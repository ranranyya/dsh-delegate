// Session placement: which DSH Workspace a delegated run appears in, and which
// native Session it drives inside that Workspace.
//
// There is exactly ONE placement policy, and it is per task, not per directory:
//
//   * **A new submission is a new conversation.** Every ordinary dispatch creates a
//     fresh DSH Session in the Workspace for its execution directory. Nothing an
//     earlier task did in the same directory can make a new submission continue
//     somebody else's conversation — there is no directory-level mode to read, and
//     a settings document that still stores the legacy `conversation.mode: "reuse"`
//     is accepted as input but is incapable of causing an implicit reuse
//     ({@link LEGACY_CONVERSATION_MODE}).
//
//   * **A follow-up continues one named task thread.** `continueFromTaskId` names
//     the previous task explicitly, and only that identity is continued: the same
//     Workspace, the same Session. This is why the durable map below is keyed by
//     *task id* rather than by directory — one directory may hold many independent
//     conversations, and only the operator's explicit choice can join them.
//
// Two questions, answered by two explicit native APIs and never by a guess:
//
//   * **Workspace.** A run must be accounted to a real DSH Workspace keyed by the
//     directory it actually executes in (`task.executionPath`) — the worktree when
//     isolation prepared one, the source checkout when it did not.
//     `ctx.workspaceController.create({ path })` creates or reuses that Workspace
//     and returns `{ workspace, created }`.
//
//   * **Session.** `ctx.sessionController.create({ workspaceId })` creates a new
//     Session in that Workspace; `ctx.sessionController.resolveAgent(sessionId)`
//     returns the live Agent of an existing one, which is what a follow-up drives.
//
// Dependencies are named by the service they are: `deps.workspaces` is
// `ctx.workspaceController` and `deps.sessionController` is `ctx.sessionController`.
// `deps.sessions` is the native `ctx.sessions` persistence service (used for
// `flush`, not for planning a Session) and this module never reads it.
//
// Both controllers are optional native services. Their absence, or a continuation
// whose recorded thread can no longer be reached, is a stated refusal
// ({@link SESSION_CODES}) — never a silent fall back to a new, ungrouped session.
//
// What survives a run is deliberately minimal: `{ taskId, sourcePath,
// executionPath, workspaceId, sessionId, isolation, worktreeId, worktreeState,
// updatedAt }` per task, in `sessions.json` beside the settings document. No
// prompt, no transcript, no model output, no credential and no token count is
// written here. The native session log stays the single owner of conversation
// content, so this map cannot leak anything it did not receive.

import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ISOLATION_MODES, SESSIONS_FILE } from '../config/defaults.js';
import { diagnostic } from '../config/redact.js';

/** Stable ids of a managed worktree life cycle, mirrored as a plain string set here. */
const WORKTREE_STATE_DISPOSED = 'disposed';

/** Fields one stored row may carry. Anything else is dropped on the way in. */
const RECORD_FIELDS = Object.freeze([
  'taskId',
  'sourcePath',
  'executionPath',
  'workspaceId',
  'sessionId',
  'isolation',
  'worktreeId',
  'worktreeState',
  'updatedAt',
]);

/** Session-placement refusal codes. Each one means the run did not start. */
export const SESSION_CODES = Object.freeze({
  // The native workspaces service is not composed into this harness.
  workspacesUnavailable: 'SESSION_WORKSPACES_UNAVAILABLE',
  // The native session controller is not composed into this harness.
  sessionsUnavailable: 'SESSION_CONTROLLER_UNAVAILABLE',
  // `workspaceController.create` existed but refused or reported nothing usable.
  workspaceRefused: 'SESSION_WORKSPACE_REFUSED',
  // `sessionController.create` existed but refused or reported no session.
  sessionCreateFailed: 'SESSION_CREATE_FAILED',
  // A continuation named a task that this data directory has no identity for.
  // Unknown, stale and never-retained parents are the same operator situation:
  // there is nothing to continue, and nothing is invented in its place.
  continuationUnknown: 'SESSION_CONTINUATION_UNKNOWN',
  // The named parent exists but is not in a state a thread can be continued from
  // (still running, or ended without ever driving a conversation).
  continuationState: 'SESSION_CONTINUATION_STATE',
  // The persisted identity cannot be used to reach a session: no session id, or a
  // worktree identity that is gone or refused.
  continuationUnavailable: 'SESSION_CONTINUATION_UNAVAILABLE',
  // The named parent ran somewhere else than this submission's execution
  // directory. A task chain never crosses directories.
  continuationPathMismatch: 'SESSION_CONTINUATION_PATH_MISMATCH',
  // The recorded Workspace belongs to another source repository.
  continuationWorkspaceMismatch: 'SESSION_CONTINUATION_WORKSPACE_MISMATCH',
  // Continuation was requested and the controller cannot resolve a session at all.
  resumeUnavailable: 'SESSION_RESUME_UNAVAILABLE',
  // The session exists but could not be resolved to a drivable Agent.
  resumeFailed: 'SESSION_RESUME_FAILED',
  // A resolved session's own header names another directory.
  resumePathMismatch: 'SESSION_RESUME_PATH_MISMATCH',
  // The session recorded for the named task no longer exists.
  sessionNotFound: 'SESSION_NOT_FOUND',
});

/**
 * The conversation mode a stored settings document may still carry.
 *
 * It is accepted so an upgraded document keeps loading, and it is recorded on the
 * legacy boundary only. It has no effect: a new submission is always new, and a
 * follow-up is always the thread named by `continueFromTaskId`. Nothing in this
 * module reads it, which is the property that makes the legacy value incapable of
 * causing an implicit reuse.
 */
export const LEGACY_CONVERSATION_MODE = 'reuse';

/** Placement outcomes, as reported to an operator. */
export const PLACEMENT_KINDS = Object.freeze({
  // A fresh DSH Session was created for this run.
  new: 'new',
  // An earlier task's Session was continued.
  continuation: 'continuation',
});

/** Refusal raised by {@link placeSession}. */
export class SessionPlacementError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - operator-readable explanation.
   * @param {object} [details] - bounded, non-secret context.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SessionPlacementError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Canonical form of one directory, as an identity key.
 *
 * The identity of a Workspace is a path string the harness canonicalized once, so
 * this mirrors that spelling and folds case on Windows (NTFS is
 * case-insensitive), exactly as the project-override keys do. Two spellings of
 * one directory therefore address one directory, and two different directories
 * never do.
 * @param {unknown} value - candidate directory path.
 * @returns {string | null} canonical key, or `null` when it is not a path.
 */
export function sessionPathKey(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const stripped = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') : trimmed;
  return process.platform === 'win32' ? stripped.toLowerCase() : stripped;
}

/**
 * Whether a recorded path is the same canonical path as a current one.
 * @param {unknown} a - first path.
 * @param {unknown} b - second path.
 * @returns {boolean} true when both name one directory.
 */
export function sameSessionPath(a, b) {
  const left = sessionPathKey(a);
  const right = sessionPathKey(b);
  return left !== null && right !== null && left === right;
}

/**
 * Narrow a dependency object to the two native controllers.
 *
 * Both are read here, once per placement, so every caller sees the same capability
 * decision and a missing service is one refusal code instead of a property read
 * that happens to throw.
 *
 * The two names are not interchangeable and this function is the only place that
 * answers the question, so the mapping is stated once:
 *
 *  * `deps.workspaces` — `ctx.workspaceController`;
 *  * `deps.sessionController` — `ctx.sessionController`, the service that owns
 *    `create`/`resolveAgent`. This is the planner of Sessions.
 *
 * `deps.sessions` is deliberately NOT consulted: that is the native
 * `ctx.sessions` persistence service (the one the runner calls `flush` on), and it
 * has no `create`/`resolveAgent` at all.
 * @param {object} deps - dependency object with optional `workspaces` and `sessionController`.
 * @returns {{ workspaces: object | null, sessions: object | null, worktrees: object | null }} the available services.
 */
function controllersOf(deps) {
  const workspaces = controllerOf(deps?.workspaces);
  const sessions = controllerOf(deps?.sessionController);
  const worktrees = controllerOf(deps?.worktrees);
  return {
    // `create` is the capability `ensureWorkspace`/`createWorkspaceSession` need;
    // nothing is placed through a service that cannot create.
    workspaces: typeof workspaces?.create === 'function' ? workspaces : null,
    sessions: typeof sessions?.create === 'function' ? sessions : null,
    // The worktree registry is optional: it exists only to prove that a
    // continuation runs in the tree its parent actually used.
    worktrees: typeof worktrees?.get === 'function' ? worktrees : null,
  };
}

/**
 * The runtime-resolved accessor for one native controller.
 *
 * A DSH harness may compose `workspaceController` / `sessionController` *after*
 * this plugin activated, or replace one later in the same process. A dependency
 * object that captured `ctx.get(name, false)` once during `apply` fixes the answer
 * at load, so every later run would see `null`. This accessor is deliberately live
 * on both axes: `create` is a getter, and the service is never cached, so what a
 * placement sees is what the harness exposes right now.
 * @param {() => unknown} resolve - reads the current service; may throw or answer null.
 * @param {object} [options] - `onError(error)`: called with a read refusal, which is
 *   reported as an absent controller.
 * @returns {{ readonly current: object | null }} accessor; `null` means absent.
 */
export function liveControllerAccessor(resolve, options = {}) {
  const onError = typeof options?.onError === 'function' ? options.onError : null;
  return {
    /**
     * The service as it is NOW, or null when the harness does not expose it.
     * @returns {object | null} live service.
     */
    get current() {
      try {
        const service = resolve();
        return service === undefined || service === null ? null : service;
      } catch (error) {
        // An unreadable service is an absent service for placement purposes: the
        // caller then refuses with `SESSION_*_UNAVAILABLE` instead of surfacing a
        // property-access error as an execution failure.
        onError?.(error);
        return null;
      }
    },
    get create() {
      const service = this.current;
      const method = service?.create;
      // Bound to the LIVE service, so a caller reading `create` calls through the
      // service this instant rather than through an object it saw before.
      return typeof method === 'function' ? method.bind(service) : null;
    },
  };
}

/**
 * Read one controller off a dependency value, following an accessor when it is one.
 * @param {unknown} value - a controller, an accessor, or nothing.
 * @returns {object | null} the service as it is now, or null.
 */
function controllerOf(value) {
  if (value === undefined || value === null) return null;
  // An accessor is the only dependency value that carries a live `current`
  // member; the services themselves never do.
  if (typeof value === 'object' && 'current' in value) {
    const live = value.current;
    return live === null || live === undefined ? null : live;
  }
  return value;
}

/**
 * Normalize a requested continuation identity, or `null` when none was asked for.
 *
 * An absent, blank or non-string value means "this is a new submission". A blank
 * string is deliberately treated as absent rather than as a refusal: it is what an
 * MCP client sends for "no value", and refusing it would turn "start a new
 * conversation" into an error.
 * @param {unknown} value - caller-supplied `continueFromTaskId`.
 * @returns {string | null} the task id to continue, or null.
 */
export function continuationOf(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the native Workspace a delegated run belongs to.
 *
 * `workspaceController.create({ path })` creates the Workspace for an existing
 * directory or returns the one that already owns it (`created: false`).
 * @param {object} workspaces - the native Workspace controller.
 * @param {string} path - the directory the run executes in.
 * @returns {Promise<{ workspaceId: string, path: string, created: boolean }>} the Workspace fact.
 * @throws {SessionPlacementError} when the controller refuses or reports nothing usable.
 */
export async function ensureWorkspace(workspaces, path) {
  let value;
  try {
    value = await workspaces.create({ path });
  } catch (error) {
    throw new SessionPlacementError(
      SESSION_CODES.workspaceRefused,
      'DSH refused to group this run into a Workspace for its execution directory',
      { cause: typeof error?.code === 'string' ? error.code : null, detail: diagnostic(error?.message ?? error, 200) },
    );
  }
  const workspace = value?.workspace ?? null;
  const workspaceId = workspace?.workspaceId ?? null;
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    // Fail closed: a run without a Workspace is the unpartitioned state this
    // feature exists to remove, so an unusable answer may not become a session.
    throw new SessionPlacementError(
      SESSION_CODES.workspaceRefused,
      'the Workspace controller returned no Workspace identity for this directory',
      { returned: value === null || typeof value !== 'object' ? typeof value : 'object without workspace.workspaceId' },
    );
  }
  return {
    workspaceId,
    path: typeof workspace.path === 'string' && workspace.path !== '' ? workspace.path : path,
    created: value?.created === true,
  };
}

/**
 * Place one run: a new Session, or the explicit continuation of one task thread.
 *
 * The decision is made here and only here, from two facts the caller supplies:
 *
 *  1. **capability checks first** — no Session is created and no Agent resolved
 *     before it is known that the run can be driven at all, so a refusal never
 *     leaves a Session behind;
 *  2. **`continueFromTaskId` omitted** — a fresh Session is created in the
 *     Workspace for this run's execution directory, then resolved to a live Agent.
 *     Nothing is read from the identity map: a new submission is new even when the
 *     same directory has a long history, which is the property the removed
 *     directory-level `reuse` setting used to violate;
 *  3. **`continueFromTaskId` supplied** — the recorded identity of *that task* is
 *     loaded and every fact a thread continuation depends on is re-checked
 *     ({@link validateContinuation}). A continuation that cannot be honoured is a
 *     refusal; it is never quietly replaced by the new-Session path, because that
 *     would report a continued conversation the operator is not actually in.
 *
 * Both paths return a live `agent`, and neither creates a Session or an Agent
 * twice.
 * @param {object} deps - dependency object with `workspaces`, `sessionController`,
 *   `sessionStore`, optional `worktrees`, and the task/connection facts a
 *   continuation must match (`taskId`, `connectionId`, `sourcePath`).
 * @param {object} request - `path` (the actual execution directory), `presetId`,
 *   and optional `continueFromTaskId`.
 * @returns {Promise<object>} placement fact: kind, Workspace, Session, Agent and
 *   the continuation facts.
 * @throws {SessionPlacementError} when the run cannot be placed.
 */
export async function placeSession(deps, request) {
  const { workspaces, sessions } = controllersOf(deps);
  if (workspaces === null) {
    throw new SessionPlacementError(
      SESSION_CODES.workspacesUnavailable,
      'the DSH Workspace controller is unavailable, so this run could not be grouped into a Workspace',
      {},
    );
  }
  if (sessions === null) {
    throw new SessionPlacementError(
      SESSION_CODES.sessionsUnavailable,
      'the DSH session controller is unavailable, so no Workspace-scoped session could be created',
      {},
    );
  }
  const path = sessionPathKey(request?.path);
  if (path === null) {
    throw new SessionPlacementError(SESSION_CODES.sessionCreateFailed, 'no execution directory was resolved for this run', {});
  }
  const execPath = request.path;
  const continueFromTaskId = continuationOf(request?.continueFromTaskId);

  const workspace = await ensureWorkspace(workspaces, execPath);

  if (continueFromTaskId !== null) {
    const parent = await loadContinuation(deps, continueFromTaskId);
    const resumed = await continueTaskThread({
      deps,
      sessions,
      workspace,
      parent,
      execPath,
      presetId: request?.presetId,
    });
    return {
      kind: PLACEMENT_KINDS.continuation,
      continuedFromTaskId: continueFromTaskId,
      reused: true,
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.path,
      workspaceCreated: workspace.created,
      sessionId: resumed.sessionId,
      sessionCreated: false,
      agent: resumed.agent,
    };
  }

  const sessionId = await createWorkspaceSession(sessions, workspace.workspaceId, request?.presetId);
  // A freshly created Session is joined to its Agent by resolving it, through the
  // same call a continuation uses. Nothing else attaches an Agent to a Session
  // that the caller did not create through `agents.create`, and `agents.create`
  // cannot be used here: it would create a SECOND Session under the id it is handed.
  const created = await attachWorkspaceAgent({ sessions, workspace, sessionId, execPath });
  return {
    kind: PLACEMENT_KINDS.new,
    continuedFromTaskId: null,
    reused: false,
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.path,
    workspaceCreated: workspace.created,
    sessionId: created.sessionId,
    sessionCreated: true,
    agent: created.agent,
  };
}

/**
 * Create one new Session inside a Workspace.
 *
 * `workspaceId` is passed instead of `cwd` on purpose: the native controller
 * derives the Session's directory from the Workspace, which is the same canonical
 * path membership is validated against. Passing both is refused by the controller.
 * @param {object} sessions - the native session controller.
 * @param {string} workspaceId - Workspace identity.
 * @param {string | undefined} presetId - agent preset the Session must own, if any.
 * @returns {Promise<string>} the created Session's id.
 * @throws {SessionPlacementError} when the controller refuses or reports none.
 */
async function createWorkspaceSession(sessions, workspaceId, presetId) {
  let value;
  try {
    value = await sessions.create({
      workspaceId,
      ...(typeof presetId === 'string' && presetId !== '' ? { agentPreset: presetId } : {}),
    });
  } catch (error) {
    throw new SessionPlacementError(
      SESSION_CODES.sessionCreateFailed,
      'DSH could not create a session in the Workspace for this run',
      { cause: typeof error?.code === 'string' ? error.code : null, detail: diagnostic(error?.message ?? error, 200) },
    );
  }
  const sessionId = value?.sessionId ?? null;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new SessionPlacementError(
      SESSION_CODES.sessionCreateFailed,
      'the session controller returned no session identity for this run',
      {},
    );
  }
  return sessionId;
}

/**
 * Read the persisted identity of one parent task, or refuse.
 *
 * Unknown, stale, pruned and never-recorded parents are one refusal code
 * (`SESSION_CONTINUATION_UNKNOWN`) because they are one operator situation: the
 * named thread does not exist here, so there is nothing to continue. A continuation
 * is never widened to "some other task in this directory".
 * @param {object} deps - dependency object.
 * @param {string} taskId - the task id the caller named.
 * @returns {Promise<object>} the stored identity.
 * @throws {SessionPlacementError} when no identity exists for that task.
 */
async function loadContinuation(deps, taskId) {
  const store = deps?.sessionStore ?? null;
  // A task this process still holds is judged by the engine's own record, which is
  // strictly more informative than the persisted row: liveness, connection
  // ownership and "did it ever drive a conversation" are all live facts there. The
  // engine reports the refusal itself and returns here only when the parent is not
  // one of its own, so this check cannot hide an unknown id.
  if (typeof deps?.assertAdmissible === 'function') {
    deps.assertAdmissible(taskId);
  }
  if (store === null || store === undefined || typeof store.get !== 'function') {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'this deployment keeps no task-to-conversation identity, so the named task cannot be continued',
      { continueFromTaskId: taskId, reason: 'no session identity store' },
    );
  }
  let record;
  try {
    record = await store.get(taskId);
  } catch (error) {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'the stored task-to-conversation identity could not be read, so the named task cannot be continued',
      { continueFromTaskId: taskId, detail: diagnostic(error?.message ?? error, 200) },
    );
  }
  if (record === null || record === undefined || typeof record !== 'object') {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnknown,
      'no conversation is recorded for the named task, so it cannot be continued',
      {
        continueFromTaskId: taskId,
        reason: 'unknown, pruned or started by another deployment',
        hint: 'omit continueFromTaskId to start a new task conversation',
      },
    );
  }
  return record;
}

/**
 * Validate one continuation and resolve the parent thread's live Agent.
 *
 * Every guard below is a *refusal*, never a repair, because each of them names a
 * case in which continuing would silently join the wrong conversation:
 *
 *  1. the recorded identity must name a session at all;
 *  2. the parent must have run in exactly this run's execution directory — a chain
 *     never crosses directories, and a plugin-managed worktree is a different
 *     directory from its source on purpose;
 *  3. the parent must have run for the same source repository: the recorded
 *     Workspace path must be that repository;
 *  4. a worktree parent must still be a live managed tree whose recorded
 *     `worktreeId` matches, because that tree is where the earlier uncommitted
 *     worker changes are;
 *  5. the native controller must be able to resolve the session, and the resolved
 *     Agent's own header must name the same directory.
 *
 * The ownership facts checked here are the ones that are knowable from the record
 * and the native services. Connection ownership is enforced before placement, where
 * the engine still holds the connection identity: this module never sees one.
 * @param {object} request - `deps`, `sessions`, `workspace`, `parent`, `execPath`, `presetId`.
 * @returns {Promise<{ sessionId: string, agent: object }>} the live Agent of the continued thread.
 * @throws {SessionPlacementError} when the thread cannot be continued.
 */
async function continueTaskThread({ deps, sessions, workspace, parent, execPath, presetId }) {
  const parentTaskId = parent.taskId ?? null;
  const sessionId = typeof parent.sessionId === 'string' ? parent.sessionId.trim() : '';
  if (sessionId === '') {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'the named task drove no conversation, so there is no thread to continue',
      { continueFromTaskId: parentTaskId, reason: 'no recorded session' },
    );
  }
  const recordedExec = parent.executionPath ?? parent.path ?? null;
  if (!sameSessionPath(recordedExec, execPath)) {
    throw new SessionPlacementError(
      SESSION_CODES.continuationPathMismatch,
      'the named task ran in another execution directory, so its conversation was not continued',
      {
        continueFromTaskId: parentTaskId,
        recordedExecutionPath: typeof recordedExec === 'string' ? recordedExec : null,
        executionPath: execPath,
        hint: 'a follow-up must run where its task ran; a plugin-managed worktree is its own directory',
      },
    );
  }

  const isolation = parent.isolation ?? null;
  if (isolation === 'worktree') {
    assertWorktreeContinuable(deps, parent, execPath);
  }

  const recordedSource = parent.sourcePath ?? null;
  const currentSource = deps?.sourcePath ?? null;
  if (typeof recordedSource === 'string' && recordedSource !== '' && typeof currentSource === 'string' && currentSource !== ''
    && !sameSessionPath(recordedSource, currentSource)) {
    throw new SessionPlacementError(
      SESSION_CODES.continuationWorkspaceMismatch,
      'the named task was authorized for another source repository, so its conversation was not continued',
      {
        continueFromTaskId: parentTaskId,
        reason: 'different source repository',
      },
    );
  }
  if (typeof parent.workspaceId === 'string' && parent.workspaceId !== ''
    && parent.workspaceId !== workspace.workspaceId) {
    // The Workspace is keyed by the execution directory: reaching a Workspace from
    // another directory would be a cross-directory continuation by another name.
    throw new SessionPlacementError(
      SESSION_CODES.continuationWorkspaceMismatch,
      'the named task belongs to another DSH Workspace, so its conversation was not continued',
      {
        continueFromTaskId: parentTaskId,
        reason: 'different workspace',
      },
    );
  }

  const resolved = await resumeExistingSession({ sessions, workspace, sessionId, execPath, presetId, parentTaskId });
  return resolved;
}

/**
 * Prove that a worktree parent is still the tree this continuation must reuse.
 *
 * The follow-up has to run in the tree the parent executed in, because that is
 * where the parent's uncommitted changes are. Creating a fresh tree would start
 * from a clean commit and silently hide them, so a tree that is gone, disposed, or
 * no longer the one the record names is a refusal.
 * @param {object} deps - dependency object with the optional `worktrees` registry.
 * @param {object} parent - recorded identity of the parent task.
 * @param {string} execPath - the execution directory this continuation resolved.
 * @returns {void}
 * @throws {SessionPlacementError} when the tree cannot be reused.
 */
function assertWorktreeContinuable(deps, parent, execPath) {
  const taskId = parent.taskId ?? null;
  const worktreeId = typeof parent.worktreeId === 'string' ? parent.worktreeId.trim() : '';
  if (worktreeId === '') {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'the named task ran in an isolated tree whose identity was not recorded, so it cannot be reused safely',
      { continueFromTaskId: taskId, reason: 'no recorded worktree identity' },
    );
  }
  if (parent.worktreeState === WORKTREE_STATE_DISPOSED) {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'the isolated tree the named task ran in has been removed, so the thread cannot be continued',
      { continueFromTaskId: taskId, reason: 'worktree disposed' },
    );
  }
  const registry = deps?.worktrees ?? null;
  if (registry === null || registry === undefined || typeof registry.get !== 'function') {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'this harness cannot report its managed trees, so the named task\'s tree cannot be proven reusable',
      { continueFromTaskId: taskId, reason: 'no worktree registry' },
    );
  }
  let tree;
  try {
    tree = registry.get(execPath);
  } catch (error) {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'this harness refused to report the named task\'s tree, so the thread cannot be continued',
      { continueFromTaskId: taskId, detail: diagnostic(error?.message ?? error, 200) },
    );
  }
  if (tree === null || tree === undefined || typeof tree !== 'object') {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'no managed tree exists at the named task\'s execution path, so the thread cannot be continued',
      { continueFromTaskId: taskId, reason: 'tree not managed here' },
    );
  }
  if (tree.state === WORKTREE_STATE_DISPOSED) {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'the isolated tree the named task ran in has been removed, so the thread cannot be continued',
      { continueFromTaskId: taskId, reason: 'worktree disposed' },
    );
  }
  const foundId = typeof tree.worktreeId === 'string' && tree.worktreeId !== '' ? tree.worktreeId : (tree.taskId ?? null);
  if (typeof foundId === 'string' && foundId !== '' && !sameWorktreeId(foundId, worktreeId)) {
    throw new SessionPlacementError(
      SESSION_CODES.continuationUnavailable,
      'the tree at the named task\'s execution path belongs to another run, so it was not reused',
      { continueFromTaskId: taskId, reason: 'worktree identity mismatch' },
    );
  }
}

/**
 * Whether two worktree identities name one tree.
 *
 * The registry historically exposes the tree's own `taskId` (the id of the task
 * that prepared it) and a `worktreeId` in newer views, so both spellings are
 * compared the way a path is compared: exactly, then case-folded on Windows.
 * @param {string} a - first identity.
 * @param {string} b - second identity.
 * @returns {boolean} true when both name one tree.
 */
export function sameWorktreeId(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a === b) return true;
  return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Resolve an existing Session to the live, drivable Agent a continuation drives.
 *
 * `sessionController.resolveAgent(sessionId)` is the only documented way to reach
 * the Agent of a Session the caller did not create through `agents.create`, and
 * driving the resolved Agent (rather than its logged header) is what makes the
 * turn land in the SAME native session log.
 * @param {object} request - `sessions`, `workspace`, `sessionId`, `execPath`, `presetId`, `parentTaskId`.
 * @returns {Promise<{ sessionId: string, agent: object }>} the live Agent and its id.
 * @throws {SessionPlacementError} when no drivable Agent can be resolved.
 */
async function resumeExistingSession({ sessions, workspace, sessionId, execPath, presetId, parentTaskId }) {
  if (typeof sessions.resolveAgent !== 'function') {
    throw new SessionPlacementError(
      SESSION_CODES.resumeUnavailable,
      'this DSH build cannot resolve an existing session, so the follow-up cannot be continued',
      { reason: 'sessionController.resolveAgent is missing', continueFromTaskId: parentTaskId ?? null },
    );
  }
  return await attachWorkspaceAgent({
    sessions,
    workspace,
    sessionId,
    execPath,
    presetId,
    parentTaskId,
    failureCode: SESSION_CODES.resumeFailed,
  });
}

/**
 * Resolve one existing Session to the live Agent this run will drive.
 *
 * The same call serves both paths, which is deliberate:
 *
 *  * for a continuation it continues the recorded conversation;
 *  * for a new submission it attaches the Agent to the Session that was just
 *    created in the Workspace, instead of creating a second one.
 *
 * Nothing here creates a Session or an Agent; a Session that was created but whose
 * Agent cannot be resolved is refused. The alternative — driving an Agent that is
 * not attached to the placed Session — would report a Workspace grouping the run
 * did not actually have.
 * @param {object} request - `sessions`, `workspace`, `sessionId`, `execPath`, `presetId`,
 *   optional `parentTaskId`, optional `failureCode`.
 * @returns {Promise<{ sessionId: string, agent: object }>} the live Agent and its id.
 * @throws {SessionPlacementError} when no drivable Agent can be resolved.
 */
async function attachWorkspaceAgent({ sessions, workspace, sessionId, execPath, presetId, parentTaskId = null, failureCode = null }) {
  if (typeof sessions.resolveAgent !== 'function') {
    throw new SessionPlacementError(
      SESSION_CODES.resumeUnavailable,
      'this DSH build cannot resolve a session to a drivable agent, so the run was not started',
      { reason: 'sessionController.resolveAgent is missing', presetId: presetId ?? null },
    );
  }
  let found;
  try {
    found = await sessions.resolveAgent(sessionId);
  } catch (error) {
    throw resumeFailure(workspace, error, parentTaskId, failureCode);
  }
  if (found === null || typeof found !== 'object' || found.error !== undefined) {
    throw resumeFailure(workspace, found?.error ?? { message: 'no agent was returned' }, parentTaskId, failureCode);
  }
  const agent = found.agent ?? null;
  if (agent === null || typeof agent !== 'object' || typeof agent.whenIdle !== 'function'
    || typeof agent.followup !== 'function') {
    throw new SessionPlacementError(
      failureCode ?? SESSION_CODES.resumeFailed,
      'the resolved session did not yield a drivable agent, so the run was not started',
      { code: 'SESSION_NOT_DRIVABLE', continueFromTaskId: parentTaskId },
    );
  }
  const headerCwd = agent.session?.header?.cwd ?? null;
  if (typeof headerCwd === 'string' && headerCwd !== '' && !sameSessionPath(headerCwd, execPath)) {
    throw new SessionPlacementError(
      SESSION_CODES.resumePathMismatch,
      'the resolved session runs in another directory, so it was refused',
      { sessionPath: headerCwd, executionPath: execPath, continueFromTaskId: parentTaskId },
    );
  }
  return { sessionId: agent.session?.id ?? sessionId, agent };
}

/**
 * Shape one resume failure into the bounded refusal the engine reports.
 *
 * The native codes an operator can act on are preserved (`session/not-found`,
 * `session/writer-held`), and the recorded identity is dropped from the
 * diagnostic, which also keeps the report free of a resumable handle.
 * @param {object} workspace - Workspace fact.
 * @param {unknown} error - whatever the controller answered with.
 * @param {string | null} parentTaskId - the task whose thread was being continued.
 * @param {string | null} failureCode - the placement code to report.
 * @returns {SessionPlacementError} refusal.
 */
function resumeFailure(workspace, error, parentTaskId = null, failureCode = null) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const message = code === 'session/not-found'
    ? 'the DSH session recorded for the named task no longer exists, so it was not continued'
    : 'the DSH session recorded for the named task could not be resumed';
  return new SessionPlacementError(failureCode ?? SESSION_CODES.resumeFailed, message, {
    cause: code,
    detail: diagnostic(error?.message ?? error, 200),
    workspaceId: workspace.workspaceId,
    continueFromTaskId: parentTaskId,
  });
}

/**
 * Durable, minimal task-thread identity map: task id -> DSH ids and paths.
 *
 * The map is keyed by TASK, not by directory, because a directory may hold many
 * independent conversations and only an explicit `continueFromTaskId` may join
 * them. One row holds {@link RECORD_FIELDS} and nothing else: a follow-up needs
 * exactly the identity of the thread it continues, the two paths a continuation is
 * validated against, and the safe ownership facts about a managed tree.
 *
 * Writes are serialized and land through a temporary sibling plus rename, so a
 * concurrent save cannot lose an earlier one and a crash leaves either the old or
 * the new complete document. Reads are cached after the first successful load.
 */
export class SessionStore {
  /**
   * @param {string} dataDir - plugin data directory.
   * @param {object} [options] - `fs` seam (`readFile`, `writeFile`, `rename`,
   *   `mkdir`, `rm`) and `logger`.
   */
  constructor(dataDir, options = {}) {
    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
      throw new TypeError('SessionStore needs a data directory');
    }
    this.dir = dataDir;
    this.path = join(dataDir, SESSIONS_FILE);
    this.fs = options.fs ?? { readFile, writeFile, rename, mkdir, rm };
    this.logger = options.logger ?? null;
    this.records = null;
    this.loading = null;
    this.queue = Promise.resolve();
    this.disposed = false;
  }

  /**
   * Read the map, newest first.
   * @returns {Promise<object[]>} detached records.
   */
  async list() {
    return (await this.ensureLoaded()).map((record) => ({ ...record }));
  }

  /**
   * Look up the thread recorded for one task.
   *
   * A legacy row (from a build that keyed the map by directory) is reachable by its
   * task id only when it carries one; a directory-keyed row never answers a task
   * lookup, which is what keeps the migrated rows incapable of an implicit reuse.
   * @param {string} taskId - task id.
   * @returns {Promise<object | null>} detached record, or null.
   */
  async get(taskId) {
    const key = typeof taskId === 'string' ? taskId.trim() : '';
    if (key === '') return null;
    const found = (await this.ensureLoaded()).find((record) => record.taskId === key);
    return found === undefined ? null : { ...found };
  }

  /**
   * Record the thread one task drove, replacing any earlier row for that task.
   * @param {object} entry - `taskId`, `sourcePath`, `executionPath`, `workspaceId`,
   *   `sessionId`, optional `isolation`, `worktreeId`, `worktreeState`.
   * @returns {Promise<object>} the stored record.
   * @throws {TypeError} for an entry that is not a usable identity.
   */
  async put(entry) {
    if (this.disposed) throw new Error('the session map has been disposed');
    const record = projectSessionRecord(entry);
    const run = this.enqueue(async () => {
      const base = await this.ensureLoaded();
      const next = base.filter((item) => item.taskId !== record.taskId);
      next.push(record);
      await this.writeDocument(next);
      this.records = next;
      return { ...record };
    });
    return await run;
  }

  /**
   * Forget the thread recorded for one task.
   * @param {string} taskId - task id.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  async forget(taskId) {
    if (this.disposed) throw new Error('the session map has been disposed');
    const key = typeof taskId === 'string' ? taskId.trim() : '';
    if (key === '') return false;
    const run = this.enqueue(async () => {
      const base = await this.ensureLoaded();
      const next = base.filter((item) => item.taskId !== key);
      if (next.length === base.length) return false;
      await this.writeDocument(next);
      this.records = next;
      return true;
    });
    return await run;
  }

  /**
   * Wait for queued writes and stop accepting new ones.
   * @returns {Promise<void>} resolves when settled.
   */
  async dispose() {
    if (this.disposed) return;
    await this.queue;
    this.disposed = true;
  }

  /**
   * Run one mutation after every earlier one.
   * @param {() => Promise<object>} work - queued mutation.
   * @returns {Promise<object>} its result.
   */
  enqueue(work) {
    const run = this.queue.then(work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Load once, sharing the physical read between concurrent callers.
   * @returns {Promise<object[]>} records, in document order.
   */
  async ensureLoaded() {
    if (this.records !== null) return this.records;
    if (this.loading === null) {
      this.loading = this.readOnce().finally(() => { this.loading = null; });
    }
    return await this.loading;
  }

  /**
   * Read and normalize the document. A missing file is an empty map; an
   * unreadable or malformed one is reported and treated as empty, because this map
   * is an index for continuing a thread and never an authority over a run.
   * @returns {Promise<object[]>} usable records.
   */
  async readOnce() {
    let raw;
    try {
      raw = await this.fs.readFile(this.path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.records = [];
        return this.records;
      }
      this.logger?.warn?.('dsh-delegate: the session map could not be read', diagnostic(error?.message ?? error, 200));
      this.records = [];
      return this.records;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger?.warn?.('dsh-delegate: the session map is not valid JSON; starting from an empty map (the file was left as found)');
      this.records = [];
      return this.records;
    }
    const stored = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const records = [];
    for (const entry of stored) {
      const migrated = migrateSessionRow(entry);
      if (migrated === null) {
        // A row that is not a usable task identity (including every directory-keyed
        // row from a build that recorded no task id) is dropped, never guessed at:
        // the identity it would carry is what a continuation would act on.
        if (entry !== null && typeof entry === 'object') {
          this.logger?.warn?.('dsh-delegate: one session map row carried no task identity and was ignored');
        }
        continue;
      }
      try {
        records.push(projectSessionRecord(migrated));
      } catch {
        this.logger?.warn?.('dsh-delegate: one session map row was unusable and was ignored');
      }
    }
    this.records = records;
    return this.records;
  }

  /**
   * Replace the document atomically (temporary sibling, then rename).
   * @param {object[]} records - records to store.
   * @returns {Promise<void>} resolves after the rename.
   */
  async writeDocument(records) {
    const content = `${JSON.stringify({
      schemaVersion: 2,
      updatedAt: new Date().toISOString(),
      sessions: records,
    }, null, 2)}\n`;
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await this.fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await this.fs.writeFile(temp, content, { mode: 0o600 });
      await this.fs.rename(temp, this.path);
    } catch (error) {
      await this.fs.rm?.(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/**
 * Lift one stored row onto the current shape, or refuse it.
 *
 * Two stored generations exist:
 *
 *  * **schema 2** — keyed by task id; this is what this build writes and reads;
 *  * **schema 1** — keyed by canonical execution directory, `{ path, workspaceId,
 *    sessionId, updatedAt }`, written by a build that offered a directory-level
 *    `reuse` mode. It recorded no task id, so it cannot name a task thread and is
 *    therefore *not* usable as a continuation parent. It is ignored on read and
 *    never acts as an implicit source of reuse: the map is keyed by task, and a
 *    legacy row has no task.
 *
 * A row that already carries a task id is accepted from either generation, so a
 * hand-edited or forward-compatible document is read on its own facts.
 * @param {unknown} entry - one stored row.
 * @returns {object | null} a row this build can use, or null.
 */
export function migrateSessionRow(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const taskId = typeof entry.taskId === 'string' ? entry.taskId.trim() : '';
  if (taskId === '') return null;
  return entry;
}

/**
 * Project one stored row onto the exact field set this module owns.
 *
 * Everything omitted here is omitted on purpose: no prompt, no transcript, no model
 * output, no usage figure and no credential has a field, so a continuation can
 * carry conversation identity and never conversation content.
 * @param {unknown} value - candidate row.
 * @returns {object} bounded record.
 * @throws {TypeError} when the row is not a usable identity.
 */
function projectSessionRecord(value) {
  if (value === null || typeof value !== 'object') throw new TypeError('a session map row must be an object');
  const taskId = typeof value.taskId === 'string' ? value.taskId.trim() : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  if (taskId === '') throw new TypeError('a session map row needs a taskId');
  if (sessionId === '') throw new TypeError('a session map row needs a sessionId');
  const executionPath = firstPath(value.executionPath, value.path);
  const sourcePath = firstPath(value.sourcePath, value.executionPath, value.path);
  const isolation = typeof value.isolation === 'string' && ISOLATION_MODES.includes(value.isolation)
    ? value.isolation
    : null;
  return {
    taskId,
    sourcePath,
    executionPath,
    workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId.trim() : '',
    sessionId,
    isolation,
    worktreeId: typeof value.worktreeId === 'string' && value.worktreeId.trim() !== '' ? value.worktreeId.trim() : null,
    worktreeState: typeof value.worktreeState === 'string' && value.worktreeState.trim() !== ''
      ? value.worktreeState.trim()
      : null,
    updatedAt: Number.isFinite(value.updatedAt) ? Math.trunc(value.updatedAt) : Date.now(),
  };
}

/**
 * The first usable absolute-looking path among the candidates, or null.
 * @param {...unknown} candidates - path candidates.
 * @returns {string | null} chosen path.
 */
function firstPath(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

/**
 * Record the thread a run actually drove.
 *
 * Only identity and provenance are written; nothing the model produced and nothing
 * the harness used to authenticate reaches this call.
 * @param {object | null | undefined} store - a {@link SessionStore} or null.
 * @param {object} placement - value returned by {@link placeSession}.
 * @param {object} entry - `taskId`, `sourcePath`, `executionPath`, optional
 *   `isolation`, `worktreeId`, `worktreeState`.
 * @returns {Promise<boolean>} whether a record was written.
 */
export async function rememberSession(store, placement, entry) {
  if (store === null || store === undefined || typeof store.put !== 'function') return false;
  if (placement === null || typeof placement !== 'object') return false;
  const sessionId = typeof placement.sessionId === 'string' ? placement.sessionId : '';
  if (sessionId === '') return false;
  const target = entry ?? {};
  const taskId = typeof target.taskId === 'string' ? target.taskId.trim() : '';
  const executionPath = typeof target.executionPath === 'string' ? target.executionPath.trim() : '';
  // A row without a task and an execution path names nothing a continuation could
  // validate, so it is not written at all rather than half-written.
  if (taskId === '' || executionPath === '') return false;
  await store.put({
    taskId,
    executionPath,
    sourcePath: typeof target.sourcePath === 'string' && target.sourcePath.trim() !== ''
      ? target.sourcePath.trim()
      : executionPath,
    workspaceId: typeof placement.workspaceId === 'string' ? placement.workspaceId : '',
    sessionId,
    isolation: typeof target.isolation === 'string' ? target.isolation : null,
    worktreeId: typeof target.worktreeId === 'string' ? target.worktreeId : null,
    worktreeState: typeof target.worktreeState === 'string' ? target.worktreeState : null,
  });
  return true;
}

export { RECORD_FIELDS };
