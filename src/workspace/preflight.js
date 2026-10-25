// Read-only workspace preflight: the facts a dispatcher needs *before* work is
// submitted, and the isolation it should therefore ask the plugin for.
//
// Why this module exists
// ----------------------
// The isolation setting is a property of the *job*, not of the workspace, so the
// first thing that used to discover an unusable workspace was the job itself:
// `WORKTREE_SOURCE_DIRTY` arrived after a task id was allocated, a grant was
// consumed and a queue slot was taken. The dispatcher (Codex) then had to explain
// a failure whose cause it could have measured in advance — and the natural
// remedy, silently switching the job to shared isolation, is exactly the
// downgrade `docs/workspace-contract.md` forbids.
//
// So the same facts are now measurable up front, by a tool that has no side
// effects: this module runs only read-only git subcommands through the audit
// seam, and returns a *recommendation* rather than an action. It never creates a
// commit, a stash, a branch, a worktree or a task, and it is not authorization:
// the switch, the grants and the engine remain the only things that decide
// whether work runs.
//
// The decision table is deliberately small, stable and exhaustive. Every answer
// carries a `reason` code from {@link PREFLIGHT_REASONS} so a caller (and a test)
// can branch on the cause, never on human prose:
//
//   git unavailable / not a repository / no commit   → block
//   a directory inside a work tree that is not its
//   top level (a subdirectory)                        → block (its own stable
//                                                     reason: "this path is inside
//                                                     a repository but is not its
//                                                     root", which is why naming
//                                                     it would put a tree inside
//                                                     the user's checkout)
//   clean                                             → worktree
//   dirty, `allowShared` NOT given                    → block   (the caller must decide)
//   dirty, `allowShared: true`                        → shared  (explicit, recorded)
//
// `allowShared` is a request parameter, not a configuration default: the operator
// and the dispatcher decide per dispatch, the plugin never decides for them, and
// the answer says which of the two happened (`sharedExplicit: true`).

import { relative } from 'node:path';

import { AUDIT_CODES, AUDIT_LIMITS, createGitRunner, probeRepository, readStatus } from './audit.js';
import { LOCK_CODES, WorkspaceError, resolveWorkspacePath } from './locks.js';

/** The three isolation decisions this module can recommend. */
export const PREFLIGHT_ISOLATIONS = Object.freeze(['worktree', 'shared', 'block']);

/**
 * Stable reason codes. The set is closed: a caller may switch on it, and a
 * decision always names exactly one of these.
 */
export const PREFLIGHT_REASONS = Object.freeze({
  /** Not busy, git present, repository root, at least one commit, no changes. */
  cleanRepository: 'PREFLIGHT_CLEAN_REPOSITORY',
  /** The repository root can be checked out from a commit, but it has uncommitted changes. */
  dirtyRepository: 'PREFLIGHT_DIRTY_REPOSITORY',
  /** No `allowShared` request was made for a dirty repository, so shared is not implied. */
  dirtyNeedsDecision: 'PREFLIGHT_DIRTY_NEEDS_DECISION',
  /** A dirty repository was explicitly allowed to run in place. */
  dirtySharedExplicit: 'PREFLIGHT_DIRTY_SHARED_EXPLICIT',
  /** git could not be executed here, so no fact about the workspace could be measured. */
  gitUnavailable: 'PREFLIGHT_GIT_UNAVAILABLE',
  /** The path exists but is not inside a git work tree at all. */
  notRepository: 'PREFLIGHT_NOT_A_REPOSITORY',
  /**
   * The path is inside a git work tree but is not that repository's top level.
   * Naming it as the workspace would make an isolated tree land inside the user's
   * checkout, so it is refused rather than recommended worktree or shared.
   */
  notRepositoryRoot: 'PREFLIGHT_NOT_A_REPOSITORY_ROOT',
  /** The repository has no commit; a worktree can only be created from one. */
  noCommits: 'PREFLIGHT_NO_COMMITS',
  /** A read-only git invocation failed, so the state is unknown. */
  gitFailed: 'PREFLIGHT_GIT_FAILED',
  /** The path is relative, empty or cannot be resolved to a real directory. */
  workspaceInvalid: 'PREFLIGHT_WORKSPACE_INVALID',
  /** The path is a file rather than a directory. */
  notDirectory: 'PREFLIGHT_NOT_A_DIRECTORY',
});

/** Bounds on the facts this module reports. Paths are names, never content. */
export const PREFLIGHT_LIMITS = Object.freeze({
  /** Paths listed in `changedPaths`. */
  changedPaths: 50,
  /** Bytes of one changed path retained (a pathological filename cannot bloat a result). */
  pathChars: 400,
});

/**
 * One decision, as it is published.
 *
 * The shape is fixed here so the module, the MCP tool and the document cannot
 * drift: `isolation` is the recommendation, `reason` the stable cause, `facts`
 * what was measured, and the flags state **how** the recommendation was reached
 * rather than only what it was.
 * @param {object} options - decision inputs.
 * @returns {object} published decision.
 */
function decision(options) {
  return {
    ok: true,
    // Read-only by construction: this module has no code path that writes.
    readOnly: true,
    workspacePath: options.workspacePath ?? null,
    isolation: options.isolation,
    reason: options.reason,
    // Whether the recommendation came from an explicit request instead of the
    // repository being clean. A caller can therefore tell "worktree because clean"
    // from "shared because I said so", which are different audit stories.
    sharedExplicit: options.sharedExplicit === true,
    // True when shared isolation is genuinely usable for a dirty checkout AND the
    // caller has to say so. False when there is nothing to decide.
    decisionRequired: options.decisionRequired === true,
    facts: {
      gitAvailable: options.facts?.gitAvailable === true,
      repository: options.facts?.repository === true,
      hasCommits: options.facts?.hasCommits === true,
      clean: typeof options.facts?.clean === 'boolean' ? options.facts.clean : null,
      head: typeof options.facts?.head === 'string' ? options.facts.head : null,
      changedFiles: Number.isSafeInteger(options.facts?.changedFiles) ? options.facts.changedFiles : 0,
      changedPaths: Array.isArray(options.facts?.changedPaths) ? options.facts.changedPaths : [],
      changedPathsTruncated: options.facts?.changedPathsTruncated === true,
      // Sensitive names are reported by name only — the operator must know a
      // credential file was touched — and their content is never read.
      sensitivePaths: Array.isArray(options.facts?.sensitivePaths) ? options.facts.sensitivePaths : [],
    },
    // What the caller must do next, in one sentence. Never a route override.
    guidance: options.guidance ?? null,
    checkedAt: options.now,
  };
}

/**
 * Classify one failure into the reason code and the facts that are still known.
 *
 * A failed probe is not an empty probe: `gitAvailable`/`repository`/`hasCommits`
 * stay false, `clean` stays `null` (unknown, not "true"), and every caller of
 * {@link preflightWorkspace} gets the same shape.
 * @param {unknown} error - the thrown audit/workspace error.
 * @returns {{ reason: string, message: string }} normalized failure.
 */
function classify(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === AUDIT_CODES.gitUnavailable) {
    return {
      reason: PREFLIGHT_REASONS.gitUnavailable,
      message: 'git is not executable in this environment, so the workspace cannot be inspected',
    };
  }
  if (code === AUDIT_CODES.notRepositoryRoot) {
    return { reason: PREFLIGHT_REASONS.notRepositoryRoot, message: notRootMessage(error) };
  }
  if (code === AUDIT_CODES.notRepository) {
    return { reason: PREFLIGHT_REASONS.notRepository, message: 'the workspace is not inside a git repository' };
  }
  if (code === AUDIT_CODES.noCommits) {
    return { reason: PREFLIGHT_REASONS.noCommits, message: 'the repository has no commit yet' };
  }
  if (code === AUDIT_CODES.gitFailed) {
    return { reason: PREFLIGHT_REASONS.gitFailed, message: 'a read-only git invocation failed while inspecting the workspace' };
  }
  if (code === LOCK_CODES.invalid) {
    return { reason: PREFLIGHT_REASONS.workspaceInvalid, message: 'the workspace path could not be resolved to a real directory' };
  }
  return {
    reason: PREFLIGHT_REASONS.gitFailed,
    message: 'the workspace could not be inspected',
  };
}

/**
 * Guidance for a path that is inside a repository but is not its top level.
 *
 * The message must not suggest worktree or shared isolation, because neither is
 * safe for such a path: both would place agent writes somewhere under the user's
 * checkout. Only naming the repository root is a remedy, so only that is said.
 * @param {unknown} error - the audit error carrying `details.topLevel`.
 * @returns {string} one operator-facing sentence.
 */
function notRootMessage(error) {
  const topLevel = typeof error?.details?.topLevel === 'string' ? error.details.topLevel : '';
  const base = 'the workspace path is inside a git repository but is not its root';
  return topLevel === '' ? base : `${base}; name the repository root ${topLevel} instead`;
}

/**
 * Bound one reported path.
 * @param {string} value - repository-relative path.
 * @returns {string} bounded path.
 */
function boundPath(value) {
  const text = String(value ?? '');
  if (text.length <= PREFLIGHT_LIMITS.pathChars) return text;
  return `${text.slice(0, PREFLIGHT_LIMITS.pathChars)}…`;
}

/**
 * Inspect one workspace read-only and recommend an isolation.
 *
 * Nothing in this function writes: no commit, no stash, no worktree, no task, no
 * lock, no settings change. The runs are the read-only subcommands
 * `git --version`, `git rev-parse --is-inside-work-tree`, `git rev-parse
 * --show-toplevel`, `git rev-parse --verify HEAD` and `git status
 * --porcelain=v1 -z --untracked-files=all`, all issued through the audit seam's
 * argv runner with `shell: false`. The top-level read is what distinguishes the
 * repository root (which may be inspected) from a subdirectory inside it (which
 * is refused).
 * @param {object} [deps] - dependency object; `runGit` defaults to the audit runner.
 *   Tests inject a failing runner to prove the refusal paths.
 * @param {object} request - `workspacePath` (absolute), optional `allowShared`.
 * @returns {Promise<object>} the decision described by {@link PREFLIGHT_REASONS}.
 */
export async function preflightWorkspace(deps = {}, request = {}) {
  const now = Date.now();
  const runGit = typeof deps?.runGit === 'function' ? deps.runGit : createGitRunner();
  const allowShared = request?.allowShared === true;

  // The absolute-path, resolution and directory checks are the ones the engine
  // applies (`resolveWorkspacePath`), so a preflight that answers `worktree` can
  // never be rejected by the job for naming a path the engine cannot use.
  let workspacePath;
  try {
    workspacePath = await resolveWorkspacePath(request?.workspacePath);
  } catch (error) {
    const failure = classify(error);
    return decision({
      workspacePath: null,
      isolation: 'block',
      reason: failure.reason,
      facts: { gitAvailable: false, repository: false, hasCommits: false, clean: null, changedFiles: 0 },
      guidance: `${failure.message}; name an absolute path to an existing workspace directory`,
      now,
    });
  }

  // A file is not a directory. `probeRepository` would answer "not a repository"
  // for it, which is true but hides the actual mistake, so it is distinguished.
  const kind = await describeStart(workspacePath);
  if (kind !== 'directory') {
    return decision({
      workspacePath,
      isolation: 'block',
      reason: PREFLIGHT_REASONS.notDirectory,
      facts: { gitAvailable: false, repository: false, hasCommits: false, clean: null, changedFiles: 0 },
      guidance: 'the workspace path is not a directory',
      now,
    });
  }

  let facts;
  try {
    facts = await probeRepository(runGit, workspacePath);
  } catch (error) {
    const failure = classify(error);
    return blockFor(workspacePath, failure, now);
  }

  if (!facts.git) {
    return blockFor(workspacePath, classify({ code: AUDIT_CODES.gitUnavailable }), now);
  }
  if (!facts.repository) {
    return blockFor(workspacePath, classify({ code: AUDIT_CODES.notRepository }), now, {
      gitAvailable: true,
    });
  }
  // A path inside a work tree is not the same workspace as that work tree. The
  // engine creates an isolated tree *for the supplied path*, so a subdirectory
  // would put the agent's checkout inside the user's repository — the exact
  // placement `WorktreeManager` refuses. The canonical top level is measured by
  // `git rev-parse --show-toplevel`, so this is decided from git, not from string
  // comparison against the supplied path.
  if (!facts.workTreeRoot) {
    return blockFor(
      workspacePath,
      classify({ code: AUDIT_CODES.notRepositoryRoot, details: { topLevel: facts.topLevel ?? null } }),
      now,
      { gitAvailable: true, repository: true },
    );
  }
  if (!facts.hasCommits) {
    return blockFor(workspacePath, classify({ code: AUDIT_CODES.noCommits }), now, {
      gitAvailable: true,
      repository: true,
    });
  }

  let status;
  try {
    status = await readStatus({ runGit }, workspacePath, { limit: PREFLIGHT_LIMITS.changedPaths });
  } catch (error) {
    const failure = classify(error);
    return blockFor(workspacePath, failure, now, {
      gitAvailable: true,
      repository: true,
      hasCommits: true,
      head: facts.head,
    });
  }

  const changedPaths = status.entries.slice(0, PREFLIGHT_LIMITS.changedPaths).map((entry) => boundPath(entry.path));
  const sensitivePaths = uniqSorted(status.entries.flatMap((entry) => {
    const names = [];
    if (entry.sensitive === true) names.push(entry.path);
    return names;
  })).map(boundPath).slice(0, PREFLIGHT_LIMITS.changedPaths);
  const measured = {
    gitAvailable: true,
    repository: true,
    hasCommits: true,
    head: typeof facts.head === 'string' ? facts.head : null,
    changedFiles: status.total,
    changedPaths,
    // A path list shorter than the count is stated as truncated, never implied
    // complete: "this list is short" must not read as "this list was short".
    changedPathsTruncated: status.total > changedPaths.length,
    sensitivePaths,
  };

  if (status.total === 0) {
    // A dirty source is refused by the worktree manager, so only a clean one may
    // take that route. This is the same condition, measured earlier.
    return decision({
      workspacePath,
      isolation: 'worktree',
      reason: PREFLIGHT_REASONS.cleanRepository,
      facts: { ...measured, clean: true },
      guidance: 'the repository is clean; worktree isolation can be prepared from its current commit',
      now,
    });
  }

  if (allowShared !== true) {
    // No implicit downgrade: a dirty checkout blocks until a human or the
    // coordinator decides that running in place is acceptable for this dispatch.
    return decision({
      workspacePath,
      isolation: 'block',
      reason: PREFLIGHT_REASONS.dirtyNeedsDecision,
      decisionRequired: true,
      facts: { ...measured, clean: false },
      guidance: 'the repository has uncommitted changes, so worktree isolation would fail; '
        + 'commit them, or make the shared-isolation decision explicitly (allowShared) and record why',
      now,
    });
  }

  return decision({
    workspacePath,
    isolation: 'shared',
    reason: PREFLIGHT_REASONS.dirtySharedExplicit,
    sharedExplicit: true,
    facts: { ...measured, clean: false },
    guidance: 'the repository has uncommitted changes and shared isolation was explicitly allowed; '
      + 'the delegated run will mutate this checkout in place, and unrelated changes must be preserved',
    now,
  });
}

/**
 * Build a `block` decision from a normalized failure.
 * @param {string} workspacePath - resolved workspace path.
 * @param {{reason: string, message: string}} failure - normalized failure.
 * @param {number} now - timestamp.
 * @param {object} [known] - facts that were already established.
 * @returns {object} decision.
 */
function blockFor(workspacePath, failure, now, known = {}) {
  return decision({
    workspacePath,
    isolation: 'block',
    reason: failure.reason,
    facts: {
      gitAvailable: known.gitAvailable === true,
      repository: known.repository === true,
      hasCommits: known.hasCommits === true,
      clean: null,
      head: typeof known.head === 'string' ? known.head : null,
      changedFiles: 0,
    },
    guidance: failure.message,
    now,
  });
}

/**
 * Whether one resolved path is a directory or something else.
 * @param {string} target - resolved absolute path.
 * @returns {Promise<'directory' | 'other'>} the kind of entry found.
 */
async function describeStart(target) {
  // The audit module's inspector is not exported for this purpose and the check
  // here is one `lstat`; it is done locally so the preflight stays dependency-light.
  const { lstat } = await import('node:fs/promises');
  try {
    const info = await lstat(target);
    return info.isDirectory() ? 'directory' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * Sorted unique copy of a list of strings.
 * @param {string[]} values - values.
 * @returns {string[]} sorted unique values.
 */
function uniqSorted(values) {
  return [...new Set(values)].sort();
}

/**
 * The repository-relative path of a workspace, for a caller that wants to key
 * something by it. Exported so the MCP tool does not re-implement containment.
 * @param {string} root - repository root.
 * @param {string} target - candidate path.
 * @returns {string} relative path, or `''` when they are the same directory.
 */
export function relativeTo(root, target) {
  return relative(root, target);
}

/** Re-exported so a caller can report the same bound the audit layer uses. */
export { AUDIT_LIMITS };
