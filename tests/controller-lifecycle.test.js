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
//  * the grouping/reuse behaviour already shipped in 0.1.8 is unchanged
//    (no regression: same directory -> one Workspace + a new Session per run, or
//    the recorded Session under `reuse`).
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
import { CONVERSATION_MODES } from '../src/config/defaults.js';
import {
  cleanup,
  fakeAgentPresets,
  fakeAgents,
  fakeSessionController,
  fakeWorkspaceController,
  makeTempDir,
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
  process.env.DSH_HOME = directory;
  let published = null;
  ctx.provide = (serviceName, value) => { published = value; };
  try {
    await apply(ctx, { dataDir: directory });
  } finally {
    process.env.DSH_HOME = previousHome;
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
 * @param {object} handle - the mount handle.
 * @param {object} agents - the fake agent registry the run will be dispatched with.
 * @param {object} [controllers] - an existing {@link controllerPair} to publish.
 * @returns {Promise<object>} the published pair.
 */
async function publishPair(handle, agents, controllers = null) {
  const pair = controllers ?? controllerPair(handle, { respond: agents.respondPlan ?? { text: 'ok' } });
  handle.publish('workspaceController', pair.workspaces);
  handle.publish('sessionController', pair.sessionController);
  return pair;
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

test('reuse continues the Session recorded for the same directory, through the real engine', async () => {
  // The other half of the shipped behaviour, and the reason this test drives the
  // real `JobEngine`: recording the identity a `reuse` run resumes is the ENGINE's
  // job (`rememberConversation`), so a runner-only test would assert a resume that
  // nothing ever wrote down.
  //
  // Both controllers are published AFTER the plugin activated, so the run that
  // records and the run that resumes each go through the late-bound accessors.
  const handle = await mountWithoutControllers({
    // `reuse` is the operator's opt-in conversation mode, and the local-call
    // switch must be on for a task to start at all — both are plugin config, not
    // wiring, so they are stated in the mounted document.
    providers: { ...validSettings(), delegationEnabled: true, conversation: { mode: 'reuse' } },
    // A run that joins no preset composition has no tools and is refused before an
    // agent exists, so the harness must offer one. It is published BEFORE
    // activation here only because the preset registry is not a placement
    // controller: the two services under test are still published afterwards.
    controllers: { agentPresets: fakeAgentPresets() },
  });
  try {
    const agents = fakeAgents({ respond: { text: 'turn' } });
    const { sessionController } = await publishPair(handle, agents);

    const { engine, auth } = handle.published;
    // The engine's audit/preflight layer shells out to `git`. The real binary is
    // not available to a confined test process, and the audit is not what this
    // test is about, so the runner answers in the NUL-delimited shape the parser
    // requires (an empty tree with no changes) instead of being skipped.
    engine.deps.runGit = fakeGit();
    // The engine resolves the directory it is handed, so the run needs a real one.
    const directory = await realDirectory(handle.directory, 'placement');

    // A task may only start on a route the native runtime actually serves. The
    // route set is this plugin's own registration, so it is ensured from the
    // mounted document before the first dispatch; routing itself is covered by
    // `entry.test.js` and is not what this test is about.
    await engine.deps.ensureRoutes(await handle.published.settings.read());

    /**
     * Authorize and run one task in `path`, then wait for it to settle.
     * @param {string} path - execution directory.
     * @param {string} prompt - task prompt.
     * @returns {Promise<object>} settled task view.
     */
    const runTask = async (path, prompt) => {
      const connection = auth.issueConnection({ label: 'lifecycle' });
      const grant = auth.issueGrant(connection.connectionId, {
        kind: 'task',
        workspacePath: path,
        ttlSeconds: 600,
      });
      const started = await engine.start({
        connectionId: connection.connectionId,
        grantId: grant.grantId,
        workspacePath: path,
        prompt,
      });
      return await settleTask(engine, started.taskId);
    };

    const fresh = await runTask(directory, 'start the conversation');
    assert.equal(fresh.state, 'awaiting-host-review', 'the first task must complete');
    assert.equal(fresh.execution.conversation.reused, false, 'nothing was recorded for this directory yet');
    assert.equal(fresh.conversationSaved, true, 'the engine recorded the Session it drove');

    // The same directory continues THAT conversation: no second Session is made.
    const continued = await runTask(directory, 'carry on');
    assert.equal(continued.execution.conversation.reused, true, 'the recorded Session is resumed');
    assert.equal(continued.execution.conversation.sessionId, fresh.execution.conversation.sessionId);
    assert.equal(continued.execution.conversation.workspaceId, fresh.execution.conversation.workspaceId);
    assert.equal(sessionController.creates.length, 1, 'reuse must not create a second Session');

    // The map holds the identity and nothing else — no prompt, no model output.
    const stored = JSON.parse(await readFile(join(handle.directory, 'dsh-delegate', 'sessions.json'), 'utf8'));
    const record = stored.sessions.find((entry) => entry.sessionId === fresh.execution.conversation.sessionId);
    assert.ok(record !== undefined, 'the run recorded the Session it drove');
    assert.deepEqual(Object.keys(record).sort(), ['path', 'sessionId', 'updatedAt', 'workspaceId']);
    assert.equal(JSON.stringify(stored).includes('carry on'), false, 'no prompt may reach the session map');
  } finally {
    await handle.dispose();
  }
});
