test('a replaced preset registry retires the composition the plugin registered in the old one', async () => {
  // `apply` observes `agentPresets` on every review, because the service can be
  // replaced after load. The composition already registered in the previous
  // registry must be retired at the swap: forgetting it would leave a live
  // plugin-owned preset in a registry nothing talks to any more.
  const { nativePresetRegistry, cleanup } = await import('./helpers/fakes.js');
  const first = nativePresetRegistry();
  first.mounts = [];
  first.mount = async (mountCtx, id) => {
    first.mounts.push({ ctx: mountCtx, id });
    return { id: id ?? first.defaultId };
  };
  const { published, directory, ctx } = await applyWithRecorder({
    agentPresets: first,
    reviewPresetImporter: async () => ({ apply() {} }),
  });
  try {
    const firstId = await published.deps.reviewPresets.preparation({});
    assert.equal(first.definitions.size, 1);

    // The registry service is replaced under the plugin.
    const second = nativePresetRegistry();
    second.mounts = [];
    second.mount = async (mountCtx, id) => {
      second.mounts.push({ ctx: mountCtx, id });
      return { id: id ?? second.defaultId };
    };
    ctx.get = (serviceName) => (serviceName === 'agentPresets' ? second : null);

    const secondId = await published.deps.reviewPresets.preparation({});
    assert.match(secondId, /^dsh-delegate-review-[0-9a-f]{12}$/);
    assert.equal(secondId, firstId, 'the instance keeps the id it owns across a swap');
    assert.equal(first.definitions.size, 0, 'the composition in the old registry is retired');
    assert.equal(second.definitions.size, 1, 'the new registry gets its own registration');
    assert.equal(published.deps.reviewPresets.owns(secondId), true);

    await published.reviewPreset.dispose();
    assert.equal(second.definitions.size, 0);
    assert.equal(published.deps.reviewPresets.owns(secondId), false);
  } finally {
    await cleanup(directory);
  }
});
// Native plugin entry contract.
//
// This file exists because of a concrete install blocker, not for symmetry: the
// entry declared `Config` as a plain object (`{ dataDir: { type: 'string' } }`).
// Cordis validates a plugin's config *before* `apply` runs, by calling
// `runtime.Config['~standard'].validate(config)` (`resolveConfig` in
// `@deepseek-ai/cordis` 4.0.5). A plain object has no `~standard` member, so the
// failing dereference was `undefined.validate` and the row never activated:
//
//   dsh-delegate (dsh-delegate): TypeError: Cannot read properties of undefined
//   (reading 'validate')
//
// Every unit test still passed, because no test imported the entry the harness
// imports. The assertions below are therefore about the *shape the loader reads*,
// and they are written against the real Cordis call rather than a restatement of
// the schema's own fields.

import test from 'node:test';
import assert from 'node:assert/strict';

import { useDirectoryClassifier } from '../src/codex/installer.js';
import * as entry from '../src/index.js';

// Plugin startup refreshes a byte-exact shipped Codex agent, and that read inspects
// `$CODEX_HOME` through {@link useDirectoryClassifier} territory: on Windows the
// answer normally comes from a `powershell.exe` child. A suite has to run where a
// child cannot be spawned at all, so this file answers on the platform's behalf
// through the documented classifier hook — the product code path stays the same,
// only the platform answer is supplied. `lstat` still does the work: a missing Codex
// home, a real directory and a junction each get the verdict the platform would give.
useDirectoryClassifier(async (paths) => {
  const { lstatSync } = await import('node:fs');
  const kinds = new Map();
  for (const path of paths) {
    let info = null;
    try {
      info = lstatSync(path);
    } catch {
      info = null;
    }
    if (info === null) kinds.set(path, 'missing');
    else if (info.isSymbolicLink()) kinds.set(path, 'link');
    else if (info.isDirectory()) kinds.set(path, 'directory');
    else kinds.set(path, 'other');
  }
  return kinds;
});

test('the entry declares a name and the services the harness must provide', () => {
  assert.equal(entry.name, 'dsh-taskdispatch');
  assert.deepEqual(entry.inject, ['agents', 'sessions', 'llm', 'tools', 'webServer', 'connection']);
  assert.equal(typeof entry.apply, 'function');
});

test('Config implements the Standard Schema interface Cordis validates through', () => {
  const schema = entry.Config;
  // A schemastery schema is a callable object, so both of these are legitimate;
  // an object check alone would reject the real type.
  assert.ok(
    typeof schema === 'object' || typeof schema === 'function',
    'Config must be a schema value',
  );
  assert.ok(schema !== null, 'Config must not be null');

  // This is the exact lookup Cordis performs; anything else throws the recorded
  // TypeError and the plugin row is skipped as "did not activate".
  const standard = schema['~standard'];
  assert.ok(standard !== null && typeof standard === 'object', 'Config needs a ~standard member');
  assert.equal(typeof standard.validate, 'function', '~standard.validate must be callable');

  // Synchronous, because Cordis rejects async config validation outright.
  const result = standard.validate({});
  assert.ok(!('then' in result), 'config validation must be synchronous');
  assert.equal(result.issues, undefined);
  assert.deepEqual(result.value, { dataDir: '' }, 'the default is an empty data directory');
});

test('Config accepts an explicit data directory and refuses a non-string one', () => {
  const standard = entry.Config['~standard'];

  assert.deepEqual(standard.validate({ dataDir: 'C:\\data' }).value, { dataDir: 'C:\\data' });

  // A refusal must be reported as `issues`, which is what Cordis turns into a
  // ValidationError; returning a coerced value instead would silently accept it.
  const refused = standard.validate({ dataDir: 5 });
  assert.equal(refused.value, undefined);
  assert.ok(Array.isArray(refused.issues) && refused.issues.length > 0, 'a number must be refused');
});

test('Config is a real schema, not a structural coincidence', () => {
  // `resolveConfig` only needs `~standard`, but `dsh --dump-config-schema` and the
  // settings UI read the schema's own `type`/`meta` too. A hand-rolled object with
  // just `~standard` would boot and then dump nothing useful.
  assert.equal(entry.Config.type, 'object');
  assert.ok(entry.Config.meta !== null && typeof entry.Config.meta === 'object');
});

test('the manifest ships the schema dependency the entry imports', async () => {
  // The import above proves resolution inside this repository. A tarball consumer
  // has no devDependency, so the same import must be satisfied by `dependencies`.
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies?.['@deepseek-ai/schemastery'], '~3.18.4');
  assert.equal(manifest.devDependencies?.['@deepseek-ai/schemastery'], '~3.18.4');
});

// ---------------------------------------------------------------------------
// Wiring that a unit test cannot see
//
// The plugin mounted correctly in an isolated DSH 0.2.1-rc.2 profile and saved
// settings, but `/models` answered `route: "workbuddy"`, `models: []`,
// `ROUTING_MODEL_UNRESOLVED`. Both root causes were in `apply()`'s composition �?// the facade was registered instead of the native adapter, and the snapshot was
// published after registration instead of before �?so they are asserted at the
// level where they happened: the dependency object `apply` builds.
// ---------------------------------------------------------------------------

/**
 * Drive the real `apply` against a minimal-but-faithful Cordis context and a real
 * `LlmRuntime`, and hand back the published dependency object.
 *
 * Nothing about registration is faked: `ctx.llm` is the installed runtime, and
 * the credential seam is the only injected service.
 * @param {object} [options] - `providers` for the settings document.
 * @returns {Promise<object>} `{ deps, llm, dataDir, directory }`.
 */
async function applyWithRealRuntime(options = {}) {
  const { LlmRuntime } = await import('@deepseek-ai/dsh-llm');
  const { makeTempDir, validSettings } = await import('./helpers/fakes.js');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const directory = await makeTempDir();
  // The document is written *before* `apply`, because `apply` reads it once and
  // the settings service then caches that snapshot: a later write from another
  // instance would be invisible to the plugin under test.
  const settingsDir = join(directory, 'dsh-delegate');
  await mkdir(settingsDir, { recursive: true, mode: 0o700 });
  const document = options.providers === undefined ? validSettings() : options.providers;
  await writeFile(join(settingsDir, 'settings.json'), JSON.stringify(document), 'utf8');

  const effects = [];
  const disposeFns = [];
  const routes = new Map();

  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    reflect: { provide: () => () => {} },
    events: { dispatch: () => [] },
    // The entry uses `ctx.effect()` in two shapes: a generator (the runtime's own
    // `registerAdapter`) and a plain function returning a disposer (`ctx.effect(
    // () => dispose)`). Both must work here, exactly as Cordis accepts them.
    effect(effect) {
      if (typeof effect === 'function' && effect.constructor?.name !== 'GeneratorFunction') {
        const dispose = effect();
        const returned = typeof dispose === 'function' ? dispose : () => {};
        effects.push(returned);
        disposeFns.push(returned);
        return returned;
      }
      const iterator = effect.call(ctx);
      const first = iterator.next();
      const dispose = typeof first.value === 'function' ? first.value : () => {};
      effects.push(dispose);
      disposeFns.push(dispose);
      return dispose;
    },
    waterfall: () => Promise.resolve([]),
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve() { return { value: 'sk-entry-fixture', source: 'test-store' }; },
          async describe() { return { configured: true }; },
          async set() {},
          async unset() {},
        };
      }
      if (name === 'agentPresets') return options.agentPresets ?? null;
      return null;
    },
    provide() {},
    agents: { create: async () => ({}) },
    sessions: {},
    tools: {},
    webServer: { host: '127.0.0.1', port: 3210, register: () => () => {} },
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
  process.env.CODEX_HOME = options.codexHome ?? join(directory, 'codex-home');
  let published = null;
  ctx.provide = (serviceName, value) => { published = value; };
  try {
    await entry.apply(ctx, {
      dataDir: directory,
      ...(options.reviewPresetImporter === undefined ? {} : { reviewPresetImporter: options.reviewPresetImporter }),
    });
  } finally {
    process.env.DSH_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }

  return { published, llm: ctx.llm, routes, directory, ctx, effects };
}

/**
 * Drive the real `apply` with a preset registry present, and hand back the
 * published face plus a runner that invokes the plugin's own composed unload.
 *
 * `apply`'s disposers are collected by the context stub, but the Cordis-style
 * teardown order only matters for the review preset, so the test calls the
 * published composer's own `dispose` inside a full unload instead of guessing at
 * ordering from the disposer array.
 * @param {object} [options] - `agentPresets`, forwarded to the context.
 * @returns {Promise<object>} the same handle as {@link applyWithRealRuntime}.
 */
async function applyWithRecorder(options = {}) {
  const handle = await applyWithRealRuntime(options);
  return handle;
}

test('plugin startup refreshes exact shipped Codex agents and leaves unknown files alone', async () => {
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cleanup } = await import('./helpers/fakes.js');
  const prior = readFileSync(new URL('./fixtures/codex-agent-0.1.7.toml', import.meta.url), 'utf8')
    .replace(/\r?\n/gu, '\r\n');
  const current = readFileSync(new URL('../codex/dsh-delegate.toml', import.meta.url), 'utf8');

  for (const entry of [
    { name: 'known', contents: prior, expected: current },
    { name: 'edited', contents: `${prior}# operator note\r\n`, expected: `${prior}# operator note\r\n` },
  ]) {
    const codexHome = mkdtempSync(join(tmpdir(), `dsh-delegate-codex-${entry.name}-`));
    const agentPath = join(codexHome, 'agents', 'dsh-delegate.toml');
    mkdirSync(join(codexHome, 'agents'), { recursive: true });
    writeFileSync(agentPath, entry.contents, 'utf8');
    let handle;
    try {
      handle = await applyWithRealRuntime({ codexHome });
      assert.equal(readFileSync(agentPath, 'utf8'), entry.expected);
      assert.equal(existsSync(join(codexHome, 'config.toml')), false, 'startup migration must not install an MCP entry');
    } finally {
      if (handle !== undefined) await cleanup(handle.directory);
      rmSync(codexHome, { recursive: true, force: true });
    }
  }
});

test('apply wires a lazy review composition and registers nothing at activation', async () => {
  const { nativePresetRegistry } = await import('./helpers/fakes.js');
  const registry = nativePresetRegistry();
  registry.mounts = [];
  registry.mount = async (ctx, id) => {
    registry.mounts.push({ ctx, id });
    return { id: id ?? registry.defaultId };
  };
  const { published, directory } = await applyWithRecorder({
    agentPresets: registry,
    // The real composition mounts native packages this repository does not
    // depend on; the entry accepts a solver seam so the LIFECYCLE can be tested
    // without them (see the note in `src/index.js`).
    reviewPresetImporter: async () => ({ apply() {} }),
  });
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    assert.notEqual(published, null);
    // The composition is a request-time concern: registering it during the
    // plugin's own row activation would sit inside the Host Loader's settle gate.
    assert.equal(registry.registerCalls, 0, 'no preset may be registered by activation');
    assert.equal(published.reviewPreset.createdId, null);
    assert.equal(published.deps.reviewPresets.id, null);
    assert.equal(published.deps.reviewPresets.owns('anything'), false);

    // The facade prepares over the registry it can currently see, and reports the
    // namespaced id it created.
    const id = await published.deps.reviewPresets.preparation({});
    assert.match(id, /^dsh-delegate-review-[0-9a-f]{12}$/);
    assert.equal(registry.registerCalls, 1);
    assert.equal(published.deps.reviewPresets.owns(id), true);
    // No deployment preset may ever be claimed by this plugin.
    assert.equal(published.deps.reviewPresets.owns('standard'), false);
    assert.equal(published.deps.describeRuntime().reviewPreset, id);
    // The configured default is untouched: a worker run still joins it.
    assert.equal(registry.defaultId, 'standard');
    assert.equal(registry.definitions.has('standard'), false);
    // Only the two filesystem rows were declared.
    assert.deepEqual(
      registry.definitions.get(id).config.plugins.map((row) => row.name),
      ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search'],
    );

    // Unload releases the composition.
    await published.reviewPreset.dispose();
    assert.equal(registry.definitions.has(id), false);
    assert.equal(published.deps.describeRuntime().reviewPreset, 'not-registered');
  } finally {
    await cleanup(directory);
  }
});

test('without a preset registry the review composition reports itself unavailable', async () => {
  const { published, directory, ctx } = await applyWithRecorder({
    reviewPresetImporter: async () => ({ apply() {} }),
  });
  const { cleanup, nativePresetRegistry } = await import('./helpers/fakes.js');
  try {
    assert.notEqual(published, null);
    assert.equal(published.deps.agentPresets, null);
    assert.equal(published.deps.describeRuntime().presetRegistry, 'unavailable');
    await assert.rejects(
      () => published.deps.reviewPresets.preparation({}),
      (error) => error.code === 'REVIEW_PRESET_UNSUPPORTED',
    );

    // The facade reads the registry lazily, so a service that appears AFTER the
    // plugin loaded is still usable �?the composition is not frozen at startup.
    const late = nativePresetRegistry();
    late.mounts = [];
    late.mount = async (mountCtx, id) => {
      late.mounts.push({ ctx: mountCtx, id });
      return { id: id ?? late.defaultId };
    };
    ctx.get = (name) => (name === 'agentPresets' ? late : null);
    const id = await published.deps.reviewPresets.preparation({});
    assert.match(id, /^dsh-delegate-review-[0-9a-f]{12}$/);
    assert.equal(late.registerCalls, 1);
    await published.reviewPreset.dispose();
    assert.equal(late.definitions.size, 0);
  } finally {
    await cleanup(directory);
  }
});

test('the runtime report states the per-task conversation rule and exposes no mode', async () => {
  // The removed control must be gone from the report an operator (and the settings
  // page) reads: a leftover `conversationMode` field would tell a reader that a
  // directory-level choice still exists.
  const { published, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    const report = published.deps.describeRuntime();
    assert.equal('conversationMode' in report, false, 'the retired mode must not be reported');
    assert.equal(report.conversation, 'per-task');
    assert.equal(report.conversationContinuation, 'continueFromTaskId');
  } finally {
    await cleanup(directory);
  }
});

test('the plugin restores the persisted local MCP switch at startup', async () => {
  const { validSettings, cleanup } = await import('./helpers/fakes.js');
  const { published: fresh, directory: freshDirectory } = await applyWithRealRuntime();
  try {
    assert.deepEqual(fresh.engine.posture(), {
      authorized: false,
      reason: 'delegation is disabled',
      mode: 'switch',
    });
  } finally {
    await cleanup(freshDirectory);
  }

  const persisted = { ...validSettings(), delegationEnabled: true };
  const { published: restarted, directory } = await applyWithRealRuntime({ providers: persisted });
  try {
    assert.deepEqual(restarted.engine.posture(), { authorized: true, reason: null, mode: 'switch' });
  } finally {
    await cleanup(directory);
  }
});

test('the plugin publishes its active loopback port for the standalone MCP client', async () => {
  const { cleanup } = await import('./helpers/fakes.js');
  const { readRuntimeEndpoint, resolveEndpointDiscoveryPath } = await import('../src/runtime/endpoint-discovery.js');
  const { directory } = await applyWithRealRuntime();
  try {
    const endpoint = await readRuntimeEndpoint(resolveEndpointDiscoveryPath({ DSH_HOME: directory }));
    assert.equal(endpoint.host, '127.0.0.1');
    assert.equal(endpoint.port, 3210);
    assert.equal(endpoint.processId, process.pid);
  } finally {
    await cleanup(directory);
  }
});

test('apply publishes a route resolver that registers the native adapter, not the facade', async () => {
  const { published, llm, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    assert.notEqual(published, null, 'the plugin face must be published');
    assert.equal(typeof published.deps.ensureRoutes, 'function');

    const settings = await published.settings.read();
    const mapped = await published.deps.ensureRoutes(settings);
    assert.deepEqual([...mapped], [['relay', 'dsh-delegate:relay']]);

    // The harness stored a route that can actually resolve a model.
    const listed = llm.listProviders();
    assert.deepEqual(listed.map((provider) => provider.id), ['dsh-delegate:relay']);
    assert.equal(listed[0].name, 'Local relay', 'the configured display name must be captured at registration');
    const info = await llm.resolveModelInfo('dsh-delegate:relay', 'deepseek-chat');
    assert.equal(info.id, 'deepseek-chat');
    // Exactly the declared axis from `validSettings()`: nothing added, nothing dropped.
    assert.deepEqual(
      info.reasoning.efforts.map((effort) => effort.id).sort(),
      ['high', 'low', 'medium', 'off'],
    );

    // The ambient profile id is not a route.
    await assert.rejects(
      () => llm.resolveModelInfo('relay', 'deepseek-chat'),
      (error) => error.code === 'NO_ADAPTER',
    );
  } finally {
    await cleanup(directory);
  }
});

test('apply publishes a resolver whose registered routes agree with the adapter snapshot', async () => {
  const { published, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    const settings = await published.settings.read();
    const mapped = await published.deps.ensureRoutes(settings);
    const snapshot = published.deps.adapterSnapshot();
    assert.deepEqual([...snapshot.routes], [...mapped], 'the adapter must serve exactly the registered mapping');
    assert.deepEqual(snapshot.models.get('dsh-delegate:relay'), ['deepseek-chat', 'deepseek-reasoner']);
  } finally {
    await cleanup(directory);
  }
});

test('apply\'s route resolver reports a refusal instead of substituting an ambient route', async () => {
  const { published, llm, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    const stored = await published.settings.read();
    const mapped = await published.deps.ensureRoutes(stored);
    assert.equal(mapped.get('relay'), 'dsh-delegate:relay');

    // Break registration from underneath: a disposed registry cannot ensure
    // routes, which is exactly how a refused registration reaches the read paths.
    published.providerRegistry.dispose();
    const outcome = await published.deps.resolveRoutes(stored, 'a test read');
    assert.equal(outcome.routes, null, 'a disposed registry must not yield a mapping');
    assert.equal(outcome.error.code, 'provider_registry');
    assert.equal(typeof outcome.error.message, 'string');

    // Nothing is left registered, and no ambient route answers for the profile.
    assert.deepEqual(llm.listProviders(), []);
    await assert.rejects(
      () => llm.resolveModelInfo('relay', 'deepseek-chat'),
      (error) => error.code === 'NO_ADAPTER',
    );
  } finally {
    await cleanup(directory);
  }
});

test('a blocked re-registration through apply leaves the old routes and the old snapshot in place', async () => {
  const { published, llm, directory } = await applyWithRealRuntime();
  const { cleanup } = await import('./helpers/fakes.js');
  const { createProviderRegistry } = await import('../src/model/providers.js');
  try {
    // Generation 1 is registered and working through the entry's own resolver.
    const first = await published.settings.read();
    const mapped = await published.deps.ensureRoutes(first);
    assert.deepEqual([...mapped], [['relay', 'dsh-delegate:relay']]);
    await llm.resolveModelInfo('dsh-delegate:relay', 'deepseek-chat');
    const before = published.deps.adapterSnapshot();
    assert.deepEqual([...before.models.get('dsh-delegate:relay')], ['deepseek-chat', 'deepseek-reasoner']);

    // A second owner takes a route the plugin's namespace also derives. It is
    // created from the *same* adapter and runtime, so only route ownership can
    // make the plugin's re-registration fail.
    const rival = createProviderRegistry({ llm, adapter: published.deps.providerRegistry.nativeAdapter() });
    rival.commitRoutes(new Map([['rival', 'dsh-delegate:rival']]));

    // The plugin's own re-registration now needs `dsh-delegate:rival` too: the core
    // refuses it with DUPLICATE_ADAPTER, after the adapter had published the
    // candidate. The resolver must report the refusal and leave both sides alone.
    const outcome = await published.deps.resolveRoutes({
      ...first,
      providers: [...first.providers, {
        id: 'rival',
        name: 'Rival (candidate)',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:1/v1',
        credentialRef: 'RIVAL_KEY',
        models: [{ id: 'deepseek-chat', efforts: ['low'] }],
      }],
    }, 'a blocked re-registration');

    assert.equal(outcome.routes, null, 'a refused re-registration must yield no mapping');
    assert.equal(outcome.error.code, 'DUPLICATE_ADAPTER');

    // Native side: the working generation is still described by the core, under
    // its old name and old models.
    const byId = new Map(llm.listProviders().map((entry) => [entry.id, entry.name]));
    assert.equal(byId.get('dsh-delegate:relay'), 'Local relay');
    assert.equal(byId.get('dsh-delegate:rival'), 'dsh-delegate:rival');
    const info = await llm.resolveModelInfo('dsh-delegate:relay', 'deepseek-reasoner');
    assert.equal(info.id, 'deepseek-reasoner');

    // Facade side: the old snapshot, names and models �?not the candidate's.
    const after = published.deps.adapterSnapshot();
    assert.deepEqual([...after.routes], [...before.routes]);
    assert.deepEqual(after.providerIds, before.providerIds);
    assert.deepEqual([...after.models], [...before.models]);
    assert.equal(after.routes.has('rival'), false);
    assert.equal(after.models.has('dsh-delegate:rival'), false);
  } finally {
    await cleanup(directory);
  }
});

test('an empty provider configuration stays inert through apply', async () => {
  const { validSettings } = await import('./helpers/fakes.js');
  // A fresh install: no providers, and therefore no worker chosen yet. That is the
  // stored-but-unconfigured shape the settings validator documents as legal
  // (`isUnconfiguredSelection`), and the posture this test pins down.
  const fresh = { ...validSettings(), providers: [], worker: { providerId: null } };
  const { published, llm, directory } = await applyWithRealRuntime({ providers: fresh });
  const { cleanup } = await import('./helpers/fakes.js');
  try {
    const settings = await published.settings.read();
    assert.deepEqual(settings.providers, []);
    const mapped = await published.deps.ensureRoutes(settings);
    assert.deepEqual([...mapped], []);
    assert.deepEqual(llm.listProviders(), [], 'an empty configuration must register nothing natively');
    assert.deepEqual([...published.deps.adapterSnapshot().routes], []);
    // And it stays that way on a second ensure: still nothing registered.
    assert.deepEqual([...(await published.deps.ensureRoutes(settings))], []);
    assert.deepEqual(llm.listProviders(), []);
  } finally {
    await cleanup(directory);
  }
});
