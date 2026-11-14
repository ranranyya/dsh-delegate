// R1: a finished task's result survives a restart and is still readable and reviewable.
//
// The defect these tests pin: after a restart the in-memory task map is empty, so
// `/tasks/get`, `/tasks/observe` and `/tasks/review` answered `JOB_TASK_NOT_FOUND` for a
// task whose result was on disk and visible in the page. These tests use a REAL
// `HistoryStore` on a temp directory, the REAL execution-plane handler and the REAL
// `JobEngine`; only the native executor is a fake.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { JobEngine, JOB_CODES, REVIEW_PERSISTENCE_STATES, TASK_STATES } from '../src/jobs/engine.js';
import { HistoryStore } from '../src/jobs/history.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { createExecutionHandler } from '../src/http/execution-plane.js';
import { userPlaneRoutes, USER_PLANE_PREFIX } from '../src/http/user-plane.js';
import { mockRequest, mockResponse } from './helpers/node-http-mocks.js';
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

const HEAD = 'c'.repeat(40);
/** Discriminator so every harness gets a workspace path no earlier run used. */
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
 * A data directory plus the helpers to build engines over it, one per "process".
 * @returns {Promise<object>} harness factory.
 */
async function fixture() {
  const dir = await makeTempDir();
  const root = await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace'));
  const unique = join(root, `ws-${(nextWorkspace += 1)}`);
  const workspace = await realpath(await mkdir(unique, { recursive: true }).then(() => unique));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(validSettings());
  /** Engines started here, so the fixture can dispose them in any order. */
  const engines = [];

  /**
   * Boot one engine over the SAME data directory, as a restart would.
   * @param {object} [options] - `history`: a store to share; `delegationEnabled`.
   * @returns {Promise<object>} `{ engine, store }`.
   */
  const boot = async (options = {}) => {
    const store = options.history ?? new HistoryStore(join(dir, 'data'));
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
      delegationEnabled: options.delegationEnabled ?? true,
      authorizationMode: options.authorizationMode ?? 'switch',
      logger: { info() {}, warn() {} },
    });
    engines.push({ engine, store });
    return { engine, store };
  };

  return {
    dir,
    workspace,
    settings,
    boot,
    /** @returns {Promise<object>} plane deps for one engine. */
    deps: (engine) => ({ engine, auth: engine.auth, settings, logger: { warn() {} } }),
    async close() {
      for (const { engine, store } of engines.reverse()) {
        await engine.dispose().catch(() => undefined);
        await store.flush().catch(() => undefined);
      }
      await cleanup(dir);
    },
  };
}

/**
 * Invoke the real execution-plane handler for one JSON request.
 * @param {object} deps - handler deps.
 * @param {string} path - route path below the prefix.
 * @param {object} body - JSON body.
 * @param {string} [token] - bearer token; omitted for the local switch identity.
 * @returns {Promise<{ status: number, body: object }>} answer.
 */
async function callPlane(deps, path, body, token = null) {
  const handler = createExecutionHandler(deps);
  const headers = { host: '127.0.0.1' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const req = mockRequest({
    method: 'POST',
    url: `/dsh-delegate/x${path}`,
    headers,
    body: JSON.stringify(body),
  });
  const res = mockResponse();
  await handler(req, res);
  return { status: res.status, body: res.parsed() };
}

async function pageRecords(deps, taskId) {
  const routes = userPlaneRoutes(deps);
  const call = async (suffix, body) => {
    const route = routes.find((entry) => entry.path === `${USER_PLANE_PREFIX}/${suffix}`);
    const response = await route.fetch(new Request(`http://127.0.0.1:3210${route.path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    }));
    return await response.json();
  };
  return [
    (await call('tasks')).tasks.find((task) => task.taskId === taskId),
    (await call('tasks/get', { taskId })).task,
  ];
}

/**
 * Start one task and wait for its run and its terminal history write.
 * @param {object} f - fixture.
 * @param {object} engine - engine to run on.
 * @param {object} [request] - extra start fields.
 * @returns {Promise<string>} task id.
 */
async function finishedTask(f, engine, request = {}) {
  const started = await engine.start({
    connectionId: 'local-mcp',
    workspacePath: f.workspace,
    prompt: 'go',
    ...request,
  });
  await engine.tasks.get(started.taskId).settled;
  return started.taskId;
}

/** @returns {Promise<void>} resolves after a macrotask. */
async function tick(ms = 30) {
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

// ---------------------------------------------------------------------------
// 1. The core loop: finish, restart, read, review, restart again
// ---------------------------------------------------------------------------

test('a finished task is readable and reviewable after a restart, and the conclusion survives again', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    // Deliberately NOT reviewed before the restart.
    assert.equal(first.engine.get(taskId).hostAcceptance, null);
    await first.store.flush();
    await first.engine.dispose();

    // ---- restart: a brand-new engine over the same data directory ----
    const second = await f.boot();
    const before = second.engine.list();
    assert.equal(before.length, 0, 'the bug: the restarted engine knows no live task');
    const deps = f.deps(second.engine);

    const got = await callPlane(deps, '/tasks/get', { taskId });
    assert.equal(got.status, 200);
    assert.equal(got.body.task.taskId, taskId);
    assert.equal(got.body.task.state, TASK_STATES.awaitingHostReview);
    assert.equal(got.body.task.source, 'history');
    assert.equal(got.body.task.hostAcceptance, null, 'a stored row is not an acceptance');
    assert.equal(got.body.task.execution.text.includes('implemented the change'), true);

    // observe answers AT ONCE with the stored outcome; it never waits on an old request.
    const observed = await callPlane(deps, '/tasks/observe', { taskId, waitMs: 25_000 });
    assert.equal(observed.status, 200);
    assert.equal(observed.body.reason, 'ready');
    assert.equal(observed.body.task.state, TASK_STATES.awaitingHostReview);
    assert.equal(observed.body.permission, null, 'no old permission request is offered');
    assert.equal(observed.body.wait.waitedMs, 0, 'a stored task is never waited on');

    const reviewed = await callPlane(deps, '/tasks/review', { taskId, decision: 'accepted', note: 'reviewed after restart' });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.hostAcceptance.accepted, true);
    assert.equal(reviewed.body.hostAcceptance.note, 'reviewed after restart');
    assert.equal(reviewed.body.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.saved);
    const acceptedAt = reviewed.body.hostAcceptance.acceptedAt;
    assert.equal(typeof acceptedAt, 'number');
    await second.store.flush();
    await second.engine.dispose();

    // ---- second restart: the conclusion, its time and its note are all still there ----
    const third = await f.boot();
    const again = await callPlane(f.deps(third.engine), '/tasks/get', { taskId });
    assert.equal(again.status, 200);
    assert.equal(again.body.task.hostAcceptance.accepted, true);
    assert.equal(again.body.task.hostAcceptance.note, 'reviewed after restart');
    assert.equal(again.body.task.hostAcceptance.acceptedAt, acceptedAt, 'the recorded time is preserved');
    assert.equal(again.body.task.reviewPersistence.state, REVIEW_PERSISTENCE_STATES.saved);
    // No new execution was created by reading or reviewing.
    assert.equal(third.engine.list().length, 0);
  } finally {
    await f.close();
  }
});

test('a changes-requested conclusion read back after a restart is not acceptance', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    await callPlane(f.deps(first.engine), '/tasks/review', { taskId, decision: 'changes-requested', note: 'needs fixes' });
    await first.store.flush();
    await first.engine.dispose();

    const second = await f.boot();
    const got = await callPlane(f.deps(second.engine), '/tasks/get', { taskId });
    assert.equal(got.status, 200);
    assert.equal(got.body.task.hostAcceptance.state, 'changes-requested');
    assert.equal(got.body.task.hostAcceptance.accepted, false);
    assert.equal(got.body.task.selfApproved, false);
    // And a live review of the same task is refused: the conclusion is final.
    const conflict = await callPlane(f.deps(second.engine), '/tasks/review', { taskId, decision: 'accepted', note: 'needs fixes' });
    assert.equal(conflict.status >= 400, true);
    assert.equal(conflict.body.error.code, JOB_CODES.reviewNotReviewable);
  } finally {
    await f.close();
  }
});

test('repeating the same conclusion on a restored task is idempotent', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    const posted = await callPlane(f.deps(first.engine), '/tasks/review', { taskId, decision: 'accepted', note: 'same note' });
    assert.equal(posted.status, 200);
    await first.store.flush();
    await first.engine.dispose();

    const second = await f.boot();
    const replay = await callPlane(f.deps(second.engine), '/tasks/review', { taskId, decision: 'accepted', note: 'same note' });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.hostAcceptance.acceptedAt, posted.body.hostAcceptance.acceptedAt, 'the first record is kept');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Ownership: other connection, unknown id and no owner answer identically
// ---------------------------------------------------------------------------

test('a foreign connection, an unknown id and a row with no owner are one refusal', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    await first.store.flush();
    await first.engine.dispose();

    const second = await f.boot();
    const engine = second.engine;
    // An engine wrapper whose caller identity is a DIFFERENT connection.
    const otherDeps = { ...f.deps(engine) };
    const otherGet = await engine.storedTaskRow(taskId, 'someone-else');
    assert.equal(otherGet, null, 'a foreign caller cannot read the row');
    assert.equal(await engine.storedTaskRow('no-such-task', 'local-mcp'), null);
    assert.equal(await engine.storedTaskRow(taskId, null), null, 'no verified identity, no row');
    assert.equal(otherDeps.engine === engine, true);

    for (const [path, body] of [
      ['/tasks/get', { taskId }],
      ['/tasks/observe', { taskId, waitMs: 10 }],
      ['/tasks/review', { taskId, decision: 'accepted', note: 'x' }],
    ]) {
      const answer = await callPlane(f.deps(engine), path, body);
      // The local switch identity is the owner, so these succeed; the FOREIGN case is the
      // three assertions above, checked through the same ownership rule the routes use.
      assert.equal(answer.status, 200, `${path} answers the owner`);
    }

    // A foreign review through the historical path is a not-found, not a forbidden.
    await assert.rejects(
      () => engine.recordHistoricalReview({ taskId, connectionId: 'someone-else' }, 'accepted', 'x', null),
      (error) => error.code === JOB_CODES.taskNotFound,
    );
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Only a completed run can be reviewed; failed / cancelled / interrupted keep their result
// ---------------------------------------------------------------------------

test('a stored failed, cancelled or interrupted row keeps its outcome and cannot be reviewed', async () => {
  const f = await fixture();
  try {
    const store = new HistoryStore(join(f.dir, 'data'));
    const base = {
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      connectionId: 'local-mcp',
      sourcePath: f.workspace,
      hostAcceptance: null,
      selfApproved: false,
    };
    await store.save({ ...base, taskId: 'task-failed', state: 'failed', phase: 'failed' });
    await store.save({ ...base, taskId: 'task-cancelled', state: 'cancelled', phase: 'cancelled' });
    await store.save({ ...base, taskId: 'task-interrupted', state: 'interrupted', phase: 'interrupted' });
    await store.flush();

    const { engine } = await f.boot({ history: store });
    const deps = f.deps(engine);
    for (const taskId of ['task-failed', 'task-cancelled', 'task-interrupted']) {
      const got = await callPlane(deps, '/tasks/get', { taskId });
      assert.equal(got.status, 200, `${taskId} is still readable`);
      assert.equal(got.body.task.hostAcceptance, null);
      const review = await callPlane(deps, '/tasks/review', { taskId, decision: 'accepted', note: 'nope' });
      assert.equal(review.status >= 400, true, `${taskId} cannot be accepted`);
      assert.equal(review.body.error.code, JOB_CODES.reviewNotReviewable);
      // The stored state was NOT rewritten by the refusal.
      const [stored] = (await store.load()).filter((row) => row.taskId === taskId);
      assert.notEqual(stored.state, TASK_STATES.awaitingHostReview);
      assert.equal(stored.hostAcceptance, null);
    }
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 4. A restored record never revives execution, permission or authorization
// ---------------------------------------------------------------------------

test('a restored task exposes evidence markers and no resumable or permission surface', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    await first.store.flush();
    await first.engine.dispose();

    const second = await f.boot();
    const got = await callPlane(f.deps(second.engine), '/tasks/get', { taskId });
    const task = got.body.task;
    assert.equal('prompt' in task, false, 'no prompt is republished');
    assert.equal(task.permission.pending, null, 'a stored request is never decidable');
    assert.equal(task.evidence.restored, true);
    assert.equal(task.evidence.source, 'history');
    assert.equal(task.evidence.accepted, false, 'history is not acceptance');
    assert.deepEqual(task.evidence.absent, []);
    assert.equal(Array.isArray(task.evidence.truncatedFields), true);
    // Reading it created no runnable task and no native session.
    assert.equal(second.engine.list().length, 0);
    assert.equal(second.engine.list().length, 0, 'the restarted engine still has no live task');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 5. The switch: reading and reviewing stay available; new work does not
// ---------------------------------------------------------------------------

test('with the delegation switch off a restored task is still readable and reviewable', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    await first.store.flush();
    await first.engine.dispose();

    const second = await f.boot({ delegationEnabled: false });
    const deps = f.deps(second.engine);
    const got = await callPlane(deps, '/tasks/get', { taskId });
    assert.equal(got.status, 200, 'reading a finished result needs no switch');
    const reviewed = await callPlane(deps, '/tasks/review', { taskId, decision: 'accepted', note: 'accepted while off' });
    assert.equal(reviewed.status, 200);
    // New work is still refused.
    const submit = await callPlane(deps, '/tasks', { workspacePath: f.workspace, prompt: 'go' });
    assert.equal(submit.status, 403);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 6. A terminal write cannot erase a review that was already confirmed (item 6)
// ---------------------------------------------------------------------------

test('a terminal write that starts after the review was confirmed does not erase it', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    const reviewed = await callPlane(f.deps(first.engine), '/tasks/review', {
      taskId, decision: 'accepted', note: 'confirmed before the terminal snapshot',
    });
    assert.equal(reviewed.status, 200);
    // A second terminal pass (the same task finishing again) must not write an older
    // snapshot over the confirmed decision.
    const task = first.engine.tasks.get(taskId);
    await first.engine.persistHistory(task);
    await first.store.flush();
    const [row] = (await first.store.load()).filter((entry) => entry.taskId === taskId);
    assert.equal(row.hostAcceptance.accepted, true, 'the confirmed review is still on disk');
    assert.equal(row.hostAcceptance.note, 'confirmed before the terminal snapshot');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Item 5: MCP, HTTP and engine agree on the note bound
// ---------------------------------------------------------------------------

test('an 8000-code-point emoji note survives MCP, the route and the stored record', async () => {
  const { createMcpServer } = await import('../src/mcp/server.js');
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    const note = `${'😀'.repeat(7_996)}末尾验收`;
    assert.equal(Array.from(note).length, 8_000);

    // MCP: padding whitespace must not change the verdict (it is normalized first).
    const seen = [];
    const server = createMcpServer({
      async callExecution(route, payload) { seen.push({ route, payload }); return { ok: true }; },
    });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const padded = `  ${note}  `;
    const answer = await server.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_review', arguments: { taskId: 't1', decision: 'accepted', note: padded } },
    });
    assert.equal(answer.result.isError, undefined, 'the padded 8000-code-point note is accepted');
    assert.equal(seen.length, 1);

    // The same text through the real route and engine, stored whole.
    const posted = await callPlane(f.deps(first.engine), '/tasks/review', { taskId, decision: 'accepted', note: padded });
    assert.equal(posted.status, 200);
    assert.equal(posted.body.hostAcceptance.note, note);
    assert.equal(Array.from(posted.body.hostAcceptance.note).length, 8_000);
    await first.store.flush();
    const [row] = (await first.store.load()).filter((entry) => entry.taskId === taskId);
    assert.equal(row.hostAcceptance.note, note);
  } finally {
    await f.close();
  }
});

test('an 8001-code-point note is refused by every layer with the same numbers', async () => {
  const { createMcpServer } = await import('../src/mcp/server.js');
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    const note = `${'😀'.repeat(7_997)}末尾验收`;
    assert.equal(Array.from(note).length, 8_001);

    const server = createMcpServer({ async callExecution() { throw new Error('must not reach the plane'); } });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const refused = await server.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_review', arguments: { taskId, decision: 'accepted', note: ` ${note} ` } },
    });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /8000/u);

    const posted = await callPlane(f.deps(first.engine), '/tasks/review', { taskId, decision: 'accepted', note });
    assert.equal(posted.status, 400);
    assert.equal(posted.body.error.code, 'REVIEW_NOTE_TOO_LONG');
    assert.equal(posted.body.error.details.length, 8_001);
    assert.equal(posted.body.error.details.limit, 8_000);

    await assert.rejects(
      () => first.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note }),
      (error) => error.code === JOB_CODES.reviewInvalid
        && error.details.length === 8_001
        && error.details.limit === 8_000,
    );
    assert.equal(first.engine.get(taskId).hostAcceptance, null);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Item 4: a direct store save refuses an oversized note instead of cutting it
// ---------------------------------------------------------------------------

test('HistoryStore.save refuses an 8001-code-point note and leaves the old record intact', async () => {
  const f = await fixture();
  try {
    const store = new HistoryStore(join(f.dir, 'data'));
    const base = {
      taskId: 'task-direct',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_000,
      connectionId: 'local-mcp',
      hostAcceptance: null,
      selfApproved: false,
    };
    await store.save(base);
    await store.flush();

    const note = `${'😀'.repeat(7_997)}末尾验收`;
    assert.equal(Array.from(note).length, 8_001);
    await assert.rejects(
      () => store.save({
        ...base,
        hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note },
      }),
      (error) => {
        assert.equal(error.code, 'HISTORY_VIEW_INVALID');
        assert.equal(error.details.length, 8_001);
        assert.equal(error.details.limit, 8_000);
        return true;
      },
    );
    // The old record is unchanged: no review, no shortened note.
    const [row] = (await store.load()).filter((entry) => entry.taskId === 'task-direct');
    assert.equal(row.hostAcceptance, null);

    // The legal 8000-code-point note IS accepted whole.
    const legal = `${'😀'.repeat(7_996)}末尾验收`;
    const saved = await store.save({
      ...base,
      hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_700_000_002_000, by: 'host-commander', note: legal },
    });
    assert.equal(saved.hostAcceptance.note, legal);
    assert.equal(Array.from(saved.hostAcceptance.note).length, 8_000);
    await tick(0);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 9. In-flight and failed review states are visible through a RESTORED task (A)
// ---------------------------------------------------------------------------

test('a restored task reports the in-flight state of a review written in this process', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    await first.store.flush();
    await first.engine.dispose();

    const second = await f.boot();
    const engine = second.engine;
    // Hold the document write itself open, so "in flight" is a real state and not a race
    // with a write that happened to finish first.
    let release;
    const gate = new Promise((resolvePromise) => { release = resolvePromise; });
    const update = second.store.update.bind(second.store);
    let entered = null;
    const enteredGate = new Promise((resolvePromise) => { entered = resolvePromise; });
    second.store.update = async (...args) => {
      entered();
      await gate;
      return await update(...args);
    };
    const pending = engine.recordHistoricalReview(
      { taskId, connectionId: 'local-mcp' }, 'accepted', 'held open', 50,
    );
    await enteredGate;

    // GET must say "saving", not "not reviewed", and must not publish the conclusion.
    const whileSaving = await callPlane(f.deps(engine), '/tasks/get', { taskId });
    assert.equal(whileSaving.status, 200);
    assert.equal(whileSaving.body.task.hostAcceptance, null, 'an unconfirmed conclusion is not recorded');
    assert.equal(whileSaving.body.task.reviewPersistence.state, 'saving');
    assert.equal(whileSaving.body.task.reviewPersistence.pending, true);
    assert.equal(whileSaving.body.task.reviewPersistence.decision, 'accepted');
    // The observation agrees, and the request bounded by its own wait says "unconfirmed".
    const observed = await callPlane(f.deps(engine), '/tasks/observe', { taskId, waitMs: 10 });
    assert.equal(observed.body.task.reviewPersistence.state, 'saving');
    assert.equal(observed.body.reason, 'ready');
    const timed = await pending;
    assert.equal(timed.reviewPersistence.state, 'timed-out');
    assert.equal(timed.hostAcceptance, null);

    // Release the write: the conclusion becomes durable and GET reports it.
    release('go');
    await engine.reviewWriteDone(taskId);
    const after = await callPlane(f.deps(engine), '/tasks/get', { taskId });
    assert.equal(after.body.task.hostAcceptance?.accepted, true);
    assert.equal(after.body.task.reviewPersistence.state, 'saved');
    assert.equal(after.body.task.hostAcceptance.note, 'held open');
  } finally {
    await f.close();
  }
});

test('a review of a restored task that times out is unconfirmed, not recorded', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    await first.store.flush();
    await first.engine.dispose();

    const second = await f.boot();
    const gate = new Promise((resolve) => { release = resolve; });
    const update = second.store.update.bind(second.store);
    second.store.update = async (...args) => { await gate; return await update(...args); };
    const row = await second.engine.storedTaskRow(taskId, 'local-mcp');
    const entry = second.engine.beginHistoryReviewWrite(row, 'changes-requested', 'slow');
    // Answer the request without waiting for the write: it is still running.
    const timed = await second.engine.awaitHistoryReviewWrite(row, entry, 1);
    assert.equal(timed.reviewPersistence.state, 'timed-out');
    assert.equal(timed.hostAcceptance, null, 'a timed-out historical review is not a conclusion');
    // And a GET agrees with the request's own answer.
    const got = await callPlane(f.deps(second.engine), '/tasks/get', { taskId });
    assert.equal(got.body.task.hostAcceptance, null);
    assert.equal(got.body.task.reviewPersistence.state, 'timed-out');
    release();
    await entry.done;
  } finally {
    release();
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Foreign access through the REAL route with REAL connection tokens (D)
// ---------------------------------------------------------------------------

test('unknown, foreign and ownerless rows answer one 404 through the real route', async () => {
  const f = await fixture();
  try {
    const first = await f.boot();
    // Seed a durable row belonging to a token identity. Switch-mode execution
    // deliberately normalizes every submission to local-mcp.
    const auth = first.engine.auth;
    const owner = auth.issueConnection({ label: 'owner' });
    const stranger = auth.issueConnection({ label: 'stranger' });
    const started = await first.engine.start({
      connectionId: owner.connectionId,
      workspacePath: f.workspace,
      prompt: 'go',
    });
    await first.engine.tasks.get(started.taskId).settled;
    await first.store.update(started.taskId, (row) => ({ ...row, connectionId: owner.connectionId }));
    await first.store.flush();
    await first.engine.dispose();

    // A row with NO owner recorded: it must answer like a missing one.
    const ownerless = 'task-ownerless';
    const store = new HistoryStore(join(f.dir, 'data'));
    await store.save({
      taskId: ownerless,
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      connectionId: null,
      hostAcceptance: null,
      selfApproved: false,
    });
    await store.flush();
    await store.dispose();
    await first.store.dispose();

    const next = await f.boot({ authorizationMode: 'grants' });
    const deps = { ...f.deps(next.engine), auth };
    const answers = [];
    for (const [taskId, token] of [
      ['no-such-task', stranger.token],
      [started.taskId, stranger.token],
      [ownerless, stranger.token],
      [ownerless, owner.token],
      ['no-such-task', owner.token],
    ]) {
      for (const path of ['/tasks/get', '/tasks/observe', '/tasks/review']) {
        const body = path === '/tasks/review' ? { taskId, decision: 'accepted', note: 'x' } : { taskId };
        answers.push({ path, ...(await callPlane(deps, path, body, token)) });
      }
    }
    for (const answer of answers) {
      assert.equal(answer.status, 404, `${answer.path} must be a 404`);
      assert.equal(answer.body.error.code, 'JOB_TASK_NOT_FOUND');
      // One shape and one message: nothing distinguishes "exists elsewhere" from "absent".
      assert.equal(answer.body.error.message, 'no such task for this connection');
    }
    // The OWNER can still read its own task through the same route.
    const own = await callPlane(deps, '/tasks/get', { taskId: started.taskId }, owner.token);
    assert.equal(own.status, 200);
    assert.equal(own.body.task.taskId, started.taskId);
  } finally {
    await f.close();
  }
});

test('a stored pending permission request can never be decided after a restart', async () => {
  const f = await fixture();
  try {
    const store = new HistoryStore(join(f.dir, 'data'));
    // A record whose run stopped while a permission request was outstanding.
    await store.save({
      taskId: 'task-old-pending',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: 1_700_000_000_000,
      connectionId: 'local-mcp',
      permission: {
        bridged: true,
        waiting: true,
        pending: {
          requestId: 'req-old', taskId: 'task-old-pending', toolName: 'shell', callId: 'c1',
          state: 'pending', reason: 'needs to run tests', reasonSource: 'model',
          requestedAccess: { kind: 'tool', mode: 'ask' }, argumentKeys: ['cmd'],
          arguments: '{"cmd":"npm test"}', argumentsRedacted: false, completeness: 'complete',
          argumentsComplete: true, allowBlocked: null,
        },
      },
      hostAcceptance: null,
      selfApproved: false,
    });
    await store.flush();
    await store.dispose();

    const { engine } = await f.boot();
    const deps = f.deps(engine);
    const got = await callPlane(deps, '/tasks/get', { taskId: 'task-old-pending' });
    assert.equal(got.status, 200);
    assert.equal(got.body.task.permission.pending.state, 'unavailable', 'the old request is not offered as decidable');
    const observed = await callPlane(deps, '/tasks/observe', { taskId: 'task-old-pending', waitMs: 5 });
    assert.equal(observed.body.permission, null, 'a wait never offers it either');
    assert.equal(observed.body.task.permission?.pending?.state ?? null, null, 'a wait carries no request surface');
    // Deciding it is refused: there is no live bridge.
    const decided = await callPlane(deps, '/tasks/permission', {
      taskId: 'task-old-pending', requestId: 'req-old', decision: 'allow-once', fingerprint: 'x',
    });
    assert.equal(decided.status >= 400, true);
    assert.notEqual(decided.status, 200);
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------
// 11. A terminal write overlapping a review write (C, deterministic)
// ---------------------------------------------------------------------------

test('a terminal snapshot cannot erase a review that is written while it is queued', async () => {
  const f = await fixture();
  let release = () => {};
  try {
    const first = await f.boot();
    const taskId = await finishedTask(f, first.engine);
    const gate = new Promise((resolve) => { release = resolve; });
    let entered;
    const atWrite = new Promise((resolve) => { entered = resolve; });
    const write = first.store.writeDocument.bind(first.store);
    let held = false;
    first.store.writeDocument = async (...args) => {
      if (!held) { held = true; entered(); await gate; }
      return await write(...args);
    };
    const reviewing = callPlane(f.deps(first.engine), '/tasks/review', {
      taskId, decision: 'accepted', note: 'kept through a second terminal pass',
    });
    await atWrite;
    const task = first.engine.tasks.get(taskId);
    const finishing = first.engine.persistTerminalRecord(task);
    // Let the bounded terminal wait expire while the REAL write remains held.
    await tick(5300);
    release();
    assert.equal((await reviewing).status, 200);
    await finishing;
    await first.store.flush();
    const [row] = (await first.store.load()).filter((entry) => entry.taskId === taskId);
    assert.equal(row.hostAcceptance.accepted, true);
    assert.equal(row.hostAcceptance.note, 'kept through a second terminal pass');
    // Reading it back through the route agrees with the disk.
    const got = await callPlane(f.deps(first.engine), '/tasks/get', { taskId });
    assert.equal(got.body.task.hostAcceptance.note, 'kept through a second terminal pass');
  } finally {
    release();
    await f.close();
  }
});

for (const fail of [false, true]) {
  test(`archived page and tools agree through saving, timeout and late ${fail ? 'failure with retry' : 'success'}`, async () => {
    const f = await fixture();
    let release = () => {};
    try {
      const first = await f.boot();
      const taskId = await finishedTask(f, first.engine);
      await first.engine.dispose();
      const second = await f.boot();
      const gate = new Promise((resolve) => { release = resolve; });
      let entered;
      const atWrite = new Promise((resolve) => { entered = resolve; });
      const update = second.store.update.bind(second.store);
      second.store.update = async (...args) => {
        entered(); await gate;
        if (fail) throw Object.assign(new Error('test write failed'), { code: 'HISTORY_WRITE_FAILED' });
        return await update(...args);
      };
      const note = '历史补审 😀\n'.repeat(500) + '末尾验收要求';
      const pending = second.engine.recordHistoricalReview({ taskId, connectionId: 'local-mcp' }, 'changes-requested', note, 5000)
        .then((value) => ({ value }), (error) => ({ error }));
      await atWrite;
      const deps = { ...f.deps(second.engine), history: second.store };
      const check = async (state) => {
        const external = await callPlane(deps, '/tasks/get', { taskId });
        for (const task of [external.body.task, ...await pageRecords(deps, taskId)]) {
          assert.equal(task.reviewPersistence.state, state);
          assert.equal(task.hostAcceptance, null);
        }
      };
      await check('saving');
      const entry = second.engine.reviewState.get(taskId);
      const row = await second.engine.storedTaskRow(taskId, 'local-mcp');
      const timed = await second.engine.awaitHistoryReviewWrite(row, entry, 1);
      assert.equal(timed.reviewPersistence.state, 'timed-out');
      await check('timed-out');
      release();
      const settled = await pending;
      if (fail) {
        assert.equal(settled.error.code, JOB_CODES.reviewNotPersisted);
        await check('failed');
        second.store.update = update;
        const retry = await callPlane(deps, '/tasks/review', { taskId, decision: 'changes-requested', note });
        assert.equal(retry.status, 200);
      } else {
        assert.equal(settled.value.reviewPersistence.state, 'saved');
      }
      for (const task of await pageRecords(deps, taskId)) {
        assert.equal(task.reviewPersistence.state, 'saved');
        assert.equal(task.hostAcceptance.note, note);
        assert.equal(task.hostAcceptance.state, 'changes-requested');
      }
      assert.equal(second.engine.list().length, 0, 'no archived run was revived');
    } finally { release(); await f.close(); }
  });
}
