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
import { listNativeProviderCatalog } from '../model/native-catalog.js';
import { discoverProviderModels } from '../model/discovery.js';
import { checkProviderConnectivity } from '../model/connectivity.js';
import { MAX_CREDENTIAL_VALUE_CHARS } from '../credentials/seam.js';
import { CODEX_ACTIONS, publicCodexStatus, runCodexAction } from '../codex/installer.js';
import { classifyError, HttpError, jsonResponse, readJsonRequest } from '../http/respond.js';

/**
 * Route prefix, already below `/api` because the native exact-route registry
 * validates that prefix itself. A full URL is therefore `/api/dsh-delegate/...`.
 */
export const USER_PLANE_PREFIX = '/api/dsh-delegate';

/** Body mode every user-plane route declares. Only `buffered`/`streaming` exist. */
const BODY_MODE = 'buffered';

const GRANT_CONTROL_PATHS = new Set([
  `${USER_PLANE_PREFIX}/connections`,
  `${USER_PLANE_PREFIX}/connections/revoke`,
  `${USER_PLANE_PREFIX}/grants`,
  `${USER_PLANE_PREFIX}/grants/revoke`,
  `${USER_PLANE_PREFIX}/authorization/revoke-all`,
]);

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
    {
      path: `${USER_PLANE_PREFIX}/native-providers`,
      methods: ['GET'],
      requestBody: BODY_MODE,
      fetch: async () => {
        const result = await listNativeProviderCatalog(deps.llm);
        return jsonResponse(200, { ok: true, ...result });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/delegation`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        if (typeof body.enabled !== 'boolean') {
          throw new HttpError(400, 'DELEGATION_SWITCH_INVALID', 'enabled must be a boolean');
        }
        // Closing the gate takes effect before disk I/O so no new task can slip
        // through while the setting is being persisted; active tasks are aborted.
        if (body.enabled === false) deps.engine.setDelegationEnabled(false);
        const settings = await deps.settings.setDelegationEnabled(body.enabled);
        if (body.enabled === true) deps.engine.setDelegationEnabled(settings.delegationEnabled);
        return jsonResponse(200, { ok: true, delegation: deps.engine.posture() });
      },
    },
    // One narrow route for the two silence thresholds.
    //
    // It is on the AUTHENTICATED operator plane, like every other settings write, and
    // it is the only place a monitoring edit can enter. The MCP surface never gains a
    // settings write: this route is reachable only from the operator's own page, and
    // it cannot widen an authorization, a grant, a switch, a provider or an isolation
    // mode — `setMonitoring` validates its own block and rewrites nothing else.
    {
      path: `${USER_PLANE_PREFIX}/monitoring`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        if (body.monitoring === undefined) {
          throw new HttpError(400, 'MONITORING_MISSING', 'a monitoring block is required');
        }
        // `setMonitoring` refuses an invalid block with a `MONITORING_*` code. That
        // code is the validator's, and the shared error translator would render an
        // unlisted code as a 500; a refused TIMER is the caller's mistake, so it is
        // re-thrown here as a 400 that keeps the original code and its field details.
        // Nothing is written when this throws.
        let committed;
        try {
          committed = await deps.settings.setMonitoring(body.monitoring);
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : '';
          if (!code.startsWith('MONITORING_')) throw error;
          throw new HttpError(400, code, String(error?.message ?? 'the monitoring block is invalid'), error?.details ?? {});
        }
        return jsonResponse(200, {
          ok: true,
          monitoring: { ...committed.monitoring },
          // The whole document is returned too, because the page adopts it after a
          // narrow save and must not have to issue a second read to stay truthful.
          settings: publicSettings(committed),
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
        const committed = await deps.settings.replaceConfiguration(body.settings);
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
        // Every row must name the route the harness actually serves. A catalog
        // built from public profile ids alone would describe routes that were
        // never registered — and would silently agree with an *ambient* route of
        // the same name (`relay`, `workbuddy`) that this plugin does not own.
        const resolved = await resolveRoutesForCatalog(deps, settings);
        const catalog = await describeCatalog(deps, settings.providers, {
          signal: body.signal,
          routes: resolved.routes,
        });
        const effective = settings.providers.length === 0
          ? null
          : resolveEffectiveConfig(settings, { projectPath: body.projectPath ?? null });
        return jsonResponse(200, {
          ok: true,
          catalog,
          effective,
          // `null` when every configured provider was mapped. A non-null value
          // means no row can be trusted as routable, and says why.
          registration: resolved.error,
          secrets: { values_returned: false },
        });
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
    // ---- task records ------------------------------------------------------
    // The operator's task list is the *live engine plus the durable archive*.
    //
    // A restart begins with an empty engine (that is the whole point of the
    // execution plane's restart story), so a user-plane list built from
    // `engine.list()` alone would report "no tasks" while the history document on
    // disk still holds every finished job. These two read routes therefore
    // project `HistoryStore.load()` alongside the engine, with three rules:
    //
    //   * live wins on collision. A record the engine still holds under the same
    //     `taskId` is returned unchanged, so an in-process task can never be
    //     replaced by its own stored copy (which lags the engine: history is
    //     written at terminal time, while the engine view carries prompt,
    //     acceptance and later bookkeeping). Archived records are shallow copies
    //     of detached loaded views, so nothing here writes through to the store.
    //   * archived is a marker, not a state. A persisted-only record is returned
    //     with `archived: true` and keeps the state the store normalized it to —
    //     `pending`/`running` already became `interrupted`
    //     (`error.code = JOB_INTERRUPTED_RESTART`) at load time, and that
    //     normalization is consumed as-is, never re-derived or "upgraded" here.
    //   * archived records are sealed. Nothing in this plane may create a
    //     controller, an agent, a workspace lease, an authorization or a token
    //     from them, so `/tasks/cancel` refuses an archived id outright rather
    //     than letting the engine's own `JOB_NOT_OK` path decide, and the
    //     projection is read-only in both directions: it neither dispatches work
    //     nor rewrites the document.
    //
    // A history document that cannot be read is a *visible refusal*, never an
    // empty success: answering `tasks: []` for an unreadable archive would tell
    // an operator that nothing ever ran.
    //
    // This is the authenticated user plane only. The execution plane's
    // `/tasks`, `/tasks/get` and `/tasks/cancel` are untouched: an external
    // connection still sees exactly its own in-memory tasks, and a new
    // connection never sees another connection's or a previous process's work.
    {
      path: `${USER_PLANE_PREFIX}/tasks`,
      methods: ['GET'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const url = new URL(request.url, 'http://localhost');
        const connectionId = url.searchParams.get('connectionId') ?? undefined;
        const { tasks, history } = await readTaskRecords(deps, { connectionId });
        return jsonResponse(200, {
          ok: true,
          tasks,
          // Stated, not implied: a client must be able to tell a complete list
          // from one whose archive section could not be read.
          history,
        });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/tasks/get`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
        if (taskId === '') {
          throw new HttpError(400, 'TASK_ID_REQUIRED', 'taskId is required');
        }
        const live = engineRecord(deps, taskId);
        if (live !== null) {
          return jsonResponse(200, {
            ok: true,
            task: { ...live, archived: false, live: true },
            history: historyStatus(null),
          });
        }
        // Only the engine's own "no such task" may fall through to the archive.
        // Any other engine failure (disposed, internal) is a real failure and is
        // propagated unchanged: reporting it as "archived task not found" would
        // hide a broken engine behind a 404.
        const { jobs } = await loadArchive(deps);
        const archived = jobs.find((job) => job.taskId === taskId) ?? null;
        if (archived === null) {
          throw new HttpError(404, 'JOB_TASK_NOT_FOUND', 'no such task', { taskId });
        }
        // The prompt is not in the archive by design (`HistoryStore` never stores
        // it), so the response says so rather than leaving a silent gap.
        return jsonResponse(200, {
          ok: true,
          task: { ...archivedRecord(archived), prompt: null, promptArchived: false },
          history: historyStatus({ available: true, archived: jobs.length }),
        });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/tasks/cancel`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
        if (taskId === '') {
          throw new HttpError(400, 'TASK_ID_REQUIRED', 'taskId is required');
        }
        // An archived task has no run behind it: no controller, no leases and no
        // authorization survive a restart, so "cancel" could only mark a record.
        // The live engine is consulted first (it throws its own not-found), and
        // an id that exists only in the archive is refused explicitly.
        const live = engineRecord(deps, taskId);
        if (live === null) {
          const { jobs } = await loadArchive(deps);
          if (jobs.some((job) => job.taskId === taskId)) {
            throw new HttpError(
              409,
              'JOB_ARCHIVED_TASK',
              'the task exists only in durable history; it has no live run to cancel and was not resubmitted',
              { taskId, archived: true },
            );
          }
        }
        const task = await deps.engine.cancel(taskId, 'operator');
        return jsonResponse(200, { ok: true, task });
      },
    },

    // ---- provider model list -----------------------------------------------
    // Remote discovery: one authenticated `GET <provider baseUrl>/models` against
    // the provider the operator selected, using only *that profile's* credential
    // reference, resolved through the DSH gateway for this request alone.
    //
    // This is not a native catalog read. An empty configured provider has no
    // models to enumerate, and no native route is needed to ask its API what it
    // serves — so discovery works whether or not the native routes registered,
    // and a failure here is reported as a discovery failure, never as a fake
    // native-list success. `/catalog` remains the surface that reports what the
    // harness can actually resolve for the configured models.
    //
    // `POST` rather than `GET ?providerId=`: the request carries an operator action
    // (spend one upstream call with their key), it must never be prefetched or
    // cached by an intermediary, and the native registry cannot express `PUT`.
    {
      path: `${USER_PLANE_PREFIX}/models`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        const { provider } = await requireProvider(deps, body.providerId, 'models');
        // The route-shaped facts, reported without touching the native registry:
        // `route` is a *configured* resolution hint (the mapped native route, or
        // null when there is none), never the bare profile id, so no caller can
        // read it as "this list is routable".
        const route = await configuredRoute(deps, provider.id);
        const outcome = await discoverProviderModels({
          provider,
          credentials: deps.credentials,
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          ...(body.signal === undefined || body.signal === null ? {} : { signal: body.signal }),
        });
        if (outcome.ok !== true) {
          // A 200 with an explicit diagnosis: the operator keeps their manual
          // configuration, and the empty list is explained rather than implied.
          return jsonResponse(200, {
            ok: true,
            providerId: provider.id,
            route,
            models: [],
            source: 'remote',
            discovery: {
              attempted: true,
              failed: true,
              code: outcome.diagnosis?.code ?? 'DISCOVERY_UNKNOWN',
              message: outcome.diagnosis?.message ?? 'the model list could not be retrieved',
              details: outcome.diagnosis?.details ?? {},
            },
            error: outcome.diagnosis ?? null,
            registration: null,
            secrets: { values_returned: false },
          });
        }
        return jsonResponse(200, {
          ok: true,
          providerId: provider.id,
          route,
          models: outcome.models,
          // Named so a caller never has to infer where ids came from.
          source: 'remote',
          discovery: {
            attempted: true,
            failed: false,
            code: null,
            message: null,
            details: outcome.facts,
            // The one thing a list cannot prove, stated instead of implied.
            note: 'a model listing does not establish reasoning-effort support',
          },
          error: null,
          registration: null,
          secrets: { values_returned: false },
        });
      },
    },

    // ---- credential seam ---------------------------------------------------
    // Three exact paths, because each is a distinct operator action with a
    // distinct refusal. None of them can read a value back: the seam's
    // `CredentialInfo` has no slot for one, and no handler below adds one.
    {
      path: `${USER_PLANE_PREFIX}/credentials/status`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        const { provider } = await requireProvider(deps, body.providerId, 'credential status');
        const reference = requireCredentialRef(provider);
        const credential = await requireSeam(deps).describe(reference);
        return jsonResponse(200, {
          ok: true,
          providerId: provider.id,
          reference,
          credential,
          secrets: { values_returned: false },
        });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/credentials/set`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        const { provider } = await requireProvider(deps, body.providerId, 'credential write');
        const reference = requireCredentialRef(provider);
        const seam = requireSeam(deps);
        // Bounds are checked here as well as inside the gateway. A route that
        // delegated every check to an injected object would be trusting whatever
        // was injected; the boundary that accepts the secret is the boundary that
        // must refuse a bad one.
        const value = requireCredentialValue(body.value, reference);
        // The literal is forwarded and dropped here. It is never normalized
        // (trimming would silently store a different secret), never echoed, never
        // logged, and never placed in a refusal detail.
        await seam.set(reference, value);
        const credential = await seam.describe(reference);
        // The value itself is not read back even to confirm the write: `describe`
        // is the seam's own answer to "is it configured now".
        return jsonResponse(200, {
          ok: true,
          providerId: provider.id,
          reference,
          credential,
          secrets: { values_returned: false },
        });
      },
    },
    {
      path: `${USER_PLANE_PREFIX}/credentials/unset`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        const { provider } = await requireProvider(deps, body.providerId, 'credential removal');
        const reference = requireCredentialRef(provider);
        const seam = requireSeam(deps);
        await seam.unset(reference);
        const credential = await seam.describe(reference);
        return jsonResponse(200, {
          ok: true,
          providerId: provider.id,
          reference,
          credential,
          secrets: { values_returned: false },
        });
      },
    },

    // ---- Codex integration -------------------------------------------------
    // Two routes, both on the authenticated operator plane because both are
    // operator actions about a *host-side* file (Codex's own config), not about
    // this plugin's document.
    //
    //   GET  /codex  — read-only diagnosis. It never writes, and it is the only
    //                  way the page learns what is installed.
    //   POST /codex  — one explicit action: `install`, `repair` or `remove`.
    //
    // Nothing here runs on plugin load, and no action enables the delegation
    // switch: installing a Codex agent is a separate decision from authorizing
    // local dispatch, and the response reports the switch state without changing it.
    {
      path: `${USER_PLANE_PREFIX}/codex`,
      methods: ['GET', 'POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const method = String(request.method ?? 'GET').toUpperCase();
        if (method === 'GET') {
          const outcome = await runCodexIntegration(deps, 'status');
          return jsonResponse(200, { ok: true, ...outcome });
        }
        if (method !== 'POST') return methodRefusal(request, ['GET', 'POST']);
        const body = await readJsonRequest(request);
        const action = typeof body.action === 'string' ? body.action.trim() : '';
        if (!CODEX_ACTIONS.includes(action) || action === 'status') {
          throw new HttpError(
            400,
            'CODEX_ACTION_INVALID',
            `action must be one of ${CODEX_ACTIONS.filter((entry) => entry !== 'status').join(', ')}`,
            { allowed: CODEX_ACTIONS.filter((entry) => entry !== 'status') },
          );
        }
        const outcome = await runCodexIntegration(deps, action);
        deps.logger?.info?.('dsh-delegate: Codex integration action applied', {
          action,
          changed: outcome.changed,
          refused: outcome.refused.map((entry) => entry.code),
        });
        return jsonResponse(200, { ok: true, ...outcome });
      },
    },

    // ---- layered connectivity ---------------------------------------------
    // One provider per request. The report is the four-layer structure documented
    // in `docs/native-integration-audit.md`; a layer that was not attempted is
    // `ok: null`, never `ok: true`.
    {
      path: `${USER_PLANE_PREFIX}/connectivity`,
      methods: ['POST'],
      requestBody: BODY_MODE,
      fetch: async (request) => {
        const body = await readJsonRequest(request);
        // An unknown provider is a 404 here, not a report: a report would need a
        // profile to describe and would otherwise be a manufactured green row.
        const { provider } = await requireProvider(deps, body.providerId, 'the connectivity check');
        const report = await checkProviderConnectivity(deps, {
          providerId: provider.id,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
        });
        return jsonResponse(200, {
          ok: true,
          providerId: report.providerId,
          // Redacted even though every producer here is already careful: this is
          // the one response an operator pastes into a bug report.
          report: redactDeep(report),
          secrets: { values_returned: false },
        });
      },
    },
  ];
}

// ---- Codex integration ------------------------------------------------------

/**
 * Run one Codex integration action and shape the answer for the settings page.
 *
 * The three facts an operator needs are kept apart on purpose, because they fail
 * independently and mean different things:
 *
 *   * `agent`  — the custom agent file exists (and is ours);
 *   * `mcp`    — Codex is configured to launch this package's stdio MCP server;
 *   * `switch` — the DSH local-call switch, which this route never changes.
 *
 * A `status` read is refused for a bad `CODEX_HOME` rather than silently falling
 * back to the default: reporting on the wrong directory would be worse than
 * saying that the configured one is unusable.
 * @param {object} deps - dependency object with an optional `codex` seam.
 * @param {string} action - `status`, `install`, `repair` or `remove`.
 * @returns {Promise<object>} outcome with `changed`, `refused`, `codex` and `switch`.
 * @throws {HttpError} `CODEX_INTEGRATION_UNAVAILABLE` when no seam is wired.
 */
async function runCodexIntegration(deps, action) {
  const seam = deps.codex;
  if (seam === null || seam === undefined || typeof seam.run !== 'function' || typeof seam.status !== 'function') {
    throw new HttpError(
      503,
      'CODEX_INTEGRATION_UNAVAILABLE',
      'this host does not expose the Codex integration, so nothing can be installed or reported',
    );
  }
  let outcome;
  try {
    outcome = action === 'status' ? await seam.status() : await seam.run(action);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'CODEX_INTEGRATION_FAILED';
    // The installer's own refusals carry a bounded details object; a filesystem
    // error does not, and its message may contain a path but never a secret.
    throw new HttpError(
      code === 'CODEX_HOME_INVALID' ? 400 : code === 'CODEX_CONFIG_UNSUPPORTED' ? 409 : 500,
      code,
      typeof error?.message === 'string' ? error.message : 'the Codex integration action failed',
      error?.details !== undefined && error.details !== null ? error.details : {},
    );
  }
  const switchPosture = typeof deps.engine?.posture === 'function' ? deps.engine.posture() : null;
  return {
    action,
    changed: Array.isArray(outcome?.changed) ? outcome.changed : [],
    refused: Array.isArray(outcome?.refused) ? outcome.refused : [],
    // `publicCodexStatus` drops the internal `agent.expect` bytes, which exist only
    // for the installer's own compare-before-write step.
    codex: redactDeep(publicCodexStatus(outcome?.status ?? {})),
    // Reported, never written: installing the agent must not authorize dispatch.
    switch: {
      authorized: switchPosture?.authorized === true,
      mode: switchPosture?.mode ?? 'switch',
      reason: switchPosture?.reason ?? null,
      changedByThisAction: false,
    },
  };
}

// ---- task-record projection (live engine + durable archive) ----------------

/**
 * Read the durable archive, or throw an `HttpError` that says so.
 *
 * Three postures, deliberately distinct:
 *
 *   * no store injected — the archive is simply absent, and the response says
 *     so instead of implying that nothing was ever persisted;
 *   * an empty document — a real, successful empty archive;
 *   * a refused document — a 503 carrying the store's own code
 *     (`HISTORY_MALFORMED`, `HISTORY_UNREADABLE`, …). Never an empty success:
 *     `load()` rejects for exactly this case, and swallowing it would report
 *     "your tasks are gone" for "this file cannot be read".
 * @param {object} deps - dependency object with an optional `history` store.
 * @returns {Promise<{ available: boolean, jobs: object[], code: string | null }>} archive state.
 * @throws {HttpError} `JOB_HISTORY_UNREADABLE` when the document is refused.
 */
async function loadArchive(deps) {
  const store = deps.history;
  if (store === null || store === undefined || typeof store.load !== 'function') {
    return { available: false, jobs: [], code: 'HISTORY_UNAVAILABLE' };
  }
  try {
    const jobs = await store.load();
    return { available: true, jobs: Array.isArray(jobs) ? jobs : [], code: null };
  } catch (error) {
    deps.logger?.warn?.('dsh-delegate: durable task history could not be read', error?.code ?? 'HISTORY_UNREADABLE');
    throw new HttpError(
      503,
      'JOB_HISTORY_UNREADABLE',
      'the durable task history could not be read, so archived tasks are not shown',
      {
        // A history refusal is a code, not a secret; the document text is not.
        cause: typeof error?.code === 'string' ? error.code : 'HISTORY_UNREADABLE',
      },
    );
  }
}

/**
 * Describe the archive section of a task response.
 * @param {{ available: boolean, archived: number, reason?: string } | null} status - archive state, or null when it was not read.
 * @returns {{ available: boolean, archived: number, unreadable: boolean, reason?: string }} bounded status.
 */
function historyStatus(status) {
  if (status === null || status === undefined) return { available: false, archived: 0, unreadable: false };
  return status.available
    ? { available: true, archived: status.archived, unreadable: false }
    : { available: false, archived: 0, unreadable: false, reason: status.reason ?? 'HISTORY_UNAVAILABLE' };
}

/**
 * The engine's own view of one task, or `null` when the engine does not know it.
 *
 * Only the engine's not-found code means "not live". Everything else — a disposed
 * engine, an internal failure — is re-thrown, because a broken engine must not be
 * mistaken for an empty one and then papered over by the archive.
 * @param {object} deps - dependency object with `engine`.
 * @param {string} taskId - task id.
 * @returns {object | null} live view, including the prompt for the operator.
 */
function engineRecord(deps, taskId) {
  try {
    return deps.engine.get(taskId, { includePrompt: true });
  } catch (error) {
    if (error?.code === 'JOB_TASK_NOT_FOUND') return null;
    throw error;
  }
}

/**
 * Mark a stored record as archive-only without touching the stored object.
 * @param {object} job - detached view returned by `HistoryStore.load()`.
 * @returns {object} a new object; nested blocks are the store's already-redacted ones.
 */
function archivedRecord(job) {
  return {
    ...job,
    // No live run exists, so there is nothing further to withhold or replay.
    archived: true,
    live: false,
  };
}

/**
 * Merge live engine views with the durable archive into one newest-first list.
 *
 * Ordering is by creation time only; the task id breaks ties so the list is a
 * stable total order rather than dependent on merge order. `connectionId`
 * filtering is applied to both halves with the same equality rule the engine's
 * own `list()` uses, so the user plane cannot disagree with the execution plane
 * about which records belong to a connection.
 * @param {object} deps - dependency object with `engine` and optional `history`.
 * @param {object} [options] - `connectionId` to filter on.
 * @returns {Promise<{ tasks: object[], history: object }>} merged list and archive status.
 */
async function readTaskRecords(deps, options = {}) {
  const filtered = options.connectionId !== undefined && options.connectionId !== null;
  const live = deps.engine.list(filtered ? { connectionId: options.connectionId } : {});
  const archive = await loadArchive(deps);
  const liveIds = new Set(live.map((task) => task.taskId));

  const merged = [];
  for (const task of live) {
    // Live wins: an in-process record is the newer truth for its own id.
    merged.push({ ...task, archived: false, live: true });
  }
  for (const job of archive.jobs) {
    if (liveIds.has(job.taskId)) continue;
    if (filtered && job.connectionId !== options.connectionId) continue;
    merged.push(archivedRecord(job));
  }
  merged.sort(compareNewestFirst);

  return {
    tasks: merged,
    history: {
      available: archive.available,
      archived: archive.available ? archive.jobs.length : 0,
      unreadable: false,
      ...(archive.available ? {} : { reason: archive.code }),
    },
  };
}

/**
 * Newest first by creation time, then by id.
 * @param {object} a - first record.
 * @param {object} b - second record.
 * @returns {number} sort order.
 */
function compareNewestFirst(a, b) {
  const left = Number.isFinite(a?.createdAt) ? a.createdAt : -Infinity;
  const right = Number.isFinite(b?.createdAt) ? b.createdAt : -Infinity;
  if (left !== right) return right < left ? -1 : 1;
  const leftId = typeof a?.taskId === 'string' ? a.taskId : '';
  const rightId = typeof b?.taskId === 'string' ? b.taskId : '';
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

/**
 * Resolve one provider profile from the current settings document.
 *
 * Every route that names a provider starts here, so "a provider id that is not
 * configured" is one refusal with one code everywhere instead of three subtly
 * different behaviours.
 * @param {object} deps - dependency object with `settings`.
 * @param {unknown} providerId - caller-supplied profile id.
 * @param {string} operation - what was being attempted, for the message.
 * @returns {Promise<{ settings: object, provider: object }>} the profile and the snapshot it came from.
 */
async function requireProvider(deps, providerId, operation) {
  const id = typeof providerId === 'string' ? providerId.trim() : '';
  if (id === '') {
    throw new HttpError(400, 'PROVIDER_ID_REQUIRED', `providerId is required for ${operation}`);
  }
  const settings = await deps.settings.read();
  const provider = settings.providers.find((entry) => entry.id === id);
  if (provider === undefined) {
    throw new HttpError(404, 'PROVIDER_UNKNOWN', `no provider profile named ${id}`, { providerId: id });
  }
  return { settings, provider };
}

/**
 * A credential operation needs a reference to name. A profile without one cannot
 * have a credential, and reporting that as "unconfigured" would hide the real fix.
 * @param {object} provider - validated provider profile.
 * @returns {string} the credential reference name.
 */
function requireCredentialRef(provider) {
  const reference = provider?.credentialRef;
  if (typeof reference !== 'string' || reference === '') {
    throw new HttpError(
      400,
      'PROVIDER_CREDENTIAL_REF_MISSING',
      `provider ${provider?.id ?? ''} names no credential reference; set one before storing a secret`,
      { providerId: provider?.id ?? null },
    );
  }
  return reference;
}

/**
 * Validate a pasted secret at the route boundary.
 *
 * The refusal detail carries the bound, never the value or its length: a length
 * is a fingerprint of the secret and a provider key may be short.
 * @param {unknown} value - caller-supplied literal.
 * @param {string} reference - credential reference the value is for.
 * @returns {string} the literal, unchanged.
 */
function requireCredentialValue(value, reference) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(
      400,
      'CREDENTIAL_VALUE_REQUIRED',
      'a credential value is required; use the clear action to remove one',
      { reference },
    );
  }
  if (value.length > MAX_CREDENTIAL_VALUE_CHARS) {
    throw new HttpError(
      400,
      'CREDENTIAL_VALUE_TOO_LARGE',
      'the credential value exceeds the accepted bound',
      { reference, limit: MAX_CREDENTIAL_VALUE_CHARS },
    );
  }
  return value;
}

/**
 * The credential gateway, or a refusal.
 * @param {object} deps - dependency object with an optional `credentials` gateway.
 * @returns {object} the gateway.
 */
function requireSeam(deps) {
  const seam = deps.credentials;
  if (seam === null || seam === undefined || typeof seam.describe !== 'function') {
    // The plugin loads without a credential service on purpose. That must read as
    // an honest "this host cannot store secrets", not as a failed write.
    throw new HttpError(
      503,
      'CREDENTIAL_SEAM_UNAVAILABLE',
      'this harness exposes no credential service, so a secret cannot be stored or described',
    );
  }
  return seam;
}

/**
 * Resolve the native route mapping for one snapshot, keeping the failure.
 *
 * Read paths (`/models`, `/catalog`) answer with a body rather than a thrown
 * refusal, so they need the *reason* a mapping does not exist. Returning `null`
 * routes — which is what an unguarded `ensureRoutes()` wrapper used to do — is
 * worse than failing: `describeCatalog` treats a missing map as "no mapping was
 * supplied" and falls back to the public profile id, so a provider whose
 * registration was refused would be reported under an ambient native route
 * (`relay`, `workbuddy`) that this plugin does not own. Here a failure is
 * carried explicitly and no route is ever invented.
 * @param {object} deps - dependency object with an optional `ensureRoutes`.
 * @param {object} settings - validated settings snapshot.
 * @param {string} operation - what was being attempted, for the message.
 * @returns {Promise<{ routes: Map<string, string> | null, error: { code: string, message: string } | null }>} outcome.
 */
async function resolveRoutes(deps, settings, operation) {
  if (typeof deps.resolveRoutes === 'function') {
    // Injected by the entry point, which decides how a failure is logged.
    return await deps.resolveRoutes(settings, operation);
  }
  if (typeof deps.ensureRoutes !== 'function') {
    return {
      routes: null,
      error: { code: 'PROVIDER_ROUTES_UNAVAILABLE', message: 'native provider routes cannot be registered in this host' },
    };
  }
  try {
    return { routes: await deps.ensureRoutes(settings), error: null };
  } catch (error) {
    deps.logger?.warn?.('dsh-delegate: provider route registration failed during', operation, error?.code ?? 'UNKNOWN');
    return {
      routes: null,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'PROVIDER_ROUTES_UNAVAILABLE',
        message: 'the native provider routes could not be registered',
      },
    };
  }
}

/**
 * Route mapping for the whole-document catalog.
 *
 * A catalog of an empty provider list needs no registration at all, and
 * registering one would create native state as a side effect of a read. With
 * providers configured, so is the registration.
 * @param {object} deps - dependency object.
 * @param {object} settings - validated settings snapshot.
 * @returns {Promise<{ routes: Map<string, string> | null, error: object | null }>} outcome.
 */
async function resolveRoutesForCatalog(deps, settings) {
  if (settings.providers.length === 0) return { routes: new Map(), error: null };
  return await resolveRoutes(deps, settings, 'a catalog read');
}

/**
 * The native route this provider *would* be served under, for disclosure only.
 *
 * Discovery does not need a route and does not create one: it asks the provider's
 * own API. The route is still reported because an operator uses this row to reason
 * about the whole configuration, and the rule for reporting it is the same one
 * `/catalog` follows — the registered mapping wins, and its absence is `null`,
 * never the bare profile id (which may name an ambient route this plugin does not
 * own).
 * @param {object} deps - dependency object with an optional `resolveRoutes`.
 * @param {string} providerId - configured provider id.
 * @returns {Promise<string | null>} native route id, or null.
 */
async function configuredRoute(deps, providerId) {
  if (typeof deps.resolveRoutes !== 'function' && typeof deps.ensureRoutes !== 'function') return null;
  try {
    const settings = await deps.settings.read();
    const resolved = await resolveRoutes(deps, settings, 'a model list');
    const mapped = resolved.routes instanceof Map ? resolved.routes.get(providerId) : undefined;
    return typeof mapped === 'string' && mapped !== '' ? mapped : null;
  } catch {
    // Registration failed: no route is reported, and model discovery is
    // unaffected — it never depends on the native registry.
    return null;
  }
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
  const routes = userPlaneRoutes(deps);
  const activeRoutes = deps.engine?.authorizationMode === 'switch'
    ? routes.filter((route) => !GRANT_CONTROL_PATHS.has(route.path))
    : routes;
  return assertUserPlaneRoutes(activeRoutes).map((route) => ({
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
