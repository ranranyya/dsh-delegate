// Native agent execution: one job, one agent, one session, no ambience.
//
// The runner is deliberately a thin, observable wrapper around the native
// lifecycle rather than a reimplementation of it. It adds exactly six things
// the native layer does not provide on its own:
//   1. an abort latch, so cancel/timeout that lands while creation is still in
//      flight still prevents the prompt from being delivered, and any handle
//      acquired afterwards is disposed instead of driven;
//   2. the agent-preset mount, because an Agent that joins no preset has no tools
//      at all and would report a model it cannot exercise. The identity is the
//      caller's choice: omitted means "the registry's configured default" (every
//      worker run), and an explicit `presetId` names a composition the caller
//      owns and has already verified (the additional review);
//   3. bounded prompt sizes, so a huge request cannot be smuggled into a turn;
//   4. an explicit, bounded request budget for the model call (never
//      `maxTokens: 1`, which makes a working provider look broken, and never an
//      unbounded request: a native worker needs room for a reasoning effort and
//      a real answer, so the default is the model-level allowance);
//   5. a bounded, duplicate-aware text collector and redacted diagnostics, so a
//      streamed-then-final answer is reported once and a provider error cannot
//      leak a credential into job history;
//   6. a caller-generated session identity when the request omits one, because
//      `CreateAgentOptions.sessionId` is REQUIRED and the native factory mints
//      the session under exactly that id. It does not mint an agent identity:
//      `AgentRegistry.enter()` refuses any agent whose `id` differs from its
//      session's, so a default create that omits the id fails with
//      `agent id "undefined" does not match session id "session-N"`.
//
// Model selection is the seventh concern and the one with two native shapes: a
// harness that exposes the conversation's own `agent.model.select`/`.current`
// records the route durably and can read it back, while an older one has only the
// legacy `installModelSelection(agentCtx, { current })` coupling. The runner picks
// by CAPABILITY ({@link SELECTION_MODES}) and, on the modern shape, refuses the run
// unless the route it asked for is the route the conversation reports — before any
// prompt is delivered. A model surface that is PRESENT but not fully selectable and
// readable is refused rather than treated as the old shape: only an absent
// `agent.model` means "old release", and the legacy coupling on a modern harness
// carries no selection at all.

import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { diagnostic, redactText } from '../config/redact.js';
import { LIMITS } from '../config/defaults.js';
import { placeSession, SessionPlacementError as SessionPlacementRefusal } from './session-placement.js';
import { configureDelegatedSession, policyServicesOf, SandboxPolicyError, SANDBOX_CODES } from './sandbox.js';
import { PermissionError, PERMISSION_REASONS, isApprovalOutcome } from './permissions.js';

// Re-exported for the callers that already reach it through this module. The
// implementation lives in `config/redact.js` so a harness-independent consumer
// (the stdio MCP executable) can use it without importing the DSH peers above.
export { diagnostic };

/**
 * Pass-through re-export so the engine can map every placement refusal without
 * importing the placement module as well.
 */
export { SessionPlacementRefusal };

/** Execution outcome kinds. A job never reports "approved"; that is the host's call. */
export const RUN_OUTCOMES = Object.freeze({
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  timedOut: 'timed_out',
});

/** Errors specific to driving an agent. */
export const RUN_CODES = Object.freeze({
  cancelled: 'RUN_CANCELLED',
  timeout: 'RUN_TIMEOUT',
  promptTooLarge: 'RUN_PROMPT_TOO_LARGE',
  agentsUnavailable: 'RUN_AGENTS_UNAVAILABLE',
  // A native agent that joins no preset composition has no default tool set;
  // driving it would report a model the run cannot actually exercise.
  agentPresetsUnavailable: 'RUN_AGENT_PRESETS_UNAVAILABLE',
  presetMountFailed: 'RUN_PRESET_MOUNT_FAILED',
  // A caller named a preset id that this dependency set refuses to mount. The
  // runner only mounts ids its caller marked as owned (`presetOwnership.owns`),
  // so an arbitrary id can never re-point a run at a composition the caller does
  // not control.
  presetNotOwned: 'RUN_PRESET_NOT_OWNED',
  // A caller-supplied session identity the native registry would refuse before
  // any agent existed (not a string, blank, or already live in this process).
  sessionIdUnusable: 'RUN_SESSION_ID_UNUSABLE',
  createFailed: 'RUN_CREATE_FAILED',
  turnFailed: 'RUN_TURN_FAILED',
  noText: 'RUN_NO_TEXT',
  // A caller-supplied output budget that is not a bounded positive integer. It is
  // refused before an agent exists: silently substituting a value would report a
  // budget the request did not ask for, and forwarding it unbounded is exactly the
  // "practical allowance" this contract exists to guarantee.
  maxTokensUnusable: 'RUN_MAX_TOKENS_UNUSABLE',
  sandboxPolicyUnavailable: SANDBOX_CODES.unavailable,
  // A permission bridge was handed to the run but could not be armed for the Agent
  // it would have to answer for. Refused before the prompt: a run that reported a
  // bridge while installing `never` would look like the commander could decide,
  // and nothing would ever reach it.
  permissionBridgeUnavailable: 'RUN_PERMISSION_BRIDGE_UNAVAILABLE',
  // The conversation's own model API (`agent.model`)
  // is present but unusable: it threw, answered nothing, answered a route
  // this run did not select, or exposed a surface that cannot be selected through
  // and read back (a half-installed/malformed model API). The run is refused
  // BEFORE its prompt in every one of those cases, because a conversation driven
  // on an unverified route would report the operator's selection while running on
  // another one — and there is no legacy fallback after a present model surface
  // fails: on a modern helper that installer carries no selection at all.
  selectionUnavailable: 'RUN_MODEL_SELECTION_UNAVAILABLE',
});

/**
 * Stable reasons carried in `RunError.details.reason` for a model selection that
 * could not be applied and read back.
 *
 * Fixed strings chosen by this module, never an upstream message, so an operator
 * can tell WHICH capability was missing or disagreed without reading a provider
 * error into a job record.
 */
export const SELECTION_REASONS = Object.freeze({
  noAgent: 'agent model API unavailable',
  writeFailed: 'model selection was rejected',
  readbackFailed: 'model selection could not be read back',
  readbackUnusable: 'model selection read back without a route',
  routeMismatch: 'model selection read back disagrees',
  effortMismatch: 'reasoning effort read back disagrees',
  unrequestedEffort: 'model selection read back an effort this run did not select',
  // No capability at all on this harness, on a run that left its route to the
  // conversation: nothing named a provider/model, so there is nothing to apply,
  // and a run must never invent one.
  noCapability: 'no model selection capability',
  // The Agent DOES expose a model surface, but not one this run can select
  // through and read back (a half-installed or malformed API, e.g. `select()`
  // without `current()`, or a non-callable member). Such a surface is neither the
  // verifiable modern API nor evidence of an old release, so the legacy coupling
  // is not a legitimate substitute: on a modern helper it carries no selection
  // at all and would let the run claim a route it never applied.
  modelSurfaceIncomplete: 'agent model API is present but incomplete',
});

/**
 * What one conversation can do with its own model route.
 *
 * The native API moved between supported DSH releases, and the two shapes are not
 * interchangeable:
 *
 *  * `agent.model.select({ provider, model, reasoningEffort? })` with
 *    `agent.model.current()` (the modern shape) records the choice in the
 *    conversation's durable `modelSelection` projection, which every later step
 *    reads. `installModelSelection(agentCtx)` on such a release only installs the
 *    pre-step model-switch NOTICE listener: it carries no selection, so calling
 *    it with a selection changes nothing about the route a turn runs on.
 *  * `installModelSelection(agentCtx, { current, assembled })` (the legacy shape)
 *    is what applies a route on a release that has no `agent.model` at all: its
 *    `agent/request` listener rewrites the request, and its
 *    `system-prompt/assemble` listener publishes the route to the prompt.
 *
 * `mode` is therefore decided by CAPABILITY, per run, and never by a version
 * string: a harness that exposes the modern API uses ONLY it (so a selection is
 * verified instead of assumed), one with NO model surface keeps the legacy
 * coupling it needs, and a present-but-incomplete surface is `unavailable` — a
 * refusal, because neither route can prove what it applied.
 */
export const SELECTION_MODES = Object.freeze({
  modern: 'modern',
  legacy: 'legacy',
  unavailable: 'unavailable',
});

/**
 * Which model-selection capability one agent exposes.
 *
 * Capability presence, not a version, decided in this order:
 *  * a completely callable `model.select`/`model.current` pair is
 *    {@link SELECTION_MODES.modern};
 *  * NO model surface at all (`agent.model` null/undefined) is the only state
 *    that may take the legacy coupling, because that is what a release without
 *    the conversation's own model API looks like;
 *  * anything else — a model surface that is present but malformed, or that
 *    lacks either callable member — is {@link SELECTION_MODES.unavailable}. It is
 *    deliberately NOT legacy: on a modern harness the legacy installer only
 *    installs the model-switch NOTICE, so falling back would report a selection
 *    that was never applied. Failing closed is the only honest answer.
 * @param {object} agent - native (or fake) Agent.
 * @returns {string} one of {@link SELECTION_MODES}.
 */
export function selectionModeOf(agent) {
  // Anything that is not an observable object offers no model surface at all.
  if (agent === null || typeof agent !== 'object') return SELECTION_MODES.legacy;
  const model = agent.model;
  // `null`/`undefined` is the ONLY absence: an old release has no `agent.model`.
  if (model === undefined || model === null) return SELECTION_MODES.legacy;
  if (typeof model !== 'object') return SELECTION_MODES.unavailable;
  const selectable = typeof model.select === 'function';
  const readable = typeof model.current === 'function';
  return selectable && readable ? SELECTION_MODES.modern : SELECTION_MODES.unavailable;
}

/**
 * Describe a model surface by capability only.
 *
 * Reported in a refusal's details so an operator can tell WHICH half is missing
 * without this module copying an arbitrary object into a job record: no member
 * value and no object identity ever travels, only booleans.
 * @param {unknown} model - the Agent's `model` value.
 * @returns {{ kind: string, select: boolean, current: boolean }} capability facts.
 */
function describeModelSurface(model) {
  return {
    // The JavaScript type of the surface, fixed vocabulary (`object`, `string`…).
    kind: model === undefined ? 'undefined' : (model === null ? 'null' : typeof model),
    select: typeof model?.select === 'function',
    current: typeof model?.current === 'function',
  };
}

/**
 * Default output-token budget for one native model request.
 *
 * 32768 is the model-level allowance this plugin already declares for a model the
 * settings document does not size (`DEFAULT_MAX_TOKENS` in
 * `src/model/openai-adapter.js`, mirroring the pi-ai defaults), so a worker whose
 * route declares no per-request allowance is not silently starved to a fraction
 * of what its model can emit. It is a REQUEST bound, not a model capability
 * claim: the provider still refuses what it cannot serve.
 */
export const DEFAULT_MAX_TOKENS = 32768;

/**
 * Hard bounds on a caller-supplied request budget.
 *
 * Below the minimum a reasoning model is starved into an apparent timeout; above
 * the maximum a single request can reserve more than any model serves. A value
 * outside the range is a validation refusal, never a clamp: an operator who asked
 * for an impossible budget must be told, not quietly given another one.
 */
export const MAX_TOKENS_BOUNDS = Object.freeze({ min: 256, max: 262144 });

/**
 * In-band run failures, stated on the run's own `error` field.
 *
 * These are not members of `RUN_CODES`, which is the set of *refusals* this module
 * throws before or instead of driving an agent. They describe an agent that ran and
 * produced nothing usable, and the engine maps them onto job codes by matching the
 * text; keeping the vocabulary apart is what lets a caller tell "no agent was ever
 * created" from "the agent answered nothing".
 */
const RUN_ERRORS = Object.freeze({
  emptyOutput: 'the agent produced no assistant text',
  budgetExhausted: 'the agent exhausted its output token budget without producing an answer',
});

/**
 * Hard bound on the assistant text one run retains.
 *
 * The collector clamps *while* it collects rather than at the end, so a runaway
 * or hostile stream cannot make the process hold an unbounded string before the
 * final slice. `LIMITS.outputChars` is honoured when the configuration layer
 * defines it; 64k is the plugin's own bound otherwise.
 */
const OUTPUT_TEXT_CHARS = (() => {
  const configured = Number(LIMITS?.outputChars);
  return Number.isInteger(configured) && configured > 0 ? configured : 64_000;
})();

/** Raised when a run cannot proceed. */
export class RunError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded, redacted details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RunError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Build a native user message through the harness's own constructor, so the
 * identity, `role` tag, deep freeze and source validation come from
 * `@deepseek-ai/dsh-llm` rather than a locally re-derived shape the loop could
 * drift away from. `source: { kind: 'user' }` is required by the native
 * `UserMessage` type and is what every native caller passes; omitting it
 * produces a message with no declared producer.
 * @param {string} text - prompt text.
 * @returns {object} frozen user message.
 */
export function userMessage(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}

/**
 * One run's execution deadline, with a real pause and resume.
 *
 * The previous design armed a single `setTimeout(timeoutMs)` and never touched it
 * again. A worker that paused on a permission request therefore kept burning its
 * execution budget while it was doing nothing, and a wait longer than the budget
 * timed the run out for a decision the run was not making.
 *
 * This class owns the budget instead of only reporting on it:
 *
 *  * `arm()` starts the remaining budget;
 *  * `pause()` clears the timer AND charges the elapsed span against the budget, so
 *    a paused run holds a smaller remaining budget and NO armed timer at all;
 *  * `resume()` re-arms exactly the remaining budget;
 *  * repeated pauses accumulate correctly, because each one debits what it used;
 *  * `dispose()` disarms and drops any un-charged paused span, so a run that ends
 *    during a wait leaves nothing armed.
 *
 * The clock is injectable so a test can drive a wait longer than the budget without
 * spending real wall-clock time.
 */
export class ExecutionDeadline {
  /**
   * @param {number} totalMs - the run's execution budget.
   * @param {() => void} onExpire - called once, when the remaining budget is gone.
   * @param {object} [options] - `now` (ms clock); a test seam only.
   */
  constructor(totalMs, onExpire, options = {}) {
    this.totalMs = totalMs;
    this.remainingMs = totalMs;
    this.onExpire = onExpire;
    this.now = typeof options?.now === 'function' ? options.now : () => Date.now();
    this.timer = null;
    /** When the current running span started, or null while paused/disarmed. */
    this.runningSince = null;
    /** Total time spent paused, reported as evidence. */
    this.pausedMs = 0;
    this.expired = false;
    this.disposed = false;
  }

  /** Whether a timer is currently armed (i.e. the run is not paused). */
  get armed() {
    return this.timer !== null;
  }

  /**
   * Arm the remaining budget, unless the run is disposed or already expired.
   * @returns {void}
   */
  arm() {
    if (this.disposed || this.expired || this.timer !== null) return;
    this.runningSince = this.now();
    const delay = Math.max(0, Math.floor(this.remainingMs));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runningSince = null;
      this.remainingMs = 0;
      this.expired = true;
      try {
        this.onExpire();
      } catch {
        // The expiry callback latches the run; a throw here cannot be acted on.
      }
    }, delay);
    this.timer.unref?.();
  }

  /**
   * Charge the elapsed running span against the remaining budget and disarm.
   *
   * This is the half the old design was missing: pausing does not merely record a
   * timestamp, it reduces the budget and removes the timer, so nothing can expire
   * while the run waits.
   * @returns {number} the budget remaining after the charge.
   */
  pause() {
    if (this.disposed) return this.remainingMs;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.runningSince !== null) {
      const spent = Math.max(0, this.now() - this.runningSince);
      this.remainingMs = Math.max(0, this.remainingMs - spent);
      this.runningSince = null;
    }
    return this.remainingMs;
  }

  /**
   * Re-arm exactly the remaining budget after a wait ended.
   *
   * A wait that has already consumed the whole budget expires the run on resume —
   * that is the honest outcome, because the budget really is gone. The verdict is
   * reached SYNCHRONOUSLY here rather than by arming a 0 ms timer, so a caller (and
   * a test) observes the expiry as part of the resume, not one tick later.
   * @returns {void}
   */
  resume() {
    if (this.disposed || this.expired) return;
    if (this.remainingMs <= 0) {
      this.expired = true;
      try {
        this.onExpire();
      } catch {
        // The expiry callback latches the run; a throw here cannot be acted on.
      }
      return;
    }
    this.arm();
  }

  /**
   * Record a paused span for evidence (the wait itself is accounted by `pause`).
   * @param {number} ms - the span to record as waited.
   * @returns {void}
   */
  notePaused(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.pausedMs += ms;
  }

  /** Disarm and release the timer. Safe to call more than once. */
  dispose() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.runningSince = null;
    this.disposed = true;
  }
}

/**
 * Drive one native agent to completion under a timeout and a cancellation latch.
 *
 * Two ways a run can obtain its agent, and both produce the same evidence:
 *
 *  * a Workspace PLACEMENT (`request.placement`, or one resolved from the native
 *    controllers when the caller did not supply it): the DSH Session already exists
 *    in its Workspace, so the run drives the live Agent resolved for it. A continued
 *    task thread arrives this way, and so does a freshly created Session —
 *    resolving it is what attaches the native Agent to the Workspace the Session
 *    was created in.
 *  * no placement: the historical path, which creates a Session (and Agent) through
 *    `agents.create` under a caller-supplied or generated identity. Retained for a
 *    caller that owns its own conversation identity — the additional review, which
 *    composes its own preset and must not join the operator's history.
 *
 * The runner never disposes an agent it resolved. Disposal would end a conversation
 * a later follow-up must be able to continue, so {@link driveAgent} accepts an
 * inherited `disposeOwned` and this entry point sets it only for agents it created.
 *
 * Cancellation is decided before anything is created: a run whose signal is
 * already aborted takes the unplaced path and returns `cancelled` without creating
 * a Workspace, a Session or an Agent, so an operator never finds an empty group
 * left behind by a run that never started.
 * @param {object} deps - `agents` (native agent registry), `agentPresets`, optional
 *   `workspaces`/`sessionController` for workspace-grouped placement, the native
 *   `sessions` persistence service (flush only), the optional `policyServices`
 *   accessor for the two native policy services, and `logger`.
 * @param {object} request - `prompt`, `cwd`, `selection`, `timeoutMs`, `signal`,
 *   `onEvent`, the optional preset selection (`presetId`, `presetOwnership`), and the
 *   optional `placement` / `continueFromTaskId` / `allowUnplaced`, and
 *   `delegated` for a worker session that must receive the DSH sandbox policy.
 * @returns {Promise<object>} run result with text, usage facts, the `conversation`
 *   placement fact and lifecycle evidence.
 */
export async function runAgent(deps, request) {
  const agents = deps?.agents;
  if (agents === undefined || agents === null || typeof agents.create !== 'function') {
    throw new RunError(RUN_CODES.agentsUnavailable, 'the native agent registry is not available', {});
  }
  // A run whose cancellation is already known must not place anything: creating a
  // Workspace (and then a Session inside it) for a run that will never deliver a
  // prompt leaves the operator an empty group and an empty conversation. The
  // latch below re-checks at the exact step that creates anything; this check
  // exists so the placement call is never even entered.
  if (request?.signal?.aborted === true) {
    return await driveAgent(deps, {
      ...request,
      placement: request?.placement ?? null,
      // Nothing was created by this run, so there is nothing to dispose — and even
      // a later-arriving resolved Agent is not ours to end.
      disposeOwned: false,
    });
  }
  // A caller that brings its own conversation identity decides its own placement.
  // One that does not is placed through the native controllers, and an unavailable
  // controller is a refusal — never an ungrouped run.
  const placement = request?.placement !== undefined
    ? request.placement
    : await resolvePlacement(deps, request);
  const owned = request?.placement !== undefined || request?.allowUnplaced === true;
  return await driveAgent(deps, {
    ...request,
    placement,
    // Only an Agent this run created is owned by it. Both placement paths drive a
    // RESOLVED Agent (a new Session is resolved to its Agent too), and a resolved
    // Agent belongs to its Session: disposing it would end a conversation that a
    // later `continueFromTaskId` follow-up must be able to resume.
    disposeOwned: owned ? (placement === null || placement.reused !== true) : false,
  });
}

/**
 * Resolve the Workspace and Session one run drives, or `null` for the
 * unnamed-session path.
 *
 * `null` (the value `placeSession` never returns) happens only when the caller
 * explicitly asked for an unnamed conversation, which the review does: it must not
 * appear in the operator's Workspace history. Every worker run gets a placement
 * or a refusal; there is no third outcome.
 * @param {object} deps - dependency object.
 * @param {object} request - run request.
 * @returns {Promise<object | null>} placement fact, or null.
 * @throws {SessionPlacementError} when the harness cannot place the run.
 */
async function resolvePlacement(deps, request) {
  // `allowUnplaced: true` is the review's own composition, which creates its
  // agent under a caller-owned preset and identity and is not a conversation the
  // operator navigates. It is never reachable from a job submission.
  if (request?.allowUnplaced === true) return null;
  // A caller-owned identity means the caller owns placement too. This is the
  // review's session id and the historical unplaced path a lifecycle test drives;
  // it is not reachable from `JobEngine.execute`, which never supplies one.
  if (request?.sessionId !== undefined && request?.sessionId !== null) return null;
  const placement = await placeSession(deps, {
    path: request?.cwd,
    title: request?.title,
    // The only thing that can continue an existing conversation, and it is the
    // caller's explicit statement that this submission is a follow-up to THAT task.
    // Omitted means a new conversation, always.
    continueFromTaskId: request?.continueFromTaskId,
    // Task/connection facts the continuation identity must match. The engine passes
    // them because it is the only component that knows which task and connection
    // this run belongs to.
    taskId: request?.taskId,
    connectionId: request?.connectionId,
    sourcePath: request?.sourcePath,
    presetId: request?.placementPresetId,
  });
  return placement;
}

/**
 * Drive one native agent to completion under a timeout and a cancellation latch.
 *
 * @param {object} deps - `agents`, optional `sessions` (flush) and `logger`.
 * @param {object} request - `prompt`, `cwd`, `selection`, `timeoutMs`, `signal`,
 *   `onEvent`, `presetId`, `placement`, `disposeOwned`.
 * @returns {Promise<object>} run result with text, usage facts and lifecycle evidence.
 */
export async function driveAgent(deps, request) {
  const agents = deps?.agents;
  if (agents === undefined || agents === null || typeof agents.create !== 'function') {
    throw new RunError(RUN_CODES.agentsUnavailable, 'the native agent registry is not available', {});
  }
  const presets = presetRegistryOf(deps);
  if (presets === null) {
    throw new RunError(
      RUN_CODES.agentPresetsUnavailable,
      'the native agent preset registry is not available, so no default tool composition can be installed',
      {},
    );
  }
  const prompt = typeof request?.prompt === 'string' ? request.prompt : '';
  if (prompt === '') {
    throw new RunError(RUN_CODES.turnFailed, 'the delegation prompt is empty', {});
  }
  if (prompt.length > LIMITS.promptChars) {
    throw new RunError(RUN_CODES.promptTooLarge, `the delegation prompt exceeds ${LIMITS.promptChars} characters`, {
      length: prompt.length,
      limit: LIMITS.promptChars,
    });
  }
  const selection = request.selection ?? {};
  const timeoutMs = Number.isInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : null;
  const placement = request?.placement ?? null;
  const resolvedAgent = placement?.agent ?? null;
  // A resolved agent carries its own session and preset composition; the run must
  // not mount a second composition onto it. An agent created here still does.
  //
  // This holds on BOTH placement paths: a freshly created Session is also driven
  // through the Agent the session controller resolved for it, because the Session
  // already exists in the Workspace and `agents.create` would create a second one.
  // The preset is installed by whoever created that Agent (the session controller's
  // own composition, or — on the unplaced review path — this run's setup).
  const mountsPreset = resolvedAgent === null;
  const disposeOwned = request?.disposeOwned !== false;

  // Preset selection. `undefined` means "whatever the registry configures as its
  // default", which is what every worker run asks for. A named id is only
  // mounted when the caller declares ownership of it: without that check any
  // caller could re-point a run at a composition it does not own (including a
  // user preset with a shell), and the run would silently lose the tool surface
  // the caller intended to restrict.
  const presetId = request.presetId;
  if (mountsPreset && presetId !== undefined && presetId !== null) {
    const ownership = request.presetOwnership;
    const owned = typeof ownership?.owns === 'function' && ownership.owns(presetId) === true;
    if (!owned) {
      throw new RunError(
        RUN_CODES.presetNotOwned,
        'the requested agent preset is not owned by the caller, so it will not be mounted',
        {},
      );
    }
  }

  // The native create contract takes the identity from the CALLER: `sessionId`
  // is required and the factory creates the session and the agent under it.
  // Nothing in the default creation path mints one, and `AgentRegistry.enter()`
  // refuses an agent whose `id` does not equal its session's — which is exactly
  // how a call that omitted the id used to fail. So an absent identity is
  // generated here, once per run, and travels on the create call.
  //
  // A placed run does not mint anything: its identity is the Session the
  // Workspace controller created or the one a previous run recorded.
  const sessionId = resolveSessionIdentity(placement?.sessionId ?? request?.sessionId);
  // A caller-supplied identity that the native registry would reject (blank, not
  // a string, or already live in this process) is refused before an agent
  // exists, instead of surfacing later as an opaque creation failure. A resolved
  // agent is already live under exactly this identity, so the check is skipped.
  if (sessionId.generated === false && resolvedAgent === null) {
    const unusable = sessionIdUnusable(agents, sessionId.value);
    if (unusable !== null) {
      throw new RunError(RUN_CODES.sessionIdUnusable, 'the requested session identity cannot be created', {
        // Fixed text chosen by this module, never the caller's value.
        reason: unusable,
        // Never the raw identity: a caller-supplied value may carry anything.
        requestedType: typeof sessionId.value,
      });
    }
  }

  const state = {
    abortRequested: false,
    abortCause: null,
    handle: null,
    handleDisposed: false,
    // A resolved Agent is driven through the same handle shape a created one
    // arrives in, so every step below (idle wait, prompt delivery, flush,
    // cancellation) has exactly one implementation.
    //
    // `createdOwnAgent` is the lifecycle fact that decides disposal: only an Agent
    // this run created may be disposed by it. Disposing a resolved Agent would end
    // the Session it belongs to and make a later follow-up unable to continue it.
    createdOwnAgent: resolvedAgent === null,
    disposeOwned,
    // Bounded and deduplicating: the native loop streams `text-delta` events and
    // then emits the finished assistant message carrying the same text, so a
    // naive append would report every answer twice and hold an unbounded string.
    text: createTextCollector(OUTPUT_TEXT_CHARS),
    reasoningSeen: false,
    // The model request this run will actually make, known before creation so a
    // refusal happens before an agent exists.
    maxTokens: maxTokensFor(request.maxTokens),
    usage: null,
    turnEnd: null,
    error: null,
    agentId: null,
    // The model selection this run actually installed on the Agent it drove, and
    // the request budget it asked for. Reported so a placed run — which never goes
    // through `agents.create` — can still be audited for "ran on the selected
    // provider/model/effort with a usable budget".
    selection: null,
    // The identity this run will own, known before creation settles so a run
    // that never produces a handle still reports the id it asked for instead of
    // `null`.
    sessionId: sessionId.value,
    // The approval stance this run actually installed and read back, and whether
    // an armed permission bridge is why the Session asks instead of rejecting.
    // Reported as a verified fact, never as a configuration value.
    approval: null,
    // Removes the `approval/request` answerer when the run ends. Null when the run
    // had no bridge, which is the ordinary worker run.
    permissionAnswerer: null,
    // The execution deadline this run owns. It is PAUSED around every permission
    // wait, so the wait is not charged to the operator's execution budget.
    deadline: null,
  };
  if (state.maxTokens.refused !== null) {
    throw new RunError(
      RUN_CODES.maxTokensUnusable,
      'the requested output token budget is not a bounded positive integer',
      state.maxTokens.refused,
    );
  }
  const requestBudget = state.maxTokens.value;

  let resolveAbort;
  const aborted = new Promise((resolvePromise) => { resolveAbort = resolvePromise; });

  const latch = (cause) => {
    if (state.abortRequested) return;
    state.abortRequested = true;
    state.abortCause = cause;
    resolveAbort(cause);
    // A live agent is cancelled immediately; a handle that arrives later is
    // disposed by the creation path below.
    if (state.handle !== null) {
      try {
        state.handle.agent.cancel({ kind: 'user' }, { keepInbox: false });
      } catch {
        // Cancellation of an already-idle agent is not an error we can act on.
      }
    }
  };

  const onAbortSignal = () => latch('cancelled');
  if (request.signal !== undefined && request.signal !== null) {
    if (request.signal.aborted === true) latch('cancelled');
    else request.signal.addEventListener('abort', onAbortSignal, { once: true });
  }

  // Native dispatch is `('session/event', session, event)`; the second argument
  // is the event. A second positional handler shape (`agent/error`) carries a
  // payload object instead, and is registered separately below.
  const onEvent = (sessionOrEvent, maybeEvent) => {
    const event = maybeEvent === undefined ? sessionOrEvent : maybeEvent;
    if (event === null || typeof event !== 'object') return;
    if (state.abortRequested && event.type !== 'turn/end') return;
    collectEvent(event, state);
    request.onEvent?.(event);
  };

  try {
    // A cancellation that arrived before the factory was ever called must not
    // create an agent at all — creating one only to dispose it would still run
    // setup, install a composition and pay for a session that nobody asked for.
    if (state.abortRequested) {
      return finish(state, state.abortCause === 'timeout' ? RUN_OUTCOMES.timedOut : RUN_OUTCOMES.cancelled);
    }

    const handlePromise = resolvedAgent === null
      ? agents.create({
        // Always a string: the native contract requires it, and the factory mints
        // both the session and (through `enter()`) the agent id from it.
        sessionId: state.sessionId,
        meta: { cwd: request.cwd },
        agentOptions: agentOptionsFor(selection, requestBudget),
        setup: async (agentCtx, agent) => {
          // Join the default native preset *before* the model selection is
          // installed. The preset is what mounts the Agent's tool composition and
          // its scoped services; a run that skipped it would report a model the
          // agent cannot actually exercise because it has no tools at all. Failing
          // here fails the run closed, inside `agents.create`, which the caller
          // already observes as a refusal.
          try {
            await (presetId === undefined || presetId === null
              ? presets.mount(agentCtx)
              : presets.mount(agentCtx, presetId));
          } catch (error) {
            throw new RunError(RUN_CODES.presetMountFailed, 'the native agent preset could not be mounted', {
              cause: diagnostic(error?.message ?? error),
            });
          }
          // Optional caller policy, installed after the composition exists (so the
          // inventory it may inspect is the real one) and before the prompt is
          // delivered (so no turn can run without it). A hook that throws fails
          // creation closed, which is what a caller that needs a tool restriction
          // wants: a refused restriction must never degrade into an unrestricted
          // run. The agent is passed as the second argument because an agent's
          // tools live on its own scope plane, and `tools.schemas()`/`restrict()`
          // are scoped calls.
          if (typeof request.setup === 'function') {
            await request.setup(agentCtx, agent);
          }
          if (request.delegated === true) {
            applyDelegatedPolicy(agent, deps, request);
          }
          // The created path takes the same capability-based adapter as the
          // resolved one: on a modern harness the route is selected through the
          // conversation's own model API and read back BEFORE the prompt, and on a
          // legacy harness it travels through `installModelSelection`. Nothing is
          // reported as applied that was not read back.
          state.selection = applySelection(agentCtx, agent, selection);
          agentCtx.on('session/event', onEvent);
          agentCtx.on('agent/error', (payload) => {
            state.error = errorText(payload?.error);
          });
        },
      })
      // A resolved Agent already carries its session, its preset composition and
      // its listeners. What it must still receive is THIS run's model selection:
      // the operator's provider/model/effort is per task, while the conversation
      // it continues is shared, so re-applying the selection here is the whole
      // point of driving the resolved agent instead of its logged header.
      : adoptResolvedAgent(resolvedAgent, request, selection);

    // The execution deadline is not a single `setTimeout`. A worker that is waiting
    // for a permission decision is paused, not running, so the wait must not consume
    // the operator's execution budget. {@link ExecutionDeadline} holds the remaining
    // budget and re-arms only what is left, for any number of waits.
    const deadline = timeoutMs === null ? null : new ExecutionDeadline(timeoutMs, () => latch('timeout'));
    if (deadline !== null) deadline.arm();
    state.deadline = deadline;

    const raced = await Promise.race([
      handlePromise.then((handle) => ({ kind: 'handle', handle })),
      aborted.then((cause) => ({ kind: 'aborted', cause })),
    ]);

    if (raced.kind === 'aborted') {
      // The handle may still arrive after the latch. Disposing it as soon as it
      // does is the only way no agent outlives a run that is already terminal;
      // the prompt is never delivered on this path.
      handlePromise.then(
        (handle) => { void releaseHandle(state, handle); },
        () => {},
      );
      return finish(state, raced.cause === 'timeout' ? RUN_OUTCOMES.timedOut : RUN_OUTCOMES.cancelled);
    }

    const handle = raced.handle;
    state.handle = handle;
    // Both ids are read from the ONE live agent the factory returned, so the
    // reported identity is what was actually created rather than what was asked
    // for. A factory that honoured the identity request reports the same ids the
    // run requested; `sessionId` falls back to the requested identity only for a
    // handle that exposes no session object at all.
    state.agentId = handle?.agent?.id ?? null;
    state.sessionId = handle?.agent?.session?.id ?? state.sessionId;

    if (state.abortRequested) {
      await releaseHandle(state, handle);
      return finish(state, state.abortCause === 'timeout' ? RUN_OUTCOMES.timedOut : RUN_OUTCOMES.cancelled);
    }

    // Wait for the agent's own initial quiescence before prompting, so the
    // prompt is not queued behind setup work that is still composing.
    await Promise.race([handle.agent.whenIdle(), aborted]);
    if (state.abortRequested) {
      await releaseHandle(state, handle);
      return finish(state, state.abortCause === 'timeout' ? RUN_OUTCOMES.timedOut : RUN_OUTCOMES.cancelled);
    }

    handle.agent.followup(userMessage(prompt));
    await Promise.race([handle.agent.whenIdle(), aborted]);

    const outcome = state.abortRequested
      ? (state.abortCause === 'timeout' ? RUN_OUTCOMES.timedOut : RUN_OUTCOMES.cancelled)
      : deriveOutcome(state);

    // Flush the session so the transcript is durable before the caller reads it.
    if (deps?.sessions !== undefined && typeof deps.sessions.flush === 'function' && handle?.agent?.session !== undefined) {
      try {
        await deps.sessions.flush(handle.agent.session);
      } catch (error) {
        deps?.logger?.warn?.('dsh-delegate: session flush failed', diagnostic(error?.message ?? error, 200));
      }
    }

    await releaseHandle(state, handle);
    return finish(state, outcome);
  } catch (error) {
    if (state.handle !== null) await releaseHandle(state, state.handle);
    if (error instanceof RunError) throw error;
    throw new RunError(RUN_CODES.createFailed, 'the delegated agent could not be created or driven', {
      cause: diagnostic(error?.message ?? error),
    });
  } finally {
    // The deadline is disarmed on every exit path, which also clears a paused span
    // so a run that ends during a wait leaves no armed timer behind.
    if (state.deadline !== null) state.deadline.dispose();
    if (request.signal !== undefined && request.signal !== null) {
      request.signal.removeEventListener?.('abort', onAbortSignal);
    }
    // The answerer is removed on every exit path. A run that is over must not keep
    // a listener that could answer a request for an Agent it no longer drives, and
    // a disposed bridge refuses everything anyway — this removes the listener that
    // would otherwise stay registered on the conversation's context.
    if (state.permissionAnswerer !== null) {
      const remove = state.permissionAnswerer;
      state.permissionAnswerer = null;
      try {
        remove();
      } catch {
        // The owning fiber disposes the listener on unload; this is best effort.
      }
    }
  }

  /**
   * Attach one resolved Agent to this run: listeners, this run's model selection,
   * and the handle shape the drive path expects.
   *
   * The selection is installed on the agent's own context — the same coupling
   * `agents.create`'s setup callback uses — so a continued conversation still runs
   * on the provider/model/effort the operator selected for THIS task instead of
   * whatever the previous turn happened to use. A failure here is a create
   * failure like any other, and it happens before the prompt is delivered.
   * @param {object} agent - live native Agent returned by the session controller.
   * @param {object} runRequest - the run request (for the optional setup hook).
   * @param {object} runSelection - provider route, model and effort for this run.
   * @returns {Promise<object>} handle for the drive path.
   */
  async function adoptResolvedAgent(agent, runRequest, runSelection) {
    const agentCtx = agent?.ctx ?? null;
    if (agentCtx === null || typeof agentCtx?.on !== 'function') {
      throw new RunError(
        RUN_CODES.createFailed,
        'the resolved session exposes no agent context, so its events cannot be observed',
        { cause: 'SESSION_AGENT_CONTEXT_UNAVAILABLE' },
      );
    }
    if (typeof runRequest.setup === 'function') {
      await runRequest.setup(agentCtx, agent);
    }
    if (runRequest.delegated === true) {
      applyDelegatedPolicy(agent, deps, runRequest);
    }
    // Recorded as a fact of the run, not inferred from the request: an operator
    // asking "which model did this continued conversation actually run on" gets
    // the triple that was applied AND read back from the conversation itself. On a
    // modern harness a mismatch or a throwing readback refuses the run here —
    // before the prompt — instead of driving the previous turn's route under this
    // task's name. `maxTokens` is not part of the selection: the native selection
    // carries only the provider route, model and effort.
    state.selection = applySelection(agentCtx, agent, runSelection);
    agentCtx.on('session/event', onEvent);
    agentCtx.on('agent/error', (payload) => {
      state.error = errorText(payload?.error);
    });
    return {
      agent,
      // Stated, not inferred: this handle owns nothing a dispose could legally end.
      owned: false,
      async dispose() {},
    };
  }

  /**
   * Apply the worker-only DSH policy before any prompt is delivered.
   *
   * The policy is not "set" by writing two events: it is set when the services
   * that own them resolve the values back. `deps.policyServices` is the live
   * accessor (`ctx.sandboxPolicy` / `ctx.approval`, read per call); a run that
   * carries no accessor is refused rather than trusted, because an unverifiable
   * policy is indistinguishable from no policy at all.
   *
   * Both arguments are explicit: the agent is the policy SUBJECT (its Session is
   * what the events are appended to), the deps object is where the accessor and
   * the installer live, and the request is what {@link driveAgent} was called
   * with. Conflating them is how a caller-supplied seam silently stops applying.
   * @param {object} agent - native Agent whose Session receives the policy.
   * @param {object} deps - dependency object carrying `policyServices`.
   * @param {object} runRequest - the run request carrying the optional seams.
   * @returns {void}
   * @throws {RunError} when policy cannot be installed AND verified.
   */
  function applyDelegatedPolicy(agent, deps, runRequest) {
    try {
      const bridge = bindPermissionBridge(agent, runRequest);
      const services = typeof deps?.policyServices === 'function'
        ? deps.policyServices()
        : policyServicesOf(null);
      const configure = typeof runRequest?.configureDelegatedSession === 'function'
        ? runRequest.configureDelegatedSession
        : configureDelegatedSession;
      // The bridge is armed FIRST and the policy is decided from its own
      // capability: an ARMED bridge bound to THIS Agent means `ask`, anything else
      // means `never`. The answerer is registered after the stance, so a request
      // can never arrive under `ask` with nothing listening.
      const bridged = configure(agent, services, { bridge });
      if (bridged?.bridged === true) {
        installPermissionAnswerer(agent?.ctx ?? null, bridge);
      }
      state.approval = {
        policy: bridged?.approvalPolicy ?? null,
        bridged: bridged?.bridged === true,
      };
    } catch (error) {
      // A bridge refusal keeps its own code: it is a different operator problem from
      // a policy that could not be installed, and reporting it as one would send an
      // operator to inspect the sandbox services instead of the bridge.
      if (error instanceof RunError) throw error;
      if (error instanceof SandboxPolicyError) {
        throw new RunError(error.code, error.message, error.details);
      }
      if (error instanceof PermissionError) {
        throw new RunError(
          RUN_CODES.permissionBridgeUnavailable,
          'the permission bridge could not be bound to the delegated session, so the worker was not started',
          { reason: PERMISSION_REASONS.unbound },
        );
      }
      throw new RunError(
        RUN_CODES.sandboxPolicyUnavailable,
        'the delegated DSH session policy could not be installed, so the worker was not started',
        { reason: 'policy setup failed' },
      );
    }
  }

  /**
   * Arm the run's permission bridge for the Agent this run will drive.
   *
   * Arming happens HERE — after the preset composition exists (so the worker's
   * tool surface is the real one) and BEFORE the policy is installed and any prompt
   * is delivered (so no turn can ask under an unarmed bridge). A bridge that
   * cannot be armed for this Agent is a refusal, not a silent downgrade: without
   * it the run would be reported as riding a bridge while `never` was installed.
   *
   * A run with NO bridge is the ordinary worker run: the caller simply did not ask
   * for one, the policy stays `never`, and nothing here invents an answerer.
   * @param {object} agent - the live native Agent the run will drive.
   * @param {object} runRequest - the run request carrying the optional bridge.
   * @returns {object | null} the armed bridge, or null when the run has none.
   * @throws {RunError} when a supplied bridge cannot be armed for this Agent.
   */
  function bindPermissionBridge(agent, runRequest) {
    const bridge = runRequest?.permissionBridge ?? null;
    if (bridge === null || bridge === undefined) return null;
    if (typeof bridge.arm !== 'function') {
      // A non-bridge value is a caller bug. It is refused instead of being treated
      // as "no bridge", because the caller believes approvals are bridged.
      throw new RunError(
        RUN_CODES.permissionBridgeUnavailable,
        'the requested permission bridge cannot be armed for this run, so the worker was not started',
        { reason: 'the bridge exposes no arm()' },
      );
    }
    try {
      bridge.arm(agent);
    } catch (error) {
      throw new RunError(
        RUN_CODES.permissionBridgeUnavailable,
        'the permission bridge could not be bound to the delegated session, so the worker was not started',
        {
          reason: typeof error?.details?.reason === 'string' ? error.details.reason : 'the bridge refused this agent',
        },
      );
    }
    return bridge;
  }

  /**
   * Register this run's permission bridge as the answerer for its own Agent.
   *
   * The seam is the native, agent-scoped waterfall `'approval/request'` (recorded
   * evidence: `ApprovalService.decide()` dispatches
   * `this.ctx.waterfall(scopeTarget(req.agent, req.agent), 'approval/request', req, …)`,
   * and `approveEscalation` is the one caller that raises it for a widened sandbox
   * request). A listener registered on the AGENT's own context therefore sees only
   * that Agent's requests — an ordinary session, another task's worker and the
   * optional read-only reviewer are all outside this scope and are never answered
   * by this bridge.
   *
   * The listener answers with the bridge's closed outcome. It never throws: the
   * seam already contains a thrown answerer into `'unavailable'`, and a bridge that
   * throws for a request it does not own would interfere with a scope it should
   * not be judging, so it falls through to `next()` for those.
   * @param {object} agentCtx - the agent's scoped context (listener target).
   * @param {object} bridge - the armed bridge.
   * @returns {() => void} disposer removing the listener.
   * @throws {RunError} when the context cannot register an approval answerer.
   */
  function installPermissionAnswerer(agentCtx, bridge) {
    if (agentCtx === null || agentCtx === undefined || typeof agentCtx.on !== 'function') {
      throw new RunError(
        RUN_CODES.permissionBridgeUnavailable,
        'the delegated agent exposes no context an approval answerer could be registered on, so the worker was not started',
        { reason: 'agent context unavailable' },
      );
    }
    let disposer;
    try {
      // `prepend: true` is REQUIRED, and this is why: the native seam dispatches
      // `approval/request` as a cordis WATERFALL, where listener order is dispatch
      // order and the FIRST listener to return a value claims the question. An
      // ordinary `on()` appends, so a UI/operator answerer registered before this
      // run would answer first and this bridge would never see the request — which
      // is exactly the "the commander must intercept before the UI prompt" property
      // this feature exists for. Prepending puts this run's bridge ahead of any
      // pre-existing answerer for ITS OWN agent's scope (the listener still falls
      // through for every other agent, so an ordinary session keeps the prompt it
      // actually has).
      disposer = agentCtx.on('approval/request', async (request, next) => {
        if (bridge.owns(request) !== true) {
          // Not this Agent's request: leave the chain untouched. Reporting a foreign
          // request as `unavailable` would deny an ordinary session the answerer it
          // actually has.
          return await next();
        }
        // PAUSE the run's execution deadline for the duration of the wait. This is a
        // real timer pause (the budget is charged and the timer disarmed), not a
        // reported counter: a wait longer than the remaining budget therefore does
        // NOT time the run out, while the budget still expires afterwards if the run
        // really does keep executing.
        const deadline = state.deadline;
        const pausedAt = Date.now();
        deadline?.pause();
        let outcome;
        try {
          outcome = await bridge.answer(request);
        } finally {
          // Resume on EVERY exit — answered, cancelled, disposed, thrown — so no path
          // can leave the run paused and therefore unable to time out at all.
          if (deadline !== null) {
            deadline.notePaused(Date.now() - pausedAt);
            deadline.resume();
          }
        }
        return isApprovalOutcome(outcome) ? outcome : 'unavailable';
      }, { prepend: true });
    } catch (error) {
      throw new RunError(
        RUN_CODES.permissionBridgeUnavailable,
        'the approval answerer could not be registered for the delegated session, so the worker was not started',
        { reason: typeof error?.code === 'string' ? error.code : 'agent context refused the answerer' },
      );
    }
    state.permissionAnswerer = typeof disposer === 'function' ? disposer : null;
    return () => {
      const remove = state.permissionAnswerer;
      state.permissionAnswerer = null;
      try {
        remove?.();
      } catch {
        // The owning fiber disposes the listener on unload; this is best effort.
      }
    };
  }

  /**
   * Release one handle at the end of a run.
   *
   * Disposal is skipped for an Agent this run did not create, and for any handle
   * the caller marked as not owned. A Session that is disposed cannot be
   * continued, so disposing a resolved Agent would silently break a later
   * `continueFromTaskId` follow-up — exactly the failure this feature must not
   * have.
   * @param {object} target - run state.
   * @param {object} handle - handle to release.
   * @returns {Promise<void>} resolves after the attempt.
   */
  async function releaseHandle(target, handle) {
    if (handle === null || handle === undefined) return;
    if (target.handle === handle) {
      if (target.handleDisposed) return;
      target.handleDisposed = true;
    }
    if (target.createdOwnAgent !== true || target.disposeOwned !== true) return;
    await disposeQuietly(handle);
  }

  // Native session events carry their payload under `data`, e.g.
  // `{ type: 'assistant/message', data: { message, usage } }` and
  // `{ type: 'turn/end', data: { reason: { kind } } }`. Streaming chunk types
  // (`text-delta`, `reasoning-delta`) appear both inside a message part event and
  // as top-level events, so both spellings are accepted.
  //
  // The loop streams deltas and *then* emits the finished message with the same
  // text, so the collector has to reconcile the two: deltas are appended, and the
  // final message replaces them only when it carries the answer the deltas were
  // streaming. Appending both would report every answer twice.
  function collectEvent(event, target) {
    if (event === null || typeof event !== 'object') return;
    const type = event.type;
    if (type === 'turn/end') {
      const reason = event.data?.reason ?? event.reason ?? null;
      target.turnEnd = { reason: typeof reason === 'string' ? reason : (reason?.kind ?? 'unknown') };
      return;
    }
    if (type === 'assistant/message' || type === 'message') {
      const message = event.data?.message ?? event.message ?? null;
      const usage = event.data?.usage ?? event.usage ?? null;
      const content = Array.isArray(message?.content) ? message.content : [];
      let finalText = '';
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') finalText += block.text;
        if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text !== '') {
          target.reasoningSeen = true;
        }
      }
      if (finalText !== '') target.text.mergeFinal(finalText);
      if (usage !== null && typeof usage === 'object') target.usage = normalizeUsage(usage);
      return;
    }
    if (type === 'usage') {
      const usage = event.data?.usage ?? event.usage ?? event.data ?? null;
      if (usage !== null && typeof usage === 'object') target.usage = normalizeUsage(usage);
      return;
    }
    if (type === 'text-delta') {
      const text = event.data?.text ?? event.text;
      if (typeof text === 'string' && text !== '') target.text.appendDelta(text);
      return;
    }
    if (type === 'reasoning-delta') {
      const text = event.data?.text ?? event.text;
      // A reasoning delta is activity even when it carries no display text yet.
      if (typeof text !== 'string' || text !== '') target.reasoningSeen = true;
      return;
    }
    if (type === 'message/part' || type === 'assistant/delta') {
      const delta = event.data?.delta ?? event.delta ?? event.data ?? null;
      if (delta?.type === 'text-delta' && typeof delta.text === 'string' && delta.text !== '') {
        target.text.appendDelta(delta.text);
      }
      if (delta?.type === 'reasoning-delta') target.reasoningSeen = true;
    }
  }

  function finish(target, outcome) {
    const text = target.text.value();
    // The native registry publishes an agent only under its session's id
    // (`AgentRegistry.enter()` refuses a mismatch), so an agent that exists has
    // exactly one identity. Reporting the session id as the agent id when no
    // handle was ever published keeps the pair honest for terminal runs
    // (cancel/timeout during creation) instead of emitting `agentId: null`
    // beside a real session id that names nothing.
    const agentId = target.agentId ?? target.sessionId ?? null;
    return {
      outcome,
      text: redactText(text).trim(),
      // "Reasoning only" is about what the *agent* produced, decided before
      // redaction: a redacted-out answer is still an answer.
      reasoningOnly: target.reasoningSeen && text.trim() === '',
      textTruncated: target.text.truncated(),
      usage: target.usage,
      turnEnd: target.turnEnd,
      agentId,
      sessionId: target.sessionId,
      // The provider/model/effort applied on the Agent this run drove, and the
      // output budget it requested. Present on both the created and the resolved
      // path. On a harness with the conversation's own model API this is the route
      // READ BACK from the conversation, so `applied: true` is a verified fact; on
      // the legacy shape it is the route the request-rewriting coupling was given.
      // `applied: false` means no route was requested at all (the review, which
      // inherits its composition's configured model) — never a failed selection,
      // which refuses the run instead.
      selection: target.selection,
      maxTokens: target.maxTokens?.value ?? null,
      // Where this run's conversation landed, or `null` for the unplaced path
      // (the review). Stated as its own fact so a caller can report the Workspace
      // group, whether the run started a new conversation or continued the task
      // thread it named, without re-deriving any of it from the ids.
      conversation: placement === null ? null : {
        kind: placement.kind ?? null,
        continuedFromTaskId: placement.continuedFromTaskId ?? null,
        reused: placement.reused === true,
        workspaceId: placement.workspaceId ?? null,
        workspacePath: placement.workspacePath ?? null,
        workspaceTitle: placement.workspaceTitle ?? null,
        sessionId: target.sessionId ?? placement.sessionId ?? null,
      },
      cancelCause: target.abortCause,
      error: target.error,
      aborted: target.abortRequested,
      // The approval stance this run installed and read back, plus whether an
      // armed bridge is the answerer behind it. `null` for a run that never had a
      // delegated policy installed (the review, an ordinary session).
      approval: target.approval ?? null,
    };
  }

  /**
   * Classify the turn the agent loop actually finished.
   *
   * The loop ends a turn with `max-tokens` — a response that ran out of its output
   * budget — *after* the same `assistant/message` append a `completed` turn
   * performs, so that reason is an ending, not a failure. Reading everything
   * except `completed` as a failure therefore reported a working run whose model
   * spent its budget thinking as "the delegated run produced no output" — the
   * reasoning-only false negative this plugin exists to avoid.
   *
   * Order, and why:
   *  1. an aborted or timed-out turn is cancelled, whatever it had collected;
   *  2. a recorded agent error is an execution failure, whatever the turn produced;
   *  3. a turn with text, or with reasoning, ended productively. Text stays text —
   *     a long answer is never trimmed into a reasoning-only one — and a
   *     reasoning-only turn reports its (empty) text as observed instead of being
   *     turned into an error or into a synthetic summary;
   *  4. nothing at all is a failure with its own message, split by reason: a
   *     `max-tokens` ending means the model filled its budget before answering
   *     (raise the budget), anything else means the turn was genuinely empty.
   * @param {object} target - run state.
   * @returns {string} one of {@link RUN_OUTCOMES}.
   */
  function deriveOutcome(target) {
    const reason = target.turnEnd?.reason;
    if (reason === 'aborted') return RUN_OUTCOMES.cancelled;
    if (target.error !== null) return RUN_OUTCOMES.failed;
    if (target.text.length() > 0 || target.reasoningSeen) return RUN_OUTCOMES.completed;
    // No content and no error. The reason decides which kind of nothing this was;
    // both are failures with distinguishable text, and neither is a reasoning-only
    // run (those returned as completed above).
    target.error = reason === 'max-tokens' ? RUN_ERRORS.budgetExhausted : RUN_ERRORS.emptyOutput;
    return RUN_OUTCOMES.failed;
  }
}

/**
 * Build the native agent options for one run's model request.
 *
 * `maxTokens` is always explicit: large enough that a reasoning model is not
 * starved into an apparent timeout, bounded so one request cannot ask for more
 * than a model serves. The caller's budget was validated before this point and is
 * forwarded unchanged.
 * @param {object} selection - provider route, model, optional effort.
 * @param {number} budget - validated output-token budget.
 * @returns {object} agent options for `agents.create`.
 */
function agentOptionsFor(selection, budget) {
  return {
    provider: selection.providerRoute,
    model: selection.model,
    ...(selection.reasoningEffort === null || selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
    maxTokens: budget,
  };
}

/**
 * Make one run's provider/model/effort the route the conversation will actually
 * run on, and prove it was applied before the prompt can be delivered.
 *
 * This is the capability-based adapter between the two supported native shapes
 * (see {@link SELECTION_MODES}), and it is used by BOTH paths — a freshly created
 * Agent and a resolved/continued one — so a follow-up cannot be reported on a
 * route that only the previous turn used.
 *
 * Rules, and why each one exists:
 *  * when the Agent exposes `model.select`/`model.current`, ONLY that API is used:
 *    the route is recorded through `select()`, read back through `current()`, and
 *    compared — provider, model, and the optional effort — before the caller may
 *    prompt. A throw, an empty answer, or any disagreement is a
 *    {@link RunError} refusal. There is deliberately no legacy fallback after a
 *    present modern API fails: on such a release the legacy installer carries no
 *    selection at all (it installs the model-switch notice), so falling back would
 *    "succeed" without selecting anything, which is the defect this adapter
 *    removes;
 *  * when the Agent exposes no model surface at all (`agent.model` null/undefined
 *    — an old release), the legacy `installModelSelection` coupling is used
 *    exactly as before — it is the only way a route reaches a turn there (its
 *    `agent/request` listener rewrites the request);
 *  * when the Agent's model surface is PRESENT but incomplete/malformed, the run
 *    is refused with {@link SELECTION_REASONS.modelSurfaceIncomplete}. Such a
 *    surface is not an old release, so the legacy coupling is not a substitute:
 *    on a modern harness it installs only the notice listener and would let the
 *    run claim a route nothing applied;
 *  * when no surface exists and the legacy installer is unavailable too, the run
 *    is refused UNLESS it named no route at all (the review composition, which
 *    inherits the conversation's configured route). A run that named a route and
 *    cannot apply it is never driven.
 *
 * Nothing is reported as `applied` that was not applied: the modern path reports
 * the READ-BACK route, and the legacy path is only reachable where no readback API
 * exists.
 * @param {object} agentCtx - the agent's scoped context (legacy listener target).
 * @param {object} agent - the live Agent the run will drive.
 * @param {object} selection - provider route, model, optional effort.
 * @returns {{ provider: string|null, model: string|null, reasoningEffort: string|null, applied: boolean }} reported fact.
 * @throws {RunError} when the selection cannot be applied and verified.
 */
function applySelection(agentCtx, agent, selection) {
  const wanted = {
    provider: selection?.providerRoute ?? null,
    model: selection?.model ?? null,
    // An unsupported/omitted effort must stay ABSENT rather than travel as `null`:
    // the native selection types it as optional, and "absent" is a value of its
    // own when the readback is compared.
    reasoningEffort: selection?.reasoningEffort ?? undefined,
  };
  const mode = selectionModeOf(agent);
  if (mode === SELECTION_MODES.modern) {
    return selectThroughAgentModel(agent, wanted);
  }
  if (mode === SELECTION_MODES.unavailable) {
    // Present but not selectable-and-readable. Refused before the prompt on both
    // the created and the resolved path, and no legacy listener is installed.
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'the conversation exposes a model API this run cannot select and verify through, so the worker was not started',
      {
        reason: SELECTION_REASONS.modelSurfaceIncomplete,
        // Only the capability facts: never the surface object itself.
        surface: describeModelSurface(agent?.model),
      },
    );
  }
  if (wanted.provider !== null && wanted.model !== null && typeof installModelSelection === 'function') {
    // The legacy coupling: the mutable `current` ref is what its `agent/request`
    // listener reads to rewrite the request, and its `system-prompt/assemble`
    // listener to publish the route to the prompt. No notice listener is installed
    // separately on this path, because this installer already owns one.
    installModelSelection(agentCtx, {
      current: {
        provider: wanted.provider,
        model: wanted.model,
        reasoningEffort: wanted.reasoningEffort,
      },
      assembled: undefined,
    });
    return {
      provider: wanted.provider,
      model: wanted.model,
      reasoningEffort: wanted.reasoningEffort ?? null,
      applied: true,
    };
  }
  if (wanted.provider !== null || wanted.model !== null) {
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'this harness exposes no way to select a model route, so the worker was not started on an unverified route',
      { reason: SELECTION_REASONS.noCapability },
    );
  }
  // No route was requested and the Agent exposes no model surface to verify: the
  // conversation runs on whatever its composition configured. Reported as an
  // omission, not as an applied route.
  return { provider: null, model: null, reasoningEffort: null, applied: false };
}

/**
 * Select one run's route through the conversation's own model API and verify it.
 *
 * `select()` records the choice in the Session's durable `modelSelection`
 * projection (the next step's `pre-step` reads it, which is what makes the route
 * this run's rather than the previous turn's), and `current()` reads it back. The
 * readback is what the run reports: a `select()` that silently did nothing, or a
 * conversation whose recorded choice is another route, is refused here instead of
 * being reported as applied.
 * @param {object} agent - native Agent with `model.select`/`model.current`.
 * @param {{ provider: string|null, model: string|null, reasoningEffort: string|undefined }} wanted - the route.
 * @returns {{ provider: string|null, model: string|null, reasoningEffort: string|null, applied: boolean }} readback fact.
 * @throws {RunError} when the route is incomplete, rejected, unreadable or different.
 */
function selectThroughAgentModel(agent, wanted) {
  // The modern API records a complete route, so an incomplete request has no
  // meaning it could apply: half a selection is a refusal, not a default.
  if (wanted.provider === null || wanted.model === null) {
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'the run names no provider/model route, so a model selection cannot be recorded for it',
      { reason: SELECTION_REASONS.noCapability },
    );
  }
  try {
    agent.model.select({
      provider: wanted.provider,
      model: wanted.model,
      ...(wanted.reasoningEffort === undefined ? {} : { reasoningEffort: wanted.reasoningEffort }),
    });
  } catch (error) {
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'the conversation rejected its model selection, so the worker was not started',
      {
        reason: SELECTION_REASONS.writeFailed,
        // The native code, never the upstream message: a message may carry a
        // provider response that this plugin must not copy into a job record.
        cause: typeof error?.code === 'string' ? diagnostic(error.code, 120) : null,
      },
    );
  }

  let observed;
  try {
    observed = agent.model.current();
  } catch (error) {
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'the conversation could not report the model selection it recorded, so the worker was not started',
      {
        reason: SELECTION_REASONS.readbackFailed,
        cause: typeof error?.code === 'string' ? diagnostic(error.code, 120) : null,
      },
    );
  }
  if (observed === null || observed === undefined || typeof observed !== 'object'
    || typeof observed.provider !== 'string' || typeof observed.model !== 'string') {
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'the conversation reports no model selection after one was recorded, so the worker was not started',
      { reason: SELECTION_REASONS.readbackUnusable },
    );
  }
  // The readback is the fact: when it disagrees with what was asked for, the
  // prompt is never delivered. The observed route is operator-selected metadata
  // (never a credential), so it is comparable and reportable.
  if (observed.provider !== wanted.provider || observed.model !== wanted.model) {
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'the conversation would run on a different model route than the one selected, so the worker was not started',
      {
        reason: SELECTION_REASONS.routeMismatch,
        expected: { provider: wanted.provider, model: wanted.model, reasoningEffort: wanted.reasoningEffort ?? null },
        observed: {
          provider: observed.provider,
          model: observed.model,
          reasoningEffort: typeof observed.reasoningEffort === 'string' ? observed.reasoningEffort : null,
        },
      },
    );
  }
  const observedEffort = typeof observed.reasoningEffort === 'string' && observed.reasoningEffort !== ''
    ? observed.reasoningEffort
    : undefined;
  if (wanted.reasoningEffort !== undefined && observedEffort !== wanted.reasoningEffort) {
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'the conversation would run at a different reasoning effort than the one selected, so the worker was not started',
      {
        reason: SELECTION_REASONS.effortMismatch,
        expected: { reasoningEffort: wanted.reasoningEffort },
        observed: { reasoningEffort: observedEffort ?? null },
      },
    );
  }
  // Nothing asked for an effort, yet the conversation carries one: this run cannot
  // prove the operator's "no effort" choice is what the turn will use, so the
  // route is not reported as applied.
  if (wanted.reasoningEffort === undefined && observedEffort !== undefined) {
    throw new RunError(
      RUN_CODES.selectionUnavailable,
      'the conversation carries a reasoning effort this run did not select, so the worker was not started',
      {
        reason: SELECTION_REASONS.unrequestedEffort,
        observed: { reasoningEffort: observedEffort },
      },
    );
  }
  return {
    provider: observed.provider,
    model: observed.model,
    reasoningEffort: observedEffort ?? null,
    applied: true,
  };
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Resolve the output-token budget one model request is made with.
 *
 * The rule, and why each clause exists:
 *  - an ABSENT budget (`undefined`/`null`) is not "no budget": it resolves to
 *    {@link DEFAULT_MAX_TOKENS}, because a native request with no explicit
 *    allowance is what made an installed worker stop mid-answer;
 *  - a supplied budget is PRESERVED verbatim, so an explicit caller decision is
 *    never silently replaced by the default;
 *  - a supplied budget that is not an integer inside
 *    {@link MAX_TOKENS_BOUNDS} is REFUSED (`refused` non-null) rather than
 *    clamped or dropped, so a request can never travel as unbounded.
 *
 * Note the bounds are checked by value, not reparsed: `0`, `NaN`, `1.5`, `'8192'`
 * and an out-of-range integer are all refusals.
 * @param {unknown} requested - the caller's `maxTokens`.
 * @returns {{ value: number, refused: { reason: string, min: number, max: number } | null }} resolution.
 */
function maxTokensFor(requested) {
  const bounds = { min: MAX_TOKENS_BOUNDS.min, max: MAX_TOKENS_BOUNDS.max };
  if (requested === undefined || requested === null) return { value: DEFAULT_MAX_TOKENS, refused: null };
  if (typeof requested !== 'number' || !Number.isInteger(requested)) {
    // The type is reported, never the raw value: a bad budget may carry anything.
    return { value: DEFAULT_MAX_TOKENS, refused: { ...bounds, reason: 'maxTokens must be an integer', requestedType: typeof requested } };
  }
  if (requested < bounds.min || requested > bounds.max) {
    return { value: DEFAULT_MAX_TOKENS, refused: { ...bounds, reason: 'maxTokens is outside the supported range' } };
  }
  return { value: requested, refused: null };
}

/**
 * Narrow a dependency object to the preset registry, or `null` when it cannot
 * install a composition.
 *
 * `agentPresets.mount(ctx, id?)` is the native entry point that joins an Agent
 * to a preset revision and mounts its plugin subtree (tools, scoped services).
 * Its absence is not a degraded mode to paper over: an Agent with no preset has
 * no tools, so the run is refused before any agent is created.
 * @param {object} deps - dependency object.
 * @returns {{ mount: (agentCtx: object, id?: string) => Promise<unknown> } | null} registry facade or null.
 */
function presetRegistryOf(deps) {
  const presets = deps?.agentPresets;
  if (presets === undefined || presets === null || typeof presets.mount !== 'function') return null;
  return {
    // The id is forwarded verbatim: `undefined` makes the registry apply its
    // configured default rather than this plugin inventing one, and a named id is
    // one the run already proved its caller owns.
    mount: (agentCtx, id) => (id === undefined ? presets.mount(agentCtx) : presets.mount(agentCtx, id)),
  };
}

/**
 * Resolve the agent/session identity a run will own.
 *
 * `CreateAgentOptions.sessionId` is required and the native factory creates the
 * session — and, through `AgentRegistry.enter()`, the agent — under exactly that
 * id. The default creation path mints nothing, so a caller that omits the id
 * used to pass `undefined` and the registry refused the freshly built agent with
 * `agent id "undefined" does not match session id "session-N"`.
 *
 * Rule: an identity the caller supplied is preserved verbatim (it is the
 * caller's ownership decision: a fork, an ACP id, a resumed session); only an
 * ABSENT one (`undefined`/`null`) is generated, once per run. The shape mirrors
 * the sibling one-shot runner in `dsh-headless`, which does
 * `config.sessionId ?? \`session-${randomUUID()}\`` before `agents.create`, so
 * ids stay recognisable and unrelated to this plugin's own naming.
 * @param {unknown} requested - the caller's `sessionId`, possibly absent.
 * @returns {{ value: string, generated: boolean }} the identity to create under.
 */
export function resolveSessionIdentity(requested) {
  if (typeof requested === 'string') return { value: requested, generated: false };
  // `undefined`/`null` mean "the caller has no identity to impose". Any other
  // type is a caller bug, not an omission: it is passed through so the
  // pre-create admission check below refuses it with a stated reason instead of
  // this helper silently inventing a different identity.
  if (requested === undefined || requested === null) {
    return { value: `session-${randomUUID()}`, generated: true };
  }
  return { value: requested, generated: false };
}

/**
 * Why the native registry would refuse a caller-supplied identity, or `null`.
 *
 * These are the checks `AgentRegistry`/`SessionStore.prepare` apply to an id, so
 * a run that would fail them is refused here — before an agent or a session
 * exists — instead of failing later as an opaque `RUN_CREATE_FAILED` whose cause
 * an operator cannot separate from a provider problem.
 * @param {object} agents - native agent registry (only `get` is used).
 * @param {string|unknown} id - identity the caller asked for.
 * @returns {string|null} reason text, or `null` when the id is admissible.
 */
function sessionIdUnusable(agents, id) {
  if (typeof id !== 'string') return 'sessionId must be a string';
  // `SessionStore.prepare` brands whatever string it is handed as a session id,
  // so an empty one would become a real (and unusable) session identity.
  if (id.trim() === '') return 'sessionId must not be blank';
  // `SessionStore.prepare` throws when the id already has a session; a live
  // agent is the process-local form of that collision.
  if (typeof agents.get === 'function') {
    try {
      if (agents.get(id) !== undefined) return 'a live agent already owns this session id in this process';
    } catch {
      // An unreadable registry cannot answer the question; creation itself is
      // the next authority and will refuse an id it cannot admit.
    }
  }
  return null;
}

/**
 * Normalize an agent error payload into redacted diagnostic text.
 *
 * Native `agent/error` payloads carry either an `Error` or a bare message, and
 * the provider code (e.g. `401`, `context_length_exceeded`) is the part an
 * operator needs to act on, so it is preserved alongside the message instead of
 * being flattened away.
 * @param {unknown} value - error payload.
 * @returns {string} redacted diagnostic.
 */
function errorText(value) {
  if (value === null || value === undefined) return 'agent error';
  const code = typeof value?.code === 'string' && value.code !== '' ? value.code : null;
  const message = value?.message ?? (typeof value === 'string' ? value : null);
  const text = message === null ? 'agent error' : String(message);
  return diagnostic(code === null ? text : `${code}: ${text}`);
}

/**
 * Build the bounded, duplicate-aware collector for assistant text.
 *
 * Two native behaviors make a plain array of chunks wrong:
 *  - `text-delta` events stream an answer and are followed by an
 *    `assistant/message` carrying the same text, so appending both would double
 *    it in job history;
 *  - neither source is bounded, so a runaway stream could make the process hold
 *    an unbounded string before any post-hoc slice applied.
 *
 * Both are handled here: every append is clamped to the limit as it happens, and
 * a completed message supersedes the deltas it was streaming instead of
 * following them. A later message starts a fresh pending buffer, so a multi-turn
 * run still accumulates each turn exactly once.
 * @param {number} limit - maximum retained characters.
 * @returns {object} collector with `appendDelta`, `mergeFinal`, `value`, `length`, `truncated`.
 */
function createTextCollector(limit) {
  let completed = '';
  let pending = '';
  let truncated = false;

  const clampAppend = (current, addition) => {
    if (addition === '') return current;
    if (current.length >= limit) {
      truncated = true;
      return current;
    }
    const joined = current + addition;
    if (joined.length <= limit) return joined;
    truncated = true;
    return joined.slice(0, limit);
  };

  return {
    appendDelta(text) {
      if (typeof text !== 'string' || text === '') return;
      pending = clampAppend(pending, text);
    },
    mergeFinal(text) {
      if (typeof text !== 'string' || text === '') return;
      // The completed message is authoritative for the turn it closes: when the
      // streamed deltas were its prefix, the message replaces them rather than
      // repeating them. Deltas that the message does not cover are kept.
      const merged = pending !== '' && !text.startsWith(pending) ? `${pending}${text}` : text;
      completed = clampAppend(completed, merged);
      pending = '';
    },
    value() {
      return completed + pending;
    },
    length() {
      return (completed + pending).length;
    },
    truncated() {
      return truncated;
    },
  };
}

function normalizeUsage(usage) {
  return {
    inputTokens: numeric(usage.inputTokens),
    outputTokens: numeric(usage.outputTokens),
    totalTokens: numeric(usage.totalTokens),
    reasoningTokens: numeric(usage.reasoningTokens),
  };
}

async function disposeQuietly(handle) {
  try {
    await handle.dispose();
  } catch {
    // Disposal failure must not mask the run outcome; the handle is unowned
    // either way and the native layer performs its own cleanup.
  }
}
