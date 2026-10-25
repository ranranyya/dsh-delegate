// Session placement: which DSH Workspace a delegated run appears in, and which
// native Session it drives inside that Workspace.
//
// Two independent questions, answered by two explicit native APIs and never by a
// guess:
//
//   * **Workspace.** A run must be accounted to a real DSH Workspace keyed by the
//     directory it actually executes in (`task.executionPath`) — the worktree when
//     isolation prepared one, the source checkout when it did not. Without that, a
//     delegated Session belongs to no Workspace and shows up in DSH's
//     Unpartitioned group, which is exactly what an operator cannot navigate.
//     `ctx.workspaceController.create({ path })` creates or reuses that Workspace
//     and returns `{ workspace, created }`.
//
//   * **Session.** `ctx.sessionController.create({ workspaceId })` creates a new
//     Session in that Workspace. With the operator's opt-in `reuse` mode, the
//     previously recorded Session for the *same canonical path* is resumed
//     instead, through `ctx.sessionController.resolveAgent(sessionId)`.
//
// Dependencies are named by the service they are, never by convenience:
// `deps.workspaces` is `ctx.workspaceController` and `deps.sessionController` is
// `ctx.sessionController`. `deps.sessions` is the native `ctx.sessions`
// persistence service (used for `flush`, not for planning a Session) and this
// module never reads it.
//
// Both controllers are optional native services. Their absence, or a resume that
// can no longer reach the recorded Session, is a stated refusal
// ({@link SESSION_CODES}) — never a silent fall back to an ungrouped session. A
// run either lands in its Workspace or it does not run.
//
// What survives a run is deliberately minimal: `{ path, workspaceId, sessionId,
// updatedAt }` per directory, in `sessions.json` beside the settings document.
// No prompt, no transcript, no model output, no credential and no token count is
// written here. The native session log stays the single owner of conversation
// content, so this map cannot leak anything it did not receive.

import { readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CONVERSATION_MODES, SESSIONS_FILE } from '../config/defaults.js';
import { diagnostic } from '../config/redact.js';

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
  // Reuse was requested, a Session was recorded for this path, and the native
  // controller could not resume it.
  resumeFailed: 'SESSION_RESUME_FAILED',
  // Reuse was requested and the controller that would resume cannot.
  resumeUnavailable: 'SESSION_RESUME_UNAVAILABLE',
  // A recorded Session was resolved but its own header says another directory.
  // Recording is keyed by canonical path, so this is impossible unless the file
  // was hand-edited; refusing keeps "reuse never crosses directories" true.
  resumePathMismatch: 'SESSION_RESUME_PATH_MISMATCH',
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
 * one directory therefore address one conversation, and two different
 * directories never do.
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
 * has no `create`/`resolveAgent` at all. Reading it here would either report the
 * session controller as missing on a harness that composes both, or accept a
 * non-planner object and fail later with an opaque error.
 *
 * Both values are resolved HERE, at the start of every placement, not when the
 * dependency object was built. The production wiring therefore hands in a
 * {@link liveControllerAccessor} instead of a snapshot: a harness that composes a
 * controller after the plugin activated (or replaces it) is observed on the next
 * run, which is what makes the two services a runtime capability rather than a
 * fact frozen at load. A plain object is still accepted unchanged, which is how the
 * tests and older callers describe the controllers.
 * @param {object} deps - dependency object with optional `workspaces` and `sessionController`.
 * @returns {{ workspaces: object | null, sessions: object | null }} the available controllers.
 */
function controllersOf(deps) {
  const workspaces = controllerOf(deps?.workspaces);
  const sessions = controllerOf(deps?.sessionController);
  return {
    // `create` is the capability `ensureWorkspace`/`createWorkspaceSession` need;
    // nothing is placed through a service that cannot create.
    workspaces: typeof workspaces?.create === 'function' ? workspaces : null,
    sessions: typeof sessions?.create === 'function' ? sessions : null,
  };
}

/**
 * The runtime-resolved accessor for one native controller.
 *
 * The problem this solves is a load-order one: a DSH harness may compose
 * `workspaceController` / `sessionController` *after* this plugin activated, or
 * replace one later in the same process. A dependency object that captured
 * `ctx.get(name, false)` once during `apply` fixes the answer at load, so every
 * later run sees `null` and fails closed with `SESSION_*_UNAVAILABLE` on a harness
 * that actually composes both.
 *
 * This accessor is deliberately live on both axes:
 *
 *  * `create` is a getter, so a placement performed *now* reads whatever the
 *    harness exposes *now*;
 *  * the accessor never caches or freezes the service, so a controller that
 *    appears, is replaced, or disappears is observed per placement, never once.
 *
 * Synchronous by design: {@link controllersOf} resolves both controllers in one
 * tick, at the start of `placeSession`, and a placement therefore cannot act on a
 * Workspace from one generation of the service and a Session from another.
 *
 * The accessor exposes the whole service's *shape*, not only `create`: a placement
 * also needs `resolveAgent` (to attach the Agent of the Session it just created),
 * so narrowing to `create` would report a composed harness as unable to resolve
 * and refuse every run with `SESSION_RESUME_UNAVAILABLE`.
 * @param {() => unknown} resolve - reads the current service; may throw or answer null.
 * @param {object} [options] - `onError(error)`: called with a read refusal, which is
 *   reported as an absent controller (the placement then returns its stated
 *   `SESSION_*_UNAVAILABLE` code). A failed read must never crash a run.
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
 * Resolve the native Workspace a delegated run belongs to.
 *
 * `workspaceController.create({ path })` creates the Workspace for an existing
 * directory or returns the one that already owns it (`created: false`), which is
 * the behaviour this feature needs: repeated runs in one directory share one
 * group instead of accumulating duplicates.
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
 * Resolve the conversation mode a run must use.
 *
 * Only the two documented values are executable. Anything else — including a
 * document an operator hand-edited — is refused rather than treated as the
 * default, because the two modes differ in whether the run continues somebody
 * else's conversation.
 * @param {unknown} mode - candidate mode.
 * @returns {string} one of {@link CONVERSATION_MODES}.
 * @throws {SessionPlacementError} for an unsupported mode.
 */
export function conversationModeOf(mode) {
  if (mode === undefined || mode === null) return CONVERSATION_MODES[0];
  if (typeof mode === 'string' && CONVERSATION_MODES.includes(mode)) return mode;
  throw new SessionPlacementError(SESSION_CODES.sessionCreateFailed, 'the conversation mode is not supported', {
    supported: [...CONVERSATION_MODES],
    requestedType: typeof mode,
  });
}

/**
 * Create or resume the DSH Session one run drives.
 *
 * Order of decisions, and why:
 *
 *  1. capability checks first — no Session is created before it is known that the
 *     run can be driven at all, so a refusal never leaves a Session behind;
 *  2. `new` mode (the default) always creates a fresh Session in the Workspace,
 *     then RESOLVES it to a live Agent. Resolving is what attaches the native
 *     Agent to the Session that was just created; a Session id alone names a
 *     conversation the runner could not drive, and creating an Agent separately
 *     would produce a second Session beside the placed one;
 *  3. `reuse` mode resumes the recorded Session **only** when the recorded path is
 *     the same canonical directory as this run's execution path. A different
 *     directory is not a fallback case: it is a separate conversation, so a new
 *     Session is created there instead of reaching across;
 *  4. a resume that cannot be performed is a refusal. Silently creating a new
 *     Session instead would report a continuing conversation that the operator
 *     is not actually in.
 *
 * Both modes therefore return a live `agent`, and neither ever creates a second
 * Session or Agent for the same run.
 * @param {object} deps - dependency object with `workspaces`, `sessionController`, `sessionStore`.
 * @param {object} request - `path` (the actual execution directory), `mode`, `presetId`.
 * @returns {Promise<object>} placement fact: Workspace, Session, Agent, mode and reuse outcome.
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
  const mode = conversationModeOf(request?.mode);

  const workspace = await ensureWorkspace(workspaces, execPath);

  if (mode === 'reuse') {
    const recorded = await readRecordedSession(deps?.sessionStore, execPath);
    if (recorded !== null) {
      const resumed = await resumeRecordedSession({ sessions, workspace, recorded, execPath, presetId: request?.presetId });
      return {
        mode,
        reused: true,
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.path,
        workspaceCreated: workspace.created,
        sessionId: resumed.sessionId,
        sessionCreated: false,
        agent: resumed.agent,
      };
    }
  }

  const sessionId = await createWorkspaceSession(sessions, workspace.workspaceId, request?.presetId);
  // A freshly created Session is joined to its Agent by resolving it, through the
  // same call `reuse` uses. Nothing else attaches an Agent to a Session that the
  // caller did not create through `agents.create`, and `agents.create` cannot be
  // used here: it would create a SECOND Session under the id it is handed.
  const created = await attachWorkspaceAgent({ sessions, workspace, sessionId, execPath });
  return {
    mode,
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
 * Resume the Session recorded for one directory.
 *
 * Two guards, both needed:
 *
 *  * the recorded path must equal this run's execution path — the caller already
 *    compared them, and this re-checks against `recorded.path` so a hand-edited
 *    map cannot widen the scope of a resume;
 *  * the resolved Agent's own session header must name that same directory, which
 *    is what the Workspace membership rule is built on. A mismatch is refused
 *    rather than repaired.
 * @param {object} request - `sessions`, `workspace`, `recorded`, `execPath`, `presetId`.
 * @returns {Promise<{ sessionId: string, agent: object }>} the live Agent and its id.
 */
async function resumeRecordedSession({ sessions, workspace, recorded, execPath, presetId }) {
  if (!sameSessionPath(recorded.path, execPath)) {
    throw new SessionPlacementError(
      SESSION_CODES.resumePathMismatch,
      'the recorded session belongs to a different execution directory, so it was not resumed',
      { recordedPath: typeof recorded.path === 'string' ? recorded.path : null, executionPath: execPath },
    );
  }
  if (typeof sessions.resolveAgent !== 'function') {
    throw new SessionPlacementError(
      SESSION_CODES.resumeUnavailable,
      'this DSH build cannot resolve an existing session, so conversation reuse is unavailable',
      { reason: 'sessionController.resolveAgent is missing' },
    );
  }
  return await attachWorkspaceAgent({
    sessions,
    workspace,
    sessionId: recorded.sessionId,
    execPath,
    presetId,
  });
}

/**
 * Resolve one existing Session to the live, drivable Agent this run will drive.
 *
 * `sessionController.resolveAgent(sessionId)` is the only documented way to reach
 * the Agent of a Session the caller did not create through `agents.create`; it
 * returns `{ agent }` or `{ error: { code } }`. The same call serves both
 * conversation modes, which is deliberate:
 *
 *  * in `reuse` mode it continues the recorded conversation;
 *  * in `new` mode it attaches the Agent to the Session that was just created in
 *    the Workspace, instead of creating a second one.
 *
 * Nothing here creates a Session or an Agent; a Session that was created but whose
 * Agent cannot be resolved is refused, and the caller records that refusal. The
 * alternative — driving an Agent that is not attached to the placed Session —
 * would report a Workspace grouping the run did not actually have.
 * @param {object} request - `sessions`, `workspace`, `sessionId`, `execPath`, `presetId`.
 * @returns {Promise<{ sessionId: string, agent: object }>} the live Agent and its id.
 * @throws {SessionPlacementError} when no drivable Agent can be resolved.
 */
async function attachWorkspaceAgent({ sessions, workspace, sessionId, execPath, presetId }) {
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
    throw resumeFailure(workspace, error);
  }
  if (found === null || typeof found !== 'object' || found.error !== undefined) {
    throw resumeFailure(workspace, found?.error ?? { message: 'no agent was returned' });
  }
  const agent = found.agent ?? null;
  if (agent === null || typeof agent !== 'object' || typeof agent.whenIdle !== 'function'
    || typeof agent.followup !== 'function') {
    throw new SessionPlacementError(
      SESSION_CODES.resumeFailed,
      'the resolved session did not yield a drivable agent, so the run was not started',
      { code: 'SESSION_NOT_DRIVABLE' },
    );
  }
  const headerCwd = agent.session?.header?.cwd ?? null;
  if (typeof headerCwd === 'string' && headerCwd !== '' && !sameSessionPath(headerCwd, execPath)) {
    throw new SessionPlacementError(
      SESSION_CODES.resumePathMismatch,
      'the resolved session runs in another directory, so it was refused',
      { sessionPath: headerCwd, executionPath: execPath },
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
 * @returns {SessionPlacementError} refusal.
 */
function resumeFailure(workspace, error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const message = code === 'session/not-found'
    ? 'the DSH session recorded for this directory no longer exists, so it was not resumed'
    : 'the DSH session recorded for this directory could not be resumed';
  return new SessionPlacementError(SESSION_CODES.resumeFailed, message, {
    cause: code,
    detail: diagnostic(error?.message ?? error, 200),
    workspaceId: workspace.workspaceId,
  });
}

/**
 * Read the Session recorded for one directory, or `null`.
 *
 * A missing store (the engine was constructed without one) is "nothing
 * recorded", while a *failing* store is also `null` here: the map is an
 * optimization for resuming, never an authority, and a corrupt file must not stop
 * the default mode from running. The caller decides what a `null` means, and in
 * `reuse` mode it means "start this conversation now".
 * @param {object | null | undefined} store - a {@link SessionStore} or null.
 * @param {string} execPath - execution directory.
 * @returns {Promise<object | null>} the record, or null.
 */
async function readRecordedSession(store, execPath) {
  if (store === null || store === undefined || typeof store.get !== 'function') return null;
  try {
    const record = await store.get(execPath);
    return record === null || typeof record !== 'object' ? null : record;
  } catch {
    return null;
  }
}

/**
 * Durable, minimal session-identity map: canonical execution path -> DSH ids.
 *
 * Writes are serialized and land through a temporary sibling plus rename, so a
 * concurrent save cannot lose an earlier one and a crash leaves either the old or
 * the new complete document. Reads are cached after the first successful load.
 * The document stores nothing but `{ schemaVersion, sessions: [{ path,
 * workspaceId, sessionId, updatedAt }] }` — no prompt, transcript, output,
 * credential or usage figure has a field here.
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
   * Look up the Session recorded for one directory.
   * @param {string} path - execution directory, in any spelling.
   * @returns {Promise<object | null>} detached record, or null.
   */
  async get(path) {
    const key = sessionPathKey(path);
    if (key === null) return null;
    const found = (await this.ensureLoaded()).find((record) => sessionPathKey(record.path) === key);
    return found === undefined ? null : { ...found };
  }

  /**
   * Record the Session a run drove for one directory, replacing any earlier one.
   * @param {object} entry - `path`, `workspaceId`, `sessionId`.
   * @returns {Promise<object>} the stored record.
   * @throws {TypeError} for an entry that is not a usable identity.
   */
  async put(entry) {
    if (this.disposed) throw new Error('the session map has been disposed');
    const record = projectSessionRecord(entry);
    const run = this.enqueue(async () => {
      const base = await this.ensureLoaded();
      const key = sessionPathKey(record.path);
      const next = base.filter((item) => sessionPathKey(item.path) !== key);
      next.push(record);
      await this.writeDocument(next);
      this.records = next;
      return { ...record };
    });
    return await run;
  }

  /**
   * Forget the Session recorded for one directory.
   * @param {string} path - execution directory.
   * @returns {Promise<boolean>} whether a record was removed.
   */
  async forget(path) {
    if (this.disposed) throw new Error('the session map has been disposed');
    const key = sessionPathKey(path);
    if (key === null) return false;
    const run = this.enqueue(async () => {
      const base = await this.ensureLoaded();
      const next = base.filter((item) => sessionPathKey(item.path) !== key);
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
   * is a convenience for resuming and never an authority over a run.
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
      try {
        records.push(projectSessionRecord(entry));
      } catch {
        // One unusable row is dropped, never guessed at: the identity it would
        // carry is what a resume would act on.
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
      schemaVersion: 1,
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
 * Project one stored row onto the exact field set this module owns.
 * @param {unknown} value - candidate row.
 * @returns {{ path: string, workspaceId: string, sessionId: string, updatedAt: number }} bounded record.
 * @throws {TypeError} when the row is not a usable identity.
 */
function projectSessionRecord(value) {
  if (value === null || typeof value !== 'object') throw new TypeError('a session map row must be an object');
  const path = typeof value.path === 'string' ? value.path.trim() : '';
  const workspaceId = typeof value.workspaceId === 'string' ? value.workspaceId.trim() : '';
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
  if (path === '') throw new TypeError('a session map row needs a path');
  if (sessionId === '') throw new TypeError('a session map row needs a sessionId');
  return {
    // The path is stored as given (not case-folded) so it stays readable; lookup
    // compares canonical keys, so spelling still cannot create a second entry.
    path,
    workspaceId,
    sessionId,
    updatedAt: Number.isFinite(value.updatedAt) ? Math.trunc(value.updatedAt) : Date.now(),
  };
}

/**
 * Record the placement a run actually achieved.
 *
 * Only the three identity fields and a timestamp are written; nothing the model
 * produced and nothing the harness used to authenticate reaches this call.
 * @param {object | null | undefined} store - a {@link SessionStore} or null.
 * @param {object} placement - value returned by {@link placeSession}.
 * @param {string} execPath - the directory the run executed in.
 * @returns {Promise<boolean>} whether a record was written.
 */
export async function rememberSession(store, placement, execPath) {
  if (store === null || store === undefined || typeof store.put !== 'function') return false;
  if (placement === null || typeof placement !== 'object') return false;
  const sessionId = typeof placement.sessionId === 'string' ? placement.sessionId : '';
  if (sessionId === '') return false;
  await store.put({
    path: execPath,
    workspaceId: typeof placement.workspaceId === 'string' ? placement.workspaceId : '',
    sessionId,
  });
  return true;
}

export { CONVERSATION_MODES };
