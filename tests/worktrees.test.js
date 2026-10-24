// Worktree isolation tests: real directories, a self-contained fake git, and a
// real-git path that runs wherever process creation is permitted.
//
// The fake git is local to this file on purpose. It models only the four
// invocations the manager issues (`worktree add/remove/prune`, `rev-parse`), and
// it fails loudly on anything else — so a manager that started issuing
// `checkout`, `reset` or a shell string would fail these tests instead of
// silently passing. Every assertion about safety reads the recorded argv, not
// the manager's own report.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { AUDIT_CODES, createGitRunner } from '../src/workspace/audit.js';
import {
  safeTaskSegment,
  WORKTREE_CODES,
  WORKTREE_STATES,
  WorktreeError,
  WorktreeManager,
} from '../src/workspace/worktrees.js';
import { cleanup, makeTempDir } from './helpers/fakes.js';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

/** Arguments the manager is allowed to issue. Anything else fails the test. */
const ALLOWED_GIT = [/^--version$/, /^rev-parse --/, /^status --/, /^worktree (add|remove|prune)\b/];

/**
 * Fake git that really creates and removes directories.
 *
 * `worktree add --detach <path> <sha>` behaves like the real command closely
 * enough for the manager's contract: the directory appears and the tree reports
 * the commit it was created from. Everything the fake cannot model (a dirty
 * index, a broken repository) is scripted by the test.
 * @param {object} [options] - `status`, `head`, `failAdd`, `treeHead`, `onAdd`.
 * @returns {object} runner with `calls` history.
 */
function fakeWorktreeGit(options = {}) {
  const calls = [];
  const head = options.head ?? HEAD;
  const runner = async (cwd, args) => {
    const joined = args.join(' ');
    calls.push({ cwd, args, joined });
    assert.ok(
      ALLOWED_GIT.some((pattern) => pattern.test(joined)),
      `the worktree manager issued an unexpected git command: ${joined}`,
    );
    if (joined === '--version') return { stdout: 'git version 2.54.0\n', stderr: '', code: 0 };
    if (joined === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', stderr: '', code: 0 };
    if (joined === 'rev-parse --verify HEAD') {
      // Inside a tree the manager created, the pinned commit is what it asked for.
      const inside = calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add' && resolve(call.args[3]) === resolve(cwd));
      return { stdout: `${inside ? options.treeHead ?? head : head}\n`, stderr: '', code: 0 };
    }
    if (/^status --porcelain=v1 -z --untracked-files=all$/.test(joined)) {
      return { stdout: options.status ?? '', stderr: '', code: 0 };
    }
    if (/^worktree add --detach /.test(joined)) {
      const [, , , destination] = args;
      if (options.failAdd !== undefined) return { stdout: '', stderr: options.failAdd, code: 128 };
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, '.git'), `gitdir: ${join(cwd, '.git', 'worktrees', 'x')}\n`, 'utf8');
      if (typeof options.onAdd === 'function') await options.onAdd({ destination, cwd });
      return { stdout: `Preparing worktree (detached HEAD ${args[4]})\n`, stderr: '', code: 0 };
    }
    if (/^worktree remove --force /.test(joined)) {
      await rm(args[3], { recursive: true, force: true });
      return { stdout: '', stderr: '', code: options.failRemove ?? 0 };
    }
    if (joined === 'worktree prune') return { stdout: '', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  runner.calls = calls;
  return runner;
}

/**
 * Build a manager over a fresh temporary source repository and worktree root.
 * @param {object} [options] - forwarded to {@link fakeWorktreeGit}, plus `rootInsideSource`.
 * @returns {Promise<object>} harness.
 */
async function harness(options = {}) {
  const base = await makeTempDir();
  const sourcePath = join(base, 'source');
  const rootDir = options.rootInsideSource === true ? join(sourcePath, 'trees') : join(base, 'trees');
  await mkdir(sourcePath, { recursive: true });
  const runGit = options.runGit ?? fakeWorktreeGit(options);
  const manager = new WorktreeManager({ runGit }, { rootDir, randomId: () => options.suffix ?? 'test0001' });
  return {
    base,
    sourcePath,
    rootDir,
    manager,
    runGit,
    /**
     * Remove the temporary base directory.
     * @returns {Promise<void>} resolves when removed.
     */
    async close() {
      await cleanup(base);
    },
  };
}

// ---------------------------------------------------------------------------
// Task id handling
// ---------------------------------------------------------------------------

test('a task id is reduced to one safe path segment', () => {
  assert.equal(safeTaskSegment('task-abc123'), 'task-abc123');
  assert.equal(safeTaskSegment('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeTaskSegment('C:\\Windows\\System32'), 'C-Windows-System32');
  assert.equal(safeTaskSegment('..'), '');
  assert.equal(safeTaskSegment('a/b\\c d'), 'a-b-c-d');
  assert.equal(safeTaskSegment(''), '');
  assert.equal(safeTaskSegment(42), '');
});

test('a constructed manager refuses a root that is not absolute', () => {
  const runGit = fakeWorktreeGit();
  assert.throws(
    () => new WorktreeManager({ runGit }, { rootDir: 'relative/trees' }),
    (error) => error instanceof WorktreeError && error.code === WORKTREE_CODES.rootInvalid,
  );
  assert.throws(
    () => new WorktreeManager({ runGit }, {}),
    (error) => error.code === WORKTREE_CODES.rootInvalid,
  );
  assert.throws(
    () => new WorktreeManager({}, { rootDir: tmpdir() }),
    (error) => error.code === WORKTREE_CODES.gitFailed,
  );
});

// ---------------------------------------------------------------------------
// prepare()
// ---------------------------------------------------------------------------

test('prepare creates a real detached tree under the plugin root', async () => {
  const h = await harness();
  try {
    const prepared = await h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath });
    assert.equal(prepared.isolated, true);
    assert.equal(prepared.detached, true);
    assert.equal(prepared.baseHead, HEAD);
    assert.equal(prepared.taskId, 'task-1');
    assert.equal(resolve(prepared.sourcePath), resolve(h.sourcePath));
    // The tree is inside the plugin root, not inside the user's checkout.
    assert.equal(resolve(prepared.workspacePath).startsWith(resolve(h.rootDir)), true);
    assert.equal(resolve(prepared.workspacePath).startsWith(resolve(h.sourcePath)), false);
    assert.equal((await stat(prepared.workspacePath)).isDirectory(), true);

    const add = h.runGit.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
    assert.equal(add.length, 1);
    // Detached at the pinned commit: no branch can move in either repository.
    assert.deepEqual(add[0].args.slice(0, 3), ['worktree', 'add', '--detach']);
    assert.equal(add[0].args[4], HEAD);
    // argv only: no shell, no mutating porcelain command.
    const command = JSON.stringify(h.runGit.calls.map((call) => call.args));
    for (const forbidden of ['checkout', 'merge', 'reset', 'rebase', 'stash', 'commit']) {
      assert.equal(command.includes(`"${forbidden}"`), false, `issued ${forbidden}`);
    }
  } finally {
    await h.close();
  }
});

test('prepare refuses a source that is not a git work tree', async () => {
  const h = await harness({
    runGit: async (cwd, args) => {
      if (args.join(' ') === '--version') return { stdout: 'git version 2.54.0\n', stderr: '', code: 0 };
      if (args.join(' ') === 'rev-parse --is-inside-work-tree') return { stdout: 'false\n', stderr: '', code: 128 };
      return { stdout: '', stderr: '', code: 0 };
    },
  });
  try {
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath }),
      (error) => error.code === WORKTREE_CODES.notRepository,
    );
    assert.deepEqual(h.manager.list(), []);
  } finally {
    await h.close();
  }
});

test('prepare refuses a repository with no commit', async () => {
  const h = await harness({
    runGit: async (cwd, args) => {
      const joined = args.join(' ');
      if (joined === '--version') return { stdout: 'git version 2.54.0\n', stderr: '', code: 0 };
      if (joined === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', stderr: '', code: 0 };
      if (joined === 'rev-parse --verify HEAD') return { stdout: '', stderr: '', code: 128 };
      return { stdout: '', stderr: '', code: 0 };
    },
  });
  try {
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath }),
      (error) => error.code === WORKTREE_CODES.noCommits,
    );
  } finally {
    await h.close();
  }
});

test('prepare refuses git that cannot be executed', async () => {
  const denial = new Error('spawn EPERM');
  denial.code = 'EPERM';
  const h = await harness({ runGit: async () => { throw denial; } });
  try {
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath }),
      (error) => error.code === WORKTREE_CODES.gitUnavailable,
    );
  } finally {
    await h.close();
  }
});

test('prepare refuses a dirty source and names the changes without content', async () => {
  const h = await harness({
    status: ' M src/a.js\0?? .env\0',
  });
  try {
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath }),
      (error) => {
        assert.equal(error.code, WORKTREE_CODES.sourceDirty);
        assert.equal(error.details.changes, 2);
        assert.deepEqual(error.details.paths, ['src/a.js', '.env']);
        // No content, no diff: a refusal is metadata.
        assert.equal(JSON.stringify(error.details).includes('\u0000'), false);
        return true;
      },
    );
    // Nothing was created and nothing was registered.
    assert.deepEqual(h.manager.list(), []);
    assert.deepEqual(
      h.runGit.calls.filter((call) => call.args[0] === 'worktree'),
      [],
      'a dirty source must not reach `git worktree add`',
    );
  } finally {
    await h.close();
  }
});

test('prepare refuses a root inside the source repository', async () => {
  const h = await harness({ rootInsideSource: true });
  try {
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath }),
      (error) => error.code === WORKTREE_CODES.nestedDestination,
    );
    assert.deepEqual(h.runGit.calls.filter((call) => call.args[0] === 'worktree'), []);
  } finally {
    await h.close();
  }
});

test('prepare refuses a destination that already exists', async () => {
  const h = await harness({ suffix: 'fixed01' });
  try {
    await mkdir(h.rootDir, { recursive: true });
    const taken = join(h.rootDir, 'task-1-fixed01');
    await mkdir(taken, { recursive: true });
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath }),
      (error) => error.code === WORKTREE_CODES.destinationExists,
    );
    // The existing directory is untouched.
    assert.equal((await stat(taken)).isDirectory(), true);
  } finally {
    await h.close();
  }
});

test('a task id cannot escape the plugin root', async () => {
  const h = await harness({ suffix: 'escape01' });
  try {
    const prepared = await h.manager.prepare({ taskId: '../../escape', sourcePath: h.sourcePath });
    assert.equal(resolve(prepared.workspacePath).startsWith(resolve(h.rootDir)), true);
    assert.equal(prepared.workspacePath.includes('..'), false);
  } finally {
    await h.close();
  }
});

test('two tasks get two distinct trees', async () => {
  let counter = 0;
  const base = await makeTempDir();
  try {
    const sourcePath = join(base, 'source');
    await mkdir(sourcePath, { recursive: true });
    const manager = new WorktreeManager({ runGit: fakeWorktreeGit() }, {
      rootDir: join(base, 'trees'),
      randomId: () => `id000${counter += 1}`,
    });
    const first = await manager.prepare({ taskId: 'task-1', sourcePath });
    const second = await manager.prepare({ taskId: 'task-1', sourcePath });
    assert.notEqual(first.workspacePath, second.workspacePath);
    assert.equal(manager.list({ taskId: 'task-1' }).length, 2);
  } finally {
    await cleanup(base);
  }
});

test('a failing `git worktree add` is a refusal and leaves no tree', async () => {
  const h = await harness({ failAdd: 'fatal: could not create work tree dir' });
  try {
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath }),
      (error) => error.code === WORKTREE_CODES.gitFailed
        && error.details.step === 'worktree add'
        && /could not create work tree dir/.test(error.details.stderr),
    );
    assert.deepEqual(h.manager.list(), []);
    // The administrative entry is settled even though creation failed.
    assert.equal(h.runGit.calls.some((call) => call.joined === 'worktree prune'), true);
  } finally {
    await h.close();
  }
});

test('a tree created at the wrong commit is refused and cleaned up', async () => {
  const h = await harness({ treeHead: OTHER_HEAD });
  try {
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath }),
      (error) => error.code === WORKTREE_CODES.gitFailed
        && error.details.expected === HEAD
        && error.details.actual === OTHER_HEAD,
    );
    assert.deepEqual(h.manager.list(), []);
    assert.equal(h.runGit.calls.some((call) => /^worktree remove --force /.test(call.joined)), true);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('a cancellation before creation prevents any tree from being created', async () => {
  const h = await harness();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath, signal: controller.signal }),
      (error) => error.code === WORKTREE_CODES.cancelled,
    );
    assert.deepEqual(h.runGit.calls.filter((call) => call.args[0] === 'worktree'), []);
  } finally {
    await h.close();
  }
});

test('a cancellation during creation removes the tree and hands out nothing', async () => {
  const controller = new AbortController();
  const h = await harness({ onAdd: async () => { controller.abort(); } });
  try {
    await assert.rejects(
      () => h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath, signal: controller.signal }),
      (error) => error.code === WORKTREE_CODES.cancelled && error.details.phase === 'after-create',
    );
    assert.deepEqual(h.manager.list(), []);
    assert.equal(h.runGit.calls.some((call) => /^worktree remove --force /.test(call.joined)), true);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Registry: list() and dispose()
// ---------------------------------------------------------------------------

test('list exposes metadata only, never content', async () => {
  const h = await harness();
  try {
    const prepared = await h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath });
    // Write a file into the tree: it must not appear in the registry view.
    await writeFile(join(prepared.workspacePath, 'secret-plan.txt'), 'never in metadata\n', 'utf8');
    const [entry] = h.manager.list();
    assert.deepEqual(Object.keys(entry).sort(), [
      'baseHead',
      'completedAt',
      'createdAt',
      'detached',
      'disposable',
      'isolated',
      'sourcePath',
      'sourcePreexistingChanges',
      'state',
      'taskId',
      'workspacePath',
    ]);
    assert.equal(JSON.stringify(entry).includes('never in metadata'), false);
    assert.equal(entry.state, WORKTREE_STATES.active);
  } finally {
    await h.close();
  }
});

test('a completed tree is kept until a host disposes it', async () => {
  const h = await harness();
  try {
    const prepared = await h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath });
    const completed = h.manager.markComplete(prepared.workspacePath);
    assert.equal(completed.state, WORKTREE_STATES.awaitingHostReview);
    // Still on disk: a finished run is evidence, not garbage.
    assert.equal((await stat(prepared.workspacePath)).isDirectory(), true);

    const disposed = await h.manager.dispose(prepared.workspacePath);
    assert.equal(disposed.state, WORKTREE_STATES.disposed);
    await assert.rejects(() => stat(prepared.workspacePath), (error) => error.code === 'ENOENT');
    assert.equal(h.runGit.calls.some((call) => call.joined === 'worktree prune'), true);
    // A second dispose cannot silently succeed.
    await assert.rejects(
      () => h.manager.dispose(prepared.workspacePath),
      (error) => error.code === WORKTREE_CODES.unknownTree,
    );
  } finally {
    await h.close();
  }
});

test('an active unreviewed tree is not deleted on request', async () => {
  const h = await harness();
  try {
    const prepared = await h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath });
    await assert.rejects(
      () => h.manager.dispose(prepared.workspacePath),
      (error) => error.code === WORKTREE_CODES.notReviewed,
    );
    assert.equal((await stat(prepared.workspacePath)).isDirectory(), true);
    // An explicit host statement that review happened is enough.
    const disposed = await h.manager.dispose(prepared.workspacePath, { reviewed: true });
    assert.equal(disposed.state, WORKTREE_STATES.disposed);
  } finally {
    await h.close();
  }
});

test('dispose refuses a path this manager does not own', async () => {
  const h = await harness();
  try {
    const outsider = join(h.base, 'not-a-tree');
    await mkdir(outsider, { recursive: true });
    await assert.rejects(
      () => h.manager.dispose(outsider),
      (error) => error.code === WORKTREE_CODES.unknownTree,
    );
    assert.equal((await stat(outsider)).isDirectory(), true);
    assert.equal(h.runGit.calls.some((call) => call.args[0] === 'worktree'), false);
  } finally {
    await h.close();
  }
});

test('a restart forgets the registry but leaves trees on disk for review', async () => {
  const h = await harness();
  try {
    const prepared = await h.manager.prepare({ taskId: 'task-1', sourcePath: h.sourcePath });
    const restarted = new WorktreeManager({ runGit: h.runGit }, { rootDir: h.rootDir });
    assert.deepEqual(restarted.list(), []);
    // The tree still exists and still holds the commit, so nothing was destroyed.
    assert.equal((await stat(prepared.workspacePath)).isDirectory(), true);
    await assert.rejects(
      () => restarted.dispose(prepared.workspacePath),
      (error) => error.code === WORKTREE_CODES.unknownTree,
    );
    assert.equal((await stat(prepared.workspacePath)).isDirectory(), true);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------------------
// Real git, where the host permits process creation
// ---------------------------------------------------------------------------

/**
 * Probe whether this host can actually execute git from Node.
 * @returns {Promise<boolean>} true when `git --version` succeeds.
 */
async function gitUsable() {
  const runGit = createGitRunner({ timeoutMs: 5000 });
  try {
    const result = await runGit(tmpdir(), ['--version']);
    return result.code === 0;
  } catch (error) {
    // A confinement denial is "git cannot run here", which is what the skip is
    // for; anything else is a real failure the caller should see.
    if (error?.code === AUDIT_CODES.gitUnavailable) return false;
    throw error;
  }
}

test('a real detached worktree is created for a committed repository', async (t) => {
  if (!(await gitUsable())) {
    t.skip('git cannot be spawned from this environment');
    return;
  }
  const runGit = createGitRunner({ timeoutMs: 20000 });
  const base = await mkdtemp(join(tmpdir(), 'dsh-worktree-'));
  try {
    const sourcePath = join(base, 'source');
    await mkdir(sourcePath, { recursive: true });
    const exec = async (args) => {
      const result = await runGit(sourcePath, args);
      assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
      return result;
    };
    await exec(['init', '-q', '.']);
    await exec(['config', 'user.email', 'test@example.invalid']);
    await exec(['config', 'user.name', 'test']);
    await writeFile(join(sourcePath, 'README.md'), '# fixture\n', 'utf8');
    await exec(['add', '-A']);
    await exec(['commit', '-qm', 'init']);

    const manager = new WorktreeManager({ runGit }, { rootDir: join(base, 'trees') });
    const prepared = await manager.prepare({ taskId: 'real-1', sourcePath });
    assert.equal(prepared.isolated, true);
    assert.match(prepared.baseHead, /^[0-9a-f]{40}$/);
    assert.equal((await readdir(prepared.workspacePath)).includes('README.md'), true);

    // A clean source is required, so this second attempt must be refused once
    // the checkout is dirty.
    await writeFile(join(sourcePath, 'scratch.txt'), 'dirty\n', 'utf8');
    await assert.rejects(
      () => manager.prepare({ taskId: 'real-2', sourcePath }),
      (error) => error.code === WORKTREE_CODES.sourceDirty,
    );

    manager.markComplete(prepared.workspacePath);
    await manager.dispose(prepared.workspacePath);
    await assert.rejects(() => stat(prepared.workspacePath), (error) => error.code === 'ENOENT');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
