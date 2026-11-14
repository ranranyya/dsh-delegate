// Review persistence: a conclusion is published only once the durable write confirms it.
//
// The defects these tests pin, both reproduced against 1.4.0:
//
//  1. `applyHostReview` put the decision into `task.hostAcceptance` BEFORE asking the
//     store, and `persistHistory` only WAITED 5000 ms without cancelling the write. A slow
//     write left memory saying "accepted" while nothing was durable, and on timeout the
//     memory record was cleared and the caller told `JOB_REVIEW_NOT_PERSISTED` — after
//     which the write could still land: disk accepted, memory null.
//  2. The note was capped at 1000 characters at every entry point while history projected
//     it through `label()` (256) with no truncation marker, so a long conclusion was
//     silently shortened.
//
// These tests use the REAL `HistoryStore` over a temp directory, with only its filesystem
// seam delayed, so "the write landed" is a real document read back from disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';

import { JobEngine, JOB_CODES, REVIEW_PERSISTENCE_STATES, TASK_STATES } from '../src/jobs/engine.js';
import { HISTORY_CODES, HistoryError, HistoryStore } from '../src/jobs/history.js';
import { REVIEW_NOTE_MAX_CHARS } from '../src/jobs/review-note.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import {
  cleanup,
  fakeAgents,
  fakeLlm,
  fakeSessionController,
  fakeWorkspaceController,
  llmTable,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

const HEAD = 'b'.repeat(40);

/** Monotonic discriminator so every harness gets a workspace path no earlier run used. */
let nextWorkspace = 0;

/**
 * Git fake answering in the NUL-delimited shape the audit layer parses.
 * @returns {Function} runGit fake.
 */
function reviewGit() {
  return async (cwd, args) => {
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${HEAD}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '2\t0\tsrc/a.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+implementation\n', code: 0 };
    return { stdout: '', code: 0 };
  };
}

/**
 * A filesystem seam that can HOLD one document write (its final rename) or make it fail.
 *
 * Holding the rename is exactly "the store was asked to save and has not answered yet" —
 * the window the defect lived in. Each held write is its own indexed cycle; `arrive()`
 * notifies waiters by index, so a test waits for the write it means instead of whichever
 * one happened to be there. Only the WAIT has a bound; a held write is released explicitly
 * (or by `close()`), never automatically.
 * @returns {{ state: object, fs: object }} seam.
 */
function gatedFs() {
  const state = {
    /** Hold every document write from now on. */
    hold: false,
    /** One-shot failure code for the NEXT held write (re-applied on every rename attempt). */
    failNext: null,
    renames: 0,
    cycles: [],
    waiters: new Map(),
    /**
     * Wait until write `index` reaches its gate.
     * @param {number} index - zero-based cycle index.
     * @returns {Promise<object>} that cycle.
     */
    async arrive(index) {
      if (state.cycles.length > index) return state.cycles[index];
      const notified = new Promise((resolvePromise) => { state.waiters.set(index, resolvePromise); });
      const bound = new Promise((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise('timeout'), 2_000);
        timer.unref?.();
      });
      const outcome = await Promise.race([notified, bound]);
      if (outcome === 'timeout') throw new Error(`write #${index} never reached its gate`);
      return outcome;
    },
    /**
     * Release one held write.
     * @param {number} index - zero-based cycle index.
     * @param {unknown} [how] - value it resolves with.
     * @returns {void}
     */
    release(index = state.cycles.length - 1, how) {
      const cycle = state.cycles[index];
      if (cycle !== undefined && cycle.released === false) cycle.release(how);
    },
    /** Release everything still held, so `close()` can never hang on a lost gate. */
    releaseAll() {
      for (let index = 0; index < state.cycles.length; index += 1) state.release(index);
      for (const notify of state.waiters.values()) notify({ index: -1, released: true });
      state.waiters.clear();
    },
  };
  return {
    state,
    fs: {
      stat: fsPromises.stat,
      readFile: fsPromises.readFile,
      writeFile: fsPromises.writeFile,
      mkdir: fsPromises.mkdir,
      rm: fsPromises.rm,
      async rename(from, to) {
        if (!state.hold) {
          state.renames += 1;
          return await fsPromises.rename(from, to);
        }
        const cycle = {
          index: state.cycles.length,
          released: false,
          release: null,
          failCode: state.failNext,
        };
        // One-shot: the failure applies to THIS write's every rename attempt, so the
        // store's own Windows rename retry cannot turn it into a success.
        state.failNext = null;
        cycle.gate = new Promise((resolvePromise) => {
          cycle.release = (how) => {
            cycle.released = true;
            resolvePromise(how);
          };
        });
        state.cycles.push(cycle);
        const notify = state.waiters.get(cycle.index);
        if (notify !== undefined) {
          state.waiters.delete(cycle.index);
          notify(cycle);
        }
        await cycle.gate;
        if (cycle.failCode !== null && cycle.failCode !== undefined) {
          throw Object.assign(new Error('injected rename failure'), { code: cycle.failCode });
        }
        state.renames += 1;
        return await fsPromises.rename(from, to);
      },
    },
  };
}

/**
 * A real engine over a real `HistoryStore` whose document writes can be held.
 * @returns {Promise<object>} harness.
 */
async function harness() {
  const dir = await makeTempDir();
  // A UNIQUE workspace per harness. The fake Workspace controllers are per-harness, and an
  // identical path would make a later task in the same test "continue" its own earlier
  // workspace instead of starting a fresh run.
  const root = await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace'));
  const unique = join(root, `ws-${(nextWorkspace += 1)}`);
  const workspace = await realpath(await mkdir(unique, { recursive: true }).then(() => unique));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(validSettings());
  const gated = gatedFs();
  const store = new HistoryStore(join(dir, 'data'), { fs: gated.fs });
  const agents = fakeAgents({ respond: { text: 'implemented the change' } });
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces, respond: { text: 'implemented the change' } });
  const services = await nativePolicyServices();
  const engine = new JobEngine({
    agents,
    agentPresets: {
      async mount(ctx) {
        ctx.tools.schemas = () => [{ name: 'read', description: 'read', parameters: {} }];
        return { id: 'default-preset' };
      },
    },
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    policyServices: () => services,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth: new AuthorizationRegistry(),
    locks: new WorkspaceLocks(),
    runGit: reviewGit(),
    providerRegistry: {
      async ensure(providers) {
        return { routes: new Map(providers.map((provider) => [provider.id, `${provider.id}-native`])) };
      },
    },
    history: store,
    delegationEnabled: true,
    authorizationMode: 'switch',
    logger: { info() {}, warn() {} },
  });
  return {
    dir,
    workspace,
    engine,
    settings,
    store,
    gated,
    /**
     * Hold the next document write and make every rename attempt fail with `code`.
     * @param {string} code - filesystem error code to inject.
     * @returns {void}
     */
    failNextWrite(code) {
      gated.state.hold = true;
      gated.state.failNext = code;
    },
    async close() {
      gated.state.releaseAll();
      gated.state.hold = false;
      await engine.dispose();
      await store.flush().catch(() => undefined);
      await cleanup(dir);
    },
  };
}

/**
 * Start one task and wait until its run AND its terminal history write are both finished.
 *
 * `settle()` is resolved by the engine's own end-of-run path, after the terminal history
 * write; `flush()` is the store's own "every queued write landed". Waiting for both is what
 * makes it safe for a test to gate a later write: no terminal write can be caught by
 * mistake.
 * @param {object} h - harness.
 * @returns {Promise<string>} task id, settled and durable.
 */
async function finishedTask(h) {
  const started = await h.engine.start({ connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go' });
  await h.engine.tasks.get(started.taskId).settled;
  await h.store.flush();
  assert.equal(h.engine.get(started.taskId).state, TASK_STATES.awaitingHostReview, 'the fixture must really finish');
  return started.taskId;
}

/** @returns {Promise<object | null>} the stored record for a task, read from disk. */
async function storedRecord(h, taskId) {
  try {
    const raw = await readFile(h.store.path, 'utf8');
    return JSON.parse(raw).jobs.find((job) => job.taskId === taskId) ?? null;
  } catch {
    return null;
  }
}

/** @returns {Promise<object | null>} the recorded review in the document, or null. */
async function storedAcceptance(h, taskId) {
  return (await storedRecord(h, taskId))?.hostAcceptance ?? null;
}

/** @returns {Promise<void>} resolves after a real macrotask. */
async function tick(ms = 20) {
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

// ---------------------------------------------------------------------------
// 1. Nothing is published before the store confirms
// ---------------------------------------------------------------------------

test('a review is not visible in get() while its write is unconfirmed', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.gated.state.hold = true;

    const pending = h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'looks right',
    });
    await h.gated.state.arrive(0);

    // The decisive assertion: the write has not landed, so no reader may be told the
    // conclusion exists. Under the old code `hostAcceptance.accepted` was already true.
    const view = h.engine.get(taskId);
    assert.equal(view.hostAcceptance, null, 'an unconfirmed review must not read as recorded');
    assert.equal(view.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.saving);
    assert.equal(view.reviewPersistence.durable, false);
    assert.equal(view.reviewPersistence.pending, true);
    assert.equal(view.reviewPersistence.decision, 'accepted', 'the in-flight decision is identified');
    assert.equal(view.state, TASK_STATES.awaitingHostReview, 'the execution state is untouched');
    assert.equal(view.selfApproved, false);
    // The public projection is JSON data only: nothing on the wire can be a promise.
    assert.deepEqual(JSON.parse(JSON.stringify(view.reviewPersistence)), view.reviewPersistence);
    assert.equal(await storedAcceptance(h, taskId), null, 'nor is it on disk');

    h.gated.state.release(0);
    const recorded = await pending;
    assert.equal(recorded.hostAcceptance.accepted, true);
    assert.equal(recorded.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.saved);
    assert.equal(recorded.reviewPersistence.durable, true);

    // Memory and disk agree after the confirmation.
    const row = await storedRecord(h, taskId);
    assert.equal(row.hostAcceptance.accepted, true);
    assert.equal(row.hostAcceptance.note, 'looks right');
    assert.equal(h.engine.get(taskId).hostAcceptance.note, 'looks right');
  } finally {
    await h.close();
  }
});

test('a failing write is reported, records nothing, and may then be retried with another note', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.failNextWrite('EIO');

    // The rejection handler is registered BEFORE the gate opens, so the failure can never
    // surface as an unhandled rejection.
    const refusal = assert.rejects(
      h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'first try' }),
      (error) => error.code === JOB_CODES.reviewNotPersisted,
    );
    await h.gated.state.arrive(0);
    h.gated.state.release(0);
    await refusal;

    // A settled failure is not a decision: memory, view and disk all stay empty.
    assert.equal(h.engine.get(taskId).hostAcceptance, null);
    const failedView = h.engine.get(taskId);
    assert.equal(failedView.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.failed);
    assert.equal(failedView.reviewPersistence.retryable, true);
    assert.equal(failedView.reviewPersistence.error.code, HISTORY_CODES.writeFailed);
    assert.equal(await storedAcceptance(h, taskId), null);

    // A DIFFERENT note is allowed after a settled failure: nothing was recorded, so the
    // candidate conclusion is free again. It gets a new write.
    h.gated.state.hold = false;
    const retried = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'second try',
    });
    assert.equal(retried.hostAcceptance.accepted, true);
    assert.equal(retried.hostAcceptance.note, 'second try');
    assert.equal((await storedRecord(h, taskId)).hostAcceptance.note, 'second try');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The request bound: unconfirmed is not failed
// ---------------------------------------------------------------------------

test('a write that outlives the request reports saving, then lands in memory and on disk', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.gated.state.hold = true;

    const timed = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'slow disk', waitMs: 60,
    });
    // The old code threw JOB_REVIEW_NOT_PERSISTED here and cleared the record, while the
    // write went on to land: disk accepted, memory null. Neither happens now.
    assert.equal(timed.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.timedOut);
    assert.equal(timed.reviewPersistence.pending, true);
    assert.equal(timed.reviewPersistence.durable, false);
    assert.equal(timed.hostAcceptance, null, 'an unconfirmed outcome is not a decision');
    assert.equal(JSON.stringify(timed.reviewPersistence).includes('settled'), false, 'no promise is published');
    assert.equal(h.engine.get(taskId).hostAcceptance, null);
    assert.equal(h.engine.get(taskId).reviewPersistence.pending, true);
    assert.equal(await storedAcceptance(h, taskId), null);

    // The write finishes late. Its outcome is published, and memory and disk agree. The
    // test synchronises on the store's own completion signal, not on an engine promise.
    h.gated.state.release(0);
    await h.engine.reviewWriteDone(taskId);
    const view = h.engine.get(taskId);
    assert.equal(view.hostAcceptance.accepted, true);
    assert.equal(view.hostAcceptance.note, 'slow disk');
    assert.equal(view.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.saved);
    const row = await storedRecord(h, taskId);
    assert.equal(row.hostAcceptance.accepted, true);
    assert.equal(row.hostAcceptance.note, 'slow disk');
  } finally {
    await h.close();
  }
});

test('the DEFAULT request bound also answers saving when the write is slow', async () => {
  // The 5 s boundary itself, with no `waitMs`: the request must answer on its own default
  // bound while the write is still held, and must not be reported as failed.
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.gated.state.hold = true;
    const startedAt = Date.now();
    const timed = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'changes-requested', note: 'default bound',
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(timed.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.timedOut);
    assert.equal(timed.reviewPersistence.pending, true);
    assert.equal(timed.hostAcceptance, null);
    assert.ok(elapsed >= 4_500, `the default bound must be the real 5 s one, waited ${elapsed} ms`);
    assert.ok(elapsed < 15_000, `the request must stay bounded, waited ${elapsed} ms`);

    h.gated.state.release(0);
    await h.engine.reviewWriteDone(taskId);
    assert.equal(h.engine.get(taskId).hostAcceptance.state, 'changes-requested');
    assert.equal((await storedRecord(h, taskId)).hostAcceptance.note, 'default bound');
  } finally {
    await h.close();
  }
});

test('a write that fails after the request gave up leaves no decision and can be retried', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.failNextWrite('ENOSPC');

    const timed = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'doomed', waitMs: 60,
    });
    assert.equal(timed.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.timedOut);
    assert.equal(timed.hostAcceptance, null);
    // The write is still held, so it cannot have settled: a retry is refused rather than
    // queued behind a write that is still running.
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'retried' }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );

    h.gated.state.release(0);
    await h.engine.reviewWriteDone(taskId);
    const failed = h.engine.get(taskId);
    assert.equal(failed.hostAcceptance, null, 'a late failure confirms nothing');
    assert.equal(failed.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.failed);
    assert.equal(failed.reviewPersistence.retryable, true);
    assert.equal(failed.reviewPersistence.error.code, HISTORY_CODES.writeFailed);
    assert.equal(await storedAcceptance(h, taskId), null);

    // The failed write is settled, so the candidate conclusion is free again; the retry
    // must not be gated (only the write under test is).
    h.gated.state.hold = false;
    const retried = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'retried',
    });
    assert.equal(retried.hostAcceptance.accepted, true);
    assert.equal((await storedRecord(h, taskId)).hostAcceptance.note, 'retried');
  } finally {
    await h.close();
  }
});

test('an observation waits for an unconfirmed review instead of reporting it as unreviewed', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.gated.state.hold = true;
    await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'will land', waitMs: 50,
    });

    const observing = h.engine.observeTask(taskId, { connectionId: 'local-mcp', waitMs: 2_000 });
    await tick(40);
    h.gated.state.release(0);
    const observation = await observing;
    assert.equal(observation.task.hostAcceptance?.accepted, true, 'the wait delivered the confirmation');
    assert.equal(observation.task.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.saved);
    assert.equal(observation.reason, 'ready');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Retries, concurrency and other tasks
// ---------------------------------------------------------------------------

test('concurrent identical reviews share ONE write and both observe the confirmed record', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const before = h.gated.state.renames;
    h.gated.state.hold = true;
    const a = h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'same' });
    const b = h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'same' });
    await h.gated.state.arrive(0);
    assert.equal(h.engine.get(taskId).hostAcceptance, null, 'neither caller is answered early');
    assert.equal(await storedAcceptance(h, taskId), null);

    h.gated.state.release(0);
    const [first, second] = await Promise.all([a, b]);
    assert.equal(first.hostAcceptance.accepted, true);
    assert.equal(second.hostAcceptance.accepted, true);
    assert.equal(first.hostAcceptance.acceptedAt, second.hostAcceptance.acceptedAt, 'one record, not two');
    assert.equal(h.gated.state.renames - before, 1, 'the identical replay does not write again');
  } finally {
    await h.close();
  }
});

test('a conflicting conclusion is refused while a write is in flight, and cannot overwrite it', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.gated.state.hold = true;
    const accepted = h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ship it',
    });
    await h.gated.state.arrive(0);

    await assert.rejects(
      () => h.engine.recordHostReview({
        connectionId: 'local-mcp', taskId, decision: 'changes-requested', note: 'not yet',
      }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );

    h.gated.state.release(0);
    const recorded = await accepted;
    assert.equal(recorded.hostAcceptance.state, 'accepted');
    // The refused conclusion never reached memory or disk.
    assert.equal(h.engine.get(taskId).hostAcceptance.state, 'accepted');
    assert.equal((await storedRecord(h, taskId)).hostAcceptance.state, 'accepted');

    // And after it is recorded, the conflict is still refused.
    await assert.rejects(
      () => h.engine.recordHostReview({
        connectionId: 'local-mcp', taskId, decision: 'changes-requested', note: 'ship it',
      }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
  } finally {
    await h.close();
  }
});

test('a failed write is retried by a later identical request, and the retry is the record', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.failNextWrite('EIO');
    const doomed = assert.rejects(
      h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'same note' }),
      (error) => error.code === JOB_CODES.reviewNotPersisted,
    );
    await h.gated.state.arrive(0);
    h.gated.state.release(0);
    await doomed;
    assert.equal(h.engine.get(taskId).reviewPersistence.state, REVIEW_PERSISTENCE_STATES.failed);

    h.gated.state.hold = false;
    // The SAME decision is a legitimate retry after a settled failure, and it must really
    // write again rather than inherit the failed attempt.
    const retried = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'same note',
    });
    assert.equal(retried.hostAcceptance.accepted, true);
    assert.equal((await storedRecord(h, taskId)).hostAcceptance.note, 'same note');
    // A second identical request is now a pure replay: no further write.
    const before = h.gated.state.renames;
    const replay = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'same note',
    });
    assert.equal(replay.hostAcceptance.accepted, true);
    assert.equal(h.gated.state.renames, before);
  } finally {
    await h.close();
  }
});

test('two tasks saving at once both keep their own record', async () => {
  const h = await harness();
  try {
    const first = await finishedTask(h);
    const second = await finishedTask(h);
    const before = h.gated.state.renames;
    h.gated.state.hold = true;

    const a = h.engine.recordHostReview({ connectionId: 'local-mcp', taskId: first, decision: 'accepted', note: 'one' });
    const b = h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId: second, decision: 'changes-requested', note: 'two',
    });
    // The two writes queue on the ONE store, so the second only reaches its gate after the
    // first is released; asserting on each cycle index removes the race entirely.
    await h.gated.state.arrive(0);
    assert.equal(h.engine.get(first).hostAcceptance, null, 'a task’s wait is not the other task’s');
    assert.equal(h.engine.get(second).hostAcceptance, null);
    h.gated.state.release(0);
    await h.gated.state.arrive(1);
    h.gated.state.release(1);
    const [one, two] = await Promise.all([a, b]);
    assert.equal(one.hostAcceptance.state, 'accepted');
    assert.equal(two.hostAcceptance.state, 'changes-requested');

    // Both records are durable, and neither overwrote the other.
    const raw = JSON.parse(await readFile(h.store.path, 'utf8'));
    assert.equal(raw.jobs.find((job) => job.taskId === first).hostAcceptance.note, 'one');
    assert.equal(raw.jobs.find((job) => job.taskId === second).hostAcceptance.note, 'two');
    assert.equal(h.gated.state.renames - before, 2, 'each task made its own durable write');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Restart: the disk is the only fact
// ---------------------------------------------------------------------------

test('fresh engines read only the committed review on either side of a pending rename', async () => {
  const h = await harness();
  const readers = [];
  try {
    const taskId = await finishedTask(h);
    h.gated.state.hold = true;
    const pending = h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'atomic restart cut points', waitMs: 1,
    });
    await h.gated.state.arrive(0);
    const readFresh = async () => {
      const history = new HistoryStore(h.store.dir);
      const engine = new JobEngine({ ...h.engine.deps, history });
      readers.push({ engine, history });
      const row = await engine.storedTaskRow(taskId, 'local-mcp');
      return engine.historyViewOf(row);
    };
    const before = await readFresh();
    assert.equal(before.hostAcceptance, null);
    assert.equal(before.reviewPersistence.state, 'none', 'an uncommitted request is not restored');
    h.gated.state.release(0);
    await pending;
    await h.engine.reviewState.get(taskId).done;
    const after = await readFresh();
    assert.equal(after.hostAcceptance.note, 'atomic restart cut points');
    assert.equal(after.reviewPersistence.state, 'saved');
    assert.equal(after.reviewPersistence.durable, true);
  } finally {
    for (const { engine, history } of readers) { await engine.dispose(); await history.dispose(); }
    await h.close();
  }
});

test('after a restart the recorded review is read from the disk, and no saving state survives', async () => {
  const dir = await makeTempDir();
  try {
    const store = new HistoryStore(dir);
    const createdAt = 1_700_000_000_000;
    await store.save({
      taskId: 'task-restart-1',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt,
      endedAt: createdAt + 1000,
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: createdAt + 2000, by: 'host-commander', note: 'recorded before restart',
      },
      selfApproved: false,
      reviewPersistence: { state: 'saving', decision: 'accepted', durable: false, pending: true },
    });
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.hostAcceptance.accepted, true);
    assert.equal(row.hostAcceptance.note, 'recorded before restart');
    assert.equal('reviewPersistence' in row, false, 'no live saving state is written to the document');
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 5. The note bound: 8000 code points, intact end to end
// ---------------------------------------------------------------------------

/**
 * A note of exactly `count` code points, mixing Chinese, ASCII, emoji and line breaks.
 * It ends with a visible character so `trim()` normalization removes nothing.
 * @param {number} count - code points.
 * @returns {string} note.
 */
function mixedNote(count) {
  const pieces = ['中', 'a', '😀', '\n', '文'];
  let out = '';
  for (let index = 0; Array.from(out).length < count; index += 1) out += pieces[index % pieces.length];
  return Array.from(out).slice(0, Math.max(1, count - 1)).concat('文').slice(0, count).join('');
}

test('the review note bound is 8000 code points at every entry point', async () => {
  const { MAX_REVIEW_NOTE_CHARS: mcpBound } = await import('../src/mcp/server.js');
  const plane = await import('../src/http/execution-plane.js');
  assert.equal(REVIEW_NOTE_MAX_CHARS, 8_000);
  assert.equal(mcpBound, REVIEW_NOTE_MAX_CHARS, 'the MCP schema uses the shared bound');
  assert.equal(plane.REVIEW_NOTE_LIMIT_CODE_POINTS, REVIEW_NOTE_MAX_CHARS, 'the HTTP route uses the shared bound');
});

for (const size of [256, 257, 1_000, 1_001, 7_999, 8_000]) {
  test(`a ${size}-code-point note is accepted and round-trips unchanged through memory and disk`, async () => {
    const h = await harness();
    try {
      const taskId = await finishedTask(h);
      const note = mixedNote(size);
      assert.equal(Array.from(note).length, size);
      const recorded = await h.engine.recordHostReview({
        connectionId: 'local-mcp', taskId, decision: 'accepted', note,
      });
      assert.equal(recorded.hostAcceptance.note, note, 'the whole note is kept, no truncation');
      assert.equal(h.engine.get(taskId).hostAcceptance.note, note);
      const row = await storedRecord(h, taskId);
      assert.equal(row.hostAcceptance.note, note, 'the durable record is the whole note');
      assert.equal(row.hostAcceptance.noteChars, size);
      // A reload through a fresh store sees the same text.
      const [reloaded] = await new HistoryStore(h.store.dir).load();
      assert.equal(reloaded.hostAcceptance.note, note);
      assert.equal(reloaded.hostAcceptance.noteChars, size);
    } finally {
      await h.close();
    }
  });
}

test('an 8001-code-point note is refused before anything is written, with its real length', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const before = await readFile(h.store.path, 'utf8');
    await assert.rejects(
      () => h.engine.recordHostReview({
        connectionId: 'local-mcp', taskId, decision: 'accepted', note: mixedNote(8_001),
      }),
      (error) => {
        assert.equal(error.code, JOB_CODES.reviewInvalid);
        assert.equal(error.details.limit, 8_000);
        // The count is code points, not UTF-16 units (this note is longer than 8001 units).
        assert.equal(error.details.length, 8_001);
        assert.equal(error.details.unit, 'unicode-code-points');
        return true;
      },
    );
    assert.equal(h.engine.get(taskId).hostAcceptance, null);
    assert.equal(h.engine.get(taskId).reviewPersistence.state, REVIEW_PERSISTENCE_STATES.none);
    assert.equal(await readFile(h.store.path, 'utf8'), before, 'the existing document is untouched');
  } finally {
    await h.close();
  }
});

test('a refused note leaves an already recorded review exactly as it was', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'verified: 100%',
    });
    const before = await readFile(h.store.path, 'utf8');
    await assert.rejects(
      () => h.engine.recordHostReview({
        connectionId: 'local-mcp', taskId, decision: 'changes-requested', note: mixedNote(8_001),
      }),
      (error) => error.code === JOB_CODES.reviewInvalid,
    );
    assert.equal(await readFile(h.store.path, 'utf8'), before, 'the old record is not modified');
    assert.equal(h.engine.get(taskId).hostAcceptance.note, 'verified: 100%');
  } finally {
    await h.close();
  }
});

test('a long accepted note survives beside a large diff and long execution output', async () => {
  const dir = await makeTempDir();
  try {
    const store = new HistoryStore(dir);
    const note = mixedNote(8_000);
    const saved = await store.save({
      taskId: 'task-budget-1',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      diff: {
        // A patch far larger than the entry budget allows beside an 8000-code-point note.
        patchText: `diff --git a/big b/big\n${'+const line = "x";\n'.repeat(20_000)}`,
        patchTruncated: false,
      },
      execution: { outcome: 'completed', text: 'output\n'.repeat(10_000) },
      hostAcceptance: {
        accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note,
      },
      selfApproved: false,
    });
    // The conclusion is stored WHOLE: the diff and the output are the fields that give way.
    assert.equal(saved.hostAcceptance.note, note, 'the accepted note is never shortened');
    assert.equal(saved.hostAcceptance.accepted, true);
    assert.ok(saved.truncation !== undefined, 'what was cut is stated');
    assert.equal(saved.truncation.fields.includes('hostAcceptance.note'), false);
    assert.equal(saved.truncation.fields.includes('diff.patchText'), true);

    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.hostAcceptance.note, note, 'the whole note survives the reload');
  } finally {
    await cleanup(dir);
  }
});

test('a legal note that cannot fit is refused whole, never truncated and saved', async () => {
  const dir = await makeTempDir();
  try {
    // The smallest entry budget the store accepts, and a legal full-size note that alone
    // spends more than it: the note MUST be refused, not cut.
    const maxEntryBytes = 4_096;
    const note = mixedNote(8_000);
    assert.ok(Buffer.byteLength(note, 'utf8') > maxEntryBytes * 2, 'the note really exceeds the budget');
    const store = new HistoryStore(dir, { maxEntryBytes, maxBytes: maxEntryBytes * 4 });
    await assert.rejects(
      () => store.save({
        taskId: 'task-tight-1',
        state: 'awaiting-host-review',
        phase: 'awaiting-host-review',
        createdAt: 1_700_000_000_000,
        endedAt: 1_700_000_001_000,
        hostAcceptance: {
          accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note,
        },
        selfApproved: false,
      }),
      (error) => {
        assert.ok(error instanceof HistoryError);
        assert.equal(error.code, HISTORY_CODES.entryTooLarge);
        return true;
      },
    );
    // Refused means NOTHING was written: no record, and no shortened conclusion.
    assert.equal(await readFile(store.path, 'utf8').catch(() => null), null);
  } finally {
    await cleanup(dir);
  }
});

test('a write refuses an oversized note, while a document already carrying one stays readable', async () => {
  const dir = await makeTempDir();
  try {
    const store = new HistoryStore(dir);
    const overlong = 'z'.repeat(9_000);
    const view = {
      taskId: 'task-overlong-1',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_700_000_001_000, by: 'host-commander', note: overlong },
      selfApproved: false,
    };
    // A WRITE of an oversized note is refused: a conclusion is never shortened into a save.
    await assert.rejects(
      () => store.save(view),
      (error) => error.code === HISTORY_CODES.viewInvalid && error.details.length === 9_000,
    );
    // A DOCUMENT that already carries one (another writer) still LOADS, with the cut stated.
    await writeFile(store.path, JSON.stringify({
      schemaVersion: 1,
      updatedAt: 1_700_000_003_000,
      jobs: [{
        taskId: 'task-overlong-1',
        state: 'awaiting-host-review',
        phase: 'awaiting-host-review',
        createdAt: 1_700_000_000_000,
        hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_700_000_001_000, by: 'host-commander', note: overlong },
      }],
    }), 'utf8');
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.hostAcceptance.note.endsWith('… [truncated]'), true, 'the cut is marked');
    assert.equal(row.truncation.fields.includes('hostAcceptance.note'), true, 'and recorded');
    assert.equal(row.hostAcceptance.noteChars, 9_000, 'the original size is kept as the fact');
  } finally {
    await cleanup(dir);
  }
});

test('a credential-shaped review note is still redacted before it is stored', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    await h.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId,
      decision: 'accepted',
      note: 'checked with Bearer sk-live-abcdef123456 and API_KEY=supersecretvalue',
    });
    const row = await storedRecord(h, taskId);
    assert.equal(row.hostAcceptance.note.includes('sk-live-abcdef123456'), false);
    assert.equal(row.hostAcceptance.note.includes('supersecretvalue'), false);
    assert.match(row.hostAcceptance.note, /Bearer /u);
  } finally {
    await h.close();
  }
});
