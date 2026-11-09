// Execution plane: the bounded surface an external connection uses to submit
// and observe delegated work.
//
// This plane is NOT an authorization surface. It cannot create a connection, it
// cannot issue a grant, and it cannot change settings. Those actions exist only
// on the authenticated user plane. What this plane can do is exercise an
// authorization the operator already created, which means every request here
// needs two independent facts:
//
//   1. a connection token, issued by the operator plane and stored only as a
//      hash; and
//   2. a grant for that connection and this exact workspace.
//
// The transport fence (loopback socket, loopback Host, same-origin browser
// marker) is applied first. It is a necessary condition, never a sufficient
// one: an Origin string is trivially forged by any local program, so it is
// treated as a filter, not as proof of anything.

import { fenceExternalConnection } from '../auth/fence.js';
import { AUTH_CODES } from '../auth/grants.js';
import { classifyError, HttpError, readJsonBody, sendJson } from '../http/respond.js';
import { preflightWorkspace } from '../workspace/preflight.js';

/** Route prefix owned by this plane. Deliberately not under `/api`. */
export const EXECUTION_PREFIX = '/dsh-delegate/x';

/**
 * Upper bound on one observation request, in milliseconds.
 *
 * A caller may ask for less, never for more. The bound exists so one HTTP request
 * is always answerable: a connection that has gone away cannot pin a handler open
 * for an unbounded time, and a long host-side wait is composed out of these
 * bounded observations rather than being one unbounded request.
 */
export const MAX_OBSERVE_WAIT_MS = 25_000;

/** Body fields `POST /tasks/observe` accepts. Everything else is refused. */
const OBSERVE_FIELDS = Object.freeze(['taskId', 'waitMs']);

/**
 * Build a node-style handler for the execution plane.
 *
 * Routing is exact-match on method plus path, so an unmatched path is a 404 and
 * never falls through to something more permissive.
 * @param {object} deps - `engine`, `auth`, `settings`, `logger`, `getBindHost`.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} handler.
 */
export function createExecutionHandler(deps) {
  const routes = new Map([
    ['GET /status', status],
    ['POST /tasks', submitTask],
    ['GET /tasks', listTasks],
    ['POST /tasks/get', getTask],
    ['POST /tasks/cancel', cancelTask],
    // A bounded long-poll read. It creates, settles and authorizes nothing: it
    // reports what a task looks like now, or returns when something about it that a
    // host must act on changes. Read availability follows `/tasks/get` exactly, so
    // it stays answerable while the switch is off.
    ['POST /tasks/observe', observeTask],
    // The one per-call permission decision a commander may take. It is NOT a
    // control-plane write: it consumes an already pending native approval request
    // that this task's own worker raised, cannot create or widen any grant, cannot
    // change settings/credentials/the switch, and cannot approve a future call.
    // The switch gate below applies to it exactly as it does to a submission,
    // because a decision is an authorization exercise like any other.
    ['POST /tasks/permission', decidePermission],
    // Read-only workspace inspection for a dispatcher: the facts and the isolation
    // recommendation that used to be discovered only when a job admitted. It is a
    // separate route — not a field on `/tasks` — because it neither authorizes nor
    // creates anything, so it must remain answerable when `submit` is refused.
    ['POST /workspace/preflight', preflight],
  ]);

  return async function handleExecution(req, res) {
    try {
      const fence = fenceExternalConnection(req);
      if (fence.ok !== true) {
        sendJson(res, fence.status, { ok: false, error: { code: fence.code, message: 'request refused by the transport fence' } });
        return;
      }
      const bind = deps.getBindHost?.();
      if (bind !== undefined && bind !== '127.0.0.1') {
        // A non-loopback bind invalidates the only locality evidence this plane
        // has. Refuse outright rather than trust a Host header.
        sendJson(res, 403, {
          ok: false,
          error: {
            code: 'EXECUTION_BIND_NOT_LOOPBACK',
            message: 'the execution plane requires the harness webserver to listen on 127.0.0.1',
          },
        });
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.startsWith(EXECUTION_PREFIX)
        ? url.pathname.slice(EXECUTION_PREFIX.length) || '/'
        : null;
      if (path === null) {
        sendJson(res, 404, { ok: false, error: { code: 'EXECUTION_PATH_UNKNOWN', message: 'unknown path' } });
        return;
      }
      const key = `${String(req.method ?? 'GET').toUpperCase()} ${path}`;
      const handler = routes.get(key);
      if (handler === undefined) {
        sendJson(res, 404, { ok: false, error: { code: 'EXECUTION_ROUTE_UNKNOWN', message: `no route for ${key}` } });
        return;
      }

      let connection;
      if (deps.engine.authorizationMode === 'switch') {
        // Both AUTHORIZING verbs need the switch: a submission creates work and a
        // decision releases a paused call. Reads, cancel and preflight stay
        // answerable while the switch is off, so an operator can always observe and
        // stop what already exists.
        const gated = key === 'POST /tasks' || key === 'POST /tasks/permission';
        if (gated && deps.engine.posture().authorized !== true) {
          sendJson(res, 403, {
            ok: false,
            error: { code: 'DELEGATION_DISABLED', message: 'delegation is disabled in DSH settings' },
          });
          return;
        }
        connection = { connectionId: 'local-mcp', label: 'Local MCP' };
      } else {
        connection = authenticateRequest(deps, req);
      }
      if (connection === null) {
        // One refusal for every authentication failure: distinguishing "no token"
        // from "bad token" from "revoked connection" would help an attacker and
        // help an operator very little.
        sendJson(res, 401, {
          ok: false,
          error: { code: AUTH_CODES.connectionUnknown, message: 'a valid connection token is required' },
        });
        return;
      }

      await handler({ req, res, url, connection, deps });
    } catch (error) {
      const mapped = classifyError(error);
      deps.logger?.warn?.('dsh-delegate: execution plane refusal', mapped.code);
      if (res.headersSent !== true && isWritable(res)) {
        sendJson(res, mapped.status, {
          ok: false,
          error: { code: mapped.code, message: mapped.message, details: mapped.details },
        });
      }
    }
  };
}

/**
 * Whether a response can still be written to.
 *
 * A long observation can outlive its own connection: a poller that gave up closes
 * the socket, and this plane only finds out when it tries to answer. `sendJson` on
 * a destroyed response throws from `writeHead` with an opaque socket error, which
 * the refusal path would then report as an internal failure of a request nobody is
 * listening to. The check is deliberately narrow — `writableEnded`,
 * `writableFinished` (or its property form) and a destroyed socket — and it treats
 * an unknown response shape as writable, so it never suppresses an answer.
 * @param {import('node:http').ServerResponse} res - response object.
 * @returns {boolean} true when writing is still meaningful.
 */
function isWritable(res) {
  if (res === null || typeof res !== 'object') return false;
  if (res.writableEnded === true || res.writableFinished === true) return false;
  if (res.destroyed === true || res.socket?.destroyed === true) return false;
  return true;
}

/**
 * Authenticate the presented connection token.
 * @param {object} deps - dependency object.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {object | null} the connection record, or null.
 */
export function authenticateRequest(deps, req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (match === null) return null;
  return deps.auth.authenticate(match[1]);
}

async function status({ res, connection, deps }) {
  sendJson(res, 200, {
    ok: true,
    connection: { connectionId: connection.connectionId, label: connection.label },
    // The external caller is told which workspaces it may act on, and nothing
    // about models, providers, credentials or other connections.
    grants: deps.engine.authorizationMode === 'switch' ? [] : deps.auth.listGrants(connection.connectionId).filter((grant) => {
      if (grant.revokedAt !== null) return false;
      return grant.kind === 'session' ? true : grant.consumedAt === null;
    }),
    delegation: deps.engine.posture(),
  });
}

async function submitTask({ req, res, connection, deps }) {
  const body = await readJsonBody(req);
  // The continuation identity, or `undefined` for a new task conversation. It is
  // passed through as a value, never inferred from the workspace or from earlier
  // submissions: only the caller knows whether this is a follow-up, and the engine
  // validates it fail-closed.
  const continueFromTaskId = body.continueFromTaskId === undefined || body.continueFromTaskId === null
    ? undefined
    : body.continueFromTaskId;
  if (deps.engine.authorizationMode === 'switch') {
    const task = await deps.engine.start({
      connectionId: connection.connectionId,
      workspacePath: body.workspacePath,
      prompt: body.prompt,
      overrides: body.overrides,
      ...(continueFromTaskId === undefined ? {} : { continueFromTaskId }),
    });
    sendJson(res, 202, { ok: true, task });
    return;
  }
  const authorization = body.authorization === 'session' ? 'session' : 'task';
  if (authorization === 'task' && typeof body.grantId !== 'string') {
    throw new HttpError(400, 'GRANT_ID_REQUIRED', 'grantId is required for a single-task submission');
  }
  const task = await deps.engine.start({
    // The connection identity comes from the verified token, never from the body.
    connectionId: connection.connectionId,
    grantId: body.grantId,
    authorization,
    workspacePath: body.workspacePath,
    prompt: body.prompt,
    overrides: body.overrides,
    ...(continueFromTaskId === undefined ? {} : { continueFromTaskId }),
  });
  sendJson(res, 202, { ok: true, task });
}

async function listTasks({ res, connection, deps }) {
  sendJson(res, 200, { ok: true, tasks: deps.engine.list({ connectionId: connection.connectionId }) });
}

async function getTask({ req, res, connection, deps }) {
  const body = await readJsonBody(req);
  if (typeof body.taskId !== 'string') {
    throw new HttpError(400, 'TASK_ID_REQUIRED', 'taskId is required');
  }
  const task = deps.engine.get(body.taskId);
  if (task.connectionId !== connection.connectionId) {
    // Cross-connection reads are reported as absent, not as forbidden: a
    // distinct code would confirm that a task id exists.
    throw new HttpError(404, 'JOB_TASK_NOT_FOUND', 'no such task for this connection');
  }
  sendJson(res, 200, { ok: true, task });
}

async function cancelTask({ req, res, connection, deps }) {
  const body = await readJsonBody(req);
  if (typeof body.taskId !== 'string') {
    throw new HttpError(400, 'TASK_ID_REQUIRED', 'taskId is required');
  }
  const existing = deps.engine.get(body.taskId);
  if (existing.connectionId !== connection.connectionId) {
    throw new HttpError(404, 'JOB_TASK_NOT_FOUND', 'no such task for this connection');
  }
  const task = await deps.engine.cancel(body.taskId, 'connection');
  sendJson(res, 200, { ok: true, task });
}

/**
 * Decide one pending per-call permission request of one task.
 *
 * The connection identity comes from authentication, never from the body, and it
 * is the same identity that owns the task: the engine reports a task of another
 * connection — and an unknown one — as `JOB_TASK_NOT_FOUND`, one answer with one
 * set of details, so a decision call cannot be used to learn which task ids or
 * pending requests exist elsewhere.
 *
 * The body is validated here (not only in the MCP server) because this route is
 * reachable by any local caller: an unknown field, a decision outside the closed
 * vocabulary, or a reason that is not a string is refused before the engine reads
 * anything.
 * @param {object} context - `req`, `res`, `connection`, `deps`.
 * @returns {Promise<void>} resolves after the answer is sent.
 */
async function decidePermission({ req, res, connection, deps }) {
  const body = await readJsonBody(req);
  if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
    throw new HttpError(400, 'TASK_ID_REQUIRED', 'taskId is required');
  }
  if (typeof body.requestId !== 'string' || body.requestId.trim() === '') {
    throw new HttpError(400, 'PERMISSION_REQUEST_ID_REQUIRED', 'requestId is required');
  }
  if (body.decision !== 'allow-once' && body.decision !== 'reject') {
    throw new HttpError(400, 'PERMISSION_DECISION_INVALID', 'decision must be allow-once or reject');
  }
  if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
    throw new HttpError(400, 'PERMISSION_REASON_INVALID', 'reason must be a string when present');
  }
  if (body.fingerprint !== undefined && body.fingerprint !== null && typeof body.fingerprint !== 'string') {
    throw new HttpError(400, 'PERMISSION_FINGERPRINT_INVALID', 'fingerprint must be a string when present');
  }
  const result = await deps.engine.decidePermission({
    // The verified connection, not `body.connectionId`: a caller cannot name an owner.
    connectionId: connection.connectionId,
    taskId: body.taskId,
    requestId: body.requestId,
    decision: body.decision,
    ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    ...(typeof body.fingerprint === 'string' ? { fingerprint: body.fingerprint } : {}),
  });
  sendJson(res, 200, { ok: true, ...result });
}

/**
 * Report a bounded observation of one task of this connection.
 *
 * The route is a *read with a deadline*, not a write: it creates no task, consumes
 * no grant, allocates no slot, decides no permission and changes no switch. What it
 * adds over `/tasks/get` is that the answer may arrive later, and that it arrives
 * as soon as the task reaches a state a host must act on — a permission request, a
 * finished run, a failure, a cancellation — instead of forcing a client to poll.
 *
 * Three properties are enforced here rather than left to the MCP adapter:
 *
 *   1. **Ownership is proven by the same rule as `/tasks/get`**: an unknown task and
 *      another connection's task produce one answer, so an observation cannot be
 *      used to learn that a task id exists elsewhere.
 *   2. **The wait is bounded** at {@link MAX_OBSERVE_WAIT_MS}, and a negative or
 *      non-integer `waitMs` is refused rather than clamped into something the caller
 *      did not ask for.
 *   3. **Abandonment ends only this observer.** When the requesting connection goes
 *      away the wait is aborted with an `AbortSignal`; the worker keeps running and
 *      nothing about the task is changed. A normal request that has already been
 *      fully read is NOT an abandonment: after the body is consumed, `req` emits
 *      `close` for every request, so only a real `aborted`/stream error or a
 *      premature response close counts.
 * @param {object} context - `req`, `res`, `connection`, `deps`.
 * @returns {Promise<void>} resolves after the answer is sent (or after abandonment).
 */
async function observeTask({ req, res, connection, deps }) {
  const body = await readJsonBody(req);
  for (const key of Object.keys(body)) {
    if (!OBSERVE_FIELDS.includes(key)) {
      throw new HttpError(400, 'OBSERVE_ARGUMENT_UNKNOWN', `tasks/observe does not accept ${JSON.stringify(key)}`);
    }
  }
  if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
    throw new HttpError(400, 'TASK_ID_REQUIRED', 'taskId is required');
  }
  let waitMs = MAX_OBSERVE_WAIT_MS;
  if (body.waitMs !== undefined && body.waitMs !== null) {
    if (!Number.isInteger(body.waitMs) || body.waitMs < 0) {
      throw new HttpError(400, 'OBSERVE_WAIT_INVALID', 'waitMs must be a non-negative integer');
    }
    waitMs = Math.min(body.waitMs, MAX_OBSERVE_WAIT_MS);
  }

  const abandonment = createAbandonment(req, res);
  try {
    const observation = await deps.engine.observeTask(body.taskId, {
      // The verified connection, never a body field: a caller cannot name an owner.
      connectionId: connection.connectionId,
      waitMs,
      signal: abandonment.signal,
    });
    // The reader left while the engine was settling: there is nothing to answer,
    // and writing to a closed response would only throw into the refusal path.
    if (abandonment.abandoned() || !isWritable(res)) return;
    sendJson(res, 200, { ok: true, ...observation });
  } finally {
    abandonment.dispose();
  }
}

/**
 * Watch one request/response pair for a real, premature disconnect.
 *
 * A node `IncomingMessage` emits `close` after the body has been consumed on every
 * request, including a perfectly normal one whose handler is still working. So
 * `close` on the request is only treated as abandonment while the body has NOT been
 * fully read; once it has, the only evidence of abandonment is `aborted` on the
 * request, an error on its stream, or the response being closed before it finished.
 *
 * Every listener registered here is removed by {@link dispose}, so a completed
 * observation leaves no accumulating listeners behind on a request object the
 * caller may keep.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @returns {{ signal: AbortSignal, abandoned: () => boolean, dispose: () => void }} watcher.
 */
function createAbandonment(req, res) {
  const controller = new AbortController();
  let gone = false;
  const mark = (reason) => {
    if (gone) return;
    gone = true;
    controller.abort(Object.assign(new Error(reason), { name: 'AbortError', code: reason }));
  };
  const onRequestAborted = () => mark('OBSERVE_CLIENT_ABORTED');
  const onRequestError = () => mark('OBSERVE_CLIENT_ABORTED');
  const onRequestClose = () => {
    // `readableEnded` is the fact that separates "the body was consumed" from "the
    // caller vanished mid-wait". Without this distinction every normal request
    // would abort its own observation the moment the body finished.
    if (req.readableEnded !== true) mark('OBSERVE_CLIENT_ABORTED');
  };
  const onResponseClose = () => {
    // A response is closed only after it finished, or because the socket died.
    if (res.writableFinished !== true) mark('OBSERVE_CLIENT_ABORTED');
  };
  req.once?.('aborted', onRequestAborted);
  req.once?.('error', onRequestError);
  req.once?.('close', onRequestClose);
  res.once?.('close', onResponseClose);

  return {
    signal: controller.signal,
    abandoned: () => gone,
    dispose() {
      req.off?.('aborted', onRequestAborted);
      req.off?.('error', onRequestError);
      req.off?.('close', onRequestClose);
      res.off?.('close', onResponseClose);
    },
  };
}

/**
 * Report what a workspace looks like and which isolation it implies.
 *
 * Deliberately *not* gated on the switch or on the concurrency cap: this answers a
 * question about the filesystem, so it must be usable while delegation is off
 * (that is when a coordinator decides whether dispatch is worthwhile) and while
 * every slot is busy. It is still behind the same transport fence and the same
 * connection identity as every other route, and it consumes nothing: no grant, no
 * slot, no task, no commit, no worktree.
 *
 * The `engine` is given the runner the workspace layer already uses
 * (`deps.runGit`), so the preflight measures with the same seam, the same timeout
 * and the same failure classification the job itself would.
 * @param {object} context - `req`, `res`, `deps`.
 * @returns {Promise<void>} resolves after the answer is sent.
 */
async function preflight({ req, res, deps }) {
  const body = await readJsonBody(req);
  if (typeof body.workspacePath !== 'string' || body.workspacePath.trim() === '') {
    throw new HttpError(400, 'WORKSPACE_PATH_REQUIRED', 'workspacePath is required');
  }
  const result = await preflightWorkspace({ runGit: deps.runGit }, {
    workspacePath: body.workspacePath,
    allowShared: body.allowShared === true,
  });
  sendJson(res, 200, result);
}
