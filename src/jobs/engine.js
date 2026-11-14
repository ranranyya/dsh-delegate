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
// Phases. A phase is what the task is doing now, and every terminal branch publishes
// the phase matching the state it recorded (`failed`, `cancelled`,
// `awaiting-host-review`). `execute` is published only from the executor's own
// recognised event ({@link onExecutionEvent}): a pending native create is not
// execution, and no late event overwrites `awaiting-permission` or a terminal phase.
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
import { defaultSettings, LIMITS, MONITORING_DEFAULTS } from '../config/defaults.js';
import { redactDeep, redactText } from '../config/redact.js';
import { resolveEffectiveConfig } from '../config/settings.js';
import { AUTH_CODES, AuthError } from '../auth/grants.js';
import { TaskMonitor, isPublicReason, terminalReason } from './activity.js';
import { resolveRoute } from '../model/routing.js';
import { PROVIDER_SET_CODES, managedProvidersOf } from '../model/providers.js';
import { RUN_OUTCOMES, RunError, SessionPlacementRefusal, diagnostic, runAgent } from '../runtime/agent-runner.js';
import { PermissionBridge, PermissionError, PERMISSION_CODES } from '../runtime/permissions.js';
import { DELEGATE_SANDBOX_MODE } from '../runtime/sandbox.js';
import { rememberSession, SESSION_CODES } from '../runtime/session-placement.js';
import { taskTitle } from './title.js';
import { REVIEW_STATES, reviewWork } from '../review/reviewer.js';
import { buildReviewPrompt, buildWorkerPrompt } from '../review/prompts.js';
import { captureBaseline, captureDiff } from '../workspace/audit.js';
import { LOCK_CODES, WorkspaceError, resolveWorkspacePath } from '../workspace/locks.js';
import {
  REVIEW_NOTE_MAX_CHARS,
  normalizeReviewNote,
  reviewNoteLength,
  reviewNoteOverflow,
} from './review-note.js';

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
  // Host review (delivery acceptance). These are refusals of the REVIEW verb, not new
  // task states: the task keeps `awaiting-host-review` and its underlying outcome.
  //  * notReviewable: the task is not waiting for review (still running, failed,
  //    cancelled, interrupted, or already has a DIFFERENT recorded decision);
  //  * invalid: the decision/note did not pass the closed vocabulary or the bound;
  //  * notPersisted: the decision was made but could not be written to history, so the
  //    caller is TOLD it was not saved instead of being told it succeeded.
  reviewNotReviewable: 'JOB_REVIEW_NOT_REVIEWABLE',
  reviewInvalid: 'JOB_REVIEW_INVALID',
  reviewNotPersisted: 'JOB_REVIEW_NOT_PERSISTED',
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
 * The closed vocabulary of host-review decisions.
 *
 * `accepted` is the host saying "I reviewed the delivered evidence and it is right".
 * `changes-requested` is the same review with a different conclusion. Neither is a task
 * state: the run stays `awaiting-host-review`, which is what keeps older clients and a
 * later `continueFromTaskId` follow-up compatible.
 */
export const HOST_REVIEW_STATES = Object.freeze({
  accepted: 'accepted',
  changesRequested: 'changes-requested',
});

/** Bounds on a review note: non-empty for a decision, and never unbounded. */
const REVIEW_NOTE_MAX = REVIEW_NOTE_MAX_CHARS;

/**
 * Where a review decision is in its journey to durable storage.
 *
 * `saving` means "accepted for writing, durability not yet confirmed" — deliberately NOT
 * acceptance: `hostAcceptance` stays null until the store has answered. `failed` is a
 * settled failure a retry may leave. `timed-out` is UNCONFIRMED: the write is still in
 * flight and may yet land, so it is neither failure nor success. A process restart holds
 * no saving state; the disk is the only fact that outlives the process.
 */
export const REVIEW_PERSISTENCE_STATES = Object.freeze({
  none: 'none',
  saving: 'saving',
  saved: 'saved',
  failed: 'failed',
  timedOut: 'timed-out',
});

/**
 * How long ONE review request waits for its durable write.
 *
 * A bound on the REQUEST, never on the write: exceeding it answers "still saving" and
 * leaves the write running, so a slow disk costs a deferred answer instead of a fabricated
 * failure — and the late outcome is what the engine publishes afterwards.
 */
const REVIEW_WRITE_TIMEOUT_MS = HISTORY_WRITE_TIMEOUT_MS;

/** Returned by `raceOutcome` when its bound expired first. */
const REVIEW_OUTCOME_TIMEOUT = Symbol('review-write-timeout');

/** The fixed marker recorded as the reviewer, so a stored decision is not a free name. */
const HOST_REVIEW_BY = 'host-commander';

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

/**
 * The phase a running task reports until its executor demonstrably does work.
 *
 * Every admission step has finished and the runner has been called, but a native
 * create may still be pending (a placement is resolved through the controllers
 * first), so this phase claims only "submitted", never "executing".
 */
const PHASE_BEFORE_CREATE = 'before-create';

/**
 * Session event types that prove the executor itself is working.
 *
 * The durable lifecycle types only: an opened turn, an opened model step and a
 * native tool call/result cannot be produced by a pending create, whereas a
 * streaming delta can arrive empty while a provider is still connecting.
 * @type {ReadonlySet<string>}
 */
const EXECUTION_EVIDENCE_EVENTS = Object.freeze(new Set(['turn/start', 'step/start', 'tool/call', 'tool/result']));

/**
 * The closed vocabulary of reasons one observation may report to a caller.
 *
 * `heartbeat` is in it because the adapter contract names it, but
 * {@link JobEngine#observeTask} never RETURNS it: it means "the internal wait
 * expired with nothing to say", and the documented behaviour is to re-wait once
 * rather than hand the caller a report that carries no information.
 */
export const OBSERVE_TASK_REASONS = Object.freeze({
  heartbeat: 'heartbeat',
  attention: 'attention',
  permission: 'permission',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
});

/**
 * How long one observation may wait inside the engine, and the internal slice it
 * polls on. The outer bound is a hard part of the contract (an adapter must never
 * hold a request open indefinitely); the slice is an implementation detail that a
 * test narrows to simulate time.
 */
const OBSERVE_WAIT_MS = 25_000;
const OBSERVE_SLICE_MS = 1000;

/**
 * How much of an observation's own bound is kept back when it waits for a review write.
 *
 * An observation must be answerable WITHIN the bound the caller asked for, so the wait for
 * a still-running review write stops this much short of it and leaves room to build and
 * return the answer. Without the margin a wait that used the whole budget would answer
 * after its own deadline, which is exactly the kind of overrun the bounded observation was
 * introduced to remove.
 */
const OBSERVE_REVIEW_SETTLE_MARGIN_MS = 250;

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
   *   steps that run before the worker timeout is known),
   *   `allowLegacyProviderRoutes` (tests only: use the profile id as the native
   *   route when neither seam is present), and the optional observation seams
   *   `now` (a clock returning epoch milliseconds) and `wait(ms, { signal })`
   *   (a bounded sleep), plus `observeSliceMs` (test-only polling slice).
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
    // Observation seams. Production leaves both absent and gets the real clock and
    // a real unref'd wait; a test injects a clock and a wait it can advance, so
    // "twenty minutes of silent waiting" costs no wall time and cannot flake. They
    // live on the engine, not on the monitor, because every monitor of every task
    // must read the same time source.
    this.clock = typeof deps?.now === 'function' ? deps.now : Date.now;
    this.observationWait = typeof deps?.wait === 'function' ? deps.wait : undefined;
    const slice = Number(deps?.observeSliceMs);
    this.observeSliceMs = Number.isFinite(slice) && slice > 0 ? Math.trunc(slice) : OBSERVE_SLICE_MS;
    // Observers currently waiting, so disposal can release them without touching
    // the workers they were only watching.
    this.observers = new Set();
    // One in-flight host-review write per task, plus the state of the last one, so two
    // concurrent identical requests cannot both claim success before the durable write has
    // landed — and so a write that outlived its request can still publish its outcome.
    // Keyed by task id; see {@link beginReviewWrite} for the acceptance rule.
    this.reviewState = new Map();
    // Monotonic token for review writes. Not per task: a token is compared against the
    // entry it belongs to, so a global counter is enough and cannot wrap into confusion
    // with a task's own numbering.
    this.reviewSeq = 0;
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
    task.title = taskTitle(request?.title, prompt);
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
      // The activity monitor for this run. Created with the task, fed from the
      // runner's `onEvent` hook, and disposed with the task: its counters describe
      // THIS run and must not outlive it. It holds metadata only (counts,
      // timestamps, a tool name and call id), never model text or tool arguments.
      monitor: null,
      // Idempotence latch for {@link finalize}: one promise per task, ever.
      finalizing: null,
      finalizedAt: null,
      // Cleanup that could not be performed, and durable-history outcomes. Both
      // are recorded on the task so a failure is visible instead of swallowed.
      cleanupError: null,
      historyError: null,
      historySavedAt: null,
      // Host acceptance is never granted here; it is the host's own record, and it is
      // published only once the durable write has CONFIRMED it (see `recordHostReview`).
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
   * Record the commander's delivery review for one finished task.
   *
   * This is the ONLY writer of a task's `hostAcceptance`, and it is deliberately the
   * narrowest write in the plugin. It does not decide a permission, change the switch,
   * a provider, a model, the isolation or a credential, merge a file, or create work:
   * it records "the host looked at what was delivered and concluded X" on a task whose
   * execution has already ended.
   *
   * The run's STATE is left `awaiting-host-review`. That is the compatibility anchor: an
   * older client keeps reading the same state, and `continueFromTaskId` keeps working.
   * The review conclusion lives in its own field.
   *
   * The chain of checks, all refusals:
   *  1. the task exists and belongs to the deciding connection (a foreign task answers
   *     exactly like an unknown one);
   *  2. the decision and note pass the closed vocabulary and the bound;
   *  3. closing the delegation switch does not prevent reviewing an existing result;
   *  4. the task is actually waiting for review AND its native executor has settled, so
   *     "still running" can never be recorded as reviewed;
   *  5. an existing decision is final: the SAME conclusion with the SAME note is an
   *     idempotent no-op, and a DIFFERENT one is refused (a correction is a follow-up
   *     task, not a rewrite of the record);
   *  6. only then is it stored — and the conclusion becomes visible ONLY once the durable
   *     write has confirmed it.
   *
   * Step 6 is the persistence contract: the decision is NOT put in
   * `task.hostAcceptance` before the store answers, so an ordinary read never shows a
   * conclusion the disk does not have. The request waits at most
   * {@link REVIEW_WRITE_TIMEOUT_MS}; exceeding it is UNCONFIRMED, not failed — the write
   * keeps running, the answer reports `reviewPersistence.state === 'timed-out'` with no
   * decision, and the late outcome updates memory either way. Writes are serialized per
   * task, and every attempt carries a token so a stale write cannot land on a newer
   * conclusion.
   * @param {object} request - `taskId`, `decision`, `note`, and the authenticated
   *   `connectionId` (from the plane, never from the caller's body). An optional integer
   *   `waitMs` bounds how long THIS CALL waits for durability (0 = the engine default).
   * @returns {Promise<object>} `{ task, hostAcceptance, reviewPersistence }` where `task`
   *   is the public view. `hostAcceptance` is non-null only for a confirmed decision.
   * @throws {JobError} on any refusal, and with `JOB_REVIEW_NOT_PERSISTED` once the write
   *   has genuinely FAILED (a timeout throws nothing).
   */
  async recordHostReview(request) {
    const connectionId = typeof request?.connectionId === 'string' ? request.connectionId : null;
    if (connectionId === null) {
      // No verified identity means no ownership proof: the same answer an unknown task gets.
      throw new JobError(JOB_CODES.taskNotFound, 'no such task for this connection', {});
    }
    const taskId = typeof request?.taskId === 'string' ? request.taskId.trim() : '';
    if (taskId === '') {
      throw new JobError(JOB_CODES.reviewInvalid, 'taskId is required', { field: 'taskId' });
    }
    const { decision, note: rawNote } = reviewInput(request);

    const task = this.tasks.get(taskId);
    if (task === undefined || task.connectionId !== connectionId) {
      throw new JobError(JOB_CODES.taskNotFound, 'no such task for this connection', { taskId });
    }
    // NO posture gate here, deliberately. A review records a conclusion about a result
    // that already exists: it creates no work, releases no permission, issues no grant and
    // changes no setting. Like reading a task or cancelling it, it therefore stays
    // available after the operator closes the switch — you must still be able to review
    // what you already paid for. Starting a NEW task and answering a permission request
    // remain gated by the switch at their own entry points.
    // Only a finished execution can be reviewed. `awaiting-host-review` is the state the
    // engine records after a completed run, and `native.settled` is the second,
    // independent proof that the executor is gone: neither can be inferred by the caller.
    if (task.state !== TASK_STATES.awaitingHostReview || task.native?.settled !== true) {
      throw new JobError(JOB_CODES.reviewNotReviewable, 'this task is not awaiting host review', {
        taskId,
        state: task.state,
        phase: task.phase,
      });
    }

    // The note is redacted through the same bounded redaction the rest of the projection
    // uses, so a stored conclusion cannot smuggle a credential into history or a view. It
    // is NOT cut here: the bound was already enforced above.
    const note = redactText(rawNote);
    const entry = this.beginReviewWrite(task, decision, note);
    return await this.awaitReviewWrite(task, entry, reviewWaitMs(request));
  }

  /**
   * Begin (or join) the durable write of one review decision. Only a write that is
   * genuinely IN FLIGHT locks the conclusion: `saving`/`timed-out` join the same
   * conclusion and refuse a different one; `failed` with no confirmed record frees the
   * conclusion for a new attempt; `saved` replays idempotently or refuses a conflict.
   * @param {object} task - task record (already proven reviewable and owned).
   * @param {string} decision - validated decision.
   * @param {string} note - normalized, redacted note.
   * @returns {object} the persistence entry this request must wait on.
   * @throws {JobError} when a different conclusion is recorded or already in flight.
   */
  beginReviewWrite(task, decision, note) {
    if (this.history === null || this.history === undefined || typeof this.history.save !== 'function') {
      // `persistHistory` answers success for the missing-store posture, which would let a
      // review be claimed as saved when nothing was written, so this is refused up front.
      throw this.reviewNotPersisted(
        'no durable history store is configured, so the review decision was not recorded', task, null,
      );
    }
    const current = this.reviewState.get(task.taskId) ?? null;
    const recorded = task.hostAcceptance ?? null;

    if (current !== null) {
      if (current.state === REVIEW_PERSISTENCE_STATES.saved) {
        return this.replayOrRefuse(task, recorded, decision, note);
      }
      if (current.state === REVIEW_PERSISTENCE_STATES.saving
        || current.state === REVIEW_PERSISTENCE_STATES.timedOut) {
        if (current.decision === decision && current.note === note) return current;
        throw new JobError(JOB_CODES.reviewNotReviewable,
          'a different review decision is being recorded for this task; wait for it or send a follow-up task', {
            taskId: task.taskId,
            state: task.state,
            recorded: current.decision,
            requested: decision,
            persistence: current.state,
          });
      }
      // `failed`: nothing was recorded, so this is a genuine new attempt.
    }

    if (recorded !== null && recorded !== undefined) {
      return this.replayOrRefuse(task, recorded, decision, note);
    }

    const entry = {
      state: REVIEW_PERSISTENCE_STATES.saving,
      decision,
      note,
      token: (this.reviewSeq ?? 0) + 1,
      startedAt: this.clock(),
      confirmedAt: null,
      error: null,
    };
    this.reviewSeq = entry.token;
    this.reviewState.set(task.taskId, entry);
    // Started, deliberately not awaited: the request bounds how long IT waits, not how
    // long the write may take. A write still running when the request stops waiting must
    // be allowed to finish and publish its outcome.
    entry.done = this.writeReview(task, entry);
    entry.done.catch(() => undefined);
    return entry;
  }

  /**
   * Answer a request whose conclusion is already the recorded one, or refuse a conflict.
   * @param {object} task - task record.
   * @param {object} recorded - the recorded `hostAcceptance`.
   * @param {string} decision - requested decision.
   * @param {string} note - requested note.
   * @returns {object} the saved persistence entry.
   * @throws {JobError} on a different conclusion.
   */
  replayOrRefuse(task, recorded, decision, note) {
    if (recorded !== null && recorded !== undefined
      && recorded.state === decision && recorded.note === note) {
      return { state: REVIEW_PERSISTENCE_STATES.saved, decision, note, token: -1, done: Promise.resolve(true) };
    }
    throw new JobError(JOB_CODES.reviewNotReviewable,
      'this task already has a recorded review; send a follow-up task to record a correction', {
        taskId: task.taskId,
        state: task.state,
        recorded: recorded?.state ?? null,
        requested: decision,
      });
  }

  /**
   * Write one review decision to the durable store and publish its real outcome.
   *
   * Success publishes `task.hostAcceptance` and marks `saved` — this is the only place a
   * review becomes visible. Failure marks `failed`, records `historyError` and leaves
   * `hostAcceptance` null so a retry is legal. An outcome whose token is no longer current
   * is discarded: a stale write must never overwrite a newer conclusion.
   *
   * The view is snapshotted here WITH the decision, because the decision is not in memory
   * until the write lands: the durable record says exactly what the request said.
   * @param {object} task - task record.
   * @param {object} entry - the persistence entry being written.
   * @returns {Promise<boolean>} true when the decision is durable.
   */
  async writeReview(task, entry) {
    let view;
    try {
      view = this.viewForReviewWrite(task, entry);
      await this.history.save(view);
    } catch (error) {
      this.settleReviewWrite(task, entry, false, {
        code: typeof error?.code === 'string' ? error.code : JOB_CODES.historyFailed,
        message: diagnostic(error?.message ?? error, 300),
      });
      return false;
    }
    this.settleReviewWrite(task, entry, true, null);
    return true;
  }

  /**
   * Publish (or discard) the outcome of one review write.
   * @param {object} task - task record.
   * @param {object} entry - persistence entry.
   * @param {boolean} ok - whether the decision is durable.
   * @param {object | null} error - bounded history error when not.
   * @returns {void}
   */
  settleReviewWrite(task, entry, ok, error) {
    if (this.reviewState.get(task.taskId) !== entry) return;
    if (entry.state === REVIEW_PERSISTENCE_STATES.saved) return;
    if (ok) {
      task.hostAcceptance = {
        accepted: entry.decision === HOST_REVIEW_STATES.accepted,
        state: entry.decision,
        acceptedAt: entry.startedAt,
        by: HOST_REVIEW_BY,
        note: entry.note,
      };
      task.historyError = null;
      task.historySavedAt = this.clock();
      entry.state = REVIEW_PERSISTENCE_STATES.saved;
      entry.confirmedAt = this.clock();
      entry.error = null;
      return;
    }
    task.hostAcceptance = null;
    task.historyError = error;
    task.historySavedAt = null;
    entry.state = REVIEW_PERSISTENCE_STATES.failed;
    entry.error = error;
  }

  /**
   * Wait for one review write, boundedly, and answer honestly about where it got to.
   *
   * Exceeding the bound is NOT a failure: the write is still running and may yet land, so
   * the caller is answered `timed-out` with `pending: true` and no decision. Reporting a
   * timeout as `JOB_REVIEW_NOT_PERSISTED` is the defect this replaces.
   * @param {object} task - task record.
   * @param {object} entry - persistence entry being awaited.
   * @param {number} timeoutMs - wait bound in milliseconds (0 = engine default).
   * @returns {Promise<object>} `{ task, hostAcceptance, reviewPersistence }`, JSON-safe.
   * @throws {JobError} when the write has actually failed.
   */
  async awaitReviewWrite(task, entry, timeoutMs) {
    if (entry.state !== REVIEW_PERSISTENCE_STATES.saved) {
      const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REVIEW_WRITE_TIMEOUT_MS;
      const outcome = await raceOutcome(entry.done, bound);
      if (outcome === REVIEW_OUTCOME_TIMEOUT
        && this.reviewState.get(task.taskId) === entry
        && entry.state === REVIEW_PERSISTENCE_STATES.saving) {
        entry.state = REVIEW_PERSISTENCE_STATES.timedOut;
      }
    }
    if (entry.state === REVIEW_PERSISTENCE_STATES.saved) {
      const view = this.view(task);
      return { task: view, hostAcceptance: view.hostAcceptance, reviewPersistence: view.reviewPersistence };
    }
    if (entry.state === REVIEW_PERSISTENCE_STATES.timedOut) {
      const view = this.view(task);
      return { task: view, hostAcceptance: view.hostAcceptance, reviewPersistence: view.reviewPersistence };
    }
    throw this.reviewNotPersisted(
      'the review decision could not be written to history, so it was not recorded',
      task,
      entry.error ?? task.historyError ?? null,
    );
  }

  /**
   * The in-flight review write of one task, if any.
   *
   * In-process only: the public projection carries no promise (JSON cannot), so a wire
   * consumer reads `reviewPersistence` and re-reads the task.
   * @param {string} taskId - task id.
   * @returns {Promise<boolean> | null} the write's own promise, or null when none is running.
   */
  reviewWriteDone(taskId) {
    const entry = this.reviewState.get(taskId) ?? null;
    if (entry === null || typeof entry.done?.then !== 'function') return null;
    if (entry.state !== REVIEW_PERSISTENCE_STATES.saving && entry.state !== REVIEW_PERSISTENCE_STATES.timedOut) return null;
    return entry.done;
  }

  /**
   * The refusal for a review that was not (and will not be) durable.
   * @param {string} message - explanation.
   * @param {object} task - task record.
   * @param {object | null} historyError - bounded history error.
   * @returns {JobError} the refusal, with the task's persistence state attached.
   */
  reviewNotPersisted(message, task, historyError) {
    const view = this.view(task);
    return new JobError(JOB_CODES.reviewNotPersisted, message, {
      taskId: task.taskId,
      historyError,
      reviewPersistence: view.reviewPersistence,
    });
  }

  /**
   * The public record of where a task's review decision is in its write.
   *
   * `hostAcceptance` answers "what conclusion is recorded?"; this answers "is it durable
   * yet?". Both are JSON data only — no promise, no handle — so they survive a wire hop.
   * @param {object} task - task record.
   * @returns {object} bounded persistence block.
   */
  reviewPersistenceView(task) {
    const entry = this.reviewState?.get(task.taskId) ?? null;
    const recorded = task.hostAcceptance ?? null;
    if (entry !== null) {
      const durable = entry.state === REVIEW_PERSISTENCE_STATES.saved;
      return {
        state: entry.state,
        decision: entry.decision,
        // Only a DURABLE decision can be acceptance, and only the document can say it is
        // durable: an in-flight entry never does.
        accepted: durable && recorded?.accepted === true && recorded?.state === entry.decision,
        durable,
        pending: entry.state === REVIEW_PERSISTENCE_STATES.saving || entry.state === REVIEW_PERSISTENCE_STATES.timedOut,
        startedAt: entry.startedAt ?? null,
        confirmedAt: entry.confirmedAt ?? null,
        retryable: entry.state === REVIEW_PERSISTENCE_STATES.failed,
        error: entry.error ?? null,
      };
    }
    if (recorded !== null && recorded !== undefined) {
      return {
        state: REVIEW_PERSISTENCE_STATES.saved,
        decision: recorded.state ?? null,
        accepted: recorded.accepted === true,
        durable: true,
        pending: false,
        startedAt: null,
        confirmedAt: recorded.acceptedAt ?? null,
        retryable: false,
        error: null,
      };
    }
    return {
      state: REVIEW_PERSISTENCE_STATES.none,
      decision: null,
      accepted: false,
      durable: false,
      pending: false,
      startedAt: null,
      confirmedAt: null,
      retryable: false,
      error: null,
    };
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
    // The monitor exists from the moment the run is driven, so an executor that
    // produces nothing at all is still measured from its own state time instead of
    // being invisible. Its thresholds come from the snapshot this task froze at
    // admission, never from live settings: an edit mid-run must not retime a task
    // that is already in flight.
    //
    // `ensureMonitor` never REPLACES one: an observation started before this call
    // (against `startedAt`, i.e. while the task was still `pending`) already holds a
    // reference to the monitor, and swapping it here would leave that observer
    // watching an object that never receives another event.
    this.ensureMonitor(task);
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
      task.phase = PHASE_BEFORE_CREATE;
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
      // `started` means "this task called the runner", not "the executor is
      // running": placement resolves before the runner sees an Agent, so the task
      // is handed over in `before-create` and only the executor's own events
      // ({@link onExecutionEvent}) publish `execute`.
      task.native.started = true;
      const pending = runAgent(this.deps, {
        prompt,
        title: task.title,
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
        // The activity feed. `runAgent` already dispatches every native session
        // event here, and the monitor reads only the parts it classifies: whether
        // the event was progress, and (for a tool event) its name and call id.
        // Reasoning text, assistant text and tool arguments are never retained or
        // forwarded — there is no field in the summary they could travel in.
        // This hook is also the only execution evidence the phase trusts.
        onEvent: (event) => { this.onExecutionEvent(task, event); },
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
        task.phase = 'failed';
        task.error = { code: JOB_CODES.timeout, message: 'the task exceeded its time budget' };
        task.endedAt = Date.now();
        return;
      }
      if (run.outcome !== RUN_OUTCOMES.completed) {
        task.state = TASK_STATES.failed;
        // The phase states the same ending as the state, so a failed run never keeps
        // describing a creation or an execution.
        task.phase = 'failed';
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
   * Build the activity monitor for one task.
   *
   * Thresholds come from the task's own frozen effective snapshot. They are
   * therefore immutable for the life of the run: `setMonitoring` affects the next
   * admission, never one already executing. The engine's clock and wait seams are
   * handed to every monitor so all of them observe one time source.
   * @param {object} task - admitted task record with `effective`.
   * @returns {object} the task's monitor.
   */
  createMonitor(task) {
    const monitoring = task.effective?.monitoring ?? null;
    return new TaskMonitor(task, {
      now: () => this.clock(),
      ...(this.observationWait === undefined ? {} : { wait: this.observationWait }),
      waitSliceMs: this.observeSliceMs,
      selfCheckSeconds: monitoring?.selfCheckSeconds ?? MONITORING_DEFAULTS.selfCheckSeconds,
      attentionSeconds: monitoring?.attentionSeconds ?? MONITORING_DEFAULTS.attentionSeconds,
      repeatFailureThreshold: monitoring?.repeatFailureThreshold ?? MONITORING_DEFAULTS.repeatFailureThreshold,
      log: (message, detail) => this.deps?.logger?.warn?.(message, detail),
    });
  }

  /**
   * Return this task's monitor, creating it only when there is none.
   *
   * There is exactly ONE monitor per task. A task may be observed before `execute`
   * creates its monitor (the task is `pending` but already admitted, so its frozen
   * thresholds are known), and the observation holds a reference to whatever it
   * got. Replacing the monitor later — which an unconditional assignment would do —
   * would leave that observer watching an object that never receives another event,
   * so it would stay silent forever. Creation therefore happens at most once, and
   * the threshold source is the frozen snapshot either way.
   * @param {object} task - task record (admitted, so `effective` is resolved).
   * @returns {object} the task's single monitor.
   */
  ensureMonitor(task) {
    if (task.monitor === null || task.monitor === undefined) task.monitor = this.createMonitor(task);
    return task.monitor;
  }

  /**
   * Stop one task's monitor and release any observation waiting on it.
   *
   * Idempotent, and never touches the worker: an observation that ends is a reader
   * leaving, not a run being stopped. The activity is finalized at the task's own
   * end so a later view or a stored record cannot report an idle (or tool-elapsed)
   * span that keeps growing after the run stopped.
   * @param {object} task - task record.
   * @returns {void}
   */
  releaseMonitor(task) {
    const monitor = task?.monitor ?? null;
    if (monitor === null || monitor === undefined) return;
    try {
      monitor.dispose(Number.isFinite(task.endedAt) ? task.endedAt : this.clock());
    } catch {
      // A monitor that refuses to dispose is a defect, not a reason to leave a
      // task unsettled; the observer set is cleared below regardless.
    }
  }

  /**
   * Whether a task currently has a native tool call outstanding.
   *
   * The monitor keeps the last tool span it was told about. What that means is the
   * ENGINE's judgement, not the monitor's: a run in its permission wait is not
   * "waiting on a tool" (the request carries its own reason), and a settled run is
   * not waiting on anything. So the monitor is asked for a duration, and the answer
   * about meaning is decided here.
   * @param {object} task - task record.
   * @returns {boolean} true when the summary should describe a running tool.
   */
  toolActive(task) {
    const monitor = task?.monitor ?? null;
    if (monitor === null || monitor === undefined || monitor.disposed === true) return false;
    if (task.permission?.pending !== null && task.permission?.pending !== undefined) return false;
    return LIVE.has(task.state) && monitor.activity.tool !== null;
  }

  /**
   * Feed one native executor event to the run's monitor and, on real evidence that
   * the executor is working, publish `execute`.
   *
   * Only a live task still at {@link PHASE_BEFORE_CREATE} advances, so a late event
   * can never overwrite `awaiting-permission`, `review`, a terminal phase or a
   * `pending` task.
   * @param {object} task - running task record.
   * @param {unknown} event - native event dispatched by the runner.
   * @returns {void}
   */
  onExecutionEvent(task, event) {
    task.monitor?.onEvent(event, this.clock());
    if (task.state === TASK_STATES.running
      && task.phase === PHASE_BEFORE_CREATE
      && EXECUTION_EVIDENCE_EVENTS.has(event?.type)) {
      task.phase = PHASE_EXECUTE;
    }
  }

  /**
   * The bounded, publishable activity block of one task view.
   *
   * Safe by construction: counts, timestamps and identifiers only. No transcript,
   * no reasoning, no tool arguments and no diff has a field here, so every existing
   * view (`get`, `list`, history, MCP) inherits a progress summary without
   * inheriting content.
   * @param {object} task - task record.
   * @returns {object | null} activity summary, or null for a task that never ran.
   */
  activityView(task) {
    const monitor = task?.monitor ?? null;
    if (monitor === null || monitor === undefined) return null;
    const at = this.clock();
    try {
      return monitor.snapshot({ at, toolActive: this.toolActive(task) });
    } catch {
      return null;
    }
  }

  /**
   * Await one bounded observation of a task.
   *
   * This is the documented seam the HTTP adapter (a later work unit) turns into an
   * endpoint. It answers ONE question — "is there anything the commander should
   * know right now, or should this request simply wait?" — and reports why it
   * returned.
   *
   * Contract:
   *
   *  * `waitMs` defaults to 25 s and is clamped to `[1, 25000]`. The wait is
   *    BOUNDED BY ONE WAIT: when it expires with nothing to report the reason is
   *    `heartbeat` and the caller re-issues. There is no internal re-wait, so the
   *    documented bound is the real upper bound of one call.
   *  * Reasons, in precedence order: `interrupted` (caller aborted, or the engine
   *    was disposed — the WORKER keeps running), then any terminal state
   *    (`ready`/`failed`/`cancelled`, which wins even over an `interrupted` caused
   *    by engine teardown, because the run really did reach that outcome), then
   *    `permission` (a per-call decision is outstanding), then `attention` (the
   *    silence reached `attentionSeconds`, claimed by exactly one observer), then
   *    `heartbeat`. Genuine progress never produces `attention`: it resets the
   *    silence instead.
   *  * The permission reason carries the FULL existing redacted request view,
   *    including its exact fingerprint and completeness facts. A shortened
   *    operation is not decidable, and an undecidable request is the one thing this
   *    feature must never produce.
   *  * An unknown task and another connection's task are the SAME refusal
   *    (`JOB_TASK_NOT_FOUND`, same message, same details), so the answer cannot be
   *    used to discover that an id exists.
   *  * The checks are re-run after the wait, before the summary is built, and the
   *    summary is built from the SAME task record the checks read. A permission
   *    request or a finish that lands while the caller is waiting is therefore
   *    reported, not lost.
   *  * Aborting an observation releases only its own listener and timer. It never
   *    cancels, restarts or resumes the worker, and never disturbs another
   *    observer of the same task.
   * @param {string} taskId - task to observe.
   * @param {object} [options] - `connectionId`, `waitMs` (default 25000, max 25000), `signal`.
   * @returns {Promise<{ task: object, reason: string, permission: object | null,
   *   failure: object | null, activity: object | null,
   *   selfCheck: object | null, wait: { waitMs: number, waitedMs: number, activitySinceWait: boolean } }>} observation.
   *   `failure` is present only when `attention` reports a repeated-tool-failure
   *   reminder; it carries a tool name, a failure code, an operation digest and counts.
   * @throws {JobError} `JOB_TASK_NOT_FOUND` for an unknown or foreign task.
   */
  async observeTask(taskId, options = {}) {
    const task = this.taskForObservation(taskId, options?.connectionId);
    const waitMs = clampObserveWait(options?.waitMs);
    const signal = options?.signal ?? null;

    if (this.aborted) return this.observationOf(task, OBSERVE_TASK_REASONS.interrupted, null, waitMs, 0, false);
    if (signal !== null && signal.aborted === true) {
      return this.observationOf(task, OBSERVE_TASK_REASONS.interrupted, null, waitMs, 0, false);
    }

    // Exactly one monitor per task, created at most once (see `ensureMonitor`).
    const monitor = this.ensureMonitor(task);

    // A task that has already ended owes the caller its outcome immediately: there
    // is nothing to wait for, and a `heartbeat` here would invite a pointless
    // re-request for a run that will never change again. The same is true of an
    // outstanding permission request, which is decidable right now.
    const immediate = this.settleReason(task);
    if (immediate !== null) {
      // Except for one thing a settled run can still change: its review decision may be
      // mid-write. Waiting for that write is what lets a caller who lost the answer to a
      // timed-out review learn the outcome here, instead of re-sending a decision (or
      // believing the review vanished). The wait is bounded and the report is honest
      // either way; nothing about the task's state is touched.
      const settledObservation = await this.awaitReviewSettlement(task, waitMs, signal);
      if (settledObservation !== null) return settledObservation;
      return this.observationOf(task, immediate, monitor, waitMs, 0, false);
    }

    // ONE bounded wait, and nothing more. `waitMs` is the caller's promise: a
    // documented `<= 25 s` observation must never become two waits back to back,
    // which would double it and blow an adapter's own request timeout. Re-issuing
    // is the caller's loop (the MCP tool in the next unit), not this method's.
    const outcome = await this.waitForTaskReport(monitor, { waitMs, signal });
    let reason = isPublicReason(outcome.reason) ? outcome.reason : OBSERVE_TASK_REASONS.heartbeat;

    // Late-event delivery: the summary is rebuilt from the record AFTER the wait,
    // and the checks below read the SAME `task` object the monitor loop examined.
    // A terminal state always wins — including over an `interrupted` produced by an
    // engine dispose, because the run really did reach an outcome — and a pending
    // request beats a silence report. `heartbeat` is the only reason that yields.
    const settled = this.settleReason(task);
    if (settled !== null) reason = settled;
    // A reminder superseded by a terminal state or a pending request above is dropped:
    // those outrank it, and a failure report must not describe a task that now needs a
    // different decision.
    const failure = reason === OBSERVE_TASK_REASONS.attention ? (outcome.failure ?? null) : null;
    return this.observationOf(task, reason, monitor, waitMs, outcome.waitedMs, outcome.activitySinceWait, failure);
  }

  /**
   * Wait — boundedly — for a task's in-flight review write to settle.
   *
   * Only an UNCONFIRMED write is waited for: a saved decision is already visible in the
   * ordinary observation, and no write at all is the ordinary case. This never changes the
   * task's state and never decides anything; it only delays the answer so that a caller
   * who lost the reply to a slow review can still find out what happened.
   * @param {object} task - task record.
   * @param {number} waitMs - the caller's own wait bound.
   * @param {AbortSignal | null} signal - the caller's cancellation.
   * @returns {Promise<object | null>} an observation when the wait changed the answer, else null.
   */
  async awaitReviewSettlement(task, waitMs, signal) {
    const entry = this.reviewState.get(task.taskId) ?? null;
    if (entry === null) return null;
    if (entry.state !== REVIEW_PERSISTENCE_STATES.saving && entry.state !== REVIEW_PERSISTENCE_STATES.timedOut) return null;
    if (entry.done === undefined) return null;
    const bound = Math.max(0, waitMs - OBSERVE_REVIEW_SETTLE_MARGIN_MS);
    if (bound === 0) return null;
    const started = this.clock();
    const outcome = await raceOutcome(entry.done, bound, signal);
    if (outcome === REVIEW_OUTCOME_TIMEOUT) return null;
    if (signal !== null && signal.aborted === true) return null;
    // The write settled inside the wait: report the resulting fact (confirmed or failed)
    // together with how long it took, without re-deriving the task's state.
    const reason = this.settleReason(task) ?? OBSERVE_TASK_REASONS.attention;
    const waitedMs = Math.max(0, this.clock() - started);
    return this.observationOf(task, reason, this.ensureMonitor(task), waitMs, waitedMs, true, null);
  }

  /**
   * Run one bounded internal wait against a task's monitor.
   *
   * The monitor's loop reads the task's own fields through the SAME record, so no
   * step here re-reads a stale copy. This method owns only the registration that
   * lets {@link dispose} release the waiter; it never touches the run.
   * @param {object} monitor - task monitor.
   * @param {object} input - `waitMs` and `signal`.
   * @returns {Promise<{ reason: string, waitedMs: number, activitySinceWait: boolean, selfCheck: object | null }>} outcome.
   */
  async waitForTaskReport(monitor, { waitMs, signal }) {
    const registration = { controller: new AbortController() };
    this.observers.add(registration);
    const forwarded = new AbortController();
    const forward = () => {
      try {
        forwarded.abort();
        registration.controller.abort();
      } catch {
        // Abort is idempotent.
      }
    };
    if (signal !== null) signal.addEventListener?.('abort', forward, { once: true });
    try {
      return await monitor.observe({ waitMs, signal: forwarded.signal });
    } finally {
      this.observers.delete(registration);
      if (signal !== null) signal.removeEventListener?.('abort', forward);
    }
  }

  /**
   * The reason a task's current record implies right now, or null while it is
   * still running with nothing outstanding.
   *
   * Shared by the wait loop and the post-wait re-check, so the two can never
   * disagree about precedence.
   *
   * A terminal state comes FIRST. A task that has ended may still carry a stale
   * `permission.pending` block (a run stopped while a request was outstanding), and
   * reporting that as `permission` would offer a decision for a call that no longer
   * exists — and would keep offering it forever, because nothing will ever settle
   * it. A settled run is reported as settled, and the stored request is history.
   * @param {object} task - task record.
   * @returns {string | null} reason key, or null.
   */
  settleReason(task) {
    const terminal = terminalReason(task);
    if (terminal !== null) return terminal;
    if (task?.permission?.pending !== null && task?.permission?.pending !== undefined) {
      return OBSERVE_TASK_REASONS.permission;
    }
    return null;
  }

  /**
   * Resolve the task one observation may read, refusing identically for every
   * task this caller cannot prove.
   * @param {unknown} taskId - caller-supplied id.
   * @param {unknown} connectionId - the caller's verified connection identity.
   * @returns {object} the task record.
   * @throws {JobError} `JOB_TASK_NOT_FOUND`, indistinguishable across causes.
   */
  taskForObservation(taskId, connectionId) {
    const requested = typeof taskId === 'string' ? taskId.trim() : '';
    const caller = typeof connectionId === 'string' && connectionId !== '' ? connectionId : null;
    const task = requested === '' || caller === null ? undefined : this.tasks.get(requested);
    const owner = task !== null && task !== undefined && typeof task.connectionId === 'string' && task.connectionId !== ''
      ? task.connectionId
      : null;
    // Unknown id, blank id, no verified caller, a task with no recorded owner and
    // another connection's task are one answer with one shape. The details carry
    // only what the caller itself supplied.
    if (task === undefined || owner === null || owner !== caller) {
      throw new JobError(JOB_CODES.taskNotFound, 'no such task for this connection', { taskId: requested });
    }
    return task;
  }

  /**
   * Build the documented observation result.
   *
   * The permission reason carries the WHOLE redacted pending view — request id,
   * exact fingerprint, completeness, bounds, redacted arguments — because a
   * commander cannot decide a shortened operation. Everything else is the compact
   * task summary: no transcript, no execution text, no diff.
   * @param {object} task - task record.
   * @param {string} reason - reported reason.
   * @param {object | null} monitor - task monitor, for the self-check diagnostic.
   * @param {number} waitMs - the bound that applied.
   * @param {number} waitedMs - how long the wait actually took.
   * @param {boolean} activitySinceWait - whether activity arrived during the wait.
   * @param {object | null} [failure] - the repeated-failure diagnostic, when that is
   *   what ended the wait.
   * @returns {object} observation result.
   */
  observationOf(task, reason, monitor, waitMs, waitedMs, activitySinceWait, failure = null) {
    const at = this.clock();
    const summary = this.observationSummary(task, at);
    const pending = task?.permission?.pending ?? null;
    const live = monitor ?? task?.monitor ?? null;
    const selfCheck = live === null || live === undefined ? null : live.snapshot({ at }).selfCheck;
    return {
      task: summary,
      reason,
      // The full, unshortened redacted request on the ONE reason that needs it.
      permission: reason === OBSERVE_TASK_REASONS.permission ? pending : null,
      // The typed, bounded diagnostic for a repeated-failure reminder. It is the only
      // thing that distinguishes that reminder from an ordinary silence report, whose
      // own diagnostic is `selfCheck`.
      failure: reason === OBSERVE_TASK_REASONS.attention && failure !== null ? failure : null,
      activity: summary.activity,
      selfCheck,
      wait: { waitMs, waitedMs: Math.max(0, Math.trunc(waitedMs)), activitySinceWait: activitySinceWait === true },
    };
  }

  /**
   * The compact task summary an observation returns.
   *
   * Deliberately narrower than {@link view}: it carries the facts a waiting caller
   * needs (identity, phase, timing, silence, the tool in flight, the frozen route)
   * and NONE of the evidence a reviewer reads (diff, execution text, review text).
   * @param {object} task - task record.
   * @param {number} at - reference time.
   * @returns {object} compact summary.
   */
  observationSummary(task, at) {
    const monitor = task?.monitor ?? null;
    const activity = monitor === null || monitor === undefined
      ? null
      : monitor.snapshot({ at, toolActive: this.toolActive(task) });
    const startedAt = Number.isFinite(task.startedAt) ? task.startedAt : task.createdAt;
    const endedAt = Number.isFinite(task.endedAt) ? task.endedAt : null;
    return {
      taskId: task.taskId,
      state: task.state,
      title: task.title ?? taskTitle(null, task.prompt),
      phase: task.phase,
      createdAt: task.createdAt ?? null,
      startedAt: task.startedAt ?? null,
      endedAt,
      elapsedMs: Math.max(0, (endedAt ?? at) - (Number.isFinite(startedAt) ? startedAt : at)),
      lastActivityAt: activity === null ? null : activity.lastActivityAt,
      currentTool: activity === null ? null : activity.currentTool,
      idleForMs: activity === null ? null : activity.idleForMs,
      waitingOn: activity === null ? null : activity.waitingOn,
      activity,
      selfCheck: monitor === null || monitor === undefined
        ? null
        : { episode: monitor.selfCheck.episode, checkedAt: monitor.selfCheck.checkedAt, verdict: monitor.selfCheck.verdict },
      // The route this task froze at admission. Reported as the frozen triple, not
      // re-resolved: a settings edit during the wait must not change what a
      // finished run is described as having used.
      route: this.observationRoute(task),
      connectionId: task.connectionId ?? null,
      // Stated so no consumer reads `awaiting-host-review` as acceptance by itself; the
      // recorded review, when one exists, is reported separately below.
      selfApproved: false,
      // The commander's own decision, or null when none has been RECORDED YET. Never
      // derived from the task state: a completed run is not an accepted one, and a
      // decision that is still being written is not accepted either. The note BODY is not
      // carried on a wait (R5): its state, time and length are, plus `noteOmitted`, so the
      // summary stays short without letting an old client read a missing body as "none".
      hostAcceptance: summarizedAcceptance(task.hostAcceptance ?? null),
      // Where that decision is in its durable write, so a waiting host can tell "not
      // reviewed" from "the review is being written right now" and does not resubmit one.
      reviewPersistence: this.reviewPersistenceView(task),
    };
  }

  /**
   * The frozen worker route of one task, for an observation summary.
   * @param {object} task - task record.
   * @returns {object | null} route.
   */
  observationRoute(task) {
    if (task?.effective === null || task?.effective === undefined) return null;
    return {
      providerId: task.effective.worker?.providerId ?? null,
      providerRoute: task.route?.providerRoute ?? null,
      model: task.route?.model ?? task.effective.worker?.model ?? null,
      reasoningEffort: task.route?.reasoningEffort ?? task.effective.worker?.reasoningEffort ?? null,
      isolation: task.effective.worker?.isolation ?? null,
      monitoring: {
        selfCheckSeconds: task.effective.monitoring?.selfCheckSeconds ?? null,
        attentionSeconds: task.effective.monitoring?.attentionSeconds ?? null,
        repeatFailureThreshold: task.effective.monitoring?.repeatFailureThreshold ?? null,
      },
    };
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
    // `hostAcceptance` is NOT reset here. This path runs when a run ends, and a review
    // can only be recorded after that — but a terminal task that somehow reaches this
    // method again must not lose a decision the host already recorded.
    this.clearPreflightDeadline(task);
    // The run is over, so its answerer must go: an outstanding request is released
    // (the worker's paused tool call resumes `unavailable`) and the bridge can never
    // answer a request that outlived the run it belonged to.
    this.releasePermissionBridge(task, 'dispose');
    // The monitor is stopped BEFORE the record is persisted, so no observation can
    // still be waiting on a run that has already ended. The summary survives on the
    // task, so the stored view still says how much activity there was.
    this.releaseMonitor(task);
    await this.finalize(task);
    await this.persistTerminalRecord(task);
    task.settle();
  }

  /**
   * Store a terminal task's record without ever erasing a review.
   *
   * A review can be recorded while `finalize` is still waiting for the executor to confirm
   * it stopped, so the two writes can overlap. The rule is order, not a race:
   *
   *  * a write already IN FLIGHT (`saving`/`timed-out`) is awaited first, so the terminal
   *    snapshot can never be queued behind it and then overwrite its result;
   *  * a `saved` decision is the newest fact, so the older terminal snapshot is skipped —
   *    writing it would erase the conclusion with a view that predates it;
   *  * a confirmed decision already on disk is carried into the new snapshot through
   *    `history.update`, which patches the CURRENT row instead of trusting a stale copy;
   *  * anything else (a settled failure, or no review at all) is a normal snapshot.
   * @param {object} task - terminal task record.
   * @returns {Promise<void>} resolves after the attempt, never rejects.
   */
  async persistTerminalRecord(task) {
    const entry = this.reviewState.get(task.taskId) ?? null;
    if (entry !== null && (entry.state === REVIEW_PERSISTENCE_STATES.saving || entry.state === REVIEW_PERSISTENCE_STATES.timedOut)) {
      await raceOutcome(entry.done, HISTORY_WRITE_TIMEOUT_MS);
    }
    const current = this.reviewState.get(task.taskId) ?? null;
    // A conclusion confirmed in this process — or one already on disk from an earlier
    // process — is the newest fact; the terminal snapshot must not replace it.
    if (current !== null && current.state === REVIEW_PERSISTENCE_STATES.saved) return;
    const stored = await this.confirmedAcceptanceOnDisk(task.taskId).catch(() => null);
    if (stored !== null) {
      const view = this.view(task);
      view.hostAcceptance = stored;
      if (this.history !== null && typeof this.history.update === 'function') {
        try {
          await this.history.update(task.taskId, (row) => {
            const next = { ...view };
            next.hostAcceptance = row?.hostAcceptance ?? stored;
            return next;
          });
          return;
        } catch {
          // fall through to the ordinary bounded write below
        }
      }
    }
    await this.persistHistory(task);
  }

  /**
   * The confirmed review already stored for a task, if any.
   * @param {string} taskId - task id.
   * @returns {Promise<object | null>} the stored acceptance, or null.
   */
  async confirmedAcceptanceOnDisk(taskId) {
    const history = this.history;
    if (history === null || typeof history.load !== 'function') return null;
    const rows = await history.load();
    const row = Array.isArray(rows) ? rows.find((entry) => entry?.taskId === taskId) : undefined;
    return row?.hostAcceptance ?? null;
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
   * @returns {Promise<boolean>} true when the record is durable (or history is absent),
   *   false when the write failed; never rejects.
   */
  async persistHistory(task) {
    const history = this.history;
    if (history === null || history === undefined || typeof history.save !== 'function') return true;
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
      return true;
    } catch (error) {
      // Recorded, not thrown: a history failure must not turn a completed task
      // into a failed one, and it must not escape into the release path.
      task.historyError = {
        code: typeof error?.code === 'string' ? error.code : JOB_CODES.historyFailed,
        message: diagnostic(error?.message ?? error, 300),
      };
      task.historySavedAt = null;
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Build the public view one review write should store.
   *
   * The decision is not in memory yet — that is the whole point of the contract — so the
   * stored view is the task's own projection with THIS decision filled in. It therefore
   * inherits every redaction and every bound the projection applies, and the durable
   * record says exactly what the request said rather than what memory happens to hold.
   * @param {object} task - task record.
   * @param {object} entry - the persistence entry being written.
   * @returns {object} public view carrying the decision under review.
   */
  viewForReviewWrite(task, entry) {
    const view = this.view(task);
    view.hostAcceptance = {
      accepted: entry.decision === HOST_REVIEW_STATES.accepted,
      state: entry.decision,
      acceptedAt: entry.startedAt,
      by: HOST_REVIEW_BY,
      note: entry.note,
    };
    return view;
  }

  /**
   * Read one task's stored row for a caller that proved ownership.
   *
   * This is the R1 seam: after a restart the in-memory map is empty, but a finished task's
   * result is still on disk. The row is a durable RECORD, never a runnable task — no
   * native handle, grant or permission is reconstructed from it, and nothing is put back
   * into `this.tasks`.
   * @param {string} taskId - caller-supplied id.
   * @param {string} connectionId - the caller's verified connection identity.
   * @returns {Promise<object | null>} the stored row, or null when this caller cannot prove it.
   */
  async storedTaskRow(taskId, connectionId) {
    const history = this.history;
    if (history === null || history === undefined || typeof history.load !== 'function') return null;
    const requested = typeof taskId === 'string' ? taskId.trim() : '';
    const caller = typeof connectionId === 'string' && connectionId !== '' ? connectionId : null;
    if (requested === '' || caller === null) return null;
    let rows;
    try {
      rows = await history.load();
    } catch (error) {
      // An unreadable document is not evidence about any one task, so it is reported as an
      // upstream failure rather than "no such task" (which would claim the task never existed).
      throw new JobError(JOB_CODES.historyFailed, 'the stored task history could not be read', {
        code: typeof error?.code === 'string' ? error.code : 'HISTORY_UNREADABLE',
      });
    }
    const row = Array.isArray(rows) ? rows.find((entry) => entry?.taskId === requested) : undefined;
    // A row with no owner recorded is NOT readable by anyone: there is no identity that can
    // prove it, and answering it differently from an unknown id would confirm that it exists.
    if (row === undefined || typeof row.connectionId !== 'string' || row.connectionId === ''
      || row.connectionId !== caller) return null;
    return row;
  }

  /**
   * The public view of a stored row, with the evidence it no longer has stated.
   *
   * `truncation` from the document is kept (it says what was cut on the way to disk) and
   * `evidence` states that this is history: which blocks are absent, whether the stored
   * diff was already truncated, and — crucially — that a stored row is NOT an acceptance.
   * `reviewPersistence` is the SAME projection a live task uses, so an in-flight, timed-out
   * or failed review started in this process is visible through a restored task too; a
   * confirmed conclusion comes from the document, never from memory.
   * @param {object} row - stored history row.
   * @returns {object} redacted public view.
   */
  historyViewOf(row) {
    const view = structuredClone(row);
    // A stored row carries no prompt and no resumable handle; nothing here may look like a
    // task that could be started, continued or approved again.
    delete view.prompt;
    // Only a DURABLE record is acceptance: this is what the document says.
    view.hostAcceptance = row.hostAcceptance ?? null;
    view.reviewPersistence = this.reviewPersistenceView(row);
    view.source = 'history';
    view.selfApproved = false;
    view.evidence = this.historyEvidenceOf(view);
    return redactDeep(view);
  }

  /**
   * State what a stored row does and does not carry.
   *
   * A restored record must never read as "the whole result, accepted": the operator
   * decides whether the remaining evidence is enough, and a field that was cut or was
   * never stored is named rather than silently missing.
   * @param {object} view - history view.
   * @returns {object} bounded evidence statement.
   */
  historyEvidenceOf(view) {
    const absent = [];
    if (view.diff === null || view.diff === undefined || (view.diff.files ?? []).length === 0) absent.push('diff');
    if (view.execution === null || view.execution === undefined || (view.execution.text ?? '') === '') absent.push('execution.text');
    const stored = view.truncation ?? null;
    return {
      source: 'history',
      // Stated explicitly: the run ended before this process started.
      restored: true,
      // A stored row is evidence, never an acceptance.
      accepted: view.hostAcceptance?.accepted === true,
      absent,
      // What the document itself recorded as cut on the way to disk (diff.patchText etc).
      truncatedFields: Array.isArray(stored?.fields) ? stored.fields : [],
      droppedBlocks: Array.isArray(stored?.dropped) ? stored.dropped : [],
      note: 'this result was read from durable history: evidence the document no longer carries is listed here, and only the recorded review counts as acceptance',
    };
  }

  /**
   * Record a review of a task that exists only as a durable record (after a restart).
   *
   * The SAME rules as a live review apply — closed vocabulary, the shared note bound, one
   * conclusion per task, idempotent replay, conflicting refusal — and the write goes
   * through the same serialized store write. What is different is the candidate record:
   * it is the stored row, re-read under the write so the stored evidence is never
   * discarded or partially overwritten.
   * @param {object} taskIdAndOwner - `taskId` and the verified `connectionId`.
   * @param {string} decision - validated decision.
   * @param {string} note - normalized, redacted note.
   * @param {number} waitMs - per-request wait bound.
   * @returns {Promise<object>} `{ task, hostAcceptance, reviewPersistence }`.
   * @throws {JobError} on any refusal.
   */
  async recordHistoricalReview({ taskId, connectionId }, decision, note, waitMs) {
    const input = reviewInput({ decision, note });
    decision = input.decision;
    note = redactText(input.note);
    const row = await this.storedTaskRow(taskId, connectionId);
    // The SAME answer an unknown task gets: the live path refuses an unknown id with this
    // wording, so a restored task must not be distinguishable from a missing one.
    if (row === null) throw new JobError(JOB_CODES.taskNotFound, 'no such task for this connection', { taskId });
    // Only a run that really ENDED in `awaiting-host-review` may be reviewed. A failed,
    // cancelled or interrupted record keeps its real outcome and cannot be turned into a
    // reviewable one, and a live state stored by an older build is equally not reviewable.
    if (row.state !== TASK_STATES.awaitingHostReview) {
      throw new JobError(JOB_CODES.reviewNotReviewable, 'this stored task is not awaiting host review', {
        taskId: row.taskId,
        state: row.state,
      });
    }
    const entry = this.beginHistoryReviewWrite(row, decision, note);
    return await this.awaitHistoryReviewWrite(row, entry, waitMs);
  }

  /**
   * Serialize a historical review write on the store.
   *
   * The row is re-read INSIDE the queued write (see {@link writeHistoryReview}), so the
   * stored evidence is the base and a concurrent terminal write for the same task can only
   * be followed, never overwritten with a stale copy.
   * @param {object} row - the stored row as first read.
   * @param {string} decision - validated decision.
   * @param {string} note - normalized note to record.
   * @returns {object} persistence entry to await.
   * @throws {JobError} on a recorded or in-flight conflict.
   */
  beginHistoryReviewWrite(row, decision, note) {
    const history = this.history;
    if (history === null || history === undefined || typeof history.update !== 'function') {
      throw new JobError(JOB_CODES.reviewNotPersisted,
        'no durable history store is configured, so the review decision was not recorded', {
          taskId: row.taskId,
          historyError: null,
        });
    }
    const recorded = row.hostAcceptance ?? null;
    const key = row.taskId;
    const current = this.reviewState.get(key) ?? null;
    if (current !== null
      && (current.state === REVIEW_PERSISTENCE_STATES.saving || current.state === REVIEW_PERSISTENCE_STATES.timedOut)) {
      if (current.decision === decision && current.note === note) return current;
      throw new JobError(JOB_CODES.reviewNotReviewable,
        'a different review decision is being recorded for this task; wait for it or send a follow-up task', {
          taskId: key,
          recorded: current.decision,
          requested: decision,
        });
    }
    if (recorded !== null && recorded !== undefined) {
      if (recorded.state === decision && recorded.note === note) {
        return { state: REVIEW_PERSISTENCE_STATES.saved, decision, note, token: -1, done: Promise.resolve(true) };
      }
      throw new JobError(JOB_CODES.reviewNotReviewable,
        'this task already has a recorded review; send a follow-up task to record a correction', {
          taskId: key,
          recorded: recorded.state ?? null,
          requested: decision,
        });
    }
    const entry = {
      state: REVIEW_PERSISTENCE_STATES.saving,
      decision,
      note,
      token: (this.reviewSeq ?? 0) + 1,
      startedAt: this.clock(),
      confirmedAt: null,
      error: null,
      historical: true,
      connectionId: row.connectionId,
    };
    this.reviewSeq = entry.token;
    this.reviewState.set(key, entry);
    entry.done = this.writeHistoryReview(key, entry);
    entry.done.catch(() => undefined);
    return entry;
  }

  /**
   * Write one historical review decision, re-reading the stored row under the write.
   * @param {string} taskId - task id.
   * @param {object} entry - persistence entry.
   * @returns {Promise<boolean>} true when the decision is durable.
   */
  async writeHistoryReview(taskId, entry) {
    const acceptance = {
      accepted: entry.decision === HOST_REVIEW_STATES.accepted,
      state: entry.decision,
      acceptedAt: entry.startedAt,
      by: HOST_REVIEW_BY,
      note: entry.note,
    };
    try {
      await this.history.update(taskId, (row) => {
        if (row?.connectionId !== entry.connectionId) {
          throw new JobError(JOB_CODES.taskNotFound, 'no such task for this connection', { taskId });
        }
        if (row?.state !== TASK_STATES.awaitingHostReview) {
          throw new JobError(JOB_CODES.reviewNotReviewable, 'this stored task is not awaiting host review', {
            taskId,
            state: row?.state ?? null,
          });
        }
        if (row.hostAcceptance !== null && row.hostAcceptance !== undefined) {
          if (row.hostAcceptance.state === entry.decision && row.hostAcceptance.note === entry.note) return row;
          throw new JobError(JOB_CODES.reviewNotReviewable,
            'this task already has a recorded review; send a follow-up task to record a correction', { taskId });
        }
        row.hostAcceptance = acceptance;
        return row;
      });
    } catch (error) {
      if (this.reviewState.get(taskId) === entry) {
        entry.state = REVIEW_PERSISTENCE_STATES.failed;
        entry.error = {
          code: typeof error?.code === 'string' ? error.code : JOB_CODES.historyFailed,
          message: diagnostic(error?.message ?? error, 300),
        };
      }
      return false;
    }
    if (this.reviewState.get(taskId) === entry) {
      entry.state = REVIEW_PERSISTENCE_STATES.saved;
      entry.confirmedAt = this.clock();
      entry.error = null;
    }
    return true;
  }

  /**
   * Answer a historical review request from the real persistence state.
   *
   * The answer is always read back from the DOCUMENT: a conclusion is reported only when
   * the stored row carries it. An unresolved write is reported as `timed-out`/`failed`
   * through the same projection a live task uses, never as a saved conclusion assembled
   * from memory, and never with a fabricated review if the row can no longer be read.
   * @param {object} row - the stored row.
   * @param {object} entry - persistence entry.
   * @param {number} timeoutMs - per-request bound (0 = default).
   * @returns {Promise<object>} `{ task, hostAcceptance, reviewPersistence }`.
   * @throws {JobError} when the write failed.
   */
  async awaitHistoryReviewWrite(row, entry, timeoutMs) {
    const answer = async () => {
      const stored = await this.storedTaskRow(row.taskId, row.connectionId);
      if (stored === null) {
        throw new JobError(JOB_CODES.historyFailed,
          'the stored record is no longer available, so the review outcome cannot be confirmed from history',
          { taskId: row.taskId, missingRecord: true });
      }
      const view = this.historyViewOf(stored);
      return { task: view, hostAcceptance: view.hostAcceptance, reviewPersistence: view.reviewPersistence };
    };
    if (entry.state === REVIEW_PERSISTENCE_STATES.saved) {
      return await answer();
    }
    const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REVIEW_WRITE_TIMEOUT_MS;
    const outcome = await raceOutcome(entry.done, bound);
    if (outcome === REVIEW_OUTCOME_TIMEOUT
      && this.reviewState.get(row.taskId) === entry
      && entry.state === REVIEW_PERSISTENCE_STATES.saving) {
      // Unconfirmed, not failed: the write keeps running and a later GET reports the
      // outcome once the document carries it.
      entry.state = REVIEW_PERSISTENCE_STATES.timedOut;
    }
    if (entry.state === REVIEW_PERSISTENCE_STATES.failed) {
      throw new JobError(JOB_CODES.reviewNotPersisted,
        'the review decision could not be written to history, so it was not recorded', {
          taskId: row.taskId,
          historyError: entry.error ?? null,
        });
    }
    return await answer();
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
      // The silence thresholds this task froze at admission. Published so a reader
      // can interpret the activity block without consulting a settings document
      // that may have changed since.
      monitoring: { ...(task.effective.monitoring ?? MONITORING_DEFAULTS) },
      provenance: task.effective.provenance,
    };
    const view = {
      taskId: task.taskId,
      state: task.state,
      title: task.title ?? taskTitle(null, task.prompt),
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
      // A bounded progress summary: counts, timestamps and the tool in flight. It
      // carries no model text, no reasoning, no tool arguments and no diff, so the
      // ordinary task view can show "still working, last activity 12s ago" without
      // becoming a second transcript.
      activity: this.activityView(task),
      hostAcceptance: task.hostAcceptance,
      // Where the review decision is in its durable write: `none`, `saving`, `saved`,
      // `failed` or `timed-out`. Stated as its own field so a reader can tell "no decision"
      // from "the decision is being written right now" WITHOUT having to read a
      // provisional `hostAcceptance`. It never makes an unconfirmed decision look accepted:
      // `accepted` here is true only for a `saved` entry.
      reviewPersistence: this.reviewPersistenceView(task),
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
    // Every observation still waiting is released, and nothing else: an observer
    // is a reader, so ending it must not be mistaken for ending the run. The
    // monitors are disposed with their tasks below.
    for (const registration of [...this.observers]) {
      try {
        registration.controller.abort();
      } catch {
        // Abort is idempotent.
      }
    }
    this.observers.clear();
    let count = 0;
    for (const task of this.tasks.values()) {
      // Every task's monitor is stopped, terminal or not: a monitor outliving the
      // engine would keep a waiter alive against a task nobody may read again.
      this.releaseMonitor(task);
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
 * Clamp one caller-requested observation wait to the documented bound.
 *
 * The ceiling is part of the contract, not a courtesy: an adapter must be able to
 * promise that a request returns within 25 seconds. A missing, negative or
 * non-finite request takes the default rather than a wild value.
 * @param {unknown} waitMs - requested wait in milliseconds.
 * @returns {number} a whole number of milliseconds within `[1, OBSERVE_WAIT_MS]`.
 */
function clampObserveWait(waitMs) {
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs <= 0) return OBSERVE_WAIT_MS;
  return Math.min(OBSERVE_WAIT_MS, Math.max(1, Math.trunc(waitMs)));
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

/**
 * Validate the same review vocabulary and note bound for live and restored tasks.
 * @param {object} request - decision and note.
 * @returns {{ decision: string, note: string }} normalized review input.
 */
function reviewInput(request) {
  const decision = request?.decision;
  if (decision !== HOST_REVIEW_STATES.accepted && decision !== HOST_REVIEW_STATES.changesRequested) {
    throw new JobError(JOB_CODES.reviewInvalid,
      `decision must be ${HOST_REVIEW_STATES.accepted} or ${HOST_REVIEW_STATES.changesRequested}`,
      { field: 'decision' });
  }
  const note = normalizeReviewNote(request?.note);
  if (note === '') {
    throw new JobError(JOB_CODES.reviewInvalid, 'note must be a non-empty string', { field: 'note' });
  }
  if (reviewNoteLength(note) > REVIEW_NOTE_MAX) {
    const overflow = reviewNoteOverflow(note);
    throw new JobError(JOB_CODES.reviewInvalid, overflow.message, {
      field: 'note', limit: overflow.limit, length: overflow.length, unit: 'unicode-code-points',
    });
  }
  return { decision, note };
}

/** Read an optional shorter per-call durability wait, in milliseconds. */
function reviewWaitMs(request) {
  const value = request?.waitMs;
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, REVIEW_WRITE_TIMEOUT_MS);
}

/**
 * Await a promise for at most `ms`, answering a sentinel instead of rejecting.
 *
 * The write keeps its own rejection handler: a failure that lands AFTER the bound expired
 * must not become an unhandled rejection, and the engine reads the outcome from the
 * persistence entry rather than from this race.
 * @param {Promise<unknown>} promise - work to await.
 * @param {number} ms - bound in milliseconds.
 * @param {AbortSignal | null} [signal] - optional caller cancellation.
 * @returns {Promise<unknown | symbol>} the value, or {@link REVIEW_OUTCOME_TIMEOUT}.
 */
async function raceOutcome(promise, ms, signal = null) {
  if (signal?.aborted === true) return REVIEW_OUTCOME_TIMEOUT;
  let onAbort = null;
  let timer = null;
  try {
    return await new Promise((resolvePromise) => {
      timer = setTimeout(() => { resolvePromise(REVIEW_OUTCOME_TIMEOUT); }, ms);
      timer.unref?.();
      if (signal !== null) {
        onAbort = () => { resolvePromise(REVIEW_OUTCOME_TIMEOUT); };
        signal.addEventListener?.('abort', onAbort, { once: true });
      }
      Promise.resolve(promise).then(
        (value) => { resolvePromise(value); },
        () => { resolvePromise(REVIEW_OUTCOME_TIMEOUT); },
      );
    });
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) signal.removeEventListener?.('abort', onAbort);
  }
}

/**
 * A review conclusion as a WAIT reports it: status, time and length, never the body.
 *
 * The object is kept so an old client cannot read "no note" as "not reviewed"; the body is
 * read on demand (R5). `noteOmitted: true` states the omission explicitly.
 * @param {object | null} acceptance - recorded acceptance.
 * @returns {object | null} summarized acceptance.
 */
function summarizedAcceptance(acceptance) {
  if (acceptance === null || typeof acceptance !== 'object') return null;
  return {
    accepted: acceptance.accepted === true,
    state: acceptance.state ?? null,
    acceptedAt: acceptance.acceptedAt ?? null,
    by: acceptance.by ?? null,
    noteChars: typeof acceptance.note === 'string' ? Array.from(acceptance.note).length : (acceptance.noteChars ?? 0),
    noteOmitted: true,
  };
}
