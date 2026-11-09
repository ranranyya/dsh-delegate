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
//      says `wait-limit` and keeps the task identity, so the host can immediately
//      wait again on the SAME task. It never means "review it", "resubmit it" or
//      "it failed".
//
// Metrics are counted HERE and nowhere else: `observationRequests` is the number of
// internal HTTP observations, while `waitReturns` is 1 — the number of answers the
// host actually receives. That distinction is the whole point of the metric, so it
// is a value in the answer rather than something a reader must infer.

import { ACTIONABLE_REASONS, OBSERVE_WAIT_MS, WAIT_LIMIT_REASON, isPermissionDecidable } from './server.js';

/**
 * Reasons on which the wait loop keeps waiting instead of answering.
 *
 * Stated as a set rather than "not in ACTIONABLE_REASONS" so an unknown reason
 * produced by a newer harness is treated as `attention` (a real, actionable
 * answer) instead of silently spinning or being reported as `wait-limit`.
 */
const CONTINUING_REASONS = new Set(['heartbeat']);

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
  // Activity and self-check are small, bounded summaries the engine produced for
  // exactly this purpose; they are carried whole rather than re-projected here.
  if (task.activity !== undefined) out.activity = task.activity;
  if (task.selfCheck !== undefined) out.selfCheck = task.selfCheck;
  return out;
}

/**
 * The instructions a host reads in a wait answer.
 * @param {string} reason - the reported reason.
 * @returns {string} one actionable sentence.
 */
function instructionFor(reason) {
  switch (reason) {
    case WAIT_LIMIT_REASON:
      return 'Nothing changed before this deadline. Call delegate_wait again with the same taskId; '
        + 'do not review, resubmit, restart or cancel the task on account of this answer.';
    case 'permission':
      return 'A per-call permission request is pending. Decide it with delegate_permission_decide using '
        + 'permission.requestId (and permission.fingerprint for allow-once), or reject it. The task is still '
        + 'running and waiting.';
    case 'attention':
      return 'No activity has been observed for about ten minutes while the task is still running. The run may '
        + 'be stuck. Check the current tool and idle time; cancel or follow up deliberately rather than '
        + 'assuming completion.';
    case 'ready':
      return 'The run ended and is awaiting host review. Read delegate_result for the diff and evidence; '
        + 'completion is not host acceptance.';
    case 'failed':
      return 'The run failed. Read delegate_result for the bounded error; the task is not awaiting review.';
    case 'cancelled':
      return 'The task is cancelled. Nothing further will run for it.';
    case 'interrupted':
      return 'The task was interrupted (for example by a process restart) and will not resume. Read '
        + 'delegate_result for what is recorded; do not wait for it to continue.';
    default:
      return 'The task reported a state this host should act on. Read delegate_result for detail.';
  }
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
    if (remaining <= 0) return answer(WAIT_LIMIT_REASON, lastObservation);
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
    return answer(reason, observation);
  }
  /**
   * Build the host-facing answer for one observation.
   * @param {string} reason - reported reason.
   * @param {object | null} observation - the observation that produced it.
   * @returns {object} compact answer.
   */
  function answer(reason, observation) {
    const task = compactTask(observation?.task);
    const out = {
      taskId: typeof task.taskId === 'string' ? task.taskId : taskId,
      state: task.state ?? null,
      phase: task.phase ?? null,
      reason,
      actionable: true,
      // `terminal` is honest about the TASK: `wait-limit` and `attention` are
      // reasons to act, but the run is still going, which a host must not confuse
      // with a finished task.
      terminal: TERMINAL_REASONS.has(reason),
      instruction: instructionFor(reason),
      task,
      metrics: metrics(1),
    };
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
