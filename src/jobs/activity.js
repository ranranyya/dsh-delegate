// Bounded activity bookkeeping for one running delegated task.
//
// This module answers exactly one question — "has this executor been silent, and
// for how long?" — and records the minimum needed to answer it. It is deliberately
// not a transcript, not a progress model and not a log:
//
//   * **Only metadata is retained.** An event contributes a KIND, a COUNT and a
//     timestamp. Reasoning text, assistant text, tool result bodies and tool
//     arguments are read only far enough to decide *whether the event was
//     non-empty*; nothing derived from them is stored, so no buffer here can grow
//     with model output and nothing here can leak a transcript into a view,
//     a history row or a diagnostic.
//   * **The vocabulary is the harness's own.** The classified names are the
//     durable `SessionEventMap` types of `@deepseek-ai/dsh-session` (`step/start`,
//     `assistant/message`, `tool/call`, `tool/result`, plus the turn/step/usage
//     boundaries), the two stream-chunk types `@deepseek-ai/dsh-llm` emits
//     (`text-delta`, `reasoning-delta`), and the nested streaming envelopes the
//     runner accepts (`message/part`, `assistant/delta` wrapping a delta). An
//     event this module does not recognise is `unrelated`, which by contract never
//     resets idleness.
//   * **Only real activity resets the clock.** A non-empty output or reasoning
//     delta — top-level OR nested inside a streaming envelope — an assistant
//     message carrying text or reasoning, a step that actually started, a native
//     tool call and a tool result are activity. Empty deltas, bookkeeping events,
//     connection heartbeats and result polling are NOT: if they reset the clock, a
//     hung executor would look busy forever and the whole silent-wait mechanism
//     would never fire.
//   * **Silence, not duration, raises attention.** An open tool call changes how the
//     silence is DESCRIBED (`waitingOn: 'tool'`, with the call's elapsed span and a
//     `tool-running` self-check verdict) but not WHETHER it counts: a tool that
//     emits nothing for five minutes gets the self-check and for ten minutes gets
//     attention, exactly like any other silent executor. Treating an open call as
//     proof of progress would hide a genuinely hung tool. Nothing here ever fails,
//     cancels or restarts a run because of duration.
//
// The clock is injected (`now`) so tests can simulate twenty minutes of real
// progress deterministically instead of sleeping.

/**
 * How one event kind is classified for idleness.
 *
 * `activity` — the executor demonstrably produced something; resets the idle clock.
 * `structure` — a lifecycle boundary (turn/step boundaries, usage, an empty
 * delta). Observed and counted, never treated as progress.
 * `unrelated` — anything this build does not classify, including heartbeat and
 * polling traffic on an unrelated channel.
 */
export const ACTIVITY_KINDS = Object.freeze({
  activity: 'activity',
  structure: 'structure',
  unrelated: 'unrelated',
});

/** How many distinct event types one summary keeps counts for. */
const MAX_KIND_COUNTS = 32;

/** Bound on a recorded tool name or call id; they are identifiers, not content. */
const MAX_IDENTIFIER_CHARS = 200;

/** Settled call ids remembered so a completion can be matched to its start. */
const MAX_TRACKED_CALL_IDS = 64;

/**
 * Session event types that are PROGRESS, keyed to the evidence they carry.
 *
 * These are `SessionEventMap` members of `@deepseek-ai/dsh-session` (and, for the
 * two delta names, `StreamChunk` types of `@deepseek-ai/dsh-llm`, which reach the
 * same listener). Whether a given event is *genuine* progress is decided by
 * {@link observeProgress}: several of these can arrive carrying nothing.
 */
const ACTIVITY_EVENT_TYPES = Object.freeze({
  // The loop streamed model output. Genuine only when the delta is non-empty.
  'text-delta': 'output-delta',
  'reasoning-delta': 'reasoning-delta',
  // Nested streaming envelopes: `data.delta` carries the same chunk shape. The
  // runner accepts both spellings, so both must be classified — treating them as
  // structural would hide every token of a run that streams nested.
  'message/part': 'output-delta',
  'assistant/delta': 'output-delta',
  // The settled assistant message for one step. Genuine only when it carries text
  // or reasoning; an empty message is a structural event.
  'assistant/message': 'assistant-message',
  // A step actually opened: the model was called.
  'step/start': 'model-step',
  // The model requested one tool invocation.
  'tool/call': 'tool-call',
  // One tool call settled with a model-facing result.
  'tool/result': 'tool-result',
});

/**
 * Session event types that only ever open, close or describe a step.
 *
 * `assistant/message` is handled separately: it is progress only when it carries
 * content, which is the difference between the settled answer and an empty message.
 */
const STRUCTURE_EVENT_TYPES = Object.freeze(new Set([
  'turn/start',
  'turn/end',
  'step/end',
  'assistant/attempt',
  'usage',
]));

/**
 * Classify one native event.
 *
 * @param {unknown} event - the object handed to `request.onEvent`.
 * @returns {{ kind: string, type: string | null, label: string, activity: boolean, tool: object | null }} classification.
 */
export function classifyActivityEvent(event) {
  const unrelated = { kind: ACTIVITY_KINDS.unrelated, type: null, label: 'unrelated', activity: false, tool: null };
  if (event === null || typeof event !== 'object') return unrelated;
  const type = typeof event.type === 'string' ? event.type : null;
  if (type === null) return unrelated;

  const progress = ACTIVITY_EVENT_TYPES[type];
  if (progress !== undefined) {
    const observed = observeProgress(type, event);
    return {
      kind: observed.activity ? ACTIVITY_KINDS.activity : ACTIVITY_KINDS.structure,
      type,
      label: observed.activity ? progress : `${progress}-empty`,
      activity: observed.activity,
      tool: observed.tool,
    };
  }
  if (STRUCTURE_EVENT_TYPES.has(type)) {
    return { kind: ACTIVITY_KINDS.structure, type, label: type, activity: false, tool: null };
  }
  return unrelated;
}

/**
 * Read one progress-shaped event far enough to decide whether it carried
 * anything, and to recover the tool identity when it names one.
 *
 * This is the only place that touches payload fields. It reads text/content ONLY
 * to test emptiness: no string is returned, stored or concatenated.
 * @param {string} type - event type.
 * @param {object} event - event object.
 * @returns {{ activity: boolean, tool: object | null }} observation.
 */
function observeProgress(type, event) {
  if (type === 'text-delta' || type === 'reasoning-delta') {
    const text = payloadOf(event).text;
    // A delta that carries no characters says nothing about progress: the loop
    // can emit an empty chunk while waiting on the provider. A whitespace-only
    // delta is still model output, so it counts.
    return { activity: typeof text === 'string' && text !== '', tool: null };
  }
  if (type === 'message/part' || type === 'assistant/delta') {
    // Nested streaming envelope: the chunk lives under `data.delta` (the runner
    // accepts `data.delta`, `delta`, then `data` itself). Only the delta's TYPE and
    // the emptiness of its text are read; the text is never returned.
    const payload = payloadOf(event);
    const delta = payload.delta ?? event.delta ?? payload;
    if (delta === null || typeof delta !== 'object') return { activity: false, tool: null };
    const deltaType = delta.type;
    if (deltaType !== 'text-delta' && deltaType !== 'reasoning-delta') {
      return { activity: false, tool: null };
    }
    const text = delta.text;
    return { activity: typeof text === 'string' && text !== '', tool: null };
  }
  if (type === 'assistant/message') {
    const payload = payloadOf(event);
    const message = payload.message ?? event.message ?? null;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      if ((block.type === 'text' || block.type === 'reasoning')
        && typeof block.text === 'string' && block.text !== '') {
        return { activity: true, tool: null };
      }
    }
    return { activity: false, tool: null };
  }
  if (type === 'tool/call') {
    // `payloadOf` already falls back to the event object itself, so this reads
    // `data.name` when the native envelope is present and a top-level `name`
    // otherwise. The ARGUMENTS are deliberately not read at all, so this module
    // cannot retain or forward them.
    const payload = payloadOf(event);
    const name = identifier(payload.name);
    const callId = identifier(payload.callId ?? payload.id);
    return { activity: name !== null, tool: { name, callId } };
  }
  if (type === 'tool/result') {
    // Native shape: `data.message.toolCallId` (the tool-role result message).
    const message = payloadOf(event).message;
    const callId = identifier(message?.toolCallId ?? payloadOf(event).callId);
    // Any settled tool result is progress, including a failed one: the tool ran.
    return { activity: true, tool: { name: null, callId } };
  }
  if (type === 'step/start') {
    return { activity: true, tool: null };
  }
  return { activity: false, tool: null };
}

/**
 * The payload of a native event.
 *
 * Native events carry their payload under `data` (`{ type, seq, time, data }`),
 * and the streaming shapes a fake or a legacy emitter produces put the same fields
 * at the top level. Both spellings are accepted, `data` first.
 * @param {object} event - event object.
 * @returns {object} payload object (never null).
 */
function payloadOf(event) {
  const data = event.data;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data;
  return event;
}

/**
 * Bound an identifier-shaped value (a tool name or a call id).
 *
 * Bounded and type-checked, never interpreted: these names are published so an
 * operator can see WHAT is running, and a pathological value cannot grow a view.
 * @param {unknown} value - candidate.
 * @returns {string | null} bounded identifier, or null.
 */
function identifier(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.slice(0, MAX_IDENTIFIER_CHARS);
  return trimmed === '' ? null : trimmed;
}

/**
 * Bounded activity state of one running task.
 *
 * Owned by the engine's per-task monitor. Every field is a scalar or a small
 * bounded map; there is no reference to the event object that produced it.
 */
export class TaskActivity {
  /**
   * @param {object} [options] - `now` clock override (tests).
   */
  constructor(options = {}) {
    /** @type {() => number} */
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    /** @type {number | null} */
    this.lastActivityAt = null;
    /** @type {number} */
    this.replacements = 0;
    /** @type {{ name: string | null, callId: string | null, startedAt: number } | null} */
    this.tool = null;
    /** Settled tool calls represented as a count only — never their content. */
    this.toolCallsStarted = 0;
    this.toolCallsFinished = 0;
    this.lastToolName = null;
    this.lastToolDurationMs = null;
    /** @type {Map<string, number>} */
    this.counts = new Map();
    /** @type {Map<string, number>} */
    this.openCalls = new Map();
    /** @type {Map<string, number>} */
    this.eventCounts = new Map();
    /** Bumped on every genuine activity; used to reset one wait's episode view. */
    this.sequence = 0;
    /**
     * Genuine activity events, counted independently of the label map.
     *
     * The map is bounded and its keys can be evicted, so summing it would make the
     * published count both imprecise (structure and unrelated labels would be
     * included) and lossy. This counter is only ever incremented for real progress.
     */
    this.activityCount = 0;
    /** Total observations, counted independently of the bounded per-type map. */
    this.eventCount = 0;
    /**
     * Set once the run reached a terminal state. From then on every elapsed value is
     * measured against the recorded end, so a stored record cannot appear to keep
     * growing (a "tool running for 4 hours" that ended twenty minutes ago).
     * @type {{ endedAt: number } | null}
     */
    this.final = null;
  }

  /**
   * Record one observation.
   *
   * @param {object} observation - result of {@link classifyActivityEvent}.
   * @param {number} [at] - observation timestamp.
   * @returns {boolean} whether this observation was real activity.
   */
  record(observation, at = this.now()) {
    assertObservation(observation);
    if (this.final !== null) return false;
    this.replacements += 1;
    if (this.eventCount < Number.MAX_SAFE_INTEGER) this.eventCount += 1;
    const counted = this.counts.get(observation.label) ?? 0;
    if (counted < Number.MAX_SAFE_INTEGER) this.counts.set(observation.label, counted + 1);
    if (observation.type !== null) {
      const perType = this.eventCounts.get(observation.type) ?? 0;
      if (perType < Number.MAX_SAFE_INTEGER) this.eventCounts.set(observation.type, perType + 1);
    }
    this.pruneCounts();
    if (observation.tool !== null) this.recordTool(observation.tool, at);
    if (observation.activity !== true) return false;
    if (this.activityCount < Number.MAX_SAFE_INTEGER) this.activityCount += 1;
    this.lastActivityAt = at;
    this.sequence += 1;
    return true;
  }

  /**
   * Freeze every elapsed value at the instant the run ended.
   *
   * Called once, when the task reaches a terminal state. A view or a stored record
   * read an hour later then reports the span the run actually had, not an idle or
   * tool-elapsed duration that keeps growing for a run nobody is following.
   * @param {number} endedAt - the recorded end time.
   * @returns {void}
   */
  finalize(endedAt) {
    if (this.final !== null) return;
    const at = Number.isFinite(endedAt) ? endedAt : this.now();
    this.final = { endedAt: at };
  }

  /**
   * The reference time elapsed values are measured against.
   *
   * Live: the caller's `at`. Finalized: the recorded end, so nothing grows.
   * @param {number} at - requested reference time.
   * @returns {number} the effective reference time.
   */
  referenceTime(at) {
    if (this.final !== null) return this.final.endedAt;
    return at;
  }

  /**
   * Track the tool call a `tool/call` (or `tool/result`) event named.
   *
   * A start opens a span; a result closes the matching span and records how long
   * it ran. Nothing about the tool's arguments or result is kept.
   * @param {{ name: string | null, callId: string | null }} tool - identity.
   * @param {number} at - observation timestamp.
   * @returns {void}
   */
  recordTool(tool, at) {
    const callId = tool.callId;
    if (tool.name !== null) {
      this.lastToolName = tool.name;
      this.toolCallsStarted += 1;
      this.tool = { name: tool.name, callId, startedAt: at };
      if (callId !== null) {
        this.openCalls.set(callId, at);
        while (this.openCalls.size > MAX_TRACKED_CALL_IDS) {
          const oldest = this.openCalls.keys().next();
          if (oldest.done === true) break;
          this.openCalls.delete(oldest.value);
        }
      }
      return;
    }
    if (callId !== null && this.openCalls.has(callId)) {
      const startedAt = this.openCalls.get(callId);
      this.openCalls.delete(callId);
      this.lastToolDurationMs = Math.max(0, at - startedAt);
      this.toolCallsFinished += 1;
      if (this.tool !== null && this.tool.callId === callId) this.tool = null;
    }
  }

  /**
   * Keep the counters bounded.
   *
   * Both maps are keyed by a closed vocabulary (the labels and types this module
   * classifies), so they cannot grow with model output; the cap exists so a future
   * classifier that learns more keys cannot turn this into unbounded memory.
   * @returns {void}
   */
  pruneCounts() {
    while (this.counts.size > MAX_KIND_COUNTS) {
      const oldest = this.counts.keys().next();
      if (oldest.done === true) break;
      this.counts.delete(oldest.value);
    }
    while (this.eventCounts.size > MAX_KIND_COUNTS) {
      const oldest = this.eventCounts.keys().next();
      if (oldest.done === true) break;
      this.eventCounts.delete(oldest.value);
    }
  }

  /** @returns {number} total observations recorded. */
  totalEvents() {
    return this.eventCount;
  }

  /** @returns {number} genuine activity events. */
  activityEvents() {
    return this.activityCount;
  }

  /**
   * Milliseconds since the last genuine activity, or null when there was none.
   * @param {number} [at] - reference time.
   * @returns {number | null} idle span.
   */
  idleForMs(at = this.now()) {
    if (this.lastActivityAt === null) return null;
    return Math.max(0, this.referenceTime(at) - this.lastActivityAt);
  }

  /**
   * The pending tool span, described without any argument or result text.
   * @param {number} [at] - reference time.
   * @returns {{ name: string | null, callId: string | null, startedAt: number, elapsedMs: number } | null} span.
   */
  toolSpan(at = this.now()) {
    if (this.tool === null) return null;
    return {
      name: this.tool.name,
      callId: this.tool.callId,
      startedAt: this.tool.startedAt,
      elapsedMs: Math.max(0, this.referenceTime(at) - this.tool.startedAt),
    };
  }

  /**
   * The bounded, publishable summary of this activity.
   *
   * Everything here is a count, a timestamp or an identifier. There is no field a
   * text fragment, an argument or a result body could be carried in.
   * @param {object} [options] - `at` reference time, `toolActive` whether a tool
   *   call is currently outstanding.
   * @returns {object} summary.
   */
  summary({ at = this.now(), toolActive = false } = {}) {
    const span = toolActive ? this.toolSpan(at) : null;
    return {
      lastActivityAt: this.lastActivityAt,
      // `idleForMs` is the honest silence span. While a native tool call is
      // outstanding the executor is working, not idle, so the same field reports
      // the tool's elapsed span and `waitingOn` says which of the two it is.
      idleForMs: span === null ? this.idleForMs(at) : span.elapsedMs,
      waitingOn: span === null ? 'idle' : 'tool',
      currentTool: span === null
        ? null
        : { name: span.name, callId: span.callId, startedAt: span.startedAt, elapsedMs: span.elapsedMs },
      lastTool: this.lastToolName === null
        ? null
        : { name: this.lastToolName, durationMs: this.lastToolDurationMs },
      events: this.totalEvents(),
      activityEvents: this.activityEvents(),
      toolCallsStarted: this.toolCallsStarted,
      toolCallsFinished: this.toolCallsFinished,
      // Stated when the record was frozen, so a reader can tell "this is the final
      // span" from "this is still being measured".
      finalizedAt: this.final === null ? null : this.final.endedAt,
      // Per-kind counts, bounded and sorted for a stable view.
      kinds: Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    };
  }
}

/**
 * Guard against a caller passing a value this class cannot read.
 * @param {unknown} observation - candidate observation.
 * @returns {void}
 */
function assertObservation(observation) {
  if (observation === null || typeof observation !== 'object') {
    throw new TypeError('activity observation must be an object');
  }
}

/** Why one observation wait ended. */
export const OBSERVE_REASONS = Object.freeze({
  heartbeat: 'heartbeat',
  attention: 'attention',
  permission: 'permission',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
});

/**
 * Reasons no caller may ever receive from {@link TaskMonitor#observe}.
 *
 * `heartbeat` means "nothing to report, ask again"; handing it to a caller would
 * be indistinguishable from a real report, so the loop treats it as an internal
 * re-wait instead.
 */
const INTERNAL_REASONS = Object.freeze(new Set([OBSERVE_REASONS.heartbeat]));

/**
 * The task states that end an observation, mapped to the reason reported.
 *
 * Read from the engine's own lifecycle vocabulary rather than re-declared, so a
 * new terminal state cannot leave the monitor silently reporting `heartbeat` for a
 * finished run.
 */
const TERMINAL_REASON = Object.freeze({
  'awaiting-host-review': OBSERVE_REASONS.ready,
  failed: OBSERVE_REASONS.failed,
  cancelled: OBSERVE_REASONS.cancelled,
});

/** The phase a running task reports while a permission request is outstanding. */
const PHASE_AWAITING_PERMISSION = 'awaiting-permission';

/**
 * One task's activity monitor.
 *
 * Owned by the engine and attached to the task record, so the counters live next
 * to the run that produced them and die with it. It owns three things and nothing
 * else:
 *
 *  1. the bounded activity state ({@link TaskActivity}), fed from the native
 *     `onEvent` callback the runner already invokes;
 *  2. the *episode* bookkeeping that makes silent waiting silent — a
 *     self-check fires once per idle episode, and an `attention` report is not
 *     repeated until the interval has really elapsed and the caller has asked
 *     again;
 *  3. the observation wait itself, built from injected `now`/`wait` seams so a test
 *     can simulate twenty minutes in microseconds.
 *
 * What it must never do, and does not: run an LLM, read a diff or a workspace
 * file, mutate the task, restart/cancel/resubmit a run, or extend a deadline. The
 * self-check is a read of facts the engine already holds.
 */
export class TaskMonitor {
  /**
   * @param {object} task - the engine's own task record for this run.
   * @param {object} [options] - seams and thresholds.
   * @param {() => number} [options.now] - clock.
   * @param {(ms: number) => Promise<void>} [options.wait] - bounded sleep.
   * @param {number} [options.selfCheckSeconds] - idle span for the self-check.
   * @param {number} [options.attentionSeconds] - idle span for `attention`.
   * @param {number} [options.waitSliceMs] - internal polling slice.
   * @param {(message: string, detail?: unknown) => void} [options.log] - diagnostic sink.
   */
  constructor(task, options = {}) {
    this.task = task;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.wait = typeof options.wait === 'function' ? options.wait : sleep;
    this.selfCheckMs = secondsToMs(options.selfCheckSeconds, 300);
    this.attentionMs = secondsToMs(options.attentionSeconds, 600);
    this.waitSliceMs = Number.isSafeInteger(options.waitSliceMs) && options.waitSliceMs > 0
      ? options.waitSliceMs
      : 1000;
    this.log = typeof options.log === 'function' ? options.log : null;
    this.activity = new TaskActivity({ now: this.now });
    /** Episode identity: bumped whenever genuine activity ends the idle episode. */
    this.episode = 0;
    /** The episode the self-check already ran for, or null. */
    this.checkedEpisode = null;
    /** The last self-check diagnostic, published on every summary. */
    this.selfCheck = { episode: null, checkedAt: null, verdict: null, detail: null };
    /**
     * When the most recent attention report was DELIVERED, and for which idle
     * episode.
     *
     * Exactly one pair, never a growing collection: the cooldown is a property of
     * the current silence, and an idle origin only moves forward, so an older entry
     * could never be reached again. `null` means "no attention has been delivered
     * for this episode yet".
     * @type {{ episode: number, origin: number, at: number } | null}
     */
    this.attentionDelivered = null;
    /**
     * Every observation currently waiting, so each one owns its own controller and
     * one observer can never cancel another. Bounded by the number of callers; an
     * entry is removed in its own `finally`.
     * @type {Set<object>}
     */
    this.waiters = new Set();
    this.disposed = false;
  }

  /**
   * Record one native event.
   *
   * Called from the runner's `onEvent` hook, which means it runs inside the
   * native dispatch path: nothing here may throw, await, or retain the event.
   * @param {unknown} event - native event object.
   * @param {number} [at] - observation time.
   * @returns {boolean} whether this event was real activity.
   */
  onEvent(event, at = this.now()) {
    if (this.disposed) return false;
    let observation;
    try {
      observation = classifyActivityEvent(event);
    } catch {
      // A malformed event is not a reason to disturb the run that produced it.
      return false;
    }
    try {
      const active = this.activity.record(observation, at);
      // Real activity ends the current idle episode. The episode identity is what
      // makes "once per episode" true for the self-check and the attention latch:
      // without it, a run that goes quiet, wakes, and goes quiet again would be
      // treated as the SAME silence and could never alert a second time.
      if (active) this.episode += 1;
      return active;
    } catch {
      return false;
    }
  }

  /**
   * The instant the current idle episode began.
   *
   * Before the executor has produced anything, the episode begins when its run
   * began — a model that never streams a token is silent from the start, and
   * measuring from "never" would hide it.
   * @returns {number} epoch milliseconds.
   */
  idleOrigin() {
    if (this.activity.lastActivityAt !== null) return this.activity.lastActivityAt;
    if (Number.isFinite(this.task?.startedAt)) return this.task.startedAt;
    if (Number.isFinite(this.task?.createdAt)) return this.task.createdAt;
    return this.now();
  }

  /**
   * Whether the current inactivity episode has reached the self-check threshold.
   * @param {number} [at] - reference time.
   * @returns {boolean} true when one read-only inspection is due.
   */
  selfCheckDue(at = this.now()) {
    return at - this.idleOrigin() >= this.selfCheckMs;
  }

  /**
   * Perform the 5-minute read-only inspection, at most once per idle episode.
   *
   * The inspection reads only what the engine itself already holds: whether the
   * task is alive, whether its executor settled, the phase, whether a permission
   * request is pending, and which tool call is outstanding. It performs no model
   * call, reads no diff or workspace file, changes no task state, and does not
   * touch the deadline.
   * @param {number} [at] - reference time.
   * @returns {object | null} the diagnostic, or null when none was due.
   */
  runSelfCheck(at = this.now()) {
    if (this.disposed) return null;
    if (!this.selfCheckDue(at)) return null;
    const episode = this.episode;
    if (this.checkedEpisode === episode) return null;
    this.checkedEpisode = episode;
    this.selfCheck = this.inspect(at, episode);
    return this.selfCheck;
  }

  /**
   * The last self-check diagnostic, or null when none ever ran.
   * @returns {object | null} diagnostic.
   */
  lastSelfCheck() {
    return this.selfCheck.checkedAt === null ? null : this.selfCheck;
  }

  /**
   * Build the read-only diagnostic for the current episode.
   * @param {number} at - reference time.
   * @param {number} episode - episode identity.
   * @returns {object} bounded diagnostic.
   */
  inspect(at, episode) {
    const task = this.task ?? {};
    const pending = task.permission?.pending ?? null;
    const span = this.activity.toolSpan(at);
    const idleMs = Math.max(0, at - this.idleOrigin());
    const nativeStarted = task.native?.started === true;
    const nativeSettled = task.native?.settled === true;
    let verdict;
    if (task.state === 'pending' || task.state === 'running') {
      if (pending !== null) verdict = 'waiting-for-permission';
      else if (span !== null) verdict = 'tool-running';
      else if (nativeStarted && !nativeSettled) verdict = 'executor-alive-silent';
      else if (!nativeStarted) verdict = 'executor-not-started';
      else verdict = 'idle-between-steps';
    } else {
      verdict = 'settled';
    }
    return {
      episode,
      checkedAt: at,
      idleMs,
      verdict,
      detail: {
        state: typeof task.state === 'string' ? task.state : null,
        phase: typeof task.phase === 'string' ? task.phase : null,
        nativeStarted,
        nativeSettled,
        permissionPending: pending !== null,
        permissionRequestId: pending !== null && typeof pending.requestId === 'string' ? pending.requestId : null,
        phaseIsPermissionWait: task.phase === PHASE_AWAITING_PERMISSION,
        currentTool: span === null ? null : { name: span.name, callId: span.callId, elapsedMs: span.elapsedMs },
        lastActivityAt: this.activity.lastActivityAt,
        activityEvents: this.activity.activityEvents(),
        events: this.activity.totalEvents(),
      },
    };
  }

  /**
   * Whether the current silence is old enough for an attention report, ignoring the
   * cooldown of an earlier delivery.
   * @param {number} [at] - reference time.
   * @returns {boolean} true when the idle span has reached the threshold.
   */
  attentionDue(at = this.now()) {
    return at - this.idleOrigin() >= this.attentionMs;
  }

  /**
   * The instant the next attention report may be delivered, or `Infinity` while the
   * thresholds have not been reached at all.
   *
   * The rule is a cooldown, not a one-shot latch: the FIRST report is due at
   * `idleOrigin + attentionSeconds`, and every later report for the same silence
   * needs a FURTHER `attentionSeconds` since the previous delivery. Genuine
   * activity resets both the origin and the delivery record, so a run that goes
   * quiet again can alert again.
   * @returns {number} the next deliverable instant.
   */
  nextAttentionAt() {
    const origin = this.idleOrigin();
    const delivered = this.attentionDelivered;
    let next = origin + this.attentionMs;
    if (delivered !== null && delivered.episode === this.episode && delivered.origin === origin) {
      next = Math.max(next, delivered.at + this.attentionMs);
    }
    return next;
  }

  /**
   * Whether an attention report may be delivered at `at`, and atomically claims it
   * if so.
   *
   * The claim happens in the same synchronous step as the test, so two observers
   * reaching the threshold together cannot both return `attention`: the first
   * claims, the second observes the fresh delivery record and keeps waiting.
   * @param {number} [at] - delivery instant.
   * @returns {boolean} true for the observer that won the claim.
   */
  claimAttention(at = this.now()) {
    if (at < this.nextAttentionAt()) return false;
    this.attentionDelivered = { episode: this.episode, origin: this.idleOrigin(), at };
    return true;
  }

  /**
   * Publishable activity summary for a task view.
   *
   * `toolActive` is passed by the caller because only the engine can decide what a
   * long tool span means: a pending permission request already reports its own
   * reason, and a settled run is not "waiting on a tool" at all.
   * @param {object} [options] - `at` reference time, `toolActive`.
   * @returns {object} bounded summary.
   */
  snapshot({ at = this.now(), toolActive = false } = {}) {
    const summary = this.activity.summary({ at, toolActive });
    return {
      ...summary,
      // Stated so a reader never has to derive the thresholds from a settings
      // document that may have changed since this task froze its own.
      selfCheckSeconds: Math.round(this.selfCheckMs / 1000),
      attentionSeconds: Math.round(this.attentionMs / 1000),
      idleForMs: this.activity.idleForMs(at),
      selfCheck: {
        episode: this.selfCheck.episode,
        checkedAt: this.selfCheck.checkedAt,
        verdict: this.selfCheck.verdict,
      },
    };
  }

  /**
   * Release every waiter this monitor owns. Called only by {@link dispose}.
   *
   * Each waiter aborts its own controller; one observation ending never touches
   * another.
   * @returns {void}
   */
  releaseWaiters() {
    for (const waiter of [...this.waiters]) {
      try {
        waiter.controller.abort();
      } catch {
        // Abort is idempotent.
      }
    }
    this.waiters.clear();
  }

  /**
   * The bounded observation wait documented for adapters (HTTP/MCP).
   *
   * What it reports, in precedence order, re-checked on every slice:
   *
   *  1. `interrupted` — this observer's own signal aborted, or the monitor was
   *     disposed. The WORKER is untouched;
   *  2. `ready`/`failed`/`cancelled` — the task reached a terminal state. This wins
   *     over a disposal wake, so an observation released by engine teardown still
   *     reports the outcome the run actually reached;
   *  3. `permission` — a per-call decision is outstanding. Waiting for approval is
   *     not a stall;
   *  4. `attention` — the silence reached `attentionSeconds` (once, then on the
   *     cooldown) AND the claim was won. Genuine progress never produces this: it
   *     resets the silence instead, which is the whole point of the feature;
   *  5. `heartbeat` — the bounded wait expired with nothing to report.
   *
   * The self-check runs inside the loop, so a monitor with no observer costs
   * nothing. Every caller gets its own controller and timer, so an observation
   * never cancels another.
   * @param {object} [options] - `waitMs`, `signal`.
   * @returns {Promise<{ reason: string, activitySinceWait: boolean, waitedMs: number, selfCheck: object | null }>} outcome.
   */
  async observe(options = {}) {
    const signal = options.signal ?? null;
    // A terminal outcome is a READ of the task record, so it is answered even by a
    // disposed monitor: engine teardown stops the observation loops, but it must
    // never turn a finished run into "interrupted".
    const settledNow = terminalReason(this.task);
    if (settledNow !== null) return this.outcome(settledNow, false, 0, this.lastSelfCheck());
    if (this.disposed) return this.outcome(OBSERVE_REASONS.interrupted, false, 0, null);
    if (signal !== null && signal.aborted === true) return this.outcome(OBSERVE_REASONS.interrupted, false, 0, null);

    const waitMs = boundedWait(options.waitMs);
    const startedAt = this.now();
    const startingSequence = this.activity.sequence;
    const waiter = { controller: new AbortController() };
    this.waiters.add(waiter);
    const onAbort = () => {
      try {
        waiter.controller.abort();
      } catch {
        // Unreachable; abort is idempotent.
      }
    };
    if (signal !== null) signal.addEventListener?.('abort', onAbort, { once: true });

    let selfCheck = null;
    try {
      for (;;) {
        const at = this.now();
        const activitySinceWait = this.activity.sequence !== startingSequence;
        // A pure read of local facts, run BEFORE any reason is returned so every
        // report carries the diagnostic that explains the silence.
        const checked = this.runSelfCheck(at);
        if (checked !== null) selfCheck = checked;

        // (2) The run's own outcome outranks a wake-up: a task that ended must be
        // reported as ended even if the monitor was disposed in the same instant.
        const terminal = terminalReason(this.task);
        if (terminal !== null) return this.outcome(terminal, activitySinceWait, at - startedAt, selfCheck);

        // (1) Only one's OWN abort (or disposal) interrupts.
        if (this.disposed || waiter.controller.aborted === true || (signal !== null && signal.aborted === true)) {
          return this.outcome(OBSERVE_REASONS.interrupted, activitySinceWait, at - startedAt, selfCheck);
        }

        if (this.task?.permission?.pending !== null && this.task?.permission?.pending !== undefined) {
          return this.outcome(OBSERVE_REASONS.permission, activitySinceWait, at - startedAt, selfCheck);
        }
        // (4) `claimAttention` is false while genuine progress has reset the clock,
        // because the origin moved into the future relative to `nextAttentionAt()`.
        if (this.claimAttention(at)) {
          return this.outcome(OBSERVE_REASONS.attention, activitySinceWait, at - startedAt, selfCheck);
        }
        const elapsed = at - startedAt;
        if (elapsed >= waitMs) {
          return this.outcome(OBSERVE_REASONS.heartbeat, activitySinceWait, elapsed, selfCheck);
        }
        const untilAttention = this.nextAttentionAt() - at;
        const slice = Math.max(1, Math.min(this.waitSliceMs, waitMs - elapsed, untilAttention));
        try {
          await this.wait(slice, { signal: waiter.controller.signal });
        } catch {
          // A wait seam that rejects ends THIS observation only. The worker and
          // every other observer are untouched.
          return this.outcome(OBSERVE_REASONS.interrupted, activitySinceWait, this.now() - startedAt, selfCheck);
        }
      }
    } finally {
      this.waiters.delete(waiter);
      if (signal !== null) signal.removeEventListener?.('abort', onAbort);
    }
  }

  /**
   * Build one observation outcome.
   * @param {string} reason - reported reason.
   * @param {boolean} activitySinceWait - whether progress arrived during the wait.
   * @param {number} waitedMs - observed duration.
   * @param {object | null} selfCheck - the last self-check diagnostic.
   * @returns {object} outcome.
   */
  outcome(reason, activitySinceWait, waitedMs, selfCheck) {
    return {
      reason,
      activitySinceWait: activitySinceWait === true,
      waitedMs: Math.max(0, Math.trunc(waitedMs)),
      selfCheck,
    };
  }

  /**
   * Drop every listener/timer this monitor owns. Idempotent.
   *
   * Marking the activity final first freezes the elapsed values at the end
   * recorded on the task, so nothing published afterwards grows.
   * @param {number} [endedAt] - the run's recorded end, when known.
   * @returns {void}
   */
  dispose(endedAt = undefined) {
    if (typeof endedAt === 'number') this.activity.finalize(endedAt);
    if (this.disposed) return;
    this.disposed = true;
    this.releaseWaiters();
  }
}

/**
 * Whether one internal reason may be handed to a caller.
 * @param {string} reason - reason value.
 * @returns {boolean} true when a caller should receive it.
 */
export function isPublicReason(reason) {
  return typeof reason === 'string' && Object.values(OBSERVE_REASONS).includes(reason) && !INTERNAL_REASONS.has(reason);
}

/**
 * The reason a task's current state implies, or null while it is still running.
 * @param {object} task - engine task record.
 * @returns {string | null} reason.
 */
export function terminalReason(task) {
  const state = task?.state;
  if (typeof state !== 'string') return null;
  return TERMINAL_REASON[state] ?? null;
}

/**
 * Clamp a caller-requested wait to the documented bound.
 * @param {unknown} waitMs - requested wait.
 * @returns {number} a whole number of milliseconds within bounds.
 */
function boundedWait(waitMs) {
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs <= 0) return 25_000;
  return Math.min(25_000, Math.max(1, Math.trunc(waitMs)));
}

/**
 * Convert a validated seconds threshold to milliseconds, with the documented
 * default when the value is absent.
 * @param {unknown} value - seconds.
 * @param {number} fallbackSeconds - default.
 * @returns {number} milliseconds.
 */
function secondsToMs(value, fallbackSeconds) {
  const seconds = Number.isSafeInteger(value) && value > 0 ? value : fallbackSeconds;
  return seconds * 1000;
}

/**
 * Default wait seam: a real, unref'd timeout that honours an abort signal.
 *
 * `unref()` matters: an observation waiting on a timer must not by itself keep the
 * process alive, and the timer is cleared on abort so an abandoned observation
 * leaves nothing behind.
 * @param {number} ms - slice length.
 * @param {object} [options] - `signal`.
 * @returns {Promise<void>} resolves after the slice.
 */
export function sleep(ms, options = {}) {
  const signal = options?.signal ?? null;
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal !== null && signal.aborted === true) {
      rejectPromise(abortError());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      cleanup();
      rejectPromise(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal !== null) signal.removeEventListener?.('abort', onAbort);
    };
    if (signal !== null) signal.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** @returns {Error} a DOM-shaped abort error. */
function abortError() {
  const error = new Error('the wait was aborted');
  error.name = 'AbortError';
  return error;
}

