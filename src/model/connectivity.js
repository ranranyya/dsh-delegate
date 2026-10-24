// Layered connectivity check for one provider profile.
//
// The four layers exist because they fail for different reasons and an operator
// who sees one red row must be able to tell "the endpoint is unreachable" from
// "the key is wrong" from "the model answered nothing". Collapsing them into one
// boolean produces the classic false negative this project was told not to
// repeat: a reasoning model asked for one token spends its whole budget thinking,
// returns no visible text, and looks broken while it is working perfectly.
//
// Layer order and what each one actually proves:
//
//   1. `transport`     — the configured base URL answers at the HTTP level. This
//                        is a real request with **no credential attached**, so a
//                        401/403 is a pass: it proves the endpoint is there.
//   2. `authentication`— the profile's credential reference is configured in the
//                        native seam. Presence only; the value is never read.
//   3. `catalog`       — the native routing layer can resolve this exact
//                        provider/model/effort triple and reports its declared
//                        efforts. This is the layer that refuses an unsupported
//                        effort instead of silently ignoring it.
//   4. `modelResponse` — a real, short completion with a practical token budget,
//                        classified by `probeModel` (reasoning-only counts).
//
// Only the last layer requires the first three to have any chance of passing, but
// every layer is still evaluated: an operator fixing a key should not also have to
// re-run to discover the address is wrong.

import { resolveRoute, ROUTING_CODES, CONNECTIVITY_LAYERS } from './routing.js';

/** Stable codes for connectivity-layer outcomes that are not routing refusals. */
export const CONNECTIVITY_CODES = Object.freeze({
  providerUnknown: 'CONNECTIVITY_PROVIDER_UNKNOWN',
  urlInvalid: 'CONNECTIVITY_URL_INVALID',
  transportOk: 'CONNECTIVITY_TRANSPORT_OK',
  transportUnreachable: 'CONNECTIVITY_TRANSPORT_UNREACHABLE',
  noCredentialRef: 'CONNECTIVITY_NO_CREDENTIAL_REF',
  credentialConfigured: 'CONNECTIVITY_CREDENTIAL_CONFIGURED',
  credentialMissing: 'CONNECTIVITY_CREDENTIAL_MISSING',
  seamUnavailable: 'CONNECTIVITY_CREDENTIAL_SEAM_UNAVAILABLE',
  catalogOk: 'CONNECTIVITY_CATALOG_OK',
});

/** Bound on the transport probe. A dead socket must not hold the request open. */
export const TRANSPORT_TIMEOUT_MS = 10_000;

/**
 * Probe one base URL at the HTTP level without sending a credential.
 *
 * `redirect: 'manual'` is deliberate: following a redirect would send this request
 * to a host the operator did not configure, and the status of *that* host would
 * then be reported as if it were theirs.
 * @param {string} baseUrl - validated base URL from the provider profile.
 * @param {object} [options] - `fetchImpl` (tests), `timeoutMs`, `signal`.
 * @returns {Promise<{ ok: boolean, detail: object }>} layer result.
 */
export async function probeTransport(baseUrl, options = {}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return {
      ok: false,
      detail: { code: CONNECTIVITY_CODES.urlInvalid, message: 'the provider base URL is not an absolute URL' },
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      detail: { code: CONNECTIVITY_CODES.urlInvalid, message: 'the provider base URL is not http or https' },
    };
  }
  const fetchImpl = options.fetchImpl ?? ((target, init) => globalThis.fetch(target, init));
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : TRANSPORT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // A caller's cancellation and the layer's own budget are both honoured; either
  // one aborts the request.
  const signal = options.signal === undefined || options.signal === null
    ? timeoutSignal
    : AbortSignal.any([timeoutSignal, options.signal]);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      // No `authorization` header and no cookie jar: this layer answers "is
      // something listening and speaking HTTP here", nothing about the key.
      headers: { accept: 'application/json, text/plain;q=0.5' },
      signal,
    });
    const status = typeof response?.status === 'number' ? response.status : 0;
    // Drain the body so the socket is released; the content is not inspected.
    await response?.body?.cancel?.().catch?.(() => undefined);
    if (status >= 100 && status < 500) {
      // A 401/403/404 is reachability evidence, not a failure of this layer.
      return {
        ok: true,
        detail: { code: CONNECTIVITY_CODES.transportOk, status, authenticated: false },
      };
    }
    return {
      ok: false,
      detail: {
        code: CONNECTIVITY_CODES.transportUnreachable,
        message: `the endpoint answered HTTP ${status}`,
        status,
      },
    };
  } catch (error) {
    return {
      ok: false,
      detail: {
        code: CONNECTIVITY_CODES.transportUnreachable,
        message: 'the endpoint could not be reached',
        cause: typeof error?.code === 'string' ? error.code : (error?.name ?? null),
      },
    };
  }
}

/**
 * Build the empty report skeleton, in the documented layer order.
 * @returns {object} report with every layer present and unproven.
 */
function emptyReport() {
  const report = {};
  for (const layer of CONNECTIVITY_LAYERS) {
    report[layer] = { ok: null, detail: null };
  }
  return report;
}

/**
 * Resolve the provider profile and the model/effort triple a check should use.
 *
 * The requested triple wins over the stored worker selection so an operator can
 * test a candidate before saving it, but a request that names nothing falls back
 * to the stored selection — never to a different provider, model or effort.
 * @param {object} settings - validated settings document.
 * @param {object} request - `{ providerId, model?, reasoningEffort? }`.
 * @returns {object} resolution facts.
 */
function resolveTarget(settings, request) {
  const providerId = typeof request?.providerId === 'string' ? request.providerId.trim() : '';
  const provider = settings.providers.find((entry) => entry.id === providerId) ?? null;
  const worker = settings.worker;
  const sameProvider = provider !== null && worker.providerId === provider.id;
  const model = typeof request?.model === 'string' && request.model !== ''
    ? request.model
    : (sameProvider ? worker.model : null);
  const reasoningEffort = typeof request?.reasoningEffort === 'string' && request.reasoningEffort !== ''
    ? request.reasoningEffort
    : (sameProvider ? worker.reasoningEffort : null);
  return {
    providerId,
    provider,
    model: typeof model === 'string' && model !== '' ? model : null,
    reasoningEffort: typeof reasoningEffort === 'string' && reasoningEffort !== '' ? reasoningEffort : null,
  };
}

/**
 * Run the four-layer check for one provider profile.
 *
 * Every layer runs even when an earlier one failed, so the report is a complete
 * picture rather than "the first thing that broke".
 * @param {object} deps - `settings`, `credentials` (gateway), `llm`, `probeModel`,
 *   `ensureRoutes`, and optional `fetchImpl`.
 * @param {object} request - `{ providerId, model?, reasoningEffort? }`.
 * @param {object} [options] - `signal`, `timeoutMs` for the transport layer.
 * @returns {Promise<object>} the layered report.
 */
export async function checkProviderConnectivity(deps, request, options = {}) {
  const report = emptyReport();
  const settings = await deps.settings.read();
  const target = resolveTarget(settings, request);
  report.providerId = target.providerId;
  report.providerName = target.provider?.name ?? null;
  report.selection = { model: target.model, reasoningEffort: target.reasoningEffort };

  if (target.provider === null) {
    const detail = { code: CONNECTIVITY_CODES.providerUnknown, message: `no provider profile named ${target.providerId}` };
    report.transport = { ok: false, detail };
    report.authentication = { ok: null, detail };
    report.catalog = { ok: false, detail };
    report.modelResponse = { ok: null, detail, response: null };
    return report;
  }

  // ---- 1. transport -------------------------------------------------------
  try {
    report.transport = await probeTransport(target.provider.baseUrl, {
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    report.transport = {
      ok: false,
      detail: {
        code: CONNECTIVITY_CODES.transportUnreachable,
        message: 'the endpoint check could not be completed',
        cause: typeof error?.code === 'string' ? error.code : null,
      },
    };
  }

  // ---- 2. authentication --------------------------------------------------
  const reference = target.provider.credentialRef;
  if (reference === null || reference === undefined) {
    report.authentication = {
      ok: false,
      detail: {
        code: CONNECTIVITY_CODES.noCredentialRef,
        message: 'this profile names no credential reference, so a request would be refused',
      },
    };
  } else if (deps.credentials === undefined || deps.credentials === null) {
    report.authentication = {
      ok: null,
      detail: { code: CONNECTIVITY_CODES.seamUnavailable, message: 'this harness exposes no credential service' },
    };
  } else {
    try {
      const info = await deps.credentials.describe(reference);
      report.authentication = {
        ok: info.configured === true,
        detail: {
          code: info.configured === true
            ? CONNECTIVITY_CODES.credentialConfigured
            : CONNECTIVITY_CODES.credentialMissing,
          reference,
          ...(info.source === undefined ? {} : { source: info.source }),
          // A shadowed, non-writable reference is a distinct operator fact: the
          // value resolves, but this plugin cannot change it.
          writable: info.writable === true,
        },
      };
    } catch (error) {
      report.authentication = {
        ok: false,
        detail: {
          code: typeof error?.code === 'string' ? error.code : CONNECTIVITY_CODES.seamUnavailable,
          message: 'the credential reference could not be described',
          reference,
        },
      };
    }
  }

  // ---- 3. catalog + 4. model response ------------------------------------
  // Both need a registered native route for this provider. `ensureRoutes` is the
  // same call the job engine makes, so a route that works here is the route a
  // task would use.
  if (target.model === null) {
    const detail = {
      code: ROUTING_CODES.modelUnresolved,
      message: 'no model is selected for this provider, so no model request was made',
    };
    report.catalog = { ok: false, detail };
    report.modelResponse = { ok: null, detail, response: null };
    return report;
  }

  let routes = null;
  try {
    routes = await deps.ensureRoutes?.(settings) ?? null;
  } catch (error) {
    const detail = {
      code: typeof error?.code === 'string' ? error.code : ROUTING_CODES.providerNotRegistered,
      message: 'the native provider route could not be registered',
    };
    report.catalog = { ok: false, detail };
    report.modelResponse = { ok: null, detail, response: null };
    return report;
  }

  const selection = {
    providerId: target.providerId,
    model: target.model,
    reasoningEffort: target.reasoningEffort,
  };

  let route;
  try {
    route = await resolveRoute(deps, selection, { routes, signal: options.signal });
    report.catalog = {
      ok: true,
      detail: {
        code: CONNECTIVITY_CODES.catalogOk,
        route: route.providerRoute,
        model: route.model,
        declaredEfforts: [...route.declaredEfforts],
        defaultEffort: route.defaultEffort,
      },
      providers: [{ providerId: target.providerId, route: route.providerRoute }],
    };
  } catch (error) {
    const detail = {
      code: typeof error?.code === 'string' ? error.code : ROUTING_CODES.modelUnresolved,
      message: typeof error?.message === 'string' ? error.message.slice(0, 300) : 'the selection could not be routed',
      ...(error?.details === undefined ? {} : { details: error.details }),
    };
    report.catalog = { ok: false, detail, providers: [] };
    // A refused selection is not a model failure: nothing was asked of the model,
    // so this layer stays unproven rather than red.
    report.modelResponse = { ok: null, detail, response: null };
    return report;
  }

  if (typeof deps.probeModel !== 'function') {
    report.modelResponse = {
      ok: null,
      detail: { code: 'PROBE_UNAVAILABLE', message: 'no model probe is installed in this harness' },
      response: null,
    };
    return report;
  }

  // The probe is a native service call, so it can throw as well as answer: a
  // harness whose `llm` seam is registered but not yet usable, or a probe
  // implementation that rejects, must leave this layer *unproven* rather than
  // failing the whole report. The other three layers have already been decided
  // and stay in the report either way.
  let result;
  try {
    result = await deps.probeModel(route, { signal: options.signal });
  } catch (error) {
    report.modelResponse = {
      ok: null,
      detail: {
        code: 'PROBE_UNAVAILABLE',
        message: 'the model probe could not complete',
        cause: typeof error?.code === 'string' ? error.code : null,
      },
      response: null,
    };
    return report;
  }

  const detail = result?.detail ?? null;
  const finishReason = typeof detail?.finishReason === 'string' ? detail.finishReason : null;
  // A budget ending is a budget fact, not a model failure; the probe is the one
  // classifier that decides it (`budgetExhausted`), and it also counts a
  // reasoning-only answer as an answer. Nothing is re-classified here, so the
  // report cannot disagree with the probe that produced it.
  const budgetExhausted = detail?.budgetExhausted === true;
  const reasoningOnly = result?.reasoningOnly === true;
  const text = typeof result?.text === 'string' ? result.text : '';
  const answered = text.trim() !== '' || reasoningOnly;
  report.modelResponse = {
    // A reasoning-only answer is a working model: the model answered, it simply
    // did not answer in visible text.
    ok: answered ? true : result?.ok === true,
    detail,
    response: {
      text,
      reasoningOnly,
      reasoningChars: Number.isInteger(result?.reasoningChars) ? result.reasoningChars : null,
      finishReason,
      budgetExhausted,
      ...(budgetExhausted && answered
        ? {
          note: reasoningOnly
            ? 'the model answered in reasoning only and stopped at its token budget; raise the budget for visible text'
            : 'the model answered and stopped at its token budget; raise the budget for a complete answer',
        }
        : {}),
      tokens: result?.tokens ?? null,
    },
  };
  return report;
}
