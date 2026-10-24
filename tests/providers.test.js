// Native provider route registration.
//
// These tests are built around one fact of the installed core rather than around
// this module's own preferences: `LlmRuntime.registerAdapter(ids, adapter)` is
// not lazy. While validating a candidate route set it calls
// `adapter.providerInfo(id)` and `adapter.providerRetryPolicy(id)`
// *synchronously* (`prepareRoutes`, dsh-llm 0.2.0-rc.2 lib/index.js:1858) and
// refuses the whole set unless the returned `id` equals the route and `name` is
// non-empty. Whatever that adapter is serving at that instant is therefore the
// registration.
//
// Two real failures observed in an isolated DSH 0.2.1-rc.2 profile are encoded
// below as tests, because both are invisible to a lenient double:
//
//   1. the plugin passed its *management facade* to `registerAdapter`. The facade
//      has `providerInfo`, so registration "succeeded", but it has no
//      `prepareCall`/`stream`, and the route answered `ROUTING_MODEL_UNRESOLVED`
//      ("no adapter registered for provider workbuddy") on every model call;
//   2. the plugin registered the routes *before* publishing the snapshot they
//      described. `providerInfo` is answered from the served snapshot, so the
//      names the harness stored were the previous generation's (or the route-id
//      placeholder, or a throw, depending on ordering).
//
// The double below is a deliberate mirror: it checks the same things in the same
// synchronous order and refuses the same shapes, so a test that passes here would
// have registered there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProviderRegistry, nativeAdapterOf } from '../src/model/providers.js';

/**
 * A faithful double of the native core plus a native adapter over a mutable
 * "served snapshot" map.
 *
 * `providerInfo` reads the served snapshot for the route, exactly like
 * `PiAiAdapter.providerInfo` (`this.current().profiles.get(provider)?.displayName
 * ?? provider`), and `prepare` mirrors `LlmRuntime.prepareRoutes` including its
 * refusal conditions and its synchronous call order.
 * @param {object} [options] - `replaceThrows`: error a route swap must raise.
 * @returns {object} `{ llm, adapter, facade, state }`.
 */
function nativeDouble({ replaceThrows = null } = {}) {
  const state = {
    // route -> { name, retryPolicy } the adapter would answer for right now.
    served: new Map(),
    // route -> { id, name } the harness actually stored, i.e. what it captured.
    registered: new Map(),
    registerCalls: 0,
    registerArgs: [],
    replaces: [],
    disposed: 0,
    disposeCalls: 0,
    calls: [],
  };

  const adapter = {
    providerInfo(provider) {
      state.calls.push(['providerInfo', provider]);
      const profile = state.served.get(provider);
      // Placeholder fallback, as the real adapter does for an unserved route.
      return { id: provider, name: profile?.name ?? provider };
    },
    providerRetryPolicy(provider) {
      state.calls.push(['providerRetryPolicy', provider]);
      return state.served.get(provider)?.retryPolicy;
    },
    // The call path the plugin promised: its presence is what distinguishes a
    // registrable adapter from a management facade.
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: () => this.stream() };
    },
    async resolveModel(provider, model) {
      if (!state.served.has(provider)) {
        const error = new Error(`no adapter registered for provider "${provider}"`);
        error.code = 'NO_ADAPTER';
        throw error;
      }
      return { provider, id: model, name: model };
    },
  };

  /** Mirror of `LlmRuntime.prepareRoutes`: synchronous, all-or-nothing. */
  function prepare(providers, owned) {
    const unique = new Set();
    const registrations = [];
    for (const provider of providers) {
      if (typeof provider !== 'string' || provider.length === 0) {
        throw Object.assign(new Error('adapter provider names must be non-empty'), { code: 'INVALID_ADAPTER' });
      }
      if (unique.has(provider) || (state.registered.has(provider) && !owned.has(provider))) {
        throw Object.assign(new Error(`an adapter for provider "${provider}" is already registered`), { code: 'DUPLICATE_ADAPTER' });
      }
      // Synchronous reads, in the core's own order.
      const info = adapter.providerInfo(provider);
      if (typeof info?.id !== 'string' || info.id !== provider
        || typeof info.name !== 'string' || info.name.length === 0) {
        throw Object.assign(new Error(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`), { code: 'INVALID_ADAPTER' });
      }
      unique.add(provider);
      adapter.providerRetryPolicy(provider);
      registrations.push({ provider, name: info.name, adapter });
    }
    return registrations;
  }

  function commit(owned, registrations) {
    for (const provider of owned) state.registered.delete(provider);
    owned.clear();
    for (const entry of registrations) {
      state.registered.set(entry.provider, entry);
      owned.add(entry.provider);
    }
  }

  const llm = {
    registerAdapter(providers, registered) {
      state.registerCalls += 1;
      assert.equal(typeof registered?.stream, 'function', 'the registered object must be able to stream');
      state.registerArgs.push([[...providers], registered]);
      const owned = new Set();
      let released = false;
      const dispose = () => {
        state.disposeCalls += 1;
        released = true;
        for (const provider of owned) state.registered.delete(provider);
        owned.clear();
      };
      const handle = () => {
        state.disposed += 1;
        dispose();
      };
      handle.replace = (next) => {
        if (replaceThrows !== null) throw replaceThrows;
        state.replaces.push([...next]);
        commit(owned, prepare(next, owned));
      };
      // First registration is itself all-or-nothing.
      const prepared = prepare(providers, owned);
      commit(owned, prepared);
      return handle;
    },
    listProviders() {
      return [...state.registered.values()].map((entry) => ({ id: entry.provider, name: entry.name }));
    },
  };

  // The management facade the entry point holds: metadata methods and mutation,
  // no call path. Handing this to registerAdapter is the historical bug.
  const facade = {
    replace() {},
    getAdapter: () => adapter,
    snapshot: () => ({ routes: new Map() }),
  };

  return { llm, adapter, facade, state };
}

/** Serve one provider list on the adapter, as `ensureRoutes` must do first. */
function serve(state, providers) {
  for (const provider of providers) {
    state.served.set(provider.route, { name: provider.name, retryPolicy: undefined });
  }
}

const ROUTE = (id) => `dsh-delegate:${id}`;

test('the first non-empty ensure registers the namespaced native routes once', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  serve(state, [{ route: ROUTE('primary'), name: 'Primary' }, { route: ROUTE('backup'), name: 'Backup' }]);

  const ensured = await registry.ensure([{ id: 'primary', name: 'Primary' }, { id: 'backup', name: 'Backup' }]);

  assert.equal(state.registerCalls, 1);
  // The harness stored the names the adapter was serving, not the route ids.
  assert.deepEqual([...state.registered.keys()], [ROUTE('primary'), ROUTE('backup')]);
  assert.equal(state.registered.get(ROUTE('primary')).name, 'Primary');
  assert.ok(ensured.routes instanceof Map);
  assert.deepEqual([...ensured.routes], [
    ['primary', ROUTE('primary')],
    ['backup', ROUTE('backup')],
  ]);
  for (const [publicId, nativeId] of ensured.routes) {
    assert.notEqual(publicId, nativeId, 'the native route must be separate from the public id');
  }
});

test('registering the management facade is refused; the native adapter is unwrapped instead', () => {
  const { llm, adapter, facade } = nativeDouble();

  // A facade has no call path of its own, so it could never be registered; the
  // unwrapper returns the instance that can be.
  assert.equal(typeof facade.stream, 'undefined', 'the facade must not look like an adapter');
  assert.equal(nativeAdapterOf(facade), adapter, 'the facade must be unwrapped to the native instance');
  assert.equal(nativeAdapterOf(adapter), adapter, 'a native adapter is passed through unchanged');
  // A bare metadata object (no stream, no unwrapper) is refused outright.
  assert.throws(
    () => createProviderRegistry({ llm, adapter: { providerInfo: (id) => ({ id, name: id }) } }),
    /a native provider adapter is required/u,
  );
  // An unwrapper that yields a non-streamable object is refused too.
  assert.throws(
    () => createProviderRegistry({ llm, adapter: { getAdapter: () => ({ providerInfo: () => null }) } }),
    /does not expose a native adapter that can stream/u,
  );
});

test('a registry built from the facade registers the native adapter, never the facade', async () => {
  const { llm, adapter, facade, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter: facade });
  serve(state, [{ route: ROUTE('relay'), name: 'Relay' }]);

  await registry.ensure([{ id: 'relay', name: 'Relay' }]);

  assert.equal(registry.nativeAdapter(), adapter);
  assert.equal(state.registered.get(ROUTE('relay')).adapter, adapter, 'the stored adapter must be the streamable instance');
  assert.equal(state.registered.get(ROUTE('relay')).adapter === facade, false, 'the facade must never be stored');
});

test('registering before publishing the snapshot keeps the route-id placeholder instead of the configured name', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });

  // The wrong order: register while the adapter still serves an empty snapshot.
  // The native core accepts it (the placeholder name is non-empty), which is
  // exactly why the ordering bug was invisible until an operator saw the name.
  await registry.ensure([{ id: 'relay', name: 'Local relay' }]);
  assert.equal(state.registered.get(ROUTE('relay')).name, ROUTE('relay'));

  // The supported order: serve first, then register — synchronously, inside the
  // callback, so nothing can observe the two sides apart. The stored name is the
  // one the operator configured.
  const { llm: llm2, adapter: adapter2, state: state2 } = nativeDouble();
  const registry2 = createProviderRegistry({ llm: llm2, adapter: adapter2 });
  let seenInside = null;
  await registry2.register([{ id: 'relay', name: 'Local relay' }], (routes) => {
    serve(state2, [{ route: ROUTE('relay'), name: 'Local relay' }]);
    // The commit runs inside this callback, so the core already holds the route
    // by the time the callback returns.
    registry2.commitRoutes(routes);
    seenInside = [...state2.registered.keys()];
  });
  assert.deepEqual(seenInside, [ROUTE('relay')], 'the native commit must happen inside the synchronous callback');
  assert.equal(state2.registered.get(ROUTE('relay')).name, 'Local relay');
});

test('register() runs the callback before any native state changes, and commits in the same section', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  const order = [];

  await registry.register([{ id: 'a' }], (routes) => {
    order.push(['callback', [...routes], state.registerCalls]);
    serve(state, [{ route: ROUTE('a'), name: 'A' }]);
    order.push(['before native', state.registerCalls]);
    registry.commitRoutes(routes);
    order.push(['after native', state.registerCalls]);
  });

  assert.deepEqual(order, [
    ['callback', [['a', ROUTE('a')]], 0],
    ['before native', 0],
    ['after native', 1],
  ]);
  assert.deepEqual([...state.registered.keys()], [ROUTE('a')]);
});

test('register() refuses an asynchronous callback instead of committing after it resolves', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  const deferredCommitErrors = [];

  // `async (routes) => { … }` was the previous contract, and it is exactly the bug:
  // the body runs up to its first `await` now, and a native commit after that
  // `await` lands in a microtask — after `register()` had already resolved with a
  // mapping nobody had registered.
  await assert.rejects(
    () => registry.register([{ id: 'a' }], async (routes, commit) => {
      serve(state, [{ route: ROUTE('a'), name: 'A' }]);
      // A yield before the native commit: the window this contract closes. The
      // handed `commit()` is guarded, so it refuses instead of registering late.
      await Promise.resolve();
      try {
        commit();
      } catch (error) {
        deferredCommitErrors.push(error.message);
      }
    }),
    /must not be asynchronous/u,
  );

  // The registry answered with the refusal, not with a mapping, and the commit that
  // was queued behind the yield could not reach the core at all.
  assert.deepEqual(deferredCommitErrors, ['the registration callback committed outside its own synchronous section']);
  assert.equal(state.registerCalls, 0, 'the core must not be registered from a callback that yielded');
  assert.deepEqual([...state.registered.keys()], []);
});

test('a callback that commits twice, or commits before publishing, is refused', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  serve(state, [{ route: ROUTE('a'), name: 'A' }]);

  await assert.rejects(
    () => registry.register([{ id: 'a' }], (routes, commit) => {
      commit();
      commit();
    }),
    /committed the same candidate twice/u,
  );
  assert.equal(state.registerCalls, 1, 'the second commit must not reach the core');
  assert.deepEqual([...state.registered.keys()], [ROUTE('a')]);
});

test('a callback that commits synchronously and returns a value is accepted', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });

  // The value a synchronous callback returns is not part of the contract; only a
  // thenable is refused. Returning `undefined`, a number, or the routes must work.
  await registry.register([{ id: 'a' }], (routes) => {
    serve(state, [{ route: ROUTE('a'), name: 'A' }]);
    registry.commitRoutes(routes);
    return routes.size;
  });
  assert.deepEqual([...state.registered.keys()], [ROUTE('a')]);
});

test('a callback that throws leaves the registration untouched and surfaces its error', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  const failure = Object.assign(new Error('snapshot refused'), { code: 'INVALID_SNAPSHOT' });

  await assert.rejects(() => registry.register([{ id: 'a' }], () => { throw failure; }), /snapshot refused/u);
  assert.equal(state.registerCalls, 0, 'no native registration may follow a refused snapshot');

  await assert.rejects(() => registry.register([{ id: 'a' }], 'not a function'), /registration callback is required/u);
});

test('an empty first ensure registers nothing and a later list registers lazily', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });

  const empty = await registry.ensure([]);
  assert.deepEqual([...empty.routes], []);
  assert.equal(state.registerCalls, 0, 'an empty initial set must not hit the core');

  serve(state, [{ route: ROUTE('only'), name: 'Only' }]);
  await registry.ensure(['only']);
  assert.deepEqual([...state.registered.keys()], [ROUTE('only')]);
  assert.equal(state.replaces.length, 0);
});

test('later ensures replace the whole set atomically, including a later empty set', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });

  serve(state, [{ route: ROUTE('a'), name: 'A' }, { route: ROUTE('b'), name: 'B' }]);
  await registry.ensure(['a', 'b']);
  serve(state, [{ route: ROUTE('c'), name: 'C' }]);
  await registry.ensure(['b', 'c']);
  await registry.ensure([]);

  assert.equal(state.registerCalls, 1, 'the adapter is registered once');
  assert.deepEqual(state.replaces, [[ROUTE('b'), ROUTE('c')], []]);
  assert.equal(state.disposed, 0, 'replacement must not dispose the registration');
});

test('each ensure returns a fresh Map that a later ensure cannot mutate', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  serve(state, [{ route: ROUTE('a'), name: 'A' }]);

  const first = await registry.ensure(['a']);
  first.routes.set('a', 'tampered');
  first.routes.set('injected', ROUTE('injected'));

  const second = await registry.ensure(['a']);
  assert.deepEqual([...second.routes], [['a', ROUTE('a')]]);
  assert.notEqual(first.routes, second.routes);
});

test('the route id derivation is injectable and must stay collision free', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter, routeIdFor: (publicId) => `p/${publicId}` });
  serve(state, [{ route: 'p/a', name: 'A' }]);

  const ensured = await registry.ensure(['a']);
  assert.deepEqual([...ensured.routes], [['a', 'p/a']]);
  assert.deepEqual([...state.registered.keys()], ['p/a']);

  const colliding = createProviderRegistry({ llm, adapter, routeIdFor: () => 'same' });
  await assert.rejects(() => colliding.ensure(['a', 'b']), /collides on native route id/u);
  assert.equal(state.registerCalls, 1, 'a refused set must not register');
});

test('invalid, duplicate, or unusable provider ids are refused before mutating registration', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });

  await assert.rejects(() => registry.ensure(['a', 'a']), /listed more than once/u);
  await assert.rejects(() => registry.ensure(['a', '']), /non-empty id/u);
  await assert.rejects(() => registry.ensure([{ name: 'no id' }]), /non-empty id/u);
  await assert.rejects(() => registry.ensure('a'), /must be an array/u);
  await assert.rejects(() => registry.ensure([1]), /non-empty id/u);

  assert.equal(state.registerCalls, 0);
  assert.equal(state.replaces.length, 0);
});

test('a refused ensure on a live registration leaves the current routes in place', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  serve(state, [{ route: ROUTE('a'), name: 'A' }]);

  await registry.ensure(['a']);
  await assert.rejects(() => registry.ensure(['a', 'a']), /listed more than once/u);
  await assert.rejects(() => registry.ensure([null]), /non-empty id/u);

  assert.equal(state.registerCalls, 1);
  assert.equal(state.replaces.length, 0, 'a refused candidate must not reach replace()');
  assert.deepEqual([...state.registered.keys()], [ROUTE('a')]);
});

test('a rejected native replace surfaces and keeps the registration alive', async () => {
  const failure = Object.assign(new Error('duplicate adapter route'), { code: 'DUPLICATE_ADAPTER' });
  const { llm, adapter, state } = nativeDouble({ replaceThrows: failure });
  const registry = createProviderRegistry({ llm, adapter });
  serve(state, [{ route: ROUTE('a'), name: 'A' }, { route: ROUTE('b'), name: 'B' }, { route: ROUTE('c'), name: 'C' }]);

  await registry.ensure(['a']);
  await assert.rejects(() => registry.ensure(['b']), /duplicate adapter route/u);
  assert.equal(state.disposed, 0);

  await assert.rejects(() => registry.ensure(['c']), /duplicate adapter route/u);
  assert.equal(state.registerCalls, 1);
  assert.deepEqual([...state.registered.keys()], [ROUTE('a')], 'the live route must survive a refused swap');
});

test('a missing native registration API is refused at construction', () => {
  const { adapter } = nativeDouble();
  assert.throws(() => createProviderRegistry({ adapter }), /cannot register provider adapters/u);
  assert.throws(() => createProviderRegistry({ llm: {}, adapter }), /cannot register provider adapters/u);
  assert.throws(() => createProviderRegistry({ llm: { registerAdapter() {} }, adapter: null }), /adapter is required/u);
  assert.throws(
    () => createProviderRegistry({ llm: { registerAdapter() {} }, adapter, routeIdFor: 'nope' }),
    /routeIdFor must be a function/u,
  );
});

test('a runtime that returns no disposer is refused instead of half-registered', async () => {
  const llm = { registerAdapter: () => undefined, listProviders: () => [] };
  const { adapter } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  await assert.rejects(() => registry.ensure(['a']), /returned no adapter disposer/u);
});

test('a runtime that cannot enumerate its routes is refused rather than silently assumed unowned', async () => {
  // The ownership baseline is not optional: without it this module cannot tell a
  // free route from one another registration holds, and would publish a snapshot
  // the core then refuses.
  const llm = {
    registerAdapter() { throw new Error('must not be reached'); },
    listProviders() { throw new Error('unsupported operation: listProviders'); },
  };
  const { adapter } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  await assert.rejects(
    () => registry.ensure(['a']),
    /cannot list its registered provider routes/u,
  );
});

test('dispose releases the native registration once and refuses later ensures', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  serve(state, [{ route: ROUTE('a'), name: 'A' }]);

  await registry.ensure(['a']);
  registry.dispose();
  registry.dispose();

  assert.equal(state.disposed, 1, 'dispose must be idempotent');
  assert.equal(state.registered.size, 0, 'the native route must actually be released');
  await assert.rejects(() => registry.ensure(['a']), /has been disposed/u);

  const unused = createProviderRegistry({ llm, adapter });
  unused.dispose();
  assert.equal(state.disposed, 1, 'disposing an unregistered registry must not touch the core');
});

test('ensure satisfies the engine contract shape', async () => {
  const { llm, adapter, state } = nativeDouble();
  const registry = createProviderRegistry({ llm, adapter });
  serve(state, [{ route: ROUTE('worker'), name: 'Worker' }]);

  const ensured = await registry.ensure([{ id: 'worker' }]);
  assert.equal(typeof ensured, 'object');
  assert.ok(ensured.routes instanceof Map);
  assert.equal(ensured.routes.get('worker'), ROUTE('worker'));
  assert.equal(typeof registry.dispose, 'function');
});
