/**
 * Native provider route registration.
 *
 * Maps the operator-facing provider profile ids from one settings snapshot to
 * namespaced native route ids owned by a single adapter registration on the
 * installed `@deepseek-ai/dsh-llm` runtime.
 *
 * Contract used by `JobEngine.ensureRoutes()` (`src/jobs/engine.js`):
 * `await registry.ensure(providers)` resolves to `{ routes: Map<publicId, nativeRouteId> }`.
 * The returned Map is a fresh snapshot per call, so a job that keeps one cannot
 * observe or corrupt a later ensure.
 *
 * Lifecycle, per the real `LlmRuntime.registerAdapter(providers, adapter)` API:
 * - the first non-empty provider list registers the adapter once;
 * - later ensures swap the whole route set through the disposer's
 *   `replace(providers)` (atomic in the core, and legal with an empty list);
 * - `dispose()` releases the registration and is idempotent.
 *
 * Two constraints of that API are load-bearing here and are enforced rather than
 * assumed:
 *
 *  1. The registered object must be the adapter itself. `registerAdapter(ids,
 *     facade)` would store a management object whose `providerInfo` may exist
 *     but whose `stream`/`prepareCall` never do, so every call on those routes
 *     would fail with "no adapter registered" even though registration
 *     "succeeded". {@link nativeAdapterOf} unwraps a facade when one is passed,
 *     and refuses anything that has no call path at all.
 *  2. `prepareRoutes()` reads `adapter.providerInfo(id)` synchronously before it
 *     commits, so whatever snapshot the adapter serves at registration time is
 *     the one that names those routes. {@link createProviderRegistry} therefore
 *     exposes `register()` as a callback: the caller publishes the candidate
 *     snapshot, then registers, and only that order lets `prepareRoutes` see the
 *     configured display names instead of the route id placeholder.
 *
 * Both halves of the native side are synchronous — `LlmRuntime.registerAdapter()`
 * and its `replace()` run `prepareRoutes()` + `commitRoutes()` inside one call,
 * and `PiAiAdapter.providerInfo()` answers from a plain field on the current
 * snapshot — so the whole transaction can be synchronous. That is load bearing,
 * not incidental:
 *
 *   * the candidate snapshot is published, the native registration runs, and a
 *     refusal rolls the snapshot back **all inside one non-awaiting section**, so
 *     no second ensure, and no native observer, can ever look between the two
 *     sides and find the adapter serving a generation the core did not accept;
 *   * the caller's callback never yields. {@link commitCandidate} calls it and
 *     rejects its result if it is thenable. An `async` callback would open exactly
 *     that window: the native registration would run in a later microtask, after
 *     `register()` had already resolved to a mapping nobody registered.
 *
 * Adapter construction stays outside this module: this file only owns the
 * native registration lifecycle. Every candidate set is validated before the
 * core is touched, so a refused ensure leaves the live registration untouched.
 *
 * **One configuration per process, while a task pins it.** The adapter serves the
 * *latest* generation the registry committed (`profiles: () => current.profiles`
 * on every native model operation), and a later `register`/`ensure` with a
 * different provider list swaps that generation in place. A running task keeps
 * using its frozen route id, so without a lease its *next* native model
 * operation would silently reach a different endpoint or model than the one its
 * immutable effective configuration names. {@link createProviderRegistry}
 * therefore keeps a process-local *lease* of the provider-definition set:
 *
 *  - a lease is one canonical fingerprint of every *plugin-managed* definition
 *    that can affect a later model operation (provider id, display name, protocol,
 *    endpoint, credential *reference*, and each model's id, declared efforts and
 *    context window) — never a value, never a secret. Native DSH references are
 *    excluded on both sides ({@link managedProvidersOf}), because this plugin
 *    registers no route for them and the core's copy of such a route is not part
 *    of the generation the lease protects;
 *  - {@link registry.ensure} and {@link registry.register} take the lease for
 *    their own set, and refuse a *different* set while another lease is held, with
 *    the stable code `PROVIDER_SET_BUSY`, before the adapter is asked to publish
 *    anything and before the core is touched;
 *  - an identical set is always allowed: `leases` counts holders, so concurrent
 *    jobs on one configuration and concurrent ensures of one snapshot proceed;
 *  - the engine takes its lease synchronously *before* it awaits the route ensure
 *    and releases it only from its own finalize, after the native executor is
 *    confirmed stopped — so a settings change saved during a run is stored
 *    normally (the settings service is a different authority), and becomes usable
 *    as soon as the running tasks drain. There is no queue, no retry and no
 *    substitution: the refused candidate simply did not apply.
 */

/** Namespace prefix that keeps native route ids separate from public profile ids. */
const ROUTE_NAMESPACE = 'dsh-delegate';

/**
 * The provider `source` that marks a profile DSH already routes itself.
 *
 * A native profile is a *reference* to a route the harness owns: this plugin must
 * never register one (`src/index.js` only maps it onto the DSH route id of the
 * same name), and it must not fingerprint one either — which is why the lease and
 * the route registration share {@link managedProvidersOf} instead of each
 * filtering `source` on its own.
 */
const NATIVE_PROVIDER_SOURCE = 'native';

/**
 * The provider profiles this plugin owns a route for, i.e. everything that is not
 * a native DSH reference.
 *
 * One function for both halves of the provider contract, on purpose. The engine
 * takes its long-lived lease over the *plugin-managed* set and `ensureRoutes()`
 * registers exactly that same set, so the lease fingerprint and the registered
 * (adapter-visible) candidate are two readings of one list. Filtering them
 * differently is what made a native-only configuration lease `[workbuddy]` while
 * its own route ensure registered `[]`: same task, one holder, two fingerprints,
 * and the second call refused its own lease with `PROVIDER_SET_BUSY` (0 routes)
 * before any second task existed.
 *
 * Order is preserved: the adapter publishes the list in the order it is given, so
 * a reordering must stay visible to the fingerprint. The entries are returned as
 * they are — this is a projection, not a copy or a validation step.
 * @param {unknown} providers - candidate provider list, typically `settings.providers`.
 * @returns {object[]} the plugin-managed subset, in declared order.
 */
export function managedProvidersOf(providers) {
  const list = Array.isArray(providers) ? providers : [];
  return list.filter((provider) => provider?.source !== NATIVE_PROVIDER_SOURCE);
}

/**
 * The provider profiles DSH routes natively, i.e. the complement of
 * {@link managedProvidersOf} over the same list.
 *
 * Offered so the entry point and any diagnostic count both halves with the same
 * rule; nothing here registers these routes.
 * @param {unknown} providers - candidate provider list.
 * @returns {object[]} the native subset, in declared order.
 */
export function nativeProvidersOf(providers) {
  const list = Array.isArray(providers) ? providers : [];
  return list.filter((provider) => provider?.source === NATIVE_PROVIDER_SOURCE);
}

/** Error code surfaced to the engine's routing diagnostics. */
const ERROR_CODE = 'provider_registry';

/**
 * Stable code of a refusal caused by a lease another party holds.
 *
 * Distinct from {@link ERROR_CODE} on purpose: "another task is running on a
 * different provider configuration" is an operator-visible state that resolves by
 * itself, not a registry failure, and callers must be able to tell the two apart
 * without matching a message.
 */
export const PROVIDER_SET_CODES = Object.freeze({ busy: 'PROVIDER_SET_BUSY' });

/**
 * Build one registry error.
 * @param {string} message - operator-facing diagnostic.
 * @returns {Error} error carrying this module's code.
 */
function registryError(message) {
  const error = new Error(message);
  error.code = ERROR_CODE;
  return error;
}

/**
 * Read the public provider id from one settings entry.
 *
 * A settings snapshot may carry either bare ids or provider records; both are
 * accepted so the registry does not depend on the settings module's shape.
 * @param {unknown} entry - one element of the provider list.
 * @returns {string} public provider id.
 */
function publicProviderId(entry) {
  const id = typeof entry === 'string' ? entry : entry?.id;
  if (typeof id !== 'string' || id === '') {
    throw registryError('every provider entry must be a non-empty id');
  }
  return id;
}

/**
 * Default native route id for one public provider id.
 * @param {string} publicId - validated public provider id.
 * @returns {string} namespaced native route id, distinct from the public id.
 */
function defaultRouteId(publicId) {
  return `${ROUTE_NAMESPACE}:${publicId}`;
}

/**
 * The object that may be handed to `LlmRuntime.registerAdapter()`.
 *
 * A plugin that builds its adapter behind a management facade has two objects
 * per adapter: the facade (`replace`, `snapshot`, …) and the native instance it
 * serves. Only the second one is registrable — the core asks it for
 * `providerInfo`/`providerRetryPolicy` and later for `prepareCall`/`stream`.
 * Accepting either shape here, while refusing an object with no call path,
 * turns that mix-up from a runtime "no adapter registered" on every request
 * into an error at the moment the registry is built.
 * @param {unknown} adapter - native adapter, or a facade exposing `nativeAdapter()`/`getAdapter()`.
 * @returns {object} the native adapter instance.
 */
export function nativeAdapterOf(adapter) {
  if (adapter !== null && typeof adapter === 'object' && typeof adapter.stream === 'function') {
    return adapter;
  }
  const unwrap = adapter !== null && typeof adapter === 'object'
    ? (typeof adapter.nativeAdapter === 'function' ? adapter.nativeAdapter : adapter.getAdapter)
    : undefined;
  if (typeof unwrap !== 'function') {
    throw registryError('a native provider adapter is required');
  }
  // Called on the facade as receiver so an unwrapper implemented as a method
  // that reads `this` still works; the facade's own getters are plain closures.
  const native = unwrap.call(adapter);
  if (native === null || typeof native !== 'object' || typeof native.stream !== 'function') {
    throw registryError('the adapter facade does not expose a native adapter that can stream');
  }
  if (typeof native.providerInfo !== 'function') {
    throw registryError('the native adapter cannot describe its provider routes');
  }
  return native;
}

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped.
 *
 * The fingerprint below must be *deterministic* across two readings of one
 * configuration, so it cannot depend on key insertion order, and it must not
 * change because a field is absent rather than empty. Arrays keep their order:
 * a reordered model list is a different served generation, and the adapter
 * publishes it as one.
 * @param {unknown} value - JSON-compatible value.
 * @returns {string} canonical JSON text.
 */
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Read one scalar as a string, or `null` when it is absent.
 * @param {unknown} value - candidate.
 * @returns {string | null} the value or null.
 */
function scalarOrNull(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * The canonical form of one provider definition, as far as a later model call
 * can observe it.
 *
 * Everything the adapter copies into the served generation is here: the route
 * (derived from the id), the endpoint, the credential *reference* (a name, never
 * a value), the protocol, and per model the id, the display name, the declared
 * effort axis and the context window — which is what a request's budget and
 * effort selectability are computed from. It is deliberately *not* a hash: a
 * collision has to be impossible, and the assembled text is retained in memory
 * only, never written, logged or returned.
 *
 * A provider that is not a record is fingerprinted by its id alone, so a caller
 * that passes bare ids still gets a lease.
 * @param {unknown} entry - one provider of a settings snapshot.
 * @param {(publicId: string) => string} deriveRouteId - native route id derivation.
 * @returns {object} canonical definition.
 */
function providerDefinition(entry, deriveRouteId) {
  const publicId = publicProviderId(entry);
  const route = deriveRouteId(publicId);
  if (entry === null || typeof entry !== 'object') {
    return { id: publicId, route };
  }
  const models = Array.isArray(entry.models) ? entry.models : [];
  return {
    id: publicId,
    route,
    name: scalarOrNull(entry.name),
    protocol: scalarOrNull(entry.protocol),
    baseUrl: scalarOrNull(entry.baseUrl),
    credentialRef: scalarOrNull(entry.credentialRef),
    models: models.map((model) => ({
      id: scalarOrNull(model?.id),
      name: scalarOrNull(model?.name),
      efforts: Array.isArray(model?.efforts) ? model.efforts.map((effort) => scalarOrNull(effort)) : null,
      contextWindow: typeof model?.contextWindow === 'number' && Number.isFinite(model.contextWindow)
        ? model.contextWindow
        : null,
    })),
  };
}

/**
 * Canonical fingerprint of a whole provider-definition set.
 *
 * Two readings of one configuration produce the same text, and any change a later
 * model operation could observe produces a different one. The set is sorted by
 * public provider id for the digest, while the *lease* itself keeps the declared
 * order, because order is what the adapter publishes.
 * @param {object[]} definitions - from {@link providerDefinition}, in declared order.
 * @returns {string} fingerprint.
 */
function fingerprintOf(definitions) {
  const sorted = [...definitions].sort((a, b) => (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));
  return canonicalJson(sorted);
}

/**
 * Create the native route registry for one adapter instance.
 * @param {object} options - registry dependencies.
 * @param {object} options.llm - native llm runtime exposing `registerAdapter`.
 * @param {object} options.adapter - already-constructed native adapter, or the
 *   management facade that wraps one ({@link nativeAdapterOf} unwraps it).
 * @param {(publicId: string) => string} [options.routeIdFor] - native route id derivation.
 * @returns {{
 *   ensure: (providers: unknown) => Promise<{ routes: Map<string, string> }>,
 *   register: (providers: unknown, commit: (routes: Map<string, string>) => unknown) => Promise<{ routes: Map<string, string> }>,
 *   lease: (providers: unknown, holder?: string) => object,
 *   release: (lease: object) => boolean,
 *   heldLease: () => { count: number, holders: string[], fingerprint: string } | null,
 *   commitRoutes: (routes: Map<string, string>) => void,
 *   nativeAdapter: () => object,
 *   dispose: () => void,
 * }} registry.
 */
export function createProviderRegistry(options) {
  const { llm, routeIdFor } = options ?? {};
  if (llm === null || typeof llm !== 'object' || typeof llm.registerAdapter !== 'function') {
    throw registryError('the native llm runtime cannot register provider adapters');
  }
  const adapter = nativeAdapterOf(options?.adapter);
  if (routeIdFor !== undefined && typeof routeIdFor !== 'function') {
    throw registryError('routeIdFor must be a function');
  }
  const deriveRouteId = routeIdFor ?? defaultRouteId;
  let handle = null;
  let disposed = false;
  /**
   * The process-local provider-definition lease, or `null` when no set is pinned.
   *
   * One fingerprint, a holder count and the holder labels. Counting (rather than
   * storing one owner) is what lets several tasks share one configuration while a
   * *different* one is refused; see the module comment.
   * @type {{ fingerprint: string, count: number, holders: string[] } | null}
   */
  let held = null;
  /**
   * Holders of the lease this registry handed out, so every release is exact and
   * a second release of one lease is a no-op rather than somebody else's.
   * @type {WeakSet<object>}
   */
  const issued = new WeakSet();
  /**
   * Native routes owned by *other* registrations, captured before this registry
   * registered anything.
   *
   * `LlmRuntime.listProviders()` lists every route in the runtime, not this
   * adapter's. Ownership therefore has to be read relative to this baseline: a
   * route present here belongs to somebody else (refuse it), and a route absent
   * here that this registration has not adopted belongs to nobody (the core will
   * refuse it — the adapter must not publish it first).
   * @type {Set<string> | null}
   */
  let foreignRoutes = null;

  /**
   * Freeze the foreign-route baseline, once, before this registry registers.
   * @returns {Error | null} a refusal when the runtime cannot report its routes.
   */
  function captureForeignRoutes() {
    if (foreignRoutes !== null) return null;
    try {
      foreignRoutes = new Set(llm.listProviders().map((entry) => entry.id));
    } catch {
      // Silence is unsafe here: without a second opinion this module cannot prove
      // the candidate does not claim a route another owner registered.
      return registryError('the native llm runtime cannot list its registered provider routes');
    }
    return null;
  }

  /**
   * Why one candidate may not be committed to the native core.
   *
   * On a first registration this is the `DUPLICATE_ADAPTER` the core would raise;
   * on a replace it is the `DUPLICATE_ADAPTER` or `INVALID_ADAPTER` the core would
   * raise. Either way the point is the same: refuse *before* the adapter publishes
   * a route set the core is going to reject.
   * @param {Map<string, string>} routes - validated candidate mapping.
   * @returns {Error | null} the refusal, or `null` when the candidate is legal.
   */
  function ownershipRefusal(routes) {
    const refusal = captureForeignRoutes();
    if (refusal !== null) return refusal;
    for (const [publicId, nativeId] of routes) {
      // A route another registration owns makes `registerAdapter()`/`replace()`
      // throw `DUPLICATE_ADAPTER` — after the caller had already published a
      // snapshot serving it. One this registration has not adopted and nobody owns
      // is not registered at all, so `replace()` would throw `INVALID_ADAPTER` with
      // the adapter already republished. Both are refused here, before the adapter
      // sees the candidate.
      if (foreignRoutes.has(nativeId)) {
        return registryError(`provider ${publicId} maps to native route ${nativeId}, which another adapter registration already owns`);
      }
    }
    return null;
  }

  /**
   * Validate one candidate provider list and derive its route mapping.
   * Pure: nothing is registered here, so a refusal cannot mutate the core.
   * @param {unknown} providers - candidate provider list.
   * @returns {Map<string, string>} public id -> native route id, in input order.
   */
  function plan(providers) {
    if (!Array.isArray(providers)) throw registryError('the provider list must be an array');
    const routes = new Map();
    const nativeIds = new Set();
    for (const entry of providers) {
      const publicId = publicProviderId(entry);
      if (routes.has(publicId)) {
        throw registryError(`provider ${publicId} is listed more than once`);
      }
      const nativeId = deriveRouteId(publicId);
      if (typeof nativeId !== 'string' || nativeId === '') {
        throw registryError(`provider ${publicId} has no usable native route id`);
      }
      if (nativeIds.has(nativeId)) {
        throw registryError(`provider ${publicId} collides on native route id ${nativeId}`);
      }
      nativeIds.add(nativeId);
      routes.set(publicId, nativeId);
    }
    return routes;
  }

  /**
   * Commit one validated route set to the native core.
   *
   * The first call registers; later calls replace the whole set. The registration
   * handle is only kept once the core returned one, so a thrown registration
   * leaves this module in the state it was in before the attempt. Synchronous:
   * the core validates and commits inside the call.
   * @param {Map<string, string>} routes - validated public -> native mapping.
   * @returns {void}
   */
  function commitRoutes(routes) {
    const nativeIds = [...routes.values()];
    if (handle === null) {
      // The baseline is taken before this registration exists, so it holds only
      // other owners' routes. If the caller already refused a candidate, this is a
      // no-op; if it did not run, this is the first and only chance to take it.
      const refusal = captureForeignRoutes();
      if (refusal !== null) throw refusal;
      /**
       * The native handle is the disposer plus `replace()`; a runtime that
       * returns anything else cannot be kept consistent by this module.
       */
      const registered = llm.registerAdapter(nativeIds, adapter);
      if (typeof registered !== 'function') {
        throw registryError('the native llm runtime returned no adapter disposer');
      }
      handle = registered;
      return;
    }
    // Atomic in the core: a rejected candidate throws and keeps the live routes.
    handle.replace(nativeIds);
  }

  /**
   * Decide what one candidate needs: a native commit, or nothing at all.
   * @param {Map<string, string>} routes - validated candidate mapping.
   * @returns {boolean} whether the native core has to be touched.
   */
  function changesNativeState(routes) {
    // An empty first list establishes nothing; the core refuses an empty initial
    // registration, and a later non-empty list registers lazily.
    return handle !== null || routes.size > 0;
  }

  /**
   * Validate one candidate provider list into its canonical definition set.
   * @param {unknown} providers - candidate provider list.
   * @returns {{ routes: Map<string, string>, fingerprint: string }} plan plus its fingerprint.
   */
  function describe(providers) {
    const routes = plan(providers);
    const fingerprint = fingerprintOf([...providers].map((entry) => providerDefinition(entry, deriveRouteId)));
    return { routes, fingerprint };
  }

  /**
   * The refusal a different provider set would receive right now, or `null`.
   *
   * This is the whole admission rule: an equal set always shares the lease, and a
   * different one is refused while anybody holds it. It deliberately names no
   * endpoint and no credential reference — only that a configuration is pinned and
   * by whom — because it is reported to a caller who may not be the holder.
   * @param {string} fingerprint - candidate set.
   * @param {number} routeCount - size of the candidate mapping, for the message.
   * @returns {Error | null} refusal carrying {@link PROVIDER_SET_CODES.busy}.
   */
  function leaseRefusal(fingerprint, routeCount) {
    if (held === null || held.fingerprint === fingerprint) return null;
    const error = registryError(
      `another task is running on a different provider configuration (${held.count} lease holder(s)); `
      + `this ${routeCount} provider set may not be applied until it finishes`,
    );
    error.code = PROVIDER_SET_CODES.busy;
    error.details = {
      code: PROVIDER_SET_CODES.busy,
      heldBy: held.count,
      // Labels are generated by this module or by the caller and never contain a
      // provider id, an endpoint or a credential reference.
      holders: held.holders.slice(0, 8),
    };
    return error;
  }

  /**
   * Take the provider-definition lease for one already-described set.
   *
   * Synchronous on purpose: the engine calls this in the same step that freezes
   * its task's route set, before it awaits anything, so there is no window in
   * which the set it is about to use could have been swapped by somebody else.
   * @param {string} fingerprint - candidate set.
   * @param {number} routeCount - size of the candidate mapping.
   * @param {string} holder - bounded label for diagnostics.
   * @returns {void}
   * @throws {Error} the busy refusal when another set is pinned.
   */
  function acquire(fingerprint, routeCount, holder) {
    const refusal = leaseRefusal(fingerprint, routeCount);
    if (refusal !== null) throw refusal;
    if (held === null) held = { fingerprint, count: 0, holders: [] };
    held.count += 1;
    if (holder !== '') held.holders.push(holder);
  }

  /**
   * Give one holder's lease back.
   *
   * `register`/`ensure` take their lease for the duration of their own call and
   * hand it back the same way; a lease object taken through `lease()` is released
   * once and never again, so it cannot drain another holder's share. A release that
   * leaves nobody holding frees the set, i.e. a different configuration may apply
   * from the next call on.
   * @param {string} fingerprint - the set being released.
   * @param {string} holder - the label to remove.
   * @returns {void}
   */
  function giveBack(fingerprint, holder) {
    if (held === null || held.fingerprint !== fingerprint) return;
    held.count -= 1;
    const index = held.holders.lastIndexOf(holder);
    if (index >= 0) held.holders.splice(index, 1);
    if (held.count <= 0) held = null;
  }

  /**
   * Take the lease for one provider set and hand back a releasable lease object.
   *
   * The object is the only thing a caller may release; releasing it twice is a
   * no-op, and releasing a lease the registry never issued is refused, so one
   * task cannot drain another's hold.
   * @param {unknown} providers - provider list from one settings snapshot.
   * @param {string} [holder] - bounded diagnostic label (a task id, an operation).
   * @returns {{ kind: string, fingerprint: string, holder: string, released: boolean }} lease.
   */
  function lease(providers, holder) {
    if (disposed) throw registryError('the provider registry has been disposed');
    const described = describe(providers);
    const label = typeof holder === 'string' && holder !== '' ? holder.slice(0, 120) : '';
    acquire(described.fingerprint, described.routes.size, label);
    const record = { kind: 'provider-definition-lease', fingerprint: described.fingerprint, holder: label, released: false };
    issued.add(record);
    return record;
  }

  /**
   * Release one lease handed out by {@link lease}.
   * @param {unknown} record - lease object.
   * @returns {boolean} true when this call released it.
   */
  function release(record) {
    if (record === null || typeof record !== 'object' || !issued.has(record)) return false;
    if (record.released === true) return false;
    record.released = true;
    giveBack(record.fingerprint, record.holder);
    return true;
  }

  /**
   * Describe the lease currently held, for diagnostics and tests.
   * @returns {{ count: number, holders: string[], fingerprint: string } | null} copy, or null when free.
   */
  function heldLease() {
    if (held === null) return null;
    return { count: held.count, holders: [...held.holders], fingerprint: held.fingerprint };
  }

  /**
   * Ensure the native routes for one provider list.
   *
   * The lease is taken for the duration of this call, which is synchronous apart
   * from its own `async` wrapper, so an ensure of a different set cannot interleave
   * with one already in progress.
   * @param {unknown} providers - provider list from one settings snapshot.
   * @returns {Promise<{ routes: Map<string, string> }>} fresh public -> native mapping.
   */
  async function ensure(providers) {
    if (disposed) throw registryError('the provider registry has been disposed');
    const { routes, fingerprint } = describe(providers);
    acquire(fingerprint, routes.size, 'ensure');
    try {
      if (changesNativeState(routes)) commitRoutes(routes);
    } finally {
      giveBack(fingerprint, 'ensure');
    }
    return { routes: new Map(routes) };
  }

  /**
   * Ensure the native routes for one provider list, letting the caller act
   * between validation and registration.
   *
   * The callback exists because the adapter's serving state has to be in place
   * *before* the core validates the routes: `prepareRoutes()` reads
   * `providerInfo(id)` synchronously and refuses (or mislabels) a route the
   * adapter is not already serving. A caller that must publish a snapshot first
   * uses this. The callback runs after the candidate set is fully validated, its
   * native commit runs from inside it, and nothing in between yields, so an
   * exception from the callback — or from the registration — leaves the native
   * registration exactly as it was, and the callback's own restoration is the last
   * word on the snapshot.
   *
   * The callback receives the routes and performs the *publication* only: it
   * calls the second argument, `commit()`, at the point where the native
   * registration must happen. Anything after that call runs with the candidate
   * already committed, so a callback that yields after it is the one thing this
   * contract cannot take back — which is why the return value is checked and why
   * the handed `commit()` refuses to fire once the callback has yielded.
   *
   * The provider-definition lease is checked here too, *before* the callback runs,
   * so a task pinned to another configuration cannot have this one published
   * underneath it — and the adapter is never asked for a snapshot that the core
   * will then refuse.
   * @param {unknown} providers - provider list from one settings snapshot.
   * @param {(routes: Map<string, string>, commit: () => void) => unknown} commit - runs after validation; must not yield.
   * @returns {Promise<{ routes: Map<string, string> }>} fresh public -> native mapping.
   */
  async function register(providers, commit) {
    if (typeof commit !== 'function') throw registryError('a registration callback is required');
    if (disposed) throw registryError('the provider registry has been disposed');
    const { routes, fingerprint } = describe(providers);
    acquire(fingerprint, routes.size, 'register');
    try {
      if (changesNativeState(routes)) commitCandidate(routes, commit);
      else commit(new Map(), () => {});
    } finally {
      giveBack(fingerprint, 'register');
    }
    return { routes: new Map(routes) };
  }

  /**
   * The transaction: publication, native commit, and nothing awaited.
   *
   * The callback is handed a `commit()` it must call itself, so the native
   * registration runs from inside the callback's own synchronous stack — never
   * before publication, never after a yield. `commit()` and the callback share
   * one guard: once the callback has yielded it cannot commit, and once it has
   * committed the native state is real, so it cannot pull the snapshot out from
   * under a committed registration either.
   *
   * `adapt` is the only party that can restore the snapshot the candidate
   * displaced, so this function never restores anything on its own. Its contract:
   *
   *  1. the candidate set is refused *before* `adapt` runs if it claims a route
   *     another registration owns, so the adapter never publishes a route the
   *     core would reject;
   *  2. `adapt()` must not return a thenable — a promise means the callback
   *     yielded, and the native registration would then land in a microtask this
   *     function has already answered past;
   *  3. whatever `adapt()` throws propagates unchanged, after it has restored the
   *     snapshot state it was given.
   * @param {Map<string, string>} routes - validated candidate mapping.
   * @param {(routes: Map<string, string>, commit: () => void) => unknown} adapt - publish, then commit, synchronously.
   * @returns {void}
   * @throws {Error} the ownership refusal, the contract violation, or the native refusal.
   */
  function commitCandidate(routes, adapt) {
    const refusal = ownershipRefusal(routes);
    if (refusal !== null) throw refusal;
    let open = true;
    let committed = false;
    /**
     * Perform the native commit for this candidate, exactly once.
     * @returns {void}
     * @throws {Error} when called after a yield or a throw.
     */
    const commit = () => {
      if (!open) {
        throw registryError('the registration callback committed outside its own synchronous section');
      }
      if (committed) throw registryError('the registration callback committed the same candidate twice');
      commitRoutes(routes);
      committed = true;
    };
    let outcome;
    try {
      outcome = adapt(new Map(routes), commit);
    } finally {
      // Closed as soon as the callback's synchronous stack unwinds, whichever way
      // it left: a queued continuation can no longer mutate the native registry.
      open = false;
    }
    if (outcome !== null && (typeof outcome === 'object' || typeof outcome === 'function')
      && typeof outcome.then === 'function') {
      // Swallow the loser's rejection: the refusal below is the error that reaches
      // the caller, and an unhandled rejection must not surface from a candidate
      // this module already refused.
      Promise.resolve(outcome).catch(() => {});
      throw registryError('the registration callback must not be asynchronous');
    }
  }

  /**
   * Release the native registration. Idempotent; later ensures are refused.
   *
   * The lease goes with it: a disposed registry can never apply another
   * configuration, so keeping a set pinned would refuse work for no reason. A
   * task that still holds a lease record releases it into a free registry, which
   * is a no-op, so a late finalize after unload cannot resurrect a hold.
   * @returns {void}
   */
  function dispose() {
    if (disposed) return;
    disposed = true;
    held = null;
    const registered = handle;
    handle = null;
    if (registered !== null) registered();
  }

  return {
    ensure,
    register,
    lease,
    release,
    heldLease,
    commitRoutes,
    nativeAdapter: () => adapter,
    dispose,
  };
}
