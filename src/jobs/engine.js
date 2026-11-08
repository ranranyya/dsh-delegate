// Job engine: the only component that can turn a request into model work.
//
// Authorization order is fixed and every step can refuse:
//   1. the caller presents a connection identity and a grant; the grant is
//      consumed (or, for a session, checked by its exact id) before anything is
//      read from disk;
//   2. an immutable effective configuration snapshot is resolved and validated;
//   3. the concurrency slot is checked, then the source workspace is locked;
//   4. isolation is honoured (a real worktree) or refused — never downgraded;
//   5. the execution workspace is locked, audited and baselined;
//   6. worker and review routes are confirmed and frozen against one provider
//      registry snapshot;
//   7. only then does an agent exist.
//
// A job that completes is NOT accepted. It becomes `awaiting-host-review`, and
// the host decides. Nothing in this module can mark a job approved.
//
// Race discipline. A start is not atomic: it awaits path resolution, settings,
// the provider registry, worktree creation, the audit and routing. Two rules
// apply to every one of those awaits.
//
//  1. They are *guarded*: raced against the task's own abort signal and against
//     its deadline, so a native service that never settles cannot hold a start,
//     its concurrency slot or its leases forever.
//  2. They are followed by `assertLive`, which re-checks three independent
//     facts: the plugin is not disposed, the task's controller is not aborted,
//     and the authorization still covers exactly this task and this source
//     workspace.
//
// The task record (with its controller and its creation sequence) exists before
// the first await and counts towards `maxParallelism` from that moment. The slot
// decision is ordered by that sequence, so two concurrent starts cannot both
// believe they hold the free slot: the older one is admitted, the newer one is
// refused. Any failure releases the slot and the leases, marks a prepared tree
// complete (never deleted), and nothing else: a consumed grant is never restored.
//
// A task can also stop from the outside: the authorization registry's
// invalidation subscription aborts matching pending and running tasks
// immediately, and an internal sweep timer makes expiry effective even when no
// request arrives to trigger a sweep.
//
// Terminal states. Exactly one terminal state is recorded per task, and the first
// one wins: {@link markTerminal} is the only writer, so a late promise, a late
// review result or a second failure can never revive or overwrite a task that has
// already ended. Cancellation is checked before a deadline for the same reason —
// an operator who cancelled did ask to stop, and reporting a timeout instead
// would misattribute the outcome.
//
// Cleanup. Release of a lease, release of the concurrency slot and completion of a
// prepared tree all happen in {@link finalize}, which is idempotent and runs on
// every exit path — successful completion, cancellation, timeout, failure and an
// admission refusal alike. The one thing it refuses to do is release the workspace
// (or the slot) of a task whose native executor has not yet confirmed that it
// stopped: freeing a workspace that is still being mutated would hand it to the
// next job while the previous one is writing. When that happens the leases stay
// held, the slot stays occupied and the refusal is recorded as `cleanupError` on
// the task record, so it is visible rather than silent. The task's settlement
// promise resolves only once finalize has finished, so `cancel()` returning means
// the capacity it described has actually been returned (or the refusal has been
// recorded), not merely that the state was written.

import { randomUUID } from 'node:crypto';
import { defaultSettings, LIMITS } from '../config/defaults.js';
import { redactDeep, redactText } from '../config/redact.js';
import { resolveEffectiveConfig } from '../config/settings.js';
import { AUTH_CODES, AuthError } from '../auth/grants.js';
import { resolveRoute } from '../model/routing.js';
import { PROVIDER_SET_CODES, managedProvidersOf } from '../model/providers.js';
import { RUN_OUTCOMES, RunError, SessionPlacementRefusal, diagnostic, runAgent } from '../runtime/agent-runner.js';
import { PermissionBridge, PermissionError, PERMISSION_CODES } from '../runtime/permissions.js';
import { DELEGATE_SANDBOX_MODE } from '../runtime/sandbox.js';
import { rememberSession, SESSION_CODES } from '../runtime/session-placement.js';
import { REVIEW_STATES, reviewWork } from '../review/reviewer.js';
import { buildReviewPrompt, buildWorkerPrompt } from '../review/prompts.js';
import { captureBaseline, captureDiff } from '../workspace/audit.js';
import { LOCK_CODES, WorkspaceError, resolveWorkspacePath } from '../workspace/locks.js';

/** Task lifecycle states. `awaiting-host-review` is terminal for this plugin. */
export const TASK_STATES = Object.freeze({
  pending: 'pending',
  running: 'running',
  awaitingHostReview: 'awaiting-host-review',
  failed: 'failed',
  cancelled: 'cancelled',
});

/** Terminal states: a task in one of these may not be driven again. */
const TERMINAL = new Set([TASK_STATES.awaitingHostReview, TASK_STATES.failed, TASK_STATES.cancelled]);

/** States that occupy a concurrency slot. */
const LIVE = new Set([TASK_STATES.pending, TASK_STATES.running]);

/** Job-level refusal codes. */
export const JOB_CODES = Object.freeze({
  notAuthorized: 'JOB_NOT_AUTHORIZED',
  taskNotFound: 'JOB_TASK_NOT_FOUND',
  taskTerminal: 'JOB_TASK_TERMINAL',
  promptRequired: 'JOB_PROMPT_REQUIRED',
  promptTooLarge: 'JOB_PROMPT_TOO_LARGE',
  workspaceRequired: 'JOB_WORKSPACE_REQUIRED',
  noProviders: 'JOB_NO_PROVIDERS',
  providerRegistry: 'JOB_PROVIDER_REGISTRY_REQUIRED',
  isolationRefused: 'JOB_ISOLATION_REFUSED',
  auditUnavailable: 'JOB_AUDIT_UNAVAILABLE',
  routingRefused: 'JOB_ROUTING_REFUSED',
  busy: 'JOB_WORKSPACE_BUSY',
  concurrency: 'JOB_CONCURRENCY_LIMIT',
  cancelled: 'JOB_CANCELLED',
  disposed: 'JOB_DISPOSED',
  startFailed: 'JOB_START_FAILED',
  overrideInvalid: 'JOB_OVERRIDE_INVALID',
  internal: 'JOB_INTERNAL',
  timeout: 'JOB_TIMEOUT',
  executionFailed: 'JOB_EXECUTION_FAILED',
  noOutput: 'JOB_NO_OUTPUT',
  // Distinct from `noOutput`: the model was asked and stopped because it ran out
  // of its own output budget. The task may still have produced a change, so the
  // budget is reported instead of being dressed up as a provider error.
  outputTruncated: 'JOB_OUTPUT_TRUNCATED',
  failed: 'JOB_FAILED',
  nativeNotStopped: 'JOB_NATIVE_NOT_STOPPED',
  historyFailed: 'JOB_HISTORY_FAILED',
  // Session placement refused: this harness cannot group the run into a DSH
  // Workspace, or could not create/resume the Workspace's session. A specific
  // `SESSION_*` code is carried in `details.session`.
  conversationUnavailable: 'JOB_CONVERSATION_UNAVAILABLE',
  // A `continueFromTaskId` follow-up was requested and cannot be honoured. Always
  // fail-closed: the run is refused rather than turned into a new conversation the
  // caller did not ask for. `details.session` carries the specific `SESSION_*` code.
  continuationRefused: 'JOB_CONTINUATION_REFUSED',
  // A pending per-call permission request the worker is waiting on. The task is
  // still `running`; the PHASE says it is waiting for the commander's decision.
  // `waitingForPermission` is not a terminal state and is not a failure.
  permissionPending: 'JOB_PERMISSION_PENDING',
});

/** Default interval of the internal authorization sweep. */
const DEFAULT_SWEEP_INTERVAL_MS = 1000;

/**
 * Bound on preflight before the operator's own timeout is known.
 *
 * The worker timeout lives in the settings document, which is read *during*
 * preflight, so the first steps need a bound of their own or a hung native
 * service could hold a slot forever. Once the effective snapshot is resolved the
 * deadline is re-armed from `worker.timeoutSeconds`, measured from task creation,
 * so preflight time is charged to the same budget as the run itself.
 */
const DEFAULT_PREFLIGHT_TIMEOUT_MS = defaultSettings().worker.timeoutSeconds * 1000;

/** Ceiling on the additional review's own time budget. */
const REVIEW_TIMEOUT_CAP_MS = 1800 * 1000;

/** How long cancel/dispose wait for a task to observe its cancellation. */
const SETTLE_TIMEOUT_MS = 5000;

/**
 * Bound on waiting for a native executor to confirm that it stopped.
 *
 * {@link finalize} will not hand back a concurrency slot or a workspace lease
 * while the executor this task started may still be writing, so the wait has to
 * be bounded: an executor that never settles must cost a recorded refusal
 * (`cleanupError`), not a slot retained forever with no evidence. The bound
 * matches the window `cancel()` and `dispose()` use, so a caller that observed
 * either of those already waited at least as long as this gate can take.
 */
const NATIVE_SETTLE_TIMEOUT_MS = SETTLE_TIMEOUT_MS;

/**
 * Bound on one durable history write.
 *
 * The history document is written atomically, but it is still file I/O on a
 * borrowed directory: a wedged filesystem must not keep a terminal task's
 * cleanup (and therefore its workspace lease) pending forever. Exceeding this
 * bound is recorded on the task as `historyError` rather than silently dropped.
 */
const HISTORY_WRITE_TIMEOUT_MS = 5000;

/** Upper bound on retained task records; oldest terminal records go first. */
const MAX_RETAINED_TASKS = 256;

/**
 * The phase a running task reports while a permission request is outstanding.
 *
 * It is a PHASE, not a state, on purpose: the worker is still running and its
 * workspace slot, lock and execution budget are still its own. Reporting a new
 * `waiting` state would have changed every state contract downstream (terminal
 * sets, cancel rules, history rehydration) to describe something that is not a
 * new lifecycle.
 */
const PHASE_AWAITING_PERMISSION = 'awaiting-permission';
const PHASE_EXECUTE = 'execute';

/** Raised for job-level refusals. */
export class JobError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded, redacted details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Task engine. Holds at most a bounded number of live tasks in memory. Terminal
 * records are persisted to an optional `HistoryStore`; nothing is read back to
 * decide anything, so a restart begins with no tasks and no authorization.
 */
export class JobEngine {
  /**
   * @param {object} deps - native services and plugin components:
   *   `agents`, `agentPresets`, `sessions`, `llm`, `settings`, `auth`, `locks`,
   *   `runGit`, optional `ensureRoutes` (the entry point's full-snapshot seam:
   *   `(settings) => Promise<Map<publicId, nativeRoute>>`, which publishes the
   *   adapter snapshot *and* registers the native routes in one transaction),
   *   optional `providerRegistry` (`{ ensure(providers) }`, the route-only
   *   registration used as the fallback seam), optional `worktrees` (a
   *   `WorktreeManager`), optional `history` (a `HistoryStore`), optional
   *   `sweepIntervalMs`, optional `preflightTimeoutMs` (a bound for preflight
   *   steps that run before the worker timeout is known), and
   *   `allowLegacyProviderRoutes` (tests only: use the profile id as the native
   *   route when neither seam is present).
   */
  constructor(deps) {
    this.deps = deps;
    this.settings = deps.settings;
    this.auth = deps.auth;
    this.locks = deps.locks;
    // Durable job history. Optional injection: the engine persists the public
    // view it already computed for a terminal task and never reads history back
    // to decide anything. Startup history belongs to whoever constructs the
    // store, so a restart reports its own `interrupted` records instead of this
    // engine resurrecting tasks it never admitted.
    this.history = deps?.history ?? null;
    this.tasks = new Map();
    this.aborted = false;
    this.sweepTimer = null;
    this.unsubscribe = null;
    this.sequence = 0;
    // The new control plane uses one persisted switch. Legacy grant mode stays
    // available when this is false so existing clients can be upgraded safely.
    this.delegationEnabled = deps?.delegationEnabled === true;
    this.authorizationMode = deps?.authorizationMode === 'switch' ? 'switch' : 'grants';
    const configuredPreflight = Number(deps?.preflightTimeoutMs);
    this.preflightTimeoutMs = Number.isFinite(configuredPreflight) && configuredPreflight > 0
      ? configuredPreflight
      : DEFAULT_PREFLIGHT_TIMEOUT_MS;
    this.listen();
  }

  /**
   * Subscribe to authorization invalidation and start the internal sweep.
   *
   * Two mechanisms, because they answer different questions. The subscription is
   * what makes an operator's revoke an actual cancellation; the timer is what
   * makes an expiry effective when no authenticated request arrives to trigger a
   * sweep. Both are idempotent and both are removed on dispose.
   * @returns {void}
   */
  listen() {
    if (this.unsubscribe === null && typeof this.auth?.subscribe === 'function') {
      try {
        this.unsubscribe = this.auth.subscribe((event) => this.onAuthorizationInvalidated(event));
      } catch {
        // An authorization registry that refuses subscribers leaves the engine
        // with one fewer notification path; the per-phase rechecks still hold.
        this.unsubscribe = null;
      }
    }
    if (this.sweepTimer === null && typeof this.auth?.sweep === 'function') {
      const configured = Number(this.deps?.sweepIntervalMs);
      const interval = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SWEEP_INTERVAL_MS;
      this.sweepTimer = setInterval(() => {
        try {
          this.auth.sweep();
        } catch {
          // A sweep failure must not kill the timer; the next tick retries.
        }
      }, interval);
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Stop the subscription and the sweep timer. Called from {@link dispose}.
   * @returns {void}
   */
  stopListening() {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.unsubscribe !== null) {
      try {
        this.unsubscribe();
      } catch {
        // Unsubscribe is idempotent by contract; a throw is not actionable.
      }
      this.unsubscribe = null;
    }
  }

  /**
   * Report whether delegation may run at all right now.
   * @returns {{ authorized: boolean, reason: string | null }} current posture.
   */
  posture() {
    if (this.aborted) return { authorized: false, reason: 'the plugin has been disposed' };
    if (this.authorizationMode === 'switch') {
      return this.delegationEnabled === true
        ? { authorized: true, reason: null, mode: 'switch' }
        : { authorized: false, reason: 'delegation is disabled', mode: 'switch' };
    }
    if (this.auth.isDelegationAuthorized() !== true) {
      return { authorized: false, reason: 'no live delegation authorization exists' };
    }
    return { authorized: true, reason: null };
  }

  /** Toggle the DSH-side master switch and stop live work when it is disabled. */
  setDelegationEnabled(enabled) {
    const next = enabled === true;
    const changed = this.delegationEnabled !== next;
    this.delegationEnabled = next;
    if (changed && next === false) {
      for (const task of this.tasks.values()) {
        if (!TERMINAL.has(task.state)) this.abortTask(task, 'delegation-disabled');
      }
    }
    return this.posture();
  }

  /**
   * Start one delegated task.
   *
   * The task record (and its controller) is created before the first await, so
   * the request occupies a concurrency slot from the moment it is accepted and a
   * cancellation or revocation can reach it while it is still resolving paths.
   * A preflight deadline is armed at the same moment and cleared on every exit,
   * so a native service that never settles costs a bounded wait instead of a
   * permanent slot.
   *
   * The authorization is consumed before any other side effect, so a failure
   * later in the pipeline still costs the caller its grant. That is deliberate:
   * a grant authorizes one attempt at one task, not a free retry loop. A retry is
   * a new `start` with a new grant; a consumed grant is never restored.
   * @param {object} request - `connectionId`, `grantId`, `workspacePath`, `prompt`, `overrides`,
   *   `authorization` (`'task'` consumes a single-use grant, `'session'` checks the named live session grant),
   *   and optional `continueFromTaskId` (this submission is a follow-up to that named
   *   delegated task and must continue exactly its DSH thread).
   * @returns {Promise<object>} the created task view.
   */
  async start(request) {
    const posture = this.posture();
    if (!posture.authorized) {
      throw new JobError(JOB_CODES.notAuthorized, posture.reason ?? 'delegation is not authorized', {});
    }

    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (prompt === '') throw new JobError(JOB_CODES.promptRequired, 'a task prompt is required', {});
    if (prompt.length > LIMITS.promptChars) {
      throw new JobError(JOB_CODES.promptTooLarge, `the task prompt exceeds ${LIMITS.promptChars} characters`, {
        limit: LIMITS.promptChars,
      });
    }
    // A continuation identity that is not a string is a caller bug, refused here
    // rather than coerced: coercing would either name some other task (`String(42)`)
    // or silently drop the request and start a new conversation.
    const rawContinuation = request?.continueFromTaskId;
    if (rawContinuation !== undefined && rawContinuation !== null && typeof rawContinuation !== 'string') {
      throw new JobError(JOB_CODES.continuationRefused, 'continueFromTaskId must be a task id string', {
        requestedType: typeof rawContinuation,
      });
    }
    const continueFromTaskId = typeof rawContinuation === 'string' ? rawContinuation.trim() : '';

    const authorization = this.authorizationMode === 'switch'
      ? 'switch'
      : (request?.authorization === 'session' ? 'session' : 'task');
    const task = this.createTask(prompt, authorization);
    // Frozen before the first await so the task record states, from the moment it
    // exists, whether it starts a conversation or continues one.
    task.continueFromTaskId = continueFromTaskId === '' ? null : continueFromTaskId;
    this.tasks.set(task.taskId, task);
    this.prune();

    try {
      this.armPreflightDeadline(task, this.preflightTimeoutMs);
      await this.admit(task, request);
    } catch (error) {
      await this.failAdmission(task, error);
      throw this.admissionError(error);
    } finally {
      this.clearPreflightDeadline(task);
    }

    this.drive(task);
    return this.view(task, { includePrompt: true });
  }

  /**
   * Build the pending record. Synchronous on purpose: nothing may await between
   * the caller's request and the existence of a cancellation target.
   * @param {string} prompt - validated prompt text.
   * @param {'task'|'session'} authorization - which grant kind was presented.
   * @returns {object} task record.
   */
  createTask(prompt, authorization) {
    const taskId = `task-${randomUUID()}`;
    let settle;
    const settled = new Promise((resolvePromise) => { settle = resolvePromise; });
    this.sequence += 1;
    return {
      taskId,
      // Admission order. The concurrency slot is decided by this number, not by
      // whichever start happens to finish its awaits first.
      sequence: this.sequence,
      state: TASK_STATES.pending,
      phase: 'created',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      prompt,
      authorization,
      // The task whose DSH thread this submission continues, or null for a new
      // conversation. Frozen at creation: it is what the run does with its session,
      // and it must not be re-read after the first await.
      continueFromTaskId: null,
      connectionId: null,
      grantId: null,
      grantKind: null,
      sourcePath: null,
      executionPath: null,
      effective: null,
      routes: null,
      route: null,
      reviewRoute: null,
      reviewRouteError: null,
      baseline: null,
      worktree: null,
      leases: [],
      // The process-local provider-definition lease this task holds, taken before
      // it awaited the route ensure and given back only by {@link finalize}: it is
      // what keeps the served provider set identical for every native model
      // operation of this task, not only the first one.
      providerLease: null,
      providerLeaseReleased: false,
      // Whether this task currently owns a concurrency slot. Set synchronously
      // during admission and cleared only once the slot may legally be reused.
      slotHeld: false,
      diff: null,
      execution: null,
      // Session placement facts for this task: which DSH Workspace group it ran in,
      // whether it started a new conversation or continued the task it named, and
      // whether the identity was saved so a later follow-up can continue it.
      // `conversationError` is recorded rather than thrown, because failing to save
      // a continuation handle must not change the run's outcome.
      conversation: null,
      conversationSaved: null,
      conversationError: null,
      // A continuation may reuse the parent task's managed worktree. These are
      // admission-only facts; the public task view exposes the resulting
      // execution path and conversation, never the internal parent object.
      continuationParent: null,
      continuationRecord: null,
      // The identity map row, read exactly once, and the single durable snapshot the
      // continuation is judged by. Both are admission-only facts; the public task view
      // exposes the resulting execution path and conversation, never the internals.
      continuationIdentity: null,
      reusedWorktree: false,
      review: { state: REVIEW_STATES.notRun, verdict: null, text: '', error: null },
      error: null,
      cancelRequested: false,
      cancelledBy: null,
      // The preflight deadline: set before the first await so a hung native
      // service cannot retain this task, and re-armed from the effective
      // worker timeout once that is known.
      preflightTimer: null,
      preflightTimedOut: false,
      controller: new AbortController(),
      // Native execution bookkeeping. `started` flips immediately before the
      // runner is called; `settled` flips when the runner's promise resolves,
      // which is where the runner has disposed the handle it knew about. The
      // promise is what {@link finalize} waits on, boundedly, before it releases
      // the leases: a workspace must not be handed to the next job while the
      // previous executor may still be writing to it.
      native: { started: false, settled: false, promise: null },
      // The per-call permission surface of this run. `bridge` is the answerer the
      // runner arms for this task's own Agent (null when the run was not offered
      // one), `pending` is the one request the worker is waiting on (null when
      // nothing is outstanding), and `evidence` is the bounded settled trail the
      // task view and the durable history carry. `pausedExecutionMs` is how much
      // of the execution budget was spent WAITING: it is given back to the run's
      // timer when the request settles, so an approval wait can never be charged
      // to the execution timeout.
      permission: { bridge: null, pending: null, evidence: [], pausedAt: null, pausedExecutionMs: 0 },
      // Idempotence latch for {@link finalize}: one promise per task, ever.
      finalizing: null,
      finalizedAt: null,
      // Cleanup that could not be performed, and durable-history outcomes. Both
      // are recorded on the task so a failure is visible instead of swallowed.
      cleanupError: null,
      historyError: null,
      historySavedAt: null,
      // Host acceptance is never granted here; it is the host's own record.
      hostAcceptance: null,
      settled,
      settle: () => { settle(); },
    };
  }

  /**
   * Admit one task: every preflight step, in the fixed order, with a liveness and
   * authorization recheck after each await.
   *
   * Every await goes through {@link guardPreflight}, which races the native call
   * against the task's own cancellation and preflight deadline. That is what
   * makes a hung `settings.read()`, `providerRegistry.ensure()` or
   * `worktrees.prepare()` cost a bounded wait instead of a permanent slot, a
   * permanent lease, or a start that never returns.
   * @param {object} task - pending record.
   * @param {object} request - the start request.
   * @returns {Promise<void>} resolves when the task is fully prepared.
   */
  async admit(task, request) {
    // ---- 1. source workspace -------------------------------------------------
    task.phase = 'workspace';
    const sourcePath = await this.guardPreflight(task, 'workspace', () => resolveWorkspacePath(request?.workspacePath))
      .catch((error) => {
        if (error instanceof WorkspaceError) {
          throw new JobError(JOB_CODES.workspaceRequired, error.message, redactDeep(error.details ?? {}));
        }
        throw error;
      });
    task.sourcePath = sourcePath;
    task.executionPath = sourcePath;
    this.assertLive(task, 'workspace');

    // ---- 2. authorization, bound to the source workspace ---------------------
    // A task grant is consumed exactly once; a session grant is checked by the
    // exact id the caller named and the resulting id is frozen on the task. The
    // engine never widens a named lookup to "some other live session grant".
    task.phase = 'authorization';
    let grant = { grantId: null, kind: 'switch', overrides: null };
    if (task.authorization === 'switch') {
      task.connectionId = 'local-mcp';
      task.grantId = null;
      task.grantKind = 'switch';
      this.assertLive(task, 'authorization');
    } else {
    grant = task.authorization === 'session'
      ? this.auth.requireSessionGrant({
        connectionId: request?.connectionId,
        grantId: request?.grantId,
        workspacePath: sourcePath,
      })
      : this.auth.consumeTaskGrant({
        connectionId: request?.connectionId,
        grantId: request?.grantId,
        taskId: task.taskId,
        workspacePath: sourcePath,
      });
    // The public grant projection carries no connectionId; the caller's verified
    // identity is the connection the registry just checked against the grant.
    task.connectionId = request?.connectionId;
    task.grantId = grant.grantId;
    task.grantKind = grant.kind;
    this.assertLive(task, 'authorization');
    }

    // ---- 2b. a follow-up must be owned by this caller, fail-closed -----------
    // Proven here, where the caller's verified connection identity is known, and
    // before anything about the parent can be described. One call decides the whole
    // chain — ownership, outcome, paths, isolation and the identity map — from a
    // single durable snapshot, so nothing about the parent can reach a caller who has
    // not proven ownership and no later step reads history or the identity map again.
    // Running it here, before settings and the concurrency slot, is what makes a
    // refusal stable: a still-running parent is refused for its own state rather than
    // for a slot it was never entitled to, and the parent's isolation mode is known
    // before any mode is resolved.
    if (task.continueFromTaskId !== null) {
      task.phase = 'continuation';
      await this.assertContinuation(task, sourcePath);
      this.assertLive(task, 'continuation');
    }

    // ---- 3. one immutable settings snapshot ----------------------------------
    task.phase = 'settings';
    const settings = await this.guardPreflight(task, 'settings', () => this.settings.read());
    this.assertLive(task, 'settings');
    if (!Array.isArray(settings?.providers) || settings.providers.length === 0) {
      throw new JobError(JOB_CODES.noProviders, 'no provider profile is configured', {});
    }

    // ---- 4. effective configuration and the concurrency slot -----------------
    task.phase = 'effective';
    const overrides = sanitizeOverrides(grant.overrides ?? request?.overrides);
    if (task.continuationRecord !== null) {
      const parentIsolation = task.continuationRecord.isolation;
      if (overrides.isolation !== undefined && overrides.isolation !== parentIsolation) {
        throw this.continuationRefusal('a follow-up must keep the isolation mode of the task it continues', {
          continueFromTaskId: task.continueFromTaskId,
          requestedIsolation: overrides.isolation,
          parentIsolation,
          session: SESSION_CODES.continuationUnavailable,
        });
      }
      // A continuation belongs to the original task chain. If the global or
      // project setting changed after its parent ran, use the parent's isolation
      // so the follow-up reaches the same checkout or the same managed worktree.
      overrides.isolation = parentIsolation;
    }
    let effective;
    try {
      effective = resolveEffectiveConfig(settings, { projectPath: sourcePath, overrides });
    } catch (error) {
      throw new JobError(JOB_CODES.routingRefused, error?.message ?? 'the effective configuration was refused', {
        cause: error?.code ?? null,
        details: redactDeep(error?.details ?? null),
      });
    }
    task.effective = effective;
    // The worker timeout is a budget for the whole task, preflight included, so
    // the deadline is re-armed from creation time rather than from this point.
    task.deadlineAt = task.createdAt + effective.worker.timeoutSeconds * 1000;
    this.armPreflightDeadline(task, task.deadlineAt - Date.now());
    this.assertLive(task, 'effective');
    // The slot claim and the count happen in one synchronous step, ordered by
    // admission sequence, so two concurrent starts cannot both take the slot.
    // From here the slot is held until {@link finalize} returns it, and finalize
    // does that only after the native executor is confirmed stopped.
    this.reserveSlot(task, effective.worker.maxParallelism);

    // ---- 5. provider routes for worker and review, from one snapshot ---------
    task.phase = 'providers';
    // The provider-definition lease is taken *before* the first await of this
    // step, in this same synchronous section. The native adapter serves the latest
    // generation the registry committed for every model operation, so without a
    // hold a settings edit (or another job's catalog read) could swap the served
    // definition between two turns of this task while `task.effective` still names
    // the old one. The hold is released only by {@link finalize}, after the native
    // executor has confirmed it stopped.
    this.leaseProviders(task, settings);
    task.routes = await this.guardPreflight(task, 'providers', () => this.ensureRoutes(settings));
    this.assertLive(task, 'providers');
    const workerRouteId = this.routeFor(task.routes, effective.worker.providerId, 'worker');

    // ---- 6. lock the source workspace before anything is audited or created --
    task.phase = 'source-lock';
    this.acquireSourceLock(task);

    // ---- 7. isolation: a real worktree, or explicitly shared -----------------
    if (effective.worker.isolation === 'worktree') {
      task.phase = 'worktree';
      const prepared = task.continuationRecord === null
        ? await this.guardPreflight(task, 'worktree', () => this.prepareWorktree(task), {
          // A tree that finished after this start was abandoned still exists on
          // disk. It is recorded and marked complete, never deleted or merged: it
          // is evidence, and the host decides what happens to it.
          onLateSettle: (value) => this.adoptLateWorktree(task, value),
        })
        : await this.guardPreflight(task, 'continuation-worktree', () => this.reuseContinuationWorktree(task));
      task.worktree = prepared;
      task.executionPath = prepared.workspacePath;
      task.reusedWorktree = task.continuationRecord !== null;
      this.assertLive(task, 'worktree');
      this.acquireExecutionLock(task);
    } else if (effective.worker.isolation !== 'shared') {
      // Unreachable for a validated snapshot; refusing is still the only honest
      // answer to a mode this build cannot honour.
      throw new JobError(JOB_CODES.isolationRefused, `isolation ${String(effective.worker.isolation)} is not implemented`, {
        requested: effective.worker.isolation ?? null,
      });
    }

    // ---- 8. baseline in the workspace the run will actually mutate -----------
    task.phase = 'baseline';
    let baseline;
    try {
      baseline = await this.guardPreflight(task, 'baseline', () => captureBaseline(this.deps, task.executionPath));
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw new JobError(JOB_CODES.auditUnavailable, error?.message ?? 'the workspace could not be audited', {
        cause: error?.code ?? null,
      });
    }
    this.assertLive(task, 'baseline');
    if (task.worktree !== null && baseline.head !== task.worktree.baseHead) {
      // The tree is a detached checkout of one commit; a baseline that disagrees
      // means something else wrote to it before the run started.
      throw new JobError(JOB_CODES.auditUnavailable, 'the isolated workspace does not start at the pinned commit', {
        cause: 'BASELINE_HEAD_MISMATCH',
      });
    }
    task.baseline = baseline;

    // ---- 9. worker route, frozen on the task ---------------------------------
    task.phase = 'worker-route';
    let route;
    try {
      route = await this.guardPreflight(task, 'worker-route', () => resolveRoute(this.deps, {
        providerId: effective.worker.providerId,
        providerRoute: workerRouteId,
        model: effective.worker.model,
        reasoningEffort: effective.worker.reasoningEffort,
      }, { signal: task.controller.signal }));
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw new JobError(JOB_CODES.routingRefused, error?.message ?? 'the route could not be confirmed', {
        cause: error?.code ?? null,
        details: redactDeep(error?.details ?? null),
      });
    }
    this.assertLive(task, 'worker-route');
    task.route = route;

    // ---- 10. review route, frozen BEFORE the worker runs ---------------------
    // A review that resolved its route after execution would judge the work with
    // whatever configuration existed later, or with an ambient route. A review
    // routing failure is recorded on the review record and never refuses the
    // task, and it never turns into approval.
    if (effective.review.enabled === true) {
      task.phase = 'review-route';
      try {
        const reviewRouteId = this.routeFor(task.routes, effective.review.providerId, 'review');
        task.reviewRoute = await this.guardPreflight(task, 'review-route', () => resolveRoute(this.deps, {
          providerId: effective.review.providerId,
          providerRoute: reviewRouteId,
          model: effective.review.model,
          reasoningEffort: effective.review.reasoningEffort,
        }, { signal: task.controller.signal }));
      } catch (error) {
        if (error instanceof JobError) throw error;
        task.reviewRoute = null;
        task.reviewRouteError = {
          code: 'REVIEW_ROUTING_REFUSED',
          message: diagnostic(error?.message ?? 'the review route could not be confirmed', 400),
          cause: typeof error?.code === 'string' ? error.code : null,
        };
      }
      this.assertLive(task, 'review-route');
    }

    // ---- 11. last preflight gate before any native create --------------------
    task.phase = 'admitted';
    this.assertLive(task, 'admitted');
  }

  /**
   * Await one preflight step under cancellation and the preflight deadline.
   *
   * The await is what a native service can hang on, so it is the await that gets
   * a bound. When the race loses, the underlying promise is *not* cancelled — it
   * cannot be — so `onLateSettle` is given the chance to account for whatever it
   * eventually produced (a worktree, in practice) instead of leaking it.
   * @param {object} task - pending record.
   * @param {string} phase - the step being awaited.
   * @param {() => Promise<unknown>} start - thunk producing the native call.
   * @param {object} [options] - `onLateSettle(value)` for work that lands late.
   * @returns {Promise<unknown>} the native call's value.
   */
  async guardPreflight(task, phase, start, options = {}) {
    const signal = task.controller.signal;
    if (signal.aborted) throw this.preflightAbort(task, phase);

    const promise = Promise.resolve().then(start);
    let onAbort;
    const aborted = new Promise((resolvePromise) => {
      onAbort = () => resolvePromise({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      const raced = await Promise.race([
        promise.then((value) => ({ kind: 'ok', value }), (error) => ({ kind: 'error', error })),
        aborted,
      ]);
      if (raced.kind === 'aborted') {
        if (typeof options.onLateSettle === 'function') {
          void promise.then(
            (value) => { options.onLateSettle(value); },
            () => {},
          );
        }
        throw this.preflightAbort(task, phase);
      }
      if (raced.kind === 'error') throw raced.error;
      return raced.value;
    } finally {
      signal.removeEventListener?.('abort', onAbort);
    }
  }

  /**
   * Map a preflight race loss onto the reason it was lost.
   * @param {object} task - pending record.
   * @param {string} phase - the step that was abandoned.
   * @returns {JobError} refusal to throw.
   */
  preflightAbort(task, phase) {
    if (this.aborted) {
      return new JobError(JOB_CODES.disposed, 'the plugin was disposed while the task was starting', { phase });
    }
    if (task.preflightTimedOut === true) {
      return new JobError(JOB_CODES.timeout, `the task exceeded its time budget during ${phase}`, { phase });
    }
    return new JobError(JOB_CODES.cancelled, `the task was cancelled during ${phase}`, {
      phase,
      reason: task.cancelledBy ?? 'request',
    });
  }

  /**
   * Arm (or re-arm) the preflight deadline that bounds a pending start.
   * @param {object} task - pending record.
   * @param {number} remainingMs - milliseconds left in the task's budget.
   * @returns {void}
   */
  armPreflightDeadline(task, remainingMs) {
    this.clearPreflightDeadline(task);
    const delay = Number.isFinite(remainingMs)
      ? Math.max(0, remainingMs)
      : this.preflightTimeoutMs;
    if (delay === 0) {
      // The budget was already spent before this step began.
      task.preflightTimedOut = true;
      try {
        task.controller.abort();
      } catch {
        // AbortController.abort() does not throw; kept for defence in depth.
      }
      return;
    }
    const timer = setTimeout(() => {
      task.preflightTimer = null;
      task.preflightTimedOut = true;
      try {
        task.controller.abort();
      } catch {
        // As above: abort is not expected to throw.
      }
    }, delay);
    timer.unref?.();
    task.preflightTimer = timer;
  }

  /**
   * Disarm the preflight deadline. Idempotent, and safe after it already fired.
   * @param {object} task - task record.
   * @returns {void}
   */
  clearPreflightDeadline(task) {
    if (task.preflightTimer !== null && task.preflightTimer !== undefined) {
      clearTimeout(task.preflightTimer);
      task.preflightTimer = null;
    }
  }

  /**
   * Record and finish a worktree that was prepared after its start was abandoned.
   * @param {object} task - task record.
   * @param {unknown} prepared - the late value, if it is usable.
   * @returns {void}
   */
  adoptLateWorktree(task, prepared) {
    if (prepared === null || typeof prepared !== 'object' || typeof prepared.workspacePath !== 'string') return;
    if (task.worktree === null) {
      task.worktree = prepared;
      task.executionPath = prepared.workspacePath;
    }
    this.completeWorktree(task);
  }

  /**
   * Whether a task still occupies a concurrency slot.
   *
   * Two independent reasons, and a task may have both: it is live, or it is
   * terminal but its native executor has not been confirmed stopped and its
   * leases therefore have not been released. The second case is what stops a
   * finished-but-still-cleaning task from being counted as free capacity — the
   * next job would then admit against a workspace that is still being written to.
   * @param {object} task - task record.
   * @returns {boolean} true when the slot is still taken.
   */
  occupiesSlot(task) {
    if (task.slotHeld === true) return true;
    return LIVE.has(task.state);
  }

  /**
   * Record the one terminal state a task may have. The first writer wins, so a
   * late promise, a late review result or a second failure can never revive or
   * overwrite a task that has already ended.
   * @param {object} task - task record.
   * @param {string} state - terminal state to record.
   * @returns {boolean} true when this call recorded the state.
   */
  markTerminal(task, state) {
    if (TERMINAL.has(task.state)) return false;
    task.state = state;
    task.endedAt = task.endedAt ?? Date.now();
    return true;
  }

  /**
   * Claim the concurrency slot for one task, or refuse.
   *
   * The count and the claim happen in one synchronous step, so two concurrent
   * starts cannot both observe the same free slot: whichever claims second sees
   * the first claim. Ordering is by admission sequence, so a pending start
   * competes only with the requests accepted before it. A later request is behind
   * it in the queue and counting it would refuse both starts of a
   * `maxParallelism: 1` pair, dropping work the operator asked for instead of
   * admitting exactly one.
   * @param {object} task - the pending task asking for a slot.
   * @param {number} limit - `worker.maxParallelism`.
   * @returns {void}
   * @throws {JobError} when every slot is already taken.
   */
  reserveSlot(task, limit) {
    if (task.slotHeld === true) return;
    let ahead = 0;
    for (const other of this.tasks.values()) {
      if (other === task) continue;
      if (other.sequence >= task.sequence) continue;
      if (!this.occupiesSlot(other)) continue;
      ahead += 1;
    }
    if (ahead >= limit) {
      throw new JobError(JOB_CODES.concurrency, `at most ${limit} task(s) may run at once`, {
        limit,
        active: ahead,
      });
    }
    // Claimed, not merely counted: from this statement the slot is this task's
    // until {@link releaseSlot} returns it inside {@link finalize}.
    task.slotHeld = true;
  }

  /**
   * Return the concurrency slot. Idempotent, and never called before the native
   * executor is confirmed stopped.
   * @param {object} task - task record.
   * @returns {void}
   */
  releaseSlot(task) {
    task.slotHeld = false;
  }

  /**
   * Return this task's capacity exactly once: the concurrency slot, every
   * workspace lease, and the provider-definition lease.
   *
   * Idempotent by latch. A task keeps its record after it is terminal, so every
   * terminal path — success, failure, cancellation, timeout, admission refusal,
   * dispose — has to come through here, and a second path that races the first
   * (a late review refusal, `cancel()` after `dispose()`) awaits the same
   * promise instead of releasing twice.
   *
   * It refuses to hand anything back while the native executor this task started
   * may still be writing. The wait for that executor is bounded (see
   * {@link NATIVE_SETTLE_TIMEOUT_MS}); when the bound is exceeded the release is
   * declined and recorded as `cleanupError`, so an executor that never confirms
   * it stopped costs a visible refusal rather than a silent double-write. A
   * declined release is not latched as final: a later caller retries it, and
   * succeeds if the executor has settled by then. Only a *completed* release is
   * terminal, and only one attempt runs at a time.
   * @param {object} task - task record.
   * @returns {Promise<boolean>} true when the capacity was actually returned.
   */
  finalize(task) {
    if (task.finalizedAt !== null) return Promise.resolve(true);
    if (task.finalizing !== null) return task.finalizing;
    const attempt = this.releaseCapacity(task).then(
      (released) => {
        // A refusal stays retryable; the next terminal path may find the
        // executor stopped. A release that happened is never repeated.
        if (released !== true && task.finalizing === attempt) task.finalizing = null;
        return released;
      },
      (error) => {
        if (task.finalizing === attempt) task.finalizing = null;
        throw error;
      },
    );
    task.finalizing = attempt;
    return attempt;
  }

  /**
   * Take the process-local provider-definition lease for one task.
   *
   * This is the second half of the immutability of `task.effective`. The effective
   * configuration snapshot freezes what the task *asked for*; the native adapter,
   * however, serves whatever generation the registry committed last, and every
   * model operation re-reads it. A multi-turn run would therefore follow a settings
   * change onto its next turn, on a route whose endpoint and models the task never
   * agreed to. Holding the provider set for the task's whole life — from the step
   * before the route ensure runs until {@link finalize} confirms the native
   * executor stopped — makes the served set a fact the task controls, and makes a
   * different set a refusal the other caller can see (see `PROVIDER_SET_CODES`).
   *
   * Called synchronously, before the ensure await, so the hold exists before any
   * other start can observe a window without it. Idempotent: a task takes at most
   * one lease.
   *
   * The lease covers the *plugin-managed* providers only — the same subset
   * `ensureRoutes` registers — so the two are two readings of one list rather than
   * two filters that can disagree. Native DSH profiles are references to routes
   * this plugin never registers: leasing them used to fingerprint the settings list
   * (`[workbuddy]`) while the route ensure registered the custom subset (`[]`), and
   * the task's own ensure was then refused, unanswered by any second task, with
   * `PROVIDER_SET_BUSY` and `routeCount` 0.
   *
   * The lease is best-effort by design, and its absence is never silent: an
   * injected registry that predates this contract (no `lease`) is used exactly as
   * before, and a registry whose `lease` throws is treated as "no hold" rather than
   * as an admission failure — the engine cannot invent a lease a registry does not
   * implement, and refusing every job on an older seam would be worse than the
   * status quo. The one exception is the registry's own busy refusal: a caller that
   * asked for a different provider set while another is pinned must be told, and
   * the refusal carries `PROVIDER_SET_CODES.busy` straight through to the job.
   * @param {object} task - pending record with `effective` resolved.
   * @param {object} settings - the validated settings snapshot the task read.
   * @returns {void}
   * @throws {JobError} `PROVIDER_SET_BUSY` when another provider set is pinned.
   */
  leaseProviders(task, settings) {
    if (task.providerLease !== null || task.providerLeaseReleased === true) return;
    const registry = this.deps?.providerRegistry;
    if (registry === undefined || registry === null || typeof registry.lease !== 'function') return;
    // The canonical set, shared with `ensureRoutes` by construction. A native-only
    // configuration therefore leases the empty set, which is exactly what its route
    // registration applies — the two agree, and the refusal only ever comes from a
    // genuinely different custom set.
    const managed = managedProvidersOf(settings?.providers);
    try {
      task.providerLease = registry.lease(managed, task.taskId);
      return;
    } catch (error) {
      if (error?.code === PROVIDER_SET_CODES.busy) {
        throw new JobError(PROVIDER_SET_CODES.busy, diagnostic(error?.message ?? 'the provider configuration is pinned', 300)
          ?? 'the provider configuration is pinned', { phase: 'providers', ...redactDeep(error?.details ?? {}) });
      }
      task.providerLease = null;
    }
  }

  /**
   * Give back the provider-definition lease, if this task holds one.
   *
   * Idempotent by latch, and never called before the native executor is confirmed
   * stopped: the executor is the only party that performs native model operations
   * after preflight, so releasing any earlier would reopen the window this lease
   * exists to close. A refusal thrown by the registry is swallowed: the lease is
   * process-local, the task is already terminal, and the next task's release would
   * hit the same registry state. The latch is still set, so a late cleanup can
   * never release twice.
   * @param {object} task - task record.
   * @returns {void}
   */
  releaseProviderLease(task) {
    if (task.providerLeaseReleased === true) return;
    task.providerLeaseReleased = true;
    const held = task.providerLease;
    task.providerLease = null;
    if (held === null || held === undefined) return;
    try {
      this.deps?.providerRegistry?.release?.(held);
    } catch {
      // A registry that cannot release is a registry defect, not a task outcome;
      // the task is terminal and this cannot be reported anywhere useful.
    }
  }

  /**
   * Perform one release attempt, gated on the native executor's settlement.
   * @param {object} task - task record.
   * @returns {Promise<boolean>} true when the slot and the leases were returned.
   */
  async releaseCapacity(task) {
    this.clearPreflightDeadline(task);
    if (task.native.started === true && task.native.settled !== true) {
      await this.awaitNativeSettlement(task);
    }
    if (task.native.started === true && task.native.settled !== true) {
      task.cleanupError = {
        code: JOB_CODES.nativeNotStopped,
        message: 'the native executor did not confirm that it stopped; the workspace lease and slot stay held',
      };
      return false;
    }
    task.cleanupError = null;
    this.releaseLeases(task);
    // The provider set is given back on the same terms as the workspace: only
    // once the executor that reads it has confirmed it stopped. After this line a
    // saved, different configuration applies to the next task.
    this.releaseProviderLease(task);
    // A tree prepared before the task ended is evidence, not garbage: it is kept
    // and marked complete so the host can inspect or dispose it explicitly.
    this.completeWorktree(task);
    this.releaseSlot(task);
    task.finalizedAt = task.finalizedAt ?? Date.now();
    return true;
  }

  /**
   * Wait, boundedly, for the native executor's own promise to settle.
   * @param {object} task - task record holding a started executor.
   * @returns {Promise<void>} resolves when it settled, or when the bound expires.
   */
  async awaitNativeSettlement(task) {
    const pending = task.native.promise;
    if (pending === null || typeof pending.then !== 'function') return;
    await Promise.race([
      pending.then(() => {}, () => {}),
      new Promise((resolvePromise) => { setTimeout(resolvePromise, NATIVE_SETTLE_TIMEOUT_MS).unref?.(); }),
    ]);
  }

  /**
   * Ensure the native provider routes for one settings snapshot.
   *
   * One call per snapshot, before either the worker or the review route is
   * resolved, so both selections come from the same mapping. Previously ensured
   * routes stay with the registry until plugin dispose; the engine never narrows
   * the set it passes in.
   *
   * Which seam is used matters, and is not an implementation detail. Native route
   * registration has two halves that must move together: the adapter's served
   * snapshot (which is what `LlmRuntime.registerAdapter()` reads synchronously
   * through `providerInfo(route)`) and the core's route table. The entry point's
   * `deps.ensureRoutes(settings)` seam performs both in one synchronous,
   * rollback-protected transaction, and every other caller (`/models`,
   * `/catalog`, connectivity) already goes through it.
   *
   * Registering through `providerRegistry.ensure()` alone only touches the core's
   * route table: the adapter keeps serving whatever generation it was last given
   * — often the empty one — and the first job on a freshly loaded plugin then
   * fails with `ROUTING_MODEL_UNRESOLVED` for a model that is configured and
   * plain resolvable. So the full-snapshot seam is preferred whenever it was
   * injected, and the registry is only the fallback when it was not.
   * @param {object} settings - immutable settings snapshot.
   * @returns {Promise<Map<string, string> | null>} public provider id -> native route, or null on the legacy test path.
   */
  async ensureRoutes(settings) {
    const seam = this.deps?.ensureRoutes;
    if (seam !== undefined && seam !== null && typeof seam === 'function') {
      return await this.ensureRoutesThroughSeam(seam, settings);
    }
    const registry = this.deps?.providerRegistry;
    if (registry === undefined || registry === null) {
      // Production entry points always inject one of the two seams (src/index.js
      // injects both). The profile-id fallback exists only for tests that fake the
      // native routes directly, and must be requested explicitly.
      if (this.deps?.allowLegacyProviderRoutes === true) return null;
      throw new JobError(
        JOB_CODES.providerRegistry,
        'the native provider registry is required to route a delegated run',
        {},
      );
    }
    if (typeof registry.ensure !== 'function') {
      throw new JobError(JOB_CODES.providerRegistry, 'the injected provider registry cannot ensure routes', {});
    }
    let ensured;
    try {
      ensured = await registry.ensure(settings.providers);
    } catch (error) {
      throw this.routeEnsureRefusal(error);
    }
    return this.readRouteMapping(ensured, 'the provider registry');
  }

  /**
   * Ensure routes through the entry point's full-snapshot seam.
   *
   * The seam is handed the *whole* settings snapshot rather than a provider list,
   * because publishing the adapter snapshot needs the provider profiles (display
   * names, models, effort axes) and not only the ids the core registers. It
   * returns the mapping directly; the shape is validated here anyway so a seam
   * that changes shape is a refusal instead of a `undefined.get()` later.
   * @param {Function} seam - `deps.ensureRoutes(settings) -> Promise<Map|{routes}>`.
   * @param {object} settings - immutable settings snapshot.
   * @returns {Promise<Map<string, string>>} public provider id -> native route.
   */
  async ensureRoutesThroughSeam(seam, settings) {
    let ensured;
    try {
      ensured = await seam(settings);
    } catch (error) {
      throw this.routeEnsureRefusal(error);
    }
    return this.readRouteMapping(ensured, 'the provider route seam');
  }

  /**
   * Turn a failed route ensure into a bounded job refusal.
   * @param {unknown} error - thrown by the registry or the seam.
   * @returns {JobError} routing refusal.
   */
  routeEnsureRefusal(error) {
    if (error instanceof JobError) return error;
    return new JobError(JOB_CODES.routingRefused, 'the provider routes could not be ensured', {
      cause: typeof error?.code === 'string' ? error.code : null,
      detail: diagnostic(error?.message ?? error, 200),
    });
  }

  /**
   * Accept either shape a route ensure produces: a `Map` of public id -> native
   * route, or a record carrying one as `routes`.
   * @param {unknown} ensured - value returned by a route ensure seam.
   * @param {string} source - seam name for diagnostics.
   * @returns {Map<string, string>} the route mapping.
   */
  readRouteMapping(ensured, source) {
    if (ensured === null || typeof ensured !== 'object') {
      throw new JobError(JOB_CODES.routingRefused, `${source} returned no route mapping`, {});
    }
    const routes = ensured instanceof Map ? ensured : ensured.routes;
    if (routes instanceof Map) {
      if (routes.size > 0) return routes;
    } else if (routes !== null && typeof routes === 'object') {
      const mapped = new Map();
      for (const [key, value] of Object.entries(routes)) {
        const id = nativeRouteId(value);
        if (id !== null) mapped.set(key, id);
      }
      if (mapped.size > 0) return mapped;
    }
    throw new JobError(JOB_CODES.routingRefused, `${source} returned no usable route mapping`, {});
  }

  /**
   * Resolve the native route for one public provider profile id.
   *
   * A mapping that exists but does not cover the selected provider is a refusal,
   * never a fallback to the profile id: the profile id is not a native route, and
   * resolving one produced the field failure this module exists to prevent.
   * @param {Map<string, string> | null} routes - route mapping, or null for the legacy path.
   * @param {string | null} providerId - operator-facing profile id.
   * @param {string} role - `worker` or `review`, for diagnostics.
   * @returns {string} native route id.
   */
  routeFor(routes, providerId, role) {
    if (routes === null) return providerId;
    if (typeof providerId !== 'string' || providerId === '') {
      throw new JobError(JOB_CODES.routingRefused, 'no provider was selected', { role });
    }
    if (!(routes instanceof Map)) {
      throw new JobError(JOB_CODES.routingRefused, 'the provider route mapping is unusable', { role });
    }
    if (!routes.has(providerId)) {
      throw new JobError(JOB_CODES.routingRefused, `provider ${providerId} was not registered with the harness`, {
        role,
        providerId,
        registered: [...routes.keys()].slice(0, 32),
      });
    }
    const route = routes.get(providerId);
    const id = nativeRouteId(route);
    if (id === null) {
      throw new JobError(JOB_CODES.routingRefused, `provider ${providerId} has no native route`, {
        role,
        providerId,
      });
    }
    return id;
  }

  /**
   * Acquire the lease on the source workspace.
   * @param {object} task - pending record.
   * @returns {void}
   */
  acquireSourceLock(task) {
    try {
      const lease = this.locks.acquire(task.sourcePath, { taskId: task.taskId });
      task.leases.push({ path: task.sourcePath, nonce: lease.nonce });
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === LOCK_CODES.busy) {
        throw new JobError(JOB_CODES.busy, error.message, redactDeep(error.details ?? {}));
      }
      throw error;
    }
  }

  /**
   * Acquire the lease on the execution workspace (the worktree), after the
   * source lease. A shared run reuses the source lease instead of double-locking
   * one path.
   * @param {object} task - pending record with a prepared execution path.
   * @returns {void}
   */
  acquireExecutionLock(task) {
    if (task.executionPath === null || samePath(task.executionPath, task.sourcePath)) return;
    if (task.leases.some((lease) => samePath(lease.path, task.executionPath))) return;
    try {
      const lease = this.locks.acquire(task.executionPath, { taskId: task.taskId });
      task.leases.push({ path: task.executionPath, nonce: lease.nonce });
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === LOCK_CODES.busy) {
        throw new JobError(JOB_CODES.busy, 'another job is already running in the isolated workspace', {
          ...redactDeep(error.details ?? {}),
        });
      }
      throw error;
    }
  }

  /**
   * Prepare an isolated worktree, or refuse. There is no fallback to shared
   * execution: a missing service is a refusal, not a downgrade.
   * @param {object} task - pending record with a locked source path.
   * @returns {Promise<object>} prepared worktree metadata.
   */
  async prepareWorktree(task) {
    const manager = this.deps?.worktrees;
    if (manager === undefined || manager === null || typeof manager.prepare !== 'function') {
      throw new JobError(
        JOB_CODES.isolationRefused,
        'worktree isolation is configured but no worktree service is available; select shared isolation explicitly',
        { requested: 'worktree', cause: 'WORKTREE_SERVICE_UNAVAILABLE' },
      );
    }
    let prepared;
    try {
      prepared = await manager.prepare({
        taskId: task.taskId,
        sourcePath: task.sourcePath,
        signal: task.controller.signal,
      });
    } catch (error) {
      if (error?.code === 'WORKTREE_CANCELLED') {
        throw new JobError(JOB_CODES.cancelled, error?.message ?? 'the worktree was cancelled', {
          cause: error.code,
        });
      }
      throw new JobError(JOB_CODES.isolationRefused, error?.message ?? 'the isolated workspace could not be prepared', {
        requested: 'worktree',
        cause: typeof error?.code === 'string' ? error.code : null,
        details: redactDeep(error?.details ?? null),
      });
    }
    if (prepared === null || typeof prepared !== 'object'
      || typeof prepared.workspacePath !== 'string' || prepared.workspacePath === '') {
      throw new JobError(JOB_CODES.isolationRefused, 'the worktree service returned no usable workspace', {
        requested: 'worktree',
        cause: 'WORKTREE_NO_PATH',
      });
    }
    if (prepared.isolated !== true) {
      throw new JobError(JOB_CODES.isolationRefused, 'the worktree service did not report an isolated checkout', {
        requested: 'worktree',
        cause: 'WORKTREE_NOT_ISOLATED',
        workspacePath: prepared.workspacePath,
      });
    }
    if (samePath(prepared.workspacePath, task.sourcePath)) {
      throw new JobError(JOB_CODES.isolationRefused, 'the worktree service returned the source workspace', {
        requested: 'worktree',
        cause: 'WORKTREE_SAME_PATH',
      });
    }
    return prepared;
  }

  /**
   * Shape a continuation refusal as the job error that carries its `SESSION_*` cause.
   *
   * The specific placement code travels in `details.session` so a caller can tell a
   * stale identity from a live one from an unreadable store, exactly as a
   * conversation-placement refusal does.
   * @param {string} message - operator-readable explanation.
   * @param {object} [details] - bounded context; never a credential or a transcript.
   * @returns {JobError} refusal to throw.
   */
  continuationRefusal(message, details = {}) {
    return new JobError(JOB_CODES.continuationRefused, message, redactDeep(details));
  }

  /**
   * Prove that this caller owns the named parent thread, then judge whether the chain
   * may be joined — in one method, from one snapshot, with no branch that skips a check.
   *
   * Admission calls this once, before settings are read and before a concurrency slot
   * is claimed, so everything a continuation needs is decided in one order:
   *
   *  1. **Ownership.** The caller must state a verified connection id (the empty side is
   *     never a wildcard). A live parent record is proven by its own exact
   *     `connectionId`; a record that states none is unprovable rather than ownerless.
   *     A parent this process does not hold is proven by its durable history row, whose
   *     exact `connectionId` must equal the caller's. A deployment without durable
   *     history, an unreadable or malformed document, a pruned or missing record, a
   *     truncated record and a record with no owner all fail closed the same way, because
   *     each of them would otherwise confirm that some task exists. Every ownership
   *     failure is the same `JOB_TASK_NOT_FOUND`, reported as absent rather than
   *     forbidden, so the answer cannot enumerate another connection's tasks.
   *  2. **The durable snapshot.** History is read exactly once here and the row is
   *     reduced to one standard shape: `state`, `sourcePath`, `executionWorkspacePath`,
   *     `isolation` and `conversation`. A parent that is live in this process supplies
   *     that shape from its own record; a parent from a previous process supplies it from
   *     the durable row, with `conversation` taken from `row.execution?.conversation`.
   *     There is no "row was null, so skip the checks" path: a failed read is a refusal,
   *     never a pass.
   *  3. **The identity map**, read exactly once, and **the outcome**: {@link admitContinuation}
   *     judges state, paths, isolation and Session from that snapshot and this identity.
   *
   * The verified result is recorded on the task, because steps 4 and 7 of admission
   * (effective isolation, and reusing the parent's tree instead of preparing a new one)
   * read `task.continuationRecord`. Nothing below re-reads history or the identity map.
   * @param {object} task - pending record with `continueFromTaskId` and a verified `connectionId`.
   * @param {string} sourcePath - this submission's resolved source workspace.
   * @returns {Promise<void>} resolves once the chain is proven continuable.
   * @throws {JobError} `JOB_TASK_NOT_FOUND` when ownership is unprovable, a `SESSION_*`
   *   refusal when a proven parent cannot be joined.
   */
  async assertContinuation(task, sourcePath) {
    const parentId = task.continueFromTaskId;
    const caller = typeof task.connectionId === 'string' && task.connectionId !== '' ? task.connectionId : null;
    if (caller === null) throw this.absentContinuation(parentId);

    // One snapshot of the parent, in one standard shape. A live record is authoritative
    // for its own outcome and paths; otherwise the durable row must supply them, and a
    // row that cannot be found or read is a refusal, never a skip.
    const parent = this.tasks.get(parentId) ?? null;
    let row;
    if (parent !== null) {
      if (parent.connectionId !== caller) throw this.absentContinuation(parentId);
      row = {
        state: parent.state,
        sourcePath: parent.sourcePath,
        executionWorkspacePath: parent.executionPath,
        isolation: parent.effective?.worker?.isolation ?? null,
        conversation: parent.execution?.conversation ?? null,
      };
    } else {
      const durable = await this.durableParent(task, parentId, caller);
      if (durable === null) throw this.absentContinuation(parentId);
      row = {
        state: durable.state ?? null,
        sourcePath: durable.sourcePath ?? null,
        executionWorkspacePath: durable.executionWorkspacePath ?? null,
        isolation: durable.isolation ?? null,
        conversation: durable.execution?.conversation ?? null,
      };
    }

    // The identity map is the only document carrying the exact execution directory and
    // the Session; it is read once, here, and judged together with the snapshot above.
    task.continuationIdentity = await this.readContinuationIdentity(task);
    this.admitContinuation(task, row, sourcePath);

    // Recorded only after every check passed: these two facts are what admission's
    // isolation and worktree steps read to resume the parent instead of starting over.
    task.continuationParent = parent;
    task.continuationRecord = task.continuationIdentity;
  }

  /**
   * The one refusal an unprovable owner gets.
   *
   * Unknown, ownerless and another connection's parent are indistinguishable on
   * purpose: the details carry the id the caller itself supplied and nothing else,
   * so the answer cannot confirm that any other task exists.
   * @param {string} parentTaskId - the id the caller named.
   * @returns {JobError} refusal to throw.
   */
  absentContinuation(parentTaskId) {
    return new JobError(JOB_CODES.taskNotFound, 'no such task for this connection', { continueFromTaskId: parentTaskId });
  }

  /**
   * Read the durable record of a parent this process does not hold, and decide
   * whether it proves this caller's ownership.
   *
   * Fail-closed by construction: a deployment without durable history, an
   * unreadable or malformed document, a missing (pruned, never written) record, a
   * truncated record and a record that states no owner all answer `null`, which the
   * caller turns into the same `JOB_TASK_NOT_FOUND` an unknown id gets.
   * @param {object} task - pending record (for the guarded await).
   * @param {string} parentTaskId - the id the caller named.
   * @param {string} caller - this submission's verified connection id.
   * @returns {Promise<object | null>} the proven row, or null.
   */
  async durableParent(task, parentTaskId, caller) {
    const history = this.history;
    if (history === null || history === undefined || typeof history.load !== 'function') return null;
    let rows;
    try {
      rows = await this.guardPreflight(task, 'continuation-history', () => history.load());
    } catch (error) {
      if (error instanceof JobError) throw error;
      return null;
    }
    // Read once. The document is newest-first, so the first match is recent.
    const row = Array.isArray(rows)
      ? rows.find((entry) => entry !== null && typeof entry === 'object' && entry.taskId === parentTaskId) ?? null
      : null;
    if (row === null) return null;
    // A record that had to be cut to fit its byte budget is not complete evidence of
    // either ownership or outcome.
    if (row.truncation !== undefined && row.truncation !== null) return null;
    if (typeof row.connectionId !== 'string' || row.connectionId === '' || row.connectionId !== caller) return null;
    return row;
  }

  /**
   * Decide whether a proven parent may be joined, and record what joining it needs.
   *
   * Ownership is already proven, so every refusal here may name its reason. They are
   * all `SESSION_*` codes carried in `details.session`, and none of them falls back to
   * a new conversation.
   *
   *  1. **The snapshot decides the outcome.** It must be terminal — `pending`,
   *     `running`, `interrupted` (live when a previous process stopped) and anything
   *     this build does not know are refused — and it must name a conversation that
   *     really drove a Session: a placement of kind `new` or `continuation` with a
   *     non-empty Workspace id and Workspace path. A run that failed before it reached
   *     one has no thread, and continuing it would silently start a new one.
   *  2. **Its paths must be usable proof.** Both the source repository and the
   *     execution directory must be stated, unmasked and non-empty. A masked path was
   *     rewritten by redaction and cannot prove which directory it names, so it is
   *     refused exactly like a missing one — a mask is never a wildcard and never equals
   *     anything.
   *  3. **The identity map supplies the thread and must agree.** It is the only
   *     document carrying the exact execution directory and Session, so it must state
   *     one, its source repository must be this submission's, and its Workspace id,
   *     execution directory and isolation must be the ones the snapshot names. The
   *     native Session and its Agent are then verified by placement.
   * @param {object} task - pending record carrying the once-read `continuationIdentity`.
   * @param {object} row - the single parent snapshot, already in the standard shape.
   * @param {string} sourcePath - this submission's resolved source workspace.
   * @returns {void}
   * @throws {JobError} a `SESSION_*` refusal naming the reason.
   */
  admitContinuation(task, row, sourcePath) {
    const parentId = task.continueFromTaskId;
    const refuse = (message, session, reason, extra = {}) => this.continuationRefusal(message, {
      continueFromTaskId: parentId,
      session,
      reason,
      ...extra,
    });
    const state = row.state;
    if (!TERMINAL.has(state)) {
      // A parent that is merely unfinished (`pending`/`running`) is the one refusal an
      // operator retries, and says so in the same words the live re-check uses. A run
      // that stopped without ending (`interrupted`, or a state this build does not
      // know) is not "still running" and keeps the message that does not promise a retry.
      const message = state === TASK_STATES.pending || state === TASK_STATES.running
        ? 'the named task is still running, so its conversation cannot be continued yet'
        : 'the named task did not end, so its conversation cannot be continued';
      throw refuse(message, SESSION_CODES.continuationState,
        typeof state === 'string' ? state : 'no recorded end state');
    }
    const conversation = row.conversation;
    // A conversation is proof only when it names a placement that reached a Session in a
    // named Workspace. An absent one, an unknown kind or an empty Workspace id is a run
    // that never drove a thread, whichever terminal state it ended in.
    if (conversation === null || typeof conversation !== 'object'
      || !['new', 'continuation'].includes(conversation.kind)
      || typeof conversation.workspaceId !== 'string' || conversation.workspaceId.trim() === ''
      || typeof conversation.workspacePath !== 'string' || conversation.workspacePath.trim() === '') {
      throw refuse('the named task ended without driving a conversation, so there is nothing to continue',
        SESSION_CODES.continuationState, typeof state === 'string' ? state : 'no recorded end state');
    }
    // Paths are proof, not a hint: a value written through a projection that rewrote it
    // (a mask) cannot say which directory it named, so it is refused exactly like a
    // missing one. No path, connection or isolation value is ever a wildcard.
    for (const [field, session] of [
      ['sourcePath', SESSION_CODES.continuationWorkspaceMismatch],
      ['executionWorkspacePath', SESSION_CODES.continuationUnavailable],
    ]) {
      if (typeof row[field] !== 'string' || row[field].trim() === '' || recordedPathIsMasked(row[field])) {
        throw refuse('the named task has no reliably recorded path, so its conversation cannot be continued', session, `unusable recorded ${field}`);
      }
    }
    if (!samePath(row.sourcePath, sourcePath)) {
      throw refuse('the named task belongs to another source repository, so its conversation was not continued',
        SESSION_CODES.continuationWorkspaceMismatch, 'different source repository');
    }
    if (!['shared', 'worktree'].includes(row.isolation)) {
      throw refuse('the named task has no recorded isolation, so its conversation cannot be continued',
        SESSION_CODES.continuationUnavailable, 'no recorded isolation');
    }

    // The identity map supplies the thread itself, and must agree with the snapshot it
    // belongs to. It is the only document that carries the exact execution directory and
    // the Session, so a missing one is refused like a missing path.
    const identity = task.continuationIdentity;
    if (identity === null || typeof identity !== 'object') {
      throw refuse('no conversation identity is recorded for the named task, so it cannot be continued',
        SESSION_CODES.continuationUnknown, 'unknown, pruned or started by another deployment');
    }
    if (typeof identity.sessionId !== 'string' || identity.sessionId.trim() === '') {
      throw refuse('the recorded conversation identity names no Session, so it cannot be continued',
        SESSION_CODES.continuationUnavailable, 'no recorded session');
    }
    if (typeof identity.executionPath !== 'string' || identity.executionPath.trim() === ''
      || recordedPathIsMasked(identity.executionPath)) {
      throw refuse('the named task has no usable execution-path identity, so its conversation cannot be continued',
        SESSION_CODES.continuationUnavailable, 'unusable recorded execution path');
    }
    if (!samePath(identity.sourcePath, sourcePath)) {
      throw refuse('the named task belongs to another source repository, so its conversation was not continued',
        SESSION_CODES.continuationWorkspaceMismatch, 'identity source repository differs');
    }
    if (typeof identity.workspaceId !== 'string' || identity.workspaceId.trim() === ''
      || identity.workspaceId !== conversation.workspaceId) {
      throw refuse('the recorded conversation identity does not match the named task',
        SESSION_CODES.continuationUnavailable, 'identity workspace differs');
    }
    // The conversation names the directory it was recorded against. A record whose path
    // is masked cannot say which directory that was, and one that names a different
    // execution directory than the identity resolves is another directory's thread —
    // the Workspace id alone is not proof, so the Session is never resolved for either.
    if (recordedPathIsMasked(conversation.workspacePath) || !samePath(conversation.workspacePath, identity.executionPath)) {
      throw refuse('the recorded conversation path does not match its execution directory',
        SESSION_CODES.continuationUnavailable, 'conversation workspace path differs');
    }
    if (!samePath(identity.executionPath, row.executionWorkspacePath)) {
      throw refuse('the recorded conversation identity does not match the named task',
        SESSION_CODES.continuationUnavailable, 'identity execution path differs');
    }
    if (!['shared', 'worktree'].includes(identity.isolation) || identity.isolation !== row.isolation) {
      throw refuse('the recorded conversation identity does not match the named task',
        SESSION_CODES.continuationUnavailable, 'identity isolation differs');
    }
  }

  /**
   * Read the persisted identity of the named parent task, or refuse.
   *
   * This is the only read of the identity map in a submission. A missing store, an
   * unreadable document and a document with no row for the task are each a refusal,
   * because without them no Session can be reached and the follow-up would silently
   * become a new conversation. The row's own facts are judged in
   * {@link admitContinuation}, once ownership and outcome are known.
   * @param {object} task - pending record with `continueFromTaskId`.
   * @returns {Promise<object | null>} the stored row, or null when there is none.
   * @throws {JobError} when the map cannot be read at all.
   */
  async readContinuationIdentity(task) {
    const store = this.deps?.sessionStore ?? null;
    if (store === null || typeof store.get !== 'function') {
      throw this.continuationRefusal('this deployment keeps no task-to-conversation identity, so the named task cannot be continued', {
        continueFromTaskId: task.continueFromTaskId,
        session: SESSION_CODES.continuationUnavailable,
        reason: 'no session identity store',
      });
    }
    try {
      return await this.guardPreflight(task, 'continuation-identity', () => store.get(task.continueFromTaskId));
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw this.continuationRefusal('the stored task-to-conversation identity could not be read, so the named task cannot be continued', {
        continueFromTaskId: task.continueFromTaskId,
        session: SESSION_CODES.continuationUnavailable,
        cause: typeof error?.code === 'string' ? error.code : null,
      });
    }
  }

  /**
   * Resolve and validate the existing managed tree for a continuation.
   *
   * A new tree would hide the parent's uncommitted work and create a different
   * DSH Workspace, so this path never calls `prepare()`. After a plugin restart,
   * or after explicit disposal, the in-memory registry cannot prove ownership and
   * the continuation is refused rather than guessed from a directory name.
   * @param {object} task - continuation with a stored parent identity.
   * @returns {Promise<object>} the existing tree metadata.
   * @throws {JobError} when the original tree cannot be proven reusable.
   */
  async reuseContinuationWorktree(task) {
    const identity = task.continuationRecord;
    const manager = this.deps?.worktrees ?? null;
    const refuse = (message, reason) => this.continuationRefusal(message, {
      continueFromTaskId: task.continueFromTaskId,
      session: SESSION_CODES.continuationUnavailable,
      reason,
    });
    if (identity?.isolation !== 'worktree') {
      throw refuse('the named task did not use a managed worktree', 'parent was not isolated');
    }
    if (manager === null || typeof manager.get !== 'function') {
      throw refuse('the managed worktree service is unavailable, so the original tree cannot be proven reusable', 'no worktree registry');
    }
    let tree;
    try {
      tree = manager.get(identity.executionPath);
    } catch (error) {
      throw refuse('the managed worktree service refused to report the original tree', typeof error?.code === 'string' ? error.code : 'registry read failed');
    }
    if (tree === null || typeof tree !== 'object') {
      throw refuse('the original worktree is no longer registered; a new tree will not be substituted', 'tree not managed here');
    }
    const expectedTreeId = identity.worktreeId ?? identity.taskId;
    if (!samePath(tree.workspacePath, identity.executionPath)
      || !samePath(tree.sourcePath, identity.sourcePath)
      || (typeof expectedTreeId === 'string' && expectedTreeId !== '' && tree.taskId !== expectedTreeId)
      || tree.state === 'disposed'
      || tree.isolated !== true
      || tree.detached !== true) {
      throw refuse('the registered worktree does not match the task being continued', 'worktree identity mismatch');
    }
    let workspacePath;
    try {
      workspacePath = await resolveWorkspacePath(identity.executionPath);
    } catch {
      throw refuse('the original worktree path is no longer available', 'worktree path unavailable');
    }
    if (!samePath(workspacePath, identity.executionPath)) {
      throw refuse('the original worktree path resolves to a different directory', 'worktree path mismatch');
    }
    return { ...tree, workspacePath, reused: true };
  }

  /**
   * Decide whether a named task thread may be joined, from the live facts of one parent.
   *
   * This is the engine's own answer for a parent still in memory, used by placement
   * (`deps.assertAdmissible`) as a synchronous re-check of a chain admission has already
   * proven; a parent this process does not hold is not its business and answers
   * `undefined`, because {@link assertContinuation} already judged such a parent from its
   * durable snapshot. It is purely synchronous and never reads history or the identity
   * map back.
   *
   * The ownership, terminal-state, conversation and path rules are the same ones
   * {@link admitContinuation} applies to a snapshot, expressed for a live record: a
   * caller with no verified connection identity and a parent record that states no owner
   * are both unprovable, a parent that has not ended, or ended without a conversation,
   * is refused with the `SESSION_*` code that says why, and a parent that ran in another
   * directory (or records a masked one) cannot be joined merely because its Workspace id
   * looks familiar.
   * @param {string} parentTaskId - the task id the caller named.
   * @param {object} facts - `sourcePath` (this submission's source workspace),
   *   `executionPath` (the directory this submission runs in — the parent's tree when it
   *   continues an isolated chain), optional `connectionId` (this submission's verified
   *   connection, or null), and optional `selfTaskId` (the submitting task, for the
   *   self-continuation guard). A missing or masked path on either side is never a
   *   wildcard.
   * @returns {object | undefined} the live parent record when this process has one.
   * @throws {JobError} when the chain cannot be joined.
   */
  assertAdmissible(parentTaskId, facts = {}) {
    const parent = this.tasks.get(parentTaskId);
    if (parent === undefined) return undefined;
    if (facts.selfTaskId !== undefined && parent.taskId === facts.selfTaskId) {
      throw this.continuationRefusal('a task cannot continue its own conversation', {
        continueFromTaskId: parentTaskId,
        session: SESSION_CODES.continuationState,
      });
    }
    // An id is proven by comparing two ids, so a caller that states nothing and a
    // parent record that states no owner are both unprovable: the empty side is
    // never a wildcard. Reported as absent rather than forbidden, the same way a
    // cross-connection task read is — a distinct code would confirm the id exists.
    const owner = typeof parent.connectionId === 'string' && parent.connectionId !== '' ? parent.connectionId : null;
    const caller = typeof facts.connectionId === 'string' && facts.connectionId !== '' ? facts.connectionId : null;
    if (owner === null || caller === null || owner !== caller) throw this.absentContinuation(parentTaskId);
    if (!TERMINAL.has(parent.state)) {
      throw this.continuationRefusal('the named task is still running, so its conversation cannot be continued yet', {
        continueFromTaskId: parentTaskId,
        state: typeof parent.state === 'string' ? parent.state : 'no recorded end state',
        session: SESSION_CODES.continuationState,
      });
    }
    const conversation = parent.execution?.conversation ?? null;
    if (conversation === null || typeof conversation !== 'object') {
      // A run that ended without ever driving a session (an admission refusal, a
      // policy failure) has no thread; continuing it would silently start a new one.
      throw this.continuationRefusal('the named task ended without driving a conversation, so there is nothing to continue', {
        continueFromTaskId: parentTaskId,
        state: parent.state,
        session: SESSION_CODES.continuationState,
      });
    }
    if (typeof parent.sourcePath !== 'string' || parent.sourcePath === ''
      || typeof facts.sourcePath !== 'string' || facts.sourcePath === ''
      || !samePath(parent.sourcePath, facts.sourcePath)) {
      throw this.continuationRefusal('the named task belongs to another source repository, so its conversation was not continued', {
        continueFromTaskId: parentTaskId,
        reason: 'different source repository',
        session: SESSION_CODES.continuationWorkspaceMismatch,
      });
    }
    // The execution directory is the other half of a chain's identity: the parent's
    // conversation lives in the Workspace of the directory it ran in, and a live parent
    // keeps its exact directory even when it drove a managed worktree. Equal Workspace
    // ids are not enough — the same id two coordinates apart is a workspace the
    // follow-up did not inherit — and a masked directory cannot prove which one it names.
    const recordedExecution = parent.executionPath;
    const execution = facts.executionPath;
    if (recordedExecution !== undefined && recordedExecution !== null) {
      if (typeof recordedExecution !== 'string' || recordedExecution.trim() === ''
        || typeof execution !== 'string' || execution.trim() === ''
        || recordedPathIsMasked(recordedExecution) || recordedPathIsMasked(execution)) {
        throw this.continuationRefusal('the named task has no reliably recorded execution path, so its conversation cannot be continued', {
          continueFromTaskId: parentTaskId,
          reason: 'unusable recorded execution path',
          session: SESSION_CODES.continuationUnavailable,
        });
      }
      if (!samePath(recordedExecution, execution)) {
        throw this.continuationRefusal('the named task ran in another execution directory, so its conversation was not continued', {
          continueFromTaskId: parentTaskId,
          reason: 'different execution directory',
          session: SESSION_CODES.continuationPathMismatch,
        });
      }
    }
    return parent;
  }

  /**
   * Re-check the three facts that make a preflight step legal: not disposed, not
   * cancelled, and still authorized for exactly this task and source workspace.
   * @param {object} task - pending record.
   * @param {string} phase - the step that just completed.
   * @returns {void}
   */
  assertLive(task, phase) {
    if (this.aborted) {
      throw new JobError(JOB_CODES.disposed, 'the plugin was disposed while the task was starting', { phase });
    }
    if (task.cancelRequested || task.controller.signal.aborted) {
      throw new JobError(JOB_CODES.cancelled, `the task was cancelled during ${phase}`, {
        phase,
        reason: task.cancelledBy ?? 'request',
      });
    }
    if (task.authorization === 'switch' && this.delegationEnabled !== true) {
      throw new JobError(JOB_CODES.notAuthorized, 'delegation is disabled', { phase });
    }
    if (task.connectionId === null || task.grantId === null || task.sourcePath === null) return;
    try {
      this.auth.assertTaskAuthorized({
        connectionId: task.connectionId,
        grantId: task.grantId,
        taskId: task.taskId,
        workspacePath: task.sourcePath,
      });
    } catch (error) {
      throw new JobError(
        typeof error?.code === 'string' ? error.code : JOB_CODES.notAuthorized,
        diagnostic(error?.message ?? 'the authorization is no longer valid', 300) ?? 'the authorization is no longer valid',
        { phase, ...redactDeep(error?.details ?? {}) },
      );
    }
  }

  /**
   * Whether the task has been asked to stop.
   * @param {object} task - task record.
   * @returns {boolean} true when cancellation was requested.
   */
  isCancelled(task) {
    return task.cancelRequested === true || task.controller.signal.aborted === true;
  }

  /**
   * Whether a delegated run may be offered a per-call permission bridge.
   *
   * The question is capability, not configuration, and it is answered by the
   * deployment: a bridge is offered only when the entry point says it can surface
   * pending requests and accept a decision from a commander (`deps.permissionBridge`
   * is a function returning a bridge). A deployment without that seam keeps the
   * original fail-closed behaviour for every run, and nothing in this module
   * invents a second way to grant anything.
   * @returns {boolean} true when a bridge may be created for a run.
   */
  permissionBridgeAvailable() {
    return typeof this.deps?.permissionBridge === 'function' && this.aborted !== true;
  }

  /**
   * Create the permission bridge for one task, or `null`.
   *
   * The bridge belongs to the task and to the run inside it. Its observers are
   * wired here rather than in the runtime so the task record — not the runner —
   * owns the phase, the execution-time accounting and the evidence trail: those
   * are task lifecycle facts, and the runner has no authority over the budget.
   *
   * The factory is called with the exact facts the commander is later asked to
   * recognise: the task and the connection that owns it.
   * @param {object} task - the running task.
   * @returns {object | null} a bridge to arm, or null when unavailable.
   */
  createPermissionBridge(task) {
    if (!this.permissionBridgeAvailable()) return null;
    let bridge;
    try {
      bridge = this.deps.permissionBridge({
        taskId: task.taskId,
        connectionId: task.connectionId,
        onPending: (view) => this.onPermissionPending(task, view),
        onSettled: (entry) => this.onPermissionSettled(task, entry),
      });
    } catch (error) {
      // A factory that cannot produce a bridge is the same operator situation as a
      // deployment without the seam: the run keeps `never` and is not failed for
      // it. The refusal is logged rather than surfaced as a task error, because
      // "approvals are not bridged here" is a property of the deployment.
      this.deps?.logger?.warn?.('dsh-delegate: the per-call permission bridge could not be created', String(error?.code ?? ''));
      return null;
    }
    if (bridge === null || bridge === undefined || typeof bridge !== 'object' || typeof bridge.arm !== 'function') {
      return null;
    }
    return bridge;
  }

  /**
   * Record one request the worker is now waiting on.
   *
   * The task state stays `running` and only its PHASE changes, so nothing that
   * reads the state contract has to learn a new lifecycle value: a task waiting for
   * a decision is neither failed nor execution-complete, and its workspace lock,
   * concurrency slot and provider lease remain its own.
   *
   * The wait is NOT charged to the execution budget. The runner's own timer does
   * not observe it (the native tool call is paused, not the run), and the request
   * carries a separate bounded deadline of its own, so a paused call can never
   * turn into a timeout of the work.
   * @param {object} task - the running task.
   * @param {object} view - the bridge's redacted request view.
   * @returns {void}
   */
  onPermissionPending(task, view) {
    if (TERMINAL.has(task.state)) return;
    task.permission.pending = view;
    task.permission.pausedAt = Date.now();
    if (task.state === TASK_STATES.running) task.phase = PHASE_AWAITING_PERMISSION;
    // Durable checkpoint: a crash while the worker is PAUSED is exactly the case the
    // in-memory record cannot describe after a restart, so the pending request is
    // written now rather than only at terminal time.
    this.checkpointHistory(task);
  }

  /**
   * Record one settled request and account for the time spent waiting.
   * @param {object} task - the task the request belonged to.
   * @param {object} entry - the bridge's redacted settled view.
   * @returns {void}
   */
  onPermissionSettled(task, entry) {
    if (task.permission.pending !== null && entry?.requestId === task.permission.pending.requestId) {
      task.permission.pending = null;
    }
    if (task.permission.pausedAt !== null) {
      task.permission.pausedExecutionMs += Math.max(0, Date.now() - task.permission.pausedAt);
      task.permission.pausedAt = null;
    }
    if (entry !== null && entry !== undefined) {
      task.permission.evidence.push(entry);
      if (task.permission.evidence.length > 8) task.permission.evidence.shift();
    }
    // Back to the execution phase, never to a new state: a settled request that was
    // allowed and one that was rejected both leave the task `running` until the run
    // itself reaches an outcome.
    if (task.state === TASK_STATES.running && task.phase === PHASE_AWAITING_PERMISSION) {
      task.phase = PHASE_EXECUTE;
    }
    this.checkpointHistory(task);
  }

  /**
   * Write a bounded, fire-and-forget history checkpoint for a LIVE task.
   *
   * Three deliberate properties:
   *
   *  * it is **serialized by the store**, so a pending checkpoint cannot interleave
   *    with the terminal write — the documents are whole-file atomic writes and one
   *    save runs at a time;
   *  * it **cannot resurrect a terminal task**: `HistoryStore` refuses to overwrite a
   *    terminal record with a live one, and this method re-checks the task's own state
   *    before the write lands, so a slow checkpoint that finishes after the run ended
   *    is dropped instead of rolling the record back to `running`;
   *  * it is **bounded and silent**. It shares `HISTORY_WRITE_TIMEOUT_MS`, records a
   *    failure as `historyError` and never rejects upward: a checkpoint is evidence,
   *    not a step the run depends on.
   * @param {object} task - live task record.
   * @returns {void}
   */
  checkpointHistory(task) {
    const history = this.history;
    if (history === null || history === undefined || typeof history.save !== 'function') return;
    if (TERMINAL.has(task.state)) return;
    let view;
    try {
      view = this.view(task);
    } catch {
      return;
    }
    // A save that is already queued for a NEWER snapshot wins; an older one is
    // discarded rather than allowed to publish a stale phase.
    this.historyCheckpointSeq = (this.historyCheckpointSeq ?? 0) + 1;
    task.historyCheckpointSeq = this.historyCheckpointSeq;
    const seq = this.historyCheckpointSeq;
    let timer = null;
    const bounded = new Promise((resolvePromise, rejectPromise) => {
      timer = setTimeout(() => {
        rejectPromise(new JobError(JOB_CODES.historyFailed, 'the history checkpoint exceeded its time budget', {
          code: 'HISTORY_WRITE_TIMEOUT',
          timeoutMs: HISTORY_WRITE_TIMEOUT_MS,
        }));
      }, HISTORY_WRITE_TIMEOUT_MS);
      timer.unref?.();
      Promise.resolve(history.save(view)).then(resolvePromise, rejectPromise);
    });
    void bounded
      .then(() => {
        // A LATER snapshot OF THIS SAME TASK has superseded this one. The counter is
        // global, so `this.historyCheckpointSeq` would let a concurrent task's
        // checkpoint discard this task's own successful write (and leave the
        // bookkeeping fields stale); the comparison is per task, against the
        // sequence this task last claimed.
        if (task.historyCheckpointSeq !== seq) return;
        // The run ended while this write was in flight: the terminal record is the
        // truth, and a live snapshot must never overwrite it.
        if (TERMINAL.has(task.state)) return;
        task.historyError = null;
        task.historySavedAt = Date.now();
      })
      .catch((error) => {
        task.historyError = {
          code: typeof error?.code === 'string' ? error.code : JOB_CODES.historyFailed,
          message: diagnostic(error?.message ?? error, 300),
        };
      })
      .finally(() => {
        if (timer !== null) clearTimeout(timer);
      });
  }

  /**
   * Decide one pending permission request for one task.
   *
   * This is the commander's only way to answer, and it is shaped like every other
   * refusal in this class: the identity comes from the authenticated caller, the
   * task owner is checked before anything is read, and an id this deployment cannot
   * prove belongs to the caller is answered as absent so the reply cannot be used
   * to discover other tasks.
   *
   * The chain of checks, all refusals:
   *
   *  1. the task exists and belongs to the deciding connection (a foreign task is
   *     `JOB_TASK_NOT_FOUND`, identical to an unknown one);
   *  2. delegation is still authorized and this task's own authorization is still
   *     valid (a switch turned off or a revoked grant stops the decision);
   *  3. the task is live and has a bridge with an outstanding request;
   *  4. the bridge decides the request — still pending, not past its deadline, and
   *     the fingerprint (when supplied) matching the bound operation exactly;
   *  5. only then does the outcome travel to the paused native tool call.
   *
   * The decision is NOT acceptance and NOT a standing grant: the task keeps
   * running afterwards, `selfApproved` stays false, and the Session's sandbox mode
   * is untouched.
   * @param {object} request - `taskId`, `requestId`, `decision`, optional `reason`,
   *   optional `fingerprint`, and the authenticated `connectionId` (supplied by the
   *   plane, never by the caller's body).
   * @returns {object} bounded result: `{ task, permission, hostAcceptance: null }`.
   * @throws {JobError} on any refusal.
   */
  decidePermission(request) {
    const connectionId = typeof request?.connectionId === 'string' ? request.connectionId : null;
    if (connectionId === null) {
      // No verified identity means no ownership proof, which is the same answer an
      // unknown task gets — never a discovery oracle.
      throw new JobError(JOB_CODES.taskNotFound, 'no such task for this connection', {});
    }
    const taskId = typeof request?.taskId === 'string' ? request.taskId.trim() : '';
    if (taskId === '') {
      throw new JobError(PERMISSION_CODES.invalid, 'taskId is required', { field: 'taskId' });
    }
    const task = this.tasks.get(taskId);
    if (task === undefined || task.connectionId !== connectionId) {
      throw new JobError(JOB_CODES.taskNotFound, 'no such task for this connection', { taskId });
    }
    if (TERMINAL.has(task.state)) {
      throw new JobError(PERMISSION_CODES.notPending, 'this task has already ended; its pending request is history only', {
        taskId,
        state: task.state,
      });
    }
    // The authorization is re-checked at the decision, not only at submission: an
    // operator who closed the switch or revoked the authorization between the ask
    // and the decision must not have a live decision applied afterwards.
    if (this.posture().authorized !== true) {
      throw new JobError(JOB_CODES.notAuthorized, 'delegation is no longer authorized, so no decision may be applied', {});
    }
    this.assertLive(task, 'permission-decide');
    const bridge = task.permission.bridge;
    if (bridge === null || bridge === undefined || typeof bridge.decide !== 'function') {
      throw new JobError(PERMISSION_CODES.notFound, 'this task has no pending permission request', { taskId });
    }
    let settled;
    try {
      settled = bridge.decide({
        requestId: request?.requestId,
        decision: request?.decision,
        reason: request?.reason,
        ...(request?.fingerprint === undefined ? {} : { fingerprint: request.fingerprint }),
      });
    } catch (error) {
      if (error instanceof PermissionError) {
        throw new JobError(error.code, error.message, error.details);
      }
      throw error;
    }
    return { task: this.view(task), permission: settled, hostAcceptance: null };
  }

  /**
   * Stop every outstanding request of one task and disarm its bridge.
   *
   * Called from every path that ends a run — a terminal state, cancellation,
   * switch-off, revocation, disposal — so a paused native tool call is released
   * instead of outliving the reason it was paused. The bridge is disposed LAST, so
   * the outstanding request is first settled with the right cause (`cancelled` for
   * a stop, `unavailable` for a disposal) and only then does the answerer go away.
   * @param {object} task - task record.
   * @param {string} [cause] - `stop` (default) or `dispose`.
   * @returns {void}
   */
  releasePermissionBridge(task, cause = 'stop') {
    const bridge = task.permission?.bridge ?? null;
    if (bridge === null || bridge === undefined) return;
    try {
      if (cause === 'dispose') bridge.dispose?.();
      else bridge.stop?.();
    } catch (error) {
      this.deps?.logger?.warn?.('dsh-delegate: the permission bridge could not be stopped', String(error?.code ?? ''));
    }
    if (task.permission.pending !== null) task.permission.pending = null;
    task.permission.pausedAt = null;
    if (cause === 'dispose') task.permission.bridge = null;
  }

  /**
   * The bounded, public permission block of one task.
   *
   * `pending` is the request the commander has to decide (or `null`), `evidence` is
   * the settled trail, and `bridged`/`waiting` are stated so a client never has to
   * infer them from a phase string. `pausedExecutionMs` is reported because it is
   * the time that was NOT charged to the execution budget — an operator reading a
   * long run should be able to see how much of it was spent waiting for a decision.
   * @param {object} task - task record.
   * @returns {object} redacted permission view.
   */
  permissionView(task) {
    const pending = task.permission?.pending ?? null;
    return {
      bridged: task.permission?.bridge !== null && task.permission?.bridge !== undefined,
      waiting: pending !== null,
      pending,
      evidence: Array.isArray(task.permission?.evidence) ? task.permission.evidence : [],
      pausedExecutionMs: task.permission?.pausedExecutionMs ?? 0,
      // Stated on every view, because it is the property the whole feature turns
      // on: a decision applies to one call and never to the standing policy.
      standingSandboxMode: DELEGATE_SANDBOX_MODE,
      grantScope: 'single-call',
    };
  }

  /**
   * Request cancellation of one live task and record why.
   *
   * The task's outstanding permission request is withdrawn FIRST (if it has one),
   * so the paused native tool call observes a cancelled question instead of a
   * controller abort it would learn about only after the tool returned. The
   * workspace lock, the concurrency slot and the provider lease are untouched here:
   * they are released by {@link finalize}, and only once the executor confirms it
   * stopped — a wait that was interrupted by a cancel is still a live executor.
   * @param {object} task - task record.
   * @param {string} reason - recorded provenance.
   * @returns {void}
   */
  abortTask(task, reason) {
    if (TERMINAL.has(task.state)) return;
    // The CAUSE decides how the outstanding request is settled, and only the
    // dispose path reports the channel as unusable: a plugin teardown must not be
    // dressed up as "the operator withdrew the question". A later explicit
    // `releasePermissionBridge(task, 'dispose')` is idempotent, so disposing here
    // does not double-settle.
    this.releasePermissionBridge(task, reason === 'dispose' ? 'dispose' : 'stop');
    task.cancelRequested = true;
    task.cancelledBy = task.cancelledBy ?? reason;
    try {
      task.controller.abort();
    } catch {
      // AbortController.abort() does not throw; kept for defence in depth.
    }
  }

  /**
   * Handle one authorization invalidation event.
   * @param {object} event - `kind`, optional `grantId`/`connectionId`, `reason`.
   * @returns {void}
   */
  onAuthorizationInvalidated(event) {
    if (this.aborted) return;
    const reason = `authorization:${typeof event?.reason === 'string' ? event.reason : 'revoked'}`;
    for (const task of this.tasks.values()) {
      if (TERMINAL.has(task.state)) continue;
      if (!matchesInvalidation(task, event)) continue;
      this.abortTask(task, reason);
    }
  }

  /**
   * Drive one admitted task to a terminal state.
   * @param {object} task - admitted task.
   * @returns {void}
   */
  drive(task) {
    void this.execute(task)
      .catch((error) => {
        // execute() already records failures; this guards against a programming
        // error escaping an already-settled task.
        if (task.state === TASK_STATES.running || task.state === TASK_STATES.pending) {
          task.state = TASK_STATES.failed;
          task.error = task.error ?? { code: JOB_CODES.internal, message: diagnostic(error?.message ?? error) };
          task.endedAt = Date.now();
        }
      })
      .finally(() => task.settle());
  }

  /**
   * Record a failed admission: the slot and every lease are released, the record
   * becomes terminal, and nothing is created. A consumed grant stays consumed,
   * and a tree that was created before the refusal is marked complete and kept.
   * @param {object} task - pending record.
   * @param {unknown} error - the refusal that ended admission.
   * @returns {Promise<void>} resolves once the refused task's capacity is returned.
   */
  async failAdmission(task, error) {
    this.clearPreflightDeadline(task);
    // Admission never created an executor, so any bridge it did create (it is
    // created just before the runner call, so normally none) is disposed here too.
    this.releasePermissionBridge(task, 'dispose');
    task.endedAt = task.endedAt ?? Date.now();
    // A preflight that ran out of budget is a timeout, not a cancellation: it is
    // the same budget the run itself would have failed on, and reporting it as
    // "cancelled" would hide that nobody asked to stop it.
    const timedOut = error?.code === JOB_CODES.timeout || (task.preflightTimedOut === true && this.isCancelled(task));
    const cancelled = !timedOut
      && (this.aborted || this.isCancelled(task)
        || error?.code === JOB_CODES.cancelled || error?.code === JOB_CODES.disposed);
    if (!TERMINAL.has(task.state)) {
      task.state = cancelled ? TASK_STATES.cancelled : TASK_STATES.failed;
      if (cancelled) {
        task.cancelledBy = task.cancelledBy ?? (this.aborted ? 'dispose' : 'request');
        task.error = null;
      } else {
        task.error = this.errorOf(error, task);
      }
    }
    // A tree prepared before the refusal is evidence, not garbage: it is kept and
    // marked complete so the host can inspect or dispose it explicitly. Both that
    // and the lease release are done by {@link finalize}, which is the single
    // release path for every exit. Admission failed before any native executor
    // existed, so the slot is returned immediately rather than staying occupied by
    // a record that will never run.
    await this.finalize(task);
    // A refused task is a failed task: the history document records it on the same
    // terms as a failed run, so an operator can see that a grant was spent and no
    // work was produced.
    await this.persistHistory(task);
    task.settle();
  }

  /**
   * Project a thrown refusal into a bounded task error.
   *
   * A session-placement refusal is also handled here, not only in the execution
   * path: `start()` raises these during admission, and reporting one as a generic
   * `JOB_START_FAILED` would hide the one code an operator can act on. A
   * continuation refusal keeps its `SESSION_*` cause in `details.session`.
   * @param {unknown} error - thrown value.
   * @param {object} [task] - the task record, when the error belongs to one.
   * @returns {object} error record.
   */
  errorOf(error, task = null) {
    if (error instanceof SessionPlacementRefusal && task !== null) {
      return this.conversationErrorOf(error, task);
    }
    return {
      code: typeof error?.code === 'string' ? error.code : JOB_CODES.failed,
      message: diagnostic(error?.message ?? String(error), 400) ?? 'the task could not start',
      details: redactDeep(error?.details ?? {}),
    };
  }

  /**
   * Shape one session-placement refusal into the task error an operator reads.
   * @param {object} error - placement refusal.
   * @param {object} task - the task the refusal belongs to.
   * @returns {{ code: string, message: string, details: object }} bounded error.
   */
  conversationErrorOf(error, task) {
    const continuation = task?.continueFromTaskId ?? null;
    return {
      code: continuation === null ? JOB_CODES.conversationUnavailable : JOB_CODES.continuationRefused,
      message: error.message,
      details: {
        session: error.code,
        ...(continuation === null ? {} : { continueFromTaskId: continuation }),
        ...redactDeep(error.details ?? {}),
      },
    };
  }

  /**
   * Map any admission refusal onto a job refusal for the caller.
   * @param {unknown} error - thrown value.
   * @returns {JobError} refusal to throw.
   */
  admissionError(error) {
    if (error instanceof JobError) return error;
    const code = typeof error?.code === 'string' ? error.code : null;
    if (error instanceof AuthError || (code !== null && code.startsWith('GRANT_'))) {
      return new JobError(code ?? JOB_CODES.notAuthorized, diagnostic(error?.message ?? 'authorization refused', 300)
        ?? 'authorization refused', redactDeep(error?.details ?? {}));
    }
    if (code !== null) {
      return new JobError(code, diagnostic(error?.message ?? 'the task could not start', 300)
        ?? 'the task could not start', redactDeep(error?.details ?? {}));
    }
    return new JobError(JOB_CODES.startFailed, diagnostic(error?.message ?? 'the task could not start', 300)
      ?? 'the task could not start', {});
  }

  /**
   * Release every lease this task holds, newest first.
   * @param {object} task - task record.
   * @returns {void}
   */
  releaseLeases(task) {
    while (task.leases.length > 0) {
      const lease = task.leases.pop();
      try {
        this.locks.release(lease.path, lease.nonce);
      } catch {
        // Releasing a lease we no longer hold is a no-op by design.
      }
    }
  }

  /**
   * Execute one admitted task end to end. Records failures on the task; never throws.
   * @param {object} task - task record.
   * @returns {Promise<void>} resolves when the task reaches a terminal state.
   */
  async execute(task) {
    // A task cancelled or revoked while it was being handed over is never
    // published as `running`: the operator asked for it to stop, so it must not
    // appear to have started afterwards.
    if (!this.isCancelled(task)) {
      task.state = TASK_STATES.running;
      task.phase = 'execute';
      task.startedAt = Date.now();
    }
    try {
      const workerSelection = {
        // The public profile id stays the operator-facing identity; the native
        // route is a separate fact the registry produced.
        providerId: task.effective.worker.providerId,
        providerRoute: task.route.providerRoute,
        model: task.route.model,
        reasoningEffort: task.route.reasoningEffort,
      };
      const prompt = buildWorkerPrompt({
        taskId: task.taskId,
        prompt: task.prompt,
        workspacePath: task.executionPath,
        isolation: task.effective.worker.isolation,
        baseline: task.baseline,
      });

      // The last gate before a native agent exists. Everything above awaited at
      // least once; this re-check runs in the same step as the creation call.
      task.phase = 'before-create';
      this.assertLive(task, 'before-create');

      // The native executor comes into existence here. `started` is recorded
      // before the call and `settled` only once its promise has settled, on
      // success and on failure alike, so {@link finalize} can tell "no executor
      // was ever created" from "an executor may still be writing to the
      // workspace". Nothing below may release a lease or the slot before the
      // matching `settled` is true.
      //
      // The permission bridge is created BEFORE the executor exists (it is bound
      // in the run's setup, so the runtime also sees it) and is the answerer the
      // policy stance is installed for. A bridge is offered only when this
      // deployment can surface its requests to a commander at all; when it cannot,
      // the run keeps the fail-closed `never` stance and nothing about it changes.
      const bridge = this.createPermissionBridge(task);
      task.permission.bridge = bridge;
      task.native.started = true;
      const pending = runAgent(this.deps, {
        prompt,
        cwd: task.executionPath,
        selection: workerSelection,
        timeoutMs: task.effective.worker.timeoutSeconds * 1000,
        signal: task.controller.signal,
        // What this run does with its DSH conversation, frozen on the task at
        // creation: omitted means a new conversation, present means continue exactly
        // that task's thread. There is no directory-level mode to consult, so a
        // settings edit (or a legacy `reuse` value) cannot change it mid-run.
        ...(task.continueFromTaskId === null ? {} : { continueFromTaskId: task.continueFromTaskId }),
        // The task/connection/source facts a continuation identity must match.
        taskId: task.taskId,
        connectionId: task.connectionId,
        sourcePath: task.sourcePath,
        // Worker sessions are writable only inside their current DSH workspace.
        // Wider sandbox requests are refused when no bridge is armed, and decided
        // per call by the commander when one is. The services that own both facts
        // are read live through `deps.policyServices`, so the runner verifies the
        // resolved policy before it prompts.
        delegated: true,
        // The per-call approval answerer for THIS task's own Agent: armed in the
        // run's setup, scanned by the engine before it is offered here, and
        // disposed when the run ends. `null` keeps the deterministic `never` stance.
        ...(bridge === null ? {} : { permissionBridge: bridge }),
        configureDelegatedSession: this.deps.configureDelegatedSession,
        policyServices: this.deps.policyServices,
        // The engine is the authority for "may this chain be joined": a parent it
        // still holds is judged live here, and a parent recovered from the persisted
        // map is judged by the same rule through this hook.
        assertAdmissible: (parentTaskId) => this.assertAdmissible(parentTaskId, {
          sourcePath: task.sourcePath,
          // The directory this run actually executes in: the parent's own managed tree
          // when this task continues an isolated chain, the source checkout otherwise.
          executionPath: task.executionPath,
          connectionId: task.connectionId,
          selfTaskId: task.taskId,
        }),
      });
      task.native.promise = pending;
      let run;
      try {
        run = await pending;
      } finally {
        task.native.settled = true;
      }

      task.execution = {
        workspacePath: task.executionPath,
        outcome: run.outcome,
        text: run.text,
        reasoningOnly: run.reasoningOnly,
        usage: run.usage,
        turnEnd: run.turnEnd,
        agentId: run.agentId,
        sessionId: run.sessionId,
        // The provider/model/effort the run actually installed on the agent it
        // drove, plus the output budget it requested. Reported because a placed
        // run does not create its agent through `agents.create`, so `agentOptions`
        // is not observable for it — and "which model did this run on" must still
        // be answerable from the task record.
        selection: run.selection ?? null,
        maxTokens: run.maxTokens ?? null,
        // The approval stance this run installed and read back, plus whether an
        // armed bridge was the answerer behind it. Recorded per run so "did this
        // task ask, or did it reject without asking" is answerable from the record.
        approval: run.approval ?? null,
        // Where the conversation landed. Reported per run so an operator can tell a
        // fresh session from a continued one, and which Workspace group it is in.
        conversation: run.conversation ?? null,
        cancelCause: run.cancelCause,
        error: run.error,
      };

      // Remember the thread this run drove, keyed by THIS task, so a later explicit
      // `continueFromTaskId` follow-up can continue exactly that conversation in
      // exactly this execution path. Only identity and provenance are stored; the
      // transcript stays in the native session log. A failure here is recorded and
      // never changes the run's outcome.
      await this.rememberConversation(task);

      // Evidence is captured even for a failed or cancelled run: a partial
      // change still needs to be visible to the host.
      task.diff = await captureDiff(this.deps, task.executionPath, task.baseline).catch((error) => ({
        error: {
          code: error?.code ?? 'AUDIT_FAILED',
          message: diagnostic(error?.message ?? error, 300),
        },
        files: [],
        fileCount: 0,
        patchText: '',
        patchTruncated: false,
      }));

      if (run.outcome === RUN_OUTCOMES.cancelled || this.isCancelled(task)) {
        this.finishCancelled(task);
        return;
      }
      if (run.outcome === RUN_OUTCOMES.timedOut) {
        task.state = TASK_STATES.failed;
        task.error = { code: JOB_CODES.timeout, message: 'the task exceeded its time budget' };
        task.endedAt = Date.now();
        return;
      }
      if (run.outcome !== RUN_OUTCOMES.completed) {
        task.state = TASK_STATES.failed;
        // Three endings that are not completion, kept apart because they need
        // different fixes:
        //  * the model was stopped by its own output budget (`max-tokens`) — raise
        //    the budget;
        //  * an agent-reported error — investigate the provider;
        //  * silence — investigate the run.
        // The budget ending is tested by the turn record, not by the runner's
        // message: the runner states a diagnostic for that case too, and reading the
        // message first would turn a settings change into a provider investigation.
        // A reasoning-only run never reaches this branch at all — the runner counts
        // reasoning as output, so it completes.
        const budgetExhausted = run.turnEnd?.reason === 'max-tokens';
        const reported = run.error !== null && run.error !== undefined;
        const code = budgetExhausted
          ? JOB_CODES.outputTruncated
          : (reported ? JOB_CODES.executionFailed : JOB_CODES.noOutput);
        task.error = {
          code,
          message: budgetExhausted
            ? 'the delegated run stopped at its output token budget before producing an answer'
            : (reported ? run.error : 'the delegated run produced no output'),
          ...(budgetExhausted
            ? { details: { turnEnd: run.turnEnd ?? null, usage: run.usage ?? null } }
            : {}),
        };
        task.endedAt = Date.now();
        return;
      }

      // Review runs only for a completed execution, and only when enabled. Its
      // route was frozen during preflight; nothing here re-reads settings.
      task.phase = 'review';
      task.review = await this.runReview(task);

      // A cancellation or revocation during the review makes the task terminal
      // cancelled. It must never be reported as awaiting host review, because
      // nothing was reviewed to completion.
      if (this.isCancelled(task) || task.review.state === REVIEW_STATES.cancelled) {
        this.finishCancelled(task, task.review.state === REVIEW_STATES.cancelled ? 'review-cancelled' : null);
        return;
      }

      task.state = TASK_STATES.awaitingHostReview;
      task.phase = 'awaiting-host-review';
      task.endedAt = Date.now();
    } catch (error) {
      if (this.isCancelled(task)) {
        this.finishCancelled(task);
        return;
      }
      task.state = TASK_STATES.failed;
      task.phase = 'failed';
      task.error = this.runErrorOf(error, task);
      task.endedAt = Date.now();
    } finally {
      await this.finishTask(task);
    }
  }

  /**
   * Shape any thrown value from the EXECUTION path into the bounded error record.
   *
   * A session-placement refusal keeps its own `SESSION_*` code as a detail and is
   * reported as the job-level `JOB_CONVERSATION_UNAVAILABLE` — or, when the run was
   * a `continueFromTaskId` follow-up, `JOB_CONTINUATION_REFUSED` — because the cause
   * an operator needs is "this harness cannot place the run in a Workspace" or "this
   * thread cannot be continued", not the name of the missing service. It is never
   * mapped onto a generic execution failure: the run did not fail, it never started.
   * @param {unknown} error - thrown value.
   * @param {object} [task] - the task record, when the error belongs to one.
   * @returns {{ code: string, message: string, details?: object }} bounded error.
   */
  runErrorOf(error, task = null) {
    if (error instanceof SessionPlacementRefusal) return this.conversationErrorOf(error, task ?? {});
    if (error instanceof RunError) {
      return { code: error.code, message: error.message, details: redactDeep(error.details ?? null) };
    }
    return {
      code: typeof error?.code === 'string' ? error.code : JOB_CODES.internal,
      message: diagnostic(error?.message ?? error, 300),
    };
  }

  /**
   * Make a cancelled task terminal and preserve its provenance.
   * @param {object} task - task record.
   * @param {string | null} [fallback] - provenance to record when nothing else did.
   * @returns {void}
   */
  finishCancelled(task, fallback = null) {
    task.state = TASK_STATES.cancelled;
    task.phase = 'cancelled';
    task.cancelledBy = task.cancelledBy ?? fallback ?? (task.cancelRequested ? 'request' : 'agent');
    task.endedAt = Date.now();
  }

  /**
   * Settle a terminal task: release its capacity (slot and leases) through the
   * single idempotent {@link finalize} path, then resolve its settlement promise.
   *
   * `finalize` is what decides whether the release is legal: it declines while a
   * native executor may still be writing, and records that refusal on the task.
   * @param {object} task - terminal task.
   * @returns {Promise<void>} resolves after bookkeeping.
   */
  async finishTask(task) {
    task.hostAcceptance = null;
    this.clearPreflightDeadline(task);
    // The run is over, so its answerer must go: an outstanding request is released
    // (the worker's paused tool call resumes `unavailable`) and the bridge can never
    // answer a request that outlived the run it belonged to.
    this.releasePermissionBridge(task, 'dispose');
    await this.finalize(task);
    await this.persistHistory(task);
    task.settle();
  }

  /**
   * Persist one terminal task's public view to the durable history store.
   *
   * Three deliberate properties:
   *
   *   * The *view* is what is stored, so the history document inherits every
   *     redaction the projection already applies — there is no second
   *     serializer that could forget one.
   *   * The write is bounded. A wedged data directory must not keep a terminal
   *     task's cleanup pending, so exceeding the bound is recorded on the task as
   *     `historyError` instead of being swallowed or retried forever.
   *   * A missing store is not an error. Running without durable history is a
   *     supported posture (the engine never reads history back to decide
   *     anything), so `history === null` is silent while a *failing* store is loud.
   * @param {object} task - terminal task record.
   * @returns {Promise<void>} resolves after the attempt, never rejects.
   */
  async persistHistory(task) {
    const history = this.history;
    if (history === null || history === undefined || typeof history.save !== 'function') return;
    let timer = null;
    try {
      const view = this.view(task);
      const bounded = new Promise((resolvePromise, rejectPromise) => {
        timer = setTimeout(() => {
          rejectPromise(new JobError(JOB_CODES.historyFailed, 'the job history write exceeded its time budget', {
            code: 'HISTORY_WRITE_TIMEOUT',
            timeoutMs: HISTORY_WRITE_TIMEOUT_MS,
          }));
        }, HISTORY_WRITE_TIMEOUT_MS);
        timer.unref?.();
        Promise.resolve(history.save(view)).then(resolvePromise, rejectPromise);
      });
      await bounded;
      task.historyError = null;
      task.historySavedAt = Date.now();
    } catch (error) {
      // Recorded, not thrown: a history failure must not turn a completed task
      // into a failed one, and it must not escape into the release path.
      task.historyError = {
        code: typeof error?.code === 'string' ? error.code : JOB_CODES.historyFailed,
        message: diagnostic(error?.message ?? error, 300),
      };
      task.historySavedAt = null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Persist the minimal task-thread identity a later `continueFromTaskId` needs.
   *
   * Four deliberate properties, mirroring {@link persistHistory}:
   *
   *   * the row is keyed by TASK, and holds only what a continuation is validated
   *     against — the two paths, the DSH Workspace/Session ids, the isolation that
   *     was used and (for a managed tree) that tree's ownership facts. No prompt,
   *     transcript, output, usage figure or credential has a field;
   *   * a failure is recorded on the task (`conversationError`) instead of thrown,
   *     because losing the ability to *continue* this thread later is not a reason
   *     to fail or un-finish the run that just succeeded;
   *   * a missing store is silent: an engine constructed without one simply cannot
   *     offer continuation, which is the safe default;
   *   * an unplaced run (the additional review) records nothing, because it is not
   *     part of the worker thread and must not become continuable.
   * @param {object} task - task record with a completed `task.execution`.
   * @returns {Promise<void>} resolves after the attempt, never rejects.
   */
  async rememberConversation(task) {
    const store = this.deps?.sessionStore ?? null;
    const placement = task.execution?.conversation ?? null;
    if (store === null || store === undefined || placement === null) return;
    const worktree = task.worktree === null || task.worktree === undefined ? null : task.worktree;
    try {
      const saved = await rememberSession(store, {
        workspaceId: placement.workspaceId,
        sessionId: placement.sessionId,
      }, {
        taskId: task.taskId,
        sourcePath: task.sourcePath,
        executionPath: task.executionPath,
        isolation: task.effective?.worker?.isolation ?? null,
        // A worktree row carries the tree's identity so a follow-up can prove it is
        // reusing the same tree instead of a fresh one.
        worktreeId: worktree === null
          ? null
          : (typeof worktree.worktreeId === 'string' && worktree.worktreeId !== ''
            ? worktree.worktreeId
            : (typeof worktree.taskId === 'string' ? worktree.taskId : task.taskId)),
        worktreeState: worktree === null ? null : (typeof worktree.state === 'string' ? worktree.state : null),
      });
      task.conversationSaved = saved;
      task.conversationError = null;
    } catch (error) {
      task.conversationSaved = false;
      task.conversationError = {
        code: typeof error?.code === 'string' ? error.code : 'CONVERSATION_SAVE_FAILED',
        message: diagnostic(error?.message ?? error, 300),
      };
    }
  }

  /**
   * Mark a prepared tree complete and record its final metadata.
   *
   * The tree is kept, never deleted and never merged: it is the evidence a host
   * reviews, and an unreviewed deletion would destroy the only proof of what the
   * run changed. A tree that cannot be marked stays recorded with the reason, so
   * the host can still review or dispose of it explicitly.
   * @param {object} task - task record holding a prepared tree.
   * @returns {void}
   */
  completeWorktree(task) {
    if (task.worktree === null || task.executionPath === null) return;
    if (task.worktreeCompleted === true) return;
    task.worktreeCompleted = true;
    const manager = this.deps?.worktrees;
    if (typeof manager?.markComplete !== 'function') return;
    try {
      const metadata = manager.markComplete(task.executionPath);
      if (metadata !== null && typeof metadata === 'object') {
        task.worktree = { ...task.worktree, ...metadata };
      }
    } catch (error) {
      task.worktree = {
        ...task.worktree,
        markCompleteError: {
          code: typeof error?.code === 'string' ? error.code : 'WORKTREE_MARK_FAILED',
          message: diagnostic(error?.message ?? error, 300),
        },
      };
    }
  }

  /**
   * Run the optional independent review against the frozen review route.
   * @param {object} task - completed-execution task.
   * @returns {Promise<object>} review record.
   */
  async runReview(task) {
    if (task.effective.review.enabled !== true) {
      return { state: REVIEW_STATES.disabled, verdict: null, text: '', error: null };
    }
    if (task.reviewRouteError !== null) {
      // A review routing failure is a review failure, not a task failure, and it
      // is never an approval.
      return {
        state: REVIEW_STATES.failed,
        verdict: null,
        text: '',
        error: task.reviewRouteError,
        denials: [],
        selection: reviewSelection(task.effective.review, null),
      };
    }
    const route = task.reviewRoute;
    if (route === null) {
      return {
        state: REVIEW_STATES.failed,
        verdict: null,
        text: '',
        error: {
          code: 'REVIEW_ROUTING_REFUSED',
          message: 'the review route was not confirmed before execution',
          cause: null,
        },
        denials: [],
        selection: reviewSelection(task.effective.review, null),
      };
    }
    if (this.isCancelled(task)) {
      return {
        state: REVIEW_STATES.cancelled,
        verdict: null,
        text: '',
        error: { code: 'REVIEW_CANCELLED', message: 'the additional review was cancelled before it started' },
        denials: [],
        selection: reviewSelection(task.effective.review, route),
      };
    }
    const prompt = buildReviewPrompt({
      taskId: task.taskId,
      taskPrompt: task.prompt,
      workerSummary: task.execution?.text ?? '',
      evidence: task.diff,
    });
    const result = await reviewWork(this.deps, {
      taskId: task.taskId,
      cwd: task.executionPath,
      selection: {
        // The public id is what an operator recognises; the native route is
        // carried alongside it and is not disguised as a profile id.
        providerId: task.effective.review.providerId,
        providerRoute: route.providerRoute,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
      },
      prompt,
      evidence: task.diff,
      timeoutMs: Math.min(task.effective.worker.timeoutSeconds, 1800) * 1000,
      // Cancellation and revocation reach the reviewer through the same signal.
      signal: task.controller.signal,
    });
    return {
      state: result.state,
      verdict: result.verdict,
      text: result.text ?? '',
      error: result.error ?? null,
      denials: result.denials ?? [],
      denialsDelivered: (result.denials ?? []).length,
      selection: result.selection ?? reviewSelection(task.effective.review, route),
    };
  }

  /**
   * Request cancellation of one task.
   * @param {string} taskId - task to cancel.
   * @param {string} reason - recorded provenance.
   * @returns {Promise<object>} the task view.
   */
  async cancel(taskId, reason = 'request') {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new JobError(JOB_CODES.taskNotFound, 'no such task', { taskId });
    if (TERMINAL.has(task.state)) return this.view(task);
    this.abortTask(task, reason);
    // Give the run a bounded window to observe the cancellation and clean up.
    await Promise.race([
      task.settled ?? Promise.resolve(),
      new Promise((resolvePromise) => { setTimeout(resolvePromise, SETTLE_TIMEOUT_MS).unref?.(); }),
    ]);
    return this.view(task);
  }

  /**
   * Read one task.
   * @param {string} taskId - task id.
   * @param {object} [options] - `includePrompt` adds the prompt text.
   * @returns {object} task view.
   */
  get(taskId, options = {}) {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new JobError(JOB_CODES.taskNotFound, 'no such task', { taskId });
    return this.view(task, options);
  }

  /**
   * List tasks, optionally filtered by connection.
   * @param {object} [options] - `connectionId`.
   * @returns {object[]} task views, newest first.
   */
  list(options = {}) {
    const out = [];
    for (const task of this.tasks.values()) {
      if (options.connectionId !== undefined && task.connectionId !== options.connectionId) continue;
      out.push(this.view(task));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Public projection of one task.
   *
   * The projection is structural, not incidental: no credential, no provider
   * endpoint, and no un-redacted text leaves this method. `workspacePath` is the
   * path the work actually ran in; `sourcePath` is the authorized repository.
   * @param {object} task - task record.
   * @param {object} [options] - `includePrompt`.
   * @returns {object} redacted view.
   */
  view(task, options = {}) {
    const effective = task.effective === null ? null : {
      worker: { ...task.effective.worker },
      review: { ...task.effective.review },
      // The conversation policy this task ran under. It is a rule, not a stored
      // setting: a new submission starts a new DSH conversation, and a follow-up
      // continues the thread named by `continueFromTaskId`.
      conversation: { ...task.effective.conversation },
      provenance: task.effective.provenance,
    };
    const view = {
      taskId: task.taskId,
      state: task.state,
      phase: task.phase,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      sourcePath: task.sourcePath,
      workspacePath: task.executionPath ?? task.sourcePath,
      executionWorkspacePath: task.executionPath,
      isolation: effective === null ? null : effective.worker.isolation,
      connectionId: task.connectionId,
      grantId: task.grantId,
      authorization: task.authorization,
      effective,
      // The public id is the operator's profile id; the native route is a
      // separate field and never replaces it.
      route: task.route === null ? null : {
        providerId: effective === null ? null : effective.worker.providerId,
        providerRoute: task.route.providerRoute,
        model: task.route.model,
        reasoningEffort: task.route.reasoningEffort,
      },
      // Frozen during preflight: a later settings edit does not change it.
      reviewRoute: task.reviewRoute === null ? null : {
        providerId: effective === null ? null : effective.review.providerId,
        providerRoute: task.reviewRoute.providerRoute,
        model: task.reviewRoute.model,
        reasoningEffort: task.reviewRoute.reasoningEffort,
      },
      reviewRouteError: task.reviewRouteError,
      worktree: task.worktree,
      baseline: task.baseline,
      diff: task.diff,
      execution: task.execution === null ? null : {
        workspacePath: task.execution.workspacePath ?? task.executionPath,
        outcome: task.execution.outcome,
        text: task.execution.text,
        reasoningOnly: task.execution.reasoningOnly,
        usage: task.execution.usage,
        turnEnd: task.execution.turnEnd,
        agentId: task.execution.agentId,
        sessionId: task.execution.sessionId,
        // The provider/model/effort actually installed on the agent this run
        // drove, and the request budget. Observable for BOTH paths: a placed run
        // drives a resolved Agent, so `agents.create` options cannot be read.
        selection: task.execution.selection ?? null,
        maxTokens: task.execution.maxTokens ?? null,
        conversation: task.execution.conversation ?? null,
        cancelCause: task.execution.cancelCause,
        error: task.execution.error,
      },
      // Where the run's conversation was placed in DSH. `workspaceId` is the group an
      // operator sees; `kind` is `new` or `continuation`, and `continuedFromTaskId`
      // names the task whose thread this run continued (null for a new one).
      conversation: task.execution?.conversation ?? null,
      // Frozen on the task at creation, so the record states the intent even when
      // the run never got as far as driving a conversation.
      continueFromTaskId: task.continueFromTaskId ?? null,
      conversationSaved: task.conversationSaved,
      conversationError: task.conversationError,
      review: task.review,
      error: task.error,
      cancelledBy: task.cancelledBy,
      // The per-call permission surface of this run: whether it was bridged, the
      // request the commander may still decide (redacted), the settled trail, and
      // the standing mode the decision did NOT change. Present on every task, so a
      // reader never has to infer "no bridge" from a missing field.
      permission: this.permissionView(task),
      // The approval stance the run installed and read back (`never` without a
      // bridge, `ask` with an armed one), recorded from the run itself.
      approval: task.execution?.approval ?? null,
      hostAcceptance: task.hostAcceptance,
      // Stated explicitly so no consumer can read `awaiting-host-review` as
      // "done and approved".
      selfApproved: false,
    };
    if (options.includePrompt === true) view.prompt = redactText(task.prompt);
    return redactDeep(view);
  }

  /**
   * Bound the in-memory task map: oldest terminal records are dropped first, and
   * a live task is never dropped.
   * @returns {void}
   */
  prune() {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return;
    const terminal = [...this.tasks.values()]
      .filter((task) => TERMINAL.has(task.state))
      .sort((a, b) => (a.endedAt ?? a.createdAt) - (b.endedAt ?? b.createdAt));
    for (const task of terminal) {
      if (this.tasks.size <= MAX_RETAINED_TASKS) break;
      this.tasks.delete(task.taskId);
    }
  }

  /**
   * Abort every live task, stop the timers, and release every lease. Called on
   * dispose. Prepared worktrees are not deleted: a finished tree is evidence.
   * @returns {Promise<number>} number of tasks asked to stop.
   */
  async dispose() {
    this.aborted = true;
    this.stopListening();
    let count = 0;
    for (const task of this.tasks.values()) {
      if (TERMINAL.has(task.state)) {
        // A terminal task may still hold a bridge if its own teardown has not run
        // yet; disposing is idempotent and cannot answer anything after this point.
        this.releasePermissionBridge(task, 'dispose');
        continue;
      }
      this.abortTask(task, 'dispose');
      // Teardown is not a cancel: the answerer goes away, so the worker's paused
      // call must be told the channel is gone rather than that it was withdrawn.
      this.releasePermissionBridge(task, 'dispose');
      count += 1;
    }
    await Promise.race([
      Promise.allSettled([...this.tasks.values()].map((task) => task.settled ?? Promise.resolve())),
      new Promise((resolvePromise) => { setTimeout(resolvePromise, SETTLE_TIMEOUT_MS).unref?.(); }),
    ]);
    this.locks.releaseAll();
    this.aborted = true;
    return count;
  }
}

/**
 * Whether an invalidation event concerns one task.
 * @param {object} task - task record.
 * @param {object} event - invalidation event.
 * @returns {boolean} true when the task's authorization is gone.
 */
function matchesInvalidation(task, event) {
  if (event === null || typeof event !== 'object') return false;
  if (event.kind === 'all') return true;
  if (event.kind === 'connection') {
    return task.connectionId !== null && task.connectionId === event.connectionId;
  }
  if (event.kind === 'grant') {
    if (task.grantId === null || event.grantId !== task.grantId) return false;
    return event.connectionId === undefined || task.connectionId === event.connectionId;
  }
  return false;
}

/**
 * Extract a native route id from a value the provider registry produced.
 * @param {unknown} value - string, `{ id }`, `{ route }` or `{ providerRoute }`.
 * @returns {string | null} route id.
 */
function nativeRouteId(value) {
  if (typeof value === 'string' && value !== '') return value;
  if (value === null || typeof value !== 'object') return null;
  for (const key of ['id', 'route', 'providerRoute']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return null;
}

/**
 * Compare two workspace paths the way the lock registry keys them.
 * @param {string} a - first path.
 * @param {string} b - second path.
 * @returns {boolean} true when they name the same directory.
 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = (value) => {
    const trimmed = value.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  };
  return normalize(a) === normalize(b);
}

/**
 * The placeholder a redacted path segment is rewritten to.
 */
const PATH_MASK_SEGMENT = 'masks-user-profile-segment';

/**
 * Whether a persisted path cannot prove which directory it names.
 *
 * Durable documents are projected through redaction, which replaces an
 * account-identifying directory name with the placeholder above. A path carrying that
 * placeholder is a shortened spelling: nothing can prove which directory stood there,
 * so it is never compared into a match and is treated exactly like a missing path — the
 * mask only ever causes a refusal, it never stands for equality. A real directory whose
 * name merely *starts with* the placeholder is still its own directory, which is why the
 * test is for the whole segment.
 * @param {unknown} value - candidate path.
 * @returns {boolean} true when the path was rewritten and can only be refused.
 */
function recordedPathIsMasked(value) {
  if (typeof value !== 'string') return false;
  return value
    .split(/[\\/]+/)
    .some((part) => part.trim() === PATH_MASK_SEGMENT);
}

/**
 * Review selection projection for a review that never ran.
 * @param {object} review - effective review block.
 * @param {object | null} route - frozen route, if any.
 * @returns {object} selection summary.
 */
function reviewSelection(review, route) {
  return {
    providerId: review?.providerId ?? null,
    model: route?.model ?? review?.model ?? null,
    reasoningEffort: route?.reasoningEffort ?? review?.reasoningEffort ?? null,
  };
}

/**
 * Validate the shape a caller-supplied override may take before it reaches the
 * settings validator. Kept here so the engine never trusts a raw object.
 * @param {unknown} value - raw override object.
 * @returns {object} shallow copy with only known keys.
 */
export function sanitizeOverrides(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new JobError(JOB_CODES.overrideInvalid, 'overrides must be an object', {});
  }
  const allowed = ['providerId', 'model', 'reasoningEffort', 'timeoutSeconds', 'isolation'];
  const out = {};
  for (const key of allowed) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

export { AuthError, AUTH_CODES, defaultSettings };
