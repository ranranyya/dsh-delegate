// Provider-definition lease: one served configuration per process, per task.
//
// The defect this file pins is not visible in any single ensure. `LlmRuntime` and
// the native adapter are both built for "latest configuration wins": the adapter
// answers every model operation from `current().profiles`, and the registry's
// `replace()` swaps that generation in place. A multi-turn native agent therefore
// re-reads the served provider set on *every* turn, so a settings edit (or another
// job's catalog read) that lands between two turns would move an already-running
// task onto a different endpoint, model list or credential reference 鈥攚hile
// `task.effective` still names the configuration the task started with.
//
// The lease closes that window. These tests drive it through the *real*
// `LlmRuntime`, the *real* adapter, the *real* registry and the production
// `ensureRoutes` transaction, with a deterministic local API pair standing in for
// two upstream endpoints. Nothing is stubbed except the Cordis context the runtime
// is constructed with, the DSH credential service, and `globalThis.fetch`.
//
// Two halves:
//   1. the registry's own contract (`lease`/`release`/`heldLease`, admission for
//      `ensure` and `register`, failed admission, unsupported seams);
//   2. the engine's contract: a two-turn task stays on A, an attempt to apply B
//      between its turns is refused before publication, and B becomes usable once
//      the task drains.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { LlmRuntime } from '@deepseek-ai/dsh-llm';

import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { JobEngine, JOB_CODES, TASK_STATES } from '../src/jobs/engine.js';
import { createOpenAiAdapter } from '../src/model/openai-adapter.js';
import { createProviderRegistry, managedProvidersOf, nativeProvidersOf, PROVIDER_SET_CODES } from '../src/model/providers.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import {
  cleanup,
  fakeAgents,
  fakeSessionController,
  fakeWorkspaceController,
  makeTempDir,
  validSettings,
} from './helpers/fakes.js';

// ---------------------------------------------------------------------------
// The real composition, with a deterministic local API pair underneath.
// ---------------------------------------------------------------------------

/**
 * A Cordis-shaped context good enough to construct a real `LlmRuntime`.
 * @returns {object} context with an `effects` log.
 */
function runtimeContext() {
  const effects = [];
  const ctx = {
    effects,
    reflect: { provide: () => () => {} },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    events: { dispatch: () => [] },
    effect(generator) {
      const iterator = generator.call(ctx);
      const first = iterator.next();
      const dispose = typeof first.value === 'function' ? first.value : () => {};
      effects.push(dispose);
      return dispose;
    },
    waterfall: () => Promise.resolve([]),
  };
  return ctx;
}

/** A credential service whose values never leave this process. */
function fakeCredentials() {
  return {
    async resolve(ref) {
      return { value: `fixture-value-for-${ref}`, source: 'test-store' };
    },
    async describe(ref) {
      return { configured: true, reference: ref, writable: true };
    },
  };
}

/**
 * One validated provider profile, shaped the way `src/config/validate.js` stores it.
 * @param {object} [overrides] - profile field overrides.
 * @returns {object} provider profile.
 */
function workbuddy(overrides = {}) {
  return {
    id: 'workbuddy',
    name: 'WorkBuddy',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:8443/v1',
    credentialRef: 'WORKBUDDY_KEY',
    models: [{ id: 'deepseek-v4.1-flash', name: 'Flash', efforts: ['off', 'low', 'high'] }],
    ...overrides,
  };
}

/**
 * One settings snapshot selecting the `workbuddy` profile.
 * @param {object[]} providers - provider list.
 * @returns {object} settings document.
 */
function settingsDocument(providers) {
  const document = validSettings({
    worker: { providerId: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', isolation: 'shared' },
    review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
  });
  return { ...document, providers };
}

/**
 * Build the entry point's composition exactly as `src/index.js` does: one real
 * runtime, one adapter facade, one registry, and `ensureRoutes` publishing the
 * adapter snapshot and registering the routes in one synchronous section.
 * @returns {object} wiring.
 */
function wire() {
  const ctx = runtimeContext();
  const llm = new LlmRuntime(ctx);
  const adapter = createOpenAiAdapter({ credentials: fakeCredentials() });
  const registry = createProviderRegistry({ llm, adapter });

  /**
   * The production `ensureRoutes` transaction.
   *
   * It mirrors `src/index.js` exactly on the one point that matters for the lease:
   * the list handed to the registry is `managedProvidersOf(snapshot.providers)`,
   * not the whole settings list. A harness that registered the full list would
   * fingerprint a different set from the engine's lease and fail this file in a way
   * production does not.
   * @param {object} snapshot - settings snapshot.
   * @returns {Promise<Map<string, string>>} public provider id -> native route.
   */
  const ensureRoutes = async (snapshot) => {
    const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
    const routes = new Map();
    for (const provider of nativeProvidersOf(providers)) routes.set(provider.id, provider.id);
    const managed = managedProvidersOf(providers);
    if (managed.length === 0) {
      await registry.register(managed, () => {});
      return routes;
    }
    const adapt = (candidate, commit) => {
      const prepared = adapter.prepareRoutes({ providers: managed, routes: candidate });
      if (!adapter.describes(prepared, candidate)) {
        prepared.rollback();
        throw new Error('dsh-delegate: the adapter and the registry planned different route sets');
      }
      try {
        commit();
      } catch (error) {
        prepared.rollback();
        throw error;
      }
    };
    const ensured = await registry.register(managed, adapt);
    for (const [id, route] of ensured.routes) routes.set(id, route);
    return routes;
  };

  return { ctx, llm, adapter, registry, ensureRoutes };
}

/** A git runner answering in the NUL-delimited format the audit layer parses. */
function engineGit() {
  return async (_cwd, args) => {
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${'a'.repeat(40)}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '1\t0\tsrc/a.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+work\n', code: 0 };
    return { stdout: '', code: 0 };
  };
}

/** The plugin-owned read-only review composition, stubbed at its contract. */
function reviewComposer() {
  const id = 'dsh-delegate-review-test';
  return {
    get id() { return id; },
    owns(candidate) { return candidate === id; },
    async preparation() { return id; },
  };
}

/**
 * An agent registry whose turns the test controls.
 *
 * `fakeAgents` settles a turn from a fixed script; here each prompt opens a turn
 * that stays open until the test calls `openTurn(index)`, which is what makes
 * "between two turns of one running task" an observable moment rather than a race.
 * Events are emitted in the native order (`text-delta`, then the completed
 * `assistant/message`, then `turn/end`), to the listeners the runner installed on
 * that agent's scope. Identity, idle waiting and disposal are the shared fake's.
 * @param {string[]} replies - text for each turn, in order.
 * @returns {object} agent registry with `turns` and `openTurn(index)`.
 */
function gatedAgents(replies) {
  const agents = fakeAgents();
  const turns = [];
  const originalCreate = agents.create.bind(agents);

  agents.create = async (request) => {
    const handle = await originalCreate(request);
    const record = agents.created.at(-1);
    handle.agent.followup = (message) => {
      record.followups.push(message);
      record.idle = false;
      const index = turns.length;
      turns.push({
        index,
        text: replies[index] ?? `reply ${index}`,
        delivered: true,
        open: () => {
          const text = replies[index] ?? `reply ${index}`;
          for (const entry of agents.listeners) {
            if (entry.record !== record || entry.event !== 'session/event') continue;
            entry.listener({ id: record.agent.session.id }, { type: 'text-delta', data: { text } });
            entry.listener({ id: record.agent.session.id }, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text }] } },
            });
            entry.listener({ id: record.agent.session.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          }
          record.idle = true;
          for (const waiter of record.idleWaiters.splice(0)) waiter();
        },
      });
    };
    return handle;
  };

  return { ...agents, turns, openTurn: (index) => { turns[index].open(); } };
}

/**
 * A session controller whose resolved agents deliver gated turns.
 *
 * A PLACED run drives the Agent the session controller resolves, not one it
 * creates, so "between two turns of one running task" has to be observable there.
 * Each prompt opens a turn that stays open until the test calls `openTurn(index)`;
 * events are emitted in the native order (`text-delta`, then the completed
 * `assistant/message`, then `turn/end`) to the listeners the runner installed on
 * that agent's own context.
 * @param {object} workspaces - the Workspace controller the sessions belong to.
 * @param {string[]} replies - text for each turn, in order.
 * @returns {object} session controller with `turns` and `openTurn(index)`.
 */
function gatedSessionController(workspaces, replies) {
  const controller = fakeSessionController({ workspaces });
  const turns = [];
  const resolveOriginal = controller.resolveAgent.bind(controller);
  controller.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found.agent;
    if (agent === undefined) return found;
    agent.followup = (message) => {
      agent.followups.push(message);
      const index = turns.length;
      turns.push({
        index,
        text: replies[index] ?? `reply ${index}`,
        delivered: true,
        open: () => {
          const text = replies[index] ?? `reply ${index}`;
          for (const entry of agent.listeners) {
            if (entry.event !== 'session/event') continue;
            entry.listener({ id: agent.session.id }, { type: 'text-delta', data: { text } });
            entry.listener({ id: agent.session.id }, {
              type: 'assistant/message',
              data: { message: { content: [{ type: 'text', text }] } },
            });
            entry.listener({ id: agent.session.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
          }
          agent.idle = true;
          for (const waiter of agent.idleWaiters.splice(0)) waiter();
        },
      });
      agent.idle = false;
    };
    return found;
  };
  controller.turns = turns;
  controller.openTurn = (index) => { turns[index].open(); };
  return controller;
}

/**
 * Build an engine over the real composition, one temporary workspace, and a
 * settings service the test edits directly (as an operator would).
 * @param {object} [options] - `providerRegistry`.
 * @returns {Promise<object>} harness.
 */
async function engineWire(options = {}) {  const wired = wire();
  const dir = await makeTempDir();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(settingsDocument([workbuddy()]));
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const agents = fakeAgents();
  // A worker run is placed in a Workspace and drives the agent the session
  // controller resolves for it. Gated turns are the default (a test opens each
  // one); a caller testing something other than turn boundaries can hand in an
  // auto-answering controller instead.
  const workspaces = options.workspaces ?? fakeWorkspaceController();
  const sessionController = options.sessionController ?? gatedSessionController(workspaces, ['first', 'second']);
  const deps = {
    agents,
    agentPresets: { async mount() { return { id: 'default' }; } },
    reviewPresets: reviewComposer(),
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    llm: options.llm ?? wired.llm,
    settings,
    auth,
    locks,
    runGit: engineGit(),
    providerRegistry: options.providerRegistry ?? wired.registry,
    // The production seam: without it the engine falls back to route-only
    // registration, which is a different code path. A case that is specifically
    // about the registry's own `ensure` omits it with `useRouteSeam: false`.
    ensureRoutes: wired.ensureRoutes,
    logger: { info() {}, warn() {} },
  };
  if (options.useRouteSeam === false) delete deps.ensureRoutes;
  const engine = new JobEngine(deps);

  /**
   * Issue a connection and a grant covering this harness's workspace.
   * @returns {{ connectionId: string, grantId: string }} authorization.
   */
  function authorize() {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, { kind: 'task', workspacePath: workspace, ttlSeconds: 600 });
    return { connectionId: connection.connectionId, grantId: grant.grantId };
  }

  return {
    ...wired,
    dir,
    workspace,
    settings,
    auth,
    engine,
    // The harness's `agents` is the carrier of the gated turns, which for a
    // PLACED run is the session controller's resolved-agent side. Tests read
    // `turns`/`openTurn` here; the agent registry's `created` list stays empty by
    // design because a placed run creates no agent through it.
    agents: sessionController,
    deps,
    authorize,
    async close() {
      await engine.dispose();
      wired.registry.dispose();
      await cleanup(dir);
    },
  };
}

/**
 * Wait until a task leaves the live states.
 * @param {object} engine - job engine.
 * @param {string} taskId - task id.
 * @returns {Promise<object>} settled view.
 */
async function settleTask(engine, taskId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const task = engine.get(taskId);
    if (task.state !== TASK_STATES.running && task.state !== TASK_STATES.pending) return task;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  return engine.get(taskId);
}

/**
 * Wait until the gated agent registry has created `count` agents *and* delivered
 * their prompts.
 *
 * Creation is not the moment a turn exists. `runAgent` awaits
 * `agents.create()`, then awaits the agent's own initial quiescence
 * (`agent.whenIdle()`) before it calls `agent.followup(prompt)` 鈥?so between
 * those two awaits there is a real, observable gap in which the agent exists and
 * the test's override on `followup` has not fired yet. A test that opens turn
 * `index` as soon as `created.length` reaches `index + 1` therefore races the
 * delivery and indexes a turn that does not exist yet.
 *
 * Waiting for `turns.length` instead makes "the task is on its turn, with the
 * prompt delivered" the condition, which is what every caller of this helper
 * actually means.
 *
 * Note which counter is read: a PLACED run drives the agent the session
 * controller resolved, so `agents.created` stays empty by design and
 * `agents.turns` (the gated turns on the resolved agents) is the only counter
 * that moves.
 * @param {object} agents - the harness's gated turn carrier (`turns`/`openTurn`).
 * @param {number} count - turns expected, i.e. prompts delivered.
 * @returns {Promise<void>} resolves when they exist.
 */
async function waitForAgents(agents, count) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (agents.turns.length >= count) return;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  throw new Error(`only ${agents.turns.length} turn(s) were delivered, expected ${count}`);
}

/**
 * Wait until a task has left the `pending` state, i.e. admission finished.
 * @param {object} engine - job engine.
 * @param {string} taskId - task id.
 * @returns {Promise<object>} the view once the task is admitted or terminal.
 */
async function waitForAdmitted(engine, taskId) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const task = engine.get(taskId);
    if (task.state !== TASK_STATES.pending) return task;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  return engine.get(taskId);
}

/** A second configuration for the same provider id, on another endpoint. */
function workbuddyOnAnotherEndpoint() {
  return workbuddy({
    name: 'WorkBuddy (B)',
    baseUrl: 'http://127.0.0.1:9443/v1',
    credentialRef: 'WORKBUDDY_KEY_B',
  });
}

// ---------------------------------------------------------------------------
// Registry contract.
// ---------------------------------------------------------------------------

test('a held provider set is shared by identical sets and refused for a different one', async () => {
  const { registry, adapter, llm, ensureRoutes } = wire();
  const routes = await ensureRoutes({ providers: [workbuddy()] });
  assert.deepEqual([...routes], [['workbuddy', 'dsh-delegate:workbuddy']]);

  const first = registry.lease([workbuddy()], 'task-a');
  const second = registry.lease([workbuddy()], 'task-b');
  assert.equal(registry.heldLease().count, 2, 'identical sets share one lease');

  // A different endpoint, name, credential reference or model axis is a different
  // definition set; each is refused with the stable busy code.
  const candidates = [
    [workbuddy({ baseUrl: 'http://127.0.0.1:9443/v1' })],
    [workbuddy({ name: 'Renamed' })],
    [workbuddy({ credentialRef: 'OTHER_REF' })],
    [workbuddy({ models: [{ id: 'deepseek-v4.1-flash', name: 'Flash', efforts: ['off'] }] })],
    [workbuddy(), workbuddy({ id: 'relay', name: 'Relay', baseUrl: 'http://127.0.0.1:7443/v1' })],
  ];
  for (const providers of candidates) {
    assert.throws(
      () => registry.lease(providers, 'other-task'),
      (error) => error.code === PROVIDER_SET_CODES.busy,
      `a changed definition must be refused: ${JSON.stringify(providers)}`,
    );
  }

  // Both ensure paths refuse too, and neither reaches the adapter or the core.
  const served = adapter.snapshot();
  const published = [];
  await assert.rejects(
    () => ensureRoutes({ providers: [workbuddyOnAnotherEndpoint()] }),
    (error) => error.code === PROVIDER_SET_CODES.busy,
  );
  await assert.rejects(
    () => registry.ensure([workbuddyOnAnotherEndpoint()]),
    (error) => error.code === PROVIDER_SET_CODES.busy,
  );
  await assert.rejects(
    () => registry.register([workbuddyOnAnotherEndpoint()], () => { published.push('ran'); }),
    (error) => error.code === PROVIDER_SET_CODES.busy,
  );
  assert.deepEqual(published, [], 'the callback must not run for a refused set');
  assert.deepEqual([...adapter.snapshot().routes], [...served.routes], 'the adapter must still serve A');
  assert.deepEqual(
    llm.listProviders().map((entry) => [entry.id, entry.name]),
    [['dsh-delegate:workbuddy', 'WorkBuddy']],
    'the core must still describe A',
  );

  // An identical set always proceeds, through both paths.
  assert.deepEqual([...(await ensureRoutes({ providers: [workbuddy()] }))], [['workbuddy', 'dsh-delegate:workbuddy']]);
  assert.deepEqual([...(await registry.ensure([workbuddy()])).routes], [['workbuddy', 'dsh-delegate:workbuddy']]);

  // Releasing one of two holders keeps the set pinned; the last release frees it.
  assert.equal(registry.release(first), true);
  assert.equal(registry.release(first), false, 'a lease is released once');
  assert.equal(registry.heldLease().count, 1);
  await assert.rejects(() => registry.ensure([workbuddyOnAnotherEndpoint()]), (error) => error.code === PROVIDER_SET_CODES.busy);

  assert.equal(registry.release(second), true);
  assert.equal(registry.heldLease(), null);
  const changed = await ensureRoutes({ providers: [workbuddyOnAnotherEndpoint()] });
  assert.deepEqual([...changed], [['workbuddy', 'dsh-delegate:workbuddy']]);
  assert.deepEqual(llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy (B)']]);
});

test('a lease is released when the set it pinned is no longer held, and unissued leases are refused', async () => {
  const { registry } = wire();
  const lease = registry.lease([workbuddy()], 'task-a');
  // A foreign object that merely looks like a lease cannot drain the hold.
  assert.equal(registry.release({ kind: 'provider-definition-lease', fingerprint: lease.fingerprint, holder: 'task-a' }), false);
  assert.equal(registry.heldLease().count, 1);
  assert.equal(registry.release(null), false);
  assert.equal(registry.release(lease), true);
  assert.equal(registry.heldLease(), null);
});

test('dispose frees the lease and refuses a new one', () => {
  const { registry } = wire();
  registry.lease([workbuddy()], 'task-a');
  assert.notEqual(registry.heldLease(), null);
  registry.dispose();
  assert.equal(registry.heldLease(), null, 'a disposed registry cannot keep a set pinned');
  assert.throws(() => registry.lease([workbuddy()], 'task-b'), /has been disposed/u);
});

test('the fingerprint is deterministic and ignores nothing that reaches a model call', () => {
  const { registry } = wire();
  // Two structurally equal (but separately built, differently keyed) documents are
  // the same set, so a reloaded settings snapshot can still share a lease.
  const a = registry.lease([workbuddy()], 'a');
  const reordered = workbuddy();
  const b = registry.lease([{
    models: reordered.models.map((model) => ({ efforts: model.efforts, id: model.id, name: model.name })),
    credentialRef: reordered.credentialRef,
    baseUrl: reordered.baseUrl,
    protocol: reordered.protocol,
    name: reordered.name,
    id: reordered.id,
  }], 'b');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(registry.heldLease().count, 2);

  // ...while an endpoint change does not.
  assert.notEqual(
    registry.heldLease().fingerprint,
    (() => {
      const probe = createProviderRegistry({ llm: { registerAdapter: () => () => {}, listProviders: () => [] }, adapter: { stream() {}, providerInfo: () => null } });
      try {
        return probe.lease([workbuddyOnAnotherEndpoint()], 'probe').fingerprint;
      } catch {
        return null;
      }
    })() ?? 'unavailable',
  );
  assert.equal(registry.release(a), true);
  assert.equal(registry.release(b), true);
});

test('a failed ensure releases its own hold instead of pinning the process', async () => {
  // A runtime that cannot enumerate its routes refuses the first registration; the
  // ensure's transient lease must not survive that failure.
  const { adapter } = wire();
  const refused = createProviderRegistry({
    llm: {
      registerAdapter() { throw new Error('must not be reached'); },
      listProviders() { throw new Error('unsupported operation: listProviders'); },
    },
    adapter: adapter.nativeAdapter(),
  });
  await assert.rejects(() => refused.ensure([workbuddy()]), /cannot list its registered provider routes/u);
  assert.equal(refused.heldLease(), null, 'a refused ensure must not keep the set pinned');
  // And the next attempt is judged on its own merits, not on a leaked hold.
  await assert.rejects(() => refused.ensure([workbuddyOnAnotherEndpoint()]), /cannot list its registered provider routes/u);
});

// ---------------------------------------------------------------------------
// Native-only configurations: one canonical provider set for lease and routes.
//
// The defect these cases pin was deterministic and needed no second task. The
// engine leased `settings.providers` — the whole list, native references included
// — while `ensureRoutes` registered only the custom subset. On the installed
// settings (`[{ id: 'workbuddy', source: 'native' }]`) that is a lease on
// `[workbuddy]` followed by a registration of `[]` in the *same* task's preflight:
// the registry fingerprints sets exactly, so the task refused its own lease with
// `PROVIDER_SET_BUSY` and `routeCount` 0. The fix is one canonical set on both
// sides (`managedProvidersOf`), which these tests assert by behaviour and by
// fingerprint.
// ---------------------------------------------------------------------------

/** The installed configuration: one native DSH reference and nothing custom. */
function nativeWorkbuddy() {
  return {
    id: 'workbuddy',
    name: 'WorkBuddy',
    source: 'native',
    protocol: null,
    baseUrl: null,
    credentialRef: null,
    models: [{ id: 'deepseek-v4.1-flash', name: 'Flash', efforts: ['off', 'low', 'high'] }],
  };
}

/** A second, custom profile, so a mixed configuration has something to register. */
function relay(overrides = {}) {
  return {
    id: 'relay',
    name: 'Local relay',
    source: 'user',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:7443/v1',
    credentialRef: 'RELAY_KEY',
    models: [{ id: 'deepseek-chat', name: 'Chat', efforts: ['low', 'high'] }],
    ...overrides,
  };
}

/**
 * The DSH-owned registration of one native reference, as the harness itself makes it.
 *
 * A native profile (`source: 'native'`) is a *reference* to a route the harness
 * owns; this plugin registers no adapter for it. The route therefore only exists
 * if DSH registered it, so the fixture registers a minimal native adapter through
 * the real `LlmRuntime.registerAdapter(providers, adapter)` API instead of faking
 * `listProviders()`. Registering makes the core enforce the parts that matter
 * here: the route is routable (`resolveModelInfo('workbuddy', …)` answers), it is
 * owned by an adapter this plugin did not create, and attempting to register the
 * same route again would be refused — which is what a non-empty plugin route set
 * for `workbuddy` amounts to.
 *
 * The adapter is test-only and minimal: `resolveModel` answers the metadata the
 * profile declares, and `stream` refuses, because no case in this file streams a
 * native call.
 * @param {object} llm - the real `LlmRuntime` under test.
 * @param {object} provider - the native profile (`nativeWorkbuddy()`).
 * @returns {{ route: { id: string, name: string }, dispose: () => void }} the native route listing plus the release disposer.
 */
function registerNativeAdapter(llm, provider) {
  const route = provider.id;
  const models = Array.isArray(provider.models) ? provider.models : [];
  const adapter = {
    providerInfo: (owned) => ({ id: owned, name: provider.name }),
    // The base-class default every real `LlmAdapter` inherits: no route-owned
    // retry policy, so the core applies its own defaults.
    providerRetryPolicy: () => undefined,
    async listModels() {
      return models.map((model) => {
        const { id, name } = model;
        return { id, name };
      });
    },
    async resolveModel(owned, model) {
      if (owned !== route) throw new Error(`native fixture does not serve route ${owned}`);
      const declared = models.find((candidate) => candidate.id === model);
      if (declared === undefined) throw new Error(`native fixture does not serve model ${model}`);
      // `LlmRuntime.normalizeModelInfo` validates this shape: identity is echoed
      // back exactly, and every declared effort is `{ id, name }`.
      return {
        provider: owned,
        id: model,
        name: declared.name,
        reasoning: { efforts: declared.efforts.map((effort) => ({ id: effort, name: effort })) },
      };
    },
    stream() {
      throw new Error('the native fixture is not streamed by the provider-lease cases');
    },
  };
  const dispose = llm.registerAdapter([route], adapter);
  return { route: { id: route, name: provider.name }, dispose };
}

test('the canonical split keeps native references out and preserves custom order', () => {
  // The helper is the single rule both halves use; assert it directly so a future
  // edit cannot quietly reintroduce a second hand-written filter.
  assert.deepEqual(managedProvidersOf([nativeWorkbuddy()]), []);
  assert.deepEqual(nativeProvidersOf([nativeWorkbuddy()]).map((entry) => entry.id), ['workbuddy']);
  assert.deepEqual(managedProvidersOf([nativeWorkbuddy(), relay(), relay({ id: 'other' })]).map((entry) => entry.id), ['relay', 'other']);
  assert.deepEqual(nativeProvidersOf([nativeWorkbuddy(), relay()]).map((entry) => entry.id), ['workbuddy']);
  // A store shape without a `source` field is custom, matching `src/index.js`.
  assert.equal(managedProvidersOf([{ id: 'plain' }]).length, 1);
  assert.deepEqual(managedProvidersOf(undefined), []);
  assert.deepEqual(managedProvidersOf('not-a-list'), []);
});

test('a native-only configuration leases and registers the same empty custom set', async () => {
  const { registry, adapter, llm, ensureRoutes } = wire();
  // The engine's half: a lease over the canonical (empty) custom set.
  const lease = registry.lease(managedProvidersOf([nativeWorkbuddy()]), 'task-1');
  // The route half must be the same set, i.e. accepted by the very lease above.
  // Before the fix this call was itself the refusal: PROVIDER_SET_BUSY, routeCount 0.
  const routes = await ensureRoutes({ providers: [nativeWorkbuddy()] });
  assert.deepEqual([...routes], [['workbuddy', 'workbuddy']], 'a native route is the DSH route id of the same name');
  assert.equal(registry.heldLease()?.count, 1, 'the ensure must not displace the task lease');
  assert.deepEqual(registry.heldLease().fingerprint, lease.fingerprint, 'lease and registration describe one set');
  assert.deepEqual([...adapter.snapshot().routes], [], 'no adapter route is published for a native reference');
  // The registry's own fingerprint of the canonical set is the engine's. An empty
  // set registers nothing, so the ensure resolves to an empty mapping; it is a
  // Promise and has to be awaited before its routes are read.
  const ensured = await registry.ensure(managedProvidersOf([nativeWorkbuddy()]));
  assert.deepEqual([...ensured.routes], [], 'an empty custom set ensures an empty route mapping');
  assert.equal(llm.listProviders().length, 0, 'a native-only configuration registers no plugin adapter');

  // A different custom set is still refused while this one is pinned.
  await assert.rejects(
    () => ensureRoutes({ providers: [nativeWorkbuddy(), relay()] }),
    (error) => error.code === PROVIDER_SET_CODES.busy,
  );
  assert.equal(registry.release(lease), true);
  assert.equal(registry.heldLease(), null);

  // Free again, the mixed set applies: only its custom half is registered.
  const mixed = await ensureRoutes({ providers: [nativeWorkbuddy(), relay()] });
  assert.deepEqual([...mixed], [['workbuddy', 'workbuddy'], ['relay', 'dsh-delegate:relay']]);
  assert.deepEqual(llm.listProviders().map((entry) => entry.id), ['dsh-delegate:relay']);
  registry.dispose();
});

test('a mixed native+custom configuration leases and registers the same custom subset', async () => {
  const { registry, adapter, llm, ensureRoutes } = wire();
  const providers = [nativeWorkbuddy(), relay()];
  // The engine's lease, over the canonical custom subset.
  const lease = registry.lease(managedProvidersOf(providers), 'task-2');
  // Registration fingerprints the *same* subset: not `[workbuddy, relay]`, and not
  // something derived from it that the native entry could perturb.
  const routes = await ensureRoutes({ providers });
  assert.deepEqual([...routes], [['workbuddy', 'workbuddy'], ['relay', 'dsh-delegate:relay']]);
  assert.deepEqual(registry.heldLease().fingerprint, lease.fingerprint);
  assert.equal(registry.heldLease().count, 1);

  // The lease genuinely tracks the custom definitions: a custom change is still a
  // different set and is refused, while the native reference cannot make one.
  await assert.rejects(
    () => ensureRoutes({ providers: [nativeWorkbuddy(), relay({ baseUrl: 'http://127.0.0.1:9443/v1' })] }),
    (error) => error.code === PROVIDER_SET_CODES.busy,
  );
  // Re-reading the same document with the native entry renamed or re-ordered is
  // the same custom set, so an ensure of it shares the lease instead of refusing.
  const reread = await registry.ensure(managedProvidersOf([relay(), { ...nativeWorkbuddy(), name: 'Renamed in DSH' }]));
  assert.deepEqual([...reread.routes], [['relay', 'dsh-delegate:relay']]);
  assert.equal(registry.heldLease().count, 1);

  assert.deepEqual(llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:relay', 'Local relay']]);
  assert.deepEqual([...adapter.snapshot().routes], [['relay', 'dsh-delegate:relay']]);
  assert.equal(registry.release(lease), true);
  registry.dispose();
});

test('genuinely concurrent different custom provider sets still refuse with PROVIDER_SET_BUSY', async () => {
  const { registry } = wire();
  // Task A pins custom set A; task B holds a different custom set.
  const a = registry.lease(managedProvidersOf([nativeWorkbuddy(), relay()]), 'task-a');
  assert.throws(
    () => registry.lease(managedProvidersOf([nativeWorkbuddy(), relay({ name: 'Relay (B)' })]), 'task-b'),
    (error) => error.code === PROVIDER_SET_CODES.busy
      && error.details.code === PROVIDER_SET_CODES.busy
      && error.details.heldBy === 1,
    'a different custom set must be refused, native references notwithstanding',
  );
  // And the empty set is a different set too, so a task cannot drop the routes out
  // from under a holder by presenting a native-only configuration.
  assert.throws(
    () => registry.lease(managedProvidersOf([nativeWorkbuddy()]), 'task-c'),
    (error) => error.code === PROVIDER_SET_CODES.busy,
    'a native-only set must not be treated as equal to a custom one',
  );
  // Only a holder of the *same* set is admitted alongside.
  const a2 = registry.lease(managedProvidersOf([relay(), nativeWorkbuddy()]), 'task-a2');
  assert.equal(registry.heldLease().count, 2);
  assert.equal(registry.release(a2), true);
  assert.equal(registry.release(a), true);
  assert.equal(registry.heldLease(), null);
  registry.dispose();
});

test('a native-only configuration passes a real engine preflight without refusing its own lease', async () => {
  // The end-to-end reproduction: the *installed* settings shape through the real
  // engine, the real registry and the real route seam. Before the fix, `start()`
  // failed in `providers` with PROVIDER_SET_BUSY against its own lease.
  const wired = wire();
  const dir = await makeTempDir();
  const settings = new SettingsService(join(dir, 'data'));
  const document = settingsDocument([nativeWorkbuddy()]);
  await settings.replace(document);
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  // The native route is owned by the harness, so DSH has to have registered it:
  // the production seam refuses a native reference whose route DSH no longer has.
  // Registering it through the real `LlmRuntime.registerAdapter()` is what makes
  // `listProviders()` report it — and what makes the plugin's own registration of
  // an otherwise empty custom set the only one that happens here.
  const native = registerNativeAdapter(wired.llm, nativeWorkbuddy());
  // Placement, wired as production wires it, so the task reaches its provider
  // preflight instead of being refused for an unplaceable run.
  const placementWorkspaces = fakeWorkspaceController();
  const placementSessions = fakeSessionController({ workspaces: placementWorkspaces, respond: { text: 'done' } });
  const engine = new JobEngine({
    agents: fakeAgents({ respond: { text: 'done' } }),
    agentPresets: { async mount() { return { id: 'default' }; } },
    reviewPresets: reviewComposer(),
    sessions: { async flush() {} },
    workspaces: placementWorkspaces,
    sessionController: placementSessions,
    llm: wired.llm,
    settings,
    auth,
    locks,
    runGit: engineGit(),
    providerRegistry: wired.registry,
    ensureRoutes: wired.ensureRoutes,
    logger: { info() {}, warn() {} },
  });
  try {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, { kind: 'task', workspacePath: workspace, ttlSeconds: 600 });
    const started = await engine.start({
      connectionId: connection.connectionId,
      grantId: grant.grantId,
      workspacePath: workspace,
      prompt: 'go',
    });
    assert.equal(started.route.providerRoute, 'workbuddy', 'a native reference routes to the DSH route id itself');
    const settled = await settleTask(engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview, `a native-only task must run: ${JSON.stringify(settled.error)}`);
    assert.equal(settled.error, null);
    // The plugin still registered no adapter route, and the lease is back. The one
    // route the runtime reports is the harness-owned native one this fixture
    // registered; the plugin's own registration holds none.
    assert.deepEqual(wired.llm.listProviders().map((entry) => entry.id), [native.route.id]);
    assert.equal(wired.registry.heldLease(), null);
    assert.deepEqual([...wired.adapter.snapshot().routes], []);
  } finally {
    await engine.dispose();
    wired.registry.dispose();
    native.dispose();
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Engine contract: the two-turn regression.
// ---------------------------------------------------------------------------
/** The tool inventory the mount advertises, so the review has something to see. */
const INVENTORY = ['read', 'glob', 'grep'];

/**
 * Let the scenario's own scheduled work run, which is how the gated turns below
 * advance (a turn stays open until this is called).
 * @returns {Promise<void>} resolves after the microtask and timer queues drained.
 */
function advanceTurns() {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
}

test('a running task keeps its provider set: no other configuration can be applied until it drains', async () => {
  const h = await engineWire();
  try {
    const first = h.authorize();
    const started = await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grantId,
      workspacePath: h.workspace,
      prompt: 'start work',
    });
    await waitForAgents(h.agents, 1);

    // At this point the task is on its FIRST turn, with A served and pinned.
    assert.deepEqual(h.llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy']]);
    // The task is live, so it has not recorded an execution yet; what proves it
    // used the pinned route is the lease it holds on that exact provider set.
    assert.equal(h.registry.heldLease()?.holders.includes(started.taskId), true, 'the running task must hold the lease');

    // The operator saves a different endpoint between the task's two turns. The
    // settings write itself is unaffected: it is a different authority.
    await h.settings.upsertProvider(workbuddyOnAnotherEndpoint());

    // Applying it is refused, before publication, with the stable busy code 鈥?the
    // same refusal `/models`, `/catalog` and connectivity receive.
    const outcome = await (async () => {
      try {
        return { routes: await h.ensureRoutes({ providers: [workbuddyOnAnotherEndpoint()] }), error: null };
      } catch (error) {
        return { routes: null, error: { code: error?.code, message: error?.message } };
      }
    })();
    assert.equal(outcome.routes, null);
    assert.equal(outcome.error.code, PROVIDER_SET_CODES.busy);
    // The adapter still serves A, with A's endpoint and A's models.
    assert.deepEqual([...h.adapter.snapshot().routes], [['workbuddy', 'dsh-delegate:workbuddy']]);
    assert.deepEqual(h.llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy']]);
    const info = await h.llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');
    assert.equal(info.id, 'deepseek-v4.1-flash');

    // Let the first turn finish, and wait for the whole task to complete. Its
    // *next* native model operation happens after the new settings were stored;
    // the task must still be on A, and the completion must have given A back.
    h.agents.openTurn(0);
    await h.engine.tasks.get(started.taskId).settled;
    const settled = h.engine.get(started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview, `the task must complete on A: ${JSON.stringify(settled.error)}`);
    assert.equal(settled.route.providerRoute, 'dsh-delegate:workbuddy');
    assert.deepEqual(h.llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy']]);
    assert.equal(h.registry.heldLease(), null, 'a finished task must give the provider set back');

    // After the drain the changed definition applies, to a new task.
    const second = h.authorize();
    const next = await h.engine.start({
      connectionId: second.connectionId,
      grantId: second.grantId,
      workspacePath: h.workspace,
      prompt: 'next job',
    });
    await waitForAgents(h.agents, 2);
    assert.deepEqual(h.llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy (B)']]);
    assert.equal(next.route.providerRoute, 'dsh-delegate:workbuddy');
    h.agents.openTurn(1);
    const nextSettled = await settleTask(h.engine, next.taskId);
    assert.equal(nextSettled.state, TASK_STATES.awaitingHostReview);
  } finally {
    await h.close();
  }
});

test('a second job on the same configuration is admitted while the first runs', async () => {
  const h = await engineWire();
  try {
    // Two slots, one configuration: sharing the lease is what makes this legal.
    await h.settings.setWorker({
      providerId: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'high',
      timeoutSeconds: 600,
      maxParallelism: 2,
      isolation: 'shared',
    });
    const first = h.authorize();
    const one = await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    // Admission finished: the first task holds the provider set and the workspace.
    await waitForAdmitted(h.engine, one.taskId);
    assert.equal(h.registry.heldLease().count, 1);

    // A second workspace, because the workspace lease is the one thing that must
    // still refuse two jobs at once; the provider set is what must be shared.
    const other = await realpath(await mkdir(join(h.dir, 'second'), { recursive: true }).then(() => join(h.dir, 'second')));
    const secondConnection = h.auth.issueConnection({ label: 'codex' });
    const secondGrant = h.auth.issueGrant(secondConnection.connectionId, { kind: 'task', workspacePath: other, ttlSeconds: 600 });
    const two = await h.engine.start({
      connectionId: secondConnection.connectionId,
      grantId: secondGrant.grantId,
      workspacePath: other,
      prompt: 'second',
    });
    await waitForAdmitted(h.engine, two.taskId);
    assert.equal(h.registry.heldLease().count, 2, 'both tasks hold one shared lease');
    assert.equal(h.registry.heldLease().holders.includes(one.taskId), true);
    assert.equal(h.registry.heldLease().holders.includes(two.taskId), true);

    // The second start was *not* refused for the shared configuration.
    assert.equal(two.state, TASK_STATES.running);
  } finally {
    await h.close();
  }
});

test('a task refused for a different pinned configuration releases everything and keeps no hold', async () => {
  const h = await engineWire();
  try {
    const first = h.authorize();
    const running = await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await waitForAdmitted(h.engine, running.taskId);
    assert.equal(h.registry.heldLease()?.holders.includes(running.taskId), true);

    // The stored document now describes B, and the first task still pins A.
    await h.settings.upsertProvider(workbuddyOnAnotherEndpoint());
    await h.settings.setWorker({
      providerId: 'workbuddy',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'high',
      timeoutSeconds: 600,
      maxParallelism: 2,
      isolation: 'shared',
    });

    // A second workspace, so the refusal can only come from the provider set.
    const other = await realpath(await mkdir(join(h.dir, 'second'), { recursive: true }).then(() => join(h.dir, 'second')));
    const secondConnection = h.auth.issueConnection({ label: 'codex' });
    const secondGrant = h.auth.issueGrant(secondConnection.connectionId, { kind: 'task', workspacePath: other, ttlSeconds: 600 });
    await assert.rejects(
      () => h.engine.start({
        connectionId: secondConnection.connectionId,
        grantId: secondGrant.grantId,
        workspacePath: other,
        prompt: 'second',
      }),
      (error) => error.code === PROVIDER_SET_CODES.busy,
      'a different set must be refused with the stable busy code',
    );

    const refused = [...h.engine.tasks.values()].at(-1);
    assert.equal(refused.state, TASK_STATES.failed, 'the refused start is recorded as failed');
    assert.equal(refused.error.code, PROVIDER_SET_CODES.busy);
    assert.equal(refused.slotHeld, false, 'a failed admission must not keep its slot');
    assert.equal(refused.providerLeaseReleased, true, 'a failed admission must not leak a pin');
    assert.equal(h.registry.heldLease().count, 1, 'only the running task keeps the lease');
    assert.equal(h.registry.heldLease().holders.includes(refused.taskId), false);
    assert.equal(h.engine.locks.isLocked(h.workspace), true, 'the running task still owns the workspace');
    assert.equal(h.engine.locks.isLocked(other), false, 'the refused task released its workspace');
  } finally {
    await h.close();
  }
});

test('cancel and dispose return the provider set', async () => {
  const h = await engineWire();
  try {
    const first = h.authorize();
    const started = await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await waitForAdmitted(h.engine, started.taskId);
    assert.equal(h.registry.heldLease().count, 1);

    // `cancel()` resolves only after finalize has run, so the set is already free.
    const cancelled = await h.engine.cancel(started.taskId, 'operator');
    assert.equal(cancelled.state, TASK_STATES.cancelled);
    assert.equal(h.registry.heldLease(), null, 'cancellation must release the pinned set');
    assert.equal(h.engine.tasks.get(started.taskId).providerLeaseReleased, true);

    // A second task holds it again, and dispose gives it back on the way out.
    const second = h.authorize();
    const next = await h.engine.start({
      connectionId: second.connectionId,
      grantId: second.grantId,
      workspacePath: h.workspace,
      prompt: 'second',
    });
    await waitForAdmitted(h.engine, next.taskId);
    assert.equal(h.registry.heldLease().count, 1);
    await h.engine.dispose();
    assert.equal(h.registry.heldLease(), null, 'dispose must release the pinned set');
  } finally {
    await h.close();
  }
});

test('a timed-out preflight returns the provider set and does not block the next configuration', async () => {
  const wired = wire();
  const dir = await makeTempDir();
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  let calls = 0;
  // The first ensure hangs past the preflight deadline; the second answers at once.
  const ensureRoutes = async (snapshot) => {
    calls += 1;
    if (calls === 1) await gate;
    return await wired.ensureRoutes(snapshot);
  };
  const settings = new SettingsService(join(dir, 'data'));
  // The preflight deadline is `min(remaining worker budget, preflightTimeoutMs
  // until the budget is known)`: `admit()` arms `preflightTimeoutMs` first and
  // then re-arms from the task's own deadline once the effective configuration is
  // resolved. A worker budget of the default 600s therefore replaces this bound
  // with ten minutes, and the hung ensure below would never time out. The budget
  // is what a task is entitled to, so the test uses the shortest budget the
  // settings schema allows (30s) and brings the preflight bound forward instead:
  // `preflightTimeoutMs` is a construction dependency, not a stored setting.
  const document = settingsDocument([workbuddy()]);
  await settings.replace({ ...document, worker: { ...document.worker, timeoutSeconds: 30 } });
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const engine = new JobEngine({
    agents: fakeAgents({ respond: { text: 'done' } }),
    agentPresets: { async mount() { return { id: 'default' }; } },
    reviewPresets: reviewComposer(),
    sessions: { async flush() {} },
    llm: wired.llm,
    settings,
    auth,
    locks,
    runGit: engineGit(),
    providerRegistry: wired.registry,
    ensureRoutes,
    preflightTimeoutMs: 50,
    logger: { info() {}, warn() {} },
  });
  try {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, { kind: 'task', workspacePath: workspace, ttlSeconds: 600 });
    await assert.rejects(
      () => engine.start({ connectionId: connection.connectionId, grantId: grant.grantId, workspacePath: workspace, prompt: 'go' }),
      (error) => error.code === JOB_CODES.timeout,
    );
    assert.equal(wired.registry.heldLease(), null, 'a timed-out start must return the pinned set');
    // A different configuration is admissible immediately.
    const changed = await wired.registry.lease([workbuddyOnAnotherEndpoint()], 'probe');
    assert.equal(wired.registry.release(changed), true);
    release();
  } finally {
    await engine.dispose();
    wired.registry.dispose();
    await cleanup(dir);
  }
});

test('a task whose native executor never confirms it stopped keeps the set until it does', async () => {
  const h = await engineWire();
  try {
    const started = h.authorize();
    const created = await h.engine.start({
      connectionId: started.connectionId,
      grantId: started.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    await waitForAgents(h.agents, 1);

    // Drive finalize directly against a task whose executor has not settled: the
    // provider set must be held exactly as long as the workspace is.
    const task = h.engine.tasks.get(created.taskId);
    task.native = { started: true, settled: false, promise: new Promise(() => {}) };
    h.engine.finalizing = null;
    const released = await h.engine.finalize(task);
    assert.equal(released, false);
    assert.equal(task.cleanupError.code, JOB_CODES.nativeNotStopped);
    assert.equal(h.registry.heldLease().count, 1, 'a declined release must not free the set');
    assert.equal(task.providerLeaseReleased, false);

    task.native.settled = true;
    assert.equal(await h.engine.finalize(task), true);
    assert.equal(h.registry.heldLease(), null, 'the retried release frees the set');
  } finally {
    await h.close();
  }
});

test('a registry without a lease seam is used exactly as before, and a failing lease is not a refusal', async () => {
  // These two halves are about the *lease seam only*, so they drive the
  // auto-answering fake instead of the gated registry: nothing here observes a
  // turn boundary, and a gated agent whose turn is never opened would leave the
  // run `running` until the native-settle bound expired rather than testing the
  // seam. One prompt, one answered turn, no manual `openTurn`.
  const respondOnce = { respond: { text: 'done' } };
  // A controller (and the Workspace registry it resolves against) that answers
  // every turn, for the halves of this test that are about the lease seam only.
  const autoAnswer = () => {
    const workspaces = fakeWorkspaceController();
    return { workspaces, sessionController: fakeSessionController({ workspaces, respond: respondOnce.respond }) };
  };
  const answerOne = autoAnswer();
  // An injected registry that predates this contract: no `lease`, no `release`.
  // It still has to make its routes real — the engine resolves the worker route
  // through the native runtime after `ensure()` returns, so a mapping that names a
  // route nobody registered is a routing refusal, not a lease question. The wire
  // it is given registers exactly the routes this fake reports.
  const legacyWire = wire();
  const legacy = {
    calls: [],
    async ensure(providers) {
      legacy.calls.push(providers.map((provider) => provider.id));
      return { routes: await legacyWire.ensureRoutes({ providers }) };
    },
  };
  const h1 = await engineWire({
    providerRegistry: legacy,
    agents: fakeAgents(respondOnce),
    useRouteSeam: false,
    llm: legacyWire.llm,
    // Nothing here observes a turn boundary, so the auto-answering controller is
    // used instead of a gated one; a gated agent whose turn is never opened would
    // leave the run `running` until the native-settle bound expired.
    workspaces: answerOne.workspaces,
    sessionController: answerOne.sessionController,
  });
  try {
    const { connectionId, grantId } = h1.authorize();
    const started = await h1.engine.start({
      connectionId,
      grantId,
      workspacePath: h1.workspace,
      prompt: 'go',
    });
    const settled = await settleTask(h1.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview, `a registry without leases must still run: ${JSON.stringify(settled.error)}`);
    assert.deepEqual(legacy.calls, [['workbuddy']]);
  } finally {
    await h1.close();
  }

  // A registry whose `lease` throws an unrelated error: treated as "no hold", so
  // the job proceeds on the registry's own terms instead of failing admission.
  const brokenWire = wire();
  const answerTwo = autoAnswer();
  const broken = {
    async ensure(providers) {
      return { routes: await brokenWire.ensureRoutes({ providers }) };
    },
    lease() { throw Object.assign(new Error('lease is not wired up'), { code: 'LEASE_UNSUPPORTED' }); },
    release() { throw new Error('must not be called for a lease that was never taken'); },
  };
  const h2 = await engineWire({
    providerRegistry: broken,
    agents: fakeAgents(respondOnce),
    useRouteSeam: false,
    llm: brokenWire.llm,
    workspaces: answerTwo.workspaces,
    sessionController: answerTwo.sessionController,
  });
  try {
    const { connectionId, grantId } = h2.authorize();
    const started = await h2.engine.start({ connectionId, grantId, workspacePath: h2.workspace, prompt: 'go' });
    const settled = await settleTask(h2.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview, `an unsupported lease seam must not refuse work: ${JSON.stringify(settled.error)}`);
    assert.equal(h2.engine.tasks.get(started.taskId).providerLease, null);
    assert.equal(h2.engine.tasks.get(started.taskId).providerLeaseReleased, true);
  } finally {
    await h2.close();
  }
});

test('a busy refusal is carried through the engine as a job refusal, not as a routing failure', async () => {
  // A minimal registry that pins A and answers `ensure` for A only: the engine must
  // surface the registry's own code rather than folding it into JOB_ROUTING_REFUSED.
  const held = { fingerprint: 'pinned', count: 1, holders: ['other-task'] };
  const registry = {
    heldLease: () => held,
    lease(providers) {
      const fingerprint = JSON.stringify(providers.map((provider) => provider.baseUrl));
      if (fingerprint !== JSON.stringify(['http://127.0.0.1:9443/v1'])) {
        const error = new Error('another task is running on a different provider configuration');
        error.code = PROVIDER_SET_CODES.busy;
        error.details = { holders: ['other-task'] };
        throw error;
      }
      return { kind: 'lease' };
    },
    release() { return true; },
    async ensure(providers) {
      return { routes: new Map(providers.map((provider) => [provider.id, `${provider.id}-native`])) };
    },
  };
  const h = await engineWire({ providerRegistry: registry });
  try {
    const { connectionId, grantId } = h.authorize();
    await assert.rejects(
      () => h.engine.start({ connectionId, grantId, workspacePath: h.workspace, prompt: 'go' }),
      (error) => error.code === PROVIDER_SET_CODES.busy && error.details.phase === 'providers',
    );
    // Nothing native happened: the refusal landed before the ensure ran.
    assert.deepEqual([...h.adapter.snapshot().routes], []);
    assert.deepEqual(h.llm.listProviders(), []);
    assert.equal(h.deps.agents.created.length, 0, 'no agent may be created for a refused job');
    assert.equal(h.deps.sessionController.creates.length, 0, 'nor a conversation');
  } finally {
    await h.close();
  }
});
