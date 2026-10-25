// Isolated git worktrees for delegated runs.
//
// A delegated run is allowed to mutate files. When the operator asks for
// worktree isolation, it must mutate a *different* checkout than the one the
// human is looking at. This module owns that checkout:
//
//  - it is created by `git worktree add --detach <pinned-commit>`, so the run
//    starts from an exact commit and no branch is moved in either repository;
//  - it lives under a plugin-owned root directory, never inside the user's
//    checkout, and never at a path a caller supplied directly;
//  - every mutation is an argv array handed to the same `runGit` seam the rest
//    of the plugin uses — no shell, no `checkout`, no `reset`, no merge, no
//    rebase anywhere in this file;
//  - it is kept after the run so the host can review it, and it is only removed
//    when a host says so. A finished tree is evidence, not garbage.
//
// What this is NOT: a security boundary against the agent process. A delegated
// agent runs as the same OS user; worktree isolation keeps the *human's files*
// from being edited, it does not sandbox a hostile program. That is stated here
// rather than implied by the word "isolated".

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { AUDIT_CODES, AUDIT_LIMITS, AuditError, probeRepository, readRepositoryTopLevel, readStatus } from './audit.js';
import { isInside } from './locks.js';

/** Worktree refusal codes. Each is a refusal, never a silent fallback. */
export const WORKTREE_CODES = Object.freeze({
  gitUnavailable: 'WORKTREE_GIT_UNAVAILABLE',
  notRepository: 'WORKTREE_NOT_A_REPOSITORY',
  noCommits: 'WORKTREE_NO_COMMITS',
  sourceDirty: 'WORKTREE_SOURCE_DIRTY',
  rootInvalid: 'WORKTREE_ROOT_INVALID',
  pathEscape: 'WORKTREE_PATH_ESCAPE',
  nestedDestination: 'WORKTREE_NESTED_DESTINATION',
  destinationExists: 'WORKTREE_DESTINATION_EXISTS',
  cancelled: 'WORKTREE_CANCELLED',
  gitFailed: 'WORKTREE_GIT_FAILED',
  unknownTree: 'WORKTREE_UNKNOWN_TREE',
  notReviewed: 'WORKTREE_NOT_REVIEWED',
  taskIdInvalid: 'WORKTREE_TASK_ID_INVALID',
});

/** Tree states. `awaiting-host-review` is where a tree stays until a host acts. */
export const WORKTREE_STATES = Object.freeze({
  active: 'active',
  awaitingHostReview: 'awaiting-host-review',
  disposed: 'disposed',
});

/** Raised when a worktree request is refused. */
export class WorktreeError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded details; never file content.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Reduce a task id to a safe single path segment.
 *
 * The task id is caller-influenced, so it is not trusted as a path component:
 * anything outside `[A-Za-z0-9._-]` becomes `-`, leading dots are dropped so no
 * generated name can be mistaken for a hidden or parent directory, and the
 * segment is length-bounded.
 * @param {unknown} taskId - raw task id.
 * @returns {string} safe segment, or an empty string when nothing usable remains.
 */
export function safeTaskSegment(taskId) {
  if (typeof taskId !== 'string') return '';
  const cleaned = taskId.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 48);
  return cleaned === '' ? '' : cleaned;
}

/**
 * Build a refusal from a failed git invocation.
 * @param {string} step - which invocation failed.
 * @param {object} result - runner result.
 * @returns {WorktreeError} refusal to throw.
 */
function gitFailure(step, result) {
  return new WorktreeError(WORKTREE_CODES.gitFailed, `git ${step} failed`, {
    step,
    exitCode: typeof result?.code === 'number' ? result.code : null,
    stderr: String(result?.stderr ?? '').trim().slice(0, AUDIT_LIMITS.stderrBytes),
  });
}

/**
 * Validate the shape a runner returned.
 * @param {unknown} result - runner result.
 * @param {string} step - invocation name.
 * @returns {{stdout: string, stderr: string, code: number}} result.
 */
function requireResult(result, step) {
  if (result === null || typeof result !== 'object' || typeof result.stdout !== 'string' || typeof result.code !== 'number') {
    throw new WorktreeError(WORKTREE_CODES.gitFailed, `the git runner returned no usable result for ${step}`, { step });
  }
  return { stdout: result.stdout, stderr: typeof result.stderr === 'string' ? result.stderr : '', code: result.code };
}

/**
 * Whether a path exists, without following a final symlink.
 * @param {string} target - absolute path.
 * @returns {Promise<boolean>} true when something is there.
 */
async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Owns plugin-created detached worktrees.
 *
 * One manager per plugin instance. The manager keeps metadata in memory only: a
 * restart forgets the registry, which is honest — a forgotten tree is still on
 * disk and still reviewable, and the alternative (silently deleting trees at
 * startup) would destroy evidence.
 */
export class WorktreeManager {
  /**
   * @param {object} deps - `runGit` runner (same seam as the audit module).
   * @param {object} options - `rootDir` (required), optional `now` and `randomId`.
   */
  constructor(deps, options = {}) {
    if (typeof deps?.runGit !== 'function') {
      throw new WorktreeError(WORKTREE_CODES.gitFailed, 'a runGit runner is required', {});
    }
    if (typeof options.rootDir !== 'string' || options.rootDir.trim() === '' || !isAbsolute(options.rootDir.trim())) {
      throw new WorktreeError(WORKTREE_CODES.rootInvalid, 'an absolute rootDir for worktrees is required', {});
    }
    this.deps = deps;
    this.rootDir = resolve(options.rootDir.trim());
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.randomId = typeof options.randomId === 'function' ? options.randomId : () => randomUUID().slice(0, 8);
    /** @type {Map<string, object>} keyed by normalized workspace path. */
    this.trees = new Map();
    this.rootReady = null;
  }

  /**
   * Create the root directory once and resolve it to its real path.
   *
   * Resolving after creation matters: every containment check below compares
   * real paths, so a symlinked root cannot be used to place a tree anywhere
   * else.
   * @returns {Promise<string>} resolved root directory.
   */
  async ensureRoot() {
    if (this.rootReady === null) {
      this.rootReady = (async () => {
        await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
        return await realpath(this.rootDir);
      })();
    }
    return await this.rootReady;
  }

  /**
   * Prepare one detached worktree for a task.
   *
   * Order is deliberate: every refusal that can be decided without touching the
   * filesystem happens first, then the commit is pinned, then the tree is
   * created, then it is verified. A cancellation observed at any point before
   * the caller receives a workspace means the caller must not run anything.
   * @param {object} request - `taskId`, `sourcePath`, optional `signal`.
   * @returns {Promise<object>} `{ workspacePath, baseHead, sourcePath, isolated: true, ... }`.
   */
  async prepare(request = {}) {
    const taskId = typeof request.taskId === 'string' ? request.taskId.trim() : '';
    if (taskId === '') {
      throw new WorktreeError(WORKTREE_CODES.taskIdInvalid, 'a task id is required to prepare a worktree', {});
    }
    const segment = safeTaskSegment(taskId);
    if (segment === '') {
      throw new WorktreeError(WORKTREE_CODES.taskIdInvalid, 'the task id has no path-safe characters', { taskId });
    }
    if (typeof request.sourcePath !== 'string' || request.sourcePath.trim() === '' || !isAbsolute(request.sourcePath.trim())) {
      throw new WorktreeError(WORKTREE_CODES.rootInvalid, 'an absolute source repository path is required', {});
    }
    const signal = request.signal;
    this.throwIfAborted(signal, { taskId, phase: 'before-probe' });

    const sourcePath = await realpath(resolve(request.sourcePath.trim())).catch((error) => {
      throw new WorktreeError(WORKTREE_CODES.notRepository, 'the source repository path could not be resolved', {
        cause: error?.code ?? null,
      });
    });
    // Containment is decided against the repository's canonical top level, not
    // against the supplied path. A supplied path may be a directory *inside* the
    // repository, and a tree root that sits elsewhere in that same repository is
    // exactly as unsafe as one under the subdirectory: either way the agent's
    // checkout would land inside the user's repository.
    const repositoryRoot = await this.resolveRepositoryRoot(sourcePath, taskId);
    const declaredRoot = this.rootDir;
    // A tree inside the source checkout would put agent writes back into the
    // user's working directory and make `git status` ambiguous. Both the
    // declared root and its resolved path are checked, because the root may be
    // reached through a symlink that only applies after it exists.
    if (isInside(repositoryRoot, declaredRoot)) {
      throw new WorktreeError(
        WORKTREE_CODES.nestedDestination,
        'the worktree root is inside the source repository; choose a root outside it',
        { rootDir: declaredRoot, sourcePath, repositoryRoot },
      );
    }
    const root = await this.ensureRoot();
    if (isInside(repositoryRoot, root)) {
      throw new WorktreeError(
        WORKTREE_CODES.nestedDestination,
        'the worktree root is inside the source repository; choose a root outside it',
        { rootDir: root, sourcePath, repositoryRoot },
      );
    }

    const facts = await this.probeSource(sourcePath, taskId);
    const dirty = await this.assertClean(sourcePath, taskId);
    this.throwIfAborted(signal, { taskId, phase: 'before-create' });

    const workspacePath = await this.claimDestination(root, segment, taskId, sourcePath, repositoryRoot);
    this.throwIfAborted(signal, { taskId, phase: 'before-create' });

    // `--detach` binds the tree to a commit, not a branch: nothing the run does
    // can move a ref in the user's repository.
    const created = requireResult(
      await this.deps.runGit(sourcePath, ['worktree', 'add', '--detach', workspacePath, facts.head]),
      'worktree add',
    );
    if (created.code !== 0) {
      // A partially created tree must not be left behind claiming to be usable.
      await this.removeLeftover(sourcePath, workspacePath);
      throw gitFailure('worktree add', created);
    }

    const record = {
      taskId,
      workspacePath,
      sourcePath,
      baseHead: facts.head,
      isolated: true,
      detachedVerified: false,
      state: WORKTREE_STATES.active,
      createdAt: this.now(),
      completedAt: null,
      // Baseline facts the engine records with the task; names and counts only.
      sourcePreexistingChanges: dirty.total,
    };
    this.trees.set(normalizeKey(workspacePath), record);

    try {
      await this.verifyTree(record);
    } catch (error) {
      await this.removeLeftover(sourcePath, workspacePath);
      this.trees.delete(normalizeKey(workspacePath));
      throw error;
    }

    // A cancellation that arrived while `git worktree add` was running must not
    // hand the caller a usable workspace.
    if (signal?.aborted === true) {
      await this.removeLeftover(sourcePath, workspacePath);
      this.trees.delete(normalizeKey(workspacePath));
      throw new WorktreeError(WORKTREE_CODES.cancelled, 'the worktree was cancelled before the run could start', {
        taskId,
        phase: 'after-create',
      });
    }

    return this.view(record);
  }

  /**
   * Measure the canonical top level of the source repository.
   *
   * This runs before anything is created, and it is the value every containment
   * check below compares against: the supplied `sourcePath` may be a directory
   * inside the repository, so using it as the boundary would let a root located
   * elsewhere in the same repository pass as "outside the source".
   * @param {string} sourcePath - resolved source path.
   * @param {string} taskId - task id, for details.
   * @returns {Promise<string>} resolved top-level directory.
   */
  async resolveRepositoryRoot(sourcePath, taskId) {
    let topLevel;
    try {
      topLevel = await readRepositoryTopLevel(this.deps.runGit, sourcePath);
    } catch (error) {
      if (error instanceof AuditError && error.code === AUDIT_CODES.gitUnavailable) {
        throw new WorktreeError(WORKTREE_CODES.gitUnavailable, 'worktree isolation requires git in this environment', {
          taskId,
          cause: error?.details?.cause ?? null,
        });
      }
      throw error;
    }
    if (typeof topLevel !== 'string' || topLevel.trim() === '') {
      throw new WorktreeError(WORKTREE_CODES.notRepository, 'worktree isolation requires a git work tree', { taskId });
    }
    return await realpath(topLevel).catch((error) => {
      throw new WorktreeError(WORKTREE_CODES.notRepository, 'the repository root could not be resolved', {
        taskId,
        cause: error?.code ?? null,
      });
    });
  }

  /**
   * Confirm the source is a git work tree with a commit.
   * @param {string} sourcePath - resolved source repository.
   * @param {string} taskId - task id, for details.
   * @returns {Promise<{head: string}>} pinned commit facts.
   */
  async probeSource(sourcePath, taskId) {
    let facts;
    try {
      facts = await probeRepository(this.deps.runGit, sourcePath);
    } catch (error) {
      if (error instanceof AuditError && error.code === AUDIT_CODES.gitUnavailable) {
        throw new WorktreeError(WORKTREE_CODES.gitUnavailable, 'worktree isolation requires git in this environment', {
          taskId,
          cause: error?.details?.cause ?? null,
        });
      }
      throw error;
    }
    if (!facts.git) {
      throw new WorktreeError(WORKTREE_CODES.gitUnavailable, 'worktree isolation requires git in this environment', { taskId });
    }
    if (!facts.repository) {
      throw new WorktreeError(WORKTREE_CODES.notRepository, 'worktree isolation requires a git work tree', { taskId });
    }
    if (!facts.hasCommits || typeof facts.head !== 'string') {
      throw new WorktreeError(
        WORKTREE_CODES.noCommits,
        'worktree isolation requires at least one commit; commit the workspace first',
        { taskId },
      );
    }
    return facts;
  }

  /**
   * Require a clean source checkout.
   *
   * A dirty source is refused rather than carried into the tree: a worktree is
   * created from a commit, so uncommitted edits would silently *not* be there,
   * and the delegated run would fail for a reason nobody can see.
   * @param {string} sourcePath - resolved source repository.
   * @param {string} taskId - task id, for details.
   * @returns {Promise<{total: number, paths: string[], truncated: boolean}>} bounded dirt facts.
   */
  async assertClean(sourcePath, taskId) {
    const status = await readStatus(this.deps, sourcePath, { limit: AUDIT_LIMITS.samplePaths });
    if (status.total > 0) {
      throw new WorktreeError(
        WORKTREE_CODES.sourceDirty,
        `the source workspace has ${status.total} uncommitted change(s); commit or stash them before requesting worktree isolation`,
        {
          taskId,
          sourcePath,
          changes: status.total,
          // Names only: the refusal must not read what was changed.
          paths: status.entries.slice(0, AUDIT_LIMITS.samplePaths).map((entry) => entry.path),
          truncated: status.truncated,
        },
      );
    }
    return status;
  }

  /**
   * Choose a unique destination under the root and prove it is contained.
   * @param {string} root - resolved root directory.
   * @param {string} segment - safe task segment.
   * @param {string} taskId - task id, for details.
   * @param {string} sourcePath - resolved source path named by the caller.
   * @param {string} repositoryRoot - resolved top level of the source repository.
   * @returns {Promise<string>} unused absolute destination path.
   */
  async claimDestination(root, segment, taskId, sourcePath, repositoryRoot) {
    const suffix = String(this.randomId() ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || randomUUID().slice(0, 8);
    const workspacePath = join(root, `${segment}-${suffix}`);
    // The generated name must remain inside the root; a task id that survives
    // sanitization cannot escape, and this check proves it rather than assuming.
    if (!isInside(root, workspacePath)) {
      throw new WorktreeError(WORKTREE_CODES.pathEscape, 'the worktree path escaped the plugin root', { taskId });
    }
    // Containment is against the repository root, not only the supplied path: a
    // destination elsewhere in the same repository is just as much inside the
    // user's checkout as one under a supplied subdirectory.
    const boundary = typeof repositoryRoot === 'string' && repositoryRoot !== '' ? repositoryRoot : sourcePath;
    if (isInside(boundary, workspacePath) || isInside(sourcePath, workspacePath) || workspacePath === sourcePath) {
      throw new WorktreeError(
        WORKTREE_CODES.nestedDestination,
        'the worktree destination would be inside the source repository',
        { taskId, workspacePath, sourcePath, repositoryRoot: boundary },
      );
    }
    if (await pathExists(workspacePath)) {
      throw new WorktreeError(WORKTREE_CODES.destinationExists, 'the worktree destination already exists', {
        taskId,
        workspacePath,
      });
    }
    return workspacePath;
  }

  /**
   * Verify that the tree really points at the pinned commit.
   * @param {object} record - tree record.
   * @returns {Promise<void>} resolves when verified.
   */
  async verifyTree(record) {
    const head = requireResult(
      await this.deps.runGit(record.workspacePath, ['rev-parse', '--verify', 'HEAD']),
      'rev-parse --verify HEAD',
    );
    const sha = head.stdout.trim();
    if (head.code !== 0 || sha === '') {
      throw new WorktreeError(WORKTREE_CODES.gitFailed, 'the created worktree has no commit', {
        step: 'rev-parse --verify HEAD',
        exitCode: head.code,
      });
    }
    if (sha !== record.baseHead) {
      throw new WorktreeError(WORKTREE_CODES.gitFailed, 'the created worktree does not start at the pinned commit', {
        step: 'rev-parse --verify HEAD',
        expected: record.baseHead,
        actual: sha,
      });
    }
    record.detachedVerified = true;
  }

  /**
   * Throw when a cancellation was already requested.
   * @param {AbortSignal | undefined} signal - caller signal.
   * @param {object} details - bounded details.
   * @returns {void}
   */
  throwIfAborted(signal, details) {
    if (signal?.aborted === true) {
      throw new WorktreeError(WORKTREE_CODES.cancelled, 'the worktree request was cancelled', details);
    }
  }

  /**
   * Remove a tree this manager created after a failed or cancelled creation.
   *
   * This is the only path that deletes without a host decision, and it is
   * restricted to trees that never became usable: the caller never received the
   * workspace path, so no unreviewed work can exist there.
   * @param {string} sourcePath - source repository.
   * @param {string} workspacePath - tree to remove.
   * @returns {Promise<void>} resolves after the best-effort cleanup.
   */
  async removeLeftover(sourcePath, workspacePath) {
    try {
      await this.deps.runGit(sourcePath, ['worktree', 'remove', '--force', workspacePath]);
    } catch {
      // Fall through to prune: the directory may not exist yet.
    }
    try {
      await this.deps.runGit(sourcePath, ['worktree', 'prune']);
    } catch {
      // The registry entry is dropped regardless; the operator is told nothing
      // was handed out, and a stale administrative entry is harmless.
    }
  }

  /**
   * Mark a prepared tree as finished so a host can review it.
   * @param {string} workspacePath - tree path returned by {@link prepare}.
   * @returns {object} tree metadata.
   */
  markComplete(workspacePath) {
    const record = this.requireTree(workspacePath);
    if (record.state === WORKTREE_STATES.disposed) {
      throw new WorktreeError(WORKTREE_CODES.unknownTree, 'the worktree has already been disposed', { workspacePath });
    }
    record.state = WORKTREE_STATES.awaitingHostReview;
    record.completedAt = this.now();
    return this.view(record);
  }

  /**
   * List managed trees as metadata only.
   *
   * No file contents, no diff: a host reviews a tree through the audit module,
   * not through this registry.
   * @param {object} [filter] - optional `taskId` and `state`.
   * @returns {object[]} tree metadata, newest first.
   */
  list(filter = {}) {
    const out = [];
    for (const record of this.trees.values()) {
      if (filter.taskId !== undefined && record.taskId !== filter.taskId) continue;
      if (filter.state !== undefined && record.state !== filter.state) continue;
      out.push(this.view(record));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Read one tree's metadata.
   * @param {string} workspacePath - tree path.
   * @returns {object | null} metadata, or null when unmanaged.
   */
  get(workspacePath) {
    const record = this.trees.get(normalizeKey(workspacePath));
    return record === undefined ? null : this.view(record);
  }

  /**
   * Remove one tree at a host's explicit request.
   *
   * Refuses while the tree is still `active` unless the caller states the tree
   * was reviewed: deleting a tree a run is still using, or one nobody looked at,
   * would destroy the only evidence of what the run changed.
   * @param {string} workspacePath - tree path.
   * @param {object} [options] - `reviewed: true` asserts host review happened.
   * @returns {Promise<object>} metadata of the removed tree.
   */
  async dispose(workspacePath, options = {}) {
    const record = this.requireTree(workspacePath);
    if (record.state === WORKTREE_STATES.disposed) {
      throw new WorktreeError(WORKTREE_CODES.unknownTree, 'the worktree has already been disposed', { workspacePath });
    }
    if (record.state === WORKTREE_STATES.active && options.reviewed !== true) {
      throw new WorktreeError(
        WORKTREE_CODES.notReviewed,
        'the worktree is still active; mark it complete or state that it was reviewed before removing it',
        { workspacePath, state: record.state },
      );
    }
    const removed = requireResult(
      await this.deps.runGit(record.sourcePath, ['worktree', 'remove', '--force', record.workspacePath]),
      'worktree remove',
    );
    if (removed.code !== 0) {
      // The directory may already be gone; prune settles the administrative
      // entry before any failure is reported.
      await this.deps.runGit(record.sourcePath, ['worktree', 'prune']).catch(() => {});
      if (await pathExists(record.workspacePath)) {
        throw gitFailure('worktree remove', removed);
      }
    } else {
      await this.deps.runGit(record.sourcePath, ['worktree', 'prune']).catch(() => {});
    }
    record.state = WORKTREE_STATES.disposed;
    record.reviewedByHost = options.reviewed === true;
    return this.view(record);
  }

  /**
   * Resolve a managed record or refuse.
   * @param {string} workspacePath - tree path.
   * @returns {object} record.
   */
  requireTree(workspacePath) {
    const record = this.trees.get(normalizeKey(workspacePath));
    if (record === undefined) {
      throw new WorktreeError(WORKTREE_CODES.unknownTree, 'no such managed worktree', { workspacePath });
    }
    return record;
  }

  /**
   * Project a record for callers: metadata only, no content, no error text.
   * @param {object} record - internal record.
   * @returns {object} metadata view.
   */
  view(record) {
    return {
      taskId: record.taskId,
      workspacePath: record.workspacePath,
      sourcePath: record.sourcePath,
      baseHead: record.baseHead,
      isolated: record.isolated === true,
      detached: record.detachedVerified === true,
      state: record.state,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      sourcePreexistingChanges: record.sourcePreexistingChanges,
      disposable: record.state !== WORKTREE_STATES.disposed,
    };
  }
}

/**
 * Normalize a path for use as a registry key. Case-folded on Windows, where the
 * filesystem is case-insensitive.
 * @param {string} workspacePath - path.
 * @returns {string} key.
 */
function normalizeKey(workspacePath) {
  const normalized = String(workspacePath).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
