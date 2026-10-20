// Independent additional review.
//
// Review exists to give the host a second opinion, not to approve work. Three
// properties make it independent rather than decorative:
//  1. It uses its own provider/model/effort selection. Reusing the worker's
//     selection would reproduce the worker's blind spots.
//  2. It is read-only by construction: a deny-by-default tool guard plus a
//     visibility restriction, both installed on the reviewer's own agent scope.
//     A tool that is not on the allow-list cannot execute, so the reviewer
//     cannot change the workspace it is reviewing.
//  3. It is off unless enabled, and it has no loop back into execution: a
//     "changes requested" verdict is reported to the host, never turned into an
//     automatic repair round.
//
// Review errors are tracked separately from execution errors so a broken
// reviewer never looks like a broken task.

import { randomUUID } from 'node:crypto';
import { LIMITS } from '../config/defaults.js';
import { REDACTED_PLACEHOLDER } from './prompts.js';

/** Review verdicts. `unknown` is used when the reviewer produced no parsable verdict. */
export const REVIEW_VERDICTS = Object.freeze(['approve', 'changes-requested', 'unknown']);

/** Review outcome states kept distinct from the execution outcome. */
export const REVIEW_STATES = Object.freeze({
  disabled: 'disabled',
  notRun: 'not_run',
  completed: 'completed',
  failed: 'failed',
});

/**
 * Tools the reviewer may execute. The list is intentionally small, and it is a
 * deny-by-default allow-list: membership is required, not merely suggested.
 * @param {string[]} [extra] - operator-approved additional tool names.
 * @returns {ReadonlySet<string>} allowed tool names.
 */
export function reviewerToolAllowList(extra = []) {
  const base = ['read_file', 'list_directory', 'search_files', 'glob', 'grep'];
  const allowed = new Set(base);
  for (const name of extra) {
    if (typeof name === 'string' && name.trim() !== '') allowed.add(name.trim());
  }
  return allowed;
}

/**
 * Intercept write-shaped tool names even if an operator mistakenly allows them.
 * @param {string} name - tool name.
 * @returns {boolean} true when the name looks like a mutation.
 */
export function looksMutating(name) {
  return /(^|[_\-. ])(write|edit|apply|patch|delete|remove|move|rename|chmod|chown|create_file|mkdir|touch|exec|shell|bash|run|spawn|install|git_commit|commit|push|merge|reset|checkout|add)([_\-. ]|$)/i
    .test(String(name ?? ''));
}

/**
 * Review the delivered work with a separate model selection, read-only.
 *
 * @param {object} deps - `agents`, optional `sessions`, `logger`.
 * @param {object} input - `taskId`, `cwd`, `selection`, `prompt`, `evidence`, `timeoutMs`,
 *   `extraAllowedTools`.
 * @returns {Promise<object>} review record with verdict and its own diagnostics.
 */
export async function reviewWork(deps, input) {
  const agents = deps?.agents;
  if (agents === undefined || agents === null || typeof agents.create !== 'function') {
    return {
      state: REVIEW_STATES.failed,
      error: { code: 'REVIEW_AGENTS_UNAVAILABLE', message: 'the native agent registry is not available' },
      verdict: null,
      text: '',
      selection: summarizeSelection(input.selection),
    };
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (prompt === '') {
    return {
      state: REVIEW_STATES.failed,
      error: { code: 'REVIEW_PROMPT_EMPTY', message: 'the review prompt is empty' },
      verdict: null,
      text: '',
      selection: summarizeSelection(input.selection),
    };
  }

  const allowed = reviewerToolAllowList(input.extraAllowedTools ?? []);
  const denials = [];
  const chunks = [];
  const selection = input.selection ?? {};
  const timeoutMs = Number.isInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : null;

  let handle = null;
  let timer = null;
  let cancelled = false;

  try {
    handle = await agents.create({
      sessionId: randomUUID(),
      meta: { cwd: input.cwd },
      agentOptions: {
        provider: selection.providerRoute,
        model: selection.model,
        ...(selection.reasoningEffort === null || selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selection.reasoningEffort }),
        maxTokens: 8192,
      },
      setup: async (agentCtx) => {
        // Two layers, on purpose:
        //  - restrict() hides disallowed tools from the model's schema;
        //  - guard() denies execution even if a name reached the model by
        //    another route. Guards cannot be overridden by listener ordering.
        if (typeof agentCtx.tools?.restrict === 'function') {
          agentCtx.tools.restrict({ allow: [...allowed] });
        }
        if (typeof agentCtx.tools?.guard === 'function') {
          agentCtx.tools.guard((execution) => {
            const name = execution?.name;
            if (typeof name !== 'string') return 'reviewer tool identity missing';
            if (looksMutating(name)) {
              denials.push({ tool: name, reason: 'mutation-shaped tool name' });
              return `the additional review is read-only and cannot run ${name}`;
            }
            if (!allowed.has(name)) {
              denials.push({ tool: name, reason: 'not on the read-only allow-list' });
              return `the additional review may only use read-only tools; ${name} is not permitted`;
            }
            return undefined;
          });
        }
        agentCtx.on('session/event', (_session, event) => {
          if (event?.type !== 'assistant/message') return;
          const content = event.data?.message?.content ?? [];
          const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('');
          if (text !== '') chunks.push(text);
        });
      },
    });

    if (handle === null) {
      return {
        state: REVIEW_STATES.failed,
        error: { code: 'REVIEW_CREATE_FAILED', message: 'the reviewer agent could not be created' },
        verdict: null,
        text: '',
        selection: summarizeSelection(selection),
        denials,
      };
    }

    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        cancelled = true;
        try {
          handle.agent.cancel({ kind: 'hook', reason: 'review timeout' }, { keepInbox: false });
        } catch {
          // Already idle.
        }
      }, timeoutMs);
      timer.unref?.();
    }

    await handle.agent.whenIdle();
    handle.agent.followup(userMessageFor(prompt));
    await handle.agent.whenIdle();

    const text = chunks.join('').trim();
    const verdict = parseVerdict(text);

    return {
      state: cancelled ? REVIEW_STATES.failed : REVIEW_STATES.completed,
      error: cancelled
        ? { code: 'REVIEW_TIMEOUT', message: 'the additional review exceeded its time budget' }
        : null,
      verdict,
      text: text.slice(0, LIMITS.reviewPromptChars),
      selection: summarizeSelection(selection),
      denials,
      // Recorded so the reviewer's own output size is visible as evidence.
      chars: text.length,
    };
  } catch (error) {
    return {
      state: REVIEW_STATES.failed,
      error: {
        code: 'REVIEW_FAILED',
        message: 'the additional review could not complete',
        detail: typeof error?.message === 'string' ? error.message.slice(0, 400) : null,
      },
      verdict: null,
      text: chunks.join('').trim().slice(0, LIMITS.reviewPromptChars),
      selection: summarizeSelection(selection),
      denials,
    };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (handle !== null) {
      try {
        await handle.dispose();
      } catch {
        // Disposal failure does not change the review verdict.
      }
    }
  }
}

function userMessageFor(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: { kind: 'user' },
  });
}

/**
 * Extract a verdict from reviewer text.
 *
 * The reviewer is constrained by the prompt to emit a machine-readable line.
 * Absence of that line yields `unknown`, which the host must treat as "not
 * approved" — never as approval by default.
 * @param {string} text - reviewer output.
 * @returns {{ verdict: string, reason: string | null } | null} parsed verdict.
 */
export function parseVerdict(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const match = /VERDICT:\s*(approve|changes-requested)\b/i.exec(text);
  if (match === null) return { verdict: 'unknown', reason: null };
  const verdict = match[1].toLowerCase() === 'approve' ? 'approve' : 'changes-requested';
  const reasonMatch = /REASON:\s*(.+)/i.exec(text);
  return { verdict, reason: reasonMatch === null ? null : reasonMatch[1].trim().slice(0, 400) };
}

function summarizeSelection(selection) {
  if (selection === null || selection === undefined) return null;
  return {
    providerId: selection.providerId ?? null,
    model: selection.model ?? null,
    reasoningEffort: selection.reasoningEffort ?? null,
  };
}

export { REDACTED_PLACEHOLDER };
