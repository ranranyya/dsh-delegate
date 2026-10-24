// Workspace tests: mutual exclusion, audit evidence, NUL-safe status parsing,
// sensitive-content withholding before any diff exists, and refusal when git is
// unavailable.
//
// The audit runner is faked, but never *helpfully*: the fake returns exactly the
// bytes a real `git status -z` returns, and every assertion that matters is made
// against the argv the audit module actually issued. A regression in argument
// construction (dropping `--no-ext-diff`, comparing to `HEAD`, forgetting an
// exclusion pathspec) therefore fails here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIT_CODES,
  AUDIT_LIMITS,
  assertWorktreeCapable,
  captureBaseline,
  captureDiff,
  createGitRunner,
  parseNumstatZ,
  parseStatusZ,
  probeRepository,
} from '../src/workspace/audit.js';
import { isInside, LOCK_CODES, WorkspaceError, WorkspaceLocks } from '../src/workspace/locks.js';
import { fakeGit } from './helpers/fakes.js';

const ROOT = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

const STATUS_ARGS = 'status --porcelain=v1 -z --untracked-files=all';
const LSFILES_ARGS = 'ls-files --others --exclude-standard -z';

/** NUL-join a list of porcelain records, as git does. */
function z(...tokens) {
  return `${tokens.join('\0')}\0`;
}

/**
 * Build an audit runner that answers from a table keyed by joined argv and
 * records every call, so tests can assert the exact invocation.
 * @param {object} table - `{ 'argv key': { stdout, stderr, code } }`.
 * @returns {object} runner with `calls`.
 */
function auditGit(table = {}) {
  const calls = [];
  const base = {
    '--version': { stdout: 'git version 2.54.0\n', stderr: '', code: 0 },
    'rev-parse --is-inside-work-tree': { stdout: 'true\n', stderr: '', code: 0 },
    'rev-parse --verify HEAD': { stdout: `${HEAD}\n`, stderr: '', code: 0 },
  };
  const runner = async (cwd, args) => {
    const joined = args.join(' ');
    calls.push({ cwd, args, joined });
    // A scripted answer wins over the healthy defaults, so a test can make one
    // probe fail and nothing else.
    const scripted = Object.hasOwn(table, joined) ? table[joined] : base[joined];
    if (scripted === undefined) return { stdout: '', stderr: '', code: 0 };
    if (scripted instanceof Error) throw scripted;
    return { stdout: scripted.stdout ?? '', stderr: scripted.stderr ?? '', code: scripted.code ?? 0 };
  };
  runner.calls = calls;
  return runner;
}

/** The diff invocation the audit module must use for a pinned base. */
function diffKey(baseHead, exclusions = []) {
  const base = `diff --no-color --no-ext-diff --no-textconv --unified=3 ${baseHead}`;
  if (exclusions.length === 0) return base;
  return `${base} -- ${exclusions.map((relPath) => `:(exclude,literal)${relPath}`).join(' ')}`;
}

// ---------------------------------------------------------------------------
// Locks and path containment
// ---------------------------------------------------------------------------

test('a workspace lock admits one holder and refuses a second', () => {
  const locks = new WorkspaceLocks();
  const lease = locks.acquire(ROOT, { taskId: 'task-1' });
  assert.equal(locks.isLocked(ROOT), true);
  assert.throws(
    () => locks.acquire(ROOT, { taskId: 'task-2' }),
    (error) => error instanceof WorkspaceError && error.code === LOCK_CODES.busy,
  );
  assert.equal(locks.release(ROOT, lease.nonce), true);
  assert.equal(locks.isLocked(ROOT), false);
});

test('a stale nonce cannot release another holder lock', () => {
  const locks = new WorkspaceLocks();
  const first = locks.acquire(ROOT, { taskId: 'task-1' });
  assert.equal(locks.release(ROOT, 'wrong-nonce'), false);
  assert.equal(locks.isLocked(ROOT), true);
  assert.equal(locks.release(ROOT, first.nonce), true);
});

test('an expired lease is reclaimable', () => {
  let clock = 1_000_000;
  const locks = new WorkspaceLocks({ now: () => clock, maxHoldMs: 1000 });
  locks.acquire(ROOT, { taskId: 'task-1' });
  clock += 1001;
  assert.equal(locks.isLocked(ROOT), false);
  const second = locks.acquire(ROOT, { taskId: 'task-2' });
  assert.equal(second.taskId, 'task-2');
});

test('path containment is boundary-aware', () => {
  assert.equal(isInside(ROOT, ROOT), true);
  assert.equal(isInside(ROOT, process.platform === 'win32' ? 'C:\\work\\project\\src\\a.js' : '/work/project/src/a.js'), true);
  // A sibling directory sharing a prefix must not count as contained.
  assert.equal(isInside(ROOT, process.platform === 'win32' ? 'C:\\work\\project2\\a.js' : '/work/project2/a.js'), false);
});

// ---------------------------------------------------------------------------
// Repository probing
// ---------------------------------------------------------------------------

test('a repository probe reports git, repository and commit facts', async () => {
  const facts = await probeRepository(auditGit(), ROOT);
  assert.equal(facts.git, true);
  assert.equal(facts.repository, true);
  assert.equal(facts.hasCommits, true);
  assert.equal(facts.head, HEAD);
});

test('a probe reports a non-repository instead of throwing', async () => {
  const facts = await probeRepository(auditGit({
    'rev-parse --is-inside-work-tree': { stdout: 'false\n', code: 128 },
  }), ROOT);
  assert.equal(facts.repository, false);
});

test('a git failure is a refusal, never "no changes"', async () => {
  const denial = new Error('spawn EPERM');
  denial.code = 'EPERM';
  const runGit = async () => { throw denial; };
  await assert.rejects(() => probeRepository(runGit, ROOT), (error) => error.code === AUDIT_CODES.gitUnavailable);
  await assert.rejects(() => captureBaseline({ runGit }, ROOT), (error) => error.code === AUDIT_CODES.gitUnavailable);
  await assert.rejects(() => captureDiff({ runGit }, ROOT, { head: HEAD }), (error) => error.code === AUDIT_CODES.gitUnavailable);
});

test('a runner that returns junk is a refusal, not an empty diff', async () => {
  const runGit = async () => null;
  await assert.rejects(
    () => probeRepository(runGit, ROOT),
    (error) => error.code === AUDIT_CODES.gitFailed,
  );
});

// ---------------------------------------------------------------------------
// NUL-delimited status parsing
// ---------------------------------------------------------------------------

test('status parsing keeps names with spaces, quotes and unicode intact', () => {
  const { entries } = parseStatusZ(z(
    ' M src/with space.js',
    '?? "quoted"\\name.js',
    '?? caf\u00e9/\u4e2d\u6587.js',
  ));
  assert.deepEqual(entries.map((entry) => entry.path), ['src/with space.js', '"quoted"\\name.js', 'caf\u00e9/\u4e2d\u6587.js']);
  // No quote stripping: in -z form a quote character is part of the filename.
  assert.equal(entries[1].path.startsWith('"'), true);
});

test('a rename yields both the new and the old path', () => {
  const { entries } = parseStatusZ(z('R  new-name.js', 'old-name.js'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'new-name.js');
  assert.equal(entries[0].from, 'old-name.js');
  assert.equal(entries[0].status, 'renamed');
});

test('a rename away from a sensitive path is still sensitive', () => {
  const { entries } = parseStatusZ(z('R  notes.txt', '.env'));
  assert.equal(entries[0].sensitive, true);
  // The new name alone would have looked harmless.
  assert.equal(entries[0].path, 'notes.txt');
  assert.equal(entries[0].from, '.env');
});

test('status entries are bounded but the total is reported', () => {
  const records = [];
  for (let index = 0; index < 12; index += 1) records.push(` M file-${index}.js`);
  const { entries, total, truncated } = parseStatusZ(z(...records), 5);
  assert.equal(entries.length, 5);
  assert.equal(total, 12);
  assert.equal(truncated, true);
});

test('a non-NUL status read is refused rather than mis-parsed', async () => {
  // A line-format status would rewrite quoted paths; guessing is not allowed.
  const runGit = auditGit({ [STATUS_ARGS]: { stdout: ' M .env\n?? certs/x.pem\n' } });
  await assert.rejects(
    () => captureBaseline({ runGit }, ROOT),
    (error) => error.code === AUDIT_CODES.gitFailed,
  );
});

test('numstat -z parses normal and rename rows', () => {
  const rows = parseNumstatZ(`${z('3\t1\tsrc/a.js', '1\t0\t', 'old.js', 'new.js')}`);
  assert.deepEqual(rows, [
    { added: '3', removed: '1', path: 'src/a.js', from: null },
    { added: '1', removed: '0', path: 'new.js', from: 'old.js' },
  ]);
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

test('a baseline pins the head commit and records pre-existing dirt', async () => {
  const runGit = auditGit({ [STATUS_ARGS]: { stdout: z(' M src/already-dirty.js', '?? notes.txt') } });
  const baseline = await captureBaseline({ runGit }, ROOT);
  assert.equal(baseline.head, HEAD);
  assert.equal(baseline.dirtyBaseline, true);
  assert.equal(baseline.preexistingChanges, 2);
  assert.deepEqual(baseline.preexistingPaths, ['src/already-dirty.js', 'notes.txt']);
  assert.equal(baseline.statusFormat, 'porcelain-v1-z');
});

test('a repository with no commit is refused as a baseline', async () => {
  const runGit = auditGit({ 'rev-parse --verify HEAD': { stdout: '', code: 128 } });
  await assert.rejects(() => captureBaseline({ runGit }, ROOT), (error) => error.code === AUDIT_CODES.notRepository);
});

test('a failing status read is a refusal carrying bounded stderr', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: '', stderr: 'fatal: index file smaller than expected', code: 128 },
  });
  await assert.rejects(
    () => captureBaseline({ runGit }, ROOT),
    (error) => error.code === AUDIT_CODES.gitFailed
      && error.details.exitCode === 128
      && /index file smaller/.test(error.details.stderr),
  );
});

// ---------------------------------------------------------------------------
// Diff evidence
// ---------------------------------------------------------------------------

test('the diff is measured against the pinned baseline commit, not HEAD', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(' M src/index.js') },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD}`]: { stdout: z('3\t1\tsrc/index.js') },
    [diffKey(HEAD)]: { stdout: 'diff --git a/src/index.js b/src/index.js\n+added line\n' },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: HEAD, dirtyBaseline: false, preexistingChanges: 0 });
  assert.equal(diff.baseHead, HEAD);
  assert.equal(diff.fileCount, 1);
  assert.deepEqual(diff.files.map((file) => file.path), ['src/index.js']);
  assert.equal(diff.files[0].status, 'modified');
  assert.match(diff.patchText, /added line/);
  // Every diff invocation names the pinned commit; `HEAD` must never appear.
  for (const call of runGit.calls.filter((entry) => entry.args[0] === 'diff')) {
    assert.equal(call.args.includes('HEAD'), false, `diff invoked with HEAD: ${call.joined}`);
    assert.equal(call.args.includes(NEXT_HEAD), false);
  }
});

test('the audit never asks git to compare against the string HEAD', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(' M a.js') },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD}`]: { stdout: z('1\t0\ta.js') },
    [diffKey(HEAD)]: { stdout: '+x\n' },
  });
  await captureDiff({ runGit }, ROOT, { head: HEAD });
  const joined = runGit.calls.map((call) => call.joined).join('\n');
  assert.equal(/\bHEAD\b/.test(joined.replace(/rev-parse --verify HEAD/g, '')), false, joined);
});

test('a diff without a pinned baseline is refused', async () => {
  await assert.rejects(
    () => captureDiff({ runGit: auditGit() }, ROOT, { head: null }),
    (error) => error.code === AUDIT_CODES.baselineInvalid,
  );
  await assert.rejects(
    () => captureDiff({ runGit: auditGit() }, ROOT, null),
    (error) => error.code === AUDIT_CODES.baselineInvalid,
  );
});

test('external diff drivers and textconv filters are disabled on every diff', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(' M a.js', '?? b.js') },
    [LSFILES_ARGS]: { stdout: z('b.js') },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD}`]: { stdout: z('1\t0\ta.js') },
    [diffKey(HEAD)]: { stdout: '+x\n' },
    ['diff --no-index --no-color --no-ext-diff --no-textconv --unified=3 -- /dev/null b.js']: {
      stdout: 'diff --git a/b.js b/b.js\n+y\n',
      code: 1,
    },
  });
  // The untracked file is described, not opened, before it is rendered.
  const statPath = async () => ({ kind: 'file', size: 10 });
  const diff = await captureDiff({ runGit, statPath }, ROOT, { head: HEAD });
  assert.match(diff.patchText, /\+x/);
  assert.match(diff.patchText, /\+y/);
  for (const call of runGit.calls.filter((entry) => entry.args[0] === 'diff')) {
    assert.equal(call.args.includes('--no-ext-diff'), true, call.joined);
    assert.equal(call.args.includes('--no-textconv'), true, call.joined);
  }
});

test('an untracked path that is not a regular file is not rendered', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z('?? link.js', '?? dir/') },
    [LSFILES_ARGS]: { stdout: z('link.js', 'dir/file.js') },
    [`diff --no-index --no-color --no-ext-diff --no-textconv --unified=3 -- /dev/null dir/file.js`]: {
      stdout: '+from-dir\n',
      code: 1,
    },
  });
  const seen = [];
  const statPath = async (absolutePath) => {
    seen.push(absolutePath);
    return absolutePath.endsWith('link.js')
      ? { kind: 'symlink', size: 0 }
      : { kind: 'file', size: 12 };
  };
  const diff = await captureDiff({ runGit, statPath }, ROOT, { head: HEAD });
  assert.equal(seen.length, 2);
  assert.equal(diff.patchText.includes('from-dir'), true);
  // Only the regular file was handed to git for rendering.
  const reads = runGit.calls.filter((call) => call.args.includes('--no-index'));
  assert.deepEqual(reads.map((call) => call.args.at(-1)), ['dir/file.js']);
});

test('sensitive paths are excluded before any diff is produced', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(' M .env', '?? certs/server.pem', ' M src/a.js') },
    [LSFILES_ARGS]: { stdout: z('certs/server.pem') },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD} -- :(exclude,literal).env :(exclude,literal)certs/server.pem`]: {
      stdout: z('1\t0\tsrc/a.js'),
    },
    [diffKey(HEAD, ['.env', 'certs/server.pem'])]: { stdout: 'diff --git a/src/a.js b/src/a.js\n+implementation\n' },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: HEAD });
  assert.deepEqual(diff.sensitivePaths, ['.env', 'certs/server.pem']);
  assert.equal(diff.sensitiveTouchedCount, 2);
  assert.equal(diff.sensitiveContentWithheld, true);
  // Names stay visible so an operator knows credential files were touched.
  assert.equal(diff.files.some((file) => file.sensitive === true), true);
  // The untracked sensitive file is never opened: no --no-index read for it.
  const reads = runGit.calls.filter((call) => call.args[0] === 'diff' && call.args.includes('--no-index'));
  assert.deepEqual(reads.map((call) => call.args.at(-1)), [], 'a sensitive untracked file was read');
});

test('a rename away from a sensitive path is excluded by its old name too', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z('R  notes.txt', '.env', ' M src/a.js') },
    [LSFILES_ARGS]: { stdout: '' },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD} -- :(exclude,literal).env`]: { stdout: z('1\t0\tsrc/a.js') },
    [diffKey(HEAD, ['.env'])]: { stdout: '+implementation\n' },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: HEAD });
  assert.deepEqual(diff.sensitivePaths, ['.env']);
  assert.equal(diff.files.find((file) => file.path === 'notes.txt').sensitive, true);
});

test('a truncated status list withholds the patch, because completeness is unprovable', async () => {
  const records = [];
  for (let index = 0; index < AUDIT_LIMITS.statusEntries + 1; index += 1) records.push(` M f-${index}.js`);
  const runGit = auditGit({ [STATUS_ARGS]: { stdout: z(...records) }, [LSFILES_ARGS]: { stdout: z('untracked.js') } });
  const diff = await captureDiff({ runGit }, ROOT, { head: HEAD });
  assert.equal(diff.patchWithheld, true);
  assert.match(diff.patchText, /status list exceeded/);
  // No diff at all, so no untracked file was opened and no patch was produced.
  assert.deepEqual(runGit.calls.filter((call) => call.args[0] === 'diff'), []);
  assert.equal(diff.patchText.includes('untracked.js'), false);
});

test('too many sensitive paths withholds the patch entirely', async () => {
  const records = [];
  for (let index = 0; index < AUDIT_LIMITS.sensitivePaths + 1; index += 1) records.push(`?? secret-${index}.key`);
  const runGit = auditGit({ [STATUS_ARGS]: { stdout: z(...records) }, [LSFILES_ARGS]: { stdout: '' } });
  const diff = await captureDiff({ runGit }, ROOT, { head: HEAD });
  assert.equal(diff.patchWithheld, true);
  assert.equal(diff.sensitiveTouchedCount, AUDIT_LIMITS.sensitivePaths + 1);
  assert.match(diff.patchText, /diff withheld/);
  // No diff invocation was issued at all, so no content could have been read.
  assert.deepEqual(runGit.calls.filter((call) => call.args[0] === 'diff'), []);
});

test('secret-shaped text that reaches the patch is still masked', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(' M src/config.js') },
    [LSFILES_ARGS]: { stdout: '' },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD}`]: { stdout: z('1\t0\tsrc/config.js') },
    [diffKey(HEAD)]: { stdout: '+const API_KEY=sk-abcdefghijklmnopqrstuvwx\n' },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: HEAD });
  assert.equal(diff.patchText.includes('sk-abcdefghijklmnopqrstuvwx'), false);
});

test('an oversize patch is truncated with a marker', async () => {
  const huge = `+${'x'.repeat(80 * 1024)}`;
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(' M big.txt') },
    [LSFILES_ARGS]: { stdout: '' },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD}`]: { stdout: z('1\t0\tbig.txt') },
    [diffKey(HEAD)]: { stdout: huge },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: HEAD });
  assert.equal(diff.patchTruncated, true);
  assert.match(diff.patchText, /patch truncated/);
  assert.ok(Buffer.byteLength(diff.patchText, 'utf8') < 80 * 1024);
});

test('the file list is bounded and says so', async () => {
  const records = [];
  for (let index = 0; index < AUDIT_LIMITS.files + 5; index += 1) records.push(` M f-${index}.js`);
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(...records) },
    [LSFILES_ARGS]: { stdout: '' },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD}`]: { stdout: '' },
    [diffKey(HEAD)]: { stdout: '' },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: HEAD });
  assert.equal(diff.files.length, AUDIT_LIMITS.files);
  assert.equal(diff.fileCount, AUDIT_LIMITS.files + 5);
  assert.equal(diff.truncatedFiles, true);
});

test('a failing diff is a refusal, not an empty patch', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(' M a.js') },
    [LSFILES_ARGS]: { stdout: '' },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD}`]: { stdout: '', code: 128 },
  });
  await assert.rejects(
    () => captureDiff({ runGit }, ROOT, { head: HEAD }),
    (error) => error.code === AUDIT_CODES.gitFailed && error.details.step === 'diff --numstat',
  );
});

test('the patch invocation never renders a sensitive path', async () => {
  const runGit = auditGit({
    [STATUS_ARGS]: { stdout: z(' M .env') },
    [LSFILES_ARGS]: { stdout: '' },
    [`diff --numstat -z --no-ext-diff --no-textconv ${HEAD} -- :(exclude,literal).env`]: { stdout: '' },
    [diffKey(HEAD, ['.env'])]: { stdout: '' },
  });
  await captureDiff({ runGit }, ROOT, { head: HEAD });
  const patches = runGit.calls.filter((call) => call.args[0] === 'diff' && call.args.includes('--unified=3'));
  assert.equal(patches.length, 1);
  assert.equal(patches[0].args.includes('--'), true);
  assert.equal(patches[0].args.includes(':(exclude,literal).env'), true);
});

// ---------------------------------------------------------------------------
// Worktree capability (the manager's own tests live in worktrees.test.js)
// ---------------------------------------------------------------------------

test('worktree isolation refuses a non-repository', async () => {
  const runGit = auditGit({ 'rev-parse --is-inside-work-tree': { stdout: 'false\n', code: 128 } });
  await assert.rejects(
    () => assertWorktreeCapable({ runGit }, ROOT),
    (error) => error.code === AUDIT_CODES.notRepository,
  );
});

test('worktree isolation refuses a repository with no commit', async () => {
  const runGit = auditGit({ 'rev-parse --verify HEAD': { stdout: '', code: 128 } });
  await assert.rejects(
    () => assertWorktreeCapable({ runGit }, ROOT),
    (error) => error.code === AUDIT_CODES.noCommits,
  );
});

test('worktree isolation accepts a committed repository', async () => {
  const facts = await assertWorktreeCapable({ runGit: auditGit() }, ROOT);
  assert.equal(facts.hasCommits, true);
});

test('the shipped git runner refuses an environment that cannot spawn git', async () => {
  // This sandbox denies process creation; the runner must refuse, not report an
  // empty diff. Where git does run, the version probe must succeed.
  const runGit = createGitRunner({ timeoutMs: 4000 });
  try {
    const result = await runGit(ROOT, ['--version']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /git version/);
  } catch (error) {
    assert.equal(error.code, AUDIT_CODES.gitUnavailable, error.message);
  }
});
