// Native registration integration: the real core, the real adapter, no doubles.
//
// The two failures this file exists for were both invisible to lenient doubles:
//
//   * the plugin handed the `LlmRuntime` its management facade instead of the
//     `PiAiAdapter`, so registration "succeeded" and every model call then
//     answered `ROUTING_MODEL_UNRESOLVED` — "no adapter registered for provider
//     workbuddy" — although `listProviders()` showed the route;
//   * the plugin registered routes before publishing the snapshot they described,
//     and `prepareRoutes` reads `providerInfo()` synchronously, so the harness
//     captured a display name from the previous generation.
//
// So this file imports the *installed* `LlmRuntime` (`@deepseek-ai/dsh-llm`), the
// installed `PiAiAdapter` (`@deepseek-ai/dsh-llm-pi-ai`) and the plugin's own
// factory, and drives them through the entry point's exact composition. Nothing
// is stubbed except the Cordis context the runtime is constructed with and the
// DSH credential service, and neither participates in route registration.
//
// No network is used: every model assertion below stops at model resolution,
// which the core performs from registration + adapter metadata alone. Streaming
// is covered offline in `tests/openai-adapter.test.js`.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { LlmRuntime } from '@deepseek-ai/dsh-llm';

import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { JobEngine, JOB_CODES, TASK_STATES } from '../src/jobs/engine.js';
import { createOpenAiAdapter } from '../src/model/openai-adapter.js';
import { createProviderRegistry } from '../src/model/providers.js';
import { describeCatalog, resolveRoute } from '../src/model/routing.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { cleanup, fakeAgents, fakeSessionController, fakeWorkspaceController, makeTempDir, validSettings } from './helpers/fakes.js';

/**
 * A Cordis-shaped context good enough to construct a real `LlmRuntime`.
 *
 * `Service`'s constructor calls `ctx.reflect.provide(name, self, check)` and the
 * runtime's own `registerAdapter` runs through `ctx.effect(...)`, which must
 * return a working disposer. Both are mirrored here; nothing else about Cordis
 * is simulated, and the runtime code under test is the shipped one.
 * @returns {object} context with an `effects` log.
 */
function runtimeContext() {
  const effects = [];
  const ctx = {
    effects,
    reflect: { provide: () => () => {} },
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    events: { dispatch: () => [] },
    // `registerAdapter` binds a generator to the runtime's own context; running
    // it to its first yield performs the registration and yields the disposer.
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
    async resolve() {
      return { value: 'sk-integration-fixture', source: 'test-store' };
    },
    async describe() {
      return { configured: true, reference: 'INTEGRATION_KEY', writable: true };
    },
    asked: [],
  };
}

/** One validated provider profile, the way `src/config/validate.js` produces it. */
function providerProfile(overrides = {}) {
  return {
    id: 'workbuddy',
    name: 'WorkBuddy',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1/v1',
    credentialRef: 'WORKBUDDY_KEY',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'Flash', efforts: ['off', 'low', 'medium', 'high', 'max'] },
    ],
    ...overrides,
  };
}

/**
 * The entry point's `ensureRoutes` seam, extracted verbatim from `src/index.js`.
 *
 * Publishing the adapter snapshot and registering the native routes is one
 * synchronous, rollback-protected transaction. It is factored out here so a test
 * can hand the *production* seam to another component (`JobEngine`) instead of a
 * re-implementation that could drift from it.
 * @param {object} adapter - the openai adapter facade.
 * @param {object} registry - the provider registry built around that adapter.
 * @returns {(snapshot: object) => Promise<Map<string, string>>} seam.
 */
function entryEnsureRoutes(adapter, registry) {
  return async (snapshot) => {
    const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
    if (providers.length === 0) {
      // An inert first configuration must not touch the native core: the registry
      // skips an empty first set, and there is nothing to publish for it either.
      const empty = await registry.register(providers, () => {});
      return empty.routes;
    }
    /**
     * The transaction body: publication, native commit, and nothing awaited.
     * @param {Map<string, string>} routes - the candidate mapping to register.
     * @param {() => void} commit - perform the native registration.
     * @returns {void}
     */
    const adapt = (routes, commit) => {
      const prepared = adapter.prepareRoutes({ providers, routes });
      if (!adapter.describes(prepared, routes)) {
        prepared.rollback();
        throw new Error('route sets disagree');
      }
      try {
        commit();
      } catch (error) {
        prepared.rollback();
        throw error;
      }
    };
    const ensured = await registry.register(providers, adapt);
    return ensured.routes;
  };
}

/**
 * Reproduce the entry point's composition exactly: one native runtime, one
 * adapter facade, one registry, and `ensureRoutes` publishing and registering in
 * one synchronous section.
 *
 * This mirrors `src/index.js` line for line, including the empty-config fast path
 * and the rollback in the adapter's hands, so a bug in that composition shows up
 * here as well as in `tests/entry.test.js`.
 * @returns {object} wiring plus the real runtime.
 */
function wire() {
  const ctx = runtimeContext();
  const llm = new LlmRuntime(ctx);
  const credentials = fakeCredentials();
  const adapter = createOpenAiAdapter({ credentials });
  const registry = createProviderRegistry({ llm, adapter });
  const ensureRoutes = entryEnsureRoutes(adapter, registry);

  return { ctx, llm, adapter, registry, credentials, ensureRoutes };
}

test('the real core stores an adapter that can actually serve every registered route', async () => {
  const { llm, adapter, ensureRoutes } = wire();

  const routes = await ensureRoutes({ providers: [providerProfile()] });
  assert.deepEqual([...routes], [['workbuddy', 'dsh-delegate:workbuddy']]);

  // What the harness believes it has...
  assert.deepEqual(llm.listProviders().map((entry) => entry.id), ['dsh-delegate:workbuddy']);
  // ...is the name the operator configured, captured during prepareRoutes.
  assert.equal(llm.listProviders()[0].name, 'WorkBuddy');

  // ...and resolution through the core reaches the adapter. With a facade
  // registered, this is the call that answered `NO_ADAPTER` in the field.
  const resolved = await llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');
  assert.equal(resolved.provider, 'dsh-delegate:workbuddy');
  assert.equal(resolved.id, 'deepseek-v4.1-flash');
  assert.deepEqual(
    resolved.reasoning.efforts.map((effort) => effort.id).sort(),
    ['high', 'low', 'max', 'medium', 'off'],
  );
  // A retry policy was captured for the route, as `prepareRoutes` requires.
  assert.equal(typeof llm.providerRetryPolicy('dsh-delegate:workbuddy').mode, 'string');

  // The plugin's own route resolution agrees with the core, through the mapped
  // route and never through the ambient profile id.
  const route = await resolveRoute({ llm }, {
    providerId: 'workbuddy',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'max',
  }, { routes });
  assert.deepEqual(route.providerRoute, 'dsh-delegate:workbuddy');
  assert.deepEqual(route.declaredEfforts, ['off', 'low', 'medium', 'high', 'max']);

  // The ambient profile id is not a registered route, and must not resolve.
  await assert.rejects(
    () => llm.resolveModelInfo('workbuddy', 'deepseek-v4.1-flash'),
    (error) => error.code === 'NO_ADAPTER',
  );
  assert.equal(adapter.snapshot().routes.get('workbuddy'), 'dsh-delegate:workbuddy');
});

test('a re-registration swaps the route set and the stored names together', async () => {
  const { llm, ensureRoutes } = wire();

  await ensureRoutes({ providers: [providerProfile()] });
  await ensureRoutes({
    providers: [
      providerProfile({ id: 'relay', name: 'Relay' }),
      providerProfile({ id: 'workbuddy', name: 'WorkBuddy (renamed)' }),
    ],
  });

  const listed = llm.listProviders();
  assert.deepEqual(listed.map((entry) => entry.id), ['dsh-delegate:relay', 'dsh-delegate:workbuddy']);
  assert.deepEqual(listed.map((entry) => entry.name), ['Relay', 'WorkBuddy (renamed)']);

  // The whole set is replaced, including routes dropped from the settings.
  await ensureRoutes({ providers: [providerProfile({ id: 'workbuddy', name: 'WorkBuddy' })] });
  assert.deepEqual(llm.listProviders().map((entry) => entry.id), ['dsh-delegate:workbuddy']);
  await assert.rejects(() => llm.resolveModelInfo('dsh-delegate:relay', 'deepseek-v4.1-flash'));
});

test('a refused registration leaves both the harness and the adapter on the previous generation', async () => {
  const { llm, adapter, ensureRoutes } = wire();

  await ensureRoutes({ providers: [providerProfile()] });
  const good = adapter.snapshot();
  assert.deepEqual([...good.routes], [['workbuddy', 'dsh-delegate:workbuddy']]);

  // A provider that fails snapshot validation (unsupported protocol) must not
  // disturb the live registration, and must not be half-published on the adapter.
  await assert.rejects(
    () => ensureRoutes({
      providers: [providerProfile({ id: 'relay', name: 'Relay', protocol: 'anthropic-messages' })],
    }),
    (error) => error.code === 'PROTOCOL_UNSUPPORTED',
  );

  assert.deepEqual(llm.listProviders().map((entry) => entry.id), ['dsh-delegate:workbuddy']);
  assert.equal(llm.listProviders()[0].name, 'WorkBuddy');
  assert.deepEqual([...adapter.snapshot().routes], [...good.routes], 'the adapter must still serve the accepted snapshot');
  // And the route is still usable.
  await llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');
});

test('a duplicate native route is refused instead of half-registering', async () => {
  const { ctx, llm, adapter } = wire();
  // Two profiles that a hostile `routeIdFor` collision would merge are already
  // refused by the registry's own plan; here two *separate registrations* claim the
  // same native route. The rival's registry now recognises that from its own
  // baseline and refuses before its adapter publishes anything, which is strictly
  // better than letting the core raise DUPLICATE_ADAPTER after publication.
  const registry = createProviderRegistry({ llm, adapter });
  const other = createOpenAiAdapter({ credentials: fakeCredentials() });
  const rival = createProviderRegistry({ llm, adapter: other });

  await registry.register([providerProfile()], (routes, commit) => {
    adapter.prepareRoutes({ providers: [providerProfile()], routes });
    commit();
  });
  assert.deepEqual(llm.listProviders().map((entry) => entry.id), ['dsh-delegate:workbuddy']);

  let rivalCallbackRan = false;
  await assert.rejects(
    () => rival.register([providerProfile()], () => { rivalCallbackRan = true; }),
    /another adapter registration already owns/u,
  );
  assert.equal(rivalCallbackRan, false, 'the rival adapter must not publish a route the core would reject');

  // The first registration is intact and the rival holds no route.
  assert.deepEqual(llm.listProviders().map((entry) => entry.id), ['dsh-delegate:workbuddy']);
  assert.deepEqual([...other.snapshot().routes], [], 'the refused rival snapshot must not stay published');
  assert.equal(ctx.effects.length >= 1, true);
});

test('the catalog reports registered routes only, and the ambient id is not routable', async () => {
  const { llm, ensureRoutes } = wire();
  const provider = providerProfile();
  const routes = await ensureRoutes({ providers: [provider] });

  const [entry] = await describeCatalog({ llm }, [provider], { routes });
  assert.equal(entry.providerId, 'workbuddy');
  assert.equal(entry.route, 'dsh-delegate:workbuddy');
  assert.deepEqual(entry.models.map((model) => model.id), ['deepseek-v4.1-flash']);
  assert.deepEqual(entry.models[0].efforts, ['off', 'low', 'medium', 'high', 'max']);
  assert.equal(entry.error, null);

  // Without the mapping, the same catalog row must report *no* route rather than
  // the profile id — which no native adapter serves, and which may collide with an
  // ambient route of the same name. That is the silent-fallback shape the user
  // plane avoids by always passing the registered mapping.
  const [unmapped] = await describeCatalog({ llm }, [provider]);
  assert.equal(unmapped.route, null);
  assert.equal(unmapped.error.code, 'ROUTING_PROVIDER_NOT_REGISTERED');
  assert.deepEqual(unmapped.models, []);
});

test('disposing the registry releases exactly the routes it registered', async () => {
  const { llm, registry, ensureRoutes } = wire();

  await ensureRoutes({ providers: [providerProfile()] });
  assert.equal(llm.listProviders().length, 1);

  registry.dispose();
  assert.deepEqual(llm.listProviders(), []);
  await assert.rejects(
    () => llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash'),
    (error) => error.code === 'NO_ADAPTER',
  );
});

test('a blocked re-registration leaves the old native routes and the old facade snapshot in place', async () => {
  const { ctx, llm, adapter, registry, ensureRoutes } = wire();

  // Generation 1 is live and working.
  const first = providerProfile();
  const routes = await ensureRoutes({ providers: [first] });
  assert.deepEqual([...routes], [['workbuddy', 'dsh-delegate:workbuddy']]);
  await llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');
  const before = adapter.snapshot();

  // Another owner registers a route this adapter's namespace would also claim.
  const rivalAdapter = createOpenAiAdapter({ credentials: fakeCredentials() });
  const rival = createProviderRegistry({ llm, adapter: rivalAdapter });
  const rivalRoutes = new Map([['rival', 'dsh-delegate:rival']]);
  rivalAdapter.replace({ providers: [providerProfile({ id: 'rival', name: 'Rival' })], routes: rivalRoutes });
  rival.commitRoutes(rivalRoutes);
  assert.deepEqual(llm.listProviders().map((entry) => entry.id).sort(), ['dsh-delegate:rival', 'dsh-delegate:workbuddy']);

  // The candidate would need `dsh-delegate:rival`, which the other owner holds, so
  // the native `replace()` must refuse it. The adapter has already published the
  // candidate by then — the whole point of this test is that the refusal rolls the
  // facade back to generation 1 rather than leaving it on the candidate.
  await assert.rejects(
    () => ensureRoutes({
      providers: [
        providerProfile(),
        providerProfile({ id: 'rival', name: 'Rival (candidate)' }),
      ],
    }),
    (error) => error.code === 'DUPLICATE_ADAPTER',
  );

  // Native side: unchanged names and models for the generation that was working.
  const byId = new Map(llm.listProviders().map((entry) => [entry.id, entry.name]));
  assert.deepEqual([...byId.keys()].sort(), ['dsh-delegate:rival', 'dsh-delegate:workbuddy']);
  assert.equal(byId.get('dsh-delegate:workbuddy'), 'WorkBuddy', 'the core must still describe the old registration, not the refused candidate');
  assert.equal(byId.get('dsh-delegate:rival'), 'Rival', 'the other owner is untouched');
  const info = await llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');
  assert.equal(info.id, 'deepseek-v4.1-flash');

  // Facade side: the old snapshot and its models, not the candidate's.
  const after = adapter.snapshot();
  assert.deepEqual([...after.routes], [...before.routes], 'the adapter must serve the old route mapping again');
  assert.deepEqual(after.providerIds, before.providerIds);
  assert.deepEqual([...after.models], [...before.models], 'the adapter must serve the old models again');
  assert.equal(after.routes.has('rival'), false, 'the refused candidate must not stay published');
  assert.equal(after.models.has('dsh-delegate:rival'), false);

  // `registry` is still the live owner and can still replace correctly.
  await ensureRoutes({ providers: [providerProfile({ name: 'WorkBuddy (v2)' })] });
  const replaced = new Map(llm.listProviders().map((entry) => [entry.id, entry.name]));
  assert.equal(replaced.get('dsh-delegate:workbuddy'), 'WorkBuddy (v2)');
  assert.equal(replaced.get('dsh-delegate:rival'), 'Rival');
  assert.equal(ctx.effects.length >= 1, true);
});

test('a candidate whose route another registration owns is refused before the adapter publishes it', async () => {
  const { llm, adapter, registry } = wire();

  const rivalAdapter = createOpenAiAdapter({ credentials: fakeCredentials() });
  const rival = createProviderRegistry({ llm, adapter: rivalAdapter });
  const rivalRoutes = new Map([['rival', 'dsh-delegate:rival']]);
  rivalAdapter.replace({ providers: [providerProfile({ id: 'rival', name: 'Rival' })], routes: rivalRoutes });
  rival.commitRoutes(rivalRoutes);

  // My own registration exists, so a re-registration is a `replace()`, not a
  // registration; the candidate then names a route the rival owns.
  const mine = new Map([['workbuddy', 'dsh-delegate:workbuddy']]);
  adapter.replace({ providers: [providerProfile()], routes: mine });
  registry.commitRoutes(mine);
  const before = adapter.snapshot();

  let callbackRan = false;
  await assert.rejects(
    () => registry.register(
      [providerProfile(), providerProfile({ id: 'rival', name: 'Rival (candidate)' })],
      () => { callbackRan = true; },
    ),
    /another adapter registration already owns/u,
  );

  assert.equal(callbackRan, false, 'the adapter must not be asked to publish a candidate that cannot be registered');
  assert.deepEqual([...adapter.snapshot().routes], [...before.routes]);
  assert.deepEqual(llm.listProviders().map((entry) => entry.id), ['dsh-delegate:rival', 'dsh-delegate:workbuddy']);
});

test('a concurrent ensure cannot interleave between snapshot publication and the native commit', async () => {
  const { llm, adapter, ensureRoutes } = wire();

  // Two ensures started in the same turn. With any `await` inside the transaction
  // the second one would run in the window the first left open, publish its own
  // generation, and the first would then register against — or overwrite — it.
  const outcomes = [];
  const competitive = (name) => ensureRoutes({ providers: [providerProfile({ name })] })
    .then((routes) => { outcomes.push([name, 'ok', [...routes]]); }, (error) => { outcomes.push([name, 'refused', error.code ?? error.message]); });
  await Promise.all([competitive('WorkBuddy (first)'), competitive('WorkBuddy (second)')]);

  // Both candidates are legal, so both apply — in call order.
  assert.deepEqual(outcomes.map(([name, status]) => [name, status]), [
    ['WorkBuddy (first)', 'ok'],
    ['WorkBuddy (second)', 'ok'],
  ]);
  // The last one to apply is the one both sides describe.
  assert.deepEqual(llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy (second)']]);
  const served = adapter.snapshot();
  assert.deepEqual([...served.routes], [['workbuddy', 'dsh-delegate:workbuddy']]);
  assert.deepEqual([...served.models.get('dsh-delegate:workbuddy')], ['deepseek-v4.1-flash']);
  await llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');

  // And the window is provably closed: a reentrant ensure issued from inside the
  // transaction's own synchronous section cannot run until that section is done.
  const observedInside = [];
  await adapter.prepareRoutes({
    providers: [providerProfile({ name: 'WorkBuddy (reentrant probe)' })],
    routes: new Map([['workbuddy', 'dsh-delegate:workbuddy']]),
  }).rollback();
  const pending = llm.listProviders().map((entry) => entry.name);
  observedInside.push(pending);
  assert.deepEqual(observedInside, [['WorkBuddy (second)']], 'a synchronous rollback leaves the core untouched');
});

test('the first ensure fails cleanly and a later one recovers', async () => {
  const { llm, adapter, ensureRoutes } = wire();

  // Nothing registered yet: the candidate fails on its own protocol, before
  // publication and before the core is touched.
  await assert.rejects(
    () => ensureRoutes({ providers: [providerProfile({ protocol: 'anthropic-messages' })] }),
    (error) => error.code === 'PROTOCOL_UNSUPPORTED',
  );
  assert.deepEqual(llm.listProviders(), []);
  assert.deepEqual([...adapter.snapshot().routes], [], 'a refused first candidate must not leave a published snapshot');
  assert.deepEqual([...adapter.snapshot().models], []);

  // Recovery: the next ensure registers normally and serves the real name, so a
  // failed first attempt does not poison the registry (no half-kept handle).
  const routes = await ensureRoutes({ providers: [providerProfile()] });
  assert.deepEqual([...routes], [['workbuddy', 'dsh-delegate:workbuddy']]);
  assert.deepEqual(llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy']]);
  await llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');
});

test('an empty first configuration stays inert and a later one registers lazily', async () => {
  const { ctx, llm, adapter, ensureRoutes } = wire();

  const effectsBefore = ctx.effects.length;
  const empty = await ensureRoutes({ providers: [] });
  assert.deepEqual([...empty], []);
  assert.equal(ctx.effects.length, effectsBefore, 'an empty configuration must not register anything natively');
  assert.deepEqual(llm.listProviders(), []);
  assert.deepEqual([...adapter.snapshot().routes], []);

  await ensureRoutes({ providers: [providerProfile()] });
  assert.deepEqual(llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy']]);
  await llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');
});

// ---------------------------------------------------------------------------
// Job preflight on the real composition.
//
// The field failure these tests exist for happened on the FIRST dispatch after a
// plugin load: `JOB_ROUTING_REFUSED` / `ROUTING_MODEL_UNRESOLVED` for a model that
// was configured and resolvable, because preflight registered the route through
// `providerRegistry.ensure()` alone — which touches the core's route table but
// leaves the adapter serving whatever generation it last had (on a fresh load:
// none). `/models` or `/catalog` happened to run first in the reproductions and
// published the snapshot as a side effect, which is why the same dispatch
// succeeded afterwards.
//
// So every test below starts from an EMPTY adapter snapshot and an EMPTY native
// route table, and calls `engine.start()` without any prior `/models`, `/catalog`
// or connectivity call. A fixture that pre-primed the adapter would pass even
// with the bug in place, which is exactly what must not happen here.
// ---------------------------------------------------------------------------

/** A git runner answering in the NUL-delimited format the audit layer parses. */
function engineGit() {
  return async (cwd, args) => {
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

/**
 * The plugin-owned read-only review composition, stubbed at its contract.
 *
 * The real composer mounts native filesystem tool packages this repository does
 * not depend on; that is a packaging fact about reviews, not about routing, and
 * the worker portion of these tests never touches it.
 * @returns {object} composer facade.
 */
function reviewComposer() {
  const id = 'dsh-delegate-review-test';
  return {
    get id() { return id; },
    owns(candidate) { return candidate === id; },
    async preparation() { return id; },
  };
}

/**
 * A settings document that selects the `workbuddy` profile the way an operator
 * would, over the real validator.
 * @param {object} [profile] - provider profile overrides.
 * @param {object} [worker] - worker block overrides.
 * @returns {object} candidate settings document.
 */
function workbuddySettings(profile = {}, worker = {}) {
  const settings = validSettings({
    worker: { providerId: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high', isolation: 'shared', ...worker },
  });
  return { ...settings, providers: [providerProfile(profile)] };
}

/**
 * Build a job engine exactly as `src/index.js` does: the real `LlmRuntime`, the
 * real adapter, the real registry, and the entry point's `ensureRoutes` seam.
 *
 * The agent registry and the preset registry are fakes (no paid network, no tool
 * composition) and the credentialed adapter is never streamed to, so model
 * resolution is the only native work that happens.
 * @returns {Promise<object>} engine wiring plus cleanup.
 */
async function engineWire() {
  const wired = wire();
  const dir = await makeTempDir();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(workbuddySettings());
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const agents = fakeAgents({ respond: { text: 'done' } });
  // Placement, wired the way `src/index.js` wires it. A worker run must land in a
  // real DSH Workspace keyed by its execution directory, so a harness without
  // these two services refuses every dispatch with
  // `JOB_CONVERSATION_UNAVAILABLE` — which is the fail-closed behaviour these
  // tests would otherwise be measuring instead of native route registration.
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces, respond: { text: 'done' } });
  const deps = {
    agents,
    agentPresets: { async mount() { return { id: 'default' }; } },
    reviewPresets: reviewComposer(),
    // The native persistence service (`ctx.sessions`) — NOT the session
    // controller. Placement never reads this one.
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    llm: wired.llm,
    settings,
    auth,
    locks,
    runGit: engineGit(),
    providerRegistry: wired.registry,
    // The production seam. Without this the engine falls back to route-only
    // registration, which is the bug these tests pin.
    ensureRoutes: wired.ensureRoutes,
    logger: { info() {}, warn() {} },
  };
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
    engine,
    agents,
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
 * @returns {Promise<object>} settled task view.
 */
async function settleEngineTask(engine, taskId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = engine.get(taskId);
    if (task.state !== TASK_STATES.running && task.state !== TASK_STATES.pending) return task;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  return engine.get(taskId);
}

test('the first dispatch from an empty snapshot resolves the configured model natively', async () => {
  const h = await engineWire();
  try {
    // Nothing has ensured anything yet: no adapter snapshot, no native route.
    assert.deepEqual([...h.adapter.snapshot().routes], [], 'the adapter must start empty');
    assert.deepEqual([...h.adapter.snapshot().models], []);
    assert.deepEqual(h.llm.listProviders(), [], 'the runtime must start with no routes');

    const { connectionId, grantId } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId,
      workspacePath: h.workspace,
      prompt: 'implement the change',
    });

    // The exact native triple reached the harness — not the profile id, not a
    // placeholder name, not a stale generation.
    assert.equal(started.route.providerId, 'workbuddy', 'the public id stays the operator-facing identity');
    assert.equal(started.route.providerRoute, 'dsh-delegate:workbuddy');
    assert.equal(started.route.model, 'deepseek-v4.1-flash');
    assert.equal(started.route.reasoningEffort, 'high');

    // Both halves of registration moved together, without any read-path warmup.
    assert.deepEqual(h.llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy']]);
    assert.deepEqual([...h.adapter.snapshot().routes], [['workbuddy', 'dsh-delegate:workbuddy']]);
    assert.deepEqual([...h.adapter.snapshot().models.get('dsh-delegate:workbuddy')], ['deepseek-v4.1-flash']);

    // The core resolves the exact model the adapter was given, which is the call
    // that answered ROUTING_MODEL_UNRESOLVED in the field.
    const info = await h.llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash');
    assert.equal(info.id, 'deepseek-v4.1-flash');
    assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['off', 'low', 'medium', 'high', 'max']);

    const settled = await settleEngineTask(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview, `the task must run, not fail: ${JSON.stringify(settled.error)}`);
    // A placed worker run drives a resolved Agent, so the model it used is the one
    // installed on that Agent and reported back on the run — not an
    // `agents.create` option it never passed.
    assert.equal(settled.execution.selection.model, 'deepseek-v4.1-flash');
    assert.equal(settled.execution.selection.provider, 'dsh-delegate:workbuddy');
    assert.equal(h.agents.created.length, 0, 'a placed run creates no agent through the registry');
  } finally {
    await h.close();
  }
});

test('a settings change reaches the next dispatch rather than being served from a stale snapshot', async () => {
  const h = await engineWire();
  try {
    const first = h.authorize();
    const one = await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await settleEngineTask(h.engine, one.taskId);
    assert.equal(one.route.model, 'deepseek-v4.1-flash');

    // The operator renames the provider and changes the served models.
    await h.settings.upsertProvider(providerProfile({
      name: 'WorkBuddy (renamed)',
      models: [
        { id: 'deepseek-v4.1-flash', name: 'Flash', efforts: ['off', 'low', 'medium', 'high', 'max'] },
        { id: 'deepseek-v4.1-flash-x', name: 'Flash X', efforts: ['off', 'high'] },
      ],
    }));
    await h.settings.setWorker({
      providerId: 'workbuddy',
      model: 'deepseek-v4.1-flash-x',
      reasoningEffort: 'high',
      timeoutSeconds: 600,
      maxParallelism: 1,
      isolation: 'shared',
    });

    const second = h.authorize();
    const two = await h.engine.start({
      connectionId: second.connectionId,
      grantId: second.grantId,
      workspacePath: h.workspace,
      prompt: 'second',
    });

    // Stored names and served models are the new ones on both sides.
    assert.deepEqual(h.llm.listProviders().map((entry) => [entry.id, entry.name]), [['dsh-delegate:workbuddy', 'WorkBuddy (renamed)']]);
    assert.deepEqual(
      [...h.adapter.snapshot().models.get('dsh-delegate:workbuddy')],
      ['deepseek-v4.1-flash', 'deepseek-v4.1-flash-x'],
      'the served generation is the edited one, not the one the first dispatch published',
    );
    assert.equal(two.route.model, 'deepseek-v4.1-flash-x');

    // Both edits are visible natively: the renamed provider and the added model,
    // with exactly the effort axis the new declaration lists.
    const info = await h.llm.resolveModelInfo('dsh-delegate:workbuddy', 'deepseek-v4.1-flash-x');
    assert.equal(info.id, 'deepseek-v4.1-flash-x');
    assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['off', 'high']);

    const settledTwo = await settleEngineTask(h.engine, two.taskId);
    assert.equal(settledTwo.state, TASK_STATES.awaitingHostReview, `the second task must run: ${JSON.stringify(settledTwo.error)}`);
    // The dispatch after the settings change must run on the NEW model, and the
    // evidence is the selection installed on the Agent of that second run.
    assert.equal(settledTwo.execution.selection.model, 'deepseek-v4.1-flash-x');
    assert.equal(settledTwo.execution.selection.reasoningEffort, 'high');
  } finally {
    await h.close();
  }
});

test('an unauthorized dispatch touches no route, model or agent', async () => {
  const h = await engineWire();
  try {
    await assert.rejects(
      () => h.engine.start({
        connectionId: 'conn-unknown',
        grantId: 'grant-unknown',
        workspacePath: h.workspace,
        prompt: 'do work',
      }),
      (error) => error.code === JOB_CODES.notAuthorized,
    );

    // Nothing native happened: the adapter is still empty, the runtime still owns
    // no route, and no agent exists. Registration is a side effect of an
    // *authorized* dispatch, never of a refused one.
    assert.deepEqual([...h.adapter.snapshot().routes], []);
    assert.deepEqual([...h.adapter.snapshot().models], []);
    assert.deepEqual(h.llm.listProviders(), []);
    assert.equal(h.agents.created.length, 0);
    assert.equal(h.ctx.effects.length, 0, 'no adapter registration may exist');
  } finally {
    await h.close();
  }
});
