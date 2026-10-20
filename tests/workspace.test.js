// Workspace tests: mutual exclusion, audit evidence, sensitive-content
// withholding, and refusal when git is unavailable.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertWorktreeCapable,
  AUDIT_CODES,
  captureBaseline,
  captureDiff,
  probeRepository,
} from '../src/workspace/audit.js';
import { isInside, LOCK_CODES, WorkspaceError, WorkspaceLocks } from '../src/workspace/locks.js';
import { fakeGit } from './helpers/fakes.js';

const ROOT = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';

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
  const root = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, process.platform === 'win32' ? 'C:\\work\\project\\src\\a.js' : '/work/project/src/a.js'), true);
  // A sibling directory sharing a prefix must not count as contained.
  assert.equal(isInside(root, process.platform === 'win32' ? 'C:\\work\\project2\\a.js' : '/work/project2/a.js'), false);
});

test('a repository probe reports git, repository and commit facts', async () => {
  const runGit = fakeGit();
  const facts = await probeRepository(runGit, ROOT);
  assert.equal(facts.git, true);
  assert.equal(facts.repository, true);
  assert.equal(facts.hasCommits, true);
  assert.match(facts.head, /^a{40}$/);
});

test('a probe reports a non-repository instead of throwing', async () => {
  const runGit = fakeGit({ 'rev-parse --is-inside-work-tree': { stdout: 'false\n', code: 128 } });
  const facts = await probeRepository(runGit, ROOT);
  assert.equal(facts.repository, false);
});

test('a git failure is a refusal, never "no changes"', async () => {
  const denial = new Error('spawn EPERM');
  denial.code = 'EPERM';
  const runGit = async () => { throw denial; };
  await assert.rejects(
    () => probeRepository(runGit, ROOT),
    (error) => error.code === AUDIT_CODES.gitUnavailable,
  );
  await assert.rejects(
    () => captureBaseline({ runGit }, ROOT),
    (error) => error.code === AUDIT_CODES.gitUnavailable,
  );
});

test('a baseline records pre-existing dirt', async () => {
  const runGit = fakeGit({
    'status --porcelain=v1 --untracked-files=all': { stdout: ' M src/already-dirty.js\n?? notes.txt\n' },
  });
  const baseline = await captureBaseline({ runGit }, ROOT);
  assert.equal(baseline.dirtyBaseline, true);
  assert.equal(baseline.preexistingChanges, 2);
});

test('a repository with no commit is refused as a baseline', async () => {
  const runGit = fakeGit({ 'rev-parse --verify HEAD': { stdout: '', code: 128 } });
  await assert.rejects(
    () => captureBaseline({ runGit }, ROOT),
    (error) => error.code === AUDIT_CODES.notRepository,
  );
});

test('the diff reports files, statuses and a bounded patch', async () => {
  const runGit = fakeGit({
    'status --porcelain=v1 --untracked-files=all': { stdout: ' M src/index.js\n?? new-file.js\n' },
    'diff --numstat HEAD': { stdout: '3\t1\tsrc/index.js\n' },
    'diff --no-color --no-ext-diff --unified=3 HEAD': { stdout: 'diff --git a/src/index.js b/src/index.js\n+added line\n' },
    'ls-files --others --exclude-standard': { stdout: 'new-file.js\n' },
    'diff --no-index --no-color --unified=3 -- /dev/null new-file.js': { stdout: 'diff --git a/new-file.js b/new-file.js\n+content\n' },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: 'abc', dirtyBaseline: false, preexistingChanges: 0 });
  assert.equal(diff.fileCount, 2);
  assert.deepEqual(diff.files.map((file) => file.path), ['src/index.js', 'new-file.js']);
  assert.equal(diff.files[0].status, 'modified');
  assert.equal(diff.files[1].status, 'added');
  assert.match(diff.patchText, /added line/);
  assert.match(diff.patchText, /new-file\.js/);
  assert.equal(diff.patchTruncated, false);
});

test('sensitive paths keep their name but lose their content', async () => {
  const runGit = fakeGit({
    'status --porcelain=v1 --untracked-files=all': { stdout: ' M .env\n?? certs/server.pem\n' },
    'diff --no-color --no-ext-diff --unified=3 HEAD': { stdout: '+API_KEY=super-secret-value\n' },
    'ls-files --others --exclude-standard': { stdout: 'certs/server.pem\n' },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: 'abc', dirtyBaseline: false, preexistingChanges: 0 });
  assert.deepEqual(diff.sensitivePaths.sort(), ['.env', 'certs/server.pem'].sort());
  assert.equal(diff.files.every((file) => file.sensitive === true), true);
  // The path stays visible; the secret value must not appear anywhere.
  assert.equal(JSON.stringify(diff).includes('super-secret-value'), false);
});

test('an oversize patch is truncated with a marker', async () => {
  const huge = `+${'x'.repeat(80 * 1024)}`;
  const runGit = fakeGit({
    'status --porcelain=v1 --untracked-files=all': { stdout: ' M big.txt\n' },
    'diff --no-color --no-ext-diff --unified=3 HEAD': { stdout: huge },
    'ls-files --others --exclude-standard': { stdout: '' },
  });
  const diff = await captureDiff({ runGit }, ROOT, { head: 'abc', dirtyBaseline: false, preexistingChanges: 0 });
  assert.equal(diff.patchTruncated, true);
  assert.match(diff.patchText, /patch truncated/);
  assert.ok(Buffer.byteLength(diff.patchText, 'utf8') < 80 * 1024);
});

test('worktree isolation refuses a non-repository', async () => {
  const runGit = fakeGit({ 'rev-parse --is-inside-work-tree': { stdout: 'false\n', code: 128 } });
  await assert.rejects(
    () => assertWorktreeCapable({ runGit }, ROOT),
    (error) => error.code === AUDIT_CODES.notRepository,
  );
});

test('worktree isolation refuses a repository with no commit', async () => {
  const runGit = fakeGit({ 'rev-parse --verify HEAD': { stdout: '', code: 128 } });
  await assert.rejects(
    () => assertWorktreeCapable({ runGit }, ROOT),
    (error) => error.code === AUDIT_CODES.noCommits,
  );
});

test('worktree isolation accepts a committed repository', async () => {
  const facts = await assertWorktreeCapable({ runGit: fakeGit() }, ROOT);
  assert.equal(facts.hasCommits, true);
});
