// Delegation authorization: server-issued connection identities and
// single-use task grants.
//
// Threat model, stated plainly so no reader mistakes this for more than it is:
// a process running as the same operating-system user, with unrestricted
// filesystem access, can read this process's memory and is not an adversarial
// security boundary. What these grants do guarantee is that no code path in
// this plugin dispatches model work without an authorization that a human
// operator created through the authenticated DSH surface — so an external tool,
// an MCP client, a prompt-injected agent, or a plain HTTP caller cannot cause
// delegation on its own, including after a restart.
//
// Deliberate design consequences:
//  * Grants live only in memory. Nothing here is persisted, so a restart cannot
//    resurrect an authorization. Delegation is off after every restart.
//  * Grant state is never derived from caller-supplied data. A caller may name a
//    grant id; only this module decides whether that grant still authorizes one
//    task, and consuming it is unconditional on success.
//  * A connection identity is issued by the server together with a random
//    secret. Only the secret's hash is retained, so a memory dump of this
//    registry does not yield usable tokens.

import { randomBytes, randomUUID } from 'node:crypto';
import { safeEqual, sha256 } from './fence.js';

/** Bounds that keep an accidental loop from growing unbounded state. */
export const AUTH_LIMITS = Object.freeze({
  connections: 16,
  grantsPerConnection: 32,
  grantsTotal: 256,
  tokenBytes: 32,
});

/** Refusal codes for authorization failures. */
export const AUTH_CODES = Object.freeze({
  connectionUnknown: 'CONNECTION_UNKNOWN',
  connectionRevoked: 'CONNECTION_REVOKED',
  connectionLimit: 'CONNECTION_LIMIT',
  grantUnknown: 'GRANT_UNKNOWN',
  grantExpired: 'GRANT_EXPIRED',
  grantRevoked: 'GRANT_REVOKED',
  grantConsumed: 'GRANT_CONSUMED',
  grantMismatch: 'GRANT_MISMATCH',
  grantLimit: 'GRANT_LIMIT',
});

/** An authorization refusal with a stable machine code. */
export class AuthError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded, non-secret details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.details = details;
  }
}

/** Task grants are single-use; session grants allow repeated execution until TTL. */
export const GRANT_KINDS = Object.freeze(['task', 'session']);

/**
 * In-memory registry of connection identities and task grants.
 *
 * All state transitions are synchronous. That is what makes consumption atomic:
 * the expiry, revocation and consumed checks run in one uninterrupted step, so
 * two concurrent callers can never both observe an unconsumed grant.
 */
export class AuthorizationRegistry {
  /**
   * @param {object} [options] - `now` clock override for tests.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, object>} */
    this.connections = new Map();
    /** @type {Map<string, object>} */
    this.grants = new Map();
  }

  /**
   * Whether any delegation authorization exists. This is the plugin's single
   * "is delegation on" oracle; it is false in a fresh process by construction.
   * @returns {boolean} true only while at least one usable grant is present.
   */
  isDelegationAuthorized() {
    this.sweep();
    for (const grant of this.grants.values()) {
      if (grant.consumedAt === null && grant.revokedAt === null && grant.expiresAt > this.now()) return true;
    }
    return false;
  }

  /**
   * Issue a new connection identity. The caller receives the secret exactly
   * once; the registry retains only its hash.
   * @param {{ label?: string, peer?: object }} input - operator-supplied label and audit facts.
   * @returns {{ connectionId: string, token: string, label: string, createdAt: number }} issued identity.
   */
  issueConnection(input = {}) {
    this.sweep();
    if (this.connections.size >= AUTH_LIMITS.connections) {
      throw new AuthError(AUTH_CODES.connectionLimit, `at most ${AUTH_LIMITS.connections} connections may be registered`, {
        limit: AUTH_LIMITS.connections,
      });
    }
    const connectionId = `conn-${randomUUID()}`;
    const token = randomBytes(AUTH_LIMITS.tokenBytes).toString('base64url');
    const label = typeof input.label === 'string' && input.label.trim() !== ''
      ? input.label.trim().slice(0, 80)
      : 'unnamed connection';
    const createdAt = this.now();
    this.connections.set(connectionId, {
      connectionId,
      label,
      tokenHash: sha256(token),
      createdAt,
      lastSeenAt: createdAt,
      revokedAt: null,
      peer: {
        // Peer facts are recorded for audit only; they never authorize anything.
        address: typeof input.peer?.address === 'string' ? input.peer.address : null,
      },
    });
    return { connectionId, token, label, createdAt };
  }

  /**
   * Resolve a presented connection token to its identity.
   * @param {unknown} token - presented secret.
   * @returns {object | null} the live connection record, or null.
   */
  authenticate(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const hash = sha256(token);
    for (const connection of this.connections.values()) {
      // Hash comparison first so the comparison itself is length-stable.
      if (!safeEqual(hash, connection.tokenHash)) continue;
      if (connection.revokedAt !== null) return null;
      connection.lastSeenAt = this.now();
      return connection;
    }
    return null;
  }

  /**
   * Revoke one connection and every grant it holds.
   * @param {string} connectionId - identity to revoke.
   * @returns {number} number of grants revoked with it.
   */
  revokeConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      throw new AuthError(AUTH_CODES.connectionUnknown, 'unknown connection', { connectionId });
    }
    if (connection.revokedAt !== null) return 0;
    connection.revokedAt = this.now();
    let revoked = 0;
    for (const grant of this.grants.values()) {
      if (grant.connectionId !== connectionId || grant.revokedAt !== null) continue;
      grant.revokedAt = connection.revokedAt;
      revoked += 1;
    }
    return revoked;
  }

  /**
   * Remove a connection and its grants entirely.
   * @param {string} connectionId - identity to forget.
   * @returns {boolean} true when something was removed.
   */
  forgetConnection(connectionId) {
    for (const [id, grant] of this.grants) {
      if (grant.connectionId === connectionId) this.grants.delete(id);
    }
    return this.connections.delete(connectionId);
  }

  /**
   * Issue an authorization for one task or one session.
   *
   * A grant always names the connection that will exercise it and the exact
   * workspace it covers. Both are required, so an authorization for one project
   * can never be spent on another.
   * @param {string} connectionId - issuing (and later exercising) connection.
   * @param {object} input - `kind`, `workspacePath`, `ttlSeconds`, `overrides`.
   * @returns {object} the grant record safe to return to its owner.
   */
  issueGrant(connectionId, input) {
    this.sweep();
    const connection = this.requireLiveConnection(connectionId);
    const kind = input?.kind;
    if (!GRANT_KINDS.includes(kind)) {
      throw new AuthError('GRANT_KIND_INVALID', `grant kind must be one of ${GRANT_KINDS.join(', ')}`, { kind });
    }
    const workspacePath = normalizeWorkspace(input?.workspacePath);
    const ttlSeconds = input?.ttlSeconds;
    if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new AuthError('GRANT_TTL_INVALID', 'grant ttlSeconds must be a positive integer', {});
    }
    if (this.grants.size >= AUTH_LIMITS.grantsTotal) {
      throw new AuthError(AUTH_CODES.grantLimit, `at most ${AUTH_LIMITS.grantsTotal} grants may be outstanding`, {
        limit: AUTH_LIMITS.grantsTotal,
      });
    }
    const own = [...this.grants.values()].filter((grant) => grant.connectionId === connection.connectionId);
    if (own.length >= AUTH_LIMITS.grantsPerConnection) {
      throw new AuthError(AUTH_CODES.grantLimit, `at most ${AUTH_LIMITS.grantsPerConnection} grants per connection`, {
        limit: AUTH_LIMITS.grantsPerConnection,
      });
    }
    const createdAt = this.now();
    const grant = {
      grantId: `grant-${randomUUID()}`,
      connectionId: connection.connectionId,
      kind,
      workspacePath,
      overrides: input?.overrides === undefined ? null : structuredClone(input.overrides),
      createdAt,
      expiresAt: createdAt + ttlSeconds * 1000,
      consumedAt: null,
      consumedByTaskId: null,
      revokedAt: null,
    };
    this.grants.set(grant.grantId, grant);
    return publicGrant(grant);
  }

  /**
   * Atomically consume a task grant for exactly one task.
   *
   * Every refusal path leaves the grant untouched and every success path marks
   * it consumed before the caller can act on it, so a replayed request can only
   * ever fail.
   * @param {object} input - `connectionId`, `grantId`, `taskId`, `workspacePath`.
   * @returns {object} the consumed grant snapshot.
   */
  consumeTaskGrant(input) {
    const connection = this.requireLiveConnection(input?.connectionId);
    const grant = this.grants.get(input?.grantId);
    if (grant === undefined || grant.connectionId !== connection.connectionId) {
      throw new AuthError(AUTH_CODES.grantUnknown, 'no such grant for this connection', {});
    }
    if (grant.kind !== 'task') {
      throw new AuthError(AUTH_CODES.grantMismatch, 'this grant does not authorize a single task', { kind: grant.kind });
    }
    this.assertUsable(grant);
    const workspacePath = normalizeWorkspace(input?.workspacePath);
    if (workspacePath !== grant.workspacePath) {
      throw new AuthError(AUTH_CODES.grantMismatch, 'grant does not cover this workspace', {
        workspacePath,
      });
    }
    const taskId = input?.taskId;
    if (typeof taskId !== 'string' || taskId === '') {
      throw new AuthError('GRANT_TASK_REQUIRED', 'consuming a task grant requires the task id it authorizes', {});
    }
    grant.consumedAt = this.now();
    grant.consumedByTaskId = taskId;
    return publicGrant(grant);
  }

  /**
   * Check a session grant without consuming it. Used by the execution plane on
   * each call, so revoking the grant stops further execution immediately.
   * @param {object} input - `connectionId`, `workspacePath` (or `grantId`).
   * @returns {object} the live session grant snapshot.
   */
  requireSessionGrant(input) {
    const connection = this.requireLiveConnection(input?.connectionId);
    const workspacePath = normalizeWorkspace(input?.workspacePath);
    let found = null;
    for (const grant of this.grants.values()) {
      if (grant.connectionId !== connection.connectionId) continue;
      if (grant.kind !== 'session') continue;
      if (grant.workspacePath !== workspacePath) continue;
      if (!this.isUsable(grant)) continue;
      found = grant;
      break;
    }
    if (found === null) {
      throw new AuthError(AUTH_CODES.grantUnknown, 'no live session grant covers this workspace', { workspacePath });
    }
    return publicGrant(found);
  }

  /**
   * Revoke one grant.
   * @param {{ connectionId?: string, grantId: unknown, allowOperator?: boolean }} input - revocation request.
   * @returns {object} the revoked grant snapshot.
   */
  revokeGrant(input) {
    const grant = this.grants.get(input?.grantId);
    if (grant === undefined) {
      throw new AuthError(AUTH_CODES.grantUnknown, 'no such grant', {});
    }
    if (input?.allowOperator !== true && grant.connectionId !== input?.connectionId) {
      throw new AuthError(AUTH_CODES.grantUnknown, 'no such grant for this connection', {});
    }
    if (grant.revokedAt === null) grant.revokedAt = this.now();
    return publicGrant(grant);
  }

  /**
   * Revoke every outstanding authorization. This is the operator's "stop
   * everything now" action and the plugin's dispose path.
   * @returns {number} number of grants revoked.
   */
  revokeAll() {
    const at = this.now();
    let count = 0;
    for (const grant of this.grants.values()) {
      if (grant.revokedAt !== null) continue;
      grant.revokedAt = at;
      count += 1;
    }
    for (const connection of this.connections.values()) {
      if (connection.revokedAt === null) connection.revokedAt = at;
    }
    return count;
  }

  /**
   * List grants visible to one connection. Consumption and expiry are reported
   * as facts; no token or hash is included.
   * @param {string} connectionId - queried connection.
   * @returns {object[]} grant snapshots owned by that connection.
   */
  listGrants(connectionId) {
    this.sweep();
    const out = [];
    for (const grant of this.grants.values()) {
      if (grant.connectionId !== connectionId) continue;
      out.push(publicGrant(grant));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * List connections for the operator surface, with liveness facts only.
   * @returns {object[]} connection snapshots without secrets or hashes.
   */
  listConnections() {
    this.sweep();
    return [...this.connections.values()]
      .map((connection) => ({
        connectionId: connection.connectionId,
        label: connection.label,
        createdAt: connection.createdAt,
        lastSeenAt: connection.lastSeenAt,
        revoked: connection.revokedAt !== null,
        revokedAt: connection.revokedAt,
        peer: { ...connection.peer },
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Drop expired grants and their registry entries.
   * @returns {number} number of entries removed.
   */
  sweep() {
    const now = this.now();
    let removed = 0;
    for (const [id, grant] of this.grants) {
      const expired = grant.expiresAt <= now;
      const spent = grant.consumedAt !== null;
      if (!expired && !spent) continue;
      // Retain spent or expired records briefly so a caller can be told why its
      // request failed instead of receiving a vague "unknown grant".
      if (now - Math.max(grant.expiresAt, grant.consumedAt ?? 0) > 10 * 60 * 1000) {
        this.grants.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  requireLiveConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      throw new AuthError(AUTH_CODES.connectionUnknown, 'unknown connection', {});
    }
    if (connection.revokedAt !== null) {
      throw new AuthError(AUTH_CODES.connectionRevoked, 'connection has been revoked', {});
    }
    return connection;
  }

  isUsable(grant) {
    return grant.consumedAt === null && grant.revokedAt === null && grant.expiresAt > this.now();
  }

  assertUsable(grant) {
    if (grant.revokedAt !== null) {
      throw new AuthError(AUTH_CODES.grantRevoked, 'grant has been revoked', {});
    }
    if (grant.consumedAt !== null) {
      throw new AuthError(AUTH_CODES.grantConsumed, 'grant has already been consumed', {
        consumedByTaskId: grant.consumedByTaskId,
        consumedAt: grant.consumedAt,
      });
    }
    if (grant.expiresAt <= this.now()) {
      throw new AuthError(AUTH_CODES.grantExpired, 'grant has expired', { expiresAt: grant.expiresAt });
    }
  }
}

/**
 * Canonical workspace key for grant comparison: absolute, no trailing
 * separator, case-folded on Windows where the filesystem is case-insensitive.
 * @param {unknown} value - candidate workspace path.
 * @returns {string} canonical workspace key.
 */
export function normalizeWorkspace(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthError('GRANT_WORKSPACE_REQUIRED', 'a workspace path is required', {});
  }
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  const absolute = trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  if (!absolute) {
    throw new AuthError('GRANT_WORKSPACE_NOT_ABSOLUTE', 'workspace path must be absolute', {});
  }
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

/**
 * Public projection of a grant: identifiers and lifecycle facts only.
 * @param {object} grant - internal record.
 * @returns {object} fresh snapshot.
 */
function publicGrant(grant) {
  return {
    grantId: grant.grantId,
    kind: grant.kind,
    workspacePath: grant.workspacePath,
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    consumedAt: grant.consumedAt,
    consumedByTaskId: grant.consumedByTaskId,
    revokedAt: grant.revokedAt,
    overrides: grant.overrides === null ? null : structuredClone(grant.overrides),
  };
}
