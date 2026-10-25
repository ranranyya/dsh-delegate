// Git-backed workspace inspection.
//
// What a job changed is measured, not reported: this module reads git state
// before and after the run and records the delta as evidence. It never trusts
// the agent's summary, and it reads only read-only git subcommands — nothing
// here can mutate the repository it is auditing.
//
// Three invariants make the evidence trustworthy:
//  1. The comparison point is pinned. `captureBaseline` records the commit the
//     job started from and `captureDiff` compares against *that* commit, never
//     against the mutable `HEAD` the agent may have moved.
//  2. Filenames are parsed from NUL-delimited output. `-z` is the only git
//     status/diff format that is unambiguous for spaces, quotes, backslashes and
//     non-ASCII bytes; the line format rewrites names and would mis-attribute a
//     change to a file that does not exist.
//  3. Sensitive paths are filtered *before* the diff is produced. A credential
//     file's name is reported, its content is never read into this process.
//
// A capability check is not a formality. If git is unavailable, or git fails
// where evidence is required, this module refuses rather than reporting an
// empty diff — "no changes" and "could not tell" must never look alike.

import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { isSensitivePath, redactText } from '../config/redact.js';
import { isInside } from './locks.js';

/** Bounds that keep evidence payloads reviewable and reads finite. */
export const AUDIT_LIMITS = Object.freeze({
  /** Changed files listed in the evidence. */
  files: 500,
  /** Status records parsed; beyond this the list is truncated, not trusted. */
  statusEntries: 2000,
  /** Patch bytes retained. */
  patchBytes: 64 * 1024,
  /** Untracked files whose content may be rendered into the patch. */
  patchFiles: 50,
  /** Sensitive exclusions handed to one git invocation. */
  sensitivePaths: 100,
  /** numstat rows retained. */
  statLines: 200,
  /** Per-invocation git timeout. */
  gitTimeoutMs: 8000,
  /** Per-invocation stdout/stderr ceiling. */
  gitMaxBytes: 8 * 1024 * 1024,
  /** Stderr bytes quoted in a refusal. */
  stderrBytes: 400,
  /** Paths quoted in a refusal message. */
  samplePaths: 20,
});

/** Audit failure codes, each mapped to an operator-visible explanation. */
export const AUDIT_CODES = Object.freeze({
  gitUnavailable: 'AUDIT_GIT_UNAVAILABLE',
  notRepository: 'AUDIT_NOT_A_REPOSITORY',
  noCommits: 'AUDIT_NO_COMMITS',
  gitFailed: 'AUDIT_GIT_FAILED',
  baselineInvalid: 'AUDIT_BASELINE_INVALID',
  notRepositoryRoot: 'AUDIT_NOT_A_REPOSITORY_ROOT',
});

/** Raised when the workspace cannot be audited. */
export class AuditError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Default git runner.
 *
 * `shell: false` with an explicit argv keeps the workspace path out of a shell
 * parse, and a hard timeout keeps a hung git invocation from wedging a job. A
 * sandbox that denies process creation surfaces as `AUDIT_GIT_UNAVAILABLE`,
 * which callers must treat as a refusal, not as "no changes".
 *
 * `stdout` is returned byte-faithfully: the `-z` parsers below depend on NUL
 * delimiters and on the absence of any newline translation.
 * @param {object} [options] - `timeoutMs` override (tests use a shorter bound).
 * @returns {(cwd: string, args: string[]) => Promise<{stdout: string, stderr: string, code: number}>} runner.
 */
export function createGitRunner(options = {}) {
  const timeout = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : AUDIT_LIMITS.gitTimeoutMs;
  return function runGit(cwd, args) {
    return new Promise((resolvePromise, rejectPromise) => {
      let launched;
      try {
        launched = execFile(
          'git',
          ['-c', 'core.quotepath=false', ...args],
          {
            cwd,
            encoding: 'utf8',
            timeout,
            maxBuffer: AUDIT_LIMITS.gitMaxBytes,
            shell: false,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const out = String(stdout ?? '');
            const err = String(stderr ?? '');
            if (error === null || error === undefined) {
              resolvePromise({ stdout: out, stderr: err, code: 0 });
              return;
            }
            const code = typeof error.code === 'number' ? error.code : null;
            if (code === 0) {
              resolvePromise({ stdout: out, stderr: err, code: 0 });
              return;
            }
            // A sandbox that denies spawning looks like a missing git; both are
            // "git cannot be used here", which is a refusal.
            const denied = denyProcessCreation(error);
            if (denied !== null) {
              rejectPromise(new AuditError(AUDIT_CODES.gitUnavailable, 'git is not executable in this environment', { cause: denied }));
              return;
            }
            if (code !== null) {
              // A git-level failure is data, not an exception: callers inspect it.
              resolvePromise({ stdout: out, stderr: err, code });
              return;
            }
            rejectPromise(new AuditError(AUDIT_CODES.gitFailed, 'git could not be executed', {
              cause: typeof error.code === 'string' ? error.code : null,
            }));
          },
        );
      } catch (error) {
        // Some confined sandboxes deny process creation synchronously
        // (`spawn EPERM`). That is the same refusal, not a crash.
        const denied = denyProcessCreation(error);
        rejectPromise(denied === null
          ? new AuditError(AUDIT_CODES.gitFailed, 'git could not be executed', { cause: typeof error?.code === 'string' ? error.code : null })
          : new AuditError(AUDIT_CODES.gitUnavailable, 'git is not executable in this environment', { cause: denied }));
        return;
      }
      // The child is not needed here; kept for symmetry with execFile's return.
      void launched;
    });
  };
}

/**
 * Classify a spawn-level failure.
 * @param {object} error - execFile error.
 * @returns {string | null} the denied errno, or null when git actually ran.
 */
function denyProcessCreation(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') return code;
  return null;
}

/**
 * Build a refusal from a failed git invocation.
 *
 * Only bounded, redacted stderr is quoted: a git error message never belongs in
 * a job record in full, and it must not carry file content.
 * @param {string} step - which read failed.
 * @param {object} result - runner result.
 * @returns {AuditError} refusal to throw.
 */
function gitFailure(step, result) {
  const stderr = redactText(String(result?.stderr ?? '')).trim().slice(0, AUDIT_LIMITS.stderrBytes);
  return new AuditError(AUDIT_CODES.gitFailed, `git ${step} failed`, {
    step,
    exitCode: typeof result?.code === 'number' ? result.code : null,
    stderr,
  });
}

/**
 * Validate that a runner returned the shape this module parses.
 * @param {unknown} result - runner result.
 * @param {string} step - which read produced it.
 * @returns {{stdout: string, stderr: string, code: number}} result.
 */
function requireResult(result, step) {
  if (result === null || typeof result !== 'object' || typeof result.stdout !== 'string' || typeof result.code !== 'number') {
    throw new AuditError(AUDIT_CODES.gitFailed, `the git runner returned no usable result for ${step}`, { step });
  }
  return { stdout: result.stdout, stderr: typeof result.stderr === 'string' ? result.stderr : '', code: result.code };
}

/**
 * Measure the canonical top level of the repository that contains a path.
 *
 * This is the one read that answers "which directory is this workspace's
 * repository?", and it is deliberately separate from {@link probeRepository}:
 * containment decisions (is this path the repository itself? is a worktree root
 * anywhere inside that repository?) need the top level even when the named path
 * is a subdirectory, and they need it before any write.
 *
 * `--show-toplevel` is read-only and reports an absolute path with symbolic path
 * components resolved, which is why the result is compared against real paths.
 * The value is never returned unless git exited successfully with non-empty
 * output: "could not tell" must not look like "no repository".
 * @param {(cwd: string, args: string[]) => Promise<{stdout: string, code: number}>} runGit - runner.
 * @param {string} workspacePath - resolved workspace path (may be a subdirectory).
 * @returns {Promise<string | null>} real top-level directory, or null when this
 *   path is not inside a git work tree.
 */
export async function readRepositoryTopLevel(runGit, workspacePath) {
  const runner = normalizeRunner(runGit);
  const result = requireResult(
    await runner(workspacePath, ['rev-parse', '--show-toplevel']),
    'rev-parse --show-toplevel',
  );
  if (result.code !== 0) return null;
  const topLevel = result.stdout.trim();
  return topLevel === '' ? null : topLevel;
}

/**
 * Probe whether a directory is a git work tree with at least one commit.
 *
 * `facts.repository` is true for any directory *inside* a work tree, not only
 * for its root; `facts.workTreeRoot` records whether the named path is itself
 * the top level. Callers that require a repository root — the preflight and the
 * worktree manager both do — must read `workTreeRoot` (or compare against
 * {@link readRepositoryTopLevel}) rather than `repository`.
 *
 * The top-level read is skipped when the path is not a work tree, so a
 * non-repository workspace still costs two invocations and no more.
 * @param {(cwd: string, args: string[]) => Promise<{stdout: string, code: number}>} runGit - runner.
 * @param {string} workspacePath - resolved workspace path.
 * @returns {Promise<{ git: boolean, repository: boolean, workTreeRoot: boolean, topLevel: string | null, hasCommits: boolean, head: string | null }>} facts.
 */
export async function probeRepository(runGit, workspacePath) {
  const runner = normalizeRunner(runGit);
  const facts = {
    git: false,
    repository: false,
    workTreeRoot: false,
    topLevel: null,
    hasCommits: false,
    head: null,
  };
  const version = requireResult(await runner(workspacePath, ['--version']), '--version');
  facts.git = version.code === 0;
  if (!facts.git) return facts;
  const inside = requireResult(await runner(workspacePath, ['rev-parse', '--is-inside-work-tree']), 'rev-parse');
  // A work tree that is itself a nested repository inside another checkout still
  // answers `true`, and so does any directory inside a work tree. Containment
  // guards therefore use the top level, never this flag alone.
  facts.repository = inside.code === 0 && inside.stdout.trim() === 'true';
  if (!facts.repository) return facts;
  // The canonical top level: what a containment decision must compare against.
  facts.topLevel = await readRepositoryTopLevel(runner, workspacePath);
  const head = requireResult(await runner(workspacePath, ['rev-parse', '--verify', 'HEAD']), 'rev-parse --verify HEAD');
  if (head.code === 0) {
    const sha = head.stdout.trim();
    if (sha !== '') {
      facts.hasCommits = true;
      facts.head = sha;
    }
  }
  // Only a path that resolves to the same directory as the measured top level is
  // a repository root. An unmeasurable top level is never assumed to be the
  // workspace: "could not tell" must not read as "this is the root".
  facts.workTreeRoot = facts.topLevel !== null && samePath(facts.topLevel, workspacePath);
  return facts;
}

/**
 * Whether two paths name the same directory, comparing real paths.
 *
 * Case-folded on Windows, where the filesystem is case-insensitive; both sides
 * are expected to be real paths already (`realpath` / `--show-toplevel`).
 * @param {string} left - absolute path.
 * @param {string} right - absolute path.
 * @returns {boolean} true when they are the same path.
 */
function samePath(left, right) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  return fold(String(left).replace(/[\\/]+$/, '')) === fold(String(right).replace(/[\\/]+$/, ''));
}

/**
 * Whether a porcelain status code describes a rename or a copy, which is the
 * only case where git emits a second path.
 * @param {string} code - two-character `XY` status.
 * @returns {boolean} true when an original path follows.
 */
function isRenameOrCopy(code) {
  return code.includes('R') || code.includes('C');
}

/**
 * Map a porcelain status code to a reviewer-facing verb.
 * @param {string} code - `XY` code.
 * @returns {string} verb.
 */
function describeStatus(code) {
  if (code === '??') return 'added';
  if (code.includes('R')) return 'renamed';
  if (code.includes('C')) return 'copied';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('M')) return 'modified';
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted';
  return 'changed';
}

/**
 * Parse `git status --porcelain=v1 -z` output.
 *
 * In `-z` form no path is ever quoted or escaped: records are NUL-terminated and
 * a rename/copy record is followed by one extra NUL-terminated token holding the
 * *original* path (new path first). Both paths are retained because either one
 * can name credential material, and the old path is exactly what a rename-based
 * leak would otherwise hide.
 * @param {string} stdout - raw stdout.
 * @param {number} [limit] - maximum records retained.
 * @returns {{entries: object[], total: number, truncated: boolean}} parsed status.
 */
export function parseStatusZ(stdout, limit = AUDIT_LIMITS.statusEntries) {
  const text = typeof stdout === 'string' ? stdout : '';
  if (text === '') return { entries: [], total: 0, truncated: false };
  if (!text.includes('\0')) {
    // Without NUL delimiters filenames have been rewritten or quoted; guessing
    // would silently mis-attribute a change, so this is a refusal.
    throw new AuditError(AUDIT_CODES.gitFailed, 'git status did not return the requested NUL-delimited format', {
      step: 'status',
    });
  }
  const tokens = text.split('\0');
  const entries = [];
  let total = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '') continue;
    if (token.length < 3) continue;
    const code = token.slice(0, 2);
    const path = token[2] === ' ' ? token.slice(3) : token.slice(2);
    if (path === '') continue;
    let from = null;
    if (isRenameOrCopy(code)) {
      const candidate = tokens[index + 1];
      if (typeof candidate === 'string' && candidate !== '') {
        from = candidate;
        index += 1;
      }
    }
    total += 1;
    if (entries.length >= limit) continue;
    entries.push({
      code,
      path,
      from,
      status: describeStatus(code),
      // Either side being sensitive is enough to withhold the rename patch.
      sensitive: isSensitivePath(path) || (from !== null && isSensitivePath(from)),
    });
  }
  return { entries, total, truncated: total > entries.length };
}

/**
 * Read the workspace status in NUL-delimited porcelain v1 format.
 * @param {object} deps - `runGit` runner.
 * @param {string} workspacePath - repository working directory.
 * @param {object} [options] - `limit` records.
 * @returns {Promise<{entries: object[], total: number, truncated: boolean}>} status entries.
 */
export async function readStatus(deps, workspacePath, options = {}) {
  const runGit = gitRunnerFrom(deps);
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : AUDIT_LIMITS.statusEntries;
  const result = requireResult(
    await runGit(workspacePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    'status',
  );
  if (result.code !== 0) throw gitFailure('status', result);
  return parseStatusZ(result.stdout, limit);
}

/**
 * Wrap a runner so spawn-level failures are normalised to this module's codes.
 *
 * A runner that throws `EPERM` (a confined sandbox denying process creation) or
 * anything non-`AuditError` must not escape as a generic error: callers switch on
 * `AuditError.code`, and an unclassified throw would be read as an internal bug
 * rather than as "the workspace cannot be audited".
 * @param {(cwd: string, args: string[]) => Promise<object>} runGit - raw runner.
 * @returns {(cwd: string, args: string[]) => Promise<object>} normalising runner.
 */
function normalizeRunner(runGit) {
  if (typeof runGit !== 'function') {
    throw new AuditError(AUDIT_CODES.gitFailed, 'no git runner is installed', {});
  }
  return async function safeRunGit(cwd, args) {
    try {
      return await runGit(cwd, args);
    } catch (error) {
      if (error instanceof AuditError) throw error;
      throw new AuditError(AUDIT_CODES.gitUnavailable, 'git could not be executed in this environment', {
        cause: typeof error?.code === 'string' ? error.code : null,
      });
    }
  };
}

/**
 * Resolve a normalising runner from a deps object.
 * @param {object} deps - dependency object with `runGit`.
 * @returns {(cwd: string, args: string[]) => Promise<object>} runner.
 */
export function gitRunnerFrom(deps) {
  return normalizeRunner(deps?.runGit);
}

/**
 * Capture the workspace state a job starts from.
 *
 * `head` is the fixed comparison point for the rest of the job. It is a commit
 * id, not the string `HEAD`, because the agent under audit can move `HEAD`.
 * @param {object} deps - `runGit` runner.
 * @param {string} workspacePath - resolved workspace path.
 * @returns {Promise<object>} baseline snapshot usable by {@link captureDiff}.
 */
export async function captureBaseline(deps, workspacePath) {
  const facts = await probeRepository(deps.runGit, workspacePath);
  if (!facts.repository || !facts.hasCommits) {
    throw new AuditError(AUDIT_CODES.notRepository, 'the workspace is not a git repository with a commit', {
      repository: facts.repository,
      hasCommits: facts.hasCommits,
    });
  }
  const status = await readStatus(deps, workspacePath);
  return {
    // The pinned commit the diff is measured against.
    head: facts.head,
    dirtyBaseline: status.total > 0,
    // The pre-existing dirty count is kept so a reviewer can tell this job's
    // changes apart from edits that were already there.
    preexistingChanges: status.total,
    // Names only, bounded: a reviewer needs to know the checkout was dirty, not
    // what was already in it.
    preexistingPaths: status.entries.slice(0, AUDIT_LIMITS.samplePaths).map((entry) => entry.path),
    statusTruncated: status.truncated,
    statusFormat: 'porcelain-v1-z',
    capturedAt: Date.now(),
  };
}

/**
 * Collect the paths whose content must be withheld from the patch.
 *
 * Renames contribute both names, so a rename *from* `.env` to `notes.txt` is
 * still recognised as credential material. A path is listed once even when it
 * appears in several status records.
 * @param {object[]} entries - parsed status entries.
 * @returns {{paths: string[], count: number}} sorted unique paths and the total.
 */
function collectSensitivePaths(entries) {
  const set = new Set();
  for (const entry of entries) {
    if (isSensitivePath(entry.path)) set.add(entry.path);
    if (typeof entry.from === 'string' && isSensitivePath(entry.from)) set.add(entry.from);
  }
  const paths = [...set].sort();
  return { paths, count: paths.length };
}

/**
 * Build literal exclusion pathspecs.
 *
 * `literal` is mandatory: a filename containing `*`, `?` or `[` must be excluded
 * as itself, not as a glob that may match a different sensitive file (or fail to
 * match anything and leak the excluded file back into the patch).
 * @param {string[]} paths - repository-relative paths.
 * @returns {string[]} pathspec arguments.
 */
function exclusionPathspecs(paths) {
  return paths.map((relPath) => `:(exclude,literal)${relPath}`);
}

/**
 * Parse `git diff --numstat -z` output.
 *
 * A rename row is `add\tdel\t` followed by the old path and the new path as two
 * extra NUL-terminated tokens; a normal row carries the single path in the third
 * field.
 * @param {string} stdout - raw stdout.
 * @param {number} [limit] - maximum rows retained.
 * @returns {{added: string, removed: string, path: string, from: string | null}[]} rows.
 */
export function parseNumstatZ(stdout, limit = AUDIT_LIMITS.statLines) {
  const text = typeof stdout === 'string' ? stdout : '';
  if (text === '') return [];
  const tokens = text.split('\0');
  const rows = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '') continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (match === null) continue;
    const [, added, removed, inline] = match;
    let path = inline;
    let from = null;
    if (inline === '') {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (typeof oldPath !== 'string' || typeof newPath !== 'string') continue;
      from = oldPath;
      path = newPath;
      index += 2;
    }
    if (path === '') continue;
    if (rows.length >= limit) continue;
    rows.push({ added, removed, path, from });
  }
  return rows;
}

/**
 * Default file inspector used before an untracked file's content is read.
 *
 * A file is described, never opened: the decision to include it in the patch is
 * made from `lstat` metadata only, so an oversized file, a directory or a
 * symlink is skipped without this process reading anything.
 * @param {string} absolutePath - absolute path to inspect.
 * @returns {Promise<{kind: 'file'|'directory'|'symlink'|'other'|'missing', size: number}>} facts.
 */
export async function describePath(absolutePath) {
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) return { kind: 'symlink', size: 0 };
    if (info.isFile()) return { kind: 'file', size: info.size };
    if (info.isDirectory()) return { kind: 'directory', size: 0 };
    return { kind: 'other', size: info.size };
  } catch {
    return { kind: 'missing', size: 0 };
  }
}

/**
 * Decide whether one untracked path may be rendered into the patch.
 * @param {string} workspacePath - repository root.
 * @param {string} relPath - repository-relative path.
 * @param {(absolutePath: string) => Promise<object>} statPath - file inspector seam.
 * @returns {Promise<{skip: boolean, note: string | null}>} decision.
 */
async function inspectUntracked(workspacePath, relPath, statPath) {
  const root = resolvePath(workspacePath);
  const target = resolvePath(root, relPath);
  // A path that escapes the repository is never read; the file list already
  // records it, which is all the evidence a reviewer needs.
  if (!isInside(root, target)) return { skip: true, note: null };
  const facts = await statPath(target);
  if (facts?.kind !== 'file') return { skip: true, note: null };
  const size = typeof facts.size === 'number' ? facts.size : 0;
  if (size > AUDIT_LIMITS.patchBytes) {
    return { skip: true, note: `diff -- omitted ${relPath}: ${size} bytes exceeds the patch budget` };
  }
  return { skip: false, note: null };
}

/**
 * Produce a bounded patch for everything except sensitive paths.
 * @param {Function} runGit - normalising runner.
 * @param {(absolutePath: string) => Promise<object>} statPath - file inspector seam.
 * @param {string} workspacePath - repository root.
 * @param {string} baseHead - pinned commit id.
 * @param {string[]} sensitivePaths - paths to exclude from the patch.
 * @param {string[]} untrackedPaths - non-sensitive untracked files.
 * @returns {Promise<{text: string, truncated: boolean}>} bounded patch.
 */
async function readBoundedPatch(runGit, statPath, workspacePath, baseHead, sensitivePaths, untrackedPaths) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  const add = (text) => {
    if (text === '') return;
    chunks.push(text);
    bytes += Buffer.byteLength(text, 'utf8');
  };

  // No external diff driver and no textconv filter may run: both are configured
  // in the audited repository and could read or transform withheld content.
  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', baseHead];
  const exclusions = exclusionPathspecs(sensitivePaths);
  if (exclusions.length > 0) diffArgs.push('--', ...exclusions);
  const diff = requireResult(await runGit(workspacePath, diffArgs), 'diff');
  if (diff.code !== 0) throw gitFailure('diff', diff);
  add(diff.stdout.trim() === '' ? '' : diff.stdout);
  if (bytes > AUDIT_LIMITS.patchBytes) truncated = true;

  let rendered = 0;
  for (const relPath of untrackedPaths) {
    if (bytes >= AUDIT_LIMITS.patchBytes) {
      truncated = true;
      break;
    }
    if (rendered >= AUDIT_LIMITS.patchFiles) {
      truncated = true;
      break;
    }
    const decision = await inspectUntracked(workspacePath, relPath, statPath);
    if (decision.skip) {
      if (decision.note !== null) add(decision.note);
      continue;
    }
    rendered += 1;
    // Untracked files have no diff against a commit; render them as additions so
    // a new file cannot silently evade review.
    const shown = requireResult(
      await runGit(workspacePath, [
        'diff',
        '--no-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--unified=3',
        '--',
        '/dev/null',
        relPath,
      ]),
      'diff --no-index',
    );
    // Exit code 1 is `--no-index`'s "differences found", i.e. success here.
    if (shown.code !== 0 && shown.code !== 1) throw gitFailure('diff --no-index', shown);
    add(shown.stdout.trim() === '' ? '' : shown.stdout);
  }

  const combined = redactText(chunks.join('\n'));
  const payload = Buffer.from(combined, 'utf8');
  if (payload.byteLength <= AUDIT_LIMITS.patchBytes) {
    return { text: combined, truncated };
  }
  // Cut on a byte boundary, then drop the possibly split trailing code point so
  // the retained text stays valid UTF-8 for JSON transport.
  const slice = payload.subarray(0, AUDIT_LIMITS.patchBytes).toString('utf8').replace(/\uFFFD$/, '');
  return { text: `${slice}\n… patch truncated at ${AUDIT_LIMITS.patchBytes} bytes`, truncated: true };
}

/**
 * Explain why a patch was withheld, without quoting any path.
 * @param {number} sensitiveCount - number of sensitive paths seen.
 * @param {boolean} statusTruncated - whether the status list itself was cut.
 * @returns {string} operator-facing reason.
 */
function withheldAllReason(sensitiveCount, statusTruncated) {
  if (statusTruncated) {
    return `diff withheld: the status list exceeded ${AUDIT_LIMITS.statusEntries} entries, so the sensitive-path set cannot be proven complete`;
  }
  return `diff withheld: ${sensitiveCount} sensitive paths were touched, above the ${AUDIT_LIMITS.sensitivePaths} exclusion bound`;
}

/**
 * Measure what changed since the baseline: status entries plus a bounded patch.
 *
 * Sensitive paths keep their name in the file list — the operator needs to know
 * a credential file was touched — but they are filtered out of the status list
 * *and* the pathspec set before any diff is produced, so their content is never
 * read. If more sensitive paths were touched than the exclusion bound allows,
 * the patch is withheld entirely rather than partially filtered.
 * @param {object} deps - `runGit` runner.
 * @param {string} workspacePath - resolved workspace path.
 * @param {object} baseline - value returned by {@link captureBaseline}.
 * @returns {Promise<object>} bounded, redacted change evidence.
 */
export async function captureDiff(deps, workspacePath, baseline) {
  const baseHead = typeof baseline?.head === 'string' && baseline.head.trim() !== '' ? baseline.head.trim() : null;
  if (baseHead === null) {
    // Without a pinned commit there is no honest comparison point; comparing to
    // `HEAD` would let the run's own commits disappear from the evidence.
    throw new AuditError(AUDIT_CODES.baselineInvalid, 'the baseline has no pinned head commit', {});
  }
  const runGit = gitRunnerFrom(deps);
  const statPath = typeof deps?.statPath === 'function' ? deps.statPath : describePath;

  const status = await readStatus(deps, workspacePath);
  const entries = status.entries;
  const sensitive = collectSensitivePaths(entries);
  const files = entries.slice(0, AUDIT_LIMITS.files);

  // Both tracked and untracked sensitive paths are filtered here, before any
  // diff invocation exists. A truncated status list is treated as "too many":
  // the unparsed tail could hide a credential path, and a patch rendered without
  // excluding it would leak content this module promised not to read.
  const withheldAll = sensitive.count > AUDIT_LIMITS.sensitivePaths || status.truncated;
  const sensitivePaths = sensitive.paths.slice(0, AUDIT_LIMITS.sensitivePaths);
  const untrackedResult = requireResult(
    await runGit(workspacePath, ['ls-files', '--others', '--exclude-standard', '-z']),
    'ls-files',
  );
  if (untrackedResult.code !== 0) throw gitFailure('ls-files', untrackedResult);
  // Withholding everything also means nothing untracked may be rendered.
  const untrackedPaths = withheldAll
    ? []
    : untrackedResult.stdout
      .split('\0')
      .filter((entry) => entry !== '' && !isSensitivePath(entry))
      .slice(0, AUDIT_LIMITS.files);

  const numstatArgs = ['diff', '--numstat', '-z', '--no-ext-diff', '--no-textconv', baseHead];
  if (!withheldAll && sensitivePaths.length > 0) numstatArgs.push('--', ...exclusionPathspecs(sensitivePaths));
  // When the patch is withheld no diff is produced at all: a partially filtered
  // diff over an unbounded set of sensitive files is exactly the leak the bound
  // exists to prevent.
  let changes = [];
  if (!withheldAll) {
    const numstat = requireResult(await runGit(workspacePath, numstatArgs), 'diff --numstat');
    if (numstat.code !== 0) throw gitFailure('diff --numstat', numstat);
    changes = parseNumstatZ(numstat.stdout);
  }

  const patch = withheldAll
    ? {
      text: withheldAllReason(sensitive.count, status.truncated),
      truncated: true,
    }
    : await readBoundedPatch(runGit, statPath, workspacePath, baseHead, sensitivePaths, untrackedPaths);

  return {
    // Which fixed commit this evidence is measured against.
    head: baseHead,
    baseHead,
    dirtyBaseline: baseline?.dirtyBaseline === true,
    preexistingChanges: baseline?.preexistingChanges ?? 0,
    files,
    fileCount: status.total,
    truncatedFiles: status.truncated || status.total > files.length,
    changes,
    // Paths stay visible; their content was excluded before the diff ran.
    sensitivePaths,
    sensitiveTouchedCount: sensitive.count,
    sensitiveContentWithheld: true,
    patchWithheld: withheldAll,
    patchText: patch.text,
    patchTruncated: patch.truncated,
    patchBytes: Buffer.byteLength(patch.text, 'utf8'),
    capturedAt: Date.now(),
  };
}

/**
 * Verify that a worktree isolation request can be honoured.
 *
 * Worktree isolation needs a committed repository; when that is not the case
 * the request is refused. Silently falling back to shared isolation would
 * execute a job with weaker isolation than the operator asked for.
 * @param {object} deps - `runGit` runner.
 * @param {string} workspacePath - resolved workspace path.
 * @returns {Promise<object>} facts, or a refusal.
 */
export async function assertWorktreeCapable(deps, workspacePath) {
  const facts = await probeRepository(deps.runGit, workspacePath);
  if (!facts.git) {
    throw new AuditError(AUDIT_CODES.gitUnavailable, 'worktree isolation requires git', {});
  }
  if (!facts.repository) {
    throw new AuditError(AUDIT_CODES.notRepository, 'worktree isolation requires a git work tree', {});
  }
  if (!facts.hasCommits) {
    throw new AuditError(AUDIT_CODES.noCommits, 'worktree isolation requires at least one commit', {});
  }
  return facts;
}
