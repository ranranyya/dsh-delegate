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
        if (key === 'POST /tasks' && deps.engine.posture().authorized !== true) {
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
      if (res.headersSent !== true) {
        sendJson(res, mapped.status, {
          ok: false,
          error: { code: mapped.code, message: mapped.message, details: mapped.details },
        });
      }
    }
  };
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
  if (deps.engine.authorizationMode === 'switch') {
    const task = await deps.engine.start({
      connectionId: connection.connectionId,
      workspacePath: body.workspacePath,
      prompt: body.prompt,
      overrides: body.overrides,
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
