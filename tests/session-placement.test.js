// Session placement: which DSH Workspace a delegated run appears in, which
// conversation it drives, and what happens when the harness cannot answer.
//
// The properties under test are the ones an operator can observe:
//
//  * every worker run lands in a real Workspace keyed by its ACTUAL execution
//    directory (`task.executionPath` — the worktree when one was prepared, the
//    source checkout when it was not);
//  * the default mode starts a NEW conversation per task, and `reuse` continues
//    the recorded one ONLY for the same canonical directory;
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

import {
  SESSION_CODES,
  SessionPlacementError,
  SessionStore,
  conversationModeOf,
  ensureWorkspace,
  placeSession,
  rememberSession,
  sameSessionPath,
  sessionPathKey,
} from '../src/runtime/session-placement.js';
import { CONVERSATION_MODES } from '../src/config/defaults.js';
import {
  cleanup,
  fakeSessionController,
  fakeWorkspaceController,
  makeTempDir,
} from './helpers/fakes.js';

const DIR_A = process.platform === 'win32' ? 'C:\\work\\alpha' : '/work/alpha';
const DIR_B = process.platform === 'win32' ? 'C:\\work\\beta' : '/work/beta';

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
    { path: DIR_A, mode: 'new' },
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
    () => placeSession({ workspaces, sessions: sessionsService }, { path: DIR_A, mode: 'new' }),
    (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.sessionsUnavailable,
  );
});

test('a missing Workspace controller is refused before any Session exists', async () => {
  const sessionController = fakeSessionController();
  await assert.rejects(
    () => placeSession({ workspaces: null, sessionController }, { path: DIR_A, mode: 'new' }),
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

// --- Mode vocabulary ---------------------------------------------------------

test('only the documented conversation modes are executable, and the default is new', () => {
  assert.equal(conversationModeOf(undefined), 'new');
  assert.equal(conversationModeOf(null), 'new');
  assert.equal(CONVERSATION_MODES[0], 'new', 'new is the safe default');
  for (const mode of CONVERSATION_MODES) assert.equal(conversationModeOf(mode), mode);
  for (const bogus of ['resume', 'continue', 'NEW', '', 42, {}]) {
    assert.throws(
      () => conversationModeOf(bogus),
      (error) => error instanceof SessionPlacementError
        && error.code === SESSION_CODES.sessionCreateFailed
        && /not supported/.test(error.message),
      `mode ${String(bogus)} must be refused rather than defaulted`,
    );
  }
});

// --- New mode ----------------------------------------------------------------

test('new mode creates one Session and resolves its Agent, creating nothing twice', async () => {
  const deps = controllers();
  const placement = await placeSession(deps, { path: DIR_A, mode: 'new' });

  assert.equal(placement.mode, 'new');
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

test('new mode leaves the agent composition to the Session, mounting nothing extra', async () => {
  const deps = controllers();
  const placement = await placeSession(deps, { path: DIR_A, mode: 'new' });
  // The Agent arrives from the controller with its own context; placement never
  // fabricates one, and never asks for a second preset mount.
  assert.equal(typeof placement.agent.ctx?.on, 'function', 'the resolved Agent must be observable');
});

test('the preset id is forwarded to the Session creation, not to a second create', async () => {
  const deps = controllers();
  await placeSession(deps, { path: DIR_A, mode: 'new', presetId: 'deployment-default' });
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
    () => placeSession({ workspaces, sessionController }, { path: DIR_A, mode: 'new' }),
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
    () => placeSession({ workspaces, sessionController: bare }, { path: DIR_A, mode: 'new' }),
    (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.resumeUnavailable,
  );
});

// --- Reuse mode --------------------------------------------------------------

/**
 * A store holding one recorded session for one directory.
 * @param {string} path - recorded directory.
 * @param {string} sessionId - recorded session.
 * @returns {object} minimal store with `get`/`put`.
 */
function storeWith(path, sessionId) {
  return {
    async get() { return { path, workspaceId: 'ws-1', sessionId, updatedAt: Date.now() }; },
    async put() { throw new Error('a placement test must not write'); },
  };
}

test('reuse mode continues the recorded conversation for the same directory', async () => {
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  // The conversation the previous run recorded: it must already exist.
  sessionController.sessions.set('session-recorded', {
    sessionId: 'session-recorded',
    workspaceId: 'ws-1',
    cwd: DIR_A,
    disposed: false,
  });
  const deps = { workspaces, sessionController, sessionStore: storeWith(DIR_A, 'session-recorded') };

  const placement = await placeSession(deps, { path: DIR_A, mode: 'reuse' });

  assert.equal(placement.reused, true);
  assert.equal(placement.sessionId, 'session-recorded', 'the recorded conversation must be the one continued');
  assert.equal(placement.sessionCreated, false);
  assert.equal(sessionController.creates.length, 0, 'reuse must not create a new Session');
  assert.deepEqual(sessionController.resolves, ['session-recorded']);
  assert.equal(placement.agent.id, 'session-recorded');
});

test('a reused conversation is the SAME agent across runs', async () => {
  // What "continuing a conversation" means concretely: the second run drives the
  // Agent the first run drove, so the native log carries both turns.
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces, respond: { text: 'turn' } });
  sessionController.sessions.set('session-kept', {
    sessionId: 'session-kept',
    workspaceId: 'ws-1',
    cwd: DIR_A,
    disposed: false,
  });
  const deps = { workspaces, sessionController, sessionStore: storeWith(DIR_A, 'session-kept') };

  const first = await placeSession(deps, { path: DIR_A, mode: 'reuse' });
  const second = await placeSession(deps, { path: DIR_A, mode: 'reuse' });
  assert.equal(first.agent, second.agent, 'a reused conversation must be one Agent, not two');
});

test('reuse never crosses into a different execution directory', async () => {
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  sessionController.sessions.set('session-a', {
    sessionId: 'session-a',
    workspaceId: 'ws-1',
    cwd: DIR_A,
    disposed: false,
  });
  // A store that reports another directory's record: the run refuses rather than
  // resuming across directories OR quietly pretending it continued one. The two
  // acceptable outcomes are "refused" and "a genuinely new conversation here";
  // reaching across is never one of them.
  const deps = { workspaces, sessionController, sessionStore: storeWith(DIR_B, 'session-a') };

  await assert.rejects(
    () => placeSession(deps, { path: DIR_A, mode: 'reuse' }),
    (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.resumePathMismatch,
  );
  assert.equal(sessionController.resolves.includes('session-a'), false, 'another directory\'s conversation must not be resumed');
  assert.equal(sessionController.creates.length, 0, 'and no replacement Session may be invented either');
});

test('the recorded session path is re-checked against the run, and a mismatch is refused', async () => {
  // Defence in depth: even if a store hands back a record whose path differs from
  // the one that was looked up, `resumeRecordedSession` compares it again rather
  // than trusting the lookup.
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  sessionController.sessions.set('session-other', {
    sessionId: 'session-other',
    workspaceId: 'ws-1',
    cwd: DIR_A,
    disposed: false,
  });
  // The store answers a record for the OTHER directory when asked for this one.
  const deps = {
    workspaces,
    sessionController,
    sessionStore: { async get() { return { path: DIR_B, sessionId: 'session-other' }; } },
  };

  await assert.rejects(
    () => placeSession(deps, { path: DIR_A, mode: 'reuse' }),
    (error) => error instanceof SessionPlacementError
      && error.code === SESSION_CODES.resumePathMismatch
      && error.details.executionPath === DIR_A,
  );
  assert.equal(sessionController.resolves.length, 0, 'no Agent may be resolved for a mismatched record');
});

test('an agent whose own session header names another directory is refused', async () => {
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  sessionController.sessions.set('session-wrong-cwd', {
    sessionId: 'session-wrong-cwd',
    workspaceId: 'ws-1',
    cwd: DIR_B,
    disposed: false,
  });
  const deps = { workspaces, sessionController, sessionStore: storeWith(DIR_A, 'session-wrong-cwd') };

  await assert.rejects(
    () => placeSession(deps, { path: DIR_A, mode: 'reuse' }),
    (error) => error instanceof SessionPlacementError && error.code === SESSION_CODES.resumePathMismatch,
  );
});

test('a recorded session that no longer exists is refused, not silently replaced', async () => {
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  // Nothing in `sessions`: the controller answers `session/not-found`, as the
  // real one does for a Session that was deleted.
  const deps = { workspaces, sessionController, sessionStore: storeWith(DIR_A, 'session-gone') };

  await assert.rejects(
    () => placeSession(deps, { path: DIR_A, mode: 'reuse' }),
    (error) => error instanceof SessionPlacementError
      && error.code === SESSION_CODES.resumeFailed
      && error.details.cause === 'session/not-found'
      && /no longer exists/.test(error.message),
  );
  assert.equal(sessionController.creates.length, 0, 'a failed resume must not create a replacement Session');
});

test('reuse with nothing recorded starts a new conversation in that directory', async () => {
  const deps = controllers();
  const placement = await placeSession(deps, { path: DIR_A, mode: 'reuse' });
  assert.equal(placement.reused, false, 'nothing was recorded, so there is nothing to continue');
  assert.equal(placement.sessionCreated, true);
  assert.equal(deps.sessionController.creates.length, 1);
});

test('a falling store does not stop the default mode from running', async () => {
  const workspaces = fakeWorkspaceController();
  const deps = {
    ...controllers({ workspaces }),
    sessionStore: { async get() { throw new Error('the map is corrupt'); } },
  };
  const placement = await placeSession(deps, { path: DIR_A, mode: 'reuse' });
  assert.equal(placement.reused, false);
  assert.equal(placement.sessionCreated, true);
});

test('reuse needs resolveAgent and says so when the build cannot resume', async () => {
  const workspaces = fakeWorkspaceController();
  const bare = {
    sessions: new Map(),
    async create() { return { sessionId: 'session-x' }; },
  };
  await assert.rejects(
    () => placeSession(
      { workspaces, sessionController: bare, sessionStore: storeWith(DIR_A, 'session-x') },
      { path: DIR_A, mode: 'reuse' },
    ),
    (error) => error instanceof SessionPlacementError
      && error.code === SESSION_CODES.resumeUnavailable
      && error.details.reason === 'sessionController.resolveAgent is missing',
  );
});

// --- Ownership and disposal --------------------------------------------------

test('a resolved Agent is owned by its Session, so it carries no dispose', async () => {
  const deps = controllers();
  const placement = await placeSession(deps, { path: DIR_A, mode: 'new' });
  // Placement never hands out a handle that could end the conversation: the
  // runner decides disposal, and for a resolved Agent it never disposes.
  assert.equal(placement.agent.dispose, undefined, 'a resolved Agent must not expose a dispose to its run');
});

test('placement creates exactly one Session per run, in both modes', async () => {
  for (const mode of CONVERSATION_MODES) {
    const deps = controllers();
    const placement = await placeSession(deps, { path: DIR_A, mode });
    assert.equal(
      deps.sessionController.creates.length,
      mode === 'new' ? 1 : 1,
      `mode ${mode} must create exactly one Session when nothing is recorded`,
    );
    assert.equal(placement.sessionId, `session-${deps.sessionController.creates.length}`);
    assert.equal(deps.sessionController.resolves.length, 1, 'and resolve exactly one Agent for it');
  }
});

// --- Durable identity map ----------------------------------------------------

test('the session map stores identities only, and never crosses directories', async () => {
  const dir = await makeTempDir();
  try {
    const store = new SessionStore(dir);
    await rememberSession(store, { workspaceId: 'ws-1', sessionId: 'session-a' }, DIR_A);
    await rememberSession(store, { workspaceId: 'ws-2', sessionId: 'session-b' }, DIR_B);

    assert.deepEqual(Object.keys(await store.get(DIR_A)).sort(), ['path', 'sessionId', 'updatedAt', 'workspaceId']);
    assert.equal((await store.get(DIR_A)).sessionId, 'session-a');
    assert.equal((await store.get(DIR_B)).sessionId, 'session-b');
    // A second record for one directory replaces the first: "the latest
    // conversation for this directory" is the only claim `reuse` makes.
    await rememberSession(store, { workspaceId: 'ws-1', sessionId: 'session-a2' }, DIR_A);
    assert.equal((await store.get(DIR_A)).sessionId, 'session-a2');
    assert.equal((await store.list()).length, 2);
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('the session map refuses a row with no session identity', async () => {
  const dir = await makeTempDir();
  try {
    const store = new SessionStore(dir);
    await assert.rejects(() => store.put({ path: DIR_A, sessionId: '' }), TypeError);
    await assert.rejects(() => store.put({ path: '', sessionId: 'session-a' }), TypeError);
    await assert.rejects(() => store.put(null), TypeError);
    await store.dispose();
  } finally {
    await cleanup(dir);
  }
});

test('rememberSession tolerates a missing store or placement', async () => {
  assert.equal(await rememberSession(null, { sessionId: 'x' }, DIR_A), false);
  assert.equal(await rememberSession(undefined, { sessionId: 'x' }, DIR_A), false);
  assert.equal(await rememberSession({ put: async () => ({}) }, null, DIR_A), false);
  assert.equal(await rememberSession({ put: async () => ({}) }, { sessionId: '' }, DIR_A), false);
});
