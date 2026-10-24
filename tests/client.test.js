// Registration-contract test for the built browser bundle.
//
// `lib/client.js` is evaluated the way `@deepseek-ai/dsh-client-modules` evaluates
// it: the script calls `window.__ModuleLoader__.load({ id, factory })` and nothing
// else runs; the factory body (the module) materializes later through `require`.
// The test therefore reproduces that two-step arrival instead of importing the
// file, because the file is not a module.
//
// What it pins down is the part a browser smoke test is not available for here:
//
//   * the registration id equals the package name the loader indexes;
//   * the page occupies `plugins.bundle.config` (kind `keyed`, root scope) under
//     the key the Plugins manager passes as `entryKey` — the bundle's npm name;
//   * no `settings.section` registration remains, so the old Settings page cannot
//     silently reappear beside the new one;
//   * the module requests stay inside the frozen platform table;
//   * `apply` registers through `ctx.slots.inject` and never submits a task.
//
// React itself is stubbed: the bundle only reads the React namespace when it
// renders, so materialization needs no live renderer. Rendering the page is the
// browser-side check this cannot replace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_PATH = join(ROOT, 'lib', 'client.js');
const BUNDLE_TEXT = readFileSync(BUNDLE_PATH, 'utf8');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Platform modules the loader seeds; anything else must be declared elsewhere. */
const PLATFORM_SEED = new Set(['react', 'react/jsx-runtime']);

/**
 * Arrive the bundle: execute the registration script, then materialize the
 * factory the way the module loader does.
 * @returns {object} `{ id, exports, requests }`.
 */
function materializeBundle() {
  const registrations = [];
  const requests = [];
  const window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration);
      },
    },
  };

  vm.runInNewContext(BUNDLE_TEXT, { window });

  assert.equal(registrations.length, 1, 'one script must register exactly one module');
  const [registration] = registrations;
  assert.equal(typeof registration.factory, 'function', 'a registration carries a factory');

  const require = (specifier) => {
    requests.push(specifier);
    // A namespace stub is enough: the bundle only dereferences React while
    // rendering, which this test never does.
    if (PLATFORM_SEED.has(specifier)) return {};
    throw new Error(`require("${specifier}") is not a platform module`);
  };

  return { id: registration.id, exports: registration.factory(require), requests };
}

const MODULE = materializeBundle();

/** Build the smallest faithful `ctx` for a client plugin. */
function fakeClientContext() {
  const effects = [];
  const injections = [];
  const unused = [];
  return {
    effects,
    injections,
    unused,
    effect(create, label) {
      effects.push({ label, disposer: create() });
      return () => {};
    },
    slots: {
      inject(name, callback) {
        injections.push({ name, callback });
        return () => {};
      },
      register(options, component) {
        unused.push({ options, component });
        return () => {};
      },
    },
  };
}

test('the bundle registers under the package name the module loader indexes', () => {
  assert.equal(MODULE.id, MANIFEST.name);
  assert.equal(MODULE.id, 'dsh-delegate');
});

test('the module requests only platform modules', () => {
  assert.deepEqual([...new Set(MODULE.requests)].sort(), ['react', 'react/jsx-runtime']);
});

test('the exported contract names the bundle config slot and its exact key', () => {
  const client = MODULE.exports;
  assert.equal(client.PLUGIN_CONFIG_SLOT, 'plugins.bundle.config');
  assert.equal(client.PLUGIN_BUNDLE_KEY, 'dsh-delegate');
  // The key is matched against the bundle package name by the manager's ledger,
  // so the two must not drift apart.
  assert.equal(client.PLUGIN_BUNDLE_KEY, MANIFEST.name);
  assert.deepEqual([...client.inject], ['slots']);
  assert.equal(typeof client.apply, 'function');
  assert.equal(typeof client.registerBundleConfiguration, 'function');
  assert.equal(typeof client.DelegateConfigPage, 'function');
});

test('registerBundleConfiguration occupies plugins.bundle.config, keyed by dsh-delegate', () => {
  const ctx = fakeClientContext();
  const store = { init() {}, getSnapshot() { return {}; }, subscribe() { return () => {}; } };
  const dispose = MODULE.exports.registerBundleConfiguration(ctx, { store });
  assert.equal(typeof dispose, 'function');

  // One injection, into the keyed slot, and the callback registers exactly one
  // entry under that slot name.
  assert.equal(ctx.injections.length, 1);
  const [injection] = ctx.injections;
  assert.equal(injection.name, 'plugins.bundle.config');
  assert.equal(typeof injection.callback, 'function');

  injection.callback();
  assert.equal(ctx.unused.length, 1, 'the injection must register exactly one entry');
  const { options, component } = ctx.unused[0];
  assert.equal(options.name, 'plugins.bundle.config');
  assert.equal(options.key, 'dsh-delegate');
  // The manager's bundle page passes `{ view: 'page' }`; a registration may
  // declare neither `id`, `order` nor `label` here (those belong to list slots).
  assert.equal(options.id, undefined);
  assert.equal(options.order, undefined);
  assert.equal(options.label, undefined);
  assert.equal(options.locale, undefined, 'the page is Chinese-only and declares no locale face');
  assert.equal(typeof options.inject, 'function');
  // The inject face hands the page its own user-plane store, not a host form.
  const face = options.inject();
  assert.equal(face.store, store);
  assert.equal(component, MODULE.exports.DelegateConfigPage);
});

test('apply wires the stylesheet, store and bundle page — and nothing else', () => {
  const ctx = fakeClientContext();
  MODULE.exports.apply(ctx);

  // Two effects for setup (stylesheet, registration) plus one for store disposal.
  assert.ok(ctx.effects.length >= 3, 'apply must register its effects');
  for (const effect of ctx.effects) {
    assert.equal(typeof effect.label, 'string');
    assert.doesNotMatch(effect.label, /settings section|settings\.section/u);
  }

  assert.equal(ctx.injections.length, 1, 'apply must inject exactly one slot');
  assert.equal(ctx.injections[0].name, 'plugins.bundle.config');

  // No duplicate Settings page in the shipped registration.
  assert.doesNotMatch(BUNDLE_TEXT, /settings\.section/u);
  assert.doesNotMatch(BUNDLE_TEXT, /registerSettingsSection/u);
});

test('the page store exposes no task-submit action', () => {
  // The bundle's only action surface is the store the page receives. Submission
  // belongs to the MCP host over the execution plane; a submit method here would
  // be a second, unauthorized path.
  const ctx = fakeClientContext();
  MODULE.exports.apply(ctx);
  ctx.injections[0].callback();
  const store = ctx.unused[0].options.inject().store;

  const names = Object.keys(store);
  assert.ok(names.length > 0, 'the store must expose actions');
  for (const name of names) {
    assert.doesNotMatch(name, /submit|dispatch|execute/iu, `the store must not expose ${name}`);
  }
  // Task handling is read/cancel only.
  assert.equal(typeof store.cancelTask, 'function');
  assert.equal(typeof store.loadTasks, 'function');
  // The execution plane (the MCP host's path) is not reachable from the client.
  assert.doesNotMatch(BUNDLE_TEXT, /\/dsh-delegate\/x/u);
});

test('the manifest orders this bundle after the Plugins manager that owns the slot', () => {
  // `dsh.client.inject` is the supported ordering mechanism: the loader registers
  // each named package's factory before this one materializes, and the slot only
  // exists once the manager's own entry has registered it.
  assert.deepEqual(MANIFEST.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
  ]);
  // The manager must not be requested as a runtime module — the registrant merges
  // the slot contract with `import type` only.
  for (const specifier of MODULE.requests) {
    assert.ok(!specifier.startsWith('@deepseek-ai/dsh-client-ui-plugin-manager'), specifier);
  }
  // The old Settings shell is no longer a dependency of this bundle.
  assert.ok(!MANIFEST.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings-general'));
  // The platform declaration stays `web`: 0.2.x client-modules selects nothing else.
  assert.equal(MANIFEST.dsh.client.platform, 'web');
});
