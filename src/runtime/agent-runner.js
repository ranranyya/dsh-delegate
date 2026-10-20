// Native agent execution: one job, one agent, one session, no ambience.
//
// The runner is deliberately a thin, observable wrapper around the native
// lifecycle rather than a reimplementation of it. It adds exactly four things
// the native layer does not provide on its own:
//   1. an abort latch, so cancel/timeout that lands while creation is still in
//      flight still prevents the prompt from being delivered, and any handle
//      acquired afterwards is disposed instead of driven;
//   2. bounded prompt sizes, so a huge request cannot be smuggled into a turn;
//   3. an explicit request budget for the model call (never `maxTokens: 1`,
//      which makes a working provider look broken);
//   4. redacted diagnostics, so a provider error cannot leak a credential into
//      job history.

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { redactText } from '../config/redact.js';
import { LIMITS } from '../config/defaults.js';

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
  createFailed: 'RUN_CREATE_FAILED',
  turnFailed: 'RUN_TURN_FAILED',
  noText: 'RUN_NO_TEXT',
});

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
 * Truncate and redact a diagnostic string for durable storage.
 * @param {unknown} value - raw error text.
 * @param {number} [max] - character bound.
 * @returns {string | null} redacted text, or null.
 */
export function diagnostic(value, max = 800) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : String(value);
  if (text === '') return null;
  return redactText(text.slice(0, max));
}

/**
 * Drive one native agent to completion under a timeout and a cancellation latch.
 *
 * @param {object} deps - `agents` (native agent registry) and optional `sessions` and `logger`.
 * @param {object} request - `prompt`, `sessionId`, `cwd`, `selection`, `timeoutMs`, `signal`, `onEvent`.
 * @returns {Promise<object>} run result with text, usage facts and lifecycle evidence.
 */
export async function runAgent(deps, request) {
  const agents = deps?.agents;
  if (agents === undefined || agents === null || typeof agents.create !== 'function') {
    throw new RunError(RUN_CODES.agentsUnavailable, 'the native agent registry is not available', {});
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

  const state = {
    abortRequested: false,
    abortCause: null,
    handle: null,
    handleDisposed: false,
    textChunks: [],
    reasoningSeen: false,
    usage: null,
    turnEnd: null,
    error: null,
    agentId: null,
    sessionId: request.sessionId ?? null,
  };

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
    const createPromise = agents.create({
      sessionId: state.sessionId ?? undefined,
      meta: { cwd: request.cwd },
      agentOptions: {
        provider: selection.providerRoute,
        model: selection.model,
        ...(selection.reasoningEffort === null || selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
        // An explicit budget: small enough to bound cost, large enough that a
        // reasoning model is not starved into an apparent timeout.
        maxTokens: request.maxTokens ?? 8192,
      },
      setup: async (agentCtx) => {
        // The selection is agent-scoped state, not merely an `agentOptions`
        // hint: prompt assembly and request routing read it through this
        // coupling, so an options-only selection would be reported without
        // being applied to the conversation.
        installModelSelection(agentCtx, {
          current: {
            provider: selection.providerRoute,
            model: selection.model,
            // An unsupported/omitted effort must stay absent rather than
            // travel as `null`; the native ref types it as optional.
            reasoningEffort: selection.reasoningEffort ?? undefined,
          },
          assembled: undefined,
        });
        agentCtx.on('session/event', onEvent);
        agentCtx.on('agent/error', (payload) => {
          state.error = diagnostic(payload?.error?.message ?? payload?.error ?? 'agent error');
        });
      },
    });

    if (timeoutMs !== null) {
      timer = setTimeout(() => latch('timeout'), timeoutMs);
      timer.unref?.();
    }

    const raced = await Promise.race([
      createPromise.then((handle) => ({ kind: 'handle', handle })),
      aborted.then((cause) => ({ kind: 'aborted', cause })),
    ]);

    if (raced.kind === 'aborted') {
      // The handle may still arrive; dispose it whenever it does so no agent
      // outlives a job that is already terminal.
      createPromise.then(
        (handle) => { void disposeQuietly(handle); },
        () => {},
      );
      return finish(state, raced.cause === 'timeout' ? RUN_OUTCOMES.timedOut : RUN_OUTCOMES.cancelled);
    }

    const handle = raced.handle;
    state.handle = handle;
    state.agentId = handle?.agent?.id ?? null;
    state.sessionId = handle?.agent?.session?.id ?? state.sessionId;

    if (state.abortRequested) {
      await disposeHandle(state);
      return finish(state, state.abortCause === 'timeout' ? RUN_OUTCOMES.timedOut : RUN_OUTCOMES.cancelled);
    }

    // Wait for the agent's own initial quiescence before prompting, so the
    // prompt is not queued behind setup work that is still composing.
    await Promise.race([handle.agent.whenIdle(), aborted]);
    if (state.abortRequested) {
      await disposeHandle(state);
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

    await disposeHandle(state);
    return finish(state, outcome);
  } catch (error) {
    if (state.handle !== null) await disposeHandle(state);
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

  // Native session events carry their payload under `data`, e.g.
  // `{ type: 'assistant/message', data: { message, usage } }` and
  // `{ type: 'turn/end', data: { reason: { kind } } }`. Streaming chunk types
  // (`text-delta`, `reasoning-delta`) appear both inside a message part event and
  // as top-level events, so both spellings are accepted.
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
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') target.textChunks.push(block.text);
        if (block?.type === 'reasoning' && typeof block.text === 'string') target.reasoningSeen = true;
      }
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
      if (typeof text === 'string') target.textChunks.push(text);
      return;
    }
    if (type === 'reasoning-delta') {
      target.reasoningSeen = true;
      return;
    }
    if (type === 'message/part' || type === 'assistant/delta') {
      const delta = event.data?.delta ?? event.delta ?? event.data ?? null;
      if (delta?.type === 'text-delta' && typeof delta.text === 'string') target.textChunks.push(delta.text);
      if (delta?.type === 'reasoning-delta') target.reasoningSeen = true;
    }
  }

  function finish(target, outcome) {
    return {
      outcome,
      text: redactText(target.textChunks.join('')).trim(),
      reasoningOnly: target.reasoningSeen && target.textChunks.join('').trim() === '',
      usage: target.usage,
      turnEnd: target.turnEnd,
      agentId: target.agentId,
      sessionId: target.sessionId,
      cancelCause: target.abortCause,
      error: target.error,
      aborted: target.abortRequested,
    };
  }

  function deriveOutcome(target) {
    const reason = target.turnEnd?.reason;
    if (reason === 'completed' && (target.textChunks.length > 0 || target.reasoningSeen)) {
      return RUN_OUTCOMES.completed;
    }
    if (reason === 'aborted') return RUN_OUTCOMES.cancelled;
    if (target.error !== null) return RUN_OUTCOMES.failed;
    if (target.textChunks.length === 0 && !target.reasoningSeen) {
      // No content and no error: report as a failure with a distinguishable
      // code rather than pretending the task produced empty output.
      target.error = target.error ?? 'the agent produced no assistant text';
      return RUN_OUTCOMES.failed;
    }
    return reason === 'completed' ? RUN_OUTCOMES.completed : RUN_OUTCOMES.failed;
  }

  async function disposeHandle(target) {
    if (target.handle === null || target.handleDisposed) return;
    target.handleDisposed = true;
    await disposeQuietly(target.handle);
  }
}

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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
