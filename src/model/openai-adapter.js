// Native OpenAI-compatible (Chat Completions) provider adapter.
//
// This module is the plugin-owned bridge between the validated settings shape
// (`provider { id, name, protocol:'openai-chat', baseUrl, credentialRef,
// models:[{ id, name, efforts }] }`) and the installed DSH pi-ai adapter
// (`@deepseek-ai/dsh-llm-pi-ai`), which owns request conversion and SSE parsing.
// Nothing here parses HTTP or SSE: the proven pi-ai streaming APIs do that, and
// this file only decides *which* route, model, effort and credential one request
// may use.
//
// Three invariants shape the code:
//
//  1. **One immutable snapshot per operation.** `replaceProfiles()` builds a
//     brand-new provider collection and swaps it in whole. The adapter reads the
//     current snapshot once per operation, so a settings change reaches the next
//     request and never the one already in flight.
//  2. **The snapshot exists before the harness reads it.** Native route
//     registration is not lazy: `LlmRuntime.prepareRoutes()` calls
//     `adapter.providerInfo()` / `adapter.providerRetryPolicy()` *synchronously*
//     while validating a candidate route set, and `PiAiAdapter.providerInfo()`
//     answers from the snapshot it currently serves (`this.current().profiles`).
//     A route that is not already in the served snapshot therefore either throws
//     inside registration or resolves to the placeholder display name. The
//     registration order in the entry point is derived from that fact: prime the
//     snapshot, validate the routes against the real adapter, then register — all
//     of it synchronously, through `prepareRoutes()` and the registry's
//     `commitRoutes()`, so no caller can observe the two sides apart.
//  3. **No ambient auth, ever.** A route's configured `credentialRef` is resolved
//     through the injected DSH credential service, once per request, and rides to
//     pi-ai as the request-level `apiKey` override. A reference that resolves to
//     nothing fails with `MISSING_CREDENTIAL` before any network I/O; the pi-ai
//     auth context this adapter injects can answer neither `env()` nor
//     `fileExists()`, so pi-ai can never fall back to the process environment or
//     a credential file on its own. The value is never logged, stored on a
//     profile, or copied into an error.

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import { KNOWN_EFFORTS } from '../config/defaults.js';

/**
 * DSH settings protocol id -> pi-ai API id.
 *
 * Only `openai-chat` is served by this slice; it is the one protocol the settings
 * validator accepts (`SUPPORTED_PROTOCOLS` in `src/config/defaults.js`) and the
 * one pi-ai implements as `openai-completions`.
 */
const PROTOCOL_API = Object.freeze({ 'openai-chat': 'openai-completions' });

/** Protocols this adapter can serve, in declaration order. */
export const SUPPORTED_PROTOCOLS = Object.freeze(Object.keys(PROTOCOL_API));

/**
 * Reasoning ids pi-ai maps through `Model.thinkingLevelMap`.
 *
 * `off` is handled separately in `buildModel`: pi-ai's absence default already
 * means "no reasoning level sent", and writing `off: null` would instead mark it
 * unsupported and make a declared `off` unselectable.
 */
const MAPPED_EFFORTS = Object.freeze(KNOWN_EFFORTS.filter((id) => id !== 'off'));

/** Stable failure codes. `MISSING_CREDENTIAL` matches the native seam's code. */
export const ERROR_CODES = Object.freeze({
  missingCredential: 'MISSING_CREDENTIAL',
  credentialUnavailable: 'CREDENTIAL_UNAVAILABLE',
  credentialServiceUnavailable: 'CREDENTIAL_SERVICE_UNAVAILABLE',
  protocolUnsupported: 'PROTOCOL_UNSUPPORTED',
  invalidSnapshot: 'INVALID_SNAPSHOT',
});

/**
 * pi-ai defaults for a model the settings document does not size.
 * Mirrors `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS` in
 * `@deepseek-ai/dsh-llm-pi-ai`'s configuration module, which is not a root export.
 */
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;

/** Request-level image bounds from the same module's defaults. Inert while `input` is text-only. */
const IMAGE_DEFAULTS = Object.freeze({
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
});

/** Default provider-idle bound while one stream read is outstanding (pi-ai adapter default). */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;

/** An empty snapshot: the dormant posture before any profile is supplied. */
const EMPTY_SNAPSHOT = Object.freeze({
  profiles: new Map(),
  routes: new Map(),
  providerIds: Object.freeze([]),
});

/**
 * Build one adapter failure.
 * @param {string} code - stable machine code.
 * @param {string} message - operator-facing explanation; never carries a secret.
 * @param {object} [details] - bounded, non-secret context.
 * @returns {Error & { code: string, details: object }} the failure.
 */
function adapterError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'OpenAiAdapterError';
  error.code = code;
  error.details = details;
  return error;
}

/**
 * Read one required, non-empty string.
 * @param {unknown} value - candidate.
 * @param {string} field - field name for the diagnostic.
 * @param {object} details - context for the failure.
 * @returns {string} the value.
 */
function requireName(value, field, details) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw adapterError(ERROR_CODES.invalidSnapshot, `${field} must be a non-empty string`, details);
  }
  return value;
}

/**
 * Build one pi-ai model declaration from one settings model entry.
 *
 * The model id is preserved verbatim — it is the exact string the endpoint
 * receives — and the effort axis is exactly the declared one: every undeclared
 * level is mapped to `null` (pi-ai's "unsupported"), so nothing the operator did
 * not declare is ever offered or sent.
 * @param {string} route - native route id that owns the model.
 * @param {string} baseUrl - endpoint of the route.
 * @param {object} declaration - validated settings model entry.
 * @returns {object} pi-ai `Model` declaration.
 */
function buildModel(route, baseUrl, declaration) {
  const id = requireName(declaration?.id, 'model.id', { route });
  const name = typeof declaration.name === 'string' && declaration.name !== '' ? declaration.name : id;
  const rawEfforts = declaration.efforts ?? [];
  if (!Array.isArray(rawEfforts)) {
    throw adapterError(ERROR_CODES.invalidSnapshot, `model ${id} declares efforts that are not a list`, { route, model: id });
  }
  const declared = new Set();
  for (const effort of rawEfforts) {
    if (!KNOWN_EFFORTS.includes(effort)) {
      throw adapterError(ERROR_CODES.invalidSnapshot, `model ${id} declares unsupported reasoning effort ${JSON.stringify(effort)}`, {
        route,
        model: id,
        supported: [...KNOWN_EFFORTS],
      });
    }
    declared.add(effort);
  }
  const thinkingLevelMap = {};
  let selectable = 0;
  for (const effort of MAPPED_EFFORTS) {
    // Identity mapping: the settings id IS the wire spelling, because the
    // validated settings shape carries no per-effort wire alias. `null` marks a
    // level pi-ai must refuse, which is exactly "not declared by this model".
    const offered = declared.has(effort);
    thinkingLevelMap[effort] = offered ? effort : null;
    if (offered) selectable += 1;
  }
  if (declared.has('off')) {
    // Declared `off` keeps pi-ai's default absence semantics: the level is
    // selectable and sends no reasoning parameter. Assigning `off` a mapping
    // here would either send a literal effort string or mark it unsupported.
    selectable += 1;
  }

  const contextWindow = Number.isInteger(declaration.contextWindow) ? declaration.contextWindow : DEFAULT_CONTEXT_WINDOW;
  const model = {
    id,
    name,
    api: PROTOCOL_API['openai-chat'],
    provider: route,
    baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: selectable > 0,
  };
  if (selectable > 0) model.thinkingLevelMap = thinkingLevelMap;
  return model;
}

/**
 * Build the pi-ai provider for one route.
 *
 * The provider's own `apiKey.resolve` reports "configured, no ambient key": the
 * only credential this provider ever sees is the request-level `apiKey` the
 * adapter resolves from the injected DSH service. It deliberately never reads
 * `ctx.env` or `ctx.fileExists`.
 * @param {object} spec - `{ route, name, baseUrl, models }`.
 * @returns {object} pi-ai `Provider`.
 */
function buildProvider(spec) {
  return createProvider({
    id: spec.route,
    name: spec.name,
    baseUrl: spec.baseUrl,
    models: spec.models,
    api: openAICompletionsApi(),
    auth: {
      apiKey: {
        name: `${spec.name} credential`,
        resolve: () => Promise.resolve({ auth: {}, source: 'dsh-delegate' }),
      },
    },
  });
}

/**
 * Normalize the route map that accompanies one snapshot.
 * @param {unknown} routes - `Map` (or pairs) of public provider id -> native route id.
 * @returns {Map<string, string>} a private copy.
 */
function readRoutes(routes) {
  if (routes instanceof Map) return new Map(routes);
  if (Array.isArray(routes)) return new Map(routes);
  throw adapterError(ERROR_CODES.invalidSnapshot, 'the snapshot must carry a map from public provider id to native route id');
}

/**
 * Build one immutable snapshot from a validated provider list plus its route map.
 *
 * Every check runs before anything is published, so a refused snapshot leaves the
 * serving snapshot untouched.
 * @param {object} input - `{ providers, routes }`.
 * @returns {{ profiles: Map<string, object>, routes: Map<string, string>, providerIds: readonly string[] }} snapshot.
 */
function buildSnapshot(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw adapterError(ERROR_CODES.invalidSnapshot, 'a provider snapshot must be an object');
  }
  if (!Array.isArray(input.providers)) {
    throw adapterError(ERROR_CODES.invalidSnapshot, 'a provider snapshot must carry a provider list');
  }
  const routeMap = readRoutes(input.routes);
  const profiles = new Map();
  const providerIds = [];
  const claimedRoutes = new Map();

  for (const provider of input.providers) {
    const publicId = requireName(provider?.id, 'provider.id', {});
    if (providerIds.includes(publicId)) {
      throw adapterError(ERROR_CODES.invalidSnapshot, `provider ${publicId} is listed more than once`, { provider: publicId });
    }
    const protocol = provider.protocol ?? 'openai-chat';
    if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
      throw adapterError(ERROR_CODES.protocolUnsupported, `provider ${publicId} speaks unsupported protocol ${JSON.stringify(protocol)}`, {
        provider: publicId,
        supported: [...SUPPORTED_PROTOCOLS],
      });
    }
    const route = routeMap.get(publicId);
    if (typeof route !== 'string' || route === '') {
      // Guessing the route would be exactly the hidden substitution this plugin
      // refuses; a provider the registry did not map is not served.
      throw adapterError(ERROR_CODES.invalidSnapshot, `provider ${publicId} has no native route in this snapshot`, {
        provider: publicId,
        routes: [...routeMap.keys()].slice(0, 32),
      });
    }
    const owner = claimedRoutes.get(route);
    if (owner !== undefined) {
      throw adapterError(ERROR_CODES.invalidSnapshot, `native route ${route} is claimed by both ${owner} and ${publicId}`, {
        route,
        providers: [owner, publicId],
      });
    }
    claimedRoutes.set(route, publicId);

    const name = typeof provider.name === 'string' && provider.name !== '' ? provider.name : publicId;
    const baseUrl = requireName(provider.baseUrl, `provider ${publicId}.baseUrl`, { provider: publicId });
    const credentialRef = provider.credentialRef === undefined ? null : provider.credentialRef;
    if (credentialRef !== null && (typeof credentialRef !== 'string' || credentialRef === '')) {
      throw adapterError(ERROR_CODES.invalidSnapshot, `provider ${publicId} carries an unusable credential reference`, { provider: publicId });
    }
    const declarations = provider.models ?? [];
    if (!Array.isArray(declarations)) {
      throw adapterError(ERROR_CODES.invalidSnapshot, `provider ${publicId} carries a model list that is not a list`, { provider: publicId });
    }
    const models = [];
    const seenModels = new Set();
    for (const declaration of declarations) {
      const model = buildModel(route, baseUrl, declaration);
      if (seenModels.has(model.id)) {
        throw adapterError(ERROR_CODES.invalidSnapshot, `provider ${publicId} lists model ${model.id} more than once`, {
          provider: publicId,
          model: model.id,
        });
      }
      seenModels.add(model.id);
      models.push(model);
    }

    profiles.set(route, Object.freeze({
      // Fields `ResolvedPiAiProviderProfile` requires, resolved the way the
      // installed adapter expects to read them.
      provider: route,
      displayName: name,
      api: PROTOCOL_API['openai-chat'],
      baseURL: baseUrl,
      // Only the *reference* travels on the profile. A value never does.
      credentialRef,
      apiKeyEnv: credentialRef ?? undefined,
      piProvider: buildProvider({ route, name, baseUrl, models }),
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      ...IMAGE_DEFAULTS,
      // This slice owns no retry policy and materializes no per-request cap; the
      // entry-point task supplies those at registration time.
      modelErrors: new Map(),
      configuredMaxTokens: new Map(),
    }));
    providerIds.push(publicId);
  }

  return Object.freeze({
    profiles,
    routes: new Map(routeMap),
    providerIds: Object.freeze(providerIds),
  });
}

/**
 * The snapshot a route set would need in order for the *native* adapter to
 * answer for it.
 *
 * Registration reads the adapter, not a plan: `LlmRuntime.prepareRoutes()` asks
 * `providerInfo(route)` for the display name it will store and rejects the whole
 * candidate set unless `info.id === route` and `info.name` is non-empty.
 * `PiAiAdapter` answers from the snapshot it currently serves, falling back to
 * the route id as the display name. So a route that is absent from the served
 * snapshot would register under a placeholder name — or, with any adapter that
 * refuses an unknown route, not register at all — while the plugin believed the
 * operator's configured name had been published. Passing the candidate profiles
 * here is what makes the name the operator sees the name the harness stores.
 * @param {object[]} providers - validated provider list from one settings snapshot.
 * @returns {Map<string, { id: string, name: string }>} display metadata per public id.
 */
export function expectedProviderInfo(providers) {
  if (!Array.isArray(providers)) {
    throw adapterError(ERROR_CODES.invalidSnapshot, 'the provider list must be an array');
  }
  const expected = new Map();
  for (const provider of providers) {
    const publicId = typeof provider?.id === 'string' && provider.id !== ''
      ? provider.id
      : null;
    if (publicId === null || expected.has(publicId)) {
      throw adapterError(ERROR_CODES.invalidSnapshot, 'every provider entry must carry one non-empty id');
    }
    expected.set(publicId, {
      id: publicId,
      name: typeof provider.name === 'string' && provider.name !== '' ? provider.name : publicId,
    });
  }
  return expected;
}

/**
 * Check that one native registration agrees with the snapshot it was built from.
 *
 * Two reads of the same truth are compared here: the adapter's own answer for
 * each route, and the route the plugin believes it registered. A mismatch is a
 * refusal, never a repair, because both possible repairs are substitutions — a
 * display name the operator did not choose, or a route the adapter does not
 * serve. The retry policy is checked too: the harness captures exactly one
 * policy per route, and a route handing it something unvalidated would land
 * outside the native retry vocabulary the rest of the harness assumes.
 * @param {object} reader - `{ providerInfo(route) -> object, providerRetryPolicy(route) -> unknown }`.
 * @param {Map<string, string>} routes - public provider id -> native route id.
 * @param {Map<string, { id: string, name: string }>} expected - from {@link expectedProviderInfo}.
 * @returns {{ route: string, name: string }[]} the verified display metadata, in input order.
 */
export function verifyNativeRoutes(reader, routes, expected) {
  if (reader === null || typeof reader !== 'object'
    || typeof reader.providerInfo !== 'function'
    || typeof reader.providerRetryPolicy !== 'function') {
    throw adapterError(ERROR_CODES.invalidSnapshot, 'the native adapter cannot describe the routes it was given');
  }
  if (!(routes instanceof Map) || !(expected instanceof Map)) {
    throw adapterError(ERROR_CODES.invalidSnapshot, 'routes and expected metadata must both be maps');
  }
  const verified = [];
  for (const [publicId, route] of routes) {
    if (typeof route !== 'string' || route === '') {
      throw adapterError(ERROR_CODES.invalidSnapshot, `provider ${publicId} has no native route`);
    }
    const wanted = expected.get(publicId);
    if (wanted === undefined) {
      throw adapterError(ERROR_CODES.invalidSnapshot, `provider ${publicId} has no expected metadata`);
    }
    const info = reader.providerInfo(route);
    if (info === null || typeof info !== 'object' || info.id !== route
      || typeof info.name !== 'string' || info.name === '') {
      throw adapterError(ERROR_CODES.invalidSnapshot, 'the native adapter does not describe every registered route', {
        provider: publicId,
        route,
        described: info === null || typeof info !== 'object' ? null : { id: info.id ?? null, name: info.name ?? null },
      });
    }
    if (info.name !== wanted.name) {
      // The adapter reads its snapshot, not the candidate: a differing name means
      // the snapshot serving this route is not the one the caller just built, so
      // the registration that follows would publish a name nobody chose.
      throw adapterError(ERROR_CODES.invalidSnapshot, `route ${route} is served from a snapshot that does not match this one`, {
        provider: publicId,
        route,
        expectedName: wanted.name,
        servedName: info.name,
      });
    }
    try {
      // The harness calls this synchronously too, and captures the result; doing
      // it here proves the capture succeeds before any route is published.
      reader.providerRetryPolicy(route);
    } catch (error) {
      throw adapterError(ERROR_CODES.invalidSnapshot, `route ${route} cannot supply a retry policy`, {
        provider: publicId,
        route,
        cause: typeof error?.code === 'string' ? error.code : null,
      });
    }
    verified.push({ route, name: info.name });
  }
  return verified;
}

/**
 * The credential store pi-ai is allowed to consult.
 *
 * This plugin stores no pi-ai-native credential: every route authenticates from
 * the operator's `credentialRef`, resolved per request through the DSH seam and
 * passed as the request-level override. Reading therefore reports "nothing
 * stored" and writing is refused rather than silently mislaid — a write here
 * could only mean the adapter was asked to log in, which this slice does not do.
 * @returns {object} pi-ai `CredentialStore`.
 */
function createInertCredentialStore() {
  return Object.freeze({
    read: () => Promise.resolve(undefined),
    list: () => Promise.resolve([]),
    modify: () => Promise.reject(adapterError(ERROR_CODES.credentialUnavailable,
      'this adapter keeps no pi-ai credential records; configure a credential reference instead')),
    delete: () => Promise.reject(adapterError(ERROR_CODES.credentialUnavailable,
      'this adapter keeps no pi-ai credential records; configure a credential reference instead')),
  });
}

/**
 * The auth context pi-ai is allowed to consult: neither the process environment
 * nor the filesystem, so no ambient fallback can supply a credential.
 * @returns {object} pi-ai `AuthContext`.
 */
function createStrictAuthContext() {
  return Object.freeze({
    env: () => Promise.resolve(undefined),
    fileExists: () => Promise.resolve(false),
  });
}

/**
 * Create the OpenAI-compatible native adapter slice.
 *
 * The returned API is a *management facade* around one stable `PiAiAdapter`
 * instance, and the two halves exist for different consumers:
 *
 *   * `prepareRoutes()` and `replace()` are what the plugin's route registry
 *     calls — building a snapshot and publishing it, with the prepared candidate
 *     handed back so the caller commits or rolls back inside its own synchronous
 *     section;
 *   * the object handed to `LlmRuntime.registerAdapter()` must be the
 *     `PiAiAdapter` itself, never this facade. The harness calls
 *     `providerInfo`/`providerRetryPolicy`/`prepareCall`/`stream` directly on
 *     whatever it was given, so passing the facade registers nothing that can
 *     be streamed from. `nativeAdapter()` is the only sanctioned way to obtain it.
 * @param {object} options - `{ credentials }`, the injected DSH credential service
 *   (`resolve(ref) -> Promise<{ value, source } | undefined>`).
 * @returns {{ prepareRoutes: Function, describes: Function, replace: Function, nativeAdapter: () => object, getAdapter: () => object, snapshot: () => object, expectedProviderInfo: Function }} API.
 */
export function createOpenAiAdapter(options) {
  const credentials = options?.credentials;
  if (credentials === null || typeof credentials !== 'object' || typeof credentials.resolve !== 'function') {
    throw adapterError(ERROR_CODES.credentialServiceUnavailable,
      'the DSH credential service is required to resolve provider credential references');
  }

  let current = EMPTY_SNAPSHOT;

  /**
   * Resolve one route's configured credential reference.
   *
   * Called by the pi-ai adapter once per stream call, before any network I/O, and
   * frozen for that call. A route with no reference is refused rather than served
   * keyless: pi-ai's `openai-completions` implementation demands a key or an
   * explicit Authorization header, and inventing either would be a hidden
   * substitution. The resolved value is returned to pi-ai and nowhere else.
   * @param {string} route - native route id.
   * @param {object} profile - the snapshot profile for that route.
   * @returns {Promise<string>} the credential value.
   */
  async function resolveApiKey(route, profile) {
    const ref = profile?.credentialRef ?? null;
    if (ref === null) {
      throw adapterError(ERROR_CODES.missingCredential,
        `provider route ${route} names no credential reference; configure one before requesting`,
        { provider: route });
    }
    let resolved;
    try {
      resolved = await credentials.resolve(ref);
    } catch (error) {
      // The cause is bounded to its code: a provider may put anything, including
      // the value, in a message.
      throw adapterError(ERROR_CODES.credentialUnavailable,
        `credential ${ref} for provider route ${route} could not be resolved`,
        { provider: route, reference: ref, cause: typeof error?.code === 'string' ? error.code : null });
    }
    const value = typeof resolved?.value === 'string' ? resolved.value : '';
    if (value === '') {
      throw adapterError(ERROR_CODES.missingCredential,
        `credential ${ref} for provider route ${route} is not configured`,
        { provider: route, reference: ref });
    }
    return value;
  }

  const adapter = new PiAiAdapter({
    // One read per operation: the whole snapshot the operation captured stays
    // fixed for as long as that operation holds it.
    profiles: () => current.profiles,
    resolveApiKey,
    auth: {
      credentials: createInertCredentialStore(),
      authContext: createStrictAuthContext(),
    },
  });

  /**
   * Build the snapshot one candidate route set would serve, without publishing it.
   *
   * Every validation runs here, so a caller can prepare the served state and find
   * out it is unusable before anything native observes either side.
   * @param {object} input - `{ providers, routes }` for one validated settings snapshot.
   * @returns {object} frozen snapshot.
   */
  function prepare(input) {
    return buildSnapshot(input);
  }

  /**
   * Replace the served snapshot atomically.
   * @param {object} input - `{ providers, routes }` for one validated settings snapshot.
   * @returns {{ routes: Map<string, string>, providerIds: readonly string[] }} the served route set.
   */
  function replace(input) {
    const next = prepare(input);
    current = next;
    return { routes: new Map(next.routes), providerIds: [...next.providerIds] };
  }

  /**
   * Prepare the snapshot for one route set, publish it, and hand the caller the
   * *only* two operations that may follow: `commit()` and `rollback()`.
   *
   * The order is dictated by the native core, not by preference:
   *
   *  1. `buildSnapshot` validates the candidate provider list (fails: nothing
   *     changed anywhere).
   *  2. The snapshot is published, because `registerAdapter()` — and its
   *     `replace()` — ask `providerInfo(route)` *synchronously* while validating
   *     the routes. Publishing after registration cannot work: the adapter would
   *     still be serving the previous generation when the harness reads it.
   *  3. `verifyNativeRoutes` compares the adapter's answers against the snapshot
   *     that was just published. A disagreement is a refusal that restores the
   *     previous snapshot, so the adapter never keeps serving a generation the
   *     harness did not accept.
   *
   * The native commit is deliberately **not** run here. The caller performs it
   * inside the same synchronous section (`createProviderRegistry`'s
   * `commitRoutes()`), because only the caller knows what `registerAdapter()` or
   * `replace()` threw, and because a yield between publishing and committing is
   * exactly the window in which a second ensure could interleave: the adapter
   * would be serving generation B while the core still held A. `commit()` simply
   * adopts the candidate; `rollback()` is idempotent and restores the generation
   * the candidate displaced, including after `commit()` has run (the core may
   * have refused before publishing anything).
   * @param {object} input - `{ providers, routes }` from one settings snapshot.
   * @returns {{ routes: Map<string, string>, providers: { route: string, name: string }[], commit: () => void, rollback: () => void }} the prepared candidate.
   */
  function prepareRoutes(input) {
    const next = buildSnapshot(input);
    const expected = expectedProviderInfo(input.providers);
    const previous = current;
    current = next;
    let listed;
    try {
      listed = verifyNativeRoutes(adapter, next.routes, expected);
    } catch (error) {
      current = previous;
      throw error;
    }
    return {
      routes: new Map(next.routes),
      providers: listed,
      /** Adopt this generation. */
      commit() {},
      /**
       * Restore the generation this candidate displaced. Safe to call once, twice,
       * or after `commit()`: it only ever reinstates `previous`.
       */
      rollback() {
        current = previous;
      },
    };
  }

  /**
   * Count one shared verification between two generations.
   *
   * `prepareRoutes()` already refused a candidate whose adapter answers disagree
   * with the published snapshot, so this is the caller's cheap assertion that the
   * route set it is about to register is the one that was published — a
   * comparison of sizes and bindings, never a second validation.
   * @param {{ routes: Map<string, string> }} prepared - from {@link prepareRoutes}.
   * @param {Map<string, string>} routes - the set the caller is registering.
   * @returns {boolean} whether both describe the same mapping.
   */
  function describes(prepared, routes) {
    if (!(routes instanceof Map) || prepared.routes.size !== routes.size) return false;
    for (const [publicId, route] of prepared.routes) {
      if (routes.get(publicId) !== route) return false;
    }
    return true;
  }

  return {
    prepareRoutes,
    describes,
    replace,
    /**
     * The `PiAiAdapter` itself — the only object that may be handed to
     * `LlmRuntime.registerAdapter()`. Named twice on purpose: `nativeAdapter` is
     * the correct call for new code, and `getAdapter` is kept because existing
     * callers and tests use it.
     * @returns {object} the native adapter instance.
     */
    nativeAdapter: () => adapter,
    getAdapter: () => adapter,
    expectedProviderInfo,
    /**
     * Describe the currently served snapshot without exposing the mutable
     * collections the adapter reads.
     * @returns {{ routes: Map<string, string>, providerIds: readonly string[], models: ReadonlyMap<string, readonly string[]> }} copy.
     */
    snapshot: () => {
      const models = new Map();
      for (const [route, profile] of current.profiles) {
        models.set(route, profile.piProvider.getModels().map((model) => model.id));
      }
      return { routes: new Map(current.routes), providerIds: [...current.providerIds], models };
    },
  };
}
