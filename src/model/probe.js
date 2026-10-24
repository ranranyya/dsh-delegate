// Model reachability probe.
//
// This exists because "the endpoint answered" and "the model answered" are
// different facts, and conflating them produces the classic false negative: a
// reasoning model is asked for one token, spends its entire budget thinking,
// emits no visible text, and looks broken. The probe therefore:
//   * sends a real request with a practical output budget;
//   * treats a reasoning-only response as a working model;
//   * treats a budget ending as a working model whenever the response carried
//     anything at all, because a provider that truncated the answer still
//     answered;
//   * reports what it observed instead of a bare boolean.

import { diagnostic } from '../config/redact.js';

/**
 * Default probe budget. Large enough that a reasoning model can finish.
 *
 * This is the whole point of the constant: the historical failure was a probe
 * that asked for one token, so a reasoning model spent it on thinking and the
 * check reported a timeout for a provider that was working perfectly.
 */
export const PROBE_MAX_TOKENS = 2048;

/**
 * Per-request budget for one reasoning effort, when the model declares a small
 * `maxTokens` capacity. Never below {@link PROBE_MIN_TOKENS}: a budget that
 * cannot hold a thought is the false negative this module exists to prevent.
 */
export const PROBE_MIN_TOKENS = 256;

/** Finish reasons that mean "the provider answered and stopped": everything else is a failure. */
const PRODUCTIVE_FINISH = new Set(['stop', 'max-tokens', 'tool-calls']);

/**
 * Read the probe budget from the options, falling back to the default.
 * @param {object} options - probe options.
 * @returns {number} a usable token budget.
 */
function budgetOf(options) {
  const configured = options?.maxTokens;
  if (Number.isInteger(configured) && configured <= 0) return PROBE_MAX_TOKENS;
  if (Number.isInteger(configured)) return Math.max(configured, PROBE_MIN_TOKENS);
  return PROBE_MAX_TOKENS;
}

/**
 * Normalize a streamed finish reason.
 *
 * The native protocol is `FinishReasonMap` (`{ type: 'finish', reason: { kind } }`),
 * and pi-ai maps a provider's `length` stop to `max-tokens`; a double-underscore
 * or snake-case spelling is accepted as well so a provider that reports its own
 * stop reason cannot be misread as "no finish at all".
 * @param {unknown} reason - chunk reason as a string or object.
 * @returns {string | null} normalized reason kind.
 */
export function normalizeFinishReason(reason) {
  const raw = typeof reason === 'string'
    ? reason
    : (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : null);
  if (raw === null || raw === '') return null;
  const normalized = raw.toLowerCase().replace(/_/g, '-');
  if (normalized === 'length' || normalized === 'max-tokens' || normalized === 'maxtokens') return 'max-tokens';
  if (normalized === 'end-turn' || normalized === 'stop' || normalized === 'stop-sequence') return 'stop';
  if (normalized === 'tool-use' || normalized === 'tool-calls') return 'tool-calls';
  if (normalized === 'aborted' || normalized === 'canceled' || normalized === 'cancelled') return 'aborted';
  return normalized;
}

/**
 * Whether one terminal finish reason means the provider answered.
 *
 * `max-tokens` belongs here on purpose: the response exists and the provider
 * stopped it at the budget. Only an explicit error or abort is a failure.
 * @param {string | null} kind - normalized reason kind.
 * @returns {boolean} true when the response counts as an answer.
 */
export function isProductiveFinish(kind) {
  return kind === null || PRODUCTIVE_FINISH.has(kind);
}

/**
 * Classify a finished probe stream.
 *
 * Exported so the classification is testable without a stream, and so a caller
 * that already collected text/reasoning can reuse exactly this decision.
 * @param {object} input - `{ text, reasoningText, finishKind, usage }`.
 * @returns {object} the verdict fields of a probe result.
 */
export function classifyProbeResponse(input) {
  const text = typeof input?.text === 'string' ? input.text : '';
  const reasoningText = typeof input?.reasoningText === 'string' ? input.reasoningText : '';
  const finishKind = input?.finishKind ?? null;
  const visible = text.trim();
  const reasoningOnly = visible === '' && reasoningText.trim() !== '';
  const answered = visible !== '' || reasoningOnly;
  const productive = isProductiveFinish(finishKind);
  const maxTokens = Number.isInteger(input?.maxTokens) ? input.maxTokens : PROBE_MAX_TOKENS;

  let code;
  if (answered) {
    // The model answered. A budget ending is reported as a budget fact rather
    // than as a failure, because the provider demonstrably works.
    code = 'PROBE_OK';
  } else if (productive) {
    // The provider completed the request and the answer carried nothing at all.
    code = 'PROBE_EMPTY_RESPONSE';
  } else {
    code = finishKind === 'aborted' ? 'PROBE_TIMEOUT' : 'PROBE_FAILED';
  }

  return {
    ok: code === 'PROBE_OK',
    detail: {
      code,
      finishReason: finishKind,
      reasoningOnly,
      maxTokens,
      // Stated as its own observation: an operator raising the budget reads it
      // here instead of inferring it from a truncated answer.
      budgetExhausted: finishKind === 'max-tokens',
      ...(code === 'PROBE_OK' ? {} : { message: messageFor(code, finishKind) }),
    },
    text: visible.slice(0, 200),
    reasoningOnly,
    reasoningChars: reasoningText.length,
  };
}

/**
 * Operator-facing text for a non-OK probe code.
 * @param {string} code - probe code.
 * @param {string | null} finishKind - normalized finish reason.
 * @returns {string} bounded message.
 */
function messageFor(code, finishKind) {
  if (code === 'PROBE_EMPTY_RESPONSE') return 'the model completed the request without any visible or reasoning content';
  if (code === 'PROBE_TIMEOUT') return 'the model request was aborted before an answer arrived';
  return `the model request ended without an answer (finish reason ${finishKind ?? 'unreported'})`;
}

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
      reasoningChars: 0,
      tokens: null,
    };
  }

  const maxTokens = budgetOf(options);
  const controller = new AbortController();
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener?.('abort', onExternalAbort, { once: true });

  let text = '';
  let reasoningText = '';
  let usage = null;
  let finishKind = null;

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
      // `block-end` carries the assembled block, which is the only place a
      // provider that streams no deltas (or drops them) is visible.
      if (chunk?.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object') {
        if (chunk.block.type === 'text' && typeof chunk.block.text === 'string' && text.trim() === '') {
          text += chunk.block.text;
        }
        if (chunk.block.type === 'reasoning' && typeof chunk.block.text === 'string' && reasoningText.trim() === '') {
          reasoningText += chunk.block.text;
        }
      }
      if (chunk?.type === 'finish') finishKind = normalizeFinishReason(chunk.reason);
    }

    const verdict = classifyProbeResponse({ text, reasoningText, finishKind, maxTokens });
    return {
      ...verdict,
      tokens: usage === null ? null : {
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        reasoningTokens: usage.reasoningTokens ?? null,
      },
    };
  } catch (error) {
    const aborted = controller.signal.aborted === true;
    // A stream that threw after delivering reasoning still answered the request.
    const delivered = text.trim() !== '' || reasoningText.trim() !== '';
    if (delivered) {
      const verdict = classifyProbeResponse({
        text,
        reasoningText,
        // The failure happened after content arrived, so the answer is real and
        // the reason is a transport fact worth reporting beside it.
        finishKind: null,
        maxTokens,
      });
      return {
        ...verdict,
        detail: {
          ...verdict.detail,
          streamError: {
            aborted,
            message: diagnostic(error?.message ?? error, 300),
            cause: typeof error?.code === 'string' ? error.code : null,
          },
        },
        tokens: usage === null ? null : {
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
          reasoningTokens: usage.reasoningTokens ?? null,
        },
      };
    }
    return {
      ok: false,
      detail: {
        code: aborted ? 'PROBE_TIMEOUT' : 'PROBE_FAILED',
        message: diagnostic(error?.message ?? error, 300) ?? 'the model request failed',
        cause: typeof error?.code === 'string' ? error.code : null,
        timeoutMs: aborted ? timeoutMs : null,
        maxTokens,
      },
      text: text.trim().slice(0, 200),
      reasoningOnly: false,
      reasoningChars: reasoningText.length,
      tokens: null,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', onExternalAbort);
  }
}
