// The bounded wait loop behind `delegate_wait`.
//
// The shape of the problem: a host must be told when a delegated task needs it — a
// permission request, a finished run, a failure, a cancellation — and it must be
// told ONCE, compactly, instead of polling. A single HTTP request cannot stay open
// for an hour, so one `delegate_wait` call is composed of several BOUNDED
// observation requests, each answered by the harness before it times out.
//
// Three rules make that composition safe:
//
//   1. **Each internal request is bounded.** `waitMs` per request is below the
//      execution plane's own cap, so no request can be the thing that hangs.
//   2. **Only ACTIONABLE answers end the call.** The engine's `heartbeat` reason
//      means "nothing changed yet"; it is consumed here and never surfaced, because a
//      host that saw heartbeats would have a polling loop with extra steps.
//   3. **A deadline is not a result.** When the caller's own time is up the answer
//      says `wait-limit`, `actionable: false` and keeps the task identity, so the host
//      can immediately wait again on the SAME task. It never means "review it",
//      "resubmit it" or "it failed".
//
// Metrics are counted HERE and nowhere else: `observationRequests` is the number of
// internal HTTP observations, while `waitReturns` is 1 — the number of answers the
// host actually receives. That distinction is the whole point of the metric, so it
// is a value in the answer rather than something a reader must infer.
//
// A fourth rule was added after a real acceptance run, and it is subtle enough to
// state at the top: **an interrupted OBSERVATION is not an interrupted RUN.**
//
// The engine reports `interrupted` for two completely different situations — this
// observer's own request ended (the caller's signal aborted, the connection dropped,
// the engine released the waiter during teardown), or a task record that was already
// `interrupted` came back from a restart. The first says nothing about the task: its
// worker is still running and the host must keep waiting on the SAME task. The second
// is a real terminal fact. Treating them alike either told a host that a healthy run
// had ended, or made it re-issue observations against a task that can never progress
// again. So the answer is derived from the TASK, not from the reason label alone.

import {
  ACTIONABLE_REASONS,
  OBSERVE_WAIT_MS,
  WAIT_LIMIT_REASON,
  isPermissionDecidable,
} from './server.js';
import { REPEATED_FAILURE_KIND } from '../jobs/diagnostics.js';

/** Re-exported so a caller can assert the discriminator without importing the engine. */
export { REPEATED_FAILURE_KIND };

/**
 * Reasons on which the wait loop keeps waiting instead of answering.
 *
 * Stated as a set rather than "not in ACTIONABLE_REASONS" so an unknown reason
 * produced by a newer harness is treated as `attention` (a real, actionable
 * answer) instead of silently spinning or being reported as `wait-limit`.
 *
 * `interrupted` is here because the reason alone cannot tell an observer-local
 * interruption from a real terminal history — {@link resolveInterruption} decides
 * from the task record, and that decision is either "keep waiting on this task" or
 * an answer. A reason that arrives with NO task record joins this set only through
 * that resolver's "unknown" branch, which never asserts that the run ended.
 */
const CONTINUING_REASONS = new Set(['heartbeat', 'interrupted']);

/**
 * How long an EARLY heartbeat is spaced out, in ms.
 *
 * A normal heartbeat has already waited out its own `waitMs`; this interval only
 * applies when one arrives sooner than that (a fake engine, or an engine that
 * answers at once), and it exists so such a stream cannot become a request storm.
 * One second per observation is the floor: a one-hour wait against such an engine
 * issues at most 3,600 observations, and a realistic engine issues far fewer.
 */
const EARLY_HEARTBEAT_INTERVAL_MS = 1_000;

/**
 * The task fields a wait answer carries.
 *
 * A wait answer must let a host act, so it carries identity, state, phase, timing
 * and routing — and it must NOT carry the evidence a `delegate_result` answers
 * with: no diff, no execution text, no review prose. That is a size decision and,
 * more importantly, a decision about what a "ping" is allowed to hand to a model.
 */
const TASK_FIELDS = Object.freeze([
  'taskId',
  'state',
  'phase',
  'elapsedMs',
  'lastActivityAt',
  'currentTool',
  'idleForMs',
  'route',
  'createdAt',
  'startedAt',
  'endedAt',
  'conversation',
  'selfApproved',
  'hostAcceptance',
  'cancelledBy',
]);

/**
 * Reasons that are a TERMINAL state of the task, not a request for attention.
 * @type {ReadonlySet<string>}
 */
const TERMINAL_REASONS = new Set(['ready', 'failed', 'cancelled', 'interrupted']);

/**
 * Reasons that ask the host to DO something about the task.
 *
 * `wait-limit` is deliberately absent: it says only that this call's own budget ran
 * out while nothing changed, so the correct next action is to wait again — not to
 * review, decide, resubmit or cancel. Reporting it as actionable would invite a host
 * to treat its own deadline as a business event, which is exactly the confusion this
 * field exists to remove. The flag is a description of the answer, not a guarantee
 * that a host will or will not surface it to its own model.
 * @type {ReadonlySet<string>}
 */
const ACTIONABLE_ANSWER_REASONS = new Set(['attention', 'permission', 'ready', 'failed', 'cancelled', 'interrupted']);

/**
 * Task states a live run can be in.
 *
 * `pending` and `running` mean the task has not settled: an `interrupted` observation
 * about them is an interruption of the OBSERVER only, and waiting must go on.
 */
const LIVE_TASK_STATES = new Set(['pending', 'running']);

/**
 * Reasons whose name IS a settled task state, used only when an observation carried no
 * task state at all. `ready`/`failed`/`cancelled` are finishes this tool can report
 * from the reason alone; `interrupted` is deliberately absent, because that label also
 * describes an interrupted OBSERVER and asserting an end from it is the defect this
 * file exists to prevent.
 */
const TERMINAL_STATE_REASONS = new Set(['ready', 'failed', 'cancelled']);

/**
 * Task states that are a FINISHED run, mapped to the reason a wait reports for them.
 *
 * `awaiting-host-review` is a completion, not a failure: it belongs to `ready`, and a
 * host that was told otherwise would never review the result. This map is what keeps an
 * `interrupted` observation carrying a settled state from being reported as an
 * unrecoverable interruption.
 */
const SETTLED_STATE_REASONS = Object.freeze({
  'awaiting-host-review': 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
});

/**
 * Compact one observation's task view into what a wait answer carries.
 *
 * Anything not named in {@link TASK_FIELDS} is dropped, which is what keeps a wait
 * answer small and keeps a diff from reaching a host through the one tool that is
 * supposed to be cheap.
 * @param {object | null | undefined} task - observation `task`.
 * @returns {object} the compact task.
 */
export function compactTask(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return {};
  const out = {};
  for (const key of TASK_FIELDS) {
    if (task[key] !== undefined) out[key] = task[key];
  }
  // A wait NEVER carries the review note body: the conclusion's state, time and length are
  // what a host needs to act, and the body is read on demand through `delegate_result`.
  // The object is kept (with `noteOmitted`) so an old client cannot read "no note" as
  // "not reviewed", and `reviewPersistence` states whether the conclusion is durable yet.
  const acceptance = out.hostAcceptance;
  if (acceptance !== null && typeof acceptance === 'object' && !Array.isArray(acceptance)) {
    out.hostAcceptance = {
      accepted: acceptance.accepted === true,
      state: acceptance.state ?? null,
      acceptedAt: acceptance.acceptedAt ?? null,
      by: acceptance.by ?? null,
      // Counted from the body when it is here, so the summary states the REAL length even
      // on a view that carries the full note.
      noteChars: acceptance.noteChars ?? (typeof acceptance.note === 'string' ? Array.from(acceptance.note).length : 0),
      noteOmitted: true,
    };
  }
  if (task.reviewPersistence !== undefined) out.reviewPersistence = task.reviewPersistence;
  // Activity and self-check are small, bounded summaries the engine produced for
  // exactly this purpose; they are carried whole rather than re-projected here.
  if (task.activity !== undefined) out.activity = task.activity;
  if (task.selfCheck !== undefined) out.selfCheck = task.selfCheck;
  return out;
}

/**
 * The task state a wait answer reports.
 *
 * The observation's own state is used when the engine published one. When it did not,
 * the state is taken from the REASON only where that reason is a task state by
 * definition (`failed`/`cancelled`); `ready` is a review outcome whose state is
 * `awaiting-host-review`, and inventing `state: "ready"` would publish a state the
 * engine never has. Everything else reports `null`: the wait's own outcomes
 * (`wait-limit`, `attention`, `permission`) describe a live or unreadable task, and
 * inventing "running" for an unreadable record would be a claim this tool cannot make.
 * @param {object} task - compact task.
 * @param {string} reason - reported reason.
 * @returns {string | null} task state.
 */
function resolvedTaskState(task, reason) {
  if (typeof task?.state === 'string' && task.state !== '') return task.state;
  if (SETTLED_STATE_REASONS[reason] !== undefined && reason !== 'ready' && reason !== 'interrupted') return reason;
  return null;
}

/**
 * The instructions a host reads in a wait answer.
 * @param {string} reason - the reported reason.
 * @param {{ resolved?: boolean, taskState?: string | null, kind?: string }} [facts] - `resolved`: the
 *   reason was settled by {@link resolveInterruption} rather than read verbatim;
 *   `taskState`: the state the answer reports, for the `interrupted` wording.
 * @returns {string} one actionable sentence.
 */
function instructionFor(reason, facts = {}) {
  switch (reason) {
    case WAIT_LIMIT_REASON:
      return 'This call\'s own wait budget ran out and NOTHING changed about the task. It is not a result and '
        + 'no decision is needed. Call delegate_wait again with the same taskId (omit waitSeconds); do not '
        + 'review, resubmit, restart or cancel the task on account of this answer.';
    case 'permission':
      return 'A per-call permission request is pending. Decide it with delegate_permission_decide using '
        + 'permission.requestId (and permission.fingerprint for allow-once), or reject it. The task is still '
        + 'running and waiting.';
    case 'attention':
      if (facts.failureKind === REPEATED_FAILURE_KIND) {
        return 'The worker has repeated the SAME tool operation and failed the same way several times in a row, '
          + 'while the task is still running. See `failure` (toolName, failureCode, consecutive). This is a '
          + 'question, not a verdict: decide deliberately whether to keep waiting, cancel, or follow up. Nothing '
          + 'was cancelled or changed automatically, and the run is still going.';
      }
      return 'No activity has been observed for the configured inactivity threshold (ten minutes by default) '
        + 'while the task is still running. The run may be stuck. Check the current tool and idle time; cancel '
        + 'or follow up deliberately rather than assuming completion.';
    case 'ready':
      return 'The run ended and is awaiting host review. Read delegate_result for the diff and evidence; '
        + 'completion is not host acceptance.';
    case 'failed':
      return 'The run failed. Read delegate_result for the bounded error; the task is not awaiting review.';
    case 'cancelled':
      return 'The task is cancelled. Nothing further will run for it.';
    case 'interrupted':
      if (facts.kind === INTERRUPTION_KINDS.unknown || facts.resolved !== true) {
        // The record could not be read as settled. The honest instruction keeps the task
        // identity and forbids asserting an end that was never observed.
        return 'The reported state could not be confirmed as settled. Do not assume the execution ended, and do '
          + 'not assume it is still running: check with delegate_result, or call delegate_wait again with the same '
          + 'taskId, before deciding anything.';
      }
      if (facts.kind === INTERRUPTION_KINDS.history) {
        return 'The task record is itself interrupted (for example by a process restart) and will not resume, so '
          + 'waiting for it cannot help. Read delegate_result for what is recorded, then decide whether a new task '
          + 'is needed; do not keep calling delegate_wait on this taskId.';
      }
      // A LIVE task whose observation was cut off. NOT an error and NOT a result.
      return 'The wait was interrupted while the task was still running; the execution was NOT stopped and this '
        + 'is not a result. Call delegate_wait again with the same taskId; do not review, resubmit, restart or '
        + 'cancel the task on account of this answer.';
    default:
      return 'The task reported a state this host should act on. Read delegate_result for detail.';
  }
}

/** How the wait loop treats one `interrupted` observation. */
export const INTERRUPTION_KINDS = Object.freeze({
  /** This observer's request ended; the task record is still live. Answer and wait again. */
  observation: 'observation',
  /** The task record is itself `interrupted` (a restart left it that way). Terminate. */
  history: 'history',
  /** No usable task state was reported; neither an end nor a live run may be asserted. */
  unknown: 'unknown',
});

/**
 * Decide what an `interrupted` observation actually says about the TASK.
 *
 * The engine emits `interrupted` both when an observer's own request ends and when a
 * persisted, already-`interrupted` record is read back after a restart. The TASK RECORD
 * is the evidence, and only one of its states is an unrecoverable interruption:
 *
 *   * `pending`/`running` with no `endedAt` → {@link INTERRUPTION_KINDS.observation}:
 *     the run is live and the observer's request ended;
 *   * `interrupted` → {@link INTERRUPTION_KINDS.history}: a restart history, which this
 *     build's engine never sets for a live run;
 *   * a KNOWN settled state (`awaiting-host-review`, `failed`, `cancelled`) →
 *     `history`, and {@link resolveInterruption} reports that REAL outcome so a completed
 *     run still reaches host review;
 *   * `pending`/`running` WITH an `endedAt`, and anything else — a missing state, or a
 *     state string this build does not know → {@link INTERRUPTION_KINDS.unknown}. A live
 *     state carrying an end time is a contradictory record: it is neither "running" nor a
 *     known finish, so no terminal claim is made and the host is told to check. An
 *     unknown state is NEVER assumed to be a restart history either.
 *
 * @param {object | null | undefined} task - the observation's compact task.
 * @returns {'observation' | 'history' | 'unknown'} what the interruption says.
 */
export function classifyInterruption(task) {
  const record = task !== null && typeof task === 'object' && !Array.isArray(task) ? task : null;
  const state = record === null ? null : record.state;
  if (typeof state !== 'string' || state === '') return INTERRUPTION_KINDS.unknown;
  const ended = record.endedAt !== null && record.endedAt !== undefined;
  // A live state with an end time contradicts itself: refuse to guess either way.
  if (LIVE_TASK_STATES.has(state)) return ended ? INTERRUPTION_KINDS.unknown : INTERRUPTION_KINDS.observation;
  // Only a state this build recognizes can be called a finish. A newer harness may have
  // states this build has never seen, and guessing "finished" for one of them is how a
  // running task would be silently abandoned.
  if (Object.hasOwn(SETTLED_STATE_REASONS, state)) return INTERRUPTION_KINDS.history;
  return INTERRUPTION_KINDS.unknown;
}

/**
 * The reason and terminal flag a wait answer reports for an `interrupted`
 * observation, after the task record has been read.
 *
 * This is a single point of return: it never loops. For a live task the answer is
 * `interrupted` and NOT terminal (the host waits again on the same task); for a restart
 * history it is `interrupted` and terminal; for a settled record the answer is the REAL
 * outcome (`ready`/`failed`/`cancelled`), so a completed run is never described as an
 * unrecoverable interruption and its review is never blocked.
 * @param {object | null | undefined} observation - the observation.
 * @returns {{ reason: string, terminal: boolean, state: string | null, kind: string }} resolved answer facts.
 */
export function resolveInterruption(observation) {
  const task = compactTask(observation?.task);
  const reported = typeof task.state === 'string' && task.state !== '' ? task.state : null;
  const kind = classifyInterruption(task);
  if (kind === INTERRUPTION_KINDS.unknown) {
    // Neither end nor "still running" is claimed; `state` stays whatever was reported
    // (usually null) and nothing is invented.
    return { reason: 'interrupted', terminal: false, state: reported, kind };
  }
  if (kind === INTERRUPTION_KINDS.history && reported !== null && SETTLED_STATE_REASONS[reported] !== undefined) {
    // The REAL outcome, not the interruption: `awaiting-host-review` is `ready`, so a
    // completed run still reaches host review. Its own review reason wins over the word
    // `interrupted`, which describes only the ended observation.
    return { reason: SETTLED_STATE_REASONS[reported], terminal: true, state: reported, kind };
  }
  // `observation`: a live record whose observer ended. `unknown`: a missing state, an
  // unrecognized one, or a contradictory live-with-`endedAt` record — never claimed as
  // either a finish or a live run.
  return { reason: 'interrupted', terminal: false, state: reported, kind };
}

/**
 * Wait for one task to reach a state the host must act on.
 *
 * The deadline is measured from the FIRST observation, not from "the clock when
 * this function started", so an injected clock is the only thing that decides how
 * much time a wait takes. A loop driven by a fake clock therefore measures its own
 * elapsed time from the wait's real start, which is what a test asserts on.
 * @param {object} options - `callExecution`, `taskId`, `waitMs` (deadline), `signal`,
 *   `observeWaitMs` (per-request bound), `now`, `sleep`.
 * @returns {Promise<object>} the compact wait answer (without `ok`).
 */
export async function waitForTask(options) {
  const callExecution = options.callExecution;
  const taskId = options.taskId;
  const deadlineMs = options.waitMs;
  const observeWaitMs = Math.min(options.observeWaitMs ?? OBSERVE_WAIT_MS, OBSERVE_WAIT_MS);
  const signal = options.signal;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); }));

  const startedAt = now();
  let observationRequests = 0;
  let heartbeats = 0;
  let interruptions = 0;
  let lastObservation = null;

  /** Throw the local cancellation, so the caller sees a refusal and not an answer. */
  const throwIfCancelled = () => {
    if (signal?.aborted !== true) return;
    const error = new Error('the wait was cancelled by the host');
    error.name = 'AbortError';
    error.code = 'MCP_REQUEST_CANCELLED';
    throw error;
  };

  for (;;) {
    throwIfCancelled();
    const remaining = deadlineMs - (now() - startedAt);
    if (remaining <= 0) return answer(WAIT_LIMIT_REASON, lastObservation, { resolved: false });
    // One bounded observation. It never overruns the caller's deadline, so the wait
    // cannot answer later than it said it would.
    const perRequest = Math.min(observeWaitMs, remaining);
    observationRequests += 1;
    let observation;
    try {
      observation = await callExecution('observe', { taskId, waitMs: perRequest }, { signal });
    } catch (error) {
      if (error?.code === 'MCP_REQUEST_CANCELLED') throw error;
      // A refusal is the harness's own answer and is returned as such: an unknown
      // task must read as "no such task", never as an invented completion or as a
      // retry loop against a task that does not exist here.
      return {
        ...failureAnswer(error),
        wait: metrics(0),
      };
    }
    lastObservation = observation;
    const reason = reasonOf(observation);
    if (reason === 'interrupted') {
      // An interrupted OBSERVATION is not an interrupted RUN. This branch returns
      // IMMEDIATELY in every case — it never re-issues an observation in the same call.
      //
      // Re-issuing was the defect: when the observer itself is disposed (the engine was
      // torn down, the wait seam broke, the request's own signal aborted) every
      // re-issued observation came back `interrupted` at once, so one `delegate_wait`
      // call became an unbounded burst of HTTP requests. Returning lets the HOST decide
      // to wait again, which is one observation per call at worst.
      //
      // `resolveInterruption` reads the task record, so the answer is the real state:
      // a live task is reported as `interrupted` and NOT terminal, a restart history as
      // terminal, and a settled record as its real outcome (`ready`/`failed`/`cancelled`)
      // so a completed run still reaches review.
      interruptions += 1;
      const resolved = resolveInterruption(observation);
      return answer(resolved.reason, observation, {
        resolved: true,
        resolvedState: resolved.state,
        terminal: resolved.terminal,
        kind: resolved.kind,
      });
    }
    if (CONTINUING_REASONS.has(reason)) {
      heartbeats += 1;
      // A NORMAL heartbeat has already waited out its own `waitMs` inside the engine,
      // so nothing is slept here. This branch only fires for a heartbeat that came
      // back EARLY (a fake engine, or an engine that answers at once): a per-
      // observation floor keeps such a stream from becoming a request storm. The
      // pause is a slice of that floor, never the remaining deadline — sleeping the
      // remaining budget on the first early heartbeat would turn one observation into
      // the whole wait.
      const elapsed = now() - startedAt;
      // A duration, not an instant: `nextDueOffset` used to be an absolute clock value
      // and subtracting an elapsed duration from it produced a pause of
      // (startedAt + 1s), which swallowed the whole deadline on the first heartbeat.
      const nextDueOffset = observationRequests * EARLY_HEARTBEAT_INTERVAL_MS;
      if (elapsed < nextDueOffset) {
        const pause = Math.min(nextDueOffset - elapsed, remaining);
        if (pause > 0) await sleep(pause);
      }
      continue;
    }
    return answer(reason, observation, { resolved: false });
  }

  /**
   * Build the host-facing answer for one observation.
   * @param {string} reason - reported reason.
   * @param {object | null} observation - the observation that produced it.
   * @param {{ resolved?: boolean, resolvedState?: string | null, terminal?: boolean }} [facts] -
   *   `resolved`: the reason was settled by {@link resolveInterruption} rather than read
   *   verbatim; `resolvedState`/`terminal` are that resolution's own facts.
   * @returns {object} compact answer.
   */
  function answer(reason, observation, facts = {}) {
    const task = compactTask(observation?.task);
    // A resolved interruption carries the state and terminal flag its resolution decided;
    // every other answer derives them from the reason and the published task.
    const state = facts.resolved === true
      ? (facts.resolvedState ?? null)
      : resolvedTaskState(task, reason);
    // The repeated-failure diagnostic, when THAT is what the reminder was about. It is
    // what lets a host tell "silent for ten minutes" from "kept failing the same call",
    // which need different decisions. Only the bounded fields the engine produced travel.
    const failure = reason === 'attention' && observation?.failure !== null
      && typeof observation?.failure === 'object'
      ? observation.failure
      : null;
    const out = {
      taskId: typeof task.taskId === 'string' ? task.taskId : taskId,
      state,
      phase: task.phase ?? null,
      reason,
      // `wait-limit` is NOT actionable: it reports this call's own deadline, not a
      // task fact, and the only correct response is to wait again on the same task.
      actionable: ACTIONABLE_ANSWER_REASONS.has(reason),
      // `terminal` is honest about the TASK: `wait-limit` and `attention` are
      // reasons to act, but the run is still going, which a host must not confuse
      // with a finished task. An interruption carries the flag its resolution decided.
      terminal: facts.resolved === true ? facts.terminal === true : TERMINAL_REASONS.has(reason),
      instruction: instructionFor(reason, {
        resolved: facts.resolved === true,
        taskState: state,
        kind: facts.kind,
        failureKind: failure?.kind ?? null,
      }),
      task,
      metrics: metrics(1),
    };
    if (failure !== null) out.failure = failure;
    // The permission block is carried WHOLE — identity, fingerprint, completeness
    // flags and the redacted operation — because a host that had to read
    // `delegate_result` first would be doing two round trips to answer one question,
    // and a host that reconstructed the operation from a summary would be deciding
    // something the worker never asked for.
    //
    // The engine publishes this as the pending operation ITSELF (the contract:
    // "permission is the full existing redacted pending-operation object including
    // requestId/fingerprint/completeness/arguments"), so the operation is read from
    // the observation directly, with the task-view wrapper honoured for a harness
    // that nests it under `pending`.
    if (reason === 'permission') {
      const block = observation?.permission;
      const pendingOperation = block !== null && typeof block === 'object' && block.pending !== undefined
        ? block.pending
        : block;
      if (pendingOperation !== null && typeof pendingOperation === 'object') {
        out.permission = pendingOperation;
        // Stated so a host does not have to re-derive the rule, and — importantly —
        // derived from the OPERATION AS PUBLISHED by this answer. `boundedJson` runs
        // after this function and may shorten the operation, in which case its own
        // flag-flipping (and the rescue path's forced `permissionDecidable: false`)
        // makes the published answer say "not decidable"; the value here is the
        // pre-bound one and is the truth when nothing has to be cut.
        out.permissionDecidable = isPermissionDecidable(pendingOperation);
      }
    }
    if (observation?.wait !== null && typeof observation?.wait === 'object') out.longPoll = observation.wait;
    return out;
  }

  /**
   * Build the metrics block of one return.
   *
   * `totalWaitMs` is the time this call has spent following the task, which includes
   * the internal observations before the last one. It is separate from `elapsedMs`
   * so a host can tell "the last observation waited 25 s" from "this call has been
   * following the task for twenty minutes".
   * @param {number} waitReturns - how many answers the host has received (0 or 1).
   * @returns {object} metrics with no content and no credentials.
   */
  function metrics(waitReturns) {
    return {
      observationRequests,
      heartbeatsConsumed: heartbeats,
      // Observations that ended because THIS observer's request ended, not because the
      // task reached a state. Counted separately from heartbeats so the two are never
      // read as the same event.
      interruptedObservations: interruptions,
      waitReturns,
      elapsedMs: Math.max(0, now() - startedAt),
      deadlineMs,
      perRequestWaitMs: observeWaitMs,
    };
  }
}

/**
 * The reason an observation reported.
 * @param {object} observation - observation answer.
 * @returns {string} reason, defaulting to `attention` for an unknown one.
 */
export function reasonOf(observation) {
  const reason = observation?.reason;
  if (typeof reason === 'string' && reason !== '') {
    if (CONTINUING_REASONS.has(reason)) return reason;
    if (ACTIONABLE_REASONS.includes(reason)) return reason;
    // An unrecognized reason is a state this host should look at, not a reason to
    // keep waiting: reporting it as `wait-limit` would hide it behind a retry.
    return 'attention';
  }
  return 'attention';
}

/**
 * Turn a thrown refusal into a compact, non-answer result.
 *
 * This is deliberately NOT shaped like a wait answer: `reason` is `null` and the
 * error is named, so a host cannot mistake "the harness could not be asked" for
 * "the task is in this state".
 * @param {unknown} error - thrown value.
 * @returns {object} refusal-shaped result.
 */
function failureAnswer(error) {
  return {
    taskId: null,
    reason: null,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'MCP_CALL_FAILED',
      message: typeof error?.message === 'string' ? error.message : 'the wait could not be completed',
    },
  };
}

/** Re-exported so callers can assert the closed vocabulary without importing the server. */
export { ACTIONABLE_REASONS, WAIT_LIMIT_REASON };
