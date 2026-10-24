// Layered connectivity tests.
//
// What is proven here:
//
//   1. The transport layer distinguishes "something answers HTTP here" from "the
//      endpoint is broken". A 401/403 is a *pass* on purpose: it proves the
//      endpoint exists, which is all this layer claims. A 5xx is a failure.
//   2. The transport probe sends no credential and does not follow a redirect,
//      because following one would report a third party's status as the
//      operator's.
//   3. The four layers are evaluated independently, so one red row does not hide
//      the state of the rest.
//   4. A reasoning-only model answer counts as success. This is the false negative
//      the project was explicitly told not to repeat: a thinking model asked for a
//      short reply spends its budget thinking, emits no visible text, and is
//      working perfectly.
//   5. A model/effort triple the native registry refuses is reported at the
//      *catalog* layer with the model layer honestly unproven — nothing was asked
//      of the model, so claiming a model failure would be a fabrication.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { checkProviderConnectivity, probeTransport, CONNECTIVITY_CODES } from '../src/model/connectivity.js';
import {
  PROBE_MAX_TOKENS,
  PROBE_MIN_TOKENS,
  classifyProbeResponse,
  normalizeFinishReason,
  probeModel,
} from '../src/model/probe.js';
import { CONNECTIVITY_LAYERS, ROUTING_CODES } from '../src/model/routing.js';
import { SettingsService } from '../src/config/settings.js';
import { cleanup, fakeLlm, llmTable, makeTempDir, validSettings } from './helpers/fakes.js';

/**
 * A fetch double that records what was asked and answers with one status.
 * @param {number} status - HTTP status to answer with.
 * @param {object} [options] - `throws`: error to reject with instead.
 * @returns {object} fetch function with `calls` history.
 */
function fakeFetch(status, options = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (options.throws !== undefined) throw options.throws;
    return new Response('', { status });
  };
  impl.calls = calls;
  return impl;
}

/**
 * A credential gateway double: `describe` only, which is all this layer may use.
 * @param {object} info - `{ configured, source?, writable }` to answer with.
 * @param {object} [options] - `fail`: error to throw.
 * @returns {object} gateway with `calls` history.
 */
function fakeCredentialSeam(info, options = {}) {
  const calls = [];
  return {
    calls,
    async describe(ref) {
      calls.push(ref);
      if (options.fail !== undefined) throw options.fail;
      return info;
    },
    async resolve() {
      throw new Error('the connectivity check must never resolve a credential value');
    },
    async set() {
      throw new Error('the connectivity check must never write a credential');
    },
    async unset() {
      throw new Error('the connectivity check must never remove a credential');
    },
  };
}

/**
 * Build a dependency object over one temporary settings document.
 * @param {object} [options] - `settings`, `credentials`, `fetchImpl`, `probe`, `routes`.
 * @returns {Promise<object>} harness with `deps`, `settings`, `dir`, `ensureCalls`.
 */
async function harness(options = {}) {
  const dir = await makeTempDir();
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(options.settings ?? validSettings());
  const ensureCalls = [];
  // The native route is deliberately not the profile id: a report that leaked the
  // profile id as the route would be inaccurate about what the harness was asked.
  const routes = options.routes ?? new Map([['relay', 'relay-native']]);
  const deps = {
    settings,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    credentials: options.credentials === undefined
      ? fakeCredentialSeam({ configured: true, source: 'store', writable: true })
      : options.credentials,
    fetchImpl: options.fetchImpl ?? fakeFetch(404),
    async ensureRoutes() {
      ensureCalls.push('ensure');
      return routes;
    },
    ...(options.probe === undefined ? {} : { probeModel: options.probe }),
  };
  return { dir, deps, settings, ensureCalls };
}

/** A probe double answering one result. */
function fakeProbe(result) {
  const calls = [];
  const impl = async (route) => {
    calls.push(route);
    return result;
  };
  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// 1. Transport layer
// ---------------------------------------------------------------------------

test('an unauthenticated 401 proves the endpoint is reachable and is reported as a pass', async () => {
  const fetchImpl = fakeFetch(401);
  const result = await probeTransport('http://127.0.0.1:8443/v1', { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.detail.code, CONNECTIVITY_CODES.transportOk);
  assert.equal(result.detail.status, 401);
  // The observation is stated, not implied: this layer proved reachability only.
  assert.equal(result.detail.authenticated, false);
  assert.equal(fetchImpl.calls.length, 1);
});

test('the transport probe sends no credential and does not follow a redirect', async () => {
  const fetchImpl = fakeFetch(200);
  await probeTransport('http://127.0.0.1:8443/v1', { fetchImpl });
  const [call] = fetchImpl.calls;
  assert.equal(call.init.method, 'GET');
  assert.equal(call.init.redirect, 'manual', 'following a redirect would attribute another host to the operator');
  assert.equal('authorization' in call.init.headers, false);
  assert.equal(JSON.stringify(call.init.headers).toLowerCase().includes('bearer'), false);
  assert.equal('credentials' in call.init, false, 'no cookie jar may be attached');
});

test('a 5xx is a transport failure, and so is an unreachable socket', async () => {
  const server = await probeTransport('http://127.0.0.1:8443/v1', { fetchImpl: fakeFetch(503) });
  assert.equal(server.ok, false);
  assert.equal(server.detail.code, CONNECTIVITY_CODES.transportUnreachable);
  assert.equal(server.detail.status, 503);

  const offline = await probeTransport('http://127.0.0.1:8443/v1', {
    fetchImpl: fakeFetch(0, { throws: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }),
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.detail.code, CONNECTIVITY_CODES.transportUnreachable);
  assert.equal(offline.detail.cause, 'ECONNREFUSED');
});

test('a base URL that is not an absolute http(s) URL is refused before any request', async () => {
  const fetchImpl = fakeFetch(200);
  for (const baseUrl of ['not a url', 'file:///etc/passwd', 'ftp://example.test/v1']) {
    const result = await probeTransport(baseUrl, { fetchImpl });
    assert.equal(result.ok, false, `${baseUrl} must be refused`);
    assert.equal(result.detail.code, CONNECTIVITY_CODES.urlInvalid);
  }
  assert.equal(fetchImpl.calls.length, 0, 'an invalid URL must not produce a request');
});

// ---------------------------------------------------------------------------
// 2. Independence of the four layers
// ---------------------------------------------------------------------------

test('every layer is reported even when the first one fails', async () => {
  const { dir, deps } = await harness({
    fetchImpl: fakeFetch(0, { throws: Object.assign(new Error('offline'), { code: 'ENOTFOUND' }) }),
    probe: fakeProbe({ ok: true, detail: { code: 'PROBE_OK' }, text: 'ready', reasoningOnly: false, tokens: null }),
  });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    for (const layer of CONNECTIVITY_LAYERS) {
      assert.ok(layer in report, `layer ${layer} must be present in the report`);
      assert.equal(typeof report[layer], 'object');
    }
    assert.equal(report.transport.ok, false);
    // A dead endpoint does not make the credential unconfigured, and a reachable
    // seam does not make the endpoint alive.
    assert.equal(report.authentication.ok, true);
    assert.equal(report.catalog.ok, true);
    assert.equal(report.modelResponse.ok, true);
  } finally {
    await cleanup(dir);
  }
});

test('an unknown provider is refused at every layer instead of inventing a profile', async () => {
  const { dir, deps } = await harness();
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'nope' });
    assert.equal(report.providerId, 'nope');
    assert.equal(report.providerName, null);
    assert.equal(report.transport.ok, false);
    assert.equal(report.transport.detail.code, CONNECTIVITY_CODES.providerUnknown);
    // Nothing was attempted for the layers that need a profile: unproven, not red.
    assert.equal(report.authentication.ok, null);
    assert.equal(report.modelResponse.ok, null);
  } finally {
    await cleanup(dir);
  }
});

test('a profile with no credential reference fails authentication with the reason, not a silent pass', async () => {
  const settings = validSettings();
  settings.providers[0].credentialRef = null;
  const seam = fakeCredentialSeam({ configured: true, writable: true });
  const { dir, deps } = await harness({ settings, credentials: seam, probe: fakeProbe({ ok: true, text: 'ready', reasoningOnly: false }) });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.authentication.ok, false);
    assert.equal(report.authentication.detail.code, CONNECTIVITY_CODES.noCredentialRef);
    assert.deepEqual(seam.calls, [], 'a null reference must never reach the seam');
  } finally {
    await cleanup(dir);
  }
});

test('a harness without a credential service reports authentication as unproven, not as configured', async () => {
  const { dir, deps } = await harness({ credentials: null, probe: fakeProbe({ ok: true, text: 'ready', reasoningOnly: false }) });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.authentication.ok, null);
    assert.equal(report.authentication.detail.code, CONNECTIVITY_CODES.seamUnavailable);
  } finally {
    await cleanup(dir);
  }
});

test('the authentication layer reports presence and writability but never a value', async () => {
  const seam = fakeCredentialSeam({ configured: true, source: 'store', writable: false });
  const { dir, deps } = await harness({ credentials: seam, probe: fakeProbe({ ok: true, text: 'ready', reasoningOnly: false }) });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.authentication.ok, true);
    assert.equal(report.authentication.detail.reference, 'DSH_DELEGATE_RELAY_KEY');
    assert.equal(report.authentication.detail.source, 'store');
    assert.equal(report.authentication.detail.writable, false);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('sk-'), false);
    assert.equal('value' in report.authentication.detail, false);
    assert.deepEqual(seam.calls, ['DSH_DELEGATE_RELAY_KEY']);
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 3. Model layer: reasoning-only counts, refusal is not a failure
// ---------------------------------------------------------------------------

test('a reasoning-only model answer is a working model, and the report says so', async () => {
  const probe = fakeProbe({
    ok: true,
    detail: { code: 'PROBE_OK', finishReason: 'max-tokens', reasoningOnly: true, maxTokens: 2048 },
    text: '',
    reasoningOnly: true,
    reasoningChars: 512,
    tokens: { inputTokens: 12, outputTokens: 2048, reasoningTokens: 2048 },
  });
  const { dir, deps } = await harness({ probe });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.modelResponse.ok, true);
    assert.equal(report.modelResponse.response.reasoningOnly, true);
    assert.equal(report.modelResponse.response.text, '');
    assert.equal(report.modelResponse.response.reasoningChars, 512);
    assert.equal(probe.calls.length, 1);
    // The probe must have been asked with the route the registry registered.
    assert.equal(probe.calls[0].providerRoute, 'relay-native');
  } finally {
    await cleanup(dir);
  }
});

test('an unsupported reasoning effort is refused at the catalog layer and leaves the model layer unproven', async () => {
  const probe = fakeProbe({ ok: true, text: 'ready', reasoningOnly: false });
  const { dir, deps } = await harness({ probe });
  try {
    // `deepseek-reasoner` declares only medium/high in the fixture table.
    const report = await checkProviderConnectivity(deps, {
      providerId: 'relay',
      model: 'deepseek-reasoner',
      reasoningEffort: 'low',
    });
    assert.equal(report.catalog.ok, false);
    assert.equal(report.catalog.detail.code, ROUTING_CODES.effortUnsupported);
    assert.deepEqual(report.catalog.detail.details.supported, ['medium', 'high']);
    assert.equal(report.modelResponse.ok, null, 'no model request was made, so the layer must be unproven');
    assert.deepEqual(probe.calls, [], 'a refused selection must not reach the model');
  } finally {
    await cleanup(dir);
  }
});

test('the requested model and effort take precedence over the stored worker selection', async () => {
  const probe = fakeProbe({ ok: true, text: 'ready', reasoningOnly: false });
  const { dir, deps } = await harness({ probe });
  try {
    const report = await checkProviderConnectivity(deps, {
      providerId: 'relay',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    });
    assert.deepEqual(report.selection, { model: 'deepseek-reasoner', reasoningEffort: 'high' });
    assert.equal(report.catalog.ok, true);
    assert.deepEqual(report.catalog.detail.declaredEfforts, ['medium', 'high']);
    assert.equal(probe.calls[0].model, 'deepseek-reasoner');
    assert.equal(probe.calls[0].reasoningEffort, 'high');
  } finally {
    await cleanup(dir);
  }
});

test('a request that names no model falls back to the stored selection for that provider only', async () => {
  const probe = fakeProbe({ ok: true, text: 'ready', reasoningOnly: false });
  const { dir, deps } = await harness({ probe });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    // `validSettings()` selects deepseek-chat/medium, so that is what is checked.
    assert.deepEqual(report.selection, { model: 'deepseek-chat', reasoningEffort: 'medium' });
    assert.equal(probe.calls[0].model, 'deepseek-chat');
  } finally {
    await cleanup(dir);
  }
});

test('a provider that does not hold the stored worker selection is not silently given its model', async () => {
  const settings = validSettings();
  // A second provider that the worker selection does not point at.
  settings.providers.push({
    id: 'other',
    name: 'Other',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:9000/v1',
    credentialRef: 'OTHER_KEY',
    models: [{ id: 'some-model', efforts: [] }],
  });
  const probe = fakeProbe({ ok: true, text: 'ready', reasoningOnly: false });
  const { dir, deps } = await harness({ settings, probe });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'other' });
    assert.deepEqual(report.selection, { model: null, reasoningEffort: null });
    assert.equal(report.catalog.ok, false);
    assert.equal(report.catalog.detail.code, ROUTING_CODES.modelUnresolved);
    assert.deepEqual(probe.calls, [], 'no model was selected for this provider, so nothing may be sent');
  } finally {
    await cleanup(dir);
  }
});

test('a missing model probe is reported as unavailable rather than as a model failure', async () => {
  const { dir, deps } = await harness();
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.modelResponse.ok, null);
    assert.equal(report.modelResponse.detail.code, 'PROBE_UNAVAILABLE');
  } finally {
    await cleanup(dir);
  }
});

test('a failing route registration is reported at the catalog layer without throwing', async () => {
  const { dir, deps } = await harness({ probe: fakeProbe({ ok: true, text: 'ready', reasoningOnly: false }) });
  deps.ensureRoutes = async () => {
    throw Object.assign(new Error('registration refused'), { code: 'provider_registry' });
  };
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.catalog.ok, false);
    assert.equal(report.catalog.detail.code, 'provider_registry');
    assert.equal(report.modelResponse.ok, null);
  } finally {
    await cleanup(dir);
  }
});

test('a route the registry does not map is refused instead of being rerouted to the profile id', async () => {
  const { dir, deps } = await harness({
    routes: new Map(),
    probe: fakeProbe({ ok: true, text: 'ready', reasoningOnly: false }),
  });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.catalog.ok, false);
    assert.equal(report.catalog.detail.code, ROUTING_CODES.providerNotRegistered);
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 4. The probe itself: budget, reasoning-only, and what distinguishes "empty"
// ---------------------------------------------------------------------------

/**
 * A probe dependency over a scripted native chunk stream.
 * @param {(request: object) => AsyncIterable<object>} script - yields stream chunks.
 * @returns {object} dependency object recording what the probe asked for.
 */
function probeDeps(script) {
  const requests = [];
  return {
    requests,
    llm: {
      stream(request) {
        requests.push(request);
        return script(request);
      },
    },
  };
}

/** The route a resolved selection produces for the fixture table. */
const PROBE_ROUTE = Object.freeze({ providerRoute: 'relay-native', model: 'deepseek-reasoner', reasoningEffort: 'high' });

test('the probe asks with a practical budget, never the one-token request that starved reasoning models', async () => {
  const deps = probeDeps(async function* () {
    yield { type: 'text-delta', index: 0, text: 'ready' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const result = await probeModel(deps, PROBE_ROUTE);
  assert.equal(result.ok, true);
  assert.equal(deps.requests.length, 1);
  assert.equal(deps.requests[0].maxTokens, PROBE_MAX_TOKENS);
  assert.ok(PROBE_MAX_TOKENS >= 1024, 'a one-token probe is the false timeout this check must never repeat');
  assert.equal(deps.requests[0].model, 'deepseek-reasoner');
  assert.equal(deps.requests[0].reasoningEffort, 'high');
  assert.equal(result.detail.maxTokens, PROBE_MAX_TOKENS);
  assert.equal(result.detail.budgetExhausted, false);

  // A caller-supplied budget is honoured, but a starving one is raised: a
  // budget that cannot hold a thought is the same defect in a different place.
  const tiny = probeDeps(async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  await probeModel(tiny, PROBE_ROUTE, { maxTokens: 1 });
  assert.equal(tiny.requests[0].maxTokens, PROBE_MIN_TOKENS);
  const generous = probeDeps(async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  await probeModel(generous, PROBE_ROUTE, { maxTokens: 4096 });
  assert.equal(generous.requests[0].maxTokens, 4096);
});

test('a reasoning-only answer that stops at its token budget is a working model, not a timeout', async () => {
  const deps = probeDeps(async function* () {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'weighing the request' };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing the request' } };
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 2048 } };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  });
  const result = await probeModel(deps, PROBE_ROUTE);
  assert.equal(result.ok, true);
  assert.equal(result.detail.code, 'PROBE_OK');
  assert.equal(result.detail.finishReason, 'max-tokens');
  assert.equal(result.detail.reasoningOnly, true);
  // Reported as a budget fact, never as a failure or a timeout.
  assert.equal(result.detail.budgetExhausted, true);
  assert.equal(result.detail.message, undefined);
  assert.equal(result.reasoningChars, 'weighing the request'.length);
  assert.equal(result.text, '');
});

test('a reasoning block alone is enough: a provider that streams no deltas still counts as answering', async () => {
  const deps = probeDeps(async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'deliberated' } };
    yield { type: 'finish', reason: { kind: 'started' } };
  });
  const result = await probeModel(deps, PROBE_ROUTE);
  assert.equal(result.ok, true);
  assert.equal(result.reasoningOnly, true);
  assert.equal(result.reasoningChars, 'deliberated'.length);
});

test('the probe keeps the distinctions an operator needs: empty, error, aborted and unproductive endings', async () => {
  // A provider that completes with nothing at all is empty, not a timeout.
  const empty = await probeModel(probeDeps(async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } };
  }), PROBE_ROUTE);
  assert.equal(empty.ok, false);
  assert.equal(empty.detail.code, 'PROBE_EMPTY_RESPONSE');

  // A provider error is a failure with its own cause, never an empty answer.
  const failed = await probeModel(probeDeps(async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'invalid api key', code: 'AUTH' } } };
  }), PROBE_ROUTE);
  assert.equal(failed.ok, false);
  assert.equal(failed.detail.code, 'PROBE_FAILED');

  const aborted = await probeModel(probeDeps(async function* () {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'cancelled' } } };
  }), PROBE_ROUTE);
  assert.equal(aborted.ok, false);
  assert.equal(aborted.detail.code, 'PROBE_TIMEOUT');
});

test('a stream that fails after delivering reasoning is still a working model, with the fault reported beside it', async () => {
  const result = await probeModel(probeDeps(async function* () {
    yield { type: 'reasoning-delta', index: 0, text: 'partial thought' };
    throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  }), PROBE_ROUTE);
  assert.equal(result.ok, true);
  assert.equal(result.detail.code, 'PROBE_OK');
  assert.equal(result.detail.streamError.cause, 'ECONNRESET');
});

test('a throwing probe leaves the model layer unproven instead of failing the whole report', async () => {
  const { dir, deps } = await harness({
    probe: async () => { throw Object.assign(new Error('llm unavailable'), { code: 'LLM_UNAVAILABLE' }); },
  });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.modelResponse.ok, null);
    assert.equal(report.modelResponse.detail.code, 'PROBE_UNAVAILABLE');
    assert.equal(report.modelResponse.detail.cause, 'LLM_UNAVAILABLE');
    // The layers that were decided stay decided.
    assert.equal(report.transport.ok, true);
    assert.equal(report.authentication.ok, true);
    assert.equal(report.catalog.ok, true);
  } finally {
    await cleanup(dir);
  }
});

test('the report states a budget ending as a budget fact on a working model', async () => {
  const { dir, deps } = await harness({
    probe: fakeProbe({
      ok: true,
      detail: { code: 'PROBE_OK', finishReason: 'max-tokens', reasoningOnly: false, maxTokens: 2048, budgetExhausted: true },
      text: 'rea',
      reasoningOnly: false,
      reasoningChars: 0,
      tokens: { inputTokens: 9, outputTokens: 2048, reasoningTokens: null },
    }),
  });
  try {
    const report = await checkProviderConnectivity(deps, { providerId: 'relay' });
    assert.equal(report.modelResponse.ok, true);
    assert.equal(report.modelResponse.response.finishReason, 'max-tokens');
    assert.equal(report.modelResponse.response.budgetExhausted, true);
    assert.match(report.modelResponse.response.note, /budget/);
  } finally {
    await cleanup(dir);
  }
});

test('finish reasons are normalized across the spellings a harness or provider may use', () => {
  assert.equal(normalizeFinishReason({ kind: 'max-tokens' }), 'max-tokens');
  assert.equal(normalizeFinishReason('max_tokens'), 'max-tokens');
  assert.equal(normalizeFinishReason('length'), 'max-tokens');
  assert.equal(normalizeFinishReason({ kind: 'stop' }), 'stop');
  assert.equal(normalizeFinishReason('end_turn'), 'stop');
  assert.equal(normalizeFinishReason(undefined), null);
  // An unknown reason that still carried content is an answer, not a failure.
  const unknown = classifyProbeResponse({ text: 'ready', reasoningText: '', finishKind: 'some-provider-reason' });
  assert.equal(unknown.ok, true);
});
