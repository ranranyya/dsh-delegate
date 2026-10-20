// User plane: the authenticated DSH surface an operator drives from the GUI.
//
// This half of the API is registered on the native authenticated channel
// (`ctx.connection.fetch`), so the harness applies its own Host/Origin fence and
// browser-cookie authentication *before* any handler here runs. That ordering is
// the reason this plane may issue authorization: a request that reaches it has
// already been proven to come from the operator's own browser session. This
// module therefore adds no authentication of its own — a duplicate header check
// here would be a second, weaker copy of a guarantee the carrier already made.
//
// Nothing in this plane can be reached over a bare HTTP route, and no route here
// accepts a caller-supplied identity.
//
// Registration constraints of `ctx.connection.fetch.register` (native
// `@deepseek-ai/dsh-client-connection`, 0.2.0-rc.2):
//
//   * `path` is an absolute path that must resolve below `/api`; a path without
//     that prefix is rejected by the harness.
//   * `methods` may only contain `GET`, `HEAD` and `POST`.
//   * `requestBody` is only `buffered` or `streaming` — there is no `none` mode,
//     and the bridge always hands the handler a `Request` object.
//   * routes are keyed by exact path, so the same path may be registered once.
//     A second registration of one path throws.
//
// Consequences encoded below: every exact path appears exactly once, and a path
// that needs both a read and a write carries both methods and dispatches on
// `request.method` itself. All routes declare `buffered`: the bodies here are
// small JSON control documents, and streaming would buy nothing but an
// unbounded read.

import { publicSettings, resolveEffectiveConfig } from '../config/settings.js';
import { redactDeep } from '../config/redact.js';
import { describeCatalog } from '../model/routing.js';
import { classifyError, HttpError, jsonResponse, readJsonRequest } from '../http/respond.js';

/**
 * Route prefix, already below `/api` because the native exact-route registry
 * validates that prefix itself. A full URL is therefore `/api/dsh-delegate/...`.
 */
export const USER_PLANE_PREFIX = '/api/dsh-delegate';

/** Body mode every user-plane route declares. Only `buffered`/`streaming` exist. */
const BODY_MODE = 'buffered';

/** Methods the native registry accepts on an exact fetch route. */
export const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'POST']);

/**
 * Build the authenticated user-plane fetch routes.
 * @param {object} deps - `settings`, `auth`, `engine`, `llm`, `logger`, `describeRuntime`.
 * @returns {Array<{ path: string, methods: string[], requestBody: string, fetch: Function }>} routes.
 */
export function userPlaneRoutes(deps) {
  return [
    {
      path: `${USER_PLANE_PREFIX}/status`,
      methods: ['GET'],
      requestBody: BODY_MODE,
      fetch: async () => {
        return jsonResponse(200, {
          ok: true,
          delegation: deps.engine.posture(),
          runtime: deps.describeRuntime?.(),
        });
      },
    },
    // One path, two methods. `GET` reads the stored document, `POST` replaces it.
    // There is deliberately no `PUT`: the native registry cannot express it.
    {
      path: `${USER_PLANE_PREFIX}/settings`,
      methods: ['GET', 'POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const method = String(request.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
          const settings = await deps.settings.read();
          return jsonResponse(200, {
            ok: true,
            settings: publicSettings(settings),
            // Stated in the payload so a client cannot infer it wrongly.
            secrets: { stored: 'credential-seam-only', values_returned: false },
          });
        }
        if (method !== 'POST') return methodRefusal(request, ['GET', 'POST']);
        const body = await readJsonRequest(request);
        if (body.settings === undefined) {
          throw new HttpError(400, 'SETTINGS_MISSING', 'a settings document is required');
        }
        const committed = await deps.settings.replace(body.settings);
        return jsonResponse(200, { ok: true, settings: publicSettings(committed) });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/catalog`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        const settings = await deps.settings.read();
        const catalog = await describeCatalog(deps, settings.providers, { signal: body.signal });
        const effective = settings.providers.length === 0
          ? null
          : resolveEffectiveConfig(settings, { projectPath: body.projectPath ?? null });
        return jsonResponse(200, { ok: true, catalog, effective });
      },
    },
    // One path, two methods: list connections, or issue a new one.
    {
      path: `${USER_PLANE_PREFIX}/connections`,
      methods: ['GET', 'POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const method = String(request.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
          return jsonResponse(200, { ok: true, connections: deps.auth.listConnections() });
        }
        if (method !== 'POST') return methodRefusal(request, ['GET', 'POST']);
        const body = await readJsonRequest(request);
        const issued = deps.auth.issueConnection({
          label: body.label,
          peer: { address: 'operator-session' },
        });
        // The token is returned exactly once. It is never stored in the clear and
        // never appears in a later listing.
        return jsonResponse(201, {
          ok: true,
          connection: { connectionId: issued.connectionId, label: issued.label, createdAt: issued.createdAt },
          token: issued.token,
          tokenReturnedOnce: true,
        });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/connections/revoke`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        if (typeof body.connectionId !== 'string') {
          throw new HttpError(400, 'CONNECTION_ID_REQUIRED', 'connectionId is required');
        }
        const revoked = deps.auth.revokeConnection(body.connectionId);
        return jsonResponse(200, { ok: true, grantsRevoked: revoked });
      },
    },
    // One path, two methods: list grants for a connection, or issue a grant.
    {
      path: `${USER_PLANE_PREFIX}/grants`,
      methods: ['GET', 'POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const method = String(request.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
          const url = new URL(request.url, 'http://localhost');
          const connectionId = url.searchParams.get('connectionId');
          if (connectionId === null) {
            throw new HttpError(400, 'CONNECTION_ID_REQUIRED', 'connectionId query parameter is required');
          }
          return jsonResponse(200, { ok: true, grants: deps.auth.listGrants(connectionId) });
        }
        if (method !== 'POST') return methodRefusal(request, ['GET', 'POST']);
        const body = await readJsonRequest(request);
        const settings = await deps.settings.read();
        const ttl = body.kind === 'session'
          ? settings.authorization.sessionGrantTtlSeconds
          : settings.authorization.taskGrantTtlSeconds;
        const grant = deps.auth.issueGrant(body.connectionId, {
          kind: body.kind,
          workspacePath: body.workspacePath,
          ttlSeconds: body.ttlSeconds ?? ttl,
          overrides: body.overrides ?? null,
        });
        return jsonResponse(201, { ok: true, grant });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/grants/revoke`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        if (typeof body.grantId !== 'string') {
          throw new HttpError(400, 'GRANT_ID_REQUIRED', 'grantId is required');
        }
        const grant = deps.auth.revokeGrant({ grantId: body.grantId, allowOperator: true });
        return jsonResponse(200, { ok: true, grant });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/authorization/revoke-all`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async () => {
        const revoked = deps.auth.revokeAll();
        return jsonResponse(200, { ok: true, grantsRevoked: revoked });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/tasks`,
      methods: ['GET'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const url = new URL(request.url, 'http://localhost');
        const connectionId = url.searchParams.get('connectionId') ?? undefined;
        return jsonResponse(200, { ok: true, tasks: deps.engine.list({ connectionId }) });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/tasks/get`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        return jsonResponse(200, { ok: true, task: deps.engine.get(body.taskId, { includePrompt: true }) });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/tasks/cancel`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        const task = await deps.engine.cancel(body.taskId, 'operator');
        return jsonResponse(200, { ok: true, task });
      },
    },
  ];
}

/**
 * Refuse a method a multi-method path does not accept.
 *
 * The native carrier only forwards methods the route declared, but a handler can
 * also be invoked directly (tests, in-process callers, a future carrier that
 * relaxes method filtering), so each dispatcher states its own accepted set
 * rather than assuming the router filtered for it.
 * @param {Request} request - incoming request.
 * @param {string[]} allowed - methods this branch handles.
 * @returns {Response} 405 with an `Allow` header.
 */
function methodRefusal(request, allowed) {
  const method = String(request?.method ?? 'GET').toUpperCase();
  return jsonResponse(
    405,
    {
      ok: false,
      error: {
        code: 'USER_PLANE_METHOD_NOT_ALLOWED',
        message: `${method} is not allowed on ${new URL(request.url, 'http://localhost').pathname}`,
        details: { method, allowed },
      },
    },
    { allow: allowed.join(', ') },
  );
}

/**
 * Assert a route set is registrable on the native exact-route channel.
 *
 * This mirrors the constraints the harness enforces and adds the one it does not
 * check for us in a useful place: exact paths are unique. Running it before
 * registration turns a mid-registration throw (which would leave earlier routes
 * mounted and later ones missing) into a single clear refusal.
 * @param {Array<object>} routes - candidate routes.
 * @returns {Array<object>} the same routes when valid.
 * @throws {Error} when a route could not be registered.
 */
export function assertUserPlaneRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('dsh-delegate: the user plane declares no routes');
  }
  const seen = new Map();
  for (const route of routes) {
    const path = route?.path;
    if (typeof path !== 'string' || !path.startsWith('/api/')) {
      // The native registry resolves routes below `/api`; anything else is
      // silently unreachable or rejected outright.
      throw new Error(`dsh-delegate: user-plane route path ${JSON.stringify(path)} must start with "/api/"`);
    }
    if (seen.has(path)) {
      // Exact paths are keyed, so a duplicate is not "the same route twice" but a
      // guaranteed throw on the second registration.
      throw new Error(`dsh-delegate: user-plane route ${JSON.stringify(path)} is registered twice`);
    }
    seen.set(path, route);
    if (!Array.isArray(route.methods) || route.methods.length === 0) {
      throw new Error(`dsh-delegate: user-plane route ${JSON.stringify(path)} declares no methods`);
    }
    if (new Set(route.methods).size !== route.methods.length) {
      throw new Error(`dsh-delegate: user-plane route ${JSON.stringify(path)} repeats a method`);
    }
    for (const method of route.methods) {
      if (!ALLOWED_METHODS.includes(method)) {
        throw new Error(
          `dsh-delegate: user-plane route ${JSON.stringify(path)} declares ${JSON.stringify(method)}; only ${ALLOWED_METHODS.join('/')} are supported`,
        );
      }
    }
    if (route.requestBody !== 'buffered' && route.requestBody !== 'streaming') {
      throw new Error(
        `dsh-delegate: user-plane route ${JSON.stringify(path)} declares requestBody ${JSON.stringify(route.requestBody)}; only "buffered" or "streaming" are supported`,
      );
    }
    if (typeof route.fetch !== 'function') {
      throw new Error(`dsh-delegate: user-plane route ${JSON.stringify(path)} has no fetch handler`);
    }
  }
  return routes;
}

/**
 * Wrap a user-plane route set into a validated, error-handling dispatcher.
 *
 * Registration is per exact path on the native channel, so each route already
 * carries its own guard. This wrapper validates the set once and standardizes
 * failure rendering: an operator surface must answer with a JSON refusal, never
 * with a stack trace or a bare 500 page.
 * @param {object} deps - dependency object passed to {@link userPlaneRoutes}.
 * @returns {Array<object>} validated, wrapped routes.
 */
export function wrapUserPlaneRoutes(deps) {
  return assertUserPlaneRoutes(userPlaneRoutes(deps)).map((route) => ({
    ...route,
    fetch: async (request) => {
      try {
        return await route.fetch(request);
      } catch (error) {
        const mapped = classifyError(error);
        deps.logger?.warn?.('dsh-delegate: user plane refusal', mapped.code);
        return jsonResponse(mapped.status, {
          ok: false,
          error: { code: mapped.code, message: mapped.message, details: redactDeep(mapped.details) },
        });
      }
    },
  }));
}
