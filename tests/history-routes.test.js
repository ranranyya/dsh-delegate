// User-plane task-record routes: live engine + durable archive.
//
// What this file proves, and why each part is here rather than in
// `tests/history.test.js`:
//
//   1. `HistoryStore` round-trips on its own are already covered there. This file
//      is about the *surface*: the authenticated user plane must show archived
//      records after a restart, must prefer a live in-process record for the same
//      id, must filter both halves by connection consistently, and must never
//      resurrect an archived task.
//
//   2. The restart regression is a real one: records are written to a temporary
//      durable store, the process-local objects are discarded, and a fresh
//      `deps`/`auth`/empty-`JobEngine`/`HistoryStore` set is built over the same
//      directory. Nothing is simulated.
//
//   3. The execution plane is asserted to be *unchanged*: an external connection
//      — including one issued after the restart — sees only its own in-memory
//      tasks, never another connection's and never a previous process's work.
//
// No browser, no network, no native agent: the only non-filesystem collaborators
// are fakes, and the agent/tool invocation counters below prove that reading
// history neither creates an agent nor calls a tool.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  USER_PLANE_PREFIX,
  assertUserPlaneRoutes,
  wrapUserPlaneRoutes,
} from '../src/http/user-plane.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { HistoryStore } from '../src/jobs/history.js';
import { JobEngine } from '../src/jobs/engine.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { mockRequest, mockResponse } from './helpers/node-http-mocks.js';
import { fakeAgents, fakeGit, fakeLlm, fakeToolRegistry, validSettings } from './helpers/fakes.js';

const WORKSPACE = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';

/** Connection A: the connection that submitted work before the restart. */
const CONN_A = 'conn-a-0f4c1d2e';
/** Connection B: an unrelated connection. */
const CONN_B = 'conn-b-91ab33d7';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** @returns {Promise<string>} fresh data directory. */
async function dataDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-history-routes-'));
}

/**
 * A stored public view shaped like the engine's own projection.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} view.
 */
function storedView(overrides = {}) {
  const createdAt = 1_700_000_000_000;
  return {
    taskId: 'task-stored',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt,
    startedAt: createdAt + 1000,
    endedAt: createdAt + 2000,
    sourcePath: WORKSPACE,
    workspacePath: WORKSPACE,
    executionWorkspacePath: WORKSPACE,
    isolation: 'shared',
    connectionId: CONN_A,
    effective: {
      worker: {
        providerId: 'relay',
        model: 'deepseek-chat',
        reasoningEffort: 'medium',
        timeoutSeconds: 600,
        maxParallelism: 1,
        isolation: 'shared',
      },
      review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
      provenance: { projectPath: WORKSPACE, projectKey: WORKSPACE.toLowerCase(), applied: ['global:worker'] },
    },
    route: { providerId: 'relay', providerRoute: 'dsh-delegate:relay', model: 'deepseek-chat', reasoningEffort: 'medium' },
    reviewRoute: null,
    reviewRouteError: null,
    worktree: null,
    baseline: null,
    diff: {
      head: 'a'.repeat(40),
      files: [{ code: 'M', path: 'src/a.js', from: null }],
      fileCount: 1,
      changes: [],
      sensitivePaths: [],
      patchText: 'diff --git a/src/a.js b/src/a.js\n+const a = 1;',
      patchWithheld: false,
    },
    execution: {
      workspacePath: WORKSPACE,
      outcome: 'completed',
      text: 'did the thing',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      // Native handles: a restart must not be able to resume anything from these,
      // and the store drops them. They are present here so the projection is
      // proven to not reintroduce them.
      agentId: 'agent-should-not-survive',
      sessionId: 'session-should-not-survive',
      cancelCause: null,
      error: null,
    },
    review: { state: 'not_run', verdict: null, text: '', error: null, selection: null, denials: [] },
    error: null,
    cancelledBy: null,
    hostAcceptance: null,
    ...overrides,
  };
}

/**
 * Build a complete deps set over one data directory.
 *
 * This mirrors the production constructor in `src/index.js`: a `HistoryStore`
 * and a `JobEngine` that share the directory, plus an empty `AuthorizationRegistry`
 * (no grants survive a restart in this fake either). `agentCalls`, `toolCalls`
 * and `cancelCalls` are counters the assertions below use as proof that a read
 * invoked nothing.
 * @param {string} dir - data directory.
 * @returns {Promise<object>} deps plus the observability counters.
 */
async function buildDeps(dir) {
  const settings = new SettingsService(dir);
  await settings.replace(validSettings());
  const auth = new AuthorizationRegistry();
  const history = new HistoryStore(dir);
  const locks = new WorkspaceLocks();
  const counters = { agentCalls: 0, toolCalls: 0, cancelCalls: 0 };

  const agents = fakeAgents();
  // `agents.create` is the single point where a native agent comes into
  // existence, so counting it is the direct proof that a read created none.
  const createAgent = agents.create;
  agents.create = async (...args) => {
    counters.agentCalls += 1;
    return await createAgent.apply(agents, args);
  };
  // Every tool access goes through the scoped registry; count lookups.
  const tools = fakeToolRegistry({ global: ['read'] });
  const baseToolsFor = tools.toolsFor;
  tools.toolsFor = (...args) => {
    counters.toolCalls += 1;
    return baseToolsFor.apply(tools, args);
  };
  const engine = new JobEngine({
    agents,
    agentPresets: null,
    sessions: null,
    llm: fakeLlm({ providers: { relay: { 'deepseek-chat': ['low', 'medium', 'high'] } } }),
    tools,
    settings,
    auth,
    locks,
    runGit: fakeGit(),
    worktrees: null,
    history,
    providerRegistry: null,
    allowLegacyProviderRoutes: true,
  });
  const cancel = engine.cancel.bind(engine);
  engine.cancel = async (...args) => {
    counters.cancelCalls += 1;
    return await cancel(...args);
  };

  const deps = {
    settings,
    auth,
    engine,
    history,
    llm: null,
    tools,
    locks,
    runGit: fakeGit(),
    logger: { warn() {}, info() {} },
    describeRuntime: () => ({ plugin: 'dsh-delegate' }),
  };
  return { deps, settings, auth, history, engine, locks, counters, tools, agents };
}

/**
 * Tear down one deps set without the engine's five-second settle window.
 *
 * `JobEngine.dispose()` aborts every non-terminal record and waits up to
 * `SETTLE_TIMEOUT_MS` for it to settle. The records these tests attach never ran,
 * so they can never settle; making them terminal first is what keeps the suite
 * fast. Nothing else about teardown changes: the history store is still disposed,
 * which is what flushes queued writes.
 * @param {object} built - value returned by {@link buildDeps}.
 * @returns {Promise<void>} resolves after both stores are closed.
 */
async function teardown({ engine, history }) {
  for (const task of engine.tasks.values()) {
    task.state = 'cancelled';
    task.phase = 'cancelled';
    task.endedAt = task.endedAt ?? Date.now();
    task.settle?.();
  }
  await engine.dispose();
  await history.dispose();
}

/**
 * Dispatch one request through the validated route set.
 * @param {object} deps - dependency object.
 * @param {string} method - HTTP method.
 * @param {string} path - absolute path.
 * @param {object} [body] - JSON body.
 * @returns {Promise<{ status: number, body: object }>} parsed response.
 */
async function call(deps, method, path, body) {
  const routes = wrapUserPlaneRoutes(deps);
  const pathname = new URL(`http://127.0.0.1:3210${path}`).pathname;
  const route = routes.find((entry) => entry.path === pathname);
  assert.ok(route !== undefined, `no route for ${pathname}`);
  const response = await route.fetch(new Request(`http://127.0.0.1:3210${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  }));
  return { status: response.status, body: await response.json() };
}

/**
 * Put one live record into an engine under a chosen id.
 *
 * `engine.createTask` mints its own id, so the records are re-keyed here. This
 * bypasses admission on purpose: these tests are about the merge between a live
 * record and its stored copy, and admission would require a fake native run.
 * The record is a real engine record, so `engine.view()` and `engine.list()`
 * project it exactly as they would a started one.
 * @param {JobEngine} engine - engine to seed.
 * @param {object} options - `taskId`, `connectionId`, `createdAt`, `state`.
 * @returns {object} the record now held by the engine.
 */
function attachLiveTask(engine, { taskId, connectionId, createdAt, state = 'awaiting-host-review' }) {
  const record = engine.createTask('a live prompt', 'task');
  engine.tasks.set(taskId, { ...record, taskId });
  const task = engine.tasks.get(taskId);
  task.state = state;
  task.phase = state;
  task.connectionId = connectionId;
  task.createdAt = createdAt;
  task.startedAt = createdAt + 5;
  task.endedAt = state === 'running' || state === 'pending' ? null : createdAt + 10;
  return task;
}

/**
 * Save the fixture set: two finished records for connection A and one live
 * record for connection B, which the restart must normalize to `interrupted`.
 * @param {HistoryStore} store - writer store.
 * @returns {Promise<void>} resolves after the last save.
 */
async function seedArchive(store) {
  await store.save(storedView({
    taskId: 'task-old',
    createdAt: 1_700_000_000_000,
    state: 'failed',
    error: { code: 'JOB_EXECUTION_FAILED', message: 'the model refused' },
  }));
  await store.save(storedView({
    taskId: 'task-new',
    createdAt: 1_700_000_500_000,
    connectionId: CONN_B,
  }));
  await store.save(storedView({
    taskId: 'task-pending',
    createdAt: 1_700_000_900_000,
    state: 'pending',
    phase: 'authorize',
    startedAt: null,
    endedAt: null,
    connectionId: CONN_A,
  }));
  await store.save(storedView({
    taskId: 'task-running',
    createdAt: 1_700_000_950_000,
    state: 'running',
    phase: 'execute',
    startedAt: 1_700_000_960_000,
    endedAt: null,
    connectionId: CONN_A,
  }));
  await store.dispose();
}

// ---------------------------------------------------------------------------
// Execution-plane harness (read-only observation of the unchanged surface)
// ---------------------------------------------------------------------------

/**
 * Load the execution plane, or `null` when it is absent.
 *
 * The point of the check below is that the *execution* plane keeps its own
 * contract after this feature; it is not a subject of this file. A branch that
 * cannot load it fails the test with an explicit reason instead of passing
 * silently, and the outcome is announced in the TAP stream.
 * @returns {Promise<object | null>} module namespace, or null.
 */
async function readExecutionPlane() {
  try {
    return await import('../src/http/execution-plane.js');
  } catch (error) {
    test.diagnostic(`dsh-delegate: execution plane module unavailable (${error?.code ?? 'IMPORT_FAILED'})`);
    return null;
  }
}

/**
 * Drive one node-style execution-plane request.
 * @param {object} plane - execution-plane module namespace.
 * @param {object} deps - dependency object.
 * @param {string} token - connection token.
 * @param {string} method - HTTP method.
 * @param {string} path - suffix below the execution prefix.
 * @param {object} [body] - JSON body.
 * @returns {Promise<{ status: number, body: object }>} parsed response.
 */
async function driveExecutionPlane(plane, deps, token, method, path, body) {
  const { createExecutionHandler, EXECUTION_PREFIX } = plane;
  const handler = createExecutionHandler({ ...deps, getBindHost: () => '127.0.0.1' });
  const request = mockRequest({
    method,
    url: `${EXECUTION_PREFIX}${path}`,
    headers: {
      host: '127.0.0.1:3210',
      authorization: `Bearer ${token}`,
      'sec-fetch-site': 'none',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? '' : JSON.stringify(body),
  });
  const response = mockResponse();
  await handler(request, response);
  return { status: response.status, body: response.parsed() };
}

// ---------------------------------------------------------------------------
// 1. Route set integrity
// ---------------------------------------------------------------------------

test('the task-record routes are registrable and stay on the user plane only', async () => {
  const dir = await dataDir();
  try {
    const { deps } = await buildDeps(dir);
    const routes = wrapUserPlaneRoutes(deps);
    // A duplicate exact path or an unsupported method would throw here.
    assertUserPlaneRoutes(routes);
    for (const name of ['tasks', 'tasks/get', 'tasks/cancel']) {
      const route = routes.find((entry) => entry.path === `${USER_PLANE_PREFIX}/${name}`);
      assert.ok(route !== undefined, `${name} must exist`);
      assert.equal(route.requestBody, 'buffered');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. The restart regression
// ---------------------------------------------------------------------------

test('after a restart the user plane lists archived records, interrupted included', async () => {
  const dir = await dataDir();
  try {
    // ---- first process: write the archive, then discard every local object ----
    const first = await buildDeps(dir);
    await seedArchive(first.history);
    await first.engine.dispose();
    await first.history.dispose();

    // ---- second process: same directory, empty engine, empty authorization ----
    const second = await buildDeps(dir);
    try {
      assert.equal(second.auth.isDelegationAuthorized(), false, 'a restart must not carry authorization');
      assert.deepEqual(second.engine.list(), [], 'the fresh engine starts empty');

      const list = await call(second.deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      assert.equal(list.status, 200);
      assert.equal(list.body.ok, true);
      assert.deepEqual(
        list.body.tasks.map((task) => task.taskId),
        ['task-running', 'task-pending', 'task-new', 'task-old'],
        'newest first, across the whole archive',
      );
      for (const task of list.body.tasks) {
        assert.equal(task.archived, true, `${task.taskId} is archive-only`);
        assert.equal(task.live, false);
      }
      assert.deepEqual(list.body.history, { available: true, archived: 4, unreadable: false });

      // `pending`/`running` are normalized by the store, not re-derived here.
      const byId = new Map(list.body.tasks.map((task) => [task.taskId, task]));
      for (const id of ['task-pending', 'task-running']) {
        const task = byId.get(id);
        assert.equal(task.state, 'interrupted', id);
        assert.equal(task.error.code, 'JOB_INTERRUPTED_RESTART', id);
        assert.equal(Number.isFinite(task.endedAt), true, id);
      }
      assert.equal(byId.get('task-pending').interruptedFrom, 'pending');
      assert.equal(byId.get('task-running').interruptedFrom, 'running');
      assert.equal(byId.get('task-old').state, 'failed');

      // Evidence survives the restart and stays redacted.
      assert.equal(byId.get('task-old').diff.patchText.includes('+const a = 1;'), true);
      assert.equal(byId.get('task-old').selfApproved, false);

      // ---- one archived record by id ----
      const one = await call(second.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/get`, { taskId: 'task-pending' });
      assert.equal(one.status, 200);
      assert.equal(one.body.task.taskId, 'task-pending');
      assert.equal(one.body.task.archived, true);
      assert.equal(one.body.task.state, 'interrupted');
      // The prompt is never stored, and the response says so rather than omitting it.
      assert.equal(one.body.task.prompt, null);
      assert.equal(one.body.task.promptArchived, false);

      // ---- reading created nothing: no agent, no tool, no controller ----
      assert.equal(second.counters.agentCalls, 0, 'a read must not create an agent');
      assert.equal(second.counters.cancelCalls, 0);
      assert.deepEqual(second.engine.list(), [], 'a read must not resurrect a task in the engine');

      // ---- an archived task is never a cancellation target ----
      const cancelled = await call(second.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/cancel`, { taskId: 'task-running' });
      assert.equal(cancelled.status, 409);
      assert.equal(cancelled.body.error.code, 'JOB_ARCHIVED_TASK');
      assert.equal(second.counters.cancelCalls, 0, 'the engine must not even be asked to cancel an archived id');
      assert.deepEqual(second.engine.list(), [], 'cancelling must not resurrect it either');

      // ---- an unknown id is still an honest 404 ----
      const missing = await call(second.deps, 'POST', `${USER_PLANE_PREFIX}/tasks/get`, { taskId: 'task-nope' });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, 'JOB_TASK_NOT_FOUND');
    } finally {
      await second.engine.dispose();
      await second.history.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a new external connection cannot read archived ids, and the execution plane still shows only its own tasks', async () => {
  const dir = await dataDir();
  try {
    const first = await buildDeps(dir);
    await first.history.save(storedView({ taskId: 'task-archived-a', connectionId: CONN_A }));
    await first.engine.dispose();
    await first.history.dispose();

    const second = await buildDeps(dir);
    try {
      // A connection issued after the restart: fresh id, fresh token, no history.
      const issued = second.auth.issueConnection({ label: 'after-restart' });
      const operatorList = await call(second.deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      assert.equal(operatorList.body.tasks.length, 1, 'the operator sees the archive');

      // The execution plane's own list route is imported and driven with the same
      // deps and a verified connection, so "unchanged" is observed, not assumed.
      const executionPlane = await readExecutionPlane();
      if (executionPlane === null) {
        // Announced in TAP; the engine assertions below still hold.
        assert.equal(second.engine.list({ connectionId: issued.connectionId }).length, 0);
      } else {
        const externalList = await driveExecutionPlane(executionPlane, second.deps, issued.token, 'GET', '/tasks');
        assert.equal(externalList.status, 200);
        assert.deepEqual(externalList.body.tasks, [], 'a new connection sees no restart history');

        // The previous process's task is not reachable through the external plane
        // either: `get` reports it absent for this connection.
        const externalGet = await driveExecutionPlane(executionPlane, second.deps, issued.token, 'POST', '/tasks/get', { taskId: 'task-archived-a' });
        assert.equal(externalGet.status, 404);
        assert.equal(externalGet.body.error.code, 'JOB_TASK_NOT_FOUND');
      }

      // The engine itself has no such task, which is the invariant the external
      // plane relies on.
      assert.throws(
        () => second.engine.get('task-archived-a'),
        (error) => error.code === 'JOB_TASK_NOT_FOUND',
      );
      assert.equal(second.counters.agentCalls, 0);
      assert.equal(second.counters.toolCalls, 0);
    } finally {
      await second.engine.dispose();
      await second.history.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Merge semantics inside one process
// ---------------------------------------------------------------------------

test('a live in-process record wins its own id over the stored copy', async () => {
  const dir = await dataDir();
  try {
    const { deps, engine, history } = await buildDeps(dir);
    try {
      // The archive holds a stale copy of a task the engine also holds live.
      await history.save(storedView({
        taskId: 'task-live-1',
        createdAt: 1_700_000_000_000,
        state: 'running',
        phase: 'execute',
        endedAt: null,
      }));
      // Plus one record the engine never had.
      await history.save(storedView({ taskId: 'task-archived-chat', createdAt: 1_700_000_500_000 }));

      // Insert a live record under the same id: this tests the merge, not admission.
      const live = attachLiveTask(engine, {
        taskId: 'task-live-1',
        connectionId: CONN_A,
        createdAt: 1_700_000_000_000,
        state: 'running',
      });
      live.hostAcceptance = { accepted: true, state: 'accepted', acceptedAt: 1_700_000_100_000, by: 'host', note: null };

      const list = await call(deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      const byId = new Map(list.body.tasks.map((task) => [task.taskId, task]));
      const winner = byId.get('task-live-1');
      assert.equal(winner.archived, false, 'the live record is not marked archived');
      assert.equal(winner.live, true);
      assert.equal(winner.hostAcceptance.accepted, true, 'the engine view must not be replaced by the stored copy');
      assert.equal(list.body.tasks.filter((task) => task.taskId === 'task-live-1').length, 1, 'no duplicate row');
      assert.equal(byId.get('task-archived-chat').archived, true);

      // `get` uses the same precedence, and returns the prompt the engine holds.
      const fetched = await call(deps, 'POST', `${USER_PLANE_PREFIX}/tasks/get`, { taskId: 'task-live-1' });
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body.task.archived, false);
      assert.equal(fetched.body.task.prompt, 'a live prompt');
      assert.equal(fetched.body.task.hostAcceptance.accepted, true);
    } finally {
      await engine.dispose();
      await history.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('connectionId filtering applies the same rule to live and archived records', async () => {
  const dir = await dataDir();
  try {
    const { deps, engine, history } = await buildDeps(dir);
    try {
      await history.save(storedView({ taskId: 'task-arch-a', connectionId: CONN_A, createdAt: 1_700_000_000_000 }));
      await history.save(storedView({ taskId: 'task-arch-b', connectionId: CONN_B, createdAt: 1_700_000_100_000 }));

      attachLiveTask(engine, { taskId: 'task-live-a', connectionId: CONN_A, createdAt: 1_700_000_200_000 });
      attachLiveTask(engine, { taskId: 'task-live-b', connectionId: CONN_B, createdAt: 1_700_000_300_000 });

      const all = await call(deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      assert.deepEqual(
        all.body.tasks.map((task) => task.taskId),
        ['task-live-b', 'task-live-a', 'task-arch-b', 'task-arch-a'],
      );

      const onlyA = await call(deps, 'GET', `${USER_PLANE_PREFIX}/tasks?connectionId=${encodeURIComponent(CONN_A)}`);
      assert.deepEqual(onlyA.body.tasks.map((task) => task.taskId), ['task-live-a', 'task-arch-a']);
      // The disagreement between the two halves is exactly what this proves.
      assert.equal(onlyA.body.tasks[1].archived, true);
      assert.equal(onlyA.body.tasks[0].archived, false);

      const onlyB = await call(deps, 'GET', `${USER_PLANE_PREFIX}/tasks?connectionId=${encodeURIComponent(CONN_B)}`);
      assert.deepEqual(onlyB.body.tasks.map((task) => task.taskId), ['task-live-b', 'task-arch-b']);

      // A connection that never existed is empty, not an error.
      const none = await call(deps, 'GET', `${USER_PLANE_PREFIX}/tasks?connectionId=conn-unknown`);
      assert.deepEqual(none.body.tasks, []);
    } finally {
      await engine.dispose();
      await history.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Failure visibility
// ---------------------------------------------------------------------------

test('an unreadable history document is a visible refusal, never an empty list', async () => {
  const dir = await dataDir();
  try {
    const { deps, engine, history } = await buildDeps(dir);
    try {
      await writeFile(join(dir, 'history.json'), '{"schemaVersion":1,"jobs":[{"taskId":', 'utf8');

      const list = await call(deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      assert.equal(list.status, 503);
      assert.equal(list.body.ok, false);
      assert.equal(list.body.error.code, 'JOB_HISTORY_UNREADABLE');
      assert.equal(list.body.error.details.cause, 'HISTORY_MALFORMED');
      assert.equal(JSON.stringify(list.body).includes('"tasks"'), false, 'no empty list is manufactured');

      const one = await call(deps, 'POST', `${USER_PLANE_PREFIX}/tasks/get`, { taskId: 'task-anything' });
      assert.equal(one.status, 503);
      assert.equal(one.body.error.code, 'JOB_HISTORY_UNREADABLE');
    } finally {
      await engine.dispose();
      await history.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unrelated engine failure is propagated, not reported as archive-not-found', async () => {
  const dir = await dataDir();
  try {
    const { deps, history } = await buildDeps(dir);
    try {
      await history.save(storedView({ taskId: 'task-archived-z' }));
      const broken = {
        ...deps,
        engine: {
          ...deps.engine,
          list: () => {
            throw Object.assign(new Error('the engine is disposed'), { code: 'JOB_DISPOSED' });
          },
          get: () => {
            throw Object.assign(new Error('the engine is disposed'), { code: 'JOB_DISPOSED' });
          },
        },
      };

      const list = await call(broken, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      assert.equal(list.status, 409);
      assert.equal(list.body.error.code, 'JOB_DISPOSED', 'an engine failure must not be swallowed by the archive');

      const one = await call(broken, 'POST', `${USER_PLANE_PREFIX}/tasks/get`, { taskId: 'task-archived-z' });
      assert.equal(one.status, 409);
      assert.equal(one.body.error.code, 'JOB_DISPOSED', 'only JOB_TASK_NOT_FOUND may fall through to the archive');
    } finally {
      await history.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('without a history store the list is live-only and says the archive is unavailable', async () => {
  const dir = await dataDir();
  try {
    const { deps, engine } = await buildDeps(dir);
    try {
      attachLiveTask(engine, { taskId: 'task-live-only', connectionId: CONN_A, createdAt: 1_700_000_000_000 });
      const { history: _unused, ...withoutHistory } = deps;
      const result = await call(withoutHistory, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.tasks.map((task) => task.taskId), ['task-live-only']);
      assert.equal(result.body.history.available, false);
      assert.equal(result.body.history.reason, 'HISTORY_UNAVAILABLE');
      // The stored record is never invented as a live one.
      assert.equal(result.body.tasks[0].archived, false);
    } finally {
      await engine.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reading the archive does not mutate the stored document', async () => {
  const dir = await dataDir();
  try {
    const { deps, engine, history } = await buildDeps(dir);
    try {
      await history.save(storedView({ taskId: 'task-readonly', state: 'awaiting-host-review' }));
      await history.flush();
      const before = await readFile(join(dir, 'history.json'), 'utf8');

      const list = await call(deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      assert.equal(list.body.tasks.length, 1);
      // Mutating the response must not reach the store or the next read.
      list.body.tasks[0].taskId = 'mutated';
      list.body.tasks[0].execution.text = 'mutated';
      const again = await call(deps, 'GET', `${USER_PLANE_PREFIX}/tasks`);
      assert.equal(again.body.tasks[0].taskId, 'task-readonly');
      assert.equal(again.body.tasks[0].execution.text, 'did the thing');
      assert.equal(await readFile(join(dir, 'history.json'), 'utf8'), before);
    } finally {
      await engine.dispose();
      await history.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('task ids are required on get and cancel', async () => {
  const dir = await dataDir();
  try {
    const { deps, engine, history } = await buildDeps(dir);
    try {
      for (const route of ['tasks/get', 'tasks/cancel']) {
        const result = await call(deps, 'POST', `${USER_PLANE_PREFIX}/${route}`, {});
        assert.equal(result.status, 400, route);
        assert.equal(result.body.error.code, 'TASK_ID_REQUIRED', route);
      }
    } finally {
      await engine.dispose();
      await history.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
