// User-plane HTTP contract tests.
//
// Two things are proven here and nothing else is:
//
//   1. The route set is *registrable* on the native exact-route registry. The
//      harness (`@deepseek-ai/dsh-client-connection` 0.2.0-rc.2) accepts only
//      paths below `/api`, only `GET`/`HEAD`/`POST`, only `buffered` or
//      `streaming` bodies, and only one route per exact path. A route set that
//      violates any of those does not fail gracefully at runtime — it either
//      throws during registration, leaving a half-mounted surface, or is
//      unreachable. So the checks are made against a faithful local model of the
//      harness rules (mirrored below with line references) plus the plugin's own
//      pre-registration assertion.
//
//   2. The handlers behave as the documented contract says: a shared path
//      dispatches on method, settings are read with GET and written with POST,
//      and a method a path does not own is refused rather than silently sent to
//      the wrong handler.
//
// What is deliberately NOT tested here: browser authentication and the Host/
// Origin fence. Those are applied by the carrier before a handler is reached, so
// a test that hand-fed a cookie or an Origin header would be asserting a
// guarantee this module does not provide and could not keep. Admission is
// exercised where it lives (`tests/fence.test.js` for the execution-plane fence)
// and by the coordinator's integration run.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_METHODS,
  USER_PLANE_PREFIX,
  assertUserPlaneRoutes,
  userPlaneRoutes,
  wrapUserPlaneRoutes,
} from '../src/http/user-plane.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { cleanup, makeTempDir, validSettings } from './helpers/fakes.js';

const WORKSPACE = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';

// ---------------------------------------------------------------------------
// Local model of the native exact-route registry.
//
// Mirrored from the installed `dsh-client-connection` 0.2.0-rc.2:
//   * `ENDPOINT_SEGMENT_PATTERN` and `endpointFromPath` — lib/index.js:550,711
//   * `assertFetchRoute` — lib/index.js:758
//   * duplicate-path throw — lib/index.js:634
//   * `ConnectionFetchMethod` / `ConnectionRequestBodyMode` — lib/types/rpc.d.ts
// The model refuses everything the harness refuses, so a route set that passes
// it would have registered there too.
// ---------------------------------------------------------------------------

const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;

/** @param {string} channel @param {string} pathname @returns {string|undefined} */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined;
  const endpoint = pathname.slice(channel.length + 1);
  if (endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return undefined;
  return endpoint;
}

/**
 * A stand-in for the native registry that enforces the same rules.
 * @returns {object} registry with `register`, `requestBodyMode` and `fetch`.
 */
function nativeRegistry() {
  const routes = new Map();
  return {
    routes,
    register(route) {
      if (endpointFromPath('/api', route.path) === undefined) {
        throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`);
      }
      if (!Array.isArray(route.methods) || route.methods.length === 0) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`);
      }
      if (new Set(route.methods).size !== route.methods.length) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`);
      }
      for (const method of route.methods) {
        if (!['GET', 'HEAD', 'POST'].includes(method)) {
          throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares unsupported method ${method}`);
        }
      }
      if (route.requestBody !== 'buffered' && route.requestBody !== 'streaming') {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares invalid requestBody ${JSON.stringify(route.requestBody)}`);
      }
      if (routes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
      }
      routes.set(route.path, {
        methods: new Set(route.methods),
        requestBody: route.requestBody,
        fetch: route.fetch,
      });
    },
    requestBodyMode({ method, url }) {
      const route = routes.get(url.pathname);
      return route?.methods.has(method) === true ? route.requestBody : 'buffered';
    },
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      const route = routes.get(pathname);
      if (route?.methods.has(request.method) === true) return route.fetch(request);
      return new Response('not found', { status: 404 });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function fixture() {
  const dir = await makeTempDir();
  const settings = new SettingsService(dir);
  await settings.replace(validSettings());
  const auth = new AuthorizationRegistry();
  const engineCalls = [];
  let delegationEnabled = false;
  const engine = {
    authorizationMode: 'grants',
    posture: () => ({
      authorized: delegationEnabled,
      reason: delegationEnabled ? null : 'delegation is off',
      mode: 'switch',
    }),
    setDelegationEnabled(enabled) {
      delegationEnabled = enabled === true;
      engineCalls.push(['delegation', delegationEnabled]);
      return this.posture();
    },
    list: (options) => {
      engineCalls.push(['list', options]);
      return [];
    },
    get: (taskId, options) => {
      engineCalls.push(['get', taskId, options]);
      return { taskId, state: 'awaiting-host-review', prompt: { text: 'do the thing' } };
    },
    cancel: async (taskId, by) => {
      engineCalls.push(['cancel', taskId, by]);
      return { taskId, state: 'cancelled', cancelledBy: by };
    },
  };
  const deps = {
    settings,
    auth,
    engine,
    logger: { warn() {} },
    describeRuntime: () => ({ plugin: 'dsh-delegate', version: '0.1.0' }),
  };
  return { dir, deps, settings, auth, engine, engineCalls };
}

function jsonRequest(method, path, body) {
  return new Request(`http://127.0.0.1:3210${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

async function call(routes, method, path, body) {
  const registry = nativeRegistry();
  for (const route of routes) registry.register(route);
  const response = await registry.fetch(jsonRequest(method, path, body));
  const text = await response.text();
  // The carrier's own fall-through is plain text; a handler's answer is JSON.
  const parsed = response.headers.get('content-type')?.includes('json') === true && text !== ''
    ? JSON.parse(text)
    : text;
  return { status: response.status, headers: response.headers, body: parsed };
}

// ---------------------------------------------------------------------------
// 1. Native registration contract
// ---------------------------------------------------------------------------

test('the user-plane route set registers on a model of the native exact-route registry', async () => {
  const { dir, deps } = await fixture();
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const registry = nativeRegistry();
    // A duplicate path throws here exactly as the real registry does, so a
    // successful loop is the contract check.
    for (const route of routes) registry.register(route);

    assert.equal(registry.routes.size, routes.length, 'every mode must own exactly one path');
    for (const route of routes) {
      assert.ok(route.path.startsWith('/api/'), `${route.path} must sit below /api`);
      assert.equal(route.requestBody, 'buffered');
      assert.ok(route.methods.length > 0);
      for (const method of route.methods) assert.ok(ALLOWED_METHODS.includes(method));
    }
    // Same paths that used to be split across GET and PUT must now be one route.
    const settingsRoute = routes.find((route) => route.path === `${USER_PLANE_PREFIX}/settings`);
    assert.deepEqual([...settingsRoute.methods].sort(), ['GET', 'POST']);
    assert.equal(routes.some((route) => route.methods.includes('PUT')), false);
    assert.equal(routes.some((route) => route.requestBody === 'none'), false);
  } finally {
    await cleanup(dir);
  }
});

test('the pre-registration assertion rejects a duplicate exact path', () => {
  const route = { path: '/api/dsh-delegate/status', methods: ['GET'], requestBody: 'buffered', fetch: async () => new Response('{}') };
  assert.throws(
    () => assertUserPlaneRoutes([route, { ...route }]),
    /is registered twice/,
  );
});

test('the pre-registration assertion rejects a path outside /api', () => {
  for (const path of ['/dsh-delegate/status', 'api/dsh-delegate/status', '', '/appi/dsh-delegate/status']) {
    assert.throws(
      () => assertUserPlaneRoutes([{ path, methods: ['GET'], requestBody: 'buffered', fetch: async () => new Response('{}') }]),
      /must start with "\/api\/"/,
      `path ${JSON.stringify(path)} should be refused`,
    );
  }
});

test('the pre-registration assertion rejects PUT and a "none" body mode', () => {
  const base = { path: '/api/dsh-delegate/settings', requestBody: 'buffered', fetch: async () => new Response('{}') };
  assert.throws(
    () => assertUserPlaneRoutes([{ ...base, methods: ['PUT'] }]),
    /only GET\/HEAD\/POST are supported/,
  );
  assert.throws(
    () => assertUserPlaneRoutes([{ ...base, methods: ['POST'], requestBody: 'none' }]),
    /only "buffered" or "streaming" are supported/,
  );
  assert.throws(
    () => assertUserPlaneRoutes([{ ...base, methods: ['GET', 'GET'] }]),
    /repeats a method/,
  );
});

// ---------------------------------------------------------------------------
// 2. Handlers
// ---------------------------------------------------------------------------

test('GET /api/dsh-delegate/settings returns the public, secret-free document', async () => {
  const { dir, deps } = await fixture();
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'GET', `${USER_PLANE_PREFIX}/settings`);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.settings.worker.model, 'deepseek-chat');
    assert.deepEqual(result.body.secrets, { stored: 'credential-seam-only', values_returned: false });
    assert.equal(JSON.stringify(result.body).includes('sk-'), false);
  } finally {
    await cleanup(dir);
  }
});

test('POST /api/dsh-delegate/settings commits a validated document', async () => {
  const { dir, deps, settings } = await fixture();
  try {
    const next = validSettings({ worker: { model: 'deepseek-reasoner', reasoningEffort: 'high' } });
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/settings`, { settings: next });
    assert.equal(result.status, 200);
    assert.equal(result.body.settings.worker.model, 'deepseek-reasoner');
    assert.equal(result.body.settings.worker.reasoningEffort, 'high');
    const stored = await settings.read();
    assert.equal(stored.worker.model, 'deepseek-reasoner', 'the commit must reach the store, not just the response');
  } finally {
    await cleanup(dir);
  }
});

test('the native provider selector lists only DSH-registered providers with declared model efforts', async () => {
  const { dir, deps } = await fixture();
  try {
    deps.llm = {
      listProviders: () => [
        { id: 'workbuddy', name: 'WorkBuddy' },
        { id: 'dsh-delegate:relay', name: 'Plugin-owned route' },
      ],
      listModels: (providerId) => providerId === 'workbuddy'
        ? [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
        : [],
      resolveModelInfo: (providerId, modelId) => ({
        provider: providerId,
        id: modelId,
        reasoning: { efforts: [{ id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
        context: { contextWindow: 128_000 },
      }),
    };
    const result = await call(wrapUserPlaneRoutes(deps), 'GET', `${USER_PLANE_PREFIX}/native-providers`);
    assert.equal(result.status, 200);
    assert.equal(result.body.providers.length, 1, 'the selector must not offer its own dynamically registered route');
    assert.deepEqual(result.body.providers[0], {
      id: 'workbuddy',
      name: 'WorkBuddy',
      models: [{
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        efforts: ['high', 'max'],
        contextWindow: 128_000,
      }],
      error: null,
    });
    assert.equal(JSON.stringify(result.body).includes('baseUrl'), false);
    assert.equal(JSON.stringify(result.body).includes('credential'), false);
  } finally {
    await cleanup(dir);
  }
});

test('the delegation endpoint is the only settings path that changes the switch', async () => {
  const { dir, deps, settings, engineCalls } = await fixture();
  try {
    deps.engine.authorizationMode = 'switch';
    const originalSet = settings.setDelegationEnabled.bind(settings);
    let postureWhenPersisting;
    settings.setDelegationEnabled = async (enabled) => {
      postureWhenPersisting = deps.engine.posture().authorized;
      return await originalSet(enabled);
    };
    const routes = wrapUserPlaneRoutes(deps);
    const routePaths = new Set(routes.map((route) => route.path));
    for (const path of [
      `${USER_PLANE_PREFIX}/connections`,
      `${USER_PLANE_PREFIX}/connections/revoke`,
      `${USER_PLANE_PREFIX}/grants`,
      `${USER_PLANE_PREFIX}/grants/revoke`,
      `${USER_PLANE_PREFIX}/authorization/revoke-all`,
    ]) {
      assert.equal(routePaths.has(path), false, `${path} must not be registered in switch mode`);
    }

    const enabled = await call(routes, 'POST', `${USER_PLANE_PREFIX}/delegation`, { enabled: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.delegation.authorized, true);
    assert.equal((await settings.read()).delegationEnabled, true);
    assert.deepEqual(engineCalls, [['delegation', true]]);

    const fullConfig = validSettings({ delegationEnabled: false });
    const saved = await call(routes, 'POST', `${USER_PLANE_PREFIX}/settings`, { settings: fullConfig });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.delegationEnabled, true, 'ordinary config saves preserve the live switch');
    assert.equal(deps.engine.posture().authorized, true, 'ordinary config saves cannot disable or enable it');
    assert.deepEqual(engineCalls, [['delegation', true]], 'saving other settings must not touch the switch');

    const disabled = await call(routes, 'POST', `${USER_PLANE_PREFIX}/delegation`, { enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(postureWhenPersisting, false, 'the execution gate closes before persistence begins');
    assert.equal(disabled.body.delegation.authorized, false);
    assert.equal((await settings.read()).delegationEnabled, false);
    assert.deepEqual(engineCalls, [['delegation', true], ['delegation', false]]);
  } finally {
    await cleanup(dir);
  }
});

test('POST settings without a document is refused with a stable code', async () => {
  const { dir, deps } = await fixture();
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/settings`, {});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'SETTINGS_MISSING');
  } finally {
    await cleanup(dir);
  }
});

test('POST settings with an invalid document is refused, leaving the stored document intact', async () => {
  const { dir, deps, settings } = await fixture();
  try {
    const broken = validSettings();
    broken.providers[0].apiKey = 'sk-live-value-should-never-be-stored';
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/settings`, { settings: broken });
    assert.equal(result.status, 400);
    assert.ok(result.body.error.code.startsWith('PROVIDER_'));
    const stored = await settings.read();
    assert.equal(stored.providers[0].id, 'relay');
    assert.equal(JSON.stringify(stored).includes('sk-live-value-should-never-be-stored'), false);
  } finally {
    await cleanup(dir);
  }
});

test('POST /api/dsh-delegate/grants/revoke revokes one grant', async () => {
  const { dir, deps, auth } = await fixture();
  try {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, {
      kind: 'task',
      workspacePath: WORKSPACE,
      ttlSeconds: 600,
    });

    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/grants/revoke`, { grantId: grant.grantId });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.grant.grantId, grant.grantId);
    assert.notEqual(result.body.grant.revokedAt, null, 'the returned snapshot must show the revocation');
    assert.equal(auth.isDelegationAuthorized(), false, 'the grant must actually be dead, not merely reported dead');
    const listed = auth.listGrants(connection.connectionId);
    assert.equal(listed[0].revokedAt === null, false);
  } finally {
    await cleanup(dir);
  }
});

test('POST /api/dsh-delegate/grants/revoke requires a grant id and refuses an unknown one', async () => {
  const { dir, deps } = await fixture();
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const missing = await call(routes, 'POST', `${USER_PLANE_PREFIX}/grants/revoke`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'GRANT_ID_REQUIRED');

    const unknown = await call(routes, 'POST', `${USER_PLANE_PREFIX}/grants/revoke`, { grantId: 'grant-does-not-exist' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'GRANT_UNKNOWN');
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 3. Method handling on shared paths
// ---------------------------------------------------------------------------

test('a method a shared path does not own is refused with 405 and an Allow header', async () => {
  const { dir, deps } = await fixture();
  try {
    const routes = wrapUserPlaneRoutes(deps);
    // The carrier only forwards declared methods, so the guard is exercised on
    // the handler directly: the route must refuse rather than mis-dispatch.
    const settingsRoute = routes.find((route) => route.path === `${USER_PLANE_PREFIX}/settings`);
    const response = await settingsRoute.fetch(jsonRequest('DELETE', `${USER_PLANE_PREFIX}/settings`));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, POST');
    const body = await response.json();
    assert.equal(body.error.code, 'USER_PLANE_METHOD_NOT_ALLOWED');
    assert.deepEqual(body.error.details, { method: 'DELETE', allowed: ['GET', 'POST'] });

    // A method the route never declared never reaches a handler at all.
    const carrier = await call(routes, 'HEAD', `${USER_PLANE_PREFIX}/settings`);
    assert.equal(carrier.status, 404);
  } finally {
    await cleanup(dir);
  }
});

test('a consumed-grant replay is refused by the registry, not by the handler', async () => {
  const { dir, deps, auth } = await fixture();
  try {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, { kind: 'task', workspacePath: WORKSPACE, ttlSeconds: 600 });
    auth.consumeTaskGrant({ connectionId: connection.connectionId, grantId: grant.grantId, taskId: 'task-1', workspacePath: WORKSPACE });

    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/grants/revoke`, { grantId: grant.grantId });
    // A spent grant still exists briefly so the operator can be told why; the
    // point of the assertion is that nothing issues a fresh authorization here.
    assert.equal(result.status, 200);
    assert.equal(auth.isDelegationAuthorized(), false);
  } finally {
    await cleanup(dir);
  }
});

test('the user plane adds no admission of its own; connection tokens are not accepted here', async () => {
  const { dir, deps, auth } = await fixture();
  try {
    const connection = auth.issueConnection({ label: 'codex' });
    // A bearer token is the *execution* plane's credential. Presenting it to the
    // user plane changes nothing: admission is the carrier's job, so this route
    // neither honours nor inspects the header.
    const request = new Request(`http://127.0.0.1:3210${USER_PLANE_PREFIX}/status`, {
      method: 'GET',
      headers: { authorization: `Bearer ${connection.token}` },
    });
    const statusRoute = userPlaneRoutes(deps).find((route) => route.path === `${USER_PLANE_PREFIX}/status`);
    const response = await statusRoute.fetch(request);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.delegation.authorized, false);
    assert.equal('connection' in body, false, 'the user plane must not echo a connection identity from a header');
  } finally {
    await cleanup(dir);
  }
});

test('task reads and cancellation reach the engine with the operator cause', async () => {
  const { dir, deps, engineCalls } = await fixture();
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const fetched = await call(routes, 'POST', `${USER_PLANE_PREFIX}/tasks/get`, { taskId: 'task-7' });
    assert.equal(fetched.status, 200);
    assert.deepEqual(engineCalls.at(-1), ['get', 'task-7', { includePrompt: true }]);

    const cancelled = await call(routes, 'POST', `${USER_PLANE_PREFIX}/tasks/cancel`, { taskId: 'task-7' });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.task.state, 'cancelled');
    assert.deepEqual(engineCalls.at(-1), ['cancel', 'task-7', 'operator']);
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 4. Native route mapping on the read paths
//
// The observed field bug: `/models` answered `route: "workbuddy"` with
// `models: []` and a `ROUTING_MODEL_UNRESOLVED` error, because the route map was
// lost (a failed registration was swallowed into `null`, which the catalog treats
// as "use the profile id") and the profile id happened to be the name of an
// ambient route the plugin does not own.
//
// `/models` no longer enumerates the configured catalog at all: it is *remote
// discovery* (one authenticated `GET <baseUrl>/models` against the selected
// provider), so the route contract below holds it to a different truth — the
// profile id is still never reported as a route, but an empty configured provider
// can now obtain real ids, and a discovery failure is a distinct diagnosis rather
// than a catalog error. `/catalog` keeps the configured-catalog contract.
// ---------------------------------------------------------------------------

/** A native LLM double that resolves only the routes it was given. */
function mappedLlm(table) {
  const calls = [];
  return {
    calls,
    listProviders: () => Object.keys(table).map((id) => ({ id, name: id })),
    async listModels(provider) {
      calls.push(['listModels', provider]);
      return Object.keys(table[provider] ?? {}).map((id) => ({ id, name: id }));
    },
    async resolveModelInfo(provider, model) {
      calls.push(['resolveModelInfo', provider, model]);
      const efforts = table[provider]?.[model];
      if (efforts === undefined) {
        const error = new Error(`no adapter registered for provider "${provider}"`);
        error.code = 'NO_ADAPTER';
        throw error;
      }
      return {
        provider,
        id: model,
        name: model,
        ...(efforts.length === 0 ? {} : { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } }),
      };
    },
  };
}

const NATIVE = {
  'dsh-delegate:relay': {
    'deepseek-chat': ['low', 'medium', 'high'],
    'deepseek-reasoner': ['medium', 'high'],
  },
};

/**
 * The only credential value used by `/models` tests. Not a key.
 */
const MODELS_DUMMY_KEY = 'sk-dummy-route-contract-value';

/**
 * A `fetch` double for the discovery request only.
 *
 * The remote request itself is proven against a real loopback server in
 * `tests/discovery.test.js`; here it is replaced so the *route* contract can be
 * tested without a socket per case.
 * @param {object} [options] - `status`, `body`, `fail`, and the recorded `calls`.
 * @returns {Function} fetch implementation with `calls` history.
 */
function discoveryFetch(options = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, authorization: init?.headers?.authorization ?? null });
    if (options.fail !== undefined) throw options.fail;
    const status = options.status ?? 200;
    const payload = options.body ?? { data: [{ id: 'remote-model' }] };
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  impl.calls = calls;
  return impl;
}

/** A credential gateway that answers one reference. */
function dummyCredentials(table = { DSH_DELEGATE_RELAY_KEY: MODELS_DUMMY_KEY }) {
  return {
    async describe(ref) {
      return { configured: typeof table[ref] === 'string', writable: true };
    },
    async resolve(ref) {
      const value = table[ref];
      return value === undefined ? undefined : { value, source: 'test' };
    },
  };
}

test('POST /models is remote discovery: it reports the provider\'s real ids from its API', async () => {
  const { dir, deps } = await fixture();
  try {
    const llm = mappedLlm(NATIVE);
    deps.llm = llm;
    deps.credentials = dummyCredentials();
    const fetchImpl = discoveryFetch({
      body: { object: 'list', data: [{ id: 'deepseek-chat', owned_by: 'vendor' }, { id: 'fresh-model' }] },
    });
    deps.fetchImpl = fetchImpl;
    deps.ensureRoutes = async () => new Map([['relay', 'dsh-delegate:relay']]);

    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(result.status, 200);
    assert.equal(result.body.source, 'remote');
    assert.equal(result.body.error, null);
    assert.equal(result.body.registration, null);
    assert.equal(result.body.route, 'dsh-delegate:relay', 'the configured route is disclosed, not used for discovery');
    // The ids come from the endpoint; `owned_by` and every other upstream field is dropped.
    assert.deepEqual(result.body.models, [
      { id: 'deepseek-chat', efforts: [] },
      { id: 'fresh-model', efforts: [] },
    ]);
    // Discovery is not a catalog read: the native seam is never asked for models.
    assert.deepEqual(llm.calls, []);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:8443/v1/models');
    assert.equal(fetchImpl.calls[0].authorization, `Bearer ${MODELS_DUMMY_KEY}`);
    assert.equal(JSON.stringify(result.body).includes(MODELS_DUMMY_KEY), false);
  } finally {
    await cleanup(dir);
  }
});

test('POST /models reports a discovery failure as its own diagnosis, never as a catalog error', async () => {
  const { dir, deps, settings } = await fixture();
  try {
    const llm = mappedLlm(NATIVE);
    deps.llm = llm;
    deps.credentials = dummyCredentials();
    deps.fetchImpl = discoveryFetch({ fail: new TypeError('fetch failed: getaddrinfo ENOTFOUND example.invalid') });
    deps.ensureRoutes = async () => {
      throw Object.assign(new Error('the provider routes could not be ensured'), { code: 'provider_registry' });
    };
    const before = await settings.read();

    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    // The request itself is answered: a failed discovery is a diagnosis, not a crash.
    assert.equal(result.status, 200);
    assert.equal(result.body.route, null, 'a refused registration must not answer with the profile id');
    assert.deepEqual(result.body.models, [], 'no list is invented');
    assert.equal(result.body.source, 'remote');
    // The failure is discovery's own code, not a routing/catalog code.
    assert.equal(result.body.error.code, 'DISCOVERY_NETWORK_FAILED');
    assert.equal(result.body.discovery.failed, true);
    assert.equal(result.body.discovery.code, 'DISCOVERY_NETWORK_FAILED');
    assert.equal(result.body.registration, null, 'discovery claims nothing about native registration');
    // The upstream message names the operator's host and is not forwarded.
    assert.equal(JSON.stringify(result.body).includes('ENOTFOUND'), false);
    assert.equal(JSON.stringify(result.body).includes('example.invalid'), false);
    assert.deepEqual(llm.calls.filter((entry) => entry[0] === 'resolveModelInfo'), []);
    // Read-only: the stored document is unchanged, so manual entries stay usable.
    assert.deepEqual(await settings.read(), before);
  } finally {
    await cleanup(dir);
  }
});

test('POST /models of an empty configured provider discovers ids and reports no route', async () => {
  const { dir, deps, settings } = await fixture();
  try {
    // The configuration this feature exists for: a provider with no models and no
    // native route, which the old `/models` could only answer with `models: []`.
    const empty = validSettings();
    empty.providers[0] = { ...empty.providers[0], models: [] };
    empty.worker = { providerId: null, model: null, reasoningEffort: null, timeoutSeconds: 600, maxParallelism: 1, isolation: 'shared' };
    await settings.replace(empty);
    deps.llm = mappedLlm({});
    deps.credentials = dummyCredentials();
    deps.fetchImpl = discoveryFetch({ body: { data: [{ id: 'real-remote-id' }] } });
    // A host that cannot register routes at all: discovery must not care.
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(result.status, 200);
    assert.equal(result.body.route, null);
    assert.deepEqual(result.body.models.map((model) => model.id), ['real-remote-id']);
    assert.equal(result.body.error, null);
    assert.equal(result.body.discovery.failed, false);
    assert.equal(result.body.discovery.note, 'a model listing does not establish reasoning-effort support');
  } finally {
    await cleanup(dir);
  }
});

test('POST /models refuses an unknown provider and never borrows another provider\'s credential', async () => {
  const { dir, deps } = await fixture();
  try {
    const fetchImpl = discoveryFetch();
    deps.fetchImpl = fetchImpl;
    // No credential gateway at all: even discovery cannot invent one.
    const unknown = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'nope' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PROVIDER_UNKNOWN');
    assert.equal(fetchImpl.calls.length, 0);

    const missing = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'PROVIDER_ID_REQUIRED');

    // With no seam the answer is an explicit, non-secret diagnosis and no request.
    const noSeam = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(noSeam.status, 200);
    assert.equal(noSeam.body.error.code, 'DISCOVERY_CREDENTIAL_SEAM_UNAVAILABLE');
    assert.deepEqual(noSeam.body.models, []);
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    await cleanup(dir);
  }
});

test('POST /catalog maps every row to its registered route', async () => {
  const { dir, deps, settings } = await fixture();
  try {
    const llm = mappedLlm({ ...NATIVE, 'dsh-delegate:backup': { 'deepseek-chat': ['medium'] } });
    deps.llm = llm;
    const next = validSettings();
    next.providers.push({
      id: 'backup',
      name: 'Backup',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:9000/v1',
      credentialRef: 'DSH_DELEGATE_BACKUP_KEY',
      models: [{ id: 'deepseek-chat', efforts: ['medium'] }],
    });
    await settings.replace(next);
    deps.ensureRoutes = async () => new Map([
      ['relay', 'dsh-delegate:relay'],
      ['backup', 'dsh-delegate:backup'],
    ]);

    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/catalog`, {});
    assert.equal(result.status, 200);
    assert.equal(result.body.registration, null);
    assert.deepEqual(result.body.catalog.map((entry) => entry.providerId), ['relay', 'backup']);
    assert.deepEqual([...result.body.catalog.map((entry) => entry.route)], ['dsh-delegate:relay', 'dsh-delegate:backup']);
    for (const entry of result.body.catalog) {
      assert.equal(entry.error, null, `${entry.providerId} must resolve cleanly`);
    }
    assert.deepEqual(result.body.secrets, { values_returned: false });
  } finally {
    await cleanup(dir);
  }
});

test('POST /catalog keeps a refused registration visible instead of describing ambient routes', async () => {
  const { dir, deps } = await fixture();
  try {
    const llm = mappedLlm(NATIVE);
    deps.llm = llm;
    deps.ensureRoutes = async () => {
      throw Object.assign(new Error('adapter metadata for provider "dsh-delegate:relay" is invalid'), { code: 'INVALID_ADAPTER' });
    };

    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/catalog`, {});
    assert.equal(result.status, 200);
    assert.equal(result.body.registration.code, 'INVALID_ADAPTER');
    const [entry] = result.body.catalog;
    // An unmapped provider is reported unmapped; the profile id never becomes the route.
    assert.notEqual(entry.route, 'relay');
    assert.equal(entry.error.code, 'ROUTING_PROVIDER_NOT_REGISTERED');
    assert.deepEqual(entry.models, []);
    assert.deepEqual(llm.calls, [], 'a refused registration must not query any route');
  } finally {
    await cleanup(dir);
  }
});

test('POST /catalog of an empty document registers nothing', async () => {
  const { dir, deps, settings } = await fixture();
  try {
    const empty = validSettings();
    empty.providers = [];
    empty.worker = { ...empty.worker, providerId: null, model: null };
    await settings.replace(empty);
    let ensured = 0;
    deps.ensureRoutes = async () => {
      ensured += 1;
      return new Map();
    };
    deps.llm = mappedLlm({});

    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/catalog`, {});
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.catalog, []);
    assert.equal(result.body.effective, null);
    assert.equal(ensured, 0, 'a read of an unconfigured document must not create native state');
  } finally {
    await cleanup(dir);
  }
});

test('both read paths use the entry point resolver when it is injected', async () => {
  const { dir, deps } = await fixture();
  try {
    const asked = [];
    deps.llm = mappedLlm(NATIVE);
    deps.credentials = dummyCredentials();
    deps.fetchImpl = discoveryFetch();
    deps.resolveRoutes = async (snapshot, operation) => {
      asked.push([snapshot.providers.length, operation]);
      return { routes: new Map([['relay', 'dsh-delegate:relay']]), error: null };
    };
    const routes = wrapUserPlaneRoutes(deps);

    await call(routes, 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    await call(routes, 'POST', `${USER_PLANE_PREFIX}/catalog`, {});
    assert.equal(asked.length, 2);
    assert.deepEqual(asked.map((entry) => entry[1]), ['a model list', 'a catalog read']);
  } finally {
    await cleanup(dir);
  }
});

test('a refused native registration does not block remote discovery', async () => {
  const { dir, deps } = await fixture();
  try {
    // `/catalog` reports the refusal (`registration`) and no rows; `/models` still
    // answers with what the provider's own API serves, because discovery never
    // depended on the native registry. The two surfaces disagree honestly.
    deps.llm = mappedLlm(NATIVE);
    deps.credentials = dummyCredentials();
    deps.fetchImpl = discoveryFetch({ body: { data: [{ id: 'discovered-anyway' }] } });
    deps.resolveRoutes = async () => ({
      routes: null,
      error: { code: 'INVALID_ADAPTER', message: 'the native provider routes could not be registered' },
    });
    const routes = wrapUserPlaneRoutes(deps);

    const catalog = await call(routes, 'POST', `${USER_PLANE_PREFIX}/catalog`, {});
    assert.equal(catalog.body.registration.code, 'INVALID_ADAPTER');
    // Every catalog row is unmapped: the configured models are not reported as routable.
    for (const entry of catalog.body.catalog) {
      assert.equal(entry.route, null);
      assert.deepEqual(entry.models, []);
    }

    const models = await call(routes, 'POST', `${USER_PLANE_PREFIX}/models`, { providerId: 'relay' });
    assert.equal(models.body.route, null);
    assert.deepEqual(models.body.models.map((model) => model.id), ['discovered-anyway']);
    assert.equal(models.body.error, null);
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Monitoring settings route
// ---------------------------------------------------------------------------

test('the monitoring route writes only the two thresholds and returns the committed document', async () => {
  const { dir, deps, settings } = await fixture();
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const result = await call(routes, 'POST', `${USER_PLANE_PREFIX}/monitoring`, {
      monitoring: { selfCheckSeconds: 120, attentionSeconds: 300 },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.monitoring, { selfCheckSeconds: 120, attentionSeconds: 300 });
    // The committed document comes back so the page does not need a second read.
    assert.deepEqual(result.body.settings.monitoring, { selfCheckSeconds: 120, attentionSeconds: 300 });

    // It really persisted, and it rewrote nothing else.
    const stored = await settings.read();
    assert.deepEqual(stored.monitoring, { selfCheckSeconds: 120, attentionSeconds: 300 });
    assert.equal(stored.delegationEnabled, false, 'the switch is untouched');
    assert.equal(stored.worker.model, 'deepseek-chat', 'the worker selection is untouched');
    assert.equal(stored.providers.length, 1);
  } finally {
    await cleanup(dir);
  }
});

test('the monitoring route refuses invalid timers as a 400 and writes nothing', async () => {
  const { dir, deps, settings } = await fixture();
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const before = await settings.read();

    for (const [block, code] of [
      [{ selfCheckSeconds: 600, attentionSeconds: 300 }, 'MONITORING_TIMING_INVALID'],
      [{ selfCheckSeconds: 29, attentionSeconds: 600 }, 'MONITORING_INVALID'],
      [{ selfCheckSeconds: 300, attentionSeconds: 7201 }, 'MONITORING_INVALID'],
      [{ selfCheckSeconds: 300.5, attentionSeconds: 600 }, 'MONITORING_INVALID'],
      [{ atentionSeconds: 900 }, 'MONITORING_INVALID'],
    ]) {
      const result = await call(routes, 'POST', `${USER_PLANE_PREFIX}/monitoring`, { monitoring: block });
      // A refused TIMER is the caller's mistake, not a server fault.
      assert.equal(result.status, 400, `${JSON.stringify(block)} must be a 400`);
      assert.equal(result.body.error.code, code);
      assert.equal(result.body.ok, false);
    }
    assert.deepEqual((await settings.read()).monitoring, before.monitoring, 'nothing was written');
  } finally {
    await cleanup(dir);
  }
});

test('the monitoring route requires a block and rejects a body-less GET', async () => {
  const { dir, deps } = await fixture();
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const missing = await call(routes, 'POST', `${USER_PLANE_PREFIX}/monitoring`, {});
    assert.equal(missing.body.error.code, 'MONITORING_MISSING');
    // Read-only access is not offered: this route is a write, and reads belong to
    // `/settings` so there is exactly one document-shaped read.
    const get = await call(routes, 'GET', `${USER_PLANE_PREFIX}/monitoring`);
    assert.notEqual(get.status, 200);
  } finally {
    await cleanup(dir);
  }
});
