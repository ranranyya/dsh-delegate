// MCP server: the bounded external surface.
//
// Design rule taken from SPEC §10–11: an external MCP client may *exercise* an
// authorization the operator already created, and may do nothing else. So this
// server exposes exactly four tools and maps each one onto one execution-plane
// route:
//
//   delegate_status  → GET  /dsh-delegate/x/status
//   delegate_submit  → POST /dsh-delegate/x/tasks
//   delegate_result  → POST /dsh-delegate/x/tasks/get
//   delegate_cancel  → POST /dsh-delegate/x/tasks/cancel
//
// There is no tool that issues a connection, issues or widens a grant, changes
// settings, or touches a credential. That is not an omission to be filled in
// later: those actions live on the authenticated user plane, which is reachable
// only from the operator's own browser session. A model driving this server
// therefore cannot authorize itself, which is the property that makes exposing
// delegation to a model defensible at all.
//
// The connection token is read from the environment and is never placed in a
// tool result, an error, or a log line. Every answer is bounded and is the
// server's own already-redacted projection; this process adds no data of its own.
//
// The protocol is implemented directly rather than through
// `@modelcontextprotocol/server`, which is not installed in this environment (only
// `@modelcontextprotocol/client` and `@modelcontextprotocol/core` are). What that
// costs is stated in the README: this server speaks the `initialize` handshake and
// the tools capability only, and it is not a general-purpose MCP SDK.

// Only `diagnostic` is needed here, and it is imported from the redaction module
// rather than from `runtime/agent-runner.js`. That distinction is load-bearing:
// the agent runner statically imports `@deepseek-ai/dsh-llm` and
// `@deepseek-ai/dsh-agent`, which only a running DSH installation provides. This
// executable is spawned by an arbitrary MCP host, so reaching through the runner
// made it fail at link time with `ERR_MODULE_NOT_FOUND` before it could report
// anything at all.
import { diagnostic, redactText } from '../config/redact.js';

/** Protocol revisions this server can speak, newest first (as the SDK lists them). */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** The revision answered when a client asks for one this server does not know. */
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Identifies this server in the handshake. */
export const SERVER_INFO = Object.freeze({ name: 'dsh-delegate', version: '0.1.5' });

/** Bound on a tool result's text. A task view can be large; a model's context cannot. */
export const MAX_TOOL_TEXT_CHARS = 20_000;

/** Bound on one execution-plane request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** JSON-RPC error codes used here (the standard set, not invented ones). */
export const RPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
});

/**
 * A refusal this server produced itself. Distinct from a transport failure so a
 * caller can tell "the harness said no" from "the harness could not be reached".
 */
export class McpError extends Error {
  /**
   * @param {string} code - stable machine code, surfaced to the client as text.
   * @param {string} message - explanation, already free of secrets.
   * @param {object} [options] - `rpcCode` for a protocol-level refusal.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.rpcCode = options.rpcCode ?? null;
  }
}

/**
 * Tool catalog.
 *
 * `inputSchema` is deliberately closed (`additionalProperties: false`): a model
 * that invents a field gets a clear protocol error instead of a silently ignored
 * argument, and no tool can grow an undeclared parameter by accident.
 */
export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'delegate_status',
    title: 'Delegation status',
    description: 'Report whether delegation is enabled in DSH for this local MCP connection.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_submit',
    title: 'Submit delegated task',
    description: 'Submit one prompt to run as a delegated task while the DSH delegation switch is enabled. '
      + 'Returns the task identity and state; '
      + 'it does not wait for the work to finish and it is not host approval.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Absolute path of the authorized workspace.' },
        prompt: { type: 'string', description: 'The task to perform.' },
        overrides: {
          type: 'object',
          description: 'Optional per-task overrides (model/effort/timeout). Validated by the harness.',
          additionalProperties: true,
        },
      },
      required: ['workspacePath', 'prompt'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_result',
    title: 'Read task result',
    description: 'Read one task this connection submitted: state, effective provider/model/effort, '
      + 'changed-file summary, bounded diff, validation evidence and review outcome. '
      + 'A finished execution is not host acceptance.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_cancel',
    title: 'Cancel task',
    description: 'Ask the harness to stop one task this connection submitted, and return its state afterwards.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    }),
  }),
]);

/** Tool name → the execution-plane call it makes. */
const TOOL_ROUTES = Object.freeze({
  delegate_status: 'status',
  delegate_submit: 'submit',
  delegate_result: 'result',
  delegate_cancel: 'cancel',
});

/**
 * Validate one tool's arguments against its own schema.
 *
 * Written by hand rather than pulled from a schema validator because the shapes
 * here are four small objects; a validator dependency would be the largest thing
 * in this file for no extra safety.
 * @param {object} tool - definition from {@link TOOLS}.
 * @param {unknown} args - caller-supplied arguments.
 * @returns {object} the arguments to forward.
 */
function validateArgs(tool, args) {
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new McpError('MCP_ARGUMENTS_INVALID', `${tool.name} expects an object of arguments`);
  }
  const allowed = Object.keys(tool.inputSchema.properties ?? {});
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      // An undeclared argument is a caller bug or an attempt to reach a parameter
      // this surface does not have. Both are refused, and the message names the
      // field so the caller can fix it.
      throw new McpError('MCP_ARGUMENT_UNKNOWN', `${tool.name} does not accept argument ${JSON.stringify(key)}`);
    }
  }
  for (const key of tool.inputSchema.required ?? []) {
    const field = value[key];
    if (typeof field !== 'string' || field.trim() === '') {
      throw new McpError('MCP_ARGUMENT_REQUIRED', `${tool.name} requires a non-empty ${key}`);
    }
  }
  const out = {};
  for (const key of allowed) {
    if (!(key in value)) continue;
    const declared = tool.inputSchema.properties[key];
    const field = value[key];
    if (declared.type === 'string') {
      if (typeof field !== 'string') throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be a string`);
      out[key] = field;
    } else if (declared.type === 'object') {
      if (field === null || typeof field !== 'object' || Array.isArray(field)) {
        throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be an object`);
      }
      out[key] = field;
    } else {
      out[key] = field;
    }
    if (Array.isArray(declared.enum) && !declared.enum.includes(out[key])) {
      throw new McpError('MCP_ARGUMENT_ENUM', `${tool.name}.${key} must be one of ${declared.enum.join(', ')}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bounded projection
// ---------------------------------------------------------------------------
//
// A tool result is consumed by `JSON.parse`, not by a human reading a wall of
// text. The previous implementation enforced the bound by slicing the raw
// serialized JSON and appending a plain note, which produced text that began as
// JSON and ended as prose: every `delegate_result` over the bound was unparsable,
// and a coordinator whose audit diff was large enough to cross it saw
// `JSON.parse` fail and had to abandon the delegation. An unparsable answer is
// worse than a smaller answer, so the bound is now enforced *before*
// serialization, on the structure itself.
//
// The projection is deliberately field-aware rather than generic. A truncated
// result must still let a caller act, so identity, state, phase, routing,
// refusal and acceptance status are always kept intact; heavy evidence
// (diff/evidence/prompt) is trimmed to a headline first, and bounded prose
// (execution and review text) second. Everything that was cut is listed by path
// under a top-level `truncation` object, so "this list is short" is never
// mistaken for "this list was short".
//
// If even that cannot fit — a single critical field too large to serialize — the
// result is not labelled full and is not silently returned: it becomes an
// explicit `MCP_RESULT_OVER_BUDGET` tool error that still carries the task
// identity, so a caller can tell "the content did not fit" from "no such task".

/** Fields trimmed first: evidence whose size is the caller's, not the answer's. */
const HEAVY_FIELDS = Object.freeze(['diff', 'evidence', 'prompt']);

/**
 * Field-level caps that survive into a truncated answer. Each is a *ceiling*, not
 * a target: a projection over the overall bound is shrunk further, in the order
 * named above, until it fits.
 */
const TRUNCATED_FIELD_CAPS = Object.freeze({
  /** Diff patch text kept when the whole result does not fit (0 = headline only). */
  diffPatchChars: 0,
  /** Captured validation evidence kept per entry and overall. */
  evidenceEntryChars: 160,
  evidenceChars: 800,
  evidenceEntries: 8,
  /** The submitted prompt is never quoted in a truncated answer. */
  promptChars: 0,
  /** Bounded execution prose. */
  executionTextChars: 1_200,
  /** Bounded review prose. */
  reviewTextChars: 1_200,
  /** Per-entry cap for a list that is itself being cut (tasks, files, changes). */
  listItemChars: 2_000,
});

/** How deep the projection descends before it states a depth limit. */
const MAX_PROJECTION_DEPTH = 10;
const DEPTH_LIMIT_MARKER = '[depth limit: nested value not projected]';

/**
 * Whether a value can be serialized at all.
 *
 * `JSON.stringify` throws on a bigint and on a cycle, and silently turns a
 * function into nothing. All three would make the projected answer describe
 * something other than what was received, so they are checked up front and are
 * what `MCP_RESULT_UNSERIALIZABLE` reports.
 * @param {unknown} value - value to test.
 * @returns {boolean} true when the value round-trips through JSON.
 */
function isJsonProjectable(value) {
  const stack = new Set();
  const walk = (node) => {
    if (node === null) return true;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return true;
    if (type === 'number') return Number.isFinite(node);
    if (type === 'bigint' || type === 'function' || type === 'symbol' || type === 'undefined') return false;
    if (type !== 'object') return false;
    if (stack.has(node)) return false;
    stack.add(node);
    const values = Array.isArray(node) ? node : Object.values(node);
    const ok = values.every(walk);
    stack.delete(node);
    return ok;
  };
  return walk(value);
}

/**
 * Serialize once, at one indentation. JSON's escaping rules do not depend on
 * indentation, so a length measured compact is a valid upper bound for the same
 * value measured pretty, and {@link fitsBound} accepts either encoding.
 * @param {unknown} value - JSON value.
 * @returns {string} compact JSON text.
 */
function compactJson(value) {
  return JSON.stringify(value);
}

/**
 * Whether a projected value fits the tool-text bound in either encoding.
 *
 * The bound must hold for *both* the compact and the two-space encoding because
 * the published answer alone is not the whole JSON a client parses: a client that
 * re-serializes it, or a host that pretty-prints the envelope, must not be able to
 * push past {@link MAX_TOOL_TEXT_CHARS}.
 * @param {unknown} value - projected JSON value.
 * @returns {boolean} true when the value fits.
 */
function fitsBound(value) {
  const compact = compactJson(value);
  if (compact.length > MAX_TOOL_TEXT_CHARS) return false;
  return JSON.stringify(value, null, 2).length <= MAX_TOOL_TEXT_CHARS;
}

/**
 * Explain what was cut out of a container, in the index space of the returned
 * list, so a reader is never left inferring that the short list was all there was.
 * @param {string} path - JSON path of the container.
 * @param {object} options - `total`, `omitted` (count), `detail` (extra note).
 * @returns {object} truncation record.
 */
function truncationRecord(path, options) {
  const record = { path, field: 'list', omitted: options.omitted };
  if (options.total !== undefined) record.total = options.total;
  if (typeof options.detail === 'string') record.detail = options.detail;
  return record;
}

/**
 * Trim one string to a cap, stating the trim.
 * @param {string} text - source text.
 * @param {number} cap - characters to keep.
 * @param {string} path - JSON path, for the truncation record.
 * @param {object[]} out - records collected so far.
 * @returns {string} kept text (possibly empty).
 */
function boundedText(text, cap, path, out) {
  if (text.length <= cap) return text;
  out.push({ path, field: 'text', keptChars: cap, omittedChars: text.length - cap });
  return text.slice(0, cap);
}

/**
 * Recursively trim every string in a value to one cap, stating each cut.
 *
 * Used only by the terminal projection stage, where the answer is already
 * skeletonized and this catches whatever prose is left (a path list, a refusal
 * message). It is a safety net, not the primary strategy: field-aware trimming
 * above keeps the actionable parts intact, and this runs after them.
 * @param {unknown} value - value to trim.
 * @param {string} path - JSON path.
 * @param {number} cap - characters to keep per string.
 * @param {object[]} collect - truncation records.
 * @param {number} [depth] - recursion depth.
 * @returns {unknown} trimmed value.
 */
function trimAllStrings(value, path, cap, collect, depth = 0) {
  if (typeof value === 'string') return boundedText(value, cap, path, collect);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_PROJECTION_DEPTH) {
    collect.push({ path, field: 'value', detail: DEPTH_LIMIT_MARKER });
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => trimAllStrings(entry, `${path}[${index}]`, cap, collect, depth + 1));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    out[key] = trimAllStrings(item, childPath, cap, collect, depth + 1);
  }
  return out;
}

/**
 * Replace one heavy field with a bounded summary that keeps its shape.
 * @param {unknown} source - field value.
 * @param {string} path - JSON path.
 * @param {object[]} collect - truncation records.
 * @returns {unknown} bounded replacement.
 */
function reduceHeavy(source, path, collect) {
  if (source === null || source === undefined) return source;
  if (typeof source === 'string') {
    return boundedText(source, 0, path, collect);
  }
  if (typeof source !== 'object') return source;
  if (Array.isArray(source)) {
    const keep = Math.min(source.length, TRUNCATED_FIELD_CAPS.evidenceEntries);
    if (source.length > keep) collect.push(truncationRecord(path, { total: source.length, omitted: source.length - keep }));
    return source.slice(0, keep).map((entry, index) => {
      if (typeof entry === 'string') {
        return boundedText(entry, TRUNCATED_FIELD_CAPS.evidenceEntryChars, `${path}[${index}]`, collect);
      }
      return entry;
    });
  }
  const out = {};
  // Recorded rather than assigned in the loop: `patchTruncated` normally precedes
  // `patchText` in the source object, so an assignment made while visiting
  // `patchText` would be overwritten by the original `false` a moment later.
  let patchCut = false;
  for (const [key, value] of Object.entries(source)) {
    const childPath = `${path}.${key}`;
    if (typeof value === 'string') {
      const cap = key === 'patchText' ? TRUNCATED_FIELD_CAPS.diffPatchChars : TRUNCATED_FIELD_CAPS.evidenceEntryChars;
      out[key] = boundedText(value, cap, childPath, collect);
      if (key === 'patchText' && value.length > cap) patchCut = true;
      continue;
    }
    if (Array.isArray(value)) {
      const keep = Math.min(value.length, TRUNCATED_FIELD_CAPS.evidenceEntries);
      if (value.length > keep) collect.push(truncationRecord(childPath, { total: value.length, omitted: value.length - keep }));
      out[key] = value.slice(0, keep).map((entry, index) => (typeof entry === 'string'
        ? boundedText(entry, TRUNCATED_FIELD_CAPS.evidenceEntryChars, `${childPath}[${index}]`, collect)
        : entry));
      continue;
    }
    out[key] = value;
  }
  // Only ever turns the flag on: the engine's own `patchTruncated` (a patch it had
  // already cut) must not be cleared by this projection.
  if (patchCut) out.patchTruncated = true;
  return out;
}

/**
 * Copy a value without losing JSON-compatible structure.
 * @param {unknown} value - JSON value.
 * @returns {unknown} independent copy.
 */
function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Paths of the task-shaped objects inside one answer, keyed by identity.
 * @param {object} value - answer.
 * @returns {Map<object, string>} object → JSON path.
 */
function pathsFor(value) {
  const map = new Map();
  if (value?.task !== null && typeof value?.task === 'object' && !Array.isArray(value.task)) map.set(value.task, 'task.');
  if (Array.isArray(value?.tasks)) {
    for (let index = 0; index < value.tasks.length; index += 1) {
      const task = value.tasks[index];
      if (task !== null && typeof task === 'object' && !Array.isArray(task)) map.set(task, `tasks[${index}].`);
    }
  }
  return map;
}

/**
 * Trim the projected answer until it fits the bound, in a fixed order that
 * sacrifices the least actionable content last.
 *
 * Every stage keeps the task identity, state, phase, routing, refusal and
 * acceptance fields; they differ only in how much evidence and prose survives.
 * The first stage drops the patch text and the whole prompt (their file lists and
 * counts remain); later stages shorten execution and review prose, then cap list
 * lengths, and the last stage skeletonizes the task down to those critical fields
 * with a short per-string cap. Every cut is stated in `truncation.fields`.
 * @param {object} value - answer.
 * @param {{executionText: number, reviewText: number, lists: number, skeletonChars?: number}} stage - caps.
 * @param {object[]} collect - truncation records.
 * @returns {unknown} projected answer.
 */
function projectWithStage(value, stage, collect) {
  const projected = structuredCloneSafe(value);
  const targets = pathsFor(projected);
  for (const [target, prefix] of targets) {
    for (const key of HEAVY_FIELDS) {
      if (!(key in target)) continue;
      target[key] = reduceHeavy(target[key], `${prefix}${key}`, collect);
    }
    if (target.execution !== null && typeof target.execution === 'object' && typeof target.execution.text === 'string') {
      target.execution.text = boundedText(
        target.execution.text, stage.executionText, `${prefix}execution.text`, collect,
      );
    }
    if (target.review !== null && typeof target.review === 'object' && typeof target.review.text === 'string') {
      target.review.text = boundedText(target.review.text, stage.reviewText, `${prefix}review.text`, collect);
    }
    if (typeof target.reviewRouteError === 'string') {
      target.reviewRouteError = boundedText(target.reviewRouteError, stage.skeletonChars ?? 400, `${prefix}reviewRouteError`, collect);
    }
  }
  if (Array.isArray(projected.tasks) && projected.tasks.length > stage.lists) {
    collect.push(truncationRecord('tasks', { total: projected.tasks.length, omitted: projected.tasks.length - stage.lists }));
    projected.tasks = projected.tasks.slice(0, stage.lists);
  }
  if (stage.skeletonChars !== undefined) {
    const cap = stage.skeletonChars;
    if (projected.task !== undefined) projected.task = skeletonize(projected.task, 'task', cap, collect);
    if (Array.isArray(projected.tasks)) {
      projected.tasks = projected.tasks.map((task, index) => skeletonize(task, `tasks[${index}]`, cap, collect));
    }
    // Anything else at the top level (a status answer's grants, a list's extras)
    // is trimmed rather than dropped, so nothing disappears unexplained.
    for (const [key, item] of Object.entries(projected)) {
      if (key === 'task' || key === 'tasks' || key === 'ok') continue;
      projected[key] = trimAllStrings(item, key, cap, collect);
    }
  }
  return projected;
}

/**
 * The identity, state, routing, refusal and acceptance block that is never
 * dropped, renderable even when nothing else fits.
 * @param {object} task - task view.
 * @param {string} path - JSON path prefix.
 * @param {number} cap - per-string cap.
 * @param {object[]} collect - truncation records.
 * @returns {object} skeleton.
 */
function skeletonize(task, path, cap, collect) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return task ?? null;
  const pick = (key) => (key in task ? boundValue(task[key], `${path}.${key}`, cap, collect) : undefined);
  const out = {};
  for (const key of ['taskId', 'state', 'phase', 'route', 'reviewRoute', 'reviewRouteError', 'execution', 'error',
    'hostAcceptance', 'selfApproved', 'cancelledBy', 'createdAt', 'endedAt']) {
    const value = pick(key);
    if (value === undefined) continue;
    if (key === 'execution' && value !== null && typeof value === 'object') {
      out.execution = {};
      for (const field of ['outcome', 'reasoningOnly', 'usage', 'turnEnd', 'agentId', 'cancelCause', 'error']) {
        if (field in value) out.execution[field] = boundValue(value[field], `${path}.execution.${field}`, cap, collect);
      }
    } else if (key === 'route' || key === 'reviewRoute') {
      out[key] = value === null ? null : boundValue(value, `${path}.${key}`, cap, collect);
    } else {
      out[key] = value;
    }
  }
  out.truncation = { path, field: 'result', detail: 'only identity, state, routing, refusal and acceptance fields are shown' };
  collect.push(out.truncation);
  return out;
}

/**
 * Bound a leaf value for a skeleton.
 * @param {unknown} value - value.
 * @param {string} path - JSON path.
 * @param {number} cap - per-string cap.
 * @param {object[]} collect - records.
 * @returns {unknown} bounded value.
 */
function boundValue(value, path, cap, collect) {
  if (typeof value === 'string') return boundedText(value, cap, path, collect);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((entry, index) => boundValue(entry, `${path}[${index}]`, cap, collect));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = boundValue(item, `${path}.${key}`, cap, collect);
  }
  return out;
}

/**
 * Build a structurally bounded, still-valid JSON answer.
 *
 * `ok` keeps its meaning: the payload is either the real answer or an explicit
 * failure object. A result that cannot be projected writes itself is never
 * returned as if it were complete, and never returned as truncated raw text.
 *
 * `isError` is true only when the answer could not be delivered at all
 * (`MCP_RESULT_UNSERIALIZABLE`, `MCP_RESULT_OVER_BUDGET`). A structurally trimmed
 * answer is *not* an error: it is a real answer with an explicit, machine-readable
 * `truncation` block, which lets a caller act on the parts that survived. The
 * distinction matters because a truncated result must never be presented as a
 * failure when the task itself succeeded.
 * @param {unknown} value - JSON-serializable answer.
 * @returns {{ text: string, isError: boolean }} bounded, valid JSON text.
 */
function boundedJson(value) {
  if (!isJsonProjectable(value)) {
    return refuseResult('MCP_RESULT_UNSERIALIZABLE', 'the delegated call answered with a value that cannot be represented as JSON');
  }
  let compact;
  try {
    compact = compactJson(value);
  } catch {
    return refuseResult('MCP_RESULT_UNSERIALIZABLE', 'the delegated call answered with a value that could not be serialized');
  }
  if (fitsBound(value)) return { text: JSON.stringify(redactDeepStrings(value), null, 2), isError: false };

  const stages = [
    { executionText: TRUNCATED_FIELD_CAPS.executionTextChars, reviewText: TRUNCATED_FIELD_CAPS.reviewTextChars, lists: 50 },
    { executionText: 400, reviewText: 400, lists: 20 },
    { executionText: 200, reviewText: 200, lists: 5 },
    { executionText: 120, reviewText: 120, lists: 1 },
    { executionText: 80, reviewText: 80, lists: 1, skeletonChars: 240 },
    { executionText: 40, reviewText: 40, lists: 1, skeletonChars: 96 },
  ];
  const apply = (stage) => {
    const records = [];
    const projected = projectWithStage(value, stage, records);
    projected.truncation = {
      truncated: true,
      reason: 'the full answer exceeded the tool-text bound',
      fullTextChars: compact.length,
      boundChars: MAX_TOOL_TEXT_CHARS,
      // Stated so a caller can tell a structurally trimmed answer from a short
      // one, and so "bounded" is never read as "complete".
      fullResultIncluded: false,
      fields: dedupeRecords(records),
    };
    return JSON.stringify(redactDeepStrings(projected), null, 2);
  };
  for (const stage of stages) {
    const text = apply(stage);
    if (text.length <= MAX_TOOL_TEXT_CHARS) return { text, isError: false };
  }

  // Nothing projected fits. The answer is refused as data, carrying the task
  // identity when it can: the caller learns which task the content belonged to
  // and why the result was not delivered, instead of receiving a cut fragment
  // that looks like an answer.
  const identity = {};
  if (value?.task !== null && typeof value?.task === 'object' && !Array.isArray(value.task)) {
    if (value.task.taskId !== undefined) identity.taskId = truncateScalar(value.task.taskId);
    if (value.task.state !== undefined) identity.state = truncateScalar(value.task.state);
  }
  if (Array.isArray(value?.tasks)) {
    identity.tasks = value.tasks.slice(0, 5).map((task) => ({ taskId: truncateScalar(task?.taskId) }));
  }
  return refuseResult(
    'MCP_RESULT_OVER_BUDGET',
    'the critical fields alone exceed the tool-text bound, so no usable projection could be produced',
    { ...identity, fullTextChars: compact.length, boundChars: MAX_TOOL_TEXT_CHARS },
  );
}

/**
 * Run every string in a value through {@link redactText}.
 *
 * This server is the last hop before a model reads the answer, so it does not
 * rely solely on the plane having redacted first: a task view is assembled from
 * many sources (model prose, diff text, captured evidence), and one unredacted
 * string reaching a model is the failure this guard exists to prevent. Key-based
 * masking is not repeated here — the plane already masks secret-named fields, and
 * re-masking a field this module only forwards would change a value it did not
 * read.
 * @param {unknown} value - JSON value.
 * @param {number} [depth] - recursion depth guard.
 * @returns {unknown} copy with credential-shaped substrings masked.
 */
function redactDeepStrings(value, depth = 0) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object' || depth > MAX_PROJECTION_DEPTH) return value;
  if (Array.isArray(value)) return value.map((entry) => redactDeepStrings(entry, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactDeepStrings(item, depth + 1);
  return out;
}

/**
 * An answer this server could not deliver, as valid bounded JSON.
 * @param {string} code - stable failure code.
 * @param {string} message - explanation.
 * @param {object} [extra] - additional fields merged into the error object.
 * @returns {{ text: string, isError: true }} refusal payload.
 */
function refuseResult(code, message, extra = {}) {
  const text = JSON.stringify(redactDeepStrings({
    ok: false,
    error: { code, message, ...extra },
    truncation: { truncated: true, fullResultIncluded: false },
  }), null, 2);
  if (text.length <= MAX_TOOL_TEXT_CHARS) return { text, isError: true };
  // The refusal itself is larger than the bound, which only happens if the bound
  // is configured absurdly small. This minimal form is still valid JSON and still
  // says the answer was refused rather than delivered.
  return {
    text: JSON.stringify({ ok: false, error: { code, truncated: true }, truncation: { truncated: true, fullResultIncluded: false } }, null, 2),
    isError: true,
  };
}

/**
 * Keep a scalar leaf small enough to always serialize.
 * @param {unknown} value - scalar.
 * @returns {unknown} value or its first 200 characters.
 */
function truncateScalar(value) {
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return null;
}

/**
 * Remove duplicate truncation records for the same path and field.
 * @param {object[]} records - collected records.
 * @returns {object[]} deduplicated records.
 */
function dedupeRecords(records) {
  const seen = new Map();
  for (const record of records) {
    const key = `${record.path}\u0000${record.field}`;
    if (!seen.has(key)) seen.set(key, record);
  }
  return [...seen.values()].slice(0, 64);
}

/**
 * Create the MCP request handler.
 *
 * `callExecution` is injected so this module holds no transport knowledge and can
 * be tested without a socket: it receives `(route, payload)` and resolves to the
 * execution plane's parsed `ok:true` body, throwing on any refusal.
 * @param {object} options - `callExecution`, optional `logger`.
 * @returns {{ handle: (message: unknown) => Promise<object | null>, tools: readonly object[], calls: object[] }} server.
 */
export function createMcpServer(options) {
  if (typeof options?.callExecution !== 'function') {
    throw new TypeError('createMcpServer needs a callExecution function');
  }
  const callExecution = options.callExecution;
  const logger = options.logger ?? null;
  // Records what was asked for, so a test can prove which plane route a tool
  // reached instead of trusting the tool result.
  const calls = [];
  let initialized = false;

  /**
   * Run one tool call and wrap the answer as MCP content.
   * @param {string} name - tool name.
   * @param {unknown} args - arguments.
   * @returns {Promise<object>} `{ content, isError? }`.
   */
  async function callTool(name, args) {
    const route = TOOL_ROUTES[name];
    if (route === undefined) {
      throw new McpError('MCP_TOOL_UNKNOWN', `no tool named ${JSON.stringify(name)}`, {
        rpcCode: RPC_ERRORS.invalidParams,
      });
    }
    const tool = TOOLS.find((entry) => entry.name === name);
    let payload;
    try {
      payload = validateArgs(tool, args);
    } catch (error) {
      // A malformed argument is a *tool* error, not a protocol error: the client's
      // session is healthy, the call was wrong, and `isError` is how MCP says so.
      // The code and field name go back so a model can correct itself.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_ARGUMENTS_INVALID';
      return {
        content: [{ type: 'text', text: boundedJson({ ok: false, error: { code, message: error?.message ?? 'invalid arguments' } }).text }],
        isError: true,
      };
    }
    calls.push({ tool: name, route, payload });
    try {
      const result = await callExecution(route, payload);
      const bounded = boundedJson(result);
      // A structurally trimmed answer is a real answer, so `isError` stays unset;
      // only an answer that could not be delivered at all is reported as an error.
      return bounded.isError
        ? { content: [{ type: 'text', text: bounded.text }], isError: true }
        : { content: [{ type: 'text', text: bounded.text }] };
    } catch (error) {
      // A refusal is a tool-level error, not a protocol error: the client must see
      // the harness's stable code so it can act on it, and `isError` tells it the
      // call failed without tearing down the session.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_CALL_FAILED';
      const message = diagnostic(error?.message ?? String(error), 400) ?? 'the delegated call was refused';
      logger?.warn?.('dsh-delegate-mcp: call refused', code);
      return {
        content: [{ type: 'text', text: boundedJson({ ok: false, error: { code, message } }).text }],
        isError: true,
      };
    }
  }

  /**
   * Answer one JSON-RPC message.
   *
   * Returns `null` for a notification (the protocol forbids a response) so the
   * transport writes nothing.
   * @param {unknown} message - parsed JSON-RPC message.
   * @returns {Promise<object | null>} response, or null.
   */
  async function handle(message) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, RPC_ERRORS.invalidRequest, 'a JSON-RPC message must be an object');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;
    if (typeof method !== 'string' || method === '') {
      // A message with no method is a response to something this server never
      // asked; it is not an error the client must see.
      return isNotification ? null : errorResponse(id, RPC_ERRORS.invalidRequest, 'a JSON-RPC message needs a method');
    }

    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
          initialized = true;
          return result(id, {
            protocolVersion: version,
            // Only what this server actually implements. Advertising `resources`
            // or `prompts` would invite calls that must then fail.
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: 'Delegated coding on the DSH host. Submission is allowed only while the operator '
              + 'has enabled the delegation switch in the authenticated DSH settings page.',
          });
        }
        case 'notifications/initialized':
          return null;
        case 'ping':
          return result(id, {});
        case 'tools/list': {
          if (!initialized) return errorResponse(id, RPC_ERRORS.invalidRequest, 'initialize must be sent before tools/list');
          // The JSON Schema objects are shared and never mutated, so the catalog is
          // returned by reference; a client cannot corrupt it because it only reads.
          return result(id, { tools: TOOLS.map((tool) => ({ ...tool })) });
        }
        case 'tools/call': {
          if (!initialized) return errorResponse(id, RPC_ERRORS.invalidRequest, 'initialize must be sent before tools/call');
          const name = params?.name;
          if (typeof name !== 'string' || name === '') {
            return errorResponse(id, RPC_ERRORS.invalidParams, 'tools/call requires a tool name');
          }
          return result(id, await callTool(name, params?.arguments));
        }
        default:
          return errorResponse(id, RPC_ERRORS.methodNotFound, `this server does not implement ${JSON.stringify(method)}`);
      }
    } catch (error) {
      if (error instanceof McpError && error.rpcCode !== null) {
        return errorResponse(id, error.rpcCode, error.message);
      }
      // An unexpected failure is reported with its code only: a stack or a
      // message may quote configuration this server must not disclose.
      const code = typeof error?.code === 'string' ? error.code : 'MCP_INTERNAL';
      return errorResponse(id, RPC_ERRORS.internal, `the delegation server failed (${code})`);
    }
  }

  return { handle, tools: TOOLS, calls, isInitialized: () => initialized };
}

/**
 * Build a JSON-RPC success response.
 * @param {unknown} id - request id.
 * @param {unknown} value - result.
 * @returns {object} response envelope.
 */
function result(id, value) {
  return { jsonrpc: '2.0', id: id ?? null, result: value };
}

/**
 * Build a JSON-RPC error response.
 * @param {unknown} id - request id.
 * @param {number} code - JSON-RPC error code.
 * @param {string} message - explanation.
 * @returns {object} response envelope.
 */
function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Run the newline-delimited JSON-RPC loop over a pair of streams.
 *
 * MCP's stdio transport is one JSON-RPC message per line: there is no
 * `Content-Length` framing here, and adding it would break the client. Malformed
 * input produces a parse error and the loop continues, because a single bad line
 * must not end a session the model is still using.
 * @param {object} options - `input`, `output` streams, `server`, optional `onError`.
 * @returns {Promise<void>} resolves when the input stream ends.
 */
export async function serveStdio(options) {
  const { input, output, server } = options;
  const onError = options.onError ?? (() => {});

  /**
   * Write exactly one line and wait for the stream to drain.
   * @param {object} payload - JSON-RPC message.
   * @returns {Promise<void>} resolves after the write flushed.
   */
  const write = (payload) => new Promise((resolvePromise) => {
    const line = `${JSON.stringify(payload)}\n`;
    if (output.write(line) === false) output.once('drain', resolvePromise);
    else resolvePromise();
  });

  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        await write(errorResponse(null, RPC_ERRORS.parse, 'the message is not valid JSON'));
        continue;
      }
      let response = null;
      try {
        response = await server.handle(message);
      } catch (error) {
        onError(error);
        response = errorResponse(message?.id ?? null, RPC_ERRORS.internal, 'the request could not be handled');
      }
      if (response !== null) await write(response);
    }
  }
}
