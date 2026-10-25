// Independent additional review.
//
// Review exists to give the host a second opinion, not to approve work. Three
// properties make it independent rather than decorative:
//  1. It uses its own provider/model/effort selection. Reusing the worker's
//     selection would reproduce the worker's blind spots.
//  2. It is read-only by construction: a visibility restriction intersected with
//     the tools this agent actually has, a deny-by-default execution guard, and a
//     model-facing assembly transform that filters the tools the request is
//     actually sent with. All three are installed through the shared `runAgent`
//     lifecycle, so review and execution cannot drift apart. Read-only here is a
//     TOOL PERMISSION, not an OS sandbox: a reviewer that somehow obtained a
//     shell would not be confined by this guard.
//  3. It is off unless enabled, and it has no loop back into execution: a
//     "changes requested" verdict is reported to the host, never turned into an
//     automatic repair round.
//
// Review errors are tracked separately from execution errors so a broken
// reviewer never looks like a broken task.
//
// Fail-closed rules. Review refuses to prompt when any read-only mechanism is
// missing or cannot be installed:
//  - no native tool inventory (`tools.schemas(scope)`),
//  - no `tools.restrict()`,
//  - no `tools.guard()`,
//  - no `system-prompt/assemble` registration facility (`agentCtx.on`),
//  - no read-only tool in the inventory to allow,
//  - an assembly that is missing, malformed, or still carries a name outside the
//    computed read-only set,
//  - an inventory that does not look exactly like the read-only evidence it was
//    drawn from.
// A review that cannot prove it is restricted does not run at all.
//
// Why the restriction alone is not enough (`assertAdvertised`). Native
// `tools.restrict()` is deliberately NOT a per-agent capability filter over
// everything an agent can see: `ToolRuntime.view()` applies restrictions to the
// surface a scope INHERITS (the global layer and every ancestor scope on its
// chain) and always keeps what the scope's OWN layer registers. That exemption
// is native design — the delegation runtime registers a child's own structured
// output tool into the child's layer — and `dsh-tool-subagent` uses the same
// mechanism to install a live `subagent` tool into a composing agent's own
// layer before its setup hook runs. So the reviewer's own scope CAN hold tools
// the restriction cannot remove, and there is no supported API to take another
// plugin's scope-local tool away.
//
// What removes them from the model's view (`installAssemblyFilter`). The Agent
// loop builds each request from `systemPrompt.assemble(...)`, whose
// `tools` field is exactly what the provider is sent
// (`dsh-agent-loop` passes `assembly.tools` into the request). The
// `system-prompt/assemble` waterfall transforms `PromptAssembly`
// (`(assembly, context, next)` over `{ sections, contexts, tools, variables }`),
// so review registers a scoped transform during setup that returns the
// downstream assembly with `tools` filtered to the fixed allow-list intersected
// with the native names, and proves the resulting names are exactly that set
// before returning it. A missing or malformed assembly, or a filter that cannot
// be registered, fails the review before any request is made.
//
// Scope of the claim. The transform filters the MODEL-FACING assembly of this
// reviewer. It does not remove anyone's registration from the runtime registry:
// a sibling agent's `subagent` still exists there, and this module never claims
// otherwise. The execution guard is what makes the tool non-executable for the
// reviewer regardless of where the name came from, and the assembly filter is
// what keeps it out of the request in the first place.
//
// Which composition the reviewer joins (`planComposition`). The deployment's
// DEFAULT preset is not a read-only surface: the shipped `standard` composition
// mounts `dsh-tool-subagent`, whose tool survives a scope restriction by design,
// so a reviewer joining it cannot be proven read-only. Refusing every review on
// such a deployment would make the feature unreachable; mounting the default
// anyway would be a false claim. So review composes its own: one dedicated,
// plugin-owned native preset whose only rows are `dsh-tool-fs`
// (`read`/`read_image` on, `write`/`edit` off) and `dsh-tool-fs-search`. There is
// no delegation row, so nothing agent-local is injected, and the scoped
// restriction still removes anything inherited. The composition is decided by
// capability probes on the registry this review was handed — never by a name:
//  - `register()` + `mount()` + `resolve()` present -> the plugin-owned
//    composition is used, and its preparation is verified before any agent
//    exists;
//  - a registry that mounts but cannot register -> the default composition, and
//    the advertised-surface proof still refuses anything it cannot prove
//    (`REVIEW_TOOL_SCOPE_UNENFORCEABLE`), so an unusable registry fails closed
//    with a distinct reason instead of pretending to be read-only.

import { randomUUID } from 'node:crypto';
import { LIMITS } from '../config/defaults.js';
import { redactText } from '../config/redact.js';
import { DEFAULT_MAX_TOKENS, RUN_OUTCOMES, RunError, diagnostic, runAgent } from '../runtime/agent-runner.js';
import { PRESET_CODES, reviewCompositionRows } from './preset.js';
import { REDACTED_PLACEHOLDER } from './prompts.js';

/** Review verdicts. `unknown` is used when the reviewer produced no parsable verdict. */
export const REVIEW_VERDICTS = Object.freeze(['approve', 'changes-requested', 'unknown']);

/**
 * Review outcome states, kept distinct from the execution outcome.
 *
 * `cancelled` is its own state rather than a flavour of `failed`: a cancelled
 * review says nothing about the work, so the host must not read it as a finding.
 */
export const REVIEW_STATES = Object.freeze({
  disabled: 'disabled',
  notRun: 'not_run',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
});

/** Stable review error codes. None of them can be produced by execution. */
export const REVIEW_CODES = Object.freeze({
  agentsUnavailable: 'REVIEW_AGENTS_UNAVAILABLE',
  presetsUnavailable: 'REVIEW_PRESETS_UNAVAILABLE',
  // The registry cannot register the dedicated read-only composition, so this
  // deployment cannot compose a provably read-only reviewer. Distinct from
  // `presetsUnavailable` (no registry at all) and from `scopeUnenforceable` (a
  // composition that mounted but still advertises a non-read tool).
  presetUnavailable: PRESET_CODES.unsupported,
  // Preparation of the plugin-owned composition failed: registration refused,
  // an unusable row, absent tool packages, or its own bounded deadline.
  presetPrepareFailed: 'REVIEW_PRESET_PREPARE_FAILED',
  promptEmpty: 'REVIEW_PROMPT_EMPTY',
  promptTooLarge: 'REVIEW_PROMPT_TOO_LARGE',
  restrictUnavailable: 'REVIEW_TOOL_RESTRICT_UNAVAILABLE',
  guardUnavailable: 'REVIEW_TOOL_GUARD_UNAVAILABLE',
  inventoryUnavailable: 'REVIEW_TOOL_INVENTORY_UNAVAILABLE',
  restrictRefused: 'REVIEW_TOOL_RESTRICT_REFUSED',
  // The agent context cannot register the `system-prompt/assemble` transform, so
  // the reviewer has no supported way to keep unremovable names out of the
  // model-facing request. Distinct from a transform that runs and reports a bad
  // assembly (`assemblyMismatch`).
  assemblyUnavailable: 'REVIEW_ASSEMBLY_HOOK_UNAVAILABLE',
  // The model-facing assembly could not be filtered or proven: the downstream
  // value was missing or malformed, or its tool names were not exactly the fixed
  // read-only set intersected with the native inventory. Review fails closed
  // instead of sending a request whose tools it cannot account for.
  assemblyMismatch: 'REVIEW_ASSEMBLY_MISMATCH',
  // The registry advertises tools the read-only policy cannot remove. Native
  // restrictions never filter a scope's own layer, so an agent-local tool (the
  // composing `subagent`) survives them. Retained as a code because a pre-policy
  // inventory that already differs from the read-only evidence is still refused;
  // unremovable names that survive INTO the assembly are now reported as
  // `assemblyMismatch`.
  scopeUnenforceable: 'REVIEW_TOOL_SCOPE_UNENFORCEABLE',
  // The advertised surface after the policy is installed is not exactly the
  // read-only set: the restriction did not take effect as computed.
  surfaceMismatch: 'REVIEW_TOOL_SURFACE_MISMATCH',
  noReadTools: 'REVIEW_NO_READ_TOOLS',
  cancelled: 'REVIEW_CANCELLED',
  timeout: 'REVIEW_TIMEOUT',
  failed: 'REVIEW_FAILED',
});

/**
 * The tools an additional review may execute, by their real native names.
 *
 * These are the names the shipped DSH filesystem plugins register
 * (`dsh-tool-fs`: `read`, `write`, `edit`, `read_image`; `dsh-tool-fs-search`:
 * `glob`, `grep`). Invented names such as `read_file` are not here on purpose:
 * `tools.restrict()` throws on an unknown name, so a wrong name would turn into
 * a runtime failure instead of a restriction. Capability tools outside the list
 * (`subagent`, a shell, any workflow transport) are excluded for the opposite
 * reason: each one can act on the workspace or start another agent, which a
 * read-only reviewer must not be able to do.
 */
const REVIEW_TOOLS = Object.freeze(['read', 'read_image', 'glob', 'grep']);

/** Bound on recorded tool denials, so a hostile reviewer cannot grow history. */
const MAX_DENIALS = 100;

/** Bound on a tool name or denial reason retained in review evidence. */
const MAX_TOOL_CHARS = 64;
const MAX_REASON_CHARS = 200;

/** Bound on an error message projected into a review record. */
const MAX_ERROR_CHARS = 400;

/**
 * Default bound on preparing the review composition (registration + verification).
 *
 * Registering a two-row composition is import-and-activate work, not model work;
 * it is normally fast. The bound exists so a registry waiting on another plugin
 * cannot hold a review open, and it is deliberately far below the review's own
 * time budget so the failure reads as "composition unavailable", not "review
 * timed out".
 */
const PREPARE_TIMEOUT_MS = 30_000;

/**
 * Tools the reviewer may execute.
 *
 * The set is fixed. `extra` is accepted for call-site compatibility with earlier
 * builds, but it is deliberately ignored: an operator-supplied list must never
 * widen a read-only review into something that can mutate the workspace it is
 * judging. The effective allow-list an agent receives is this set intersected
 * with that agent's real tool inventory.
 * @param {string[]} [extra] - ignored; retained so older callers keep working.
 * @returns {ReadonlySet<string>} allowed tool names.
 */
export function reviewerToolAllowList(extra = []) {
  // Intentionally not merged: see the doc comment above.
  void extra;
  return new Set(REVIEW_TOOLS);
}

/**
 * Whether a tool name looks like a mutation.
 *
 * Kept for diagnostics only. It is NOT the read-only mechanism: the guard denies
 * every name outside the allow-list, so a write tool with an unexpected name is
 * still denied. Using a name regex as the mechanism would let a new tool name
 * through by accident.
 * @param {string} name - tool name.
 * @returns {boolean} true when the name looks like a mutation.
 */
export function looksMutating(name) {
  return /(^|[_\-. ])(write|edit|apply|patch|delete|remove|move|rename|chmod|chown|create_file|mkdir|touch|exec|shell|bash|run|spawn|install|git_commit|commit|push|merge|reset|checkout|add)([_\-. ]|$)/i
    .test(String(name ?? ''));
}

/**
 * Decide which composition a review joins, and prepare it.
 *
 * The order of preference is fixed and capability-based, never name-based:
 *  1. a plugin-owned dedicated composition (`composer`), registered and verified
 *     once per plugin instance — the supported, read-only-by-construction path.
 *     Its preparation replaces the default composition, so no delegation row can
 *     inject a scope-local tool in the first place;
 *  2. otherwise the registry's configured default, which `assertAdvertised` will
 *     still refuse unless it advertises exactly the read-only set.
 *
 * A preparation failure of the owned composition is NOT silently downgraded to
 * the default: the failure is reported with its own code, because a deployment
 * that *can* compose a read-only reviewer but cannot do so right now is a
 * different problem from one that never could, and falling back would turn a
 * composition bug into a review whose read-only claim rests on a weaker proof.
 * @param {object} deps - review dependencies (`agentPresets`, optional `reviewPresets`).
 * @param {{ presetUnavailable?: string|null }} options - the registry verdict for the reason text.
 * @param {{ timeoutMs: number|null, signal: AbortSignal|null }} bounds - preparation deadline.
 * @returns {Promise<{ presetId: string|undefined, composition: string }>} mount plan.
 * @throws {RunError} with a `REVIEW_*` code when preparation fails.
 */
async function prepareComposition(deps, registry, bounds) {
  const composer = deps?.reviewPresets;
  if (composer !== undefined && composer !== null && typeof composer.preparation === 'function') {
    // The composer owns the id it created and refuses everything else; a
    // registry that cannot register reports its own distinct code from here.
    const presetId = await composer.preparation(bounds);
    return { presetId, composition: 'dedicated' };
  }
  // No composer in the dependency set: the plugin was not activated with the
  // preset lifecycle wired in. That is a composition fact, not a policy claim,
  // so it is reported as unsupported rather than degrading the proof.
  void registry;
  throw new RunError(
    PRESET_CODES.unsupported,
    'no read-only review composition is available to this review, so it cannot be composed',
    { composition: 'none' },
  );
}

/**
 * Review the delivered work with a separate model selection, read-only.
 *
 * The review runs through the same native lifecycle as delegation (`runAgent`):
 * preset mount, installed model selection, one prompt, bounded redacted output,
 * timeout and cancellation that also cover pending creation. Review only adds
 * the read-only tool policy and the review-shaped result.
 *
 * @param {object} deps - `agents`, `agentPresets`, optional `reviewPresets` (the
 *   plugin-owned composition), `sessions`, `logger`.
 * @param {object} input - `taskId`, `cwd`, `selection`, `prompt`, `timeoutMs`,
 *   `signal`, `prepareTimeoutMs`, `extraAllowedTools` (ignored).
 * @returns {Promise<object>} review record with verdict and its own diagnostics.
 */
export async function reviewWork(deps, input) {
  const options = input ?? {};
  const selection = options.selection ?? {};
  const denials = [];

  const agents = deps?.agents;
  if (agents === undefined || agents === null || typeof agents.create !== 'function') {
    return failed(REVIEW_CODES.agentsUnavailable, 'the native agent registry is not available', selection, denials);
  }
  // Review reuses the run lifecycle, which joins a preset before installing a
  // tool policy. A missing preset registry means no composition would be
  // mounted, and the restriction would then be computed over the wrong surface.
  const presets = deps?.agentPresets;
  if (presets === undefined || presets === null || typeof presets.mount !== 'function') {
    return failed(
      REVIEW_CODES.presetsUnavailable,
      'the native agent preset registry is not available, so no tool inventory can be restricted',
      selection,
      denials,
    );
  }

  const prompt = typeof options.prompt === 'string' ? options.prompt : '';
  if (prompt === '') {
    return failed(REVIEW_CODES.promptEmpty, 'the review prompt is empty', selection, denials);
  }
  if (prompt.length > LIMITS.promptChars) {
    return failed(REVIEW_CODES.promptTooLarge, `the review prompt exceeds ${LIMITS.promptChars} characters`, selection, denials);
  }

  // Fixed by construction; `extraAllowedTools` cannot widen it.
  const allowed = reviewerToolAllowList(options.extraAllowedTools ?? []);
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : null;
  // Preparation (registering and verifying the composition) has its own bound so
  // it cannot wait out the review's own budget, and it observes the same
  // cancellation the review does.
  const prepareTimeoutMs = Number.isInteger(options.prepareTimeoutMs) && options.prepareTimeoutMs > 0
    ? options.prepareTimeoutMs
    : PREPARE_TIMEOUT_MS;
  const signal = options.signal ?? null;
  const composer = deps?.reviewPresets;

  let composition;
  try {
    composition = await prepareComposition(deps, presets, { timeoutMs: prepareTimeoutMs, signal });
  } catch (error) {
    // An interruption is terminal but says nothing about the work being reviewed,
    // so it is reported as `cancelled` (its own state) rather than as a review
    // failure. Every other preparation problem is a real failure.
    const reason = typeof error?.code === 'string' ? error.code : '';
    if (reason === PRESET_CODES.cancelled || reason === PRESET_CODES.disposed) {
      return {
        state: REVIEW_STATES.cancelled,
        error: { code: REVIEW_CODES.cancelled, message: 'the additional review was cancelled before it started' },
        verdict: null,
        text: '',
        selection: summarizeSelection(selection),
        denials,
      };
    }
    return failureRecord(error, selection, denials);
  }
  // A cancellation that landed while the composition was preparing must not be
  // followed by an agent creation: the caller asked to stop.
  if (signal?.aborted === true) {
    return {
      state: REVIEW_STATES.cancelled,
      error: { code: REVIEW_CODES.cancelled, message: 'the additional review was cancelled while preparing' },
      verdict: null,
      text: '',
      selection: summarizeSelection(selection),
      denials,
    };
  }

  try {
    const run = await runAgent(deps, {
      sessionId: options.sessionId ?? randomUUID(),
      prompt,
      cwd: options.cwd,
      selection,
      timeoutMs,
      signal,
      // The same practical output allowance the worker asks for. A reviewer reads
      // evidence (a patch can be long) and then reasons about it, so a smaller
      // budget would starve it into an apparent timeout rather than a verdict. An
      // explicit, valid `maxTokens` on the review input is preserved unchanged.
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      // The composition this review measured as read-only. `undefined` keeps the
      // registry's configured default; a named id is the plugin-owned one and is
      // only mounted when the composer still owns it.
      presetId: composition.presetId,
      presetOwnership: composer ?? null,
      // The review is not part of the operator's conversation history: it composes
      // its own read-only preset and drives a throwaway session under the id above.
      // Claiming a Workspace (and creating a Session in it) would put a review in
      // the same group as the work it examined and would make it resumable by a
      // later `reuse` run.
      allowUnplaced: true,
      // Runs inside `agents.create` after the preset mount and before the prompt
      // is delivered: the tool policy is in place for every turn this reviewer
      // will ever take, and a policy that cannot be installed fails creation
      // rather than degrading into an unrestricted review.
      setup: (agentCtx, agent) => installReadOnlyTools(agentCtx, agent, allowed, denials),
    });

    const text = redactText(typeof run.text === 'string' ? run.text : '').trim();
    const base = { selection: summarizeSelection(selection), denials, chars: text.length };

    if (run.outcome === RUN_OUTCOMES.completed) {
      return {
        state: REVIEW_STATES.completed,
        error: null,
        verdict: parseVerdict(text),
        text: text.slice(0, LIMITS.reviewPromptChars),
        ...base,
      };
    }
    if (run.outcome === RUN_OUTCOMES.cancelled) {
      return {
        state: REVIEW_STATES.cancelled,
        error: { code: REVIEW_CODES.cancelled, message: 'the additional review was cancelled' },
        verdict: null,
        text: text.slice(0, LIMITS.reviewPromptChars),
        ...base,
      };
    }
    if (run.outcome === RUN_OUTCOMES.timedOut) {
      return {
        state: REVIEW_STATES.failed,
        error: { code: REVIEW_CODES.timeout, message: 'the additional review exceeded its time budget' },
        verdict: null,
        text: text.slice(0, LIMITS.reviewPromptChars),
        ...base,
      };
    }
    return {
      state: REVIEW_STATES.failed,
      error: {
        code: REVIEW_CODES.failed,
        message: 'the additional review did not complete',
        // Already bounded and redacted by the runner.
        detail: typeof run.error === 'string' ? run.error.slice(0, MAX_ERROR_CHARS) : null,
      },
      verdict: null,
      text: text.slice(0, LIMITS.reviewPromptChars),
      ...base,
    };
  } catch (error) {
    return failureRecord(error, selection, denials);
  }
}

/**
 * Install the read-only tool policy on one reviewer agent.
 *
 * Four mechanisms, on purpose, because they answer four different questions:
 *  - `restrict()` removes disallowed tools from what this agent INHERITS;
 *  - `guard()` denies execution even if a name reaches the model another way;
 *  - a `system-prompt/assemble` transform filters the tools the request is
 *    actually sent with, which is the only supported way to keep a scope-local
 *    tool (the composing `subagent`) out of the model's view;
 *  - a post-install re-read of the advertised surface proves the restriction
 *    took effect exactly as computed before any prompt is delivered.
 *
 * Guards have no allow result, so listener ordering cannot turn a denial back
 * into permission. The transform is registered inside this scoped agent
 * context, so it participates only in this reviewer's assemblies.
 *
 * The allow-list handed to `restrict()` is the intersection of the fixed
 * read-only names and the agent's real inventory. `tools.restrict()` throws on a
 * name the registry does not know, so restricting with the fixed list alone
 * would fail whenever the deployment lacks (say) the image reader. The same
 * intersection is the sole authority for the assembly filter: caller input
 * (`extraAllowedTools`) is ignored by {@link reviewerToolAllowList}, so neither
 * mechanism can be widened.
 * @param {object} agentCtx - the agent's scoped context.
 * @param {object} agent - the agent itself; the scope key for `tools.schemas()`.
 * @param {ReadonlySet<string>} allowed - fixed read-only names.
 * @param {object[]} denials - this review's denial log.
 * @returns {Promise<void>} resolves when the policy is installed and proven.
 * @throws {RunError} when any mechanism is missing, refuses, or the advertised
 *   surface is not the read-only set.
 */
async function installReadOnlyTools(agentCtx, agent, allowed, denials) {
  const tools = agentCtx?.tools;
  if (tools === null || tools === undefined) {
    throw new RunError(REVIEW_CODES.restrictUnavailable, 'the reviewer agent has no tool registry to restrict', {});
  }
  if (typeof tools.restrict !== 'function') {
    throw new RunError(REVIEW_CODES.restrictUnavailable, 'the native tool registry cannot restrict a reviewer agent', {});
  }
  if (typeof tools.guard !== 'function') {
    throw new RunError(REVIEW_CODES.guardUnavailable, 'the native tool registry cannot guard a reviewer agent', {});
  }
  if (typeof tools.schemas !== 'function') {
    throw new RunError(
      REVIEW_CODES.inventoryUnavailable,
      'the native tool registry cannot report the reviewer tool inventory',
      {},
    );
  }
  // Checked before anything is installed: a reviewer that cannot filter its
  // model-facing assembly must not be half-configured and then prompted.
  if (typeof agentCtx.on !== 'function') {
    throw new RunError(
      REVIEW_CODES.assemblyUnavailable,
      'the reviewer agent cannot register a system-prompt assembly transform, so its model-facing tools cannot be filtered',
      {},
    );
  }

  const available = readInventory(tools, agent);
  const usable = REVIEW_TOOLS.filter((name) => available.has(name));
  if (usable.length === 0) {
    throw new RunError(
      REVIEW_CODES.noReadTools,
      'the reviewer agent has none of the read-only tools, so no review can be proven read-only',
      { inventory: [...available].sort().slice(0, MAX_DENIALS) },
    );
  }

  const usableSet = new Set(usable);
  try {
    tools.restrict({ allow: usable });
  } catch (error) {
    // Unknown names, an empty filter and a scope the registry refuses all land
    // here. Review must not continue unrestricted.
    throw new RunError(REVIEW_CODES.restrictRefused, 'the reviewer tool restriction was refused', {
      cause: diagnostic(error?.message ?? error),
    });
  }
  tools.guard((execution) => guardExecution(execution, usableSet, allowed, denials));

  // The model-facing surface. `restrict()` only filters the INHERITED surface,
  // so the visible set can still hold this agent's own registrations (a live
  // `subagent`), and no supported API removes another plugin's scope-local tool.
  // The Agent loop builds each request from `systemPrompt.assemble(...)`, whose
  // `tools` are the schemas the provider is sent, so this scoped transform is
  // what actually keeps those names out of the request. Registering it fails the
  // review closed if the context cannot hold a listener.
  let disposeAssembly;
  try {
    disposeAssembly = agentCtx.on('system-prompt/assemble', (assembly, context, next) => (
      filterAssembledTools(assembly, context, next, usableSet)
    ));
  } catch (error) {
    throw new RunError(
      REVIEW_CODES.assemblyUnavailable,
      'the reviewer agent could not register a system-prompt assembly transform',
      { cause: diagnostic(error?.message ?? error) },
    );
  }
  if (disposeAssembly === false) {
    throw new RunError(
      REVIEW_CODES.assemblyUnavailable,
      'the reviewer agent assembly transform was refused by the native context',
      {},
    );
  }

  // The proof. Reading the surface again is the only supported way to see what
  // the restriction actually left behind, and it happens before the prompt
  // exists. Names it could not remove are expected (a scope-local tool); they
  // are removed from the request by the transform above, and the transform
  // proves that per request. What remains checkable here is that the policy did
  // not remove or fail to apply something it promised.
  assertAdvertised(readInventory(tools, agent), usable, available);
  return undefined;
}

/**
 * Filter one model-facing prompt assembly down to the reviewer's tool set.
 *
 * The native contract of `system-prompt/assemble` is
 * `(assembly, context, next)` where the listener returns the assembly the model
 * will be sent, and `PromptAssembly` is `{ sections, contexts, tools, variables }`.
 * Only `tools` is replaced; every other field is passed through untouched, so
 * sections, contexts and variables stay exactly what the harness assembled.
 *
 * Fail-closed, before the request: a downstream value that is not an object, a
 * `tools` field that is not an array, a schema with no usable `name`, or a
 * provider that returns nothing all throw out of the waterfall. The Agent loop
 * propagates that instead of issuing a request, so the reviewer never runs with
 * tools this function could not account for.
 * @param {unknown} assembly - the assembly collected before the waterfall.
 * @param {unknown} context - the caller's assembly context (unused: the listener
 *   is registered on the reviewer's own scope, so it only sees this agent).
 * @param {unknown} next - the continuation returning the downstream assembly.
 * @param {ReadonlySet<string>} usable - the computed read-only set.
 * @returns {Promise<object>} the downstream assembly with only `tools` filtered.
 * @throws {RunError} with `REVIEW_ASSEMBLY_MISMATCH` when the assembly cannot be
 *   filtered or proven.
 */
async function filterAssembledTools(assembly, context, next, usable) {
  // Referenced so the listener signature mirrors the native one; the filter is
  // fixed per agent and never depends on the assembly's own context.
  void context;
  if (typeof next !== 'function') {
    throw new RunError(
      REVIEW_CODES.assemblyMismatch,
      'the reviewer assembly transform was called without a continuation, so its tools cannot be filtered',
      {},
    );
  }
  if (assembly === null || typeof assembly !== 'object' || !Array.isArray(assembly.tools)) {
    throw new RunError(
      REVIEW_CODES.assemblyMismatch,
      'the reviewer prompt assembly is missing its tools, so the request cannot be proven read-only',
      {},
    );
  }

  const downstream = await next();
  if (downstream === null || typeof downstream !== 'object' || Array.isArray(downstream)) {
    throw new RunError(
      REVIEW_CODES.assemblyMismatch,
      'the reviewer prompt assembly produced no downstream assembly to filter',
      {},
    );
  }
  const schemas = downstream.tools;
  if (!Array.isArray(schemas)) {
    throw new RunError(
      REVIEW_CODES.assemblyMismatch,
      'the assembled reviewer tools are not a list, so the request cannot be proven read-only',
      {},
    );
  }

  const kept = [];
  const observed = [];
  for (const schema of schemas) {
    const name = schema?.name;
    if (typeof name !== 'string' || name === '') {
      throw new RunError(
        REVIEW_CODES.assemblyMismatch,
        'an assembled reviewer tool has no name, so the request cannot be proven read-only',
        {},
      );
    }
    observed.push(name);
    if (usable.has(name)) kept.push(schema);
  }

  // The proof, on the exact list that will be sent. Dropping a name is the
  // transform's job, so the check is on what SURVIVES: every remaining schema
  // must be one the restriction installed, and the set of them must be exactly
  // the computed read-only set. A read-only name the assembly never carried
  // would mean the reviewer is missing evidence it is supposed to have, which is
  // also a refusal — an under-provisioned reviewer cannot certify anything.
  const survivors = kept.map((schema) => schema.name).sort();
  const expected = [...usable].sort();
  const escaped = survivors.filter((name) => !usable.has(name));
  const missing = expected.filter((name) => !observed.includes(name));
  if (escaped.length > 0 || missing.length > 0 || survivors.length !== expected.length) {
    throw new RunError(
      REVIEW_CODES.assemblyMismatch,
      'the reviewer prompt assembly does not carry exactly the read-only tool set, so no request is made',
      {
        // Bounded, fixed-shape evidence: only names the harness itself reported.
        escaped: escaped.slice(0, MAX_DENIALS).map((name) => redactText(name).slice(0, MAX_TOOL_CHARS)),
        missing: missing.slice(0, MAX_DENIALS),
        expected,
        observed: observed.slice(0, MAX_DENIALS).map((name) => redactText(name).slice(0, MAX_TOOL_CHARS)),
      },
    );
  }

  return { ...downstream, tools: kept };
}

/**
 * Read the tool names a scope currently advertises.
 *
 * The agent is the scope key: an agent's tools are mounted on its own scope
 * plane, so the unscoped (global) view would miss them.
 * @param {object} tools - the native tool registry.
 * @param {object} scope - the agent whose surface is read.
 * @returns {Set<string>} advertised tool names.
 * @throws {RunError} when the inventory cannot be read.
 */
function readInventory(tools, scope) {
  let inventory;
  try {
    inventory = tools.schemas(scope);
  } catch (error) {
    throw new RunError(REVIEW_CODES.inventoryUnavailable, 'the reviewer tool inventory could not be read', {
      cause: diagnostic(error?.message ?? error),
    });
  }
  return new Set(
    (Array.isArray(inventory) ? inventory : [])
      .map((schema) => schema?.name)
      .filter((name) => typeof name === 'string' && name !== ''),
  );
}

/**
 * Refuse a reviewer surface the restriction did not install as computed.
 *
 * What this check does NOT do any more: fail because the agent's own layer
 * still holds a name (the composing `subagent`). Native restrictions keep a
 * scope's own registrations, no supported API removes them, and the request
 * tools are decided by the `system-prompt/assemble` transform, which proves the
 * model-facing list on every request. Treating the surviving registration as a
 * failure therefore refused every review on a real deployment without making
 * the request any safer.
 *
 * What it still does, and must:
 *  - a read-only name the registry advertised in the pre-policy inventory but
 *    which is no longer visible afterwards means the restriction removed
 *    something it was supposed to keep — `surfaceMismatch`;
 *  - an advertised name that was never in the pre-policy inventory means the
 *    registry's evidence no longer describes what is visible, so the computed
 *    set cannot be trusted — `scopeUnenforceable`.
 * Neither is a reason to widen the policy, patch the registry, or prompt anyway.
 * @param {Set<string>} advertised - names the registry advertises after the policy.
 * @param {string[]} usable - the read-only names the policy installed.
 * @param {ReadonlySet<string>} [evidence] - the pre-policy inventory the set was
 *   computed from; defaults to `advertised` when the caller has none.
 * @returns {void}
 * @throws {RunError} when the surface is not exactly `usable`.
 */
function assertAdvertised(advertised, usable, evidence = advertised) {
  const missing = usable.filter((name) => !advertised.has(name));
  if (missing.length > 0) {
    throw new RunError(
      REVIEW_CODES.surfaceMismatch,
      'the reviewer tool restriction did not leave the read-only set advertised',
      { missing: missing.slice(0, MAX_DENIALS) },
    );
  }
  const usableSet = new Set(usable);
  const unknown = [...advertised].filter((name) => !usableSet.has(name) && !evidence.has(name)).sort();
  if (unknown.length > 0) {
    throw new RunError(
      REVIEW_CODES.scopeUnenforceable,
      'the reviewer agent advertises tools that were not in the inventory the read-only set was computed from',
      {
        // Bounded, fixed-shape evidence: only names the registry itself reported.
        unremovable: unknown.slice(0, MAX_DENIALS).map((name) => redactText(name).slice(0, MAX_TOOL_CHARS)),
        allowed: [...usable],
      },
    );
  }
}

/**
 * Build the deny-by-default execution guard.
 *
 * Only names on the computed read-only set may run. Mutation-shaped names are
 * denied explicitly as well, but the allow-list — not the name pattern — is the
 * mechanism.
 * @param {object} execution - the identity-protected tool call.
 * @param {ReadonlySet<string>} usable - names installed by the restriction.
 * @param {ReadonlySet<string>} allowed - the fixed read-only names.
 * @param {object[]} denials - this review's denial log.
 * @returns {string | undefined} a denial reason, or undefined to allow.
 */
function guardExecution(execution, usable, allowed, denials) {
  const name = execution?.name;
  if (typeof name !== 'string' || name === '') {
    recordDenial(denials, undefined, 'tool identity missing');
    return 'the additional review cannot run a tool with no identity';
  }
  if (!allowed.has(name) || !usable.has(name)) {
    recordDenial(denials, name, 'not on the read-only allow-list');
    return `the additional review is read-only; ${redactText(name).slice(0, MAX_TOOL_CHARS)} is not permitted`;
  }
  if (looksMutating(name)) {
    // Defence in depth: a read-only name that nevertheless reads as a mutation
    // is a composition bug, not something to allow.
    recordDenial(denials, name, 'mutation-shaped tool name');
    return `the additional review is read-only and cannot run ${redactText(name).slice(0, MAX_TOOL_CHARS)}`;
  }
  return undefined;
}

/**
 * Append one bounded, redacted denial to a review's log.
 *
 * The log is bounded rather than append-forever: a reviewer that calls denied
 * tools in a loop must not be able to grow durable history.
 * @param {object[]} denials - the record's denial list.
 * @param {string | undefined} name - raw tool name.
 * @param {string} reason - short, fixed reason.
 * @returns {void}
 */
function recordDenial(denials, name, reason) {
  if (!Array.isArray(denials) || denials.length >= MAX_DENIALS) return;
  const tool = typeof name === 'string' && name !== ''
    ? redactText(name).slice(0, MAX_TOOL_CHARS)
    : '(unnamed)';
  denials.push({ tool, reason: redactText(String(reason)).slice(0, MAX_REASON_CHARS) });
}

/**
 * Bounded, redacted detail text for a refused review.
 *
 * A refused restriction or surface mismatch is only actionable if the operator
 * can see WHICH names failed, so those detail fields are rendered. Every value is
 * a tool name the registry itself reported, is redacted, and is clamped.
 * @param {RunError} error - the thrown review error.
 * @returns {string|null} bounded detail, or null when the error carries none.
 */
function errorDetail(error) {
  const details = error?.details ?? {};
  const names = (value) => (Array.isArray(value) ? value : []).filter((entry) => typeof entry === 'string');
  const unremovable = names(details.unremovable);
  const escaped = names(details.escaped);
  const missing = names(details.missing);
  const absent = names(details.missingPackages);
  // A failed composition names the rows that kept it from mounting, so the
  // operator can fix the deployment instead of guessing.
  const unusable = names(details.unusable);
  const text = unremovable.length > 0
    ? `tools the read-only policy cannot remove: ${unremovable.join(', ')}`
    : escaped.length > 0
      ? `tools the model-facing assembly still carried: ${escaped.join(', ')}`
      : missing.length > 0
        ? `read-only tools missing from the advertised surface: ${missing.join(', ')}`
        : absent.length > 0
          ? `native packages the review composition needs are absent: ${absent.join(', ')}`
          : unusable.length > 0
            ? `unusable composition rows: ${unusable.join(', ')}`
            : typeof details.cause === 'string'
              ? details.cause
              : null;
  if (text === null || text === '') return null;
  return redactText(text).slice(0, MAX_ERROR_CHARS);
}

/**
 * Project a thrown review error into a review record.
 *
 * Three kinds of thrown value reach here, and each keeps its own code so an
 * operator can tell them apart: a `REVIEW_*` code is already review-shaped, a
 * `REVIEW_PRESET_*` code names a composition failure, and anything else is a run
 * error mapped onto its review meaning.
 * @param {unknown} error - the thrown value.
 * @param {object} selection - review selection.
 * @param {object[]} denials - collected denials.
 * @returns {object} review record.
 */
function failureRecord(error, selection, denials) {
  const base = { verdict: null, text: '', selection: summarizeSelection(selection), denials };
  if (error instanceof RunError) {
    const code = typeof error.code === 'string' ? error.code : '';
    if (code.startsWith('REVIEW_PRESET_')) {
      // A distinct, non-tool code: the review could not be COMPOSED, which is a
      // different failure from a composition that was composed and refused.
      return {
        state: REVIEW_STATES.failed,
        error: {
          code: REVIEW_CODES.presetPrepareFailed,
          reason: code,
          message: redactText(String(error.message ?? '')).slice(0, MAX_ERROR_CHARS),
          detail: errorDetail(error),
        },
        ...base,
      };
    }
    if (code.startsWith('REVIEW_')) {
      return {
        state: REVIEW_STATES.failed,
        error: {
          code,
          message: redactText(String(error.message ?? '')).slice(0, MAX_ERROR_CHARS),
          detail: errorDetail(error),
        },
        ...base,
      };
    }
    const mapped = RUN_TO_REVIEW.get(code) ?? REVIEW_CODES.failed;
    return {
      state: REVIEW_STATES.failed,
      error: {
        code: mapped,
        // Preserve the original code so a refusal that came from the RUN layer
        // (for example a preset the review does not own) is still traceable.
        ...(mapped === REVIEW_CODES.presetPrepareFailed ? { reason: code } : {}),
        message: redactText(String(error.message ?? 'the additional review could not complete')).slice(0, MAX_ERROR_CHARS),
        detail: errorDetail(error),
      },
      ...base,
    };
  }
  return {
    state: REVIEW_STATES.failed,
    error: {
      code: REVIEW_CODES.failed,
      message: 'the additional review could not complete',
      detail: diagnostic(error?.message ?? error, MAX_ERROR_CHARS),
    },
    ...base,
  };
}

/** Run error codes that have a distinct review meaning. */
const RUN_TO_REVIEW = new Map([
  ['RUN_AGENTS_UNAVAILABLE', REVIEW_CODES.agentsUnavailable],
  ['RUN_AGENT_PRESETS_UNAVAILABLE', REVIEW_CODES.presetsUnavailable],
  ['RUN_PROMPT_TOO_LARGE', REVIEW_CODES.promptTooLarge],
  // A review never names a preset it does not own; if that invariant is ever
  // broken the run is refused and reported as a composition failure.
  ['RUN_PRESET_NOT_OWNED', REVIEW_CODES.presetPrepareFailed],
  ['RUN_PRESET_MOUNT_FAILED', REVIEW_CODES.presetPrepareFailed],
]);

/**
 * Build a failed review record for a precondition refusal.
 * @param {string} code - review error code.
 * @param {string} message - bounded explanation.
 * @param {object} selection - review selection.
 * @param {object[]} denials - collected denials.
 * @returns {object} review record.
 */
function failed(code, message, selection, denials) {
  return {
    state: REVIEW_STATES.failed,
    error: { code, message },
    verdict: null,
    text: '',
    selection: summarizeSelection(selection),
    denials,
  };
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
  return {
    verdict,
    reason: reasonMatch === null ? null : redactText(reasonMatch[1].trim()).slice(0, 400),
  };
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
