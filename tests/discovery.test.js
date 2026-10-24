// Remote model discovery: unit contract + the `/models` user-plane route.
//
// Everything here runs against a real `node:http` server on loopback, not a
// `fetch` double, because the properties this feature has to hold are network
// properties: which URL is addressed, which credential reaches it, whether a
// redirect is followed, whether a body is bounded, whether an early exit releases
// the socket. A mocked `fetch` would assert this module's own intentions back to
// itself.
//
// The credential used everywhere below is a dummy literal that exists only in this
// file. No real key is read, resolved or needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  DISCOVERY_CODES,
  MAX_DISCOVERY_BODY_BYTES,
  MAX_MODEL_ID_CHARS,
  isDiscoverableModelId,
  mergeDiscoveredModels,
  modelsUrlFor,
  parseModelList,
  discoverProviderModels,
} from '../src/model/discovery.js';
import { USER_PLANE_PREFIX, wrapUserPlaneRoutes } from '../src/http/user-plane.js';
import { SettingsService } from '../src/config/settings.js';
import { LIMITS } from '../src/config/defaults.js';
import { cleanup, makeTempDir } from './helpers/fakes.js';

/** The only credential value in this file. Not a key, and not usable anywhere. */
const DUMMY_KEY = 'sk-dummy-test-value-not-a-real-key';

// ---------------------------------------------------------------------------
// Deterministic loopback server
// ---------------------------------------------------------------------------

/**
 * Start one loopback server whose behaviour is supplied per test.
 *
 * The handler receives `{ req, res, url, body }` and may answer however it likes.
 * Every request is recorded with its method, path, query and the `authorization`
 * header *as received*, which is how the tests prove the selected credential
 * arrived — and that nothing else did.
 *
 * When `t` (the test context) is passed, the same server is registered in
 * `t.after` and needs no `close()` in the test body. That registration is what
 * keeps the file's process from outliving its last assertion: a listening
 * `http.Server` is a live handle, so a fixture that is never closed keeps the
 * test child running forever. Prefer this form in every test; the explicit
 * `close()` returned below exists for the one case that must close early.
 * @param {(ctx: { req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, url: URL, index: number }) => void | Promise<void>} handler - request handler.
 * @param {import('node:test').TestContext} [t] - test context; when given, the server is closed automatically.
 * @returns {Promise<{ baseUrl: string, origin: string, requests: object[], close: () => Promise<void> }>} server facts.
 */
async function startServer(handler, t = null) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const record = {
      method: req.method,
      path: url.pathname,
      search: url.search,
      authorization: req.headers.authorization ?? null,
      host: req.headers.host ?? null,
      accept: req.headers.accept ?? null,
    };
    requests.push(record);
    void Promise.resolve(handler({ req, res, url, index: requests.length - 1 })).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  // A listen/accept error would otherwise be an unhandled `'error'` event.
  const failed = once(server, 'error').then(([error]) => error, () => new Error('server failed'));
  server.listen(0, '127.0.0.1');
  const [error] = await Promise.race([once(server, 'listening').then(() => [null]), failed]);
  if (error !== null) throw error;
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  let closed = false;
  /**
   * Close once and only once: `t.after` may close after the test body (or the
   * early-close test) already did, and `server.close()` is not idempotent-safe
   * for a second callback.
   * @returns {Promise<void>} resolves when the listener is released.
   */
  const close = () => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise((resolvePromise) => {
      server.closeAllConnections?.();
      server.close(() => resolvePromise());
    });
  };
  if (t !== null && typeof t.after === 'function') t.after(close);
  return { origin, baseUrl: `${origin}/v1`, requests, close };
}

/**
 * A credential gateway that answers for one reference and records every call.
 * @param {object} [table] - `{ [reference]: string }`.
 * @returns {object} gateway with `resolved` history.
 */
function fakeCredentials(table = { DSH_DELEGATE_RELAY_KEY: DUMMY_KEY }) {
  const resolved = [];
  return {
    resolved,
    async describe(ref) {
      return { configured: typeof table[ref] === 'string', writable: true };
    },
    async resolve(ref) {
      resolved.push(ref);
      const value = table[ref];
      return value === undefined ? undefined : { value, source: 'test' };
    },
    async set() {},
    async unset() {},
  };
}

/** A provider profile pointed at one loopback origin. */
function profileFor(server, overrides = {}) {
  return {
    id: 'relay',
    name: 'Local relay',
    protocol: 'openai-chat',
    baseUrl: server.baseUrl,
    credentialRef: 'DSH_DELEGATE_RELAY_KEY',
    models: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

test('the model URL keeps the configured /v1 prefix and adds no trailing slash', () => {
  assert.equal(modelsUrlFor('https://api.example.com/v1').href, 'https://api.example.com/v1/models');
  assert.equal(modelsUrlFor('https://api.example.com/v1/').href, 'https://api.example.com/v1/models');
  assert.equal(modelsUrlFor('https://api.example.com').href, 'https://api.example.com/models');
  assert.equal(modelsUrlFor('http://127.0.0.1:3210/v1').href, 'http://127.0.0.1:3210/v1/models');
  // A gateway that already spells the path is not doubled.
  assert.equal(modelsUrlFor('https://gw.example.com/v1/models').href, 'https://gw.example.com/v1/models');
  assert.equal(modelsUrlFor('https://gw.example.com/openai/v1').href, 'https://gw.example.com/openai/v1/models');
});

test('an unusable base URL is refused before any request is made', () => {
  for (const bad of ['not-a-url', 'ftp://example.com/v1', 'https://user:pass@example.com/v1', 'https://example.com/v1?key=1']) {
    assert.throws(() => modelsUrlFor(bad), (error) => error.code === DISCOVERY_CODES.baseUrlInvalid, bad);
  }
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

test('only the documented { data: [{ id }] } shape is accepted', () => {
  const parsed = parseModelList({
    object: 'list',
    data: [
      { id: 'model-a', object: 'model', owned_by: 'vendor', capabilities: { reasoning: true } },
      { id: 'model-b' },
    ],
  });
  assert.deepEqual(parsed.models, [
    { id: 'model-a', efforts: [] },
    { id: 'model-b', efforts: [] },
  ]);
  // Upstream metadata never survives: `owned_by`, capabilities and any other
  // field are dropped, so nothing the endpoint invented can reach a settings UI.
  assert.deepEqual(Object.keys(parsed.models[0]), ['id', 'efforts']);

  for (const wrong of [[], null, 'list', { models: [{ id: 'a' }] }, { data: { id: 'a' } }, { data: 'a' }]) {
    assert.throws(() => parseModelList(wrong), (error) => error.code === DISCOVERY_CODES.malformedResponse);
  }
  // A list whose rows all lack a usable id is a malformed answer, not an empty catalog.
  assert.throws(
    () => parseModelList({ data: [{ name: 'x' }, {}, null] }),
    (error) => error.code === DISCOVERY_CODES.malformedResponse,
  );
  // A genuinely empty list is legal and is reported as such.
  assert.deepEqual(parseModelList({ data: [] }).models, []);
});

test('ids are deduplicated, sanitized and bounded to the settings limit', () => {
  const ok = parseModelList({
    data: [
      { id: 'a' },
      { id: 'a' },
      { id: 'b' },
      { id: '' },
      { id: '   ' },
      { id: 'has space' },
      { id: 'ctrl\u0001char' },
      { id: 42 },
      { id: 'x'.repeat(MAX_MODEL_ID_CHARS + 1) },
    ],
  });
  assert.deepEqual(ok.models.map((model) => model.id), ['a', 'b']);
  assert.equal(ok.duplicates, 1);
  assert.equal(ok.invalid, 6);

  const many = parseModelList({ data: Array.from({ length: LIMITS.manualModelsPerProvider + 5 }, (_, index) => ({ id: `m${index}` })) });
  assert.equal(many.models.length, LIMITS.manualModelsPerProvider);
  assert.equal(many.truncated, 5);

  assert.equal(isDiscoverableModelId('deepseek-v4.1-flash'), true);
  assert.equal(isDiscoverableModelId('vendor/model:2025-01'), true);
  assert.equal(isDiscoverableModelId(' padded'), false);
  assert.equal(isDiscoverableModelId(''), false);
  assert.equal(isDiscoverableModelId('x'.repeat(MAX_MODEL_ID_CHARS)), true);
});

test('merging discovery keeps declared capabilities and manual-only entries', () => {
  const declared = [
    { id: 'declared-with-efforts', efforts: ['low', 'high'], contextWindow: 131072 },
    { id: 'manual-only', efforts: [] },
  ];
  const merged = mergeDiscoveredModels(declared, [{ id: 'declared-with-efforts', efforts: [] }, { id: 'new-ish', efforts: [] }]);
  assert.deepEqual(merged.models.map((model) => model.id), ['declared-with-efforts', 'manual-only', 'new-ish']);
  // Discovery cannot lend capability to a declared model…
  assert.deepEqual(merged.models[0].efforts, ['low', 'high']);
  assert.equal(merged.models[0].contextWindow, 131072, 'a declared context window survives a merge');
  // …and cannot remove a manual-only entry the endpoint does not list.
  assert.deepEqual(merged.models[1], { id: 'manual-only', efforts: [] });
  // A new id arrives with no claimed capability at all.
  assert.deepEqual(merged.models[2], { id: 'new-ish', efforts: [] });
  assert.deepEqual(merged.added, ['new-ish']);
  assert.deepEqual(merged.kept, ['manual-only']);
  assert.deepEqual(merged.declaredEffortModelIds, ['declared-with-efforts']);
  // The input is not mutated: the route never writes to the operator's document.
  assert.deepEqual(declared.map((model) => model.id), ['declared-with-efforts', 'manual-only']);
});

// ---------------------------------------------------------------------------
// The upstream request, against a real loopback server
// ---------------------------------------------------------------------------

test('an empty configured provider discovers real ids and authenticates its own reference', async (t) => {
  const server = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'discovered-a' }, { id: 'discovered-b', owned_by: 'vendor' }] }));
  }, t);
  const credentials = fakeCredentials();
  const outcome = await discoverProviderModels({ provider: profileFor(server), credentials });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.models, [{ id: 'discovered-a', efforts: [] }, { id: 'discovered-b', efforts: [] }]);
  assert.equal(outcome.facts.source, 'remote');
  assert.equal(outcome.facts.capabilities, 'listing-does-not-establish-reasoning-support');

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, 'GET');
  assert.equal(server.requests[0].path, '/v1/models');
  assert.equal(server.requests[0].search, '');
  assert.equal(server.requests[0].authorization, `Bearer ${DUMMY_KEY}`);
  assert.deepEqual(credentials.resolved, ['DSH_DELEGATE_RELAY_KEY']);
});

test('the credential never appears in a result, a failure or a log-visible field', async (t) => {
  const server = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a' }] }));
  }, t);
  const refusing = await startServer(({ res }) => {
    // A hostile endpoint that echoes the key back in the body and the header.
    res.writeHead(401, { 'content-type': 'application/json', 'x-echo': DUMMY_KEY });
    res.end(JSON.stringify({ error: { message: `invalid key ${DUMMY_KEY}`, hint: DUMMY_KEY } }));
  }, t);
  const success = await discoverProviderModels({ provider: profileFor(server), credentials: fakeCredentials() });
  assert.equal(JSON.stringify(success).includes(DUMMY_KEY), false);

  const failure = await discoverProviderModels({ provider: profileFor(refusing), credentials: fakeCredentials() });
  assert.equal(failure.ok, false);
  assert.equal(failure.diagnosis.code, DISCOVERY_CODES.authRefused);
  assert.equal(JSON.stringify(failure).includes(DUMMY_KEY), false);
  assert.equal(JSON.stringify(failure).includes('invalid key'), false, 'no upstream message is forwarded');
  assert.equal(JSON.stringify(failure).includes(refusing.origin), false, 'no upstream URL is forwarded');
  // A detail may name the reference (a variable name is not a secret) but never
  // its value or its length.
  assert.equal(failure.diagnosis.details.reference, 'DSH_DELEGATE_RELAY_KEY');
  assert.equal('body' in failure.diagnosis.details, false);
});

test('a redirect is refused and never followed, so the key stays on the configured host', async (t) => {
  const elsewhere = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'stolen' }] }));
  }, t);
  const redirecting = await startServer(({ res }) => {
    res.writeHead(302, { location: `${elsewhere.origin}/v1/models` });
    res.end();
  }, t);
  const outcome = await discoverProviderModels({ provider: profileFor(redirecting), credentials: fakeCredentials() });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.diagnosis.code, DISCOVERY_CODES.redirectRefused);
  assert.equal(elsewhere.requests.length, 0, 'the redirect target must never receive a request');
  assert.equal(JSON.stringify(outcome).includes(elsewhere.origin), false, 'the redirect target is not reported');
});

test('HTTP failures and auth refusals are distinct, stable and body-free', async (t) => {
  const cases = [
    [401, DISCOVERY_CODES.authRefused],
    [403, DISCOVERY_CODES.authRefused],
    [404, DISCOVERY_CODES.httpError],
    [500, DISCOVERY_CODES.httpError],
    [429, DISCOVERY_CODES.httpError],
  ];
  for (const [status, code] of cases) {
    const server = await startServer(({ res }) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `upstream says ${DUMMY_KEY}` } }));
    }, t);
    const outcome = await discoverProviderModels({ provider: profileFor(server), credentials: fakeCredentials() });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.diagnosis.code, code, `status ${status}`);
    assert.equal(outcome.diagnosis.details.status, status);
    assert.equal(JSON.stringify(outcome).includes(DUMMY_KEY), false);
    assert.equal(JSON.stringify(outcome).includes('upstream says'), false);
  }
});

test('a malformed answer is refused without quoting it', async (t) => {
  const bodies = [
    ['text/html', '<html><body>gateway error</body></html>'],
    ['application/json', '{"models":[{"id":"a"}]}'],
    ['application/json', '[{"id":"a"}]'],
    ['application/json', '{"data":[{"name":"nope"}]}'],
    ['application/json', '{not json'],
  ];
  for (const [type, body] of bodies) {
    const server = await startServer(({ res }) => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    }, t);
    const outcome = await discoverProviderModels({ provider: profileFor(server), credentials: fakeCredentials() });
    assert.equal(outcome.ok, false, body);
    assert.equal(outcome.diagnosis.code, DISCOVERY_CODES.malformedResponse, body);
    assert.equal(JSON.stringify(outcome).includes('gateway error'), false);
  }
});

test('an oversized body is cut off at the bound instead of buffered', async (t) => {
  const server = await startServer(({ res }) => {
    // No content-length: the bound has to come from the read, not from a header.
    // The rows are written with backpressure ignored, so the client's own cap (and
    // its cancel) is what has to end the transfer.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"data":[');
    const row = `{"id":"${'x'.repeat(2048)}"},`;
    for (let sent = 0; sent < MAX_DISCOVERY_BODY_BYTES * 2; sent += row.length) res.write(row);
    res.end('{"id":"tail"}]}');
  }, t);
  const outcome = await discoverProviderModels({ provider: profileFor(server), credentials: fakeCredentials() });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.diagnosis.code, DISCOVERY_CODES.bodyTooLarge);
  assert.equal(outcome.diagnosis.details.limitBytes, MAX_DISCOVERY_BODY_BYTES);
});

test('a declared content-length above the bound is refused before reading', async (t) => {
  let finished = false;
  const server = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(MAX_DISCOVERY_BODY_BYTES + 10) });
    res.write('{"data":[');
    res.end(']}');
    finished = true;
  }, t);
  const outcome = await discoverProviderModels({ provider: profileFor(server), credentials: fakeCredentials() });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.diagnosis.code, DISCOVERY_CODES.bodyTooLarge);
  assert.equal(finished, true, 'the endpoint answered; the client refused its size');
});

test('a silent endpoint times out with a bounded, distinct code', async () => {
  const server = await startServer(() => {
    // Never answers. The client's own bound has to end the request.
  });
  try {
    const started = Date.now();
    const outcome = await discoverProviderModels({
      provider: profileFor(server),
      credentials: fakeCredentials(),
      timeoutMs: 150,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.diagnosis.code, DISCOVERY_CODES.timeout);
    assert.ok(Date.now() - started < 5000, 'the bound must actually end the wait');
  } finally {
    await server.close();
  }
});

test('caller cancellation aborts the request and is reported as cancellation', async () => {
  const server = await startServer(() => {
    // Never answers.
  });
  try {
    const controller = new AbortController();
    const pending = discoverProviderModels({
      provider: profileFor(server),
      credentials: fakeCredentials(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.diagnosis.code, DISCOVERY_CODES.cancelled);
  } finally {
    await server.close();
  }
});

test('an unreachable endpoint is a network failure, not a fabricated empty list', async () => {
  // Bind and close a server so the port is known and refused.
  const server = await startServer(({ res }) => res.end());
  const baseUrl = server.baseUrl;
  await server.close();
  const outcome = await discoverProviderModels({
    provider: { ...profileFor(server), baseUrl },
    credentials: fakeCredentials(),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.diagnosis.code, DISCOVERY_CODES.networkFailed);
  // The refusal names no host: the operator's own address is not published.
  assert.equal(JSON.stringify(outcome).includes(baseUrl), false);
});

test('a missing credential is refused before any network I/O', async (t) => {
  const server = await startServer(({ res }) => res.end(JSON.stringify({ data: [] })), t);
  try {
    const missingRef = await discoverProviderModels({
      provider: profileFor(server, { credentialRef: null }),
      credentials: fakeCredentials(),
    });
    assert.fail(`expected a refusal, got ${JSON.stringify(missingRef)}`);
  } catch (error) {
    assert.equal(error.code, DISCOVERY_CODES.credentialRefMissing);
  }

  const notConfigured = await discoverProviderModels({
    provider: profileFor(server),
    credentials: fakeCredentials({}),
  });
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.diagnosis.code, DISCOVERY_CODES.credentialNotConfigured);

  const blank = await discoverProviderModels({
    provider: profileFor(server),
    credentials: fakeCredentials({ DSH_DELEGATE_RELAY_KEY: '   ' }),
  });
  assert.equal(blank.ok, false);
  assert.equal(blank.diagnosis.code, DISCOVERY_CODES.credentialEmpty);

  const noSeam = await discoverProviderModels({ provider: profileFor(server), credentials: null });
  assert.equal(noSeam.ok, false);
  assert.equal(noSeam.diagnosis.code, DISCOVERY_CODES.credentialSeamUnavailable);

  const seamFails = await discoverProviderModels({
    provider: profileFor(server),
    credentials: { async resolve() { throw Object.assign(new Error(`backend said ${DUMMY_KEY}`), { code: 'DENIED' }); } },
  });
  assert.equal(seamFails.ok, false);
  assert.equal(seamFails.diagnosis.code, DISCOVERY_CODES.credentialUnavailable);
  assert.equal(JSON.stringify(seamFails).includes(DUMMY_KEY), false);

  assert.equal(server.requests.length, 0, 'no credential means no request');
  assert.equal(JSON.stringify([notConfigured, blank, noSeam, seamFails]).includes(DUMMY_KEY), false);
});

// ---------------------------------------------------------------------------
// The `/models` route
// ---------------------------------------------------------------------------

/**
 * Build a user-plane fixture whose single provider points at one loopback server.
 *
 * The temp data directory is removed in `t.after`, so a test that throws before
 * its own cleanup still leaves nothing behind.
 * @param {object} server - loopback server from {@link startServer}.
 * @param {object} [overrides] - provider profile overrides.
 * @param {import('node:test').TestContext} [t] - test context; when given, the data directory is removed automatically.
 * @returns {Promise<object>} `{ dir, deps, settings, credentials }`.
 */
async function routeFixture(server, overrides = {}, t = null) {
  const dir = await makeTempDir();
  if (t !== null && typeof t.after === 'function') t.after(() => cleanup(dir));
  const settings = new SettingsService(dir);
  const credentials = fakeCredentials();
  const provider = profileFor(server, overrides);
  await settings.replace({
    schemaVersion: 1,
    providers: [provider],
    // An empty provider has no model to select yet: the worker block is the
    // documented "not chosen" state, which is exactly the configuration this
    // feature exists for.
    worker: { providerId: null, model: null, reasoningEffort: null, timeoutSeconds: 600, maxParallelism: 1, isolation: 'shared' },
    review: { enabled: false },
    authorization: { taskGrantTtlSeconds: 900, sessionGrantTtlSeconds: 3600 },
  });
  const deps = {
    settings,
    credentials,
    logger: { warn() {} },
    engine: { posture: () => ({ authorized: false }), list: () => [], get: () => null, cancel: async () => null },
    auth: { listConnections: () => [], listGrants: () => [] },
  };
  return { dir, deps, settings, credentials, provider };
}

/**
 * Call one user-plane route directly.
 * @param {object[]} routes - wrapped routes.
 * @param {string} method - HTTP method.
 * @param {string} path - exact path.
 * @param {object} [body] - JSON body.
 * @returns {Promise<{ status: number, body: object, text: string }>} response.
 */
async function post(routes, method, path, body) {
  const route = routes.find((entry) => entry.path === path);
  assert.ok(route !== undefined, `${path} must be registered`);
  const request = new Request(`http://127.0.0.1:3210${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
  const response = await route.fetch(request);
  const text = await response.text();
  return { status: response.status, text, body: text === '' ? null : JSON.parse(text) };
}

test('POST /models on an empty configured provider returns the provider\'s real ids', async () => {
  const server = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'remote-one', capabilities: { reasoning: { efforts: ['max'] } } }, { id: 'remote-two' }] }));
  });
  const { dir, deps } = await routeFixture(server);
  try {
    // A native llm double that would answer a *configured catalog* query. It must
    // not be consulted: `/models` is remote discovery now.
    const llmCalls = [];
    deps.llm = {
      listProviders: () => [],
      async listModels(id) { llmCalls.push(['listModels', id]); return [{ id: 'native-only' }]; },
      async resolveModelInfo(id, model) { llmCalls.push(['resolveModelInfo', id, model]); return { id: model, name: model }; },
    };

    const result = await post(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.providerId, 'relay');
    assert.equal(result.body.source, 'remote');
    assert.equal(result.body.error, null);
    assert.deepEqual(result.body.models, [{ id: 'remote-one', efforts: [] }, { id: 'remote-two', efforts: [] }]);
    assert.deepEqual(result.body.secrets, { values_returned: false });
    // Arbitrary upstream capability metadata is dropped, never trusted: one
    // discovered model carries exactly `{ id, efforts }` and nothing else.
    assert.deepEqual(Object.keys(result.body.models[0]), ['id', 'efforts']);
    assert.equal(result.body.models[0].efforts.length, 0, 'a listing cannot lend a reasoning effort');
    assert.equal(JSON.stringify(result.body.discovery.details).includes('efforts":["max"]'), false);
    assert.equal(JSON.stringify(result.body).includes('native-only'), false);
    assert.deepEqual(llmCalls, [], 'discovery must not go through the native catalog');
    assert.equal(result.body.discovery.failed, false);
    assert.equal(result.body.discovery.details.source, 'remote');
    assert.equal(result.text.includes(DUMMY_KEY), false);

    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].path, '/v1/models');
    assert.equal(server.requests[0].authorization, `Bearer ${DUMMY_KEY}`);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test('POST /models of one provider uses only that provider\'s credential reference', async () => {
  const server = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'shared-model' }] }));
  });
  const dir = await makeTempDir();
  try {
    const settings = new SettingsService(dir);
    await settings.replace({
      schemaVersion: 1,
      providers: [
        { id: 'alpha', name: 'Alpha', protocol: 'openai-chat', baseUrl: server.baseUrl, credentialRef: 'ALPHA_KEY', models: [] },
        { id: 'beta', name: 'Beta', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1', credentialRef: 'BETA_KEY', models: [] },
      ],
      worker: { providerId: null },
      review: { enabled: false },
    });
    const credentials = fakeCredentials({ ALPHA_KEY: `${DUMMY_KEY}-alpha`, BETA_KEY: `${DUMMY_KEY}-beta` });
    const deps = { settings, credentials, logger: { warn() {} } };

    const result = await post(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'alpha' });
    assert.equal(result.body.source, 'remote');
    assert.deepEqual(credentials.resolved, ['ALPHA_KEY'], 'only the selected profile\'s reference is resolved');
    assert.equal(server.requests[0].authorization, `Bearer ${DUMMY_KEY}-alpha`);
    assert.equal(result.text.includes(`${DUMMY_KEY}-alpha`), false);
    assert.equal(result.text.includes('BETA_KEY'), false);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test('POST /models reports a discovery failure as a diagnosis and keeps configuration usable', async () => {
  const server = await startServer(({ res }) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end(`upstream exploded while checking ${DUMMY_KEY}`);
  });
  const { dir, deps, settings } = await routeFixture(server, {
    models: [{ id: 'manual-model', efforts: ['medium'] }],
  });
  try {
    const before = await settings.read();
    const result = await post(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(result.status, 200, 'a discovery failure is a diagnosis, not a broken request');
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.models, [], 'no fake list is produced');
    assert.equal(result.body.error.code, DISCOVERY_CODES.httpError);
    assert.equal(result.body.discovery.failed, true);
    assert.equal(result.body.discovery.code, DISCOVERY_CODES.httpError);
    assert.equal(result.text.includes(DUMMY_KEY), false);
    assert.equal(result.text.includes('upstream exploded'), false);
    // Read-only: the stored document is untouched, so the manual model survives.
    const after = await settings.read();
    assert.deepEqual(after.providers[0].models, before.providers[0].models);
    assert.deepEqual(after.providers[0].models, [{ id: 'manual-model', efforts: ['medium'], contextWindow: null }]);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test('POST /models answers for a provider with no native route and no route fallback', async () => {
  const server = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'still-discovered' }] }));
  });
  const { dir, deps } = await routeFixture(server);
  try {
    // No `ensureRoutes`/`resolveRoutes` at all: native registration is impossible
    // here, exactly as in a host without an llm service.
    const result = await post(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(result.body.route, null, 'no route is invented for discovery');
    assert.deepEqual(result.body.models.map((model) => model.id), ['still-discovered']);

    // A refused registration is also unaffected: discovery is independent of it.
    deps.ensureRoutes = async () => {
      throw Object.assign(new Error('registration refused'), { code: 'provider_registry' });
    };
    const again = await post(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(again.body.route, null);
    assert.deepEqual(again.body.models.map((model) => model.id), ['still-discovered']);
    assert.equal(again.body.registration, null, 'discovery reports no registration claim');
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test('POST /models reports the registered route when one exists, and never the profile id', async () => {
  const server = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'covered' }] }));
  });
  const { dir, deps } = await routeFixture(server);
  try {
    deps.resolveRoutes = async () => ({ routes: new Map([['relay', 'dsh-delegate:relay']]), error: null });
    const mapped = await post(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(mapped.body.route, 'dsh-delegate:relay');

    deps.resolveRoutes = async () => ({ routes: new Map(), error: { code: 'provider_registry', message: 'refused' } });
    const unmapped = await post(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(unmapped.body.route, null, 'an unregistered provider never answers with its profile id');
    assert.equal(unmapped.body.models.length, 1, 'discovery still works without a native route');
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test('POST /models refuses an unknown provider without making a request', async () => {
  const server = await startServer(({ res }) => res.end(JSON.stringify({ data: [] })));
  const { dir, deps } = await routeFixture(server);
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const missing = await post(routes, 'POST', `${USER_PLANE_PREFIX}/models`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'PROVIDER_ID_REQUIRED');

    const unknown = await post(routes, 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'nope' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PROVIDER_UNKNOWN');
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
    await cleanup(dir);
  }
});

test('a body that hands back upstream metadata cannot smuggle it into the route answer', async () => {
  const server = await startServer(({ res }) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'secret-ish-header' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{
        id: 'plain-model',
        object: 'model',
        created: 1700000000,
        owned_by: 'vendor',
        permission: [{ id: 'perm-1', allow_create_engine: true }],
        capabilities: { reasoning: { efforts: ['max'], defaultEffort: 'max' }, context: 999999 },
      }],
    }));
  });
  const { dir, deps } = await routeFixture(server);
  try {
    const result = await post(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    // Exactly one field per model, and it is the id that was asked for.
    assert.deepEqual(result.body.models, [{ id: 'plain-model', efforts: [] }]);
    // Nothing from the upstream row survives — checked against the *models* payload,
    // not the whole body, which legitimately carries this plugin's own explanation
    // of why a listing says nothing about capabilities.
    const modelsJson = JSON.stringify(result.body.models);
    for (const leaked of ['owned_by', 'permission', 'created', 'reasoning', '"max"', 'vendor', '999999']) {
      assert.equal(modelsJson.includes(leaked), false, `${leaked} must not be forwarded`);
    }
    assert.equal(result.text.includes('secret-ish-header'), false, 'upstream headers are not reported');
  } finally {
    await server.close();
    await cleanup(dir);
  }
});
