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

import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { diagnostic, redactText } from '../config/redact.js';
import { LIMITS } from '../config/defaults.js';
import { placeSession, SessionPlacementError as SessionPlacementRefusal } from './session-placement.js';

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
});

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
 * Drive one native agent to completion under a timeout and a cancellation latch.
 *
 * Two ways a run can obtain its agent, and both produce the same evidence:
 *
 *  * a Workspace PLACEMENT (`request.placement`, or one resolved from the native
 *    controllers when the caller did not supply it): the DSH Session already exists
 *    in its Workspace, so the run drives the live Agent resolved for it. A reused
 *    conversation arrives this way, and so does a freshly created Session —
 *    resolving it is what attaches the native Agent to the Workspace the Session
 *    was created in.
 *  * no placement: the historical path, which creates a Session (and Agent) through
 *    `agents.create` under a caller-supplied or generated identity. Retained for a
 *    caller that owns its own conversation identity — the additional review, which
 *    composes its own preset and must not join the operator's history.
 *
 * The runner never disposes an agent it resolved. Disposal is what makes a Session
 * non-resumable for the next `reuse` run, so {@link driveAgent} accepts an
 * inherited `disposeOwned` and this entry point sets it only for agents it created.
 *
 * Cancellation is decided before anything is created: a run whose signal is
 * already aborted takes the unplaced path and returns `cancelled` without creating
 * a Workspace, a Session or an Agent, so an operator never finds an empty group
 * left behind by a run that never started.
 * @param {object} deps - `agents` (native agent registry), `agentPresets`, optional
 *   `workspaces`/`sessionController` for workspace-grouped placement, the native
 *   `sessions` persistence service (flush only), and `logger`.
 * @param {object} request - `prompt`, `cwd`, `selection`, `timeoutMs`, `signal`,
 *   `onEvent`, the optional preset selection (`presetId`, `presetOwnership`), and the
 *   optional `placement` / `conversationMode` / `allowUnplaced`.
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
    // Only an Agent this run created is owned by it. Both conversation modes now
    // drive a RESOLVED Agent (a new Session is resolved to its Agent too), and a
    // resolved Agent belongs to its Session: disposing it would end the
    // conversation and make the next `reuse` run unable to resume.
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
    mode: request?.conversationMode,
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
  // This holds in BOTH conversation modes: a `new` Session is also driven through
  // the Agent the session controller resolved for it, because the Session already
  // exists in the Workspace and `agents.create` would create a second one. The
  // preset is installed by whoever created that Agent (the session controller's
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
    // the Session it belongs to and make the next `reuse` run unable to resume.
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
  let timer = null;

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
          applySelection(agentCtx, selection);
          // The same applied-selection fact the resolved path records, so a
          // caller can compare the two paths on one field instead of on
          // `agentOptions` in one case and a context mutation in the other.
          state.selection = {
            provider: selection.providerRoute ?? null,
            model: selection.model ?? null,
            reasoningEffort: selection.reasoningEffort ?? null,
            applied: true,
          };
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

    if (timeoutMs !== null) {
      timer = setTimeout(() => latch('timeout'), timeoutMs);
      timer.unref?.();
    }

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
    if (timer !== null) clearTimeout(timer);
    if (request.signal !== undefined && request.signal !== null) {
      request.signal.removeEventListener?.('abort', onAbortSignal);
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
    applySelection(agentCtx, runSelection);
    // Recorded as a fact of the run, not inferred from the request: an operator
    // asking "which model did this continued conversation actually run on" gets
    // the applied triple back. `maxTokens` is not part of the selection — the
    // native selection carries only the provider route, model and effort.
    state.selection = {
      provider: runSelection?.providerRoute ?? null,
      model: runSelection?.model ?? null,
      reasoningEffort: runSelection?.reasoningEffort ?? null,
      applied: true,
    };
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
   * Release one handle at the end of a run.
   *
   * Disposal is skipped for an Agent this run did not create, and for any handle
   * the caller marked as not owned. A Session that is disposed cannot be resumed,
   * so disposing a resolved Agent would silently break the next `reuse` run —
   * exactly the failure this feature must not have.
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
      // The provider/model/effort actually installed on the Agent this run drove,
      // and the output budget it requested. Present on both the created and the
      // resolved path; `applied: false` is never emitted, so a value here is a
      // statement that the selection reached the agent's own context.
      selection: target.selection,
      maxTokens: target.maxTokens?.value ?? null,
      // Where this run's conversation landed, or `null` for the unplaced path
      // (the review). Stated as its own fact so a caller can report the Workspace
      // group and whether the conversation was continued without re-deriving it
      // from the ids.
      conversation: placement === null ? null : {
        mode: placement.mode ?? null,
        reused: placement.reused === true,
        workspaceId: placement.workspaceId ?? null,
        workspacePath: placement.workspacePath ?? null,
        sessionId: target.sessionId ?? placement.sessionId ?? null,
      },
      cancelCause: target.abortCause,
      error: target.error,
      aborted: target.abortRequested,
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
 * Install one run's model selection on an agent's own context.
 *
 * The selection is agent-scoped state, not merely an `agentOptions` hint: prompt
 * assembly and request routing read it through this coupling, so an options-only
 * selection would be reported without being applied to the conversation. Both
 * paths — a freshly created agent and a resolved one — therefore call this.
 *
 * The call is made unconditionally: it is what makes a per-task provider/model/
 * effort travel onto a conversation that outlives the task, and skipping it for a
 * resolved Agent would silently run the continued conversation on the previous
 * turn's model.
 * @param {object} agentCtx - the agent's scoped context.
 * @param {object} selection - provider route, model, optional effort.
 * @returns {void}
 */
function applySelection(agentCtx, selection) {
  installModelSelection(agentCtx, {
    current: {
      provider: selection.providerRoute,
      model: selection.model,
      // An unsupported/omitted effort must stay absent rather than travel as
      // `null`; the native ref types it as optional.
      reasoningEffort: selection.reasoningEffort ?? undefined,
    },
    assembled: undefined,
  });
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
