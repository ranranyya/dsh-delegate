// Session placement and task-thread continuation.
//
// The properties under test are the ones an operator can observe:
//
//  * every worker run lands in a real Workspace keyed by its ACTUAL execution
//    directory (`task.executionPath` — the worktree when one was prepared, the
//    source checkout when it was not);
//  * a new submission ALWAYS starts a new DSH conversation, even in a directory
//    that already ran tasks, and even when the stored settings document still says
//    `conversation.mode: "reuse"` (the retired directory-level mode);
//  * `continueFromTaskId` continues exactly ONE task's thread — its Workspace, its
//    Session — and every way that can go wrong is a refusal, never a silent new
//    conversation;
//  * a follow-up to an isolated task runs in that task's own tree, because that is
//    where the earlier uncommitted work is;
//  * a harness that cannot place a run fails closed instead of producing an
//    ungrouped session;
//  * a run cancelled before it starts creates neither a Workspace nor a Session;
//  * the native session persistence service (`deps.sessions`) is never mistaken
//    for the session CONTROLLER (`deps.sessionController`).
//
// The last one is a wiring property, and it is asserted directly: it is the bug
// that made every placed run impossible while every fake still looked healthy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  LEGACY_CONVERSATION_MODE,
  PLACEMENT_KINDS,
  RECORD_FIELDS,
  SESSION_CODES,
  SessionPlacementError,
  SessionStore,
  continuationOf,
  ensureWorkspace,
  migrateSessionRow,
  placeSession,
  rememberSession,
  sameSessionPath,
  sameWorktreeId,
  sessionPathKey,
} from '../src/runtime/session-placement.js';
import { ISOLATION_MODES } from '../src/config/defaults.js';
import {
  cleanup,
  fakeSessionController,
  fakeWorkspaceController,
  makeTempDir,
} from './helpers/fakes.js';

const DIR_A = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha';
const DIR_B = process.platform === 'win32' ? 'C:\\work\\beta' : '/work/beta';
const TREE_A = process.platform === 'win32' ? 'C:\\trees\\alpha\\task-1' : '/trees/alpha/task-1';

/**
 * Both controllers, wired the way production wires them.
 * @param {object} [options] - `workspaces`, `sessionController`.
 * @returns {object} dependency object.
 */
function controllers(options = {}) {
  const workspaces = options.workspaces ?? fakeWorkspaceController();
  return {
    workspaces,
    sessionController: options.sessionController ?? fakeSessionController({ workspaces }),
  };
}

/**
 * One durable row as {@link rememberSession} writes it.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} row input.
 */
function identityRow(overrides = {}) {
  return {
    taskId: 'task-parent',
    sourcePath: DIR_A,
    executionPath: DIR_A,
    isolation: 'shared',
    ...overrides,
  };
}

// --- Canonical path identity -------------------------------------------------

test('two spellings of one directory are one identity, and two directories never are', () => {
  const trailing = `${DIR_A}${process.platform === 'win32' ? '\\' : '/'}`;
  assert.equal(sessionPathKey(DIR_A), sessionPathKey(trailing), 'a trailing separator is not a different directory');
  assert.equal(sameSessionPath(DIR_A, trailing), true);
  assert.equal(sameSessionPath(DIR_A, DIR_B), false, 'different directories must never be the same conversation');
  if (process.platform === 'win32') {
    assert.equal(sameSessionPath('C:\\Work\\Alpha', 'c:\\work\\alpha'), true, 'NTFS is case-insensitive');
  }
  assert.equal(sessionPathKey(''), null);
  assert.equal(sessionPathKey('   '), null);
  assert.equal(sessionPathKey(42), null);
  assert.equal(sameSessionPath(null, DIR_A), false);
});

// --- The wiring property -----------------------------------------------------

test('placement reads the session CONTROLLER, never the native sessions service', async () => {
  // The exact bug: `deps.sessions` is `ctx.sessions`, the persistence service the
  // runner flushes through. It has no `create`. A placement module that read it
  // would report a composed harness as "no session controller" — or, worse,
  // accept an object that cannot plan a Session and fail later with an opaque
  // error.
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  const sessionsService = {
    // A faithful stand-in for `ctx.sessions`: flush exists, `create` does not.
    flushed: [],
    async flush(session) { sessionsService.flushed.push(session); },
  };

  const placement = await placeSession(
    { workspaces, sessionController, sessions: sessionsService },
    { path: DIR_A },
  );

  assert.equal(sessionController.creates.length, 1, 'the session controller must be the service that created the Session');
  assert.equal(placement.workspaceId, 'ws-1');
  assert.equal(sessionsService.flushed.length, 0, 'placement must not touch the persistence service');
});

test('a harness with only the native sessions service refuses placement', async () => {
  // And the refusal is specifically "the controller is missing", not a crash on a
  // missing method: the persistence service alone must not be mistaken for a
  // session planner.
  const workspaces = fakeWorkspaceController();
  const sessionsService = { async flush() {} };

  await assert.rejects(
    () => placeSession({ workspaces, sessions: sessionsService }, { path: DIR_A }),
    (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.sessionsUnavailable,
  );
});

test('a missing Workspace controller is refused before any Session exists', async () => {
  const sessionController = fakeSessionController();
  await assert.rejects(
    () => placeSession({ workspaces: null, sessionController }, { path: DIR_A }),
    (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.workspacesUnavailable,
  );
  assert.equal(sessionController.creates.length, 0, 'no Session may be created without a Workspace');
});

// --- Workspace resolution ----------------------------------------------------

test('the Workspace is keyed by the actual execution directory and is created once', async () => {
  const workspaces = fakeWorkspaceController();
  const first = await ensureWorkspace(workspaces, DIR_A);
  const second = await ensureWorkspace(workspaces, DIR_A);

  assert.equal(first.workspaceId, second.workspaceId, 'repeated runs in one directory share one group');
  assert.equal(first.created, true);
  assert.equal(second.created, false, 'the second resolve reuses the existing Workspace');
  assert.equal(workspaces.workspaces.size, 1, 'no duplicate Workspace accumulates');
});

test('two execution directories are two Workspaces', async () => {
  const workspaces = fakeWorkspaceController();
  const a = await ensureWorkspace(workspaces, DIR_A);
  const b = await ensureWorkspace(workspaces, DIR_B);

  assert.notEqual(a.workspaceId, b.workspaceId);
  assert.equal(workspaces.workspaces.size, 2);
});

test('a controller that reports no Workspace identity is refused', async () => {
  const workspaces = fakeWorkspaceController({ shapeless: true });
  await assert.rejects(
    () => ensureWorkspace(workspaces, DIR_A),
    (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.workspaceRefused,
  );
});

test('a refusing Workspace controller is reported as a refusal, with its native code', async () => {
  const failure = Object.assign(new Error('workspace/invalid-path'), { code: 'workspace/invalid-path' });
  const workspaces = fakeWorkspaceController({ fail: failure });
  await assert.rejects(
    () => ensureWorkspace(workspaces, DIR_A),
    (error) => error instanceof SessionPlacementError
      && error.code === SESSION_CODES.workspaceRefused
      && error.details.cause === 'workspace/invalid-path',
  );
});

// --- The retired mode is incapable of an implicit reuse ----------------------

test('the legacy reuse mode is a value only: there is no mode vocabulary left to consult', async () => {
  // What the removed setting used to do — make the SECOND run in a directory
  // continue the first — must now be impossible from the settings side. The value
  // still exists as accepted input, and it is what the migration names.
  assert.equal(LEGACY_CONVERSATION_MODE, 'reuse');
  const deps = controllers();
  const first = await placeSession(deps, { path: DIR_A });
  const second = await placeSession(deps, { path: DIR_A, mode: LEGACY_CONVERSATION_MODE });
  const third = await placeSession(deps, { path: DIR_A, mode: 'new' });

  assert.equal(first.kind, PLACEMENT_KINDS.new);
  assert.equal(second.kind, PLACEMENT_KINDS.new, 'a legacy mode passed to placement is not even an input any more');
  assert.equal(third.kind, PLACEMENT_KINDS.new);
  for (const placement of [first, second, third]) {
    assert.equal(placement.reused, false, 'nothing may be reused without an explicit continuation');
    assert.equal(placement.continuedFromTaskId, null);
  }
  assert.equal(deps.sessionController.creates.length, 3, 'three submissions, three Sessions');
  assert.ifError(sessionIdsUnique([first, second, third]));
});

/**
 * Whether three placements name three distinct Sessions.
 * @param {object[]} placements - placements to compare.
 * @returns {Error | null} the failure, or null.
 */
function sessionIdsUnique(placements) {
  const ids = placements.map((placement) => placement.sessionId);
  return new Set(ids).size === ids.length ? null : new Error(`sessions were shared: ${ids.join(', ')}`);
}

test('a new submission does not read the identity map at all', async () => {
  // A new submission is new even when a perfect parent record exists for this very
  // directory: the map is keyed by task and nothing but `continueFromTaskId` reads
  // it. A placement that looked a directory up would start reusing again.
  const deps = {
    ...controllers(),
    sessionStore: {
      async get() { throw new Error('a new submission must not look up any identity'); },
    },
  };
  const placement = await placeSession(deps, { path: DIR_A });
  assert.equal(placement.kind, PLACEMENT_KINDS.new);
  assert.equal(deps.sessionController.creates.length, 1);
});

// --- New submissions ---------------------------------------------------------

test('a new submission creates one Session and resolves its Agent, creating nothing twice', async () => {
  const deps = controllers();
  const placement = await placeSession(deps, { path: DIR_A });

  assert.equal(placement.kind, PLACEMENT_KINDS.new);
  assert.equal(placement.reused, false);
  assert.equal(placement.sessionCreated, true);
  assert.equal(placement.sessionId, 'session-1');
  assert.equal(deps.sessionController.creates.length, 1, 'exactly one Session is created');
  assert.deepEqual(deps.sessionController.resolves, ['session-1'], 'that one Session is resolved to its Agent');
  assert.ok(placement.agent !== null && placement.agent !== undefined, 'a drivable Agent must be returned');
  assert.equal(typeof placement.agent.followup, 'function');
  assert.equal(typeof placement.agent.whenIdle, 'function');
  assert.equal(placement.agent.id, 'session-1', 'the Agent is joined to the Session that was created');
});

test('two unrelated submissions in one directory are two Sessions in one Workspace', async () => {
  const deps = controllers();
  const first = await placeSession(deps, { path: DIR_A });
  const second = await placeSession(deps, { path: DIR_A });

  assert.notEqual(first.sessionId, second.sessionId, 'an unrelated task gets a distinct Session');
  assert.equal(first.workspaceId, second.workspaceId, 'while the directory keeps one Workspace group');
  assert.equal(deps.sessionController.creates.length, 2);
});

test('a different directory never shares a Session or a Workspace', async () => {
  const deps = controllers();
  const a = await placeSession(deps, { path: DIR_A });
  const b = await placeSession(deps, { path: DIR_B });
  assert.notEqual(a.workspaceId, b.workspaceId);
  assert.notEqual(a.sessionId, b.sessionId);
});

test('the preset id is forwarded to the Session creation, not to a second create', async () => {
  const deps = controllers();
  await placeSession(deps, { path: DIR_A, presetId: 'deployment-default' });
  assert.equal(deps.sessionController.creates.length, 1);
  assert.equal(deps.sessionController.creates[0].agentPreset, 'deployment-default');
});

test('a Session that cannot be resolved to an Agent is a stated refusal', async () => {
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({
    workspaces,
    resumeAgent: async () => ({ error: { code: 'session/writer-held', message: 'held' } }),
  });
  await assert.rejects(
    () => placeSession({ workspaces, sessionController }, { path: DIR_A }),
    (error) => error instanceof SessionPlacementError
      && error.code === SESSION_CODES.resumeFailed
      && error.details.cause === 'session/writer-held',
  );
});

test('a controller without resolveAgent cannot place a run at all', async () => {
  // Fail closed: a Session was created, but nothing could attach an Agent to it,
  // so the run must not report a placement it cannot drive.
  const workspaces = fakeWorkspaceController();
  const bare = {
    sessions: new Map(),
    async create() { return { sessionId: 'session-x' }; },
  };
  await assert.rejects(
    () => placeSession({ workspaces, sessionController: bare }, { path: DIR_A }),
    (error) => error instanceof SessionPlacementError
      && error.code === SESSION_CODES.resumeUnavailable
      && error.details.reason === 'sessionController.resolveAgent is missing',
  );
});

// --- Continuation identity input ---------------------------------------------

test('an absent, blank or non-string continuation is "no continuation"', () => {
  assert.equal(continuationOf(undefined), null);
  assert.equal(continuationOf(null), null);
  assert.equal(continuationOf(''), null);
  assert.equal(continuationOf('   '), null);
  assert.equal(continuationOf(42), null, 'a non-string never becomes a task id');
  assert.equal(continuationOf({ taskId: 'x' }), null);
  assert.equal(continuationOf(' task-parent '), 'task-parent');
});

// --- Explicit continuation ---------------------------------------------------

/**
 * A store holding one recorded thread, plus a controller whose Session exists.
 * @param {object} [options] - `row` overrides, `existingSession` id, `sessionCwd`.
 * @returns {Promise<object>} dependency object with the fake controllers attached.
 */
async function continuationFixture(options = {}) {
  const dir = await makeTempDir();
  const store = new SessionStore(dir);
  const row = identityRow(options.row ?? {});
  await rememberSession(store, {
    workspaceId: options.workspaceId ?? 'ws-1',
    sessionId: options.existingSession ?? 'session-parent',
  }, row);
  const workspaces = fakeWorkspaceController();
  // The Workspace the PARENT's run was placed in must already exist, because the
  // parent ran there. It is discovered the way the parent resolved it — from the
  // parent's actual execution path — which for a shared run is the checkout and for
  // an isolated run is the tree. A follow-up submitted anywhere else therefore
  // resolves a different Workspace, which is the mismatch the tests below assert.
  const parentWorkspace = await workspaces.create({ path: row.executionPath });
  const sessionController = fakeSessionController({ workspaces });
  sessionController.sessions.set(options.existingSession ?? 'session-parent', {
    sessionId: options.existingSession ?? 'session-parent',
    workspaceId: parentWorkspace.workspace.workspaceId,
    cwd: options.sessionCwd ?? row.executionPath,
    disposed: false,
  });
  return {
    dir,
    store,
    row,
    parentWorkspace: parentWorkspace.workspace.workspaceId,
    deps: {
      workspaces,
      sessionController,
      sessionStore: store,
      sourcePath: row.sourcePath,
      taskId: 'task-child',
    },
  };
}

test('continueFromTaskId continues exactly the parent task thread', async () => {
  const fixture = await continuationFixture();
  try {
    const placement = await placeSession(fixture.deps, {
      path: fixture.row.executionPath,
      continueFromTaskId: fixture.row.taskId,
    });

    assert.equal(placement.kind, PLACEMENT_KINDS.continuation);
    assert.equal(placement.reused, true);
    assert.equal(placement.continuedFromTaskId, 'task-parent');
    assert.equal(placement.sessionId, 'session-parent', 'the parent Session must be the one continued');
    assert.equal(placement.sessionCreated, false);
    assert.equal(fixture.deps.sessionController.creates.length, 0, 'a continuation must not create a Session');
    assert.deepEqual(fixture.deps.sessionController.resolves, ['session-parent']);
    assert.equal(placement.agent.id, 'session-parent');
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a continued thread is the SAME live Agent, so both turns land in one log', async () => {
  const fixture = await continuationFixture();
  try {
    const first = await placeSession(fixture.deps, {
      path: fixture.row.executionPath,
      continueFromTaskId: fixture.row.taskId,
    });
    const second = await placeSession(fixture.deps, {
      path: fixture.row.executionPath,
      continueFromTaskId: fixture.row.taskId,
    });
    assert.equal(first.agent, second.agent, 'continuing one thread must drive one Agent, not two');
    assert.equal(fixture.deps.sessionController.creates.length, 0);
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('an unknown or pruned parent task is refused, never replaced by a new Session', async () => {
  const fixture = await continuationFixture();
  try {
    await assert.rejects(
      () => placeSession(fixture.deps, { path: fixture.row.executionPath, continueFromTaskId: 'task-missing' }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.continuationUnknown
        && error.details.continueFromTaskId === 'task-missing',
    );
    assert.equal(fixture.deps.sessionController.creates.length, 0, 'a refused continuation must not start a conversation');
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a continuation with no identity store says so explicitly', async () => {
  await assert.rejects(
    () => placeSession({ ...controllers(), sessionStore: null }, { path: DIR_A, continueFromTaskId: 'task-parent' }),
    (error) => error instanceof SessionPlacementError
      && error.code === SESSION_CODES.continuationUnavailable
      && error.details.reason === 'no session identity store',
  );
});

test('an unreadable identity store is a refusal, not a silent new conversation', async () => {
  const deps = {
    ...controllers(),
    sessionStore: { async get() { throw new Error('the map is corrupt'); } },
  };
  await assert.rejects(
    () => placeSession(deps, { path: DIR_A, continueFromTaskId: 'task-parent' }),
    (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.continuationUnavailable,
  );
  assert.equal(deps.sessionController.creates.length, 0);
});

test('a parent that ran in another directory is refused, and no Session is created', async () => {
  // Includes the worktree case by construction: a plugin-managed tree is a
  // different directory from its source on purpose.
  const fixture = await continuationFixture({ row: { executionPath: DIR_B, sourcePath: DIR_A } });
  try {
    await assert.rejects(
      () => placeSession(fixture.deps, { path: DIR_A, continueFromTaskId: fixture.row.taskId }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.continuationPathMismatch
        && error.details.executionPath === DIR_A
        && error.details.recordedExecutionPath === DIR_B,
    );
    assert.equal(fixture.deps.sessionController.creates.length, 0, 'a mismatched continuation invents nothing');
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a parent recorded for another source repository is refused', async () => {
  // The row's source is DIR_A while this submission's authorized source is DIR_B:
  // a task chain never crosses repositories, even when both directories happen to
  // be authorized for the same caller.
  const fixture = await continuationFixture({ row: { sourcePath: DIR_A } });
  try {
    const placement = await placeSession(
      { ...fixture.deps, sourcePath: DIR_B },
      { path: fixture.row.executionPath, continueFromTaskId: fixture.row.taskId },
    );
    assert.fail(`expected a refusal, got ${placement.kind}`);
  } catch (error) {
    assert.ok(error instanceof SessionPlacementError, 'the refusal is a placement refusal');
    assert.equal(error.code, SESSION_CODES.continuationWorkspaceMismatch);
    assert.equal(error.details.reason, 'different source repository');
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a recorded Workspace that is not this run\'s Workspace is refused', async () => {
  // The identity names a Workspace id that is not the one this submission resolves.
  // Reaching across Workspaces is a cross-directory continuation by another name.
  const fixture = await continuationFixture({ workspaceId: 'ws-other' });
  try {
    await assert.rejects(
      () => placeSession(fixture.deps, { path: fixture.row.executionPath, continueFromTaskId: fixture.row.taskId }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.continuationWorkspaceMismatch
        && error.details.reason === 'different workspace',
    );
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a continuation whose Session no longer exists is refused, not silently replaced', async () => {
  const dir = await makeTempDir();
  try {
    const store = new SessionStore(dir);
    // A recorded row whose Session the controller does not know: the parent ran in a
    // previous process and the Session was deleted since.
    await rememberSession(store, { workspaceId: 'ws-1', sessionId: 'session-gone' }, identityRow());
    const workspaces = fakeWorkspaceController();
    await workspaces.create({ path: DIR_A });
    const sessionController = fakeSessionController({ workspaces });
    await assert.rejects(
      () => placeSession({ workspaces, sessionController, sessionStore: store }, {
        path: DIR_A,
        continueFromTaskId: 'task-parent',
      }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.resumeFailed
        && error.details.cause === 'session/not-found'
        && /no longer exists/.test(error.message),
    );
    assert.equal(sessionController.creates.length, 0, 'a failed continuation must not create a replacement Session');
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('an Agent whose own session header names another directory is refused', async () => {
  const fixture = await continuationFixture({ sessionCwd: DIR_B });
  try {
    await assert.rejects(
      () => placeSession(fixture.deps, { path: fixture.row.executionPath, continueFromTaskId: fixture.row.taskId }),
      (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.resumePathMismatch,
    );
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a continuation needs resolveAgent and says so when the build cannot resume', async () => {
  const dir = await makeTempDir();
  try {
    const store = new SessionStore(dir);
    await rememberSession(store, { workspaceId: 'ws-1', sessionId: 'session-1' }, identityRow());
    const workspaces = fakeWorkspaceController();
    await workspaces.create({ path: DIR_A });
    const bare = { sessions: new Map(), async create() { return { sessionId: 'session-x' }; } };
    await assert.rejects(
      () => placeSession({ workspaces, sessionController: bare, sessionStore: store }, {
        path: DIR_A,
        continueFromTaskId: 'task-parent',
      }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.resumeUnavailable
        && error.details.reason === 'sessionController.resolveAgent is missing',
    );
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

// --- Worktree continuation ---------------------------------------------------

/**
 * A managed-tree registry stand-in shaped like `WorktreeManager.get`.
 * @param {Map<string, object>} trees - keyed by canonical tree path.
 * @returns {object} registry with `get`.
 */
function fakeWorktreeRegistry(trees) {
  const key = (path) => (typeof path === 'string' ? sessionPathKey(path) : null);
  const byKey = new Map([...trees].map(([path, record]) => [key(path), record]));
  return {
    get(path) {
      const record = byKey.get(key(path));
      return record === undefined ? null : { ...record };
    },
  };
}

test('a worktree continuation runs in the parent tree and keeps its earlier changes there', async () => {
  // The tree path is the execution path. Continuing there is what preserves the
  // parent's uncommitted worker changes: preparing a fresh tree would start from a
  // clean commit and hide them.
  const fixture = await continuationFixture({
    row: {
      executionPath: TREE_A,
      sourcePath: DIR_A,
      isolation: 'worktree',
      worktreeId: 'task-parent',
      worktreeState: 'awaiting-host-review',
    },
  });
  try {
    fixture.deps.worktrees = fakeWorktreeRegistry(new Map([[
      TREE_A,
      { taskId: 'task-parent', workspacePath: TREE_A, state: 'awaiting-host-review', worktreeId: 'task-parent' },
    ]]));
    const placement = await placeSession(fixture.deps, {
      path: TREE_A,
      continueFromTaskId: fixture.row.taskId,
    });
    assert.equal(placement.kind, PLACEMENT_KINDS.continuation);
    assert.equal(placement.workspacePath, TREE_A, 'the follow-up runs in the parent tree');
    assert.equal(placement.workspaceId, fixture.parentWorkspace, 'and in the Workspace the parent used');
    // The tree is its own Workspace group (that is what an isolated run is filed
    // under), so the follow-up neither resolves the source checkout nor creates a
    // second tree: exactly one Workspace, keyed by the tree the parent used.
    assert.deepEqual(
      fixture.deps.workspaces.creates.map((request) => request.path),
      [TREE_A, TREE_A],
      'the parent Workspace plus the same tree path, and nothing else',
    );
    assert.equal(fixture.deps.workspaces.workspaces.size, 1, 'one Workspace, no second tree group');
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a worktree continuation whose tree was disposed is refused', async () => {
  const fixture = await continuationFixture({
    row: { executionPath: TREE_A, sourcePath: DIR_A, isolation: 'worktree', worktreeId: 'task-parent', worktreeState: 'disposed' },
  });
  try {
    fixture.deps.worktrees = fakeWorktreeRegistry(new Map());
    await assert.rejects(
      () => placeSession(fixture.deps, { path: TREE_A, continueFromTaskId: fixture.row.taskId }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.continuationUnavailable
        && error.details.reason === 'worktree disposed',
    );
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a worktree continuation whose tree is gone from the registry is refused', async () => {
  const fixture = await continuationFixture({
    row: { executionPath: TREE_A, sourcePath: DIR_A, isolation: 'worktree', worktreeId: 'task-parent' },
  });
  try {
    fixture.deps.worktrees = fakeWorktreeRegistry(new Map());
    await assert.rejects(
      () => placeSession(fixture.deps, { path: TREE_A, continueFromTaskId: fixture.row.taskId }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.continuationUnavailable
        && error.details.reason === 'tree not managed here',
    );
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a worktree continuation that would land in another tree is refused', async () => {
  const fixture = await continuationFixture({
    row: { executionPath: TREE_A, sourcePath: DIR_A, isolation: 'worktree', worktreeId: 'task-parent' },
  });
  try {
    fixture.deps.worktrees = fakeWorktreeRegistry(new Map([[
      TREE_A,
      { taskId: 'task-somebody-else', workspacePath: TREE_A, state: 'awaiting-host-review', worktreeId: 'task-somebody-else' },
    ]]));
    await assert.rejects(
      () => placeSession(fixture.deps, { path: TREE_A, continueFromTaskId: fixture.row.taskId }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.continuationUnavailable
        && error.details.reason === 'worktree identity mismatch',
    );
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a worktree continuation without a recorded tree identity is refused', async () => {
  const fixture = await continuationFixture({
    row: { executionPath: TREE_A, sourcePath: DIR_A, isolation: 'worktree' },
  });
  try {
    await assert.rejects(
      () => placeSession(fixture.deps, { path: TREE_A, continueFromTaskId: fixture.row.taskId }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.continuationUnavailable
        && error.details.reason === 'no recorded worktree identity',
    );
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('a worktree continuation on a harness with no tree registry is refused', async () => {
  const fixture = await continuationFixture({
    row: { executionPath: TREE_A, sourcePath: DIR_A, isolation: 'worktree', worktreeId: 'task-parent' },
  });
  try {
    await assert.rejects(
      () => placeSession(fixture.deps, { path: TREE_A, continueFromTaskId: fixture.row.taskId }),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.continuationUnavailable
        && error.details.reason === 'no worktree registry',
    );
  } finally {
    await fixture.store.dispose();
    await cleanup(fixture.dir);
  }
});

test('two worktree ids name one tree only when they match', () => {
  assert.equal(sameWorktreeId('task-a', 'task-a'), true);
  assert.equal(sameWorktreeId('task-a', 'task-b'), false);
  assert.equal(sameWorktreeId(null, 'task-a'), false);
  if (process.platform === 'win32') assert.equal(sameWorktreeId('TASK-A', 'task-a'), true);
});

// --- Ownership and disposal --------------------------------------------------

test('a resolved Agent is owned by its Session, so it carries no dispose', async () => {
  const deps = controllers();
  const placement = await placeSession(deps, { path: DIR_A });
  // Placement never hands out a handle that could end the conversation: the runner
  // decides disposal, and for a resolved Agent it never disposes.
  assert.equal(placement.agent.dispose, undefined, 'a resolved Agent must not expose a dispose to its run');
});

test('placement creates exactly one Session per new submission', async () => {
  for (const isolation of ISOLATION_MODES) {
    const deps = controllers();
    const placement = await placeSession(deps, { path: DIR_A, isolation });
    assert.equal(deps.sessionController.creates.length, 1, `one submission in ${isolation} mode creates one Session`);
    assert.equal(placement.sessionId, 'session-1');
    assert.equal(deps.sessionController.resolves.length, 1, 'and resolves exactly one Agent for it');
  }
});

// --- Durable identity map ----------------------------------------------------

test('the identity map is keyed by task and stores only the continuation facts', async () => {
  const dir = await makeTempDir();
  try {
    const store = new SessionStore(dir);
    await rememberSession(store, { workspaceId: 'ws-1', sessionId: 'session-a' }, identityRow({ taskId: 'task-a' }));
    await rememberSession(store, { workspaceId: 'ws-1', sessionId: 'session-b' }, identityRow({ taskId: 'task-b' }));
    // Two tasks in ONE directory: the map must hold both, which a directory key
    // could not.
    const first = await store.get('task-a');
    const second = await store.get('task-b');
    assert.equal(first.sessionId, 'session-a');
    assert.equal(second.sessionId, 'session-b');
    assert.equal(first.executionPath, DIR_A);
    assert.deepEqual(Object.keys(first).sort(), [...RECORD_FIELDS].sort());
    // Re-recording one task replaces only its own row.
    await rememberSession(store, { workspaceId: 'ws-1', sessionId: 'session-a2' }, identityRow({ taskId: 'task-a' }));
    assert.equal((await store.get('task-a')).sessionId, 'session-a2');
    assert.equal((await store.get('task-b')).sessionId, 'session-b');
    assert.equal((await store.list()).length, 2);

    // Nothing content-bearing reaches the file: no prompt, no output, no token.
    const raw = await readFile(join(dir, 'sessions.json'), 'utf8');
    for (const forbidden of ['prompt', 'transcript', 'output', 'apiKey', 'token', 'text']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} must not be stored`);
    }
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('the identity map refuses a row that names no task or no session', async () => {
  const dir = await makeTempDir();
  try {
    const store = new SessionStore(dir);
    await assert.rejects(() => store.put({ taskId: '', sessionId: 'session-a', executionPath: DIR_A }), TypeError);
    await assert.rejects(() => store.put({ taskId: 'task-a', sessionId: '', executionPath: DIR_A }), TypeError);
    await assert.rejects(() => store.put(null), TypeError);
    await assert.rejects(() => store.put({ path: DIR_A, sessionId: 'session-a' }), TypeError, 'a directory is not a task');
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('a legacy directory-keyed row is ignored, so it can never be an implicit reuse', async () => {
  const dir = await makeTempDir();
  try {
    // What the previous build wrote: one row per directory, no task id.
    const legacy = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      sessions: [{ path: DIR_A, workspaceId: 'ws-1', sessionId: 'session-legacy', updatedAt: Date.now() }],
    };
    await writeFile(join(dir, 'sessions.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
    const store = new SessionStore(dir);
    assert.deepEqual(await store.list(), [], 'a row with no task identity is not a usable continuation parent');
    assert.equal(await store.get('session-legacy'), null);
    assert.equal(migrateSessionRow(legacy.sessions[0]), null);

    // A schema-2 row (or a hand-written row that names its task) is usable.
    const current = { taskId: 'task-a', executionPath: DIR_A, sessionId: 'session-a' };
    await store.put(current);
    assert.equal((await store.get('task-a')).sessionId, 'session-a');
    const written = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'));
    assert.equal(written.schemaVersion, 2, 'the document is rewritten at the current schema');
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('a corrupt identity map is reported and treated as empty, rather than crashing', async () => {
  const dir = await makeTempDir();
  try {
    const warnings = [];
    await writeFile(join(dir, 'sessions.json'), '{ not json', 'utf8');
    const store = new SessionStore(dir, { logger: { warn: (...args) => warnings.push(args.join(' ')) } });
    assert.deepEqual(await store.list(), []);
    assert.equal(warnings.some((line) => /not valid JSON/.test(line)), true, 'the corruption is reported');
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('rememberSession tolerates a missing store or placement, and needs both ids', async () => {
  assert.equal(await rememberSession(null, { sessionId: 'x' }, identityRow()), false);
  assert.equal(await rememberSession(undefined, { sessionId: 'x' }, identityRow()), false);
  assert.equal(await rememberSession({ put: async () => ({}) }, null, identityRow()), false);
  assert.equal(await rememberSession({ put: async () => ({}) }, { sessionId: '' }, identityRow()), false);
  // A row that names no task or no path is not written half-way.
  assert.equal(await rememberSession({ put: async () => ({}) }, { sessionId: 'x' }, { executionPath: DIR_A }), false);
  assert.equal(await rememberSession({ put: async () => ({}) }, { sessionId: 'x' }, { taskId: 'task-a' }), false);
});
