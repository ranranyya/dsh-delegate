// Host delivery review: the one write that records `hostAcceptance`.
//
// The bug these tests pin: a finished task stayed `awaiting-host-review` forever with
// `hostAcceptance: null`, because nothing could ever write it. These tests drive the real
// engine (only native services are faked), a real `HistoryStore` on a temp directory, the
// real execution-plane route and the real MCP server, so the whole chain is exercised
// rather than a mocked shortcut.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JobEngine, JOB_CODES, TASK_STATES } from '../src/jobs/engine.js';
import { HistoryStore } from '../src/jobs/history.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { createExecutionHandler } from '../src/http/execution-plane.js';
import { mockRequest, mockResponse } from './helpers/node-http-mocks.js';
import { createMcpServer } from '../src/mcp/server.js';
import { taskOutcome, taskProgress, hostReviewBadge, hostReviewLine } from '../src/client/api.js';
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

/** Repository root, for the static page-source checks. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The pinned commit the fake repository reports. */
const HEAD = 'a'.repeat(40);

/** Git fake answering in the NUL-delimited shape the audit layer parses. */
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
 * A real engine over temp storage, in switch mode, with a durable history store.
 *
 * Switch mode is used because it is the one the settings page actually drives, and it
 * removes the grant bookkeeping these tests do not exercise.
 * @param {object} [options] - `failHistory` makes the store reject every write.
 * @returns {Promise<object>} harness.
 */
async function harness(options = {}) {
  const dir = await makeTempDir();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(validSettings());
  const realStore = new HistoryStore(join(dir, 'data'));
  // `failHistory` models a store that refuses every write; `noHistory` models a deployment
  // with no durable store at all; `historyOverride` injects a controllable one so a race
  // can be held open deterministically.
  let history;
  if (options.noHistory === true) history = null;
  else if (options.historyOverride !== undefined) history = options.historyOverride;
  else if (options.failHistory === true) {
    history = {
      save: async () => { throw Object.assign(new Error('history unavailable'), { code: 'DISK_FULL' }); },
      load: () => realStore.load(),
    };
  } else history = realStore;
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
    history,
    delegationEnabled: true,
    authorizationMode: 'switch',
    logger: { info() {}, warn() {} },
  });
  return {
    dir,
    workspace,
    engine,
    settings,
    history: realStore,
    async close() {
      await engine.dispose();
      await cleanup(dir);
    },
  };
}

/**
 * Wait until a task is terminal.
 * @param {object} engine - engine.
 * @param {string} taskId - task.
 * @returns {Promise<object>} settled view.
 */
async function settle(engine, taskId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = engine.get(taskId);
    if (task.state !== TASK_STATES.running && task.state !== TASK_STATES.pending) return task;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  return engine.get(taskId);
}

/**
 * Start one task and wait for it to finish.
 * @param {object} h - harness.
 * @returns {Promise<string>} task id.
 */
async function finishedTask(h) {
  const started = await h.engine.start({ connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go' });
  const settled = await settle(h.engine, started.taskId);
  assert.equal(settled.state, TASK_STATES.awaitingHostReview, 'the fixture must really finish');
  return started.taskId;
}

// ---------------------------------------------------------------------------
// 1. The decision itself
// ---------------------------------------------------------------------------

test('a finished task records an accepted review, keeps its state, and is idempotent', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    // Nothing has been accepted just because execution finished.
    assert.equal(h.engine.get(taskId).hostAcceptance, null);
    assert.equal(h.engine.get(taskId).selfApproved, false);

    const recorded = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'reviewed the diff and tests',
    });
    assert.equal(recorded.hostAcceptance.accepted, true);
    assert.equal(recorded.hostAcceptance.state, 'accepted');
    assert.equal(recorded.hostAcceptance.by, 'host-commander');
    assert.equal(recorded.hostAcceptance.note, 'reviewed the diff and tests');
    assert.equal(typeof recorded.hostAcceptance.acceptedAt, 'number');

    // The underlying state is untouched: that is what keeps old clients and
    // `continueFromTaskId` compatible.
    assert.equal(h.engine.get(taskId).state, TASK_STATES.awaitingHostReview);
    assert.equal(h.engine.get(taskId).selfApproved, false, 'the plugin still never approves itself');

    // The same decision and note replay as a no-op rather than a second record.
    const replayed = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'reviewed the diff and tests',
    });
    assert.equal(replayed.hostAcceptance.acceptedAt, recorded.hostAcceptance.acceptedAt, 'the record is not rewritten');
  } finally {
    await h.close();
  }
});

test('changes-requested is recorded as its own conclusion and is not acceptance', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const recorded = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'changes-requested', note: 'the retry path is missing',
    });
    assert.equal(recorded.hostAcceptance.accepted, false);
    assert.equal(recorded.hostAcceptance.state, 'changes-requested');
    // The UI must not read this as accepted, and must not still say "waiting".
    const outcome = taskOutcome(h.engine.get(taskId));
    assert.equal(outcome.accepted, false);
    assert.match(outcome.note, /需要修正/u);
    assert.equal(hostReviewBadge(h.engine.get(taskId)).label, '需要修正');
  } finally {
    await h.close();
  }
});

test('a different second conclusion is refused and the first one is preserved', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    await h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok' });

    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'changes-requested', note: 'changed my mind' }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
    // A different note under the same conclusion is also a different record.
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'a second note' }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
    const after = h.engine.get(taskId).hostAcceptance;
    assert.equal(after.state, 'accepted');
    assert.equal(after.note, 'ok', 'the original conclusion is untouched');
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Who and what may be reviewed
// ---------------------------------------------------------------------------

test('a running task is refused, and can be reviewed once it actually finishes', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    assert.equal(h.engine.get(taskId).state, TASK_STATES.awaitingHostReview);

    // A record can only be reviewed when BOTH the state and the native settlement agree.
    // Force the half-open shape to prove the second check is real: `awaiting-host-review`
    // with an executor the engine has not seen settle is refused.
    const record = h.engine.tasks.get(taskId);
    assert.equal(record.native.settled, true, 'a finished run really has settled');
    record.native.settled = false;
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'too early' }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
    record.native.settled = true;

    // A task that is not in the review state at all is refused for its own reason.
    const failedTask = h.engine.createTask('x', 'switch');
    failedTask.connectionId = 'local-mcp';
    failedTask.state = TASK_STATES.failed;
    h.engine.tasks.set(failedTask.taskId, failedTask);
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId: failedTask.taskId, decision: 'accepted', note: 'no' }),
      (error) => error.code === JOB_CODES.reviewNotReviewable && error.details.state === TASK_STATES.failed,
    );
    // And a cancelled one likewise.
    failedTask.state = TASK_STATES.cancelled;
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId: failedTask.taskId, decision: 'accepted', note: 'no' }),
      (error) => error.code === JOB_CODES.reviewNotReviewable,
    );
  } finally {
    await h.close();
  }
});

test('another connection cannot review this task, and neither can nobody', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'someone-else', taskId, decision: 'accepted', note: 'not mine' }),
      (error) => error.code === JOB_CODES.taskNotFound,
    );
    await assert.rejects(
      () => h.engine.recordHostReview({ taskId, decision: 'accepted', note: 'no identity' }),
      (error) => error.code === JOB_CODES.taskNotFound,
    );
    assert.equal(h.engine.get(taskId).hostAcceptance, null, 'a refused review records nothing');
  } finally {
    await h.close();
  }
});

test('an empty, oversized, wrong-vocabulary or non-string decision is refused', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const cases = [
      { decision: 'accepted', note: '' },
      { decision: 'accepted', note: '   ' },
      { decision: 'accepted', note: 'x'.repeat(1_001) },
      { decision: 'approved', note: 'ok' },
      { decision: 'accepted', note: 42 },
      { decision: undefined, note: 'ok' },
    ];
    for (const input of cases) {
      await assert.rejects(
        () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, ...input }),
        (error) => error.code === JOB_CODES.reviewInvalid,
        `${JSON.stringify(input).slice(0, 60)} must be refused`,
      );
    }
    // The exact bound is accepted.
    const atLimit = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'y'.repeat(1_000),
    });
    assert.equal(atLimit.hostAcceptance.note.length, 1_000);
  } finally {
    await h.close();
  }
});

test('a credential-shaped value in the note is redacted before it is stored or projected', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    // A bearer token and a KEY=value assignment are both credential-shaped.
    const recorded = await h.engine.recordHostReview({
      connectionId: 'local-mcp',
      taskId,
      decision: 'accepted',
      note: 'checked with Bearer sk-live-abcdef123456 and API_KEY=supersecretvalue',
    });
    const stored = JSON.stringify(recorded.hostAcceptance);
    assert.equal(stored.includes('sk-live-abcdef123456'), false, 'a bearer value must not be stored');
    assert.equal(stored.includes('supersecretvalue'), false, 'an assigned secret must not be stored');
    // The same redaction is what history and the view project, so it cannot reappear.
    const view = JSON.stringify(h.engine.get(taskId));
    assert.equal(view.includes('sk-live-abcdef123456'), false);
    assert.equal(view.includes('supersecretvalue'), false);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Durability and projection
// ---------------------------------------------------------------------------

test('the recorded review is written to history and survives a reload', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    await h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'shipped' });
    await h.history.flush?.();

    // The store's PUBLIC `path` — the file it really writes — never a guessed name.
    const raw = await readFile(h.history.path, 'utf8');
    const persisted = JSON.parse(raw).jobs.find((job) => job.taskId === taskId);
    assert.equal(persisted.hostAcceptance.accepted, true);

    // And the same bytes load back through a fresh store over the same directory.
    const [row] = await new HistoryStore(h.history.dir).load();
    assert.equal(row.taskId, taskId);
    assert.equal(row.hostAcceptance.accepted, true);
    assert.equal(row.hostAcceptance.state, 'accepted');
    assert.equal(row.hostAcceptance.note, 'shipped');
    assert.equal(row.selfApproved, false);
  } finally {
    await h.close();
  }
});

test('a history write failure is reported instead of claimed as saved', async () => {
  const h = await harness({ failHistory: true });
  try {
    const taskId = await finishedTask(h);
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok' }),
      (error) => error.code === JOB_CODES.reviewNotPersisted,
    );
    // Rolled back, so the in-memory record and the durable one cannot disagree.
    assert.equal(h.engine.get(taskId).hostAcceptance, null);
  } finally {
    await h.close();
  }
});

test('with no durable history store a review is refused, never claimed as recorded', async () => {
  const h = await harness({ noHistory: true });
  try {
    const taskId = await finishedTask(h);
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok' }),
      (error) => error.code === JOB_CODES.reviewNotPersisted,
    );
    assert.equal(h.engine.get(taskId).hostAcceptance, null, 'nothing is recorded without durability');
  } finally {
    await h.close();
  }
});

test('a history object with no save method is refused too, not treated as a successful write', async () => {
  // `persistHistory` answers `true` when there is no store at all — that is the ordinary
  // "no durable history" posture. An object that merely LOOKS like a store but exposes no
  // `save` would therefore have looked like a durable success, so this is checked
  // explicitly rather than relying on the null check.
  const h = await harness({ historyOverride: {} });
  try {
    const taskId = await finishedTask(h);
    await assert.rejects(
      () => h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok' }),
      (error) => error.code === JOB_CODES.reviewNotPersisted,
    );
    assert.equal(h.engine.get(taskId).hostAcceptance, null, 'a save-less store records nothing');
  } finally {
    await h.close();
  }
});

test('concurrent identical reviews wait for the durable write and both succeed exactly once', async () => {
  // A history store whose REVIEW write is held open, so the race is deterministic rather
  // than timing-dependent: the second request arrives while the first is still writing.
  // The terminal write that ends the run is not gated, so the task can finish first.
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  const writes = [];
  let gateReviews = false;
  const h = await harness({
    historyOverride: {
      async save(view) {
        // Only a record that ALREADY carries a review is held: that is the write under test.
        if (gateReviews && view?.hostAcceptance !== null && view?.hostAcceptance !== undefined) {
          writes.push(view.taskId);
          await gate;
        }
        return view;
      },
      async load() { return []; },
      async flush() {},
    },
  });
  try {
    const taskId = await finishedTask(h);
    gateReviews = true;
    const first = h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok' });
    const second = h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok' });
    // Neither may resolve before the write it depends on has landed.
    let settledEarly = false;
    void first.then(() => { settledEarly = true; });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    assert.equal(settledEarly, false, 'the first caller must not be answered before the write');
    assert.equal(writes.length, 1, 'exactly one durable write is in flight');

    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.hostAcceptance.accepted, true);
    assert.equal(b.hostAcceptance.accepted, true);
    assert.equal(a.hostAcceptance.acceptedAt, b.hostAcceptance.acceptedAt, 'both observe the SAME record');
    // The replay came after the durable write, so it did not need a second write.
    assert.equal(writes.length, 1, 'the identical replay does not write again');
  } finally {
    await h.close();
  }
});

test('when the durable write fails, concurrent identical reviews BOTH fail', async () => {
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  let failReviews = false;
  const h = await harness({
    historyOverride: {
      async save(view) {
        // The terminal write that ends the run must still succeed; only the REVIEW write
        // under test is gated and made to fail.
        if (failReviews && view?.hostAcceptance !== null && view?.hostAcceptance !== undefined) {
          await gate;
          throw Object.assign(new Error('disk full'), { code: 'DISK_FULL' });
        }
        return view;
      },
      async load() { return []; },
      async flush() {},
    },
  });
  try {
    const taskId = await finishedTask(h);
    failReviews = true;
    const first = h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok' });
    const second = h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'ok' });
    release();
    for (const attempt of [first, second]) {
      await assert.rejects(attempt, (error) => error.code === JOB_CODES.reviewNotPersisted);
    }
    // Nothing was left behind claiming the review exists.
    assert.equal(h.engine.get(taskId).hostAcceptance, null);
  } finally {
    await h.close();
  }
});

test('a review on a finished task is allowed while the delegation switch is OFF', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    // Close the switch exactly as an operator would.
    h.engine.setDelegationEnabled(false);
    assert.equal(h.engine.posture().authorized, false);

    // Recording a conclusion about an ALREADY finished result still works: it creates no
    // work and releases no permission.
    const recorded = await h.engine.recordHostReview({
      connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'reviewed after stopping dispatch',
    });
    assert.equal(recorded.hostAcceptance.accepted, true);

    // Starting NEW work is still refused with the switch off.
    await assert.rejects(
      () => h.engine.start({ connectionId: 'local-mcp', workspacePath: h.workspace, prompt: 'go' }),
      (error) => error.code === JOB_CODES.notAuthorized,
    );
  } finally {
    await h.close();
  }
});

test('the review route answers with the switch off, while submission stays refused', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    h.engine.setDelegationEnabled(false);
    const deps = { engine: h.engine, auth: h.engine.auth, settings: h.settings, logger: { warn() {} } };

    const ok = await callPlane(deps, '/tasks/review', { taskId, decision: 'accepted', note: 'ok' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.hostAcceptance.accepted, true);

    const submit = await callPlane(deps, '/tasks', { workspacePath: h.workspace, prompt: 'go' });
    assert.equal(submit.status, 403);
    assert.equal(submit.body.error.code, 'DELEGATION_DISABLED');
  } finally {
    await h.close();
  }
});

test('task, observation and MCP projections carry the real hostAcceptance, never a hardcoded null', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    await h.engine.recordHostReview({ connectionId: 'local-mcp', taskId, decision: 'accepted', note: 'looks right' });

    const view = h.engine.get(taskId);
    assert.equal(view.hostAcceptance.accepted, true);
    assert.equal(view.selfApproved, false);

    const observation = await h.engine.observeTask(taskId, { connectionId: 'local-mcp', waitMs: 1 });
    assert.equal(observation.task.hostAcceptance.accepted, true, 'observe must report the decision');
    assert.equal(observation.task.selfApproved, false);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Wire surfaces: the HTTP route and the MCP tool
// ---------------------------------------------------------------------------

/**
 * Invoke the real execution-plane handler for one JSON request.
 * @param {object} deps - handler deps.
 * @param {string} path - route path below the prefix.
 * @param {object} body - JSON body.
 * @returns {Promise<{ status: number, body: object }>} answer.
 */
async function callPlane(deps, path, body) {
  const handler = createExecutionHandler(deps);
  const req = mockRequest({
    method: 'POST',
    url: `/dsh-delegate/x${path}`,
    headers: { host: '127.0.0.1' },
    body: JSON.stringify(body),
  });
  const res = mockResponse();
  await handler(req, res);
  return { status: res.status, body: res.parsed() };
}

test('POST /tasks/review records the decision and refuses unknown fields or a foreign owner', async () => {
  const h = await harness();
  try {
    const taskId = await finishedTask(h);
    const deps = { engine: h.engine, auth: h.engine.auth, settings: h.settings, logger: { warn() {} } };

    const ok = await callPlane(deps, '/tasks/review', { taskId, decision: 'accepted', note: 'ok' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.hostAcceptance.accepted, true);

    // The closed field set is enforced at the route.
    const unknown = await callPlane(deps, '/tasks/review', { taskId, decision: 'accepted', note: 'ok', force: true });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'REVIEW_ARGUMENT_UNKNOWN');

    // A note over the bound never reaches the engine.
    const tooLong = await callPlane(deps, '/tasks/review', { taskId, decision: 'accepted', note: 'z'.repeat(1_001) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, 'REVIEW_NOTE_TOO_LONG');

    // Another recorded conclusion is a refusal with the engine's own code.
    const conflict = await callPlane(deps, '/tasks/review', { taskId, decision: 'changes-requested', note: 'different' });
    assert.equal(conflict.status >= 400, true);
    assert.equal(conflict.body.error.code, JOB_CODES.reviewNotReviewable);
  } finally {
    await h.close();
  }
});

test('the MCP catalog advertises delegate_review with a closed schema, and its route is review', async () => {
  const seen = [];
  const server = createMcpServer({
    async callExecution(route, payload) { seen.push({ route, payload }); return { ok: true, hostAcceptance: { accepted: true } }; },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const review = listed.result.tools.find((tool) => tool.name === 'delegate_review');
  assert.ok(review !== undefined, 'delegate_review must be advertised');
  assert.deepEqual(Object.keys(review.inputSchema.properties).sort(), ['decision', 'note', 'taskId']);
  assert.deepEqual(review.inputSchema.required, ['taskId', 'decision', 'note']);
  assert.equal(review.inputSchema.additionalProperties, false);
  assert.deepEqual(review.inputSchema.properties.decision.enum, ['accepted', 'changes-requested']);
  assert.equal(review.inputSchema.properties.note.maxLength, 1_000);

  const answer = await server.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'delegate_review', arguments: { taskId: 't1', decision: 'accepted', note: 'ok' } },
  });
  assert.equal(answer.result.isError, undefined);
  assert.deepEqual(seen, [{ route: 'review', payload: { taskId: 't1', decision: 'accepted', note: 'ok' } }]);

  // Undeclared arguments and an over-long note are refused before the plane.
  for (const args of [
    { taskId: 't1', decision: 'accepted', note: 'ok', extra: 1 },
    { taskId: 't1', decision: 'accepted', note: 'q'.repeat(1_001) },
    { taskId: 't1', decision: 'approved', note: 'ok' },
  ]) {
    seen.length = 0;
    const bad = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delegate_review', arguments: args } });
    assert.equal(bad.result.isError, true, `${JSON.stringify(args).slice(0, 50)} must be refused`);
    assert.deepEqual(seen, [], 'a refused argument sends nothing');
  }
});

// ---------------------------------------------------------------------------
// 5. The UI's reading of a recorded decision
// ---------------------------------------------------------------------------

test('the UI distinguishes accepted, changes-requested and still-waiting', () => {
  const base = { taskId: 't', state: 'awaiting-host-review', phase: 'awaiting-host-review' };
  // No decision at all — including a record written before this feature existed.
  assert.equal(hostReviewBadge(base), null, 'the headline already carries the review state');
  assert.equal(taskOutcome(base).label, '等待宿主审查');
  assert.equal(taskOutcome(base).accepted, false);
  assert.match(taskOutcome(base).note, /等待宿主/u);
  assert.equal(hostReviewLine(base, String), '未记录（插件不会自行验收）');

  const accepted = {
    ...base,
    hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, by: 'host-commander', note: 'fine' },
  };
  assert.equal(taskOutcome(accepted).label, '审查通过', 'the headline replaces the raw state label');
  assert.equal(hostReviewBadge(accepted).label, '审查通过');
  assert.equal(taskOutcome(accepted).accepted, true);
  assert.match(hostReviewLine(accepted, () => 'T'), /审查通过/u);
  assert.match(hostReviewLine(accepted, () => 'T'), /fine/u);

  // The bug that made every object look accepted: `changes-requested` is an object too.
  const rejected = {
    ...base,
    hostAcceptance: { accepted: false, state: 'changes-requested', acceptedAt: 1_700_000_000_000, by: 'host-commander', note: 'redo' },
  };
  assert.equal(taskOutcome(rejected).label, '需要修正');
  assert.equal(hostReviewBadge(rejected).label, '需要修正');
  assert.equal(taskOutcome(rejected).accepted, false, 'an object present is NOT acceptance');
  assert.match(hostReviewLine(rejected, () => 'T'), /需要修正/u);

  // A finished or reviewed task must not keep a phase badge that repeats its headline.
  assert.equal(taskOutcome(accepted).phaseLabel, null);
  assert.equal(taskOutcome(rejected).phaseLabel, null);
  assert.equal(taskOutcome(base).phaseLabel, null);
  // A live run still says what it is doing.
  assert.equal(taskOutcome({ state: 'running', phase: 'execute' }).phaseLabel, '执行中');
  // And the progress headline uses the same wording, so the two never disagree.
  assert.match(taskProgress(accepted).headline, /审查通过/u);
  assert.match(taskProgress(rejected).headline, /需要修正/u);
});

test('the rendered task list and detail actually use the unified headline, not the raw state label', () => {
  // A helper nobody calls is the failure mode this pins: the previous round added
  // `hostReviewBadge` while the list still rendered `taskStateLabel(task.state)`, so a
  // reviewed task displayed "等待宿主审查". This reads the PAGE SOURCE and asserts the
  // contradictory expressions are gone and the unified ones are present.
  const source = readFileSync(join(ROOT, 'src', 'client', 'index.jsx'), 'utf8');

  // The list item and the detail header must both render the computed headline.
  const outcomeUses = source.match(/\{outcome\.label\}/gu) ?? [];
  assert.equal(outcomeUses.length >= 2, true, 'both the list and the detail must render outcome.label');

  // The raw state is no longer rendered in those two headers.
  assert.equal(
    /\{taskStateLabel\(task\.state\)\}/u.test(source),
    false,
    'the raw state label must not be rendered beside a review conclusion',
  );
  // The detail's phase row states the execution ended instead of repeating "待审".
  assert.match(source, /执行已结束/u);

  // The list computes the headline from the shared helper and drops a repeated phase badge.
  assert.match(source, /const outcome = taskOutcome\(task\)/u);
  assert.match(source, /const phase = outcome\.phaseLabel/u);
  // It must not build a second review badge from the raw state any more.
  assert.equal(/hostReviewBadge\(task\)/u.test(source), false, 'no second, contradictory review badge');
});
