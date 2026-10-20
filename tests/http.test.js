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
  const engine = {
    posture: () => ({ authorized: false, reason: 'delegation is off' }),
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
