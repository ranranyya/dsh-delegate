// Model routing against the native LLM seam.
//
// The rule this module exists to enforce: the model that runs a job is the
// model the operator selected. No branch here substitutes a provider, a model
// or a reasoning effort. When the native registry cannot confirm the requested
// triple, routing refuses with a machine code and the job does not start.
//
// Validation has two independent sources and both must agree:
//  1. the plugin's own settings document (operator intent), and
//  2. the native `llm` service (what this harness can actually reach right now).
// A configuration can be internally consistent and still unroutable; a settings
// edit can also make a previously routable route vanish.

/** Refusal codes surfaced by routing. */
export const ROUTING_CODES = Object.freeze({
  serviceUnavailable: 'ROUTING_SERVICE_UNAVAILABLE',
  providerNotRegistered: 'ROUTING_PROVIDER_NOT_REGISTERED',
  providerListFailed: 'ROUTING_PROVIDER_LIST_FAILED',
  modelUnresolved: 'ROUTING_MODEL_UNRESOLVED',
  effortUnsupported: 'ROUTING_EFFORT_UNSUPPORTED',
  credentialMissing: 'ROUTING_CREDENTIAL_MISSING',
});

/** A routing refusal with a stable machine code. */
export class RoutingError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded, non-secret details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoutingError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Read a native value that may be a plain array or a promise-returning accessor.
 * The native seam differs between harness versions; both shapes are handled so a
 * signature change degrades to an explicit refusal instead of an exception.
 * @param {unknown} value - candidate value.
 * @returns {Promise<unknown>} resolved value.
 */
async function settle(value) {
  return await value;
}

/**
 * Normalize the native effort list for one resolved model.
 *
 * The native seam validates this shape before returning it
 * (`LlmRuntime.normalizeModelInfo` throws `INVALID_MODEL_REASONING` on malformed
 * metadata), so this reads a trusted structure and only flattens it.
 * @param {object | null | undefined} resolved - resolved model info.
 * @returns {{ efforts: string[], defaultEffort: string | null }} declared efforts.
 */
export function declaredEfforts(resolved) {
  const reasoning = resolved?.reasoning ?? null;
  const raw = Array.isArray(reasoning?.efforts) ? reasoning.efforts : [];
  const efforts = [];
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (typeof id === 'string' && id !== '' && !efforts.includes(id)) efforts.push(id);
  }
  const defaultEffort = typeof reasoning?.defaultEffort === 'string' ? reasoning.defaultEffort : null;
  return { efforts, defaultEffort };
}

/**
 * Call the native exact-model lookup.
 *
 * The runtime service exposes `resolveModelInfo(provider, model, signal)`; the
 * adapter base class exposes `resolveModel(...)`. Both are tried because a test
 * double or an older harness may provide either, but a service that offers
 * neither is a refusal, not a silent "assume it works".
 * @param {object} llm - native LLM service.
 * @param {string} providerRoute - provider route id.
 * @param {string} model - model id.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @returns {Promise<object | null>} resolved info, or null when unsupported.
 */
async function resolveModelInfo(llm, providerRoute, model, signal) {
  if (typeof llm.resolveModelInfo === 'function') {
    return await settle(llm.resolveModelInfo(providerRoute, model, signal));
  }
  if (typeof llm.resolveModel === 'function') {
    return await settle(llm.resolveModel(providerRoute, model, signal));
  }
  return null;
}

/**
 * Resolve one configured selection into a routable native request descriptor.
 *
 * @param {object} deps - `llm` is the native LLM service (may be undefined while
 *   the plugin loads before that service exists).
 * @param {object} selection - validated `{ providerId, providerRoute, model, reasoningEffort, provider }`.
 * @param {object} [options] - `signal` for cancellation, `requireEffort` to demand
 *   an explicit effort on models that declare efforts.
 * @returns {Promise<object>} routable descriptor.
 */
export async function resolveRoute(deps, selection, options = {}) {
  const llm = deps?.llm;
  if (llm === undefined || llm === null
    || (typeof llm.resolveModelInfo !== 'function' && typeof llm.resolveModel !== 'function')) {
    throw new RoutingError(ROUTING_CODES.serviceUnavailable, 'the native llm service is not available', {});
  }
  const providerRoute = selection.providerRoute ?? selection.providerId;
  const model = selection.model;
  if (typeof providerRoute !== 'string' || providerRoute === '') {
    throw new RoutingError(ROUTING_CODES.providerNotRegistered, 'no provider route was selected', {});
  }
  if (typeof model !== 'string' || model === '') {
    throw new RoutingError(ROUTING_CODES.modelUnresolved, 'no model was selected', { providerRoute });
  }

  let registered;
  try {
    registered = await settle(typeof llm.listProviders === 'function' ? llm.listProviders() : []);
  } catch (error) {
    throw new RoutingError(ROUTING_CODES.providerListFailed, 'the native llm provider list could not be read', {
      cause: error?.code ?? null,
    });
  }
  const routeIds = Array.isArray(registered)
    ? registered.map((entry) => (typeof entry === 'string' ? entry : entry?.id ?? entry?.provider)).filter((id) => typeof id === 'string')
    : [];
  if (routeIds.length > 0 && !routeIds.includes(providerRoute)) {
    throw new RoutingError(ROUTING_CODES.providerNotRegistered, `provider route ${providerRoute} is not registered with the harness`, {
      providerRoute,
      available: routeIds.slice(0, 32),
    });
  }

  let resolved;
  try {
    resolved = await resolveModelInfo(llm, providerRoute, model, options.signal);
  } catch (error) {
    throw new RoutingError(ROUTING_CODES.modelUnresolved, `model ${model} could not be resolved on route ${providerRoute}`, {
      providerRoute,
      model,
      cause: error?.code ?? null,
      // Bounded and redacted: adapters may surface transport errors verbatim.
      detail: typeof error?.message === 'string' ? error.message.slice(0, 300) : null,
    });
  }
  if (resolved === null || typeof resolved !== 'object') {
    throw new RoutingError(ROUTING_CODES.serviceUnavailable, 'the native llm service cannot resolve exact model metadata', {
      providerRoute,
      model,
    });
  }

  const { efforts, defaultEffort } = declaredEfforts(resolved);
  const requested = selection.reasoningEffort ?? null;
  if (requested !== null) {
    if (efforts.length === 0) {
      // The adapter declares no effort axis. Sending an effort would be a guess
      // that a provider may ignore or reject; refuse instead.
      throw new RoutingError(ROUTING_CODES.effortUnsupported, `model ${model} declares no reasoning efforts`, {
        providerRoute,
        model,
        requested,
      });
    }
    if (!efforts.includes(requested)) {
      throw new RoutingError(ROUTING_CODES.effortUnsupported, `model ${model} does not support reasoning effort ${requested}`, {
        providerRoute,
        model,
        requested,
        supported: [...efforts],
      });
    }
  } else if (options.requireEffort === true && efforts.length > 0 && defaultEffort === null) {
    // Explicit routing means an effort is a decision, not an omission. If the
    // model has an effort axis and no adapter default, an unset effort is
    // ambiguous and is refused rather than resolved silently.
    throw new RoutingError(ROUTING_CODES.effortUnsupported, `model ${model} requires an explicit reasoning effort`, {
      providerRoute,
      model,
      supported: [...efforts],
    });
  }

  return {
    providerRoute,
    model,
    // Only a validated value leaves this function; an unset effort stays unset.
    reasoningEffort: requested,
    declaredEfforts: efforts,
    defaultEffort,
    hasEffortAxis: efforts.length > 0,
  };
}

/**
 * Collect the operator-facing catalog of routable models: for every configured
 * provider, the models the native seam can resolve and which efforts each
 * declares. Unreachable providers are reported with a reason instead of being
 * hidden, so an operator sees why their configured model cannot be picked.
 * @param {object} deps - `llm` native service.
 * @param {object[]} providers - validated provider profiles.
 * @param {object} [options] - `signal`.
 * @returns {Promise<object[]>} per-provider catalog with explicit status.
 */
export async function describeCatalog(deps, providers, options = {}) {
  const llm = deps?.llm;
  const out = [];
  for (const provider of providers) {
    const entry = { providerId: provider.id, route: provider.id, models: [], error: null };
    const resolveAvailable = llm !== undefined && llm !== null
      && (typeof llm.resolveModelInfo === 'function' || typeof llm.resolveModel === 'function');
    if (!resolveAvailable) {
      entry.error = { code: ROUTING_CODES.serviceUnavailable, message: 'the native llm service is not available' };
      out.push(entry);
      continue;
    }
    const declared = Array.isArray(provider.models) ? provider.models : [];
    const candidates = declared.length > 0
      ? declared.map((model) => model.id)
      : await listNativeModels(llm, provider.id).catch(() => []);
    for (const modelId of candidates) {
      try {
        const resolved = await resolveModelInfo(llm, provider.id, modelId, options.signal);
        const { efforts, defaultEffort } = declaredEfforts(resolved);
        entry.models.push({ id: modelId, efforts, defaultEffort });
      } catch (error) {
        entry.error = entry.error ?? {
          code: ROUTING_CODES.modelUnresolved,
          message: `model ${modelId} could not be resolved`,
          detail: typeof error?.message === 'string' ? error.message.slice(0, 300) : null,
        };
      }
    }
    out.push(entry);
  }
  return out;
}

async function listNativeModels(llm, providerId) {
  if (typeof llm?.listModels !== 'function') return [];
  const listed = await settle(llm.listModels(providerId));
  if (!Array.isArray(listed)) return [];
  return listed
    .map((model) => (typeof model === 'string' ? model : model?.id))
    .filter((id) => typeof id === 'string' && id !== '');
}
