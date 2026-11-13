// MCP server: the bounded external surface.
//
// Design rule taken from SPEC §10–11: an external MCP client may *exercise* an
// authorization the operator already created, and may do nothing else. So this
// server exposes seven tools and maps each one onto one execution-plane route:
//
//   delegate_status            → GET  /dsh-delegate/x/status
//   delegate_submit            → POST /dsh-delegate/x/tasks
//   delegate_result            → POST /dsh-delegate/x/tasks/get
//   delegate_wait              → POST /dsh-delegate/x/tasks/observe  (repeated)
//   delegate_cancel            → POST /dsh-delegate/x/tasks/cancel
//   delegate_permission_decide → POST /dsh-delegate/x/tasks/permission
//   delegate_preflight         → POST /dsh-delegate/x/workspace/preflight
//
// `delegate_wait` is a read like `delegate_result`, and it is the one tool whose
// single call may take a long time: it composes several BOUNDED observation
// requests (each ≤ {@link OBSERVE_WAIT_MS}) into one host-visible wait, and returns
// as soon as the task reaches a state the host must act on — a permission request,
// a finished run, a failure, a cancellation — or when the caller's own deadline is
// reached. It never calls `delegate_result`: a wait answer is compact by design, and
// the full snapshot stays behind its own bounded projection.
//
// `delegate_permission_decide` is the one NARROW EXCEPTION to the sentence above,
// and it is narrow in exactly one way: it consumes an ALREADY PENDING per-call
// permission request that a delegated worker raised, and it can answer only
// `allow-once` or `reject` for that one exact tool call. It cannot create a
// connection, cannot issue, widen or extend a grant, cannot change settings, the
// switch, the provider/model or a credential, and cannot pre-approve any future
// operation: the request is bound to one Session, one tool call id and an exact
// fingerprint of the real arguments, and it is consumed by the decision. The
// worker's standing sandbox mode is never changed by it. This tool is NOT part of the
// native worker's declared tool catalog, so the worker's own model is never handed it —
// a real tool-surface restriction, but NOT a claim that a process running as the same OS
// user could not reach the shared local-MCP endpoint directly. See `runtime/permissions.js`.
//
// `delegate_preflight` is the one addition that is not an authorization at all: it
// is a read-only measurement of a workspace, and it exists so a dispatcher can
// learn before submitting that a checkout is dirty, is not a repository, or would
// need an isolation decision — instead of learning it from a failed job. It still
// cannot authorize, configure or write anything, and the execution plane does not
// gate it on the switch, so an answer is available while delegation is off.
//
// There is no tool that issues a connection, issues or widens a grant, changes
// settings, or touches a credential. Those actions live on the authenticated user
// plane, which is reachable only from the operator's own browser session.
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
import { waitForTask } from './wait.js';

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
export const SERVER_INFO = Object.freeze({ name: 'dsh-delegate', version: '1.3.2' });

/** Bound on a tool result's text. A task view can be large; a model's context cannot. */
export const MAX_TOOL_TEXT_CHARS = 20_000;

/** Bound on one execution-plane request. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Longest single observation request `delegate_wait` issues, in milliseconds.
 *
 * Deliberately equal to the execution plane's own bound (`MAX_OBSERVE_WAIT_MS`):
 * the plane clamps anything larger, so a longer value here would only make the
 * client believe it had asked for something the server does not do.
 */
export const OBSERVE_WAIT_MS = 25_000;

/** Default deadline of one `delegate_wait` call, in seconds (one hour). */
export const DEFAULT_WAIT_SECONDS = 3_600;

/** Longest deadline one `delegate_wait` call may ask for, in seconds (one hour). */
export const MAX_WAIT_SECONDS = 3_600;

/** Shortest deadline one `delegate_wait` call may ask for, in seconds. */
export const MIN_WAIT_SECONDS = 1;

/**
 * How many requests may be in flight at once on the stdio transport.
 *
 * A request that takes minutes (a wait) must not stop the host from sending
 * `tools/call` for a status read, a cancel or a permission decision. Concurrency is
 * bounded anyway: each in-flight request holds a socket, a promise and its own
 * encoded reply, and an unbounded number of those is a memory bound the host, not
 * this server, controls. Beyond the cap the request is REFUSED explicitly rather
 * than queued silently, so a host learns its situation instead of wondering.
 */
export const MAX_INFLIGHT_REQUESTS = 32;

/** How many call records are retained for tests/diagnostics. */
export const MAX_CALL_LOG = 256;

/**
 * Reasons on which `delegate_wait` returns to the host.
 *
 * `heartbeat` is deliberately absent: it is the engine's internal "nothing changed
 * yet" signal, consumed by the wait loop and never surfaced as an answer.
 */
export const ACTIONABLE_REASONS = Object.freeze(['attention', 'permission', 'ready', 'failed', 'cancelled', 'interrupted']);

/** The reason a wait that reached its own deadline reports. */
export const WAIT_LIMIT_REASON = 'wait-limit';

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
 *
 * Every tool also carries MCP `annotations` (`readOnlyHint` / `destructiveHint` /
 * `idempotentHint` / `openWorldHint`). They are an accurate DESCRIPTION of what each
 * tool does — a read is marked read-only, cancelling is marked destructive and not
 * idempotent — and they let a concurrency-aware client know that a long wait is a
 * read and must not be treated as a mutating call that blocks the session. They are
 * not the fix for a serialising host: a client that forwards one call at a time
 * ignores every annotation, which is exactly why the independent
 * `bin/dsh-delegate-control.js` channel exists. Nothing here claims that annotations
 * make a serial client concurrent.
 */
export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'delegate_status',
    title: 'Delegation status',
    description: 'Report whether delegation is enabled in DSH for this local MCP connection.',
    // A pure read of the plane's own posture: no task, no grant, no write.
    annotations: Object.freeze({
      title: 'Delegation status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
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
      + 'it does not wait for the work to finish and it is not host approval. '
      + 'workspacePath is the operator-authorized SOURCE repository or checkout the task runs against; '
      + 'a source root may legitimately be a Git checkout or a Git worktree (subject to the usual preflight). '
      + 'A follow-up keeps that same source path as the task it continues. '
      + 'Omit continueFromTaskId to start a NEW task conversation (always a fresh DSH session, even in a '
      + 'directory used before). Set it to the task id of the earlier delegated task this submission is a '
      + 'follow-up to, to continue exactly that task thread (same DSH Workspace and Session): the plugin '
      + 'reuses that task\u2019s recorded execution checkout and DSH Session internally, taking no execution '
      + 'location from '
      + 'the caller. An unknown, unfinished, removed or differently-sourced parent is refused rather than '
      + 'started as a new conversation.',
    // It creates work, so it is not a read; it is not destructive of anything the
    // operator already has, and repeating it creates ANOTHER task (never idempotent).
    annotations: Object.freeze({
      title: 'Submit delegated task',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Absolute path of the operator-authorized SOURCE repository or checkout \u2014 the path '
            + 'the authorization names, not a location chosen while a task runs. A source root may itself be '
            + 'a Git checkout or a Git worktree, which is not rejected for that reason; it still goes through '
            + 'the same preflight as any other path. '
            + 'For a continueFromTaskId follow-up, pass the SAME source path the parent task was submitted '
            + 'with: the plugin reuses the parent\u2019s recorded execution checkout and DSH Session internally, so do not '
            + 'send '
            + 'an execution.workspacePath or any other internal execution location in its place, because a '
            + 'different source path names a different repository and the continuation is refused.',
        },
        prompt: { type: 'string', description: 'The task to perform.' },
        title: { type: 'string', maxLength: 120, description: 'Short work-content title in the operator\'s language, e.g. 修复登录错误. Used to name the new DSH Workspace; omit role instructions and task ids. A follow-up keeps its existing Workspace name.' },
        overrides: {
          type: 'object',
          description: 'Optional per-task overrides (model/effort/timeout). Validated by the harness.',
          additionalProperties: true,
        },
        continueFromTaskId: {
          type: 'string',
          description: 'Task id of the earlier delegated task this submission continues. '
            + 'Use it only for a follow-up change or retry that belongs to that same task; '
            + 'omit it for an unrelated task. It names a task thread, not a directory: keep passing the '
            + 'parent\u2019s original authorized source repository in workspacePath and do not send the parent\u2019s '
            + 'execution location, because the plugin reuses the parent\u2019s recorded execution checkout and DSH Session '
            + 'internally and pins the follow-up to the parent\u2019s recorded isolation; do not select a new '
            + 'isolation override either. An unknown, still-running, removed or differently-sourced parent is '
            + 'refused, never replaced by a new conversation.',
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
    // A read of a stored task: no work is created, changed or cancelled.
    annotations: Object.freeze({
      title: 'Read task result',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
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
    name: 'delegate_wait',
    title: 'Wait for a task to need you',
    description: 'Follow ONE task this connection submitted and return as soon as it needs the host. '
      + 'A single call blocks for up to waitSeconds (default 3600) and returns a COMPACT answer: '
      + '`reason` is `permission` (a per-call request is pending), `attention` (no activity for about ten '
      + 'minutes, so the run may be stuck), `ready` (the run ended and is awaiting host review), `failed`, '
      + '`cancelled` or `interrupted`. '
      + '`reason: "wait-limit"` means the deadline was reached and NOTHING changed: call delegate_wait again '
      + 'with the same taskId — do not review, resubmit or restart the task. '
      + 'Heartbeats are internal to this call and are never returned. '
      + 'This tool reads; it never submits, cancels or decides anything, and it does not fetch the task\u2019s '
      + 'diff or full result (use delegate_result for that, after an actionable reason). '
      + 'On `permission`, the returned `permission` block carries the pending request with its requestId, '
      + 'its exact fingerprint and the full existing redacted operation, so delegate_permission_decide can '
      + 'be sent without another read. '
      + '`interrupted` does NOT mean the execution stopped. This call answers it immediately, once: '
      + 'when the task is still pending or running the answer is `reason: "interrupted"` with '
      + '`terminal: false` and the real task state, and YOU wait again on the same taskId. '
      + '`terminal: true` with `state: "interrupted"` means the task record itself is a restart history '
      + 'and will not resume. If the reason carried a settled state it is reported as that outcome '
      + '(`ready`/`failed`/`cancelled`). A missing or unrecognized state is reported as '
      + '`terminal: false` with nothing asserted: check before deciding.',
    // A LONG read, and that is the point: `readOnlyHint` is what tells a
    // concurrency-aware client this call may be held for an hour without being a
    // mutating operation. A serialising host still ignores it; the independent
    // `dsh-delegate-control` channel is the answer there.
    annotations: Object.freeze({
      title: 'Wait for a task to need you',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
        waitSeconds: {
          type: 'integer',
          minimum: MIN_WAIT_SECONDS,
          maximum: MAX_WAIT_SECONDS,
          description: 'How long this one call may wait, in seconds (default 3600). '
            + 'A returned `wait-limit` means this deadline was reached, not that the task stalled.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_cancel',
    title: 'Cancel task',
    description: 'Ask the harness to stop one task this connection submitted, and return its state afterwards.',
    // It stops running work: destructive of the run (never of the workspace), and a
    // second call on an already-cancelled task changes nothing.
    annotations: Object.freeze({
      title: 'Cancel task',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }),
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
    name: 'delegate_permission_decide',
    title: 'Decide a paused permission request',
    description: 'Decide ONE per-call permission request that a delegated task is waiting on. '
      + 'A delegated worker runs in its own workspace with a standing `workspace-write` sandbox; '
      + 'when it asks to widen access for a single tool call, that call PAUSES and the request appears '
      + 'in delegate_result as `permission.pending` (state stays `running`, phase `awaiting-permission`). '
      + 'Read `permission.pending.arguments`/`argumentKeys` for the exact operation and `permission.pending.reason` '
      + 'for the asker\u2019s claim — the claim is not the operation. Answer `allow-once` to let THAT ONE call '
      + 'proceed, or `reject` to keep it denied; the worker then continues and a later escalation asks again. '
      + 'This cannot grant an account, a workspace or a standing policy, cannot change settings, credentials, '
      + 'the switch, the provider/model or the isolation, and cannot approve a future call. '
      + '`allow-once` REQUIRES the pending request\u2019s `fingerprint` and is refused when `permission.pending.'
      + 'completeness` is not `complete` (the operation was shortened by a bound, so an allow cannot be granted '
      + 'on it). `reject` needs neither and is therefore always available.',
    // It does not read and it does not write a configuration: it settles ONE paused
    // call. A repeated decision for the same request is refused, so it is not
    // idempotent — the second call is a different outcome by design.
    annotations: Object.freeze({
      title: 'Decide a paused permission request',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identity returned by delegate_submit.' },
        requestId: { type: 'string', description: 'The pending request\u2019s `requestId`, copied from delegate_result.' },
        decision: {
          type: 'string',
          enum: ['allow-once', 'reject'],
          description: 'allow-once permits exactly the paused call; reject keeps it denied.',
        },
        reason: {
          type: 'string',
          description: 'Optional bounded note recorded with the decision. It is evidence, never a grant.',
        },
        fingerprint: {
          type: 'string',
          description: 'The pending request\u2019s `fingerprint`. REQUIRED for `allow-once`: the decision must name '
            + 'the exact operation it grants, and an allow that omits it is refused. Optional for `reject` (a '
            + 'refusal is safe without it); when supplied, a request whose operation no longer matches is refused.',
        },
      },
      required: ['taskId', 'requestId', 'decision'],
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'delegate_preflight',
    title: 'Inspect workspace before dispatch',
    description: 'Read-only preflight of one absolute workspace path: whether it is a git repository with a commit, '
      + 'whether it is clean, how many files are changed (with a bounded path list), and the isolation to request '
      + '(worktree / shared / block) with a stable reason code. '
      + 'It creates no commit, stash, worktree or task and changes no setting; '
      + 'passing allowShared acknowledges a dirty workspace but does not dispatch anything.',
    // A read-only measurement of a directory: nothing is created or changed.
    annotations: Object.freeze({
      title: 'Inspect workspace before dispatch',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        workspacePath: { type: 'string', description: 'Absolute path of the workspace to inspect.' },
        allowShared: {
          type: 'boolean',
          description: 'Set only after deciding explicitly that a dirty workspace may run in place (shared isolation). '
            + 'Omit it to be told that a decision is required instead.',
        },
      },
      required: ['workspacePath'],
      additionalProperties: false,
    }),
  }),
]);

/** Tool name → the execution-plane call it makes. */
const TOOL_ROUTES = Object.freeze({
  delegate_status: 'status',
  delegate_submit: 'submit',
  delegate_result: 'result',
  delegate_wait: 'observe',
  delegate_cancel: 'cancel',
  delegate_permission_decide: 'permission',
  delegate_preflight: 'preflight',
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
    } else if (declared.type === 'boolean') {
      // Strict: a model that sends the string "true" gets a refusal naming the
      // field instead of a silently truthy value reaching the plane.
      if (typeof field !== 'boolean') throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be a boolean`);
      out[key] = field;
    } else if (declared.type === 'integer') {
      // Strict for the same reason: `"3600"` and `3600.5` are refused with the
      // field named rather than silently coerced into a deadline nobody chose.
      if (!Number.isInteger(field)) throw new McpError('MCP_ARGUMENT_TYPE', `${tool.name}.${key} must be an integer`);
      if (typeof declared.minimum === 'number' && field < declared.minimum) {
        throw new McpError('MCP_ARGUMENT_RANGE', `${tool.name}.${key} must be at least ${declared.minimum}`);
      }
      if (typeof declared.maximum === 'number' && field > declared.maximum) {
        throw new McpError('MCP_ARGUMENT_RANGE', `${tool.name}.${key} must be at most ${declared.maximum}`);
      }
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
    // The settled decision trail is HISTORY; the pending request is the thing the
    // commander must act on NOW. Under a bound the history goes first, so a running
    // task can never keep an outstanding request invisible behind old evidence.
    const permission = target.permission;
    if (permission !== null && typeof permission === 'object' && Array.isArray(permission.evidence)) {
      const keep = Math.min(permission.evidence.length, stage.permissionEvidence);
      if (permission.evidence.length > keep) {
        collect.push(truncationRecord(`${prefix}permission.evidence`, {
          total: permission.evidence.length,
          omitted: permission.evidence.length - keep,
          detail: 'the live pending request is prioritised over settled history',
        }));
        // `slice(-0)` keeps EVERY entry, so the zero-keep stage would claim a drop
        // it did not perform and then still publish the history it said it removed.
        permission.evidence = keep === 0 ? [] : permission.evidence.slice(-keep);
      }
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
    // is trimmed rather than dropped, so nothing disappears unexplained. The
    // exception is `permission`: a wait answer publishes the pending operation there,
    // and a generic per-string cut would shorten the operation WITHOUT updating
    // `argumentsComplete`/`allowBlocked`, publishing a shortened operation that still
    // reads as complete. It is bounded by the permission rule instead.
    for (const [key, item] of Object.entries(projected)) {
      if (key === 'task' || key === 'tasks' || key === 'ok') continue;
      projected[key] = key === 'permission'
        ? boundPermissionBlock(item, key, collect)
        : trimAllStrings(item, key, cap, collect);
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
  // The LIVE pending permission request is the one thing a commander must keep when
  // everything else is trimmed: without its `requestId`/`fingerprint`/operation the
  // task stays `awaiting-permission` and nothing can be decided. It gets its OWN,
  // generous caps rather than the skeleton's per-string cap, so the identity and the
  // operation survive, and its completeness flags are carried VERBATIM so a shortened
  // operation can never read as complete.
  const pending = pendingPermissionsOf(task, path, collect);
  if (pending !== undefined) out.permission = pending;
  out.truncation = { path, field: 'result', detail: 'only identity, state, routing, refusal, acceptance and the live pending permission request are shown' };
  collect.push(out.truncation);
  return out;
}

/**
 * The live pending permission request of one task, bounded but never skeletal.
 *
 * Only `state === 'pending'` qualifies: settled evidence is history and is the first
 * thing the bound gives up, while an outstanding request is the decision surface
 * itself. The per-field caps are fixed and generous (identity and fingerprint are
 * never cut; the argument blobs get their own cap), and `completeness` /
 * `argumentsComplete` / `allowBlocked` are copied unchanged so a shortened operation
 * cannot be presented as reviewable.
 *
 * Only FINAL cuts are recorded. The generic walk applies a small per-string cap to
 * every field, and then the decision surface is restored to its real value (or its
 * own 4000-character blob cap). A walk cut on a restored field no longer describes
 * the output — the walk once left `truncation.fields` naming a phantom cut on a
 * fully restored 1500-character operation — so the walk collects into a scratch list
 * and only the cuts that survive into the published block are reported.
 * `argumentsComplete: false` / `allowBlocked` still come from the engine, so a
 * genuinely shortened operation can never read as complete.
 * @param {object} task - task view.
 * @param {string} path - JSON path prefix for truncation records.
 * @param {object[]} collect - truncation records.
 * @returns {object | undefined} the bounded pending block, or undefined when none.
 */
function pendingPermissionsOf(task, path, collect) {
  const permission = task?.permission;
  if (permission === null || typeof permission !== 'object') return undefined;
  const pending = permission.pending;
  if (pending === null || typeof pending !== 'object' || pending.state !== 'pending') return undefined;
  const prefix = `${path}.permission.pending`;
  // Provisional cuts, discarded: every field they touch is restored or re-cut below.
  const scratched = [];
  const out = { ...boundValue(pending, prefix, 512, scratched) };
  // Restore the decision surface EXACTLY after the generic walk.
  for (const key of ['requestId', 'taskId', 'toolName', 'callId', 'fingerprint', 'sessionId']) {
    if (pending[key] !== undefined) out[key] = pending[key];
  }
  for (const key of ['state', 'completeness', 'argumentsComplete', 'allowBlocked', 'reasonSource', 'boundsApplied', 'omitted', 'requestedAccess']) {
    if (pending[key] !== undefined) out[key] = pending[key];
  }
  // The two blobs get their own cap, stated when it fires. This is the only cut for
  // them, because the capped value is what is published.
  for (const key of ['arguments', 'reason']) {
    if (typeof pending[key] === 'string') out[key] = boundedText(pending[key], 4000, `${prefix}.${key}`, collect);
  }
  // One identified: the provisional cap still applies to it, so the scratch list
  // holds no final cut to forward. Report the exception explicitly instead of a cut,
  // so the record explains why an unexpected field may be shorter than the original.
  if (scratched.length > 0) {
    collect.push({
      path: `${path}.permission.pending`,
      field: 'detail',
      keptChars: 512,
      detail: 'fields other than the decision surface are bounded to 512 characters each',
    });
  }
  return { bridged: permission.bridged === true, waiting: true, pending: out };
}

/**
 * The keys of a pending permission request that a decision is bound to.
 *
 * A value under one of these keys is copied VERBATIM: cutting an identity would
 * make the request undecidable, and cutting the `completeness` flags would let a
 * shortened operation read as a decidable one — which is exactly the property the
 * per-call permission boundary depends on.
 */
const PERMISSION_IDENTITY_KEYS = Object.freeze([
  'requestId', 'taskId', 'sessionId', 'toolName', 'callId', 'state', 'completeness',
  'argumentsComplete', 'allowBlocked', 'reasonSource', 'boundsApplied', 'omitted',
  'requestedAccess', 'argumentKeys', 'argumentsRedacted', 'fingerprint', 'standingModeUnchanged',
]);

/**
 * The blobs of a pending permission request, and the cap applied to each.
 *
 * `reason` is the worker's claim and `arguments` is the operation; both are prose
 * from a model, so both are bounded — but at a cap large enough for a real tool
 * call. When the cap fires, `boundsApplied` gains this server's own marker and
 * `argumentsComplete` is forced to `false` in {@link boundPermissionRequest}, so a
 * shortened operation is never presented as complete.
 */
const PERMISSION_BLOB_CAP = 4_000;

/**
 * Bound one pending permission request without ever making it look decidable when
 * it is not.
 *
 * The rule this encodes: `boundedJson` may shorten anything, but it may not change
 * the MEANING of the permission surface. Identity fields and the completeness flags
 * pass through untouched; the two prose blobs are capped, and a fired cap is
 * recorded in `boundsApplied` and reflected in `argumentsComplete: false` /
 * `allowBlocked`. The engine's own `completeness` label is left as it is (this
 * projection never upgrades `truncated` to `complete`), and no path here can set any
 * of those flags back to a permissive value.
 * @param {object} pending - pending permission record.
 * @param {string} path - JSON path for the truncation records.
 * @param {object[]} collect - truncation records.
 * @returns {object} bounded pending record.
 */
function boundPermissionRequest(pending, path, collect) {
  if (pending === null || typeof pending !== 'object' || Array.isArray(pending)) return pending ?? null;
  const out = {};
  const ownCuts = [];
  for (const [key, value] of Object.entries(pending)) {
    if (PERMISSION_IDENTITY_KEYS.includes(key)) {
      out[key] = value;
      continue;
    }
    if ((key === 'arguments' || key === 'reason') && typeof value === 'string' && value.length > PERMISSION_BLOB_CAP) {
      out[key] = boundedText(value, PERMISSION_BLOB_CAP, `${path}.${key}`, collect);
      ownCuts.push(key);
      continue;
    }
    out[key] = boundValue(value, `${path}.${key}`, 512, collect);
  }
  if (ownCuts.length > 0) {
    // Both flags are only ever made LESS permissive. `completeness` is downgraded
    // because the published operation is no longer the whole one; `argumentsComplete`
    // becomes false for the same reason; `allowBlocked` gains a reason when the
    // engine had not already supplied one.
    out.completeness = pending.completeness === 'complete' ? 'truncated' : (pending.completeness ?? 'truncated');
    out.argumentsComplete = false;
    if (out.allowBlocked === null || out.allowBlocked === undefined) {
      out.allowBlocked = 'the operation was shortened by the tool-text bound, so an allow cannot be granted on it';
    }
    const applied = Array.isArray(pending.boundsApplied) ? pending.boundsApplied.slice() : [];
    if (!applied.includes('mcp-text')) applied.push('mcp-text');
    out.boundsApplied = applied;
    collect.push({
      path: `${path}`,
      field: 'permission',
      detail: 'the published operation was shortened by the tool-text bound; it remains marked unapprovable',
    });
  }
  return out;
}

/**
 * Whether a pending operation, as it stands, can be decided `allow-once`.
 *
 * One place, one rule: the answer a host reads and the flag this server publishes
 * must agree, so the rule is a function rather than a duplicated expression.
 * @param {object} pendingOperation - pending operation (possibly bounded).
 * @returns {boolean} true only for a whole, unblocked operation.
 */
export function isPermissionDecidable(pendingOperation) {
  if (pendingOperation === null || typeof pendingOperation !== 'object') return false;
  if (pendingOperation.state !== undefined && pendingOperation.state !== 'pending') return false;
  if (pendingOperation.argumentsComplete !== true) return false;
  if (pendingOperation.allowBlocked !== null && pendingOperation.allowBlocked !== undefined) return false;
  if (pendingOperation.completeness !== undefined && pendingOperation.completeness !== 'complete') return false;
  return true;
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
    // A pending permission request nested in ANY task-shaped record (a list answer,
    // a skeletonised task) still has to be decidable, so it is bounded by its own
    // rule rather than by the generic per-string cap. Recognising it here, at every
    // depth, is what makes the guarantee hold for every tool answer and not only
    // for the shapes this file happens to special-case.
    if (key === 'permission' && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out[key] = boundPermissionBlock(item, `${path}.permission`, collect);
      continue;
    }    out[key] = boundValue(item, `${path}.${key}`, cap, collect);
  }
  return out;
}

/**
 * Bound a task's permission block, preserving its live pending request.
 * @param {object} permission - permission block.
 * @param {string} path - JSON path.
 * @param {object[]} collect - truncation records.
 * @returns {object} bounded block.
 */
function boundPermissionBlock(permission, path, collect) {
  // A bare pending operation (the shape a wait answer publishes, and the shape the
  // engine's `observeTask` contract describes) is bounded as a REQUEST, not as a
  // block: recognising it by its own identity fields means the same rule applies
  // however a particular answer happens to nest it.
  if (typeof permission.requestId === 'string' && typeof permission.state === 'string'
    && permission.state === 'pending') {
    return boundPermissionRequest(permission, path, collect);
  }
  const out = {};
  let preserved = false;
  for (const [key, value] of Object.entries(permission)) {
    if (key === 'pending' && value !== null && typeof value === 'object' && value.state === 'pending') {
      out[key] = boundPermissionRequest(value, `${path}.pending`, collect);
      preserved = true;
      // A preserved request is DECISION MATERIAL, not history. It is restored the
      // way the skeleton stage restores it: not reported as a cut merely because it
      // was bounded on its own terms.
      collect.push({
        path: `${path}.pending`,
        field: 'detail',
        detail: 'the live pending request is carried in full except for its own blob caps, and stays marked unapprovable when shortened',
      });
      continue;
    }
    out[key] = boundValue(value, `${path}.${key}`, 512, collect);
  }
  if (preserved) out.waiting = true;
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
    { executionText: TRUNCATED_FIELD_CAPS.executionTextChars, reviewText: TRUNCATED_FIELD_CAPS.reviewTextChars, lists: 50, permissionEvidence: 8 },
    { executionText: 400, reviewText: 400, lists: 20, permissionEvidence: 4 },
    { executionText: 200, reviewText: 200, lists: 5, permissionEvidence: 2 },
    { executionText: 120, reviewText: 120, lists: 1, permissionEvidence: 1 },
    { executionText: 80, reviewText: 80, lists: 1, permissionEvidence: 0, skeletonChars: 240 },
    { executionText: 40, reviewText: 40, lists: 1, permissionEvidence: 0, skeletonChars: 96 },
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
    // A wait answer publishes `permissionDecidable`, and a bound may have shortened
    // the operation it describes. Recomputing the flag from the PUBLISHED operation
    // is what stops a cut operation from being advertised as decidable.
    if (projected.permission !== undefined && projected.permission !== null) {
      projected.permissionDecidable = isPermissionDecidable(projected.permission);
    }
    return JSON.stringify(redactDeepStrings(projected), null, 2);
  };
  for (const stage of stages) {
    const text = apply(stage);
    if (text.length <= MAX_TOOL_TEXT_CHARS) return { text, isError: false };
  }

  // The refusal path is reached only when nothing above fits. An answer that carries
  // a LIVE pending permission request is different from any other oversized answer:
  // dropping it would leave the task paused and undecidable from what the host was
  // told. So before refusing, the answer is reduced to those requests alone — with
  // their blobs re-capped to whatever the bound leaves — and published under an
  // explicit `permissionOnly` marker that states the rest was not included. When
  // even this does not fit, the refusal below stands: a trimmed request must never
  // be presented as an answer.
  const rescue = permissionRescue(value, compact.length);
  if (rescue !== null) {
    for (const cap of [4_000, 1_000, 400, 160, 0]) {
      const text = rescue(cap);
      if (text.length <= MAX_TOOL_TEXT_CHARS) return { text, isError: false };
    }
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
 * Build a last-resort projection that keeps only the live pending permission
 * requests of an oversized answer.
 *
 * The ORDER is fixed and the caps are tried by the caller: identity first, then a
 * smaller operation blob. `completeness`/`argumentsComplete`/`allowBlocked` are
 * always carried as the engine states them (or downgraded by the capping), so a
 * shortened request still cannot be allowed.
 * @param {unknown} value - the answer that did not fit.
 * @param {number} fullTextChars - size of the original answer, for the record.
 * @returns {((cap: number) => string) | null} renderer, or null when the answer
 *   carries no live pending request.
 */
function permissionRescue(value, fullTextChars) {
  const entries = [];
  const collectTask = (task, path) => {
    const block = task?.permission;
    const pending = block?.pending;
    if (pending === null || typeof pending !== 'object' || pending.state !== 'pending') return;
    entries.push({ path, taskId: task.taskId, state: task.state, phase: task.phase, block, pending });
  };
  if (value?.task !== null && typeof value?.task === 'object' && !Array.isArray(value.task)) collectTask(value.task, 'task');
  if (Array.isArray(value?.tasks)) value.tasks.forEach((task, index) => collectTask(task, `tasks[${index}]`));
  // A WAIT answer publishes the pending operation directly as `permission` rather
  // than under `task.permission.pending`. It is the one shape where the whole point
  // of the answer is the operation, so it earns the same rescue: shorten the
  // operation, never drop it and never let it read as complete.
  const bare = value?.permission;
  if (bare !== null && typeof bare === 'object' && bare.state === 'pending' && typeof bare.requestId === 'string') {
    entries.push({
      path: 'permission', taskId: value.taskId, state: value.state, phase: value.phase, block: null, pending: bare, bare: true,
    });
  }
  if (entries.length === 0) return null;
  return (cap) => {
    const records = [];
    const render = (entry) => {
      const pending = boundPermissionRequest(
        cap === 0 ? { ...entry.pending, arguments: '', reason: '' } : entry.pending,
        `${entry.path === 'permission' ? 'permission' : `${entry.path}.permission.pending`}`,
        records,
      );
      if (cap === 0) {
        pending.arguments = null;
        pending.argumentsComplete = false;
        pending.completeness = 'truncated';
        pending.allowBlocked = pending.allowBlocked ?? 'the operation could not be included within the tool-text bound';
        records.push({ path: 'permission.arguments', field: 'text', keptChars: 0, detail: 'the operation did not fit' });
      } else if (cap < 4_000 && typeof pending.arguments === 'string' && pending.arguments.length > cap) {
        pending.arguments = boundedText(pending.arguments, cap, 'permission.arguments', records);
        pending.argumentsComplete = false;
        pending.completeness = pending.completeness === 'complete' ? 'truncated' : pending.completeness;
        pending.allowBlocked = pending.allowBlocked ?? 'the operation was shortened by the tool-text bound, so an allow cannot be granted on it';
      }
      return pending;
    };
    if (entries.length === 1 && entries[0].bare === true) {
      const payload = {
        ok: value.ok,
        taskId: entries[0].taskId,
        state: entries[0].state,
        phase: entries[0].phase,
        reason: value.reason,
        actionable: true,
        permission: render(entries[0]),
        permissionDecidable: false,
        truncation: truncationBlock(records, fullTextChars, entries),
      };
      return JSON.stringify(redactDeepStrings(payload), null, 2);
    }
    const tasks = entries.map((entry) => {
      const pending = render(entry);
      const block = { bridged: entry.block?.bridged === true, waiting: true, pending };
      return {
        taskId: entry.taskId,
        state: entry.state,
        phase: entry.phase,
        permissionOnly: true,
        permission: block,
      };
    });
    const payload = entries.length === 1 && entries[0].path === 'task'
      ? { ok: value.ok, task: tasks[0], truncation: truncationBlock(records, fullTextChars, entries) }
      : { ok: value.ok, tasks, truncation: truncationBlock(records, fullTextChars, entries) };
    return JSON.stringify(redactDeepStrings(payload), null, 2);
  };
}

/**
 * The truncation record of a permission-only answer.
 * @param {object[]} records - per-field cuts.
 * @param {number} fullTextChars - size of the original answer.
 * @param {object[]} entries - the requests that survived.
 * @returns {object} truncation block.
 */
function truncationBlock(records, fullTextChars, entries) {
  return {
    truncated: true,
    reason: 'the answer exceeded the tool-text bound; only the live pending permission request(s) were returned',
    fullTextChars,
    boundChars: MAX_TOOL_TEXT_CHARS,
    fullResultIncluded: false,
    permissionOnly: true,
    tasksWithPendingPermission: entries.map((entry) => truncateScalar(entry.taskId)),
    fields: dedupeRecords(records),
  };
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
 * be tested without a socket: it receives `(route, payload, context?)` and resolves
 * to the execution plane's parsed `ok:true` body, throwing on any refusal.
 * `context.signal` is the caller's per-REQUEST cancellation, used by
 * `delegate_wait` so `notifications/cancelled` ends that wait and nothing else.
 *
 * `now` and `sleep` are seams, not configuration: a test drives a twenty-minute
 * wait in milliseconds by handing in its own clock, and production takes the real
 * ones. Nothing else about the wait depends on them.
 * @param {object} options - `callExecution`, optional `logger`, `now`, `sleep`.
 * @returns {{ handle: Function, tools: readonly object[], calls: object[], isInitialized: () => boolean }} server.
 */
export function createMcpServer(options) {
  if (typeof options?.callExecution !== 'function') {
    throw new TypeError('createMcpServer needs a callExecution function');
  }
  const callExecution = options.callExecution;
  const logger = options.logger ?? null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
  // Records what was asked for, so a test can prove which plane route a tool
  // reached instead of trusting the tool result. Bounded: a long session issues
  // thousands of calls, and an unbounded array here would be a memory leak that
  // only shows up in the field.
  const calls = [];
  let initialized = false;

  /**
   * Remember one call without growing without bound.
   * @param {object} record - call record.
   * @returns {void}
   */
  function recordCall(record) {
    calls.push(record);
    if (calls.length > MAX_CALL_LOG) calls.splice(0, calls.length - MAX_CALL_LOG);
  }
  /**
   * Run one tool call and wrap the answer as MCP content.
   * @param {string} name - tool name.
   * @param {unknown} args - arguments.
   * @param {{ signal?: AbortSignal }} [context] - per-request cancellation.
   * @returns {Promise<object>} `{ content, isError? }`.
   */
  async function callTool(name, args, context = {}) {
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
    recordCall({ tool: name, route, payload });
    try {
      const result = name === 'delegate_wait'
        ? await waitAnswer(payload, context)
        : await callExecution(route, payload);
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
   * One `delegate_wait` call: a bounded loop of internal observations.
   *
   * The loop lives in `./wait.js`, and this function only supplies the pieces the
   * loop must not own itself — the transport call, the clock and the caller's
   * cancellation — so the loop can be tested without a server and a test can drive
   * twenty minutes of activity in milliseconds.
   * @param {object} payload - validated arguments.
   * @param {{ signal?: AbortSignal }} context - per-request cancellation.
   * @returns {Promise<object>} `{ ok: true, ...answer }`.
   */
  async function waitAnswer(payload, context) {
    const waitSeconds = payload.waitSeconds ?? DEFAULT_WAIT_SECONDS;
    const result = await waitForTask({
      callExecution,
      taskId: payload.taskId,
      waitMs: waitSeconds * 1_000,
      signal: context?.signal,
      now,
      sleep,
    });
    if (result?.error !== undefined) {
      // The loop could not obtain an observation at all. That is a refusal with the
      // harness's own code, raised so the standard refusal path shapes it — never an
      // answer that would look like a task state.
      throw new McpError(result.error.code, result.error.message);
    }
    return { ok: true, ...result };
  }

  /**
   * Answer one JSON-RPC message.
   *
   * Returns `null` for a notification (the protocol forbids a response) so the
   * transport writes nothing.
   *
   * `context.signal` cancels THIS request only. It is passed down to the one place
   * a request can be long — the wait loop — so a host that gives up on a wait stops
   * the observations it is making without touching the worker, the task or any
   * other request.
   * @param {unknown} message - parsed JSON-RPC message.
   * @param {{ signal?: AbortSignal }} [context] - per-request cancellation.
   * @returns {Promise<object | null>} response, or null.
   */
  async function handle(message, context = {}) {
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
              + 'has enabled the delegation switch in the authenticated DSH settings page. '
              + 'For delegate_submit, workspacePath is the operator-authorized SOURCE repository or checkout '
              + '(a Git checkout or an operator-authorized Git worktree are both legitimate), not a location a '
              + 'task execution ran in; delegate_preflight is a separate read-only inspection of a path. '
              + 'Every submission starts a new task conversation unless it passes continueFromTaskId naming the '
              + 'earlier delegated task it is a follow-up to; that explicit id is the only way to continue an '
              + 'existing task thread. A follow-up continues the parent\u2019s DSH Workspace and Session and reuses '
              + 'the parent\u2019s recorded execution checkout and DSH Session internally, so it passes the parent\u2019s original '
              + 'source path again and never substitutes an internal execution location for it. A parent that '
              + 'is unknown, still running, removed or belongs to another source repository is refused '
              + 'instead of starting a new conversation. A worker that needs wider access for ONE tool call '
              + 'pauses that call and reports it as `permission.pending` in delegate_result; while it waits the '
              + 'task stays `running` with phase `awaiting-permission`. Answer exactly one such request with '
              + 'delegate_permission_decide (`allow-once` or `reject`). That decision covers only that call, is '
              + 'never a standing grant, and cannot approve anything else. To follow a task without polling, use '
              + 'delegate_wait: one call blocks until the task needs you (permission, ready, failed, cancelled, '
              + 'interrupted) or until its deadline, in which case it answers reason "wait-limit" and you call '
              + 'it again with the same taskId instead of reviewing or resubmitting anything. '
              + '`interrupted` never means the execution stopped by itself: this call returns it at once '
              + 'with `terminal: false` while the task is still pending or running (wait again on the same '
              + 'taskId); only a task record that is itself interrupted (a restart history) is `terminal: true`. '
              + 'If a host serialises tool calls so that this '
              + 'connection is blocked by a long wait, the independently installed `dsh-delegate-control` '
              + 'binary can report or cancel one task from a separate process; it cannot submit, configure or '
              + 'change the switch.',
          });
        }
        case 'notifications/initialized':
          return null;
        case 'notifications/cancelled':
          // Handled by the transport, which owns the in-flight table: this server
          // cannot see a request that is still running from inside a handler.
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
          return result(id, await callTool(name, params?.arguments, context));
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
 *
 * Two properties of this loop are load-bearing and were added for `delegate_wait`:
 *
 *   1. **A request that takes minutes must not stop the others.** Each request is
 *      dispatched and its reply written when it settles, so a host can send a
 *      status read or a cancel while a wait is outstanding. Replies are written one
 *      line at a time through a single writer, so two concurrent answers can never
 *      interleave inside a line.
 *   2. **Cancellation is per request.** `notifications/cancelled` aborts exactly the
 *      request it names: that request's wait ends, its reply is a normal refusal,
 *      and every other request (including another wait on the same task) continues.
 *
 * The concurrency bound is a refusal, not a queue: a host that sends a 33rd
 * simultaneous request is told so explicitly. Stdin EOF stops accepting new work,
 * aborts nothing on the worker side, and the loop returns only once every
 * outstanding reply has been written, so nothing is truncated at shutdown.
 * @param {object} options - `input`, `output` streams, `server`, optional `onError`,
 *   `maxInflight`.
 * @returns {Promise<void>} resolves when the input stream ends and replies are drained.
 */
export async function serveStdio(options) {
  const { input, output, server } = options;
  const onError = options.onError ?? (() => {});
  const maxInflight = Number.isInteger(options.maxInflight) && options.maxInflight > 0
    ? options.maxInflight
    : MAX_INFLIGHT_REQUESTS;

  /**
   * Serialize every write so a line is never split by another request's answer.
   *
   * Each write waits for the previous one, and also for `drain` when the stream
   * applies backpressure. A rejected write (a closed pipe) must not leave the queue
   * permanently blocked, which is why the chain continues even after a failure.
   * @param {object} payload - JSON-RPC message.
   * @returns {Promise<void>} resolves after this line is written (or fails to be).
   */
  let writeChain = Promise.resolve();
  const write = (payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    writeChain = writeChain.then(() => new Promise((resolvePromise) => {
      let ok = true;
      try {
        ok = output.write(line) !== false;
      } catch (error) {
        onError(error);
        resolvePromise();
        return;
      }
      if (ok) {
        resolvePromise();
        return;
      }
      output.once('drain', resolvePromise);
      // A stream destroyed while waiting for `drain` never emits it; without this
      // the writer would wait forever and EOF would hang instead of draining.
      output.once('close', resolvePromise);
    }));
    return writeChain;
  };

  /** Requests currently in flight, by the JSON-RPC id as a map key. */
  const inflight = new Map();
  /** Every outstanding request promise, so EOF can drain them all. */
  const pending = new Set();
  let inputEnded = false;
  /** Set once the transport is shutting down: no new work is accepted. */
  let closed = false;

  /**
   * A stable map key for a request id. JSON-RPC ids are strings or numbers; a
   * string `"1"` and a number `1` are distinct ids, so the type is part of the key.
   * @param {unknown} id - request id.
   * @returns {string} map key.
   */
  const idKey = (id) => `${typeof id}:${String(id)}`;

  /**
   * Ask one in-flight request to stop.
   * @param {unknown} requestId - the id named by the notification.
   * @returns {boolean} whether a request was actually cancelled.
   */
  const cancel = (requestId) => {
    const entry = inflight.get(idKey(requestId));
    if (entry === undefined) return false;
    const error = new Error('the request was cancelled by the host');
    error.name = 'AbortError';
    error.code = 'MCP_REQUEST_CANCELLED';
    entry.controller.abort(error);
    return true;
  };

  /**
   * Handle one parsed line: a request is started, a notification is acted on.
   * @param {object} message - parsed JSON-RPC message.
   * @returns {void}
   */
  const dispatch = (message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      void write(errorResponse(null, RPC_ERRORS.invalidRequest, 'a JSON-RPC message must be an object'));
      return;
    }
    const { id, method } = message;
    if (method === 'notifications/cancelled') {
      // Never answered: the protocol forbids a response to a notification. The
      // cancellation request id travels in `params.requestId`.
      cancel(message.params?.requestId);
      return;
    }
    if (id === undefined || id === null) {
      // Any other notification is handled for its effect only.
      void (async () => {
        try {
          await server.handle(message);
        } catch (error) {
          onError(error);
        }
      })();
      return;
    }
    const key = idKey(id);
    if (inflight.has(key)) {
      // Two live requests with one id would make the answers unassignable, and the
      // second would silently replace the first's cancellation handle. Refusing is
      // the only honest answer; the original request keeps running.
      void write(errorResponse(id, RPC_ERRORS.invalidRequest, 'a request with this id is already in flight'));
      return;
    }
    if (inflight.size >= maxInflight) {
      void write(errorResponse(id, RPC_ERRORS.invalidRequest, `too many requests in flight (limit ${maxInflight})`));
      return;
    }

    const controller = new AbortController();
    inflight.set(key, { controller });
    const run = (async () => {
      let response = null;
      try {
        response = await server.handle(message, { signal: controller.signal });
      } catch (error) {
        onError(error);
        response = errorResponse(message?.id ?? null, RPC_ERRORS.internal, 'the request could not be handled');
      } finally {
        inflight.delete(key);
      }
      if (response !== null && response !== undefined) await write(response);
    })();
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  let buffer = '';
  try {
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
        // Awaited so the next line is not read before this one has been attributed,
        // but the request it starts is NOT awaited: that is what keeps a long wait
        // from blocking the transport.
        dispatch(message);
      }
    }
  } catch (error) {
    onError(error);
  }
  inputEnded = true;
  closed = true;

  // Drain: every reply that was already being produced is written before the loop
  // returns. Readers are ended here, but nothing is aborted on the worker side — a
  // wait that ends because its host vanished is the host's decision, not a cancel.
  while (pending.size > 0) await Promise.allSettled([...pending]);
  await writeChain;
  return { inflight: inputEnded, closed, drained: pending.size === 0 };
}
