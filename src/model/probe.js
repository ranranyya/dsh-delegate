// Model reachability probe.
//
// This exists because "the endpoint answered" and "the model answered" are
// different facts, and conflating them produces the classic false negative: a
// reasoning model is asked for one token, spends its entire budget thinking,
// emits no visible text, and looks broken. The probe therefore:
//   * sends a real request with a practical output budget;
//   * treats a reasoning-only response as a working model;
//   * reports what it observed instead of a bare boolean.

import { diagnostic } from '../runtime/agent-runner.js';

/** Default probe budget. Large enough that a reasoning model can finish. */
export const PROBE_MAX_TOKENS = 2048;

/**
 * Send one short request through the native LLM seam and classify the response.
 * @param {object} deps - `llm` native service.
 * @param {object} route - value returned by `resolveRoute`.
 * @param {object} [options] - `maxTokens`, `signal`, `timeoutMs`.
 * @returns {Promise<object>} probe result with explicit observations.
 */
export async function probeModel(deps, route, options = {}) {
  const llm = deps?.llm;
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    return {
      ok: false,
      detail: { code: 'PROBE_UNAVAILABLE', message: 'the native llm service cannot stream a request' },
      text: '',
      reasoningOnly: false,
      tokens: null,
    };
  }

  const maxTokens = Number.isInteger(options.maxTokens) ? options.maxTokens : PROBE_MAX_TOKENS;
  const controller = new AbortController();
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener?.('abort', onExternalAbort, { once: true });

  let text = '';
  let reasoningText = '';
  let usage = null;
  let finish = null;

  try {
    const stream = llm.stream({
      provider: route.providerRoute,
      model: route.model,
      ...(route.reasoningEffort === null || route.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: route.reasoningEffort }),
      maxTokens,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Reply with the single word: ready' }],
      }],
      signal: controller.signal,
    });

    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningText += chunk.text;
      if (chunk?.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage;
      if (chunk?.type === 'finish') finish = { reason: chunk.reason?.kind ?? null };
    }

    const visible = text.trim();
    const reasoningOnly = visible === '' && reasoningText.trim() !== '';
    return {
      ok: visible !== '' || reasoningOnly,
      // A finish reason of `max-tokens` with reasoning present is a budget fact,
      // not a failure; it is surfaced so an operator can raise the budget.
      detail: {
        code: visible !== '' || reasoningOnly ? 'PROBE_OK' : 'PROBE_EMPTY_RESPONSE',
        finishReason: finish?.reason ?? null,
        reasoningOnly,
        maxTokens,
      },
      text: visible.slice(0, 200),
      reasoningOnly,
      reasoningChars: reasoningText.length,
      tokens: usage === null ? null : {
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null,
      },
    };
  } catch (error) {
    const aborted = controller.signal.aborted === true;
    return {
      ok: false,
      detail: {
        code: aborted ? 'PROBE_TIMEOUT' : 'PROBE_FAILED',
        message: diagnostic(error?.message ?? error, 300),
        cause: typeof error?.code === 'string' ? error.code : null,
        timeoutMs: aborted ? timeoutMs : null,
      },
      text: text.trim().slice(0, 200),
      reasoningOnly: false,
      tokens: null,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', onExternalAbort);
  }
}
