// Git-backed workspace inspection.
//
// What a job changed is measured, not reported: this module reads git state
// before and after the run and records the delta as evidence. It never trusts
// the agent's summary, and it reads only read-only git subcommands — nothing
// here can mutate the repository it is auditing.
//
// A capability check is not a formality. If git is unavailable, the platform
// refuses job execution rather than running a job whose changes cannot be
// audited afterwards.

import { execFile } from 'node:child_process';
import { isSensitivePath, redactText } from '../config/redact.js';

/** Bounds that keep evidence payloads reviewable. */
export const AUDIT_LIMITS = Object.freeze({
  files: 500,
  patchBytes: 64 * 1024,
  gitTimeoutMs: 8000,
  statLines: 200,
});

/** Audit failure codes, each mapped to an operator-visible explanation. */
export const AUDIT_CODES = Object.freeze({
  gitUnavailable: 'AUDIT_GIT_UNAVAILABLE',
  notRepository: 'AUDIT_NOT_A_REPOSITORY',
  noCommits: 'AUDIT_NO_COMMITS',
  gitFailed: 'AUDIT_GIT_FAILED',
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
 * @param {string} cwd - repository working directory.
 * @param {string[]} args - git argv.
 * @returns {Promise<{ stdout: string, code: number }>} trimmed output.
 */
export function createGitRunner() {
  return function runGit(cwd, args) {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=false', ...args],
        { cwd, encoding: 'utf8', timeout: AUDIT_LIMITS.gitTimeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false, windowsHide: true },
        (error, stdout) => {
          if (error === null || error === undefined) {
            resolvePromise({ stdout: String(stdout ?? ''), code: 0 });
            return;
          }
          const code = typeof error.code === 'number' ? error.code : null;
          if (code === 0) {
            resolvePromise({ stdout: String(stdout ?? ''), code: 0 });
            return;
          }
          denyProcessCreation(error, rejectPromise);
          if (code !== null) {
            // A git-level failure is data, not an exception: callers inspect it.
            resolvePromise({ stdout: String(stdout ?? ''), code });
            return;
          }
          rejectPromise(new AuditError(AUDIT_CODES.gitFailed, 'git could not be executed', {
            cause: typeof error.code === 'string' ? error.code : null,
          }));
        },
      );
    });
  };
}

function denyProcessCreation(error, rejectPromise) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
    rejectPromise(new AuditError(AUDIT_CODES.gitUnavailable, 'git is not executable in this environment', { cause: code }));
  }
}

/**
 * Probe whether a directory is a git work tree with at least one commit.
 * @param {(cwd: string, args: string[]) => Promise<{stdout: string, code: number}>} runGit - runner.
 * @param {string} workspacePath - resolved workspace path.
 * @returns {Promise<{ git: boolean, repository: boolean, hasCommits: boolean, head: string | null }>} facts.
 */
export async function probeRepository(runGit, workspacePath) {
  const facts = { git: false, repository: false, hasCommits: false, head: null };
  try {
    const version = await runGit(workspacePath, ['--version']);
    facts.git = version.code === 0;
  } catch (error) {
    if (error instanceof AuditError) throw error;
    throw new AuditError(AUDIT_CODES.gitUnavailable, 'git is not available', {});
  }
  if (!facts.git) return facts;
  const inside = await runGit(workspacePath, ['rev-parse', '--is-inside-work-tree']);
  facts.repository = inside.code === 0 && inside.stdout.trim() === 'true';
  if (!facts.repository) return facts;
  const head = await runGit(workspacePath, ['rev-parse', '--verify', 'HEAD']);
  if (head.code === 0) {
    facts.hasCommits = true;
    facts.head = head.stdout.trim();
  }
  return facts;
}

/**
 * Capture the workspace state a job starts from.
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
  const status = await deps.runGit(workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const dirty = status.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return {
    head: facts.head,
    dirtyBaseline: dirty.length > 0,
    // The pre-existing dirty count is kept so a reviewer can tell this job's
    // changes apart from edits that were already there.
    preexistingChanges: dirty.length,
    capturedAt: Date.now(),
  };
}

/**
 * Measure what changed since the baseline: status entries plus a bounded patch.
 *
 * Sensitive paths keep their path in the file list — the operator needs to know
 * a credential file was touched — but their content is withheld from the patch.
 * @param {object} deps - `runGit` runner.
 * @param {string} workspacePath - resolved workspace path.
 * @param {object} baseline - value returned by {@link captureBaseline}.
 * @returns {Promise<object>} bounded, redacted change evidence.
 */
export async function captureDiff(deps, workspacePath, baseline) {
  const status = await deps.runGit(workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const entries = status.stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
    .map(parseStatusLine)
    .filter((entry) => entry !== null);

  const files = entries.slice(0, AUDIT_LIMITS.files);
  const truncatedFiles = entries.length > files.length;
  const sensitive = files.filter((entry) => isSensitivePath(entry.path));

  const numstat = await deps.runGit(workspacePath, ['diff', '--numstat', 'HEAD']);
  const changes = numstat.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, AUDIT_LIMITS.statLines)
    .map((line) => {
      const [added, removed, ...rest] = line.split('\t');
      return { added, removed, path: rest.join('\t') };
    });

  const patch = await readBoundedPatch(deps.runGit, workspacePath);

  return {
    head: baseline?.head ?? null,
    dirtyBaseline: baseline?.dirtyBaseline === true,
    preexistingChanges: baseline?.preexistingChanges ?? 0,
    files,
    fileCount: entries.length,
    truncatedFiles,
    changes,
    sensitivePaths: sensitive.map((entry) => entry.path),
    patchText: patch.text,
    patchTruncated: patch.truncated,
    patchBytes: Buffer.byteLength(patch.text, 'utf8'),
    capturedAt: Date.now(),
  };
}

async function readBoundedPatch(runGit, workspacePath) {
  const diff = await runGit(workspacePath, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    `--unified=3`,
    'HEAD',
  ]);
  // Untracked files have no diff against HEAD; include them as explicit
  // additions so a new file cannot silently evade review, minus sensitive ones.
  const untracked = await runGit(workspacePath, ['ls-files', '--others', '--exclude-standard']);
  const untrackedPaths = untracked.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !isSensitivePath(line))
    .slice(0, AUDIT_LIMITS.files);

  const chunks = [];
  if (diff.code === 0 && diff.stdout.trim() !== '') chunks.push(diff.stdout);
  for (const relPath of untrackedPaths) {
    const shown = await runGit(workspacePath, ['diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', relPath]);
    const text = shown.stdout.trim() === '' ? '' : shown.stdout;
    if (text !== '') chunks.push(text);
  }

  const combined = redactText(chunks.join('\n'));
  const bytes = Buffer.from(combined, 'utf8');
  if (bytes.byteLength <= AUDIT_LIMITS.patchBytes) {
    return { text: combined, truncated: false };
  }
  // Cut on a byte boundary, then drop the possibly split trailing code point so
  // the retained text stays valid UTF-8 for JSON transport.
  const slice = bytes.subarray(0, AUDIT_LIMITS.patchBytes).toString('utf8').replace(/\uFFFD$/, '');
  return { text: `${slice}\n… patch truncated at ${AUDIT_LIMITS.patchBytes} bytes`, truncated: true };
}

function parseStatusLine(line) {
  const match = /^(.{2})\s+(.+)$/.exec(line);
  if (match === null) return null;
  const [, code, rawPath] = match;
  const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
  return {
    code,
    path: path.trim().replace(/^"|"$/g, ''),
    status: describeStatus(code),
    sensitive: isSensitivePath(path),
  };
}

function describeStatus(code) {
  if (code === '??') return 'added';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  if (code.includes('M')) return 'modified';
  return 'changed';
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
