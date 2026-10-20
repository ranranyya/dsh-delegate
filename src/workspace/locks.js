// Workspace coordination: mutual exclusion per workspace and an audit trail of
// what a job actually changed on disk.
//
// Two guarantees, both enforced here rather than trusted from the agent:
//  1. At most one job mutates a given workspace at a time. The lock is
//     in-process, nonce-fenced and lease-bounded, so a stuck job cannot hold it
//     forever and a stale release cannot free another job's lock.
//  2. What a job changed is measured by reading git state before and after, not
//     by believing the agent's own summary.

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/** Lock refusal codes. */
export const LOCK_CODES = Object.freeze({
  busy: 'WORKSPACE_BUSY',
  invalid: 'WORKSPACE_INVALID',
});

/** An operation refused because the workspace is unavailable for it. */
export class WorkspaceError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolve a workspace path to its real absolute path.
 *
 * Refuses rather than guesses: a path that does not resolve is a refusal, and
 * the resolved value is what later boundary checks compare against so a symlink
 * cannot be used to escape the workspace.
 * @param {string} candidate - absolute workspace path.
 * @returns {Promise<string>} resolved real path.
 */
export async function resolveWorkspacePath(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new WorkspaceError(LOCK_CODES.invalid, 'a workspace path is required', {});
  }
  const absolute = candidate.trim();
  if (!(absolute.startsWith('/') || /^[A-Za-z]:[\\/]/.test(absolute) || absolute.startsWith('\\\\'))) {
    throw new WorkspaceError(LOCK_CODES.invalid, 'workspace path must be absolute', {});
  }
  try {
    return await realpath(resolve(absolute));
  } catch (error) {
    throw new WorkspaceError(LOCK_CODES.invalid, 'workspace path could not be resolved', {
      cause: error?.code ?? null,
    });
  }
}

/**
 * Whether `target` is inside `root`. Case-folded on Windows where paths are
 * compared case-insensitively.
 * @param {string} root - resolved workspace root.
 * @param {string} target - resolved candidate path.
 * @returns {boolean} true when contained (or equal).
 */
export function isInside(root, target) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const base = normalize(root).replace(/[\\/]+$/, '');
  const candidate = normalize(target);
  if (candidate === base) return true;
  const withSep = base.endsWith(sep) ? base : `${base}${sep}`;
  return candidate.startsWith(withSep);
}

/**
 * In-process workspace lock registry.
 *
 * The lock is not a file: two DSH processes would still be able to race. That
 * limitation is documented in docs/native-integration-audit.md rather than
 * papered over with a lockfile that looks stronger than it is.
 */
export class WorkspaceLocks {
  /**
   * @param {object} [options] - `now` clock override and `maxHoldMs` lease.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxHoldMs = options.maxHoldMs ?? 150 * 60 * 1000;
    /** @type {Map<string, object>} */
    this.held = new Map();
  }

  /**
   * Acquire the lock for a workspace without waiting.
   * @param {string} workspacePath - resolved absolute workspace path.
   * @param {object} input - `taskId` and optional `sessionId` for diagnostics.
   * @returns {object} the lease, including its nonce.
   */
  acquire(workspacePath, input = {}) {
    const key = lockKey(workspacePath);
    const existing = this.held.get(key);
    if (existing !== undefined && this.now() < existing.expiresAt) {
      throw new WorkspaceError(LOCK_CODES.busy, 'another job is already running in this workspace', {
        taskId: existing.taskId,
        since: existing.acquiredAt,
      });
    }
    const lease = {
      nonce: randomUUID(),
      workspacePath,
      taskId: typeof input.taskId === 'string' ? input.taskId : null,
      acquiredAt: this.now(),
      expiresAt: this.now() + this.maxHoldMs,
    };
    this.held.set(key, lease);
    return { ...lease };
  }

  /**
   * Release a lease. A release with the wrong nonce is a no-op, so one job can
   * never release another job's lock.
   * @param {string} workspacePath - locked workspace.
   * @param {string} nonce - lease nonce returned by {@link acquire}.
   * @returns {boolean} true when this call actually released the lock.
   */
  release(workspacePath, nonce) {
    const key = lockKey(workspacePath);
    const existing = this.held.get(key);
    if (existing === undefined || existing.nonce !== nonce) return false;
    this.held.delete(key);
    return true;
  }

  /**
   * Whether a workspace is currently locked by a live lease.
   * @param {string} workspacePath - workspace to test.
   * @returns {boolean} true when locked.
   */
  isLocked(workspacePath) {
    const existing = this.held.get(lockKey(workspacePath));
    if (existing === undefined) return false;
    if (this.now() >= existing.expiresAt) {
      this.held.delete(lockKey(workspacePath));
      return false;
    }
    return true;
  }

  /**
   * Drop every lease. Used on dispose: a shutdown must not leave a workspace
   * unacquirable in the next process.
   * @returns {number} number of leases dropped.
   */
  releaseAll() {
    const count = this.held.size;
    this.held.clear();
    return count;
  }
}

function lockKey(workspacePath) {
  const normalized = String(workspacePath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
