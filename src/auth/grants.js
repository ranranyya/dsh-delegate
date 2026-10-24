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
import path from 'node:path';

import { LIMITS } from '../config/defaults.js';
import { safeEqual, sha256 } from './fence.js';

/** Bounds that keep an accidental loop from growing unbounded state. */
export const AUTH_LIMITS = Object.freeze({
  connections: 16,
  grantsPerConnection: 32,
  grantsTotal: 256,
  tokenBytes: 32,
  listeners: 64,
});

/**
 * A connection is only live while it keeps presenting its token. The lease is
 * idle-based, not absolute: a heartbeat (an authenticated request) pushes it
 * forward, and a connection that goes silent is revoked together with its
 * grants so a background worker cannot keep executing on a forgotten grant.
 */
export const DEFAULT_CONNECTION_LEASE_MS = 120_000;

/** How long a settled grant or connection is retained before removal. */
export const AUTH_RETENTION_MS = 10 * 60 * 1000;

/** How often the host should call {@link AuthorizationRegistry#sweep}. */
export const AUTH_SWEEP_INTERVAL_MS = 30_000;

/** Reasons carried by invalidation events. */
export const AUTH_EVENT_REASONS = Object.freeze({
  revoked: 'revoked',
  expired: 'expired',
  leaseExpired: 'lease-expired',
  revokedAll: 'revoked-all',
});

/** Refusal codes for authorization failures. */
export const AUTH_CODES = Object.freeze({
  connectionUnknown: 'CONNECTION_UNKNOWN',
  connectionRevoked: 'CONNECTION_REVOKED',
  connectionExpired: 'CONNECTION_EXPIRED',
  connectionLimit: 'CONNECTION_LIMIT',
  grantUnknown: 'GRANT_UNKNOWN',
  grantExpired: 'GRANT_EXPIRED',
  grantRevoked: 'GRANT_REVOKED',
  grantConsumed: 'GRANT_CONSUMED',
  grantNotConsumed: 'GRANT_NOT_CONSUMED',
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
   * @param {object} [options] - `now` clock and `leaseMs` overrides for tests.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    const leaseMs = options.leaseMs ?? DEFAULT_CONNECTION_LEASE_MS;
    if (typeof leaseMs !== 'number' || !Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new AuthError('AUTH_LEASE_INVALID', 'leaseMs must be a positive number of milliseconds', {});
    }
    this.leaseMs = leaseMs;
    /** @type {Map<string, object>} */
    this.connections = new Map();
    /** @type {Map<string, object>} */
    this.grants = new Map();
    /** @type {Set<Function>} */
    this.listeners = new Set();
  }

  /**
   * Subscribe to invalidation events.
   *
   * An event is emitted whenever an authorization stops being usable for a
   * reason other than "this request failed": revocation, expiry, an operator
   * revoke-all, or a connection losing its idle lease. The job engine subscribes
   * here and cancels matching tasks, which is what makes revoke an actual
   * cancellation rather than a promise.
   *
   * Listener failures are swallowed: one bad subscriber must not break
   * authorization bookkeeping for everyone else.
   * @param {(event: {kind: 'grant'|'connection'|'all', grantId?: string, connectionId?: string, reason: string}) => void} listener - callback.
   * @returns {() => void} unsubscribe function; idempotent.
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new AuthError('AUTH_LISTENER_INVALID', 'an invalidation listener must be a function', {});
    }
    if (this.listeners.size >= AUTH_LIMITS.listeners) {
      throw new AuthError(AUTH_CODES.grantLimit, `at most ${AUTH_LIMITS.listeners} listeners may be registered`, {
        limit: AUTH_LIMITS.listeners,
      });
    }
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /**
   * Emit one invalidation event to every subscriber.
   * @param {object} event - `kind`, optional `grantId`/`connectionId`, `reason`.
   * @returns {void}
   */
  emit(event) {
    const payload = Object.freeze({
      kind: event.kind,
      ...(event.grantId === undefined ? {} : { grantId: event.grantId }),
      ...(event.connectionId === undefined ? {} : { connectionId: event.connectionId }),
      reason: event.reason,
    });
    for (const listener of [...this.listeners]) {
      try {
        listener(payload);
      } catch {
        // A subscriber's failure is its own problem; the registry stays usable.
      }
    }
  }

  /**
   * Drop every subscriber. Used on dispose so a stopped plugin cannot be woken.
   * @returns {number} number of listeners removed.
   */
  unsubscribeAll() {
    const removed = this.listeners.size;
    this.listeners.clear();
    return removed;
  }

  /**
   * Whether any delegation authorization exists. This is the plugin's single
   * "is delegation on" oracle; it is false in a fresh process by construction.
   * @returns {boolean} true only while at least one usable grant is present.
   */
  isDelegationAuthorized() {
    this.sweep();
    for (const grant of this.grants.values()) {
      if (!this.isUsable(grant)) continue;
      const connection = this.connections.get(grant.connectionId);
      if (connection === undefined || !this.isConnectionLive(connection)) continue;
      return true;
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
   * Resolve a presented connection token to its identity and renew its lease.
   *
   * Authentication is the heartbeat: an authenticated request is the only thing
   * that pushes `lastSeenAt` forward. A token that is recognised but whose lease
   * has already lapsed is refused *without* renewal, so a silent period cannot be
   * papered over by the next request — the connection stays revoked.
   * @param {unknown} token - presented secret.
   * @returns {object | null} the live connection record, or null.
   */
  authenticate(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const hash = sha256(token);
    for (const connection of this.connections.values()) {
      // Hash comparison first so the comparison itself is length-stable.
      if (!safeEqual(hash, connection.tokenHash)) continue;
      if (!this.isConnectionLive(connection)) {
        // Expired or revoked: refuse and make sure the state is settled, but do
        // not refresh the lease. Renewing here would let an attacker who holds a
        // stale token revive a dead connection indefinitely.
        this.expireConnection(connection, AUTH_EVENT_REASONS.leaseExpired);
        return null;
      }
      connection.lastSeenAt = this.now();
      return connection;
    }
    return null;
  }

  /**
   * Whether a connection record may still act.
   * @param {object} connection - internal record.
   * @returns {boolean} true when not revoked and inside its idle lease.
   */
  isConnectionLive(connection) {
    if (connection.revokedAt !== null) return false;
    return this.now() - connection.lastSeenAt <= this.leaseMs;
  }

  /**
   * Revoke a connection because its idle lease lapsed, and emit the event.
   *
   * A connection that is already revoked has already been announced; it is not
   * re-announced with a different reason, because that would cancel the same
   * tasks twice under a misleading cause.
   * @param {object} connection - internal record.
   * @param {string} reason - event reason.
   * @returns {number} number of grants revoked alongside it.
   */
  expireConnection(connection, reason) {
    if (connection.revokedAt !== null) return 0;
    return this.revokeConnectionInternal(connection, reason);
  }

  /**
   * Revoke one connection and every grant it holds.
   *
   * The grants are revoked in the same synchronous step, so no execution can
   * observe "connection revoked but grant still live". One `connection` event is
   * emitted so the engine can cancel that connection's running tasks.
   * @param {string} connectionId - identity to revoke.
   * @returns {number} number of grants revoked with it.
   */
  revokeConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      throw new AuthError(AUTH_CODES.connectionUnknown, 'unknown connection', { connectionId });
    }
    if (connection.revokedAt !== null) return 0;
    return this.revokeConnectionInternal(connection, AUTH_EVENT_REASONS.revoked);
  }

  /**
   * Shared revocation path: stamp the connection, its grants, and announce it once.
   * @param {object} connection - internal record.
   * @param {string} reason - event reason.
   * @returns {number} number of grants revoked with it.
   */
  revokeConnectionInternal(connection, reason) {
    const at = this.now();
    connection.revokedAt = at;
    let revoked = 0;
    for (const grant of this.grants.values()) {
      if (grant.connectionId !== connection.connectionId || grant.revokedAt !== null) continue;
      grant.revokedAt = at;
      revoked += 1;
    }
    this.emit({ kind: 'connection', connectionId: connection.connectionId, reason });
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
    // The TTL is bounded per kind by the same limits settings validation uses,
    // so a caller cannot mint an effectively permanent authorization by asking
    // for a longer lifetime than the operator's own settings allow.
    const bounds = kind === 'session'
      ? { min: LIMITS.sessionGrantTtlSecondsMin, max: LIMITS.sessionGrantTtlSecondsMax }
      : { min: LIMITS.taskGrantTtlSecondsMin, max: LIMITS.taskGrantTtlSecondsMax };
    if (ttlSeconds < bounds.min || ttlSeconds > bounds.max) {
      throw new AuthError(
        'GRANT_TTL_OUT_OF_RANGE',
        `a ${kind} grant TTL must be between ${bounds.min} and ${bounds.max} seconds`,
        { kind, min: bounds.min, max: bounds.max, ttlSeconds },
      );
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
   * Assert that a specific task is still authorized right now.
   *
   * This is the check a long-running job repeats as it progresses, and it is
   * deliberately stricter than "a grant exists":
   *
   *  * the connection must be live (not revoked, not past its idle lease);
   *  * the grant must belong to that exact connection and cover that exact
   *    workspace;
   *  * the grant must not be revoked or expired;
   *  * a `task` grant must already be consumed *by this very task*, because a
   *    consumed task grant stays consumed — it authorizes its own task and no
   *    other, and an unconsumed one has not authorized anything yet;
   *  * a `session` grant must be the one named by `grantId`, if one is named.
   *
   * @param {{ connectionId: unknown, grantId: unknown, taskId: unknown, workspacePath: unknown }} input - the four facts.
   * @returns {object} a safe clone of the grant, never the stored record.
   */
  assertTaskAuthorized(input) {
    const connection = this.requireLiveConnection(input?.connectionId);
    const taskId = input?.taskId;
    if (typeof taskId !== 'string' || taskId === '') {
      throw new AuthError('GRANT_TASK_REQUIRED', 'an authorization check requires the task id', {});
    }
    const grant = this.grants.get(input?.grantId);
    if (grant === undefined || grant.connectionId !== connection.connectionId) {
      // Another connection's grant is reported as unknown, never as forbidden:
      // a distinct code would confirm that the id exists.
      throw new AuthError(AUTH_CODES.grantUnknown, 'no such grant for this connection', {});
    }
    // Only revocation and expiry disqualify a grant here: a task grant that is
    // consumed *by this task* is exactly what authorizes it, so consumption is
    // checked below as a binding rather than refused as a state.
    this.assertLive(grant);
    const workspacePath = normalizeWorkspace(input?.workspacePath);
    if (workspacePath !== grant.workspacePath) {
      throw new AuthError(AUTH_CODES.grantMismatch, 'grant does not cover this workspace', { workspacePath });
    }
    if (grant.kind === 'task') {
      if (grant.consumedAt === null) {
        throw new AuthError(AUTH_CODES.grantNotConsumed, 'this task grant has not been consumed by any task', {});
      }
      if (grant.consumedByTaskId !== taskId) {
        throw new AuthError(AUTH_CODES.grantConsumed, 'grant has already been consumed by another task', {
          consumedByTaskId: grant.consumedByTaskId,
          consumedAt: grant.consumedAt,
        });
      }
    } else if (grant.kind !== 'session') {
      throw new AuthError(AUTH_CODES.grantMismatch, 'this grant kind does not authorize a task', { kind: grant.kind });
    }
    return publicGrant(grant);
  }

  /**
   * Check a session grant without consuming it. Used by the execution plane on
   * each call, so revoking the grant stops further execution immediately.
   *
   * When `grantId` is supplied, exactly that grant is checked. A caller that
   * names a grant and is then handed a *different* live grant would be told it
   * holds an authorization it never referenced, so the lookup is never widened.
   * @param {object} input - `connectionId`, `workspacePath`, optional `grantId`.
   * @returns {object} the live session grant snapshot.
   */
  requireSessionGrant(input) {
    const connection = this.requireLiveConnection(input?.connectionId);
    const workspacePath = normalizeWorkspace(input?.workspacePath);
    const named = input?.grantId;
    if (named !== undefined) {
      const grant = this.grants.get(named);
      if (grant === undefined || grant.connectionId !== connection.connectionId) {
        throw new AuthError(AUTH_CODES.grantUnknown, 'no such grant for this connection', {});
      }
      if (grant.kind !== 'session') {
        throw new AuthError(AUTH_CODES.grantMismatch, 'this grant is not a session grant', { kind: grant.kind });
      }
      if (grant.workspacePath !== workspacePath) {
        throw new AuthError(AUTH_CODES.grantMismatch, 'grant does not cover this workspace', { workspacePath });
      }
      if (!this.isUsable(grant)) this.assertUsable(grant);
      return publicGrant(grant);
    }
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
   * Revoke one grant and announce it.
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
    if (grant.revokedAt === null) {
      grant.revokedAt = this.now();
      this.emit({
        kind: 'grant',
        grantId: grant.grantId,
        connectionId: grant.connectionId,
        reason: AUTH_EVENT_REASONS.revoked,
      });
    }
    return publicGrant(grant);
  }

  /**
   * Revoke every outstanding authorization. This is the operator's "stop
   * everything now" action and the plugin's dispose path.
   *
   * One `all` event is emitted instead of one event per grant: a subscriber
   * should stop everything once, not N times.
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
    this.emit({ kind: 'all', reason: AUTH_EVENT_REASONS.revokedAll });
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
   *
   * `live` and `leaseExpiresAt` are derived, not stored: a connection is live
   * while it is not revoked and inside its idle lease. The token and its hash are
   * never part of this projection, now or later.
   * @returns {object[]} connection snapshots without secrets or hashes.
   */
  listConnections() {
    this.sweep();
    const now = this.now();
    return [...this.connections.values()]
      .map((connection) => ({
        connectionId: connection.connectionId,
        label: connection.label,
        createdAt: connection.createdAt,
        lastSeenAt: connection.lastSeenAt,
        leaseExpiresAt: connection.lastSeenAt + this.leaseMs,
        live: this.isConnectionLive(connection),
        revoked: connection.revokedAt !== null,
        revokedAt: connection.revokedAt,
        peer: { ...connection.peer },
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Settle and bound the registry.
   *
   * Three things happen here and all of them are idempotent:
   *
   *  1. A connection past its idle lease is revoked together with its grants,
   *     and one `connection` event is emitted so the engine can cancel its work.
   *  2. A grant that expires before being revoked emits one `grant` event, once
   *     — including a grant a running task has consumed. Expiring quietly would
   *     leave a running task with no notification.
   *  3. Settled grants and connections older than the retention window are
   *     deleted, which is what keeps both maps bounded across a long session.
   *
   * @returns {{ grants: number, connections: number }} number of entries removed.
   */
  sweep() {
    const now = this.now();
    let grantsRemoved = 0;
    let connectionsRemoved = 0;

    for (const connection of this.connections.values()) {
      if (connection.revokedAt !== null) continue;
      if (now - connection.lastSeenAt <= this.leaseMs) continue;
      this.expireConnection(connection, AUTH_EVENT_REASONS.leaseExpired);
    }

    for (const [id, grant] of this.grants) {
      if (grant.expiryAnnounced !== true && grant.expiresAt <= now) {
        grant.expiryAnnounced = true;
        // A revoked grant has already been announced as revoked and must not be
        // re-announced. A *consumed* grant has not: a running task holding it
        // needs to learn that its authorization has run out, so consumption is
        // deliberately not part of this condition.
        if (grant.revokedAt === null) {
          this.emit({
            kind: 'grant',
            grantId: grant.grantId,
            connectionId: grant.connectionId,
            reason: AUTH_EVENT_REASONS.expired,
          });
        }
      }
      const settledAt = Math.max(grant.expiresAt, grant.consumedAt ?? 0, grant.revokedAt ?? 0);
      if (settledAt === 0) continue;
      if (now - settledAt <= AUTH_RETENTION_MS) continue;
      this.grants.delete(id);
      grantsRemoved += 1;
    }

    for (const [id, connection] of this.connections) {
      if (connection.revokedAt === null) continue;
      if (now - connection.revokedAt <= AUTH_RETENTION_MS) continue;
      this.connections.delete(id);
      connectionsRemoved += 1;
    }

    return { grants: grantsRemoved, connections: connectionsRemoved };
  }

  /**
   * Resolve a connection that must still be able to act.
   *
   * An expired lease is reported as expired and the connection is settled (with
   * its invalidation event) rather than being silently refreshed: the caller did
   * not present a token on this path, so there is no heartbeat to justify
   * renewal.
   * @param {unknown} connectionId - connection identity.
   * @returns {object} the live connection record.
   */
  requireLiveConnection(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      throw new AuthError(AUTH_CODES.connectionUnknown, 'unknown connection', {});
    }
    if (connection.revokedAt !== null) {
      throw new AuthError(AUTH_CODES.connectionRevoked, 'connection has been revoked', {});
    }
    if (!this.isConnectionLive(connection)) {
      this.expireConnection(connection, AUTH_EVENT_REASONS.leaseExpired);
      throw new AuthError(AUTH_CODES.connectionExpired, 'connection lease has expired', {});
    }
    return connection;
  }

  isUsable(grant) {
    return grant.consumedAt === null && grant.revokedAt === null && grant.expiresAt > this.now();
  }

  /**
   * Refuse a grant that is revoked or expired. Consumption is not checked here
   * because whether consumption is disqualifying depends on the question: a
   * task grant must be consumed to authorize its own task.
   * @param {object} grant - internal record.
   * @returns {void}
   */
  assertLive(grant) {
    if (grant.revokedAt !== null) {
      throw new AuthError(AUTH_CODES.grantRevoked, 'grant has been revoked', {});
    }
    if (grant.expiresAt <= this.now()) {
      throw new AuthError(AUTH_CODES.grantExpired, 'grant has expired', { expiresAt: grant.expiresAt });
    }
  }

  assertUsable(grant) {
    this.assertLive(grant);
    if (grant.consumedAt !== null) {
      throw new AuthError(AUTH_CODES.grantConsumed, 'grant has already been consumed', {
        consumedByTaskId: grant.consumedByTaskId,
        consumedAt: grant.consumedAt,
      });
    }
  }
}

/**
 * Canonical workspace key for grant comparison.
 *
 * Two spellings of the same directory must produce the same key, or a grant
 * issued for `C:\work\project` would refuse a request for `c:/work/project/`.
 * The rules are explicit so they can be reasoned about:
 *
 *  * the value must be a non-empty string without a NUL byte;
 *  * it must be absolute (a drive-letter path, a UNC path, or a rooted path);
 *  * it is normalized and resolved as a path (`..` and `.` segments collapse),
 *    which is why `C:\work\..\other` and `C:\other` are the same key;
 *  * a filesystem root keeps its separator: `C:\` and `/` stay `C:\` and `/`,
 *    because `C:` is a drive-relative path, not the root;
 *  * on Windows, both separators are folded to `\` and the whole key is
 *    lowercased, since that filesystem is case-insensitive.
 *
 * @param {unknown} value - candidate workspace path.
 * @returns {string} canonical workspace key.
 */
export function normalizeWorkspace(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthError('GRANT_WORKSPACE_REQUIRED', 'a workspace path is required', {});
  }
  if (value.includes('\0')) {
    throw new AuthError('GRANT_WORKSPACE_INVALID', 'a workspace path must not contain a NUL byte', {});
  }
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new AuthError('GRANT_WORKSPACE_NOT_ABSOLUTE', 'workspace path must be absolute', {});
  }
  const resolved = path.resolve(trimmed);
  if (process.platform !== 'win32') return resolved;
  const folded = resolved.replace(/\//g, '\\').toLowerCase();
  // `path.resolve` already produced a root-preserving form; keep it that way so
  // `c:\` never degrades to `c:`.
  return folded;
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
