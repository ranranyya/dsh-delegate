// Remote model discovery for one configured provider profile.
//
// This module answers exactly one question: *which model ids does this provider's
// own API say it serves right now?* It is the only place in the plugin that talks
// to a provider over HTTP on the operator's behalf outside a model call, and the
// constraints below are what make that safe.
//
// What it is NOT:
//
//   * not a capability authority. An `openai-chat` model list carries ids and
//     nothing this build trusts about reasoning support, so every discovered id
//     gets `efforts: []`. Guessing `high`/`max` from a model name, or forwarding an
//     arbitrary upstream `capabilities`/`reasoning` field, would turn an unverified
//     assumption into a routing decision the provider may reject at request time;
//   * not a native catalog. `/catalog` (`describeCatalog`) reports what the
//     harness can actually resolve for the *configured* models. Discovery can
//     succeed for a provider whose native route was never registered, and that
//     must not be reported as a routable model list;
//   * not a write. Nothing here persists, saves settings, or merges results into
//     the operator's document. It returns data; the operator decides.
//
// Security shape of the single upstream request:
//
//   * the credential is the *selected profile's* `credentialRef`, resolved through
//     the injected DSH credential gateway once, for this request only. No ambient
//     environment variable or default provider credential is ever consulted: this
//     module has no accessor for either;
//   * the value is only ever placed in an `authorization` header. It is never
//     returned, stored on a profile, written to a diagnostic, or included in an
//     error — a failure is classified into a stable code plus fixed text;
//   * `redirect: 'manual'` is deliberate. Following a redirect would replay the
//     credential to a host the operator did not configure;
//   * the response body is read through a byte-limited reader, so a hostile or
//     broken endpoint cannot hold memory or the socket open;
//   * only `data[].id` survives parsing. Upstream `owned_by`, headers, messages and
//     error bodies are dropped rather than forwarded, so nothing an endpoint
//     invents can appear in the operator's UI as if this plugin vouched for it.

import { LIMITS } from '../config/defaults.js';
import { redactText } from '../config/redact.js';

/** Stable diagnosis codes for model discovery. */
export const DISCOVERY_CODES = Object.freeze({
  // Caller-side refusals (thrown, so the route answers with its own status).
  providerUnknown: 'DISCOVERY_PROVIDER_UNKNOWN',
  baseUrlInvalid: 'DISCOVERY_BASE_URL_INVALID',
  credentialRefMissing: 'DISCOVERY_CREDENTIAL_REF_MISSING',
  // Upstream outcomes (reported in the body, never thrown: discovery failing is
  // a diagnosis, not a broken request).
  credentialSeamUnavailable: 'DISCOVERY_CREDENTIAL_SEAM_UNAVAILABLE',
  credentialUnavailable: 'DISCOVERY_CREDENTIAL_UNAVAILABLE',
  credentialNotConfigured: 'DISCOVERY_CREDENTIAL_NOT_CONFIGURED',
  credentialEmpty: 'DISCOVERY_CREDENTIAL_EMPTY',
  authRefused: 'DISCOVERY_AUTH_REFUSED',
  httpError: 'DISCOVERY_HTTP_ERROR',
  redirectRefused: 'DISCOVERY_REDIRECT_REFUSED',
  networkFailed: 'DISCOVERY_NETWORK_FAILED',
  timeout: 'DISCOVERY_TIMEOUT',
  cancelled: 'DISCOVERY_CANCELLED',
  malformedResponse: 'DISCOVERY_MALFORMED_RESPONSE',
  bodyTooLarge: 'DISCOVERY_BODY_TOO_LARGE',
});

/** Optional route hint appended to a base URL. The OpenAI wire path for models. */
export const MODELS_PATH = 'models';

/**
 * Bound on the whole discovery request. A provider that has not answered within
 * this window is reported as a timeout instead of holding the settings page.
 */
export const DISCOVERY_TIMEOUT_MS = 12_000;

/** Bound on the upstream body. A model list is small; 1 MiB is generous. */
export const MAX_DISCOVERY_BODY_BYTES = 1024 * 1024;

/** One model id longer than this is not a model id this build can store. */
export const MAX_MODEL_ID_CHARS = 160;

/**
 * Characters an id may contain. This is exactly the set every protocol this build
 * speaks uses (`openai-chat` style ids), and it is also what keeps a hostile id
 * from carrying control characters into a settings document, a log line or a
 * request body.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:@/+-]+$/u;

/**
 * Build a stable, bounded discovery failure.
 *
 * The class exists so the route can pass an upstream outcome through without
 * re-deriving its code, and so no free-form upstream text can ride along: the
 * message and details are fixed strings produced here.
 */
export class DiscoveryError extends Error {
  /**
   * @param {string} code - one of {@link DISCOVERY_CODES}.
   * @param {string} message - fixed, operator-facing explanation.
   * @param {object} [details] - bounded, non-secret facts (numbers, ids, names).
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DiscoveryError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Join one provider base URL with the model-list path.
 *
 * The configured base URL has already been normalized by the validator (no query,
 * no fragment, no trailing slash), and an openai-compatible base is normally
 * `.../v1`. The `/v1` prefix therefore has to survive verbatim: dropping it, or
 * inserting the path before it, would address a different endpoint than the one
 * the operator configured. A base that already ends in the path segment is used
 * as-is rather than doubled.
 * @param {string} baseUrl - validated provider base URL.
 * @returns {URL} absolute model-list URL.
 * @throws {DiscoveryError} when the base URL is not an absolute http(s) URL.
 */
export function modelsUrlFor(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DiscoveryError(DISCOVERY_CODES.baseUrlInvalid, 'the provider base URL is not an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DiscoveryError(DISCOVERY_CODES.baseUrlInvalid, 'the provider base URL is not http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    // Defence in depth: the validator refuses these, and a URL that somehow
    // carried one would put something besides the credential in the request URL.
    throw new DiscoveryError(DISCOVERY_CODES.baseUrlInvalid, 'the provider base URL carries a query, fragment or credentials');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(`/${MODELS_PATH}`) ? path : `${path}/${MODELS_PATH}`;
  url.search = '';
  url.hash = '';
  return url;
}

/**
 * Whether a candidate string is an id this build can store as a model.
 * @param {unknown} value - candidate id.
 * @returns {boolean} true when usable.
 */
export function isDiscoverableModelId(value) {
  return typeof value === 'string'
    && value !== ''
    && value === value.trim()
    && value.length <= MAX_MODEL_ID_CHARS
    && MODEL_ID_PATTERN.test(value);
}

/**
 * Parse one OpenAI-compatible model list into bounded, safe ids.
 *
 * The accepted shape is the documented one — `{ "data": [{ "id": "<id>", ... }] }`
 * — and nothing else. An array at the top level, a `models` key, or any other
 * provider's spelling is *malformed*, not "close enough": accepting a guess would
 * mean publishing ids this build never proved came from the endpoint's list.
 *
 * Deduplication is first-wins and silent: a repeated id is one model, not an
 * error, because some gateways concatenate alias lists. Everything past
 * `LIMITS.manualModelsPerProvider` is dropped and reported as a count, so the
 * result always fits the settings document it may be merged into.
 * @param {unknown} value - parsed JSON body.
 * @returns {{ models: { id: string, efforts: string[] }[], duplicates: number, invalid: number, truncated: number }} summary.
 * @throws {DiscoveryError} when the body is not a model list at all.
 */
export function parseModelList(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DiscoveryError(DISCOVERY_CODES.malformedResponse, 'the endpoint did not answer with a JSON object');
  }
  const data = value.data;
  if (!Array.isArray(data)) {
    throw new DiscoveryError(DISCOVERY_CODES.malformedResponse, 'the endpoint answered without a "data" array');
  }
  const models = [];
  const seen = new Set();
  let duplicates = 0;
  let invalid = 0;
  let truncated = 0;
  for (const entry of data) {
    const id = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry.id : undefined;
    if (!isDiscoverableModelId(id)) {
      // A malformed row is skipped rather than refusing the whole list: one bad
      // entry must not hide the ids the endpoint did report correctly.
      invalid += 1;
      continue;
    }
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    if (models.length >= LIMITS.manualModelsPerProvider) {
      truncated += 1;
      continue;
    }
    // No capability is read from the response on purpose. An API listing proves
    // an id exists, not that it accepts a reasoning effort.
    models.push({ id, efforts: [] });
  }
  if (models.length === 0 && data.length > 0) {
    throw new DiscoveryError(DISCOVERY_CODES.malformedResponse, 'the endpoint answered with no usable model id');
  }
  return { models, duplicates, invalid, truncated };
}

/**
 * Read at most `limit` bytes from a response body.
 *
 * `response.text()` would buffer whatever the endpoint sends, and a
 * `content-length` header is a claim, not a bound. This reads the stream chunk by
 * chunk, aborts the reader as soon as the cap is crossed, and always releases the
 * body — including on every early-return path below.
 * @param {Response} response - fetch response.
 * @param {number} limit - byte bound.
 * @returns {Promise<{ ok: true, text: string } | { ok: false, code: string }>} outcome.
 */
async function readBoundedText(response, limit) {
  const declared = Number(response?.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await cancelBody(response);
    return { ok: false, code: DISCOVERY_CODES.bodyTooLarge };
  }
  const body = response?.body;
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    // A synthetic response (or a runtime without streams) still has text().
    try {
      const text = typeof response?.text === 'function' ? await response.text() : '';
      if (Buffer.byteLength(text, 'utf8') > limit) return { ok: false, code: DISCOVERY_CODES.bodyTooLarge };
      return { ok: true, text };
    } catch {
      return { ok: false, code: DISCOVERY_CODES.malformedResponse };
    }
  }
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
      size += chunk.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, code: DISCOVERY_CODES.bodyTooLarge };
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error?.name === 'AbortError') return { ok: false, code: DISCOVERY_CODES.cancelled };
    return { ok: false, code: DISCOVERY_CODES.malformedResponse };
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: Buffer.from(merged).toString('utf8') };
}

/**
 * Release a response body without consuming it.
 * @param {Response} response - fetch response.
 * @returns {Promise<void>} resolves once the body is released.
 */
async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // An already-consumed or locked body cannot be cancelled; nothing to do.
  }
}

/**
 * Classify one thrown transport failure into a stable discovery outcome.
 *
 * The caller's signal and the request's own budget are reported separately on
 * purpose. `AbortSignal.any()` aborts the combined signal whichever input fired, so
 * a combined-signal check would label our own timeout as "the operator cancelled
 * it" — a diagnosis that sends an operator looking for a cancellation that never
 * happened.
 * @param {unknown} error - thrown value from fetch.
 * @param {object} signals - `timeoutSignal` and the caller's `callerSignal`.
 * @returns {DiscoveryError} stable failure.
 */
function classifyTransportError(error, signals = {}) {
  if (signals.callerSignal?.aborted === true) {
    return new DiscoveryError(DISCOVERY_CODES.cancelled, 'the model list request was cancelled');
  }
  if (signals.timeoutSignal?.aborted === true
    || error?.name === 'TimeoutError'
    || error?.name === 'AbortError') {
    return new DiscoveryError(DISCOVERY_CODES.timeout, 'the endpoint did not answer in time', {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
  }
  // A network failure surfaces the operator's own host and port in its message,
  // and some runtimes add the request line. Only the error kind is kept.
  return new DiscoveryError(DISCOVERY_CODES.networkFailed, 'the endpoint could not be reached', {
    cause: typeof error?.code === 'string' ? error.code : (typeof error?.name === 'string' ? error.name : null),
  });
}

/**
 * Retrieve the model list of one configured provider profile.
 *
 * The credential is resolved through the injected DSH gateway for this request
 * only. A profile with no `credentialRef` is refused before any network I/O: an
 * unauthenticated list would describe what an endpoint shows a stranger, not what
 * this operator's key can use.
 * @param {object} input - discovery inputs.
 * @param {object} input.provider - validated provider profile (`id`, `baseUrl`, `credentialRef`).
 * @param {object} [input.credentials] - DSH credential gateway (`resolve(ref)`).
 * @param {(url: URL, init: object) => Promise<Response>} [input.fetchImpl] - transport override for tests.
 * @param {AbortSignal} [input.signal] - caller cancellation.
 * @param {number} [input.timeoutMs] - caller-tuned bound, never above the default.
 * @returns {Promise<object>} `{ ok, models, diagnosis, facts }`.
 */
export async function discoverProviderModels(input = {}) {
  const provider = input.provider;
  if (provider === null || typeof provider !== 'object' || typeof provider.id !== 'string' || provider.id === '') {
    throw new DiscoveryError(DISCOVERY_CODES.providerUnknown, 'no provider profile was supplied');
  }
  const url = modelsUrlFor(provider.baseUrl);
  const reference = typeof provider.credentialRef === 'string' && provider.credentialRef !== ''
    ? provider.credentialRef
    : null;
  if (reference === null) {
    throw new DiscoveryError(
      DISCOVERY_CODES.credentialRefMissing,
      `provider ${provider.id} names no credential reference; set one before fetching its model list`,
      { providerId: provider.id },
    );
  }
  const credentials = input.credentials ?? null;
  if (credentials === null || typeof credentials.resolve !== 'function') {
    return failure(new DiscoveryError(
      DISCOVERY_CODES.credentialSeamUnavailable,
      'this harness exposes no credential service, so the provider cannot be authenticated',
      { reference, providerId: provider.id },
    ));
  }

  let resolved;
  try {
    resolved = await credentials.resolve(reference);
  } catch (error) {
    // The gateway already keeps its own message out of the way; only its code is
    // forwarded, and never the value the backend may have echoed.
    return failure(new DiscoveryError(
      DISCOVERY_CODES.credentialUnavailable,
      `credential ${reference} could not be resolved`,
      { reference, providerId: provider.id, cause: typeof error?.code === 'string' ? error.code : null },
    ));
  }
  const value = typeof resolved?.value === 'string' ? resolved.value : '';
  if (value === '') {
    return failure(new DiscoveryError(
      DISCOVERY_CODES.credentialNotConfigured,
      `credential ${reference} is not configured`,
      { reference, providerId: provider.id },
    ));
  }
  if (value.trim() === '') {
    return failure(new DiscoveryError(
      DISCOVERY_CODES.credentialEmpty,
      `credential ${reference} holds no usable value`,
      { reference, providerId: provider.id },
    ));
  }

  const timeoutMs = Number.isInteger(input.timeoutMs) && input.timeoutMs > 0
    ? Math.min(input.timeoutMs, DISCOVERY_TIMEOUT_MS)
    : DISCOVERY_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal === undefined || input.signal === null
    ? timeoutSignal
    : AbortSignal.any([timeoutSignal, input.signal]);
  const fetchImpl = typeof input.fetchImpl === 'function'
    ? input.fetchImpl
    : ((target, init) => globalThis.fetch(target, init));

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      // Never follow a redirect: the credential must not reach a host the
      // operator did not configure.
      redirect: 'manual',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${value}`,
      },
      signal,
    });
  } catch (error) {
    return failure(classifyTransportError(error, { timeoutSignal, callerSignal: input.signal }));
  }

  const status = typeof response?.status === 'number' ? response.status : 0;
  if (status >= 300 && status < 400) {
    // Even a same-host redirect is refused, and its `location` is not reported:
    // the target is the endpoint's business, not the operator's.
    await cancelBody(response);
    return failure(new DiscoveryError(
      DISCOVERY_CODES.redirectRefused,
      'the endpoint answered with a redirect; configure the final base URL instead',
      { providerId: provider.id, status },
    ));
  }
  if (status === 401 || status === 403) {
    // The upstream body may quote the key back. It is released, never read.
    await cancelBody(response);
    return failure(new DiscoveryError(
      DISCOVERY_CODES.authRefused,
      `the endpoint refused the credential (HTTP ${status})`,
      { providerId: provider.id, status, reference },
    ));
  }
  if (status < 200 || status >= 300) {
    await cancelBody(response);
    return failure(new DiscoveryError(
      DISCOVERY_CODES.httpError,
      `the endpoint answered HTTP ${status}`,
      { providerId: provider.id, status },
    ));
  }

  const read = await readBoundedText(response, MAX_DISCOVERY_BODY_BYTES);
  if (read.ok !== true) {
    if (read.code === DISCOVERY_CODES.cancelled) {
      return failure(classifyTransportError(
        Object.assign(new Error('cancelled'), { name: 'AbortError' }),
        { timeoutSignal, callerSignal: input.signal },
      ));
    }
    return failure(new DiscoveryError(
      read.code,
      read.code === DISCOVERY_CODES.bodyTooLarge
        ? 'the endpoint answered with more than the accepted body size'
        : 'the endpoint response could not be read',
      { providerId: provider.id, limitBytes: MAX_DISCOVERY_BODY_BYTES },
    ));
  }

  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    // The body itself is not forwarded: it is untrusted text and may be an HTML
    // error page quoting the request.
    return failure(new DiscoveryError(
      DISCOVERY_CODES.malformedResponse,
      'the endpoint answered with something that is not JSON',
      { providerId: provider.id },
    ));
  }

  let summary;
  try {
    summary = parseModelList(parsed);
  } catch (error) {
    if (error instanceof DiscoveryError) {
      return failure(new DiscoveryError(error.code, error.message, { providerId: provider.id }));
    }
    return failure(new DiscoveryError(DISCOVERY_CODES.malformedResponse, 'the endpoint answer could not be understood', {
      providerId: provider.id,
    }));
  }

  return {
    ok: true,
    models: summary.models,
    diagnosis: null,
    facts: {
      providerId: provider.id,
      // Named so a caller never has to infer where the list came from.
      source: 'remote',
      endpoint: url.origin + url.pathname,
      status,
      received: summary.models.length,
      duplicates: summary.duplicates,
      invalid: summary.invalid,
      truncated: summary.truncated,
      // Stated rather than implied, because it is the one thing a list cannot
      // prove and the one thing an operator is most likely to assume.
      capabilities: 'listing-does-not-establish-reasoning-support',
    },
  };
}

/**
 * Wrap one upstream failure as a discovery result.
 * @param {DiscoveryError} error - stable failure.
 * @returns {object} `{ ok: false, models: [], diagnosis, facts }`.
 */
function failure(error) {
  return {
    ok: false,
    models: [],
    diagnosis: {
      code: error.code,
      // Fixed text from this module, redacted as a belt-and-braces measure: no
      // upstream string ever reaches this field, but a future edit must not be
      // able to leak one either.
      message: redactText(error.message).slice(0, 300),
      details: sanitizeDetails(error.details),
    },
    facts: { providerId: error.details?.providerId ?? null, source: 'remote' },
  };
}

/**
 * Keep only bounded, non-secret detail values.
 *
 * The detail object is built by this module, so this is a guard against a future
 * addition rather than a filter over untrusted input: strings are truncated and
 * redacted, and anything else non-primitive is dropped.
 * @param {object | undefined} details - candidate details.
 * @returns {object} safe details.
 */
function sanitizeDetails(details) {
  const out = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (typeof value === 'string') {
      if (value === '') continue;
      out[key] = redactText(value).slice(0, 200);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Fold a discovered list into the operator's stored declarations, without ever
 * weakening what was declared explicitly.
 *
 * The merge is deliberately asymmetric:
 *   * an id the document already declares keeps its declared `efforts` and
 *     `contextWindow` — discovery cannot lend capability, so it cannot take any
 *     away either;
 *   * an id that is new to the document is added with `efforts: []`, exactly as
 *     discovery found it;
 *   * ids the document declares but the endpoint did not list are kept. A manual
 *     entry (or a model the endpoint has temporarily dropped) stays configured;
 *     dropping it would silently delete an operator's work.
 * @param {object[]} declared - `provider.models` from the settings document.
 * @param {object[]} discovered - `{ id, efforts }` entries from {@link discoverProviderModels}.
 * @returns {{ models: object[], added: string[], kept: string[], declaredEffortModelIds: string[] }} merge result.
 */
export function mergeDiscoveredModels(declared, discovered) {
  const existing = Array.isArray(declared) ? declared : [];
  const models = existing.map((model) => ({ ...model }));
  const byId = new Map(models.map((model) => [model.id, model]));
  const added = [];
  const declaredEffortModelIds = [];
  for (const model of models) {
    if (Array.isArray(model.efforts) && model.efforts.length > 0) declaredEffortModelIds.push(model.id);
  }
  for (const found of Array.isArray(discovered) ? discovered : []) {
    if (!isDiscoverableModelId(found?.id)) continue;
    if (byId.has(found.id)) continue;
    const entry = { id: found.id, efforts: [] };
    models.push(entry);
    byId.set(entry.id, entry);
    added.push(entry.id);
  }
  const discoveredIds = new Set((Array.isArray(discovered) ? discovered : []).map((model) => model?.id));
  const kept = models
    .map((model) => model.id)
    .filter((id) => isDiscoverableModelId(id) && !discoveredIds.has(id));
  return { models, added, kept, declaredEffortModelIds };
}
