// Controller lifecycle: the two native placement services may arrive AFTER the
// plugin activated.
//
// The defect this file pins down was observed on a real desktop run: `apply()`
// read `ctx.get('workspaceController', false)` and `ctx.get('sessionController',
// false)` once, during activation, and froze whatever it found. DSH composes those
// controllers as its own rows settle, so on that deployment both reads returned
// nothing, the dependency object held `null` forever, and every dispatch failed
// closed with `JOB_CONVERSATION_UNAVAILABLE` /
// `SESSION_WORKSPACES_UNAVAILABLE` 鈥?on a harness that composed BOTH
// controllers moments later.
//
// The tests below therefore drive the plugin the way the harness does: mount it
// against a context whose controllers do not exist yet, then publish them, then
// dispatch. Two properties are asserted, and they are different claims:
//
//  * a controller that appears later is USED by the next run (the fix);
//  * the grouping behaviour already shipped in 0.1.8 is unchanged (same directory
//    -> one Workspace + a new Session per run), and an explicit
//    `continueFromTaskId` follow-up continues exactly the parent task's Session.
//
// Nothing here touches the network: every native service is either a fake from
// `helpers/fakes.js` or a stub whose only job is to be absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { apply } from '../src/index.js';
import { SESSION_CODES, SessionPlacementError, liveControllerAccessor } from '../src/runtime/session-placement.js';
import { runAgent } from '../src/runtime/agent-runner.js';
import {
  cleanup,
  fakeAgentPresets,
  fakeAgents,
  fakeSessionController,
  fakeWorkspaceController,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

const DIRECTORY = process.platform === 'win32' ? 'C:\\work\\placement' : '/work/placement';
const OTHER_DIRECTORY = process.platform === 'win32' ? 'C:\\work\\elsewhere' : '/work/elsewhere';
const SELECTION = { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' };

/**
 * Mount the real plugin entry against a context that composes NO placement
 * controller, and hand back the published face plus a way to publish them later.
 *
 * The context is deliberately minimal but faithful on the three seams `apply`
 * reads during activation: the injected services it dereferences (`agents`,
 * `sessions`, `llm`, `tools`, `webServer`, `connection`), the non-strict
 * `ctx.get` service accessor, and `ctx.effect`/`ctx.provide`.
 *
 * `ctx.get` is a real function over a live map, and it returns `undefined` for a
 * name that was never published 鈥?which is exactly what the installed Cordis
 * does for a non-strict read of an absent service, and is why the pre-0.1.9
 * `optionalService` saw `null` on the desktop. Publishing is a later mutation of
 * that same map, so a dependency object holding a load-time snapshot cannot see
 * it and a live accessor must.
 * @param {object} [options] - `agentPresets`, `providers` (settings document),
 *   `controllers` (published before `apply`, to model a later replacement).
 * @returns {Promise<object>} `{ published, ctx, directory, services, publish, unpublish, dispose }`.
 */
async function mountWithoutControllers(options = {}) {
  // The installed native runtime, as `entry.test.js` uses it: `apply` builds its
  // route registry against `ctx.llm.registerAdapter`, so a stub would test a
  // plugin that could never have been mounted.
  const { LlmRuntime } = await import('@deepseek-ai/dsh-llm');
  const directory = await makeTempDir();
  const settingsDir = join(directory, 'dsh-delegate');
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });
  const document = options.providers ?? validSettings();
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify(document), 'utf8');

  const services = new Map(Object.entries(options.controllers ?? {}));
  const writes = [];
  /** One registered user-plane route set; the plane is inert here. */
  const routes = new Map();
  const effects = [];

  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    reflect: { provide: () => () => {} },
    events: { dispatch: () => [] },
    waterfall: () => Promise.resolve([]),
    effect(effect) {
      // `apply` uses both shapes: a plain function returning a disposer, and the
      // runtime's own generator. Only the disposer identity matters here.
      const dispose = typeof effect === 'function' && effect.constructor?.name !== 'GeneratorFunction'
        ? effect()
        : (() => {
          const iterator = effect.call(ctx);
          const first = iterator.next();
          return typeof first.value === 'function' ? first.value : () => {};
        })();
      const returned = typeof dispose === 'function' ? dispose : () => {};
      effects.push(returned);
      return returned;
    },
    /** The non-strict service accessor Cordis exposes as `ctx.get`. */
    get(name, strict) {
      const service = services.get(name);
      if (service === undefined) {
        // A strict read of an absent service throws in Cordis; the plugin only
        // performs non-strict reads of the optional services.
        if (strict === true) throw new Error(`cannot get property "${name}" without inject`);
        return undefined;
      }
      return service;
    },
    provide() {},
    agents: { create: async () => ({}) },
    sessions: {},
    tools: {},
    webServer: {
      host: '127.0.0.1',
      port: 3210,
      register(payload) {
        writes.push(payload);
        return () => {};
      },
    },
    connection: {
      fetch: {
        register(route) {
          if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };

  ctx.llm = new LlmRuntime(ctx);

  const previousHome = process.env.DSH_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.DSH_HOME = directory;
  process.env.CODEX_HOME = join(directory, 'codex-home');
  let published = null;
  ctx.provide = (serviceName, value) => { published = value; };
  try {
    await apply(ctx, { dataDir: directory });
  } finally {
    process.env.DSH_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }

  return {
    published,
    ctx,
    directory,
    services,
    routes,
    effects,
    /** Publish a controller now, as the harness row would once it settles. */
    publish(name, service) {
      services.set(name, service);
    },
    /** Retire a controller again, as an unloaded row would. */
    unpublish(name) {
      services.delete(name);
    },
    /** Run every disposer `apply` registered, in the order Cordis would. */
    async dispose() {
      for (const dispose of effects.reverse()) await dispose();
      await cleanup(directory);
    },
  };
}

/**
 * Both controllers, wired to each other the way production wires them.
 *
 * A placed run drives the Agent the session CONTROLLER resolved for its Session
 * (it never calls `agents.create`), so the controller needs the same scripted turn
 * the agent registry was given; otherwise the placement succeeds and the turn
 * itself reports `RUN_NO_TEXT`, which would hide the wiring under test.
 * @param {object} handle - the mount handle from {@link mountWithoutControllers}.
 * @param {object} [options] - `respond` turn plan for every resolved Agent.
 * @returns {object} `{ workspaces, sessionController }` fakes.
 */
function controllerPair(handle, options = {}) {
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({
    workspaces,
    ...(options.respond === undefined ? {} : { respond: options.respond }),
  });
  return { workspaces, sessionController };
}

/**
 * Publish both controllers, so a dispatch can place a run in a Workspace.
 *
 * The session controller is given the agent registry's own turn plan: a placed run
 * drives the resolved Agent, so that is where the scripted reply has to exist.
 * The two native policy services are published as well: every worker run the
 * plugin starts is a delegated run, and it fails closed before its prompt unless
 * `ctx.sandboxPolicy` and `ctx.approval` can resolve the policy it wrote.
 * @param {object} handle - the mount handle.
 * @param {object} agents - the fake agent registry the run will be dispatched with.
 * @param {object} [controllers] - an existing {@link controllerPair} to publish.
 * @returns {Promise<object>} the published pair.
 */
async function publishPair(handle, agents, controllers = null) {
  const pair = controllers ?? controllerPair(handle, { respond: agents.respondPlan ?? { text: 'ok' } });
  handle.publish('workspaceController', pair.workspaces);
  handle.publish('sessionController', pair.sessionController);
  await publishPolicies(handle);
  return pair;
}

/**
 * Publish the native services that own a delegated session's policy.
 *
 * They are the installed ones ({@link nativePolicyServices}), so a worker run in
 * this file proves its policy through the real folds rather than through a stub.
 * @param {object} handle - the mount handle.
 * @returns {Promise<object>} the published services.
 */
async function publishPolicies(handle) {
  const services = await nativePolicyServices();
  handle.publish('sandboxPolicy', services.sandboxPolicy);
  handle.publish('approval', services.approval);
  return services;
}

/**
 * Dispatch one real run through the dependency object the plugin published 鈥?the
 * same object `JobEngine.execute` passes to `runAgent`, so the controllers under
 * test are the ones a dispatch would actually use.
 * @param {object} handle - the mount handle.
 * @param {object} agents - agent registry to attach.
 * @param {object} [request] - `prompt`, `cwd`, `mode`.
 * @returns {Promise<object>} the run result.
 */
async function dispatch(handle, agents, request = {}) {
  const deps = {
    ...handle.published.deps,
    agents,
    agentPresets: handle.published.deps.agentPresets ?? fakeAgentPresets(),
  };
  return await runAgent(deps, {
    prompt: request.prompt ?? 'do the thing',
    cwd: request.cwd ?? DIRECTORY,
    selection: SELECTION,
    timeoutMs: 5000,
    ...(request.mode === undefined ? {} : { conversationMode: request.mode }),
  });
}

/**
 * Create a real directory under the mount's temporary root and return its
 * canonical path.
 *
 * The engine resolves and locks the directory it is handed, so a task in this
 * file cannot run against a synthetic path the way a `runAgent`-only test can.
 * @param {string} root - temporary root of the mount.
 * @param {string} name - directory name.
 * @returns {Promise<string>} canonical absolute path.
 */
async function realDirectory(root, name) {
  const { realpath } = await import('node:fs/promises');
  const target = join(root, name);
  await mkdir(target, { recursive: true });
  return await realpath(target);
}

/**
 * Wait until a task reaches a terminal state.
 *
 * The engine drives a task asynchronously, so a settled view is polled rather
 * than awaited directly. The bound is generous but finite: a task that never
 * settles must fail the test, not hang it.
 * @param {object} engine - job engine.
 * @param {string} taskId - task id returned by `engine.start`.
 * @param {number} [attempts] - polling bound.
 * @returns {Promise<object>} settled task view.
 */
async function settleTask(engine, taskId, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = engine.get(taskId);
    if (task.state !== 'running' && task.state !== 'pending') return task;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  return engine.get(taskId);
}

/**
 * A git runner for the engine's audit/preflight layer.
 *
 * The engine shells out to `git` before a task may start. A confined test process
 * cannot rely on the binary, and git is not what this file is about, so this
 * answers in the NUL-delimited shape the audit parser requires: a repository at
 * HEAD with no changes. The engine's own tests use the same fixture.
 * @returns {object} runner function with `calls` history.
 */
function fakeGit() {
  const calls = [];
  const runner = async (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${'a'.repeat(40)}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: '', code: 0 };
    if (args[0] === 'diff') return { stdout: '', code: 0 };
    if (args[0] === 'ls-files') return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  };
  runner.calls = calls;
  return runner;
}

// --- The fix: a controller composed after activation is used ------------------

test('a controller composed after plugin activation places the next run', async () => {
  const handle = await mountWithoutControllers();
  try {
    // Activation happened with NEITHER controller: the pre-0.1.9 defect froze
    // that fact and every dispatch failed with `SESSION_WORKSPACES_UNAVAILABLE`
    // even after DSH composed both services.
    assert.equal(handle.published.deps.describeRuntime().workspaceController, 'unavailable');
    assert.equal(handle.published.deps.describeRuntime().sessionController, 'unavailable');

    // The harness settles its own rows a moment later.
    const agents = fakeAgents({ respond: { text: 'placed: java' } });
    const { workspaces, sessionController } = await publishPair(handle, agents);

    // The operational report follows the services instead of the load snapshot.
    assert.equal(handle.published.deps.describeRuntime().workspaceController, 'available');
    assert.equal(handle.published.deps.describeRuntime().sessionController, 'available');

    const result = await dispatch(handle, agents, { prompt: 'say java' });

    // The run completed, and it completed THROUGH the late controllers: the
    // Workspace was created for the real execution directory and the Session
    // lives inside it.
    assert.equal(result.outcome, 'completed');
    assert.equal(agents.created.length, 0, 'a placed run must not create an agent of its own');
    assert.deepEqual(workspaces.creates, [{ path: DIRECTORY }], 'the Workspace is keyed by the execution directory');
    assert.equal(sessionController.creates.length, 1, 'exactly one Session was created inside it');
    assert.equal(sessionController.creates[0].workspaceId, 'ws-1');

    const conversation = result.conversation;
    assert.ok(conversation !== null && typeof conversation === 'object', 'the run reports its placement');
    assert.equal(conversation.workspaceId, 'ws-1');
    assert.equal(conversation.workspacePath, DIRECTORY);
    assert.equal(conversation.sessionId, 'session-1');
    assert.equal(conversation.reused, false);
    assert.equal(workspaces.workspaces.get('ws-1').sessionIds.includes('session-1'), true, 'the Session is in that Workspace');
  } finally {
    await handle.dispose();
  }
});

test('a controller that disappears again refuses the next run instead of crashing', async () => {
  // The mirror image, and the reason the accessor may not cache: a harness that
  // composes and then retires a row must be observed on the next placement. The
  // refusal is the documented fail-closed code, not a thrown property access.
  const handle = await mountWithoutControllers();
  try {
    const agents = fakeAgents({ respond: { text: 'first' } });
    const { workspaces } = await publishPair(handle, agents);

    const first = await dispatch(handle, agents, { prompt: 'first' });
    assert.equal(first.outcome, 'completed');

    handle.unpublish('workspaceController');
    await assert.rejects(
      () => dispatch(handle, agents, { prompt: 'second' }),
      (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.workspacesUnavailable,
    );
    assert.equal(workspaces.creates.length, 1, 'the retired controller is no longer consulted');

    // The mirror case: a harness that composes the Workspace controller but not
    // the session controller reports the OTHER stated code, so an operator can
    // tell which service is missing.
    handle.unpublish('sessionController');
    handle.publish('workspaceController', workspaces);
    await assert.rejects(
      () => dispatch(handle, agents, { prompt: 'third' }),
      (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.sessionsUnavailable,
    );
  } finally {
    await handle.dispose();
  }
});

test('a read-supplied accessor follows a replaced controller, and fails closed when the read throws', async () => {
  // The accessor contract in isolation: it resolves the service per call, never
  // caches it, and turns a refused read into "absent" so the caller reports
  // `SESSION_*_UNAVAILABLE` rather than propagating a raw property error.
  const seen = [];
  let current = null;
  const accessor = liveControllerAccessor(() => {
    if (current === 'explode') throw new Error('service resolution refused');
    return current;
  }, { onError: (error) => seen.push(error.message) });

  assert.equal(accessor.current, null, 'an absent service resolves to null');
  assert.equal(accessor.create, null, 'and offers no create');

  const first = fakeWorkspaceController();
  current = first;
  // The whole service is exposed, not only `create`: placement also needs
  // `resolveAgent` from the session controller.
  assert.equal(accessor.current, first, 'the live service is what a caller receives');
  await accessor.create({ path: DIRECTORY });
  assert.deepEqual(first.creates, [{ path: DIRECTORY }]);

  const second = fakeWorkspaceController();
  current = second;
  assert.equal(accessor.current, second, 'a replacement must be observed, not the previous service');
  await accessor.create({ path: DIRECTORY });
  // Each controller records only its own calls: resolving `create` again hits the
  // replacement, and the retired one is not touched a second time.
  assert.deepEqual(first.creates, [{ path: DIRECTORY }]);
  assert.deepEqual(second.creates, [{ path: DIRECTORY }]);

  current = 'explode';
  assert.equal(accessor.current, null);
  assert.deepEqual(seen, ['service resolution refused'], 'a refused read is reported once, not swallowed silently');
});

// --- No regression: the shipped grouping and reuse behaviour -----------------

test('runs in one directory stay grouped while each new-mode run gets its own Session', async () => {
  // The behaviour 0.1.8 shipped, re-asserted through the late-binding path so the
  // fix cannot have changed it: one Workspace per execution directory, a fresh
  // Session per run, and the Workspace RESOLVED (create-or-reuse) once per run.
  const handle = await mountWithoutControllers();
  try {
    const agents = fakeAgents({ respond: { text: 'ok' } });
    const { workspaces, sessionController } = await publishPair(handle, agents);

    const first = await dispatch(handle, agents, { prompt: 'a' });
    const second = await dispatch(handle, agents, { prompt: 'b' });
    const elsewhere = await dispatch(handle, agents, { prompt: 'c', cwd: OTHER_DIRECTORY });

    assert.equal(first.conversation.workspaceId, second.conversation.workspaceId, 'same directory, one group');
    assert.notEqual(elsewhere.conversation.workspaceId, first.conversation.workspaceId, 'another directory, another group');
    assert.equal(workspaces.workspaces.size, 2, 'one Workspace per execution directory');

    // `workspaceCreated` is a placement fact, not a run-report field, so the
    // create-or-reuse decision is read where it was made: the controller history.
    assert.deepEqual(
      workspaces.creates.map((request) => request.path),
      [DIRECTORY, DIRECTORY, OTHER_DIRECTORY],
      'the Workspace is resolved once per run, by the actual execution directory',
    );

    assert.notEqual(first.conversation.sessionId, second.conversation.sessionId, 'new mode starts a new conversation');
    assert.equal(first.conversation.reused, false);
    assert.equal(second.conversation.reused, false);
    assert.equal(sessionController.creates.length, 3, 'one Session per run, none shared across directories');
    assert.equal(
      sessionController.creates[0].workspaceId,
      sessionController.creates[1].workspaceId,
      'both runs in one directory share the Workspace they were created in',
    );
  } finally {
    await handle.dispose();
  }
});

test('a new submission in a directory with history still starts a new Session, through the real engine', async () => {
  // The behaviour a removed directory-level setting used to change. Two submissions
  // in one directory, with the local-call switch on: same Workspace group, two
  // Sessions. Nothing about the directory's history makes the second one continue
  // the first.
  const handle = await mountWithoutControllers({
    providers: { ...validSettings(), delegationEnabled: true },
    controllers: { agentPresets: fakeAgentPresets() },
  });
  try {
    const agents = fakeAgents({ respond: { text: 'turn' } });
    const { sessionController } = await publishPair(handle, agents);
    const { engine } = handle.published;
    engine.deps.runGit = fakeGit();
    const directory = await realDirectory(handle.directory, 'fresh');
    await engine.deps.ensureRoutes(await handle.published.settings.read());

    const runTask = async (prompt) => {
      const started = await engine.start({
        connectionId: 'local-mcp',
        workspacePath: directory,
        prompt,
      });
      return await settleTask(engine, started.taskId);
    };

    const first = await runTask('first task');
    assert.equal(first.state, 'awaiting-host-review', 'the first task must complete');
    assert.equal(first.execution.conversation.kind, 'new');
    assert.equal(first.conversationSaved, true, 'the engine recorded the thread it drove');
    assert.equal(first.continueFromTaskId, null);

    const second = await runTask('unrelated second task');
    assert.equal(second.state, 'awaiting-host-review');
    assert.equal(second.execution.conversation.kind, 'new', 'an unrelated task never continues the previous one');
    assert.equal(second.execution.conversation.reused, false);
    assert.notEqual(
      second.execution.conversation.sessionId,
      first.execution.conversation.sessionId,
      'the second task has its own conversation',
    );
    assert.equal(
      second.execution.conversation.workspaceId,
      first.execution.conversation.workspaceId,
      'while the directory keeps one Workspace group',
    );
    assert.equal(sessionController.creates.length, 2, 'two submissions, two Sessions');
  } finally {
    await handle.dispose();
  }
});

test('continueFromTaskId continues that task thread through the real engine', async () => {
  // The positive half of the feature, driven end to end: the engine records the
  // thread a completed task drove, and a follow-up naming that task resumes the SAME
  // Session instead of creating a second one.
  const handle = await mountWithoutControllers({
    providers: { ...validSettings(), delegationEnabled: true },
    controllers: { agentPresets: fakeAgentPresets() },
  });
  try {
    const agents = fakeAgents({ respond: { text: 'turn' } });
    const { sessionController } = await publishPair(handle, agents);
    const { engine } = handle.published;
    engine.deps.runGit = fakeGit();
    const directory = await realDirectory(handle.directory, 'continuation');
    await engine.deps.ensureRoutes(await handle.published.settings.read());

    /**
     * Start one submission and wait for it to settle.
     * @param {string} prompt - task prompt.
     * @param {object} [extra] - extra start fields.
     * @returns {Promise<object>} settled task view.
     */
    const runTask = async (prompt, extra = {}) => {
      const started = await engine.start({
        connectionId: 'local-mcp',
        workspacePath: directory,
        prompt,
        ...extra,
      });
      return await settleTask(engine, started.taskId);
    };

    const root = await runTask('start the thread');
    assert.equal(root.state, 'awaiting-host-review');
    assert.equal(root.execution.conversation.kind, 'new');

    const followUp = await runTask('carry on with the same task', { continueFromTaskId: root.taskId });
    assert.equal(followUp.state, 'awaiting-host-review');
    assert.equal(followUp.continueFromTaskId, root.taskId, 'the task record states what it continues');
    assert.equal(followUp.execution.conversation.kind, 'continuation');
    assert.equal(followUp.execution.conversation.reused, true);
    assert.equal(followUp.execution.conversation.continuedFromTaskId, root.taskId);
    assert.equal(
      followUp.execution.conversation.sessionId,
      root.execution.conversation.sessionId,
      'the follow-up drives the SAME Session',
    );
    assert.equal(
      followUp.execution.conversation.workspaceId,
      root.execution.conversation.workspaceId,
      'in the SAME Workspace',
    );
    assert.equal(sessionController.creates.length, 1, 'a continuation must not create a Session');

    // A second follow-up of the same chain re-uses that thread rather than branching.
    const chained = await runTask('and one more', { continueFromTaskId: followUp.taskId });
    assert.equal(chained.execution.conversation.sessionId, root.execution.conversation.sessionId);
    assert.equal(sessionController.creates.length, 1);

    // The map holds identity and provenance only — no prompt, no model output.
    const stored = JSON.parse(await readFile(join(handle.directory, 'dsh-delegate', 'sessions.json'), 'utf8'));
    const record = stored.sessions.find((entry) => entry.taskId === root.taskId);
    assert.ok(record !== undefined, 'the root task recorded the thread it drove');
    assert.equal(typeof record.executionPath, 'string');
    assert.equal(JSON.stringify(stored).includes('start the thread'), false, 'no prompt may reach the identity map');
    assert.equal(JSON.stringify(stored).includes('carry on'), false, 'nor a follow-up prompt');
  } finally {
    await handle.dispose();
  }
});

test('a worktree follow-up reuses the parent tree and its uncommitted changes', async () => {
  const handle = await mountWithoutControllers({
    providers: { ...validSettings(), delegationEnabled: true, worker: { ...validSettings().worker, isolation: 'worktree' } },
    controllers: { agentPresets: fakeAgentPresets() },
  });
  try {
    const agents = fakeAgents({ respond: { text: 'turn' } });
    const { sessionController } = await publishPair(handle, agents);
    const { engine } = handle.published;
    engine.deps.runGit = fakeGit();
    const source = await realDirectory(handle.directory, 'worktree-source');
    const treePath = await realDirectory(handle.directory, 'managed-tree');
    const calls = { prepare: 0, get: 0, complete: 0 };
    let managedTree = null;
    engine.deps.worktrees = {
      async prepare({ taskId, sourcePath }) {
        calls.prepare += 1;
        managedTree = {
          taskId,
          workspacePath: treePath,
          sourcePath,
          baseHead: 'a'.repeat(40),
          isolated: true,
          detached: true,
          state: 'active',
        };
        return { ...managedTree };
      },
      get(path) {
        calls.get += 1;
        return managedTree !== null && path === treePath ? { ...managedTree } : null;
      },
      markComplete(path) {
        assert.equal(path, treePath);
        calls.complete += 1;
        managedTree.state = 'awaiting-host-review';
        return { ...managedTree };
      },
    };
    await engine.deps.ensureRoutes(await handle.published.settings.read());

    const runTask = async (prompt, extra = {}) => {
      const started = await engine.start({ connectionId: 'local-mcp', workspacePath: source, prompt, ...extra });
      return await settleTask(engine, started.taskId);
    };

    const parent = await runTask('create the first isolated change');
    assert.equal(parent.state, 'awaiting-host-review');
    assert.equal(parent.execution.workspacePath, treePath);
    assert.equal(parent.execution.conversation.kind, 'new');
    assert.equal(parent.conversationSaved, true);

    const followUp = await runTask('improve that same change', { continueFromTaskId: parent.taskId });
    assert.equal(followUp.state, 'awaiting-host-review');
    assert.equal(followUp.execution.workspacePath, treePath, 'the follow-up mutates the original tree');
    assert.equal(followUp.execution.conversation.kind, 'continuation');
    assert.equal(followUp.execution.conversation.sessionId, parent.execution.conversation.sessionId);
    assert.equal(followUp.execution.conversation.workspaceId, parent.execution.conversation.workspaceId);
    assert.equal(followUp.worktree.taskId, parent.taskId, 'tree ownership stays with the task that created it');
    assert.equal(calls.prepare, 1, 'a continuation must not create a clean replacement tree');
    assert.equal(calls.get, 2, 'the engine and DSH placement each verify the managed tree');
    assert.equal(calls.complete, 2, 'both turns leave the retained tree ready for host review');
    assert.equal(sessionController.creates.length, 1, 'the follow-up resumes the same Session');
  } finally {
    await handle.dispose();
  }
});

test('a worktree follow-up refuses when the original managed tree is no longer available', async () => {
  const handle = await mountWithoutControllers({
    providers: { ...validSettings(), delegationEnabled: true, worker: { ...validSettings().worker, isolation: 'worktree' } },
    controllers: { agentPresets: fakeAgentPresets() },
  });
  try {
    const agents = fakeAgents({ respond: { text: 'turn' } });
    const { sessionController } = await publishPair(handle, agents);
    const { engine } = handle.published;
    engine.deps.runGit = fakeGit();
    const source = await realDirectory(handle.directory, 'missing-tree-source');
    const treePath = await realDirectory(handle.directory, 'missing-managed-tree');
    let available = true;
    let taskId = null;
    engine.deps.worktrees = {
      async prepare(request) {
        taskId = request.taskId;
        return {
          taskId,
          workspacePath: treePath,
          sourcePath: request.sourcePath,
          baseHead: 'a'.repeat(40),
          isolated: true,
          detached: true,
          state: 'active',
        };
      },
      get() {
        if (!available) return null;
        return {
          taskId,
          workspacePath: treePath,
          sourcePath: source,
          baseHead: 'a'.repeat(40),
          isolated: true,
          detached: true,
          state: 'awaiting-host-review',
        };
      },
      markComplete() { return { taskId, state: 'awaiting-host-review' }; },
    };
    await engine.deps.ensureRoutes(await handle.published.settings.read());

    const started = await engine.start({ connectionId: 'local-mcp', workspacePath: source, prompt: 'start isolated work' });
    const parent = await settleTask(engine, started.taskId);
    assert.equal(parent.state, 'awaiting-host-review');
    available = false;

    await assert.rejects(
      () => engine.start({
        connectionId: 'local-mcp',
        workspacePath: source,
        prompt: 'continue isolated work',
        continueFromTaskId: parent.taskId,
      }),
      (error) => {
        assert.equal(error.code, 'JOB_CONTINUATION_REFUSED');
        assert.equal(error.details.session, SESSION_CODES.continuationUnavailable);
        return true;
      },
    );
    const refused = engine.list().find((task) => task.continueFromTaskId === parent.taskId);
    assert.ok(refused !== undefined);
    assert.equal(refused.state, 'failed');
    assert.equal(refused.error.code, 'JOB_CONTINUATION_REFUSED');
    assert.equal(refused.error.details.session, SESSION_CODES.continuationUnavailable);
    assert.equal(refused.execution, null, 'the absent tree is never replaced by a fresh checkout');
    assert.equal(sessionController.creates.length, 1, 'no unrelated conversation is created');
  } finally {
    await handle.dispose();
  }
});

test('a follow-up naming an unknown task is refused, not started as a new conversation', async () => {
  const handle = await mountWithoutControllers({
    providers: { ...validSettings(), delegationEnabled: true },
    controllers: { agentPresets: fakeAgentPresets() },
  });
  try {
    const agents = fakeAgents({ respond: { text: 'turn' } });
    const { sessionController } = await publishPair(handle, agents);
    const { engine } = handle.published;
    engine.deps.runGit = fakeGit();
    const directory = await realDirectory(handle.directory, 'unknown-parent');
    await engine.deps.ensureRoutes(await handle.published.settings.read());
    const resolvesBefore = sessionController.resolves.length;

    // Ownership is decided during admission, before a slot, worktree or Session can
    // be created. An id this deployment cannot prove belongs to the caller is
    // answered exactly like a task that never existed: one stable code and one
    // message, with no Session or state reason attached, because naming a reason
    // would confirm that some other task exists.
    await assert.rejects(
      () => engine.start({
        connectionId: 'local-mcp',
        workspacePath: directory,
        prompt: 'continue something that never existed',
        continueFromTaskId: 'task-does-not-exist',
      }),
      (error) => {
        assert.equal(error.code, 'JOB_TASK_NOT_FOUND');
        assert.equal(error.details?.session, undefined, 'an unknown parent names no Session reason');
        assert.equal(error.details?.reason, undefined, 'an unknown parent names no diagnostic reason');
        assert.equal(error.details?.continueFromTaskId, 'task-does-not-exist');
        return true;
      },
    );
    const refused = engine.list().find((task) => task.continueFromTaskId === 'task-does-not-exist');
    assert.ok(refused !== undefined);
    assert.equal(refused.state, 'failed', 'a refused continuation must not run as a new conversation');
    assert.equal(refused.error.code, 'JOB_TASK_NOT_FOUND');
    assert.equal(refused.error.details.session, undefined, 'the recorded failure keeps no Session reason');
    assert.equal(refused.error.details.reason, undefined, 'the recorded failure keeps no diagnostic reason');
    // The id is echoed because the caller supplied it; it is the ONLY continuation
    // fact this refusal carries, and it can never be another task's id.
    assert.equal(refused.error.details.continueFromTaskId, 'task-does-not-exist');
    assert.equal(refused.execution, null, 'the run never reached a conversation');
    assert.equal(sessionController.creates.length, 0, 'a refused continuation creates no conversation');
    assert.equal(sessionController.resolves.length, resolvesBefore, 'and resolves no Session either');
  } finally {
    await handle.dispose();
  }
});

test('a follow-up to a still-running task is refused, so one chain never runs twice', async () => {
  const handle = await mountWithoutControllers({
    providers: { ...validSettings(), delegationEnabled: true },
    controllers: { agentPresets: fakeAgentPresets() },
  });
  try {
    // A conversation that never goes idle: the first task stays running for the
    // whole test, which is exactly the "parent is live" case.
    const agents = fakeAgents();
    const { workspaces, sessionController } = await publishPair(handle, agents);
    const { engine } = handle.published;
    engine.deps.runGit = fakeGit();
    const directory = await realDirectory(handle.directory, 'live-parent');
    await engine.deps.ensureRoutes(await handle.published.settings.read());

    const running = await engine.start({
      connectionId: 'local-mcp',
      workspacePath: directory,
      prompt: 'long task',
    });
    // Wait until the parent has really started, so the refusal is about liveness.
    for (let attempt = 0; attempt < 200 && engine.get(running.taskId).state === 'pending'; attempt += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    assert.equal(engine.get(running.taskId).state, 'running');

    // A live parent is refused during admission, so `start()` itself rejects: the
    // engine decides liveness before it does anything a parent could conflict with.
    await assert.rejects(
      () => engine.start({
        connectionId: 'local-mcp',
        workspacePath: directory,
        prompt: 'follow up too early',
        continueFromTaskId: running.taskId,
      }),
      (error) => {
        assert.equal(error.code, 'JOB_CONTINUATION_REFUSED');
        assert.match(error.message, /still running/);
        assert.equal(error.details.session, SESSION_CODES.continuationState);
        return true;
      },
    );

    await engine.cancel(running.taskId, 'test');
    // Nothing was created for the refused follow-up: one Workspace, one Session.
    assert.equal(workspaces.workspaces.size, 1, 'the refused follow-up created no second Workspace');
    assert.equal(sessionController.creates.length, 1, 'and only the parent\'s own Session exists');
  } finally {
    await handle.dispose();
  }
});
