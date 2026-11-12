#!/usr/bin/env node
// Independent local control CLI for the delegation plane.
//
// Why this exists, and what it refuses to be
// ------------------------------------------
// The plugin's stdio MCP server already serves concurrent requests: a `delegate_wait`
// that is in flight does not stop a `delegate_status` or a `delegate_cancel` from
// being answered (see `serveStdio` in `src/mcp/server.js`). The bottleneck is the HOST:
// a client that forwards tool calls one at a time, or one that has a single MCP
// connection blocked on a long wait, cannot send a second call while the first is
// outstanding — and the operator is then unable to ask "what is this task doing" or
// "stop it" without waiting for the wait to end.
//
// This binary is that second channel, and nothing more:
//
//   * it uses the SAME execution client and the SAME endpoint discovery the MCP
//     server uses, against the loopback plane the plugin already serves — no new
//     port, no new route, no new permission, no token, no configuration surface, no
//     long-lived background process;
//   * it supports exactly two verbs, `status <taskId>` and `cancel <taskId>`. There
//     is no submit, no settings write, no switch toggle, no batch form and no way to
//     widen a grant: those actions stay where they were;
//   * `status` uses the bounded `observe` read with `waitMs: 0` — a compact task
//     status, never a diff or a conversation transcript;
//   * stdout carries one stable JSON document and nothing else, so a script or a
//     companion can parse it; diagnostics go to stderr; a failure exits non-zero;
//   * a request timeout is finite, so a caller cannot be parked indefinitely.
//
// Importing this module for tests must not run the CLI: `main` is only invoked when
// the file is executed directly.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createExecutionClient, readConfig } from './dsh-delegate-mcp.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

/** The only two verbs this CLI has. */
export const CONTROL_ACTIONS = Object.freeze(['status', 'cancel']);

/**
 * How long one control request may take, in ms.
 *
 * A control request is one bounded read (`observe` with `waitMs: 0`) or one cancel, so
 * it is fast by construction. The bound is deliberately much shorter than the MCP
 * server's own `DEFAULT_REQUEST_TIMEOUT_MS` (30 s): an operator asking "what is this
 * task doing" wants an answer or a clear failure, never a long block — that is the
 * whole point of a second channel.
 */
export const CONTROL_TIMEOUT_MS = 10_000;

/** Exit codes: a script can tell a refusal from a failure. */
export const EXIT = Object.freeze({
  ok: 0,
  // The plane answered, but with a refusal (unknown task, switch off, transport).
  refused: 1,
  // The command line itself was wrong.
  usage: 2,
});

/** Fields of a task this CLI may publish. Everything else stays on the plane. */
const TASK_FIELDS = Object.freeze([
  'taskId',
  'state',
  'phase',
  'createdAt',
  'startedAt',
  'endedAt',
  'elapsedMs',
  'lastActivityAt',
  'currentTool',
  'idleForMs',
  'route',
  'cancelledBy',
  'error',
]);

/**
 * Build the process configuration for this CLI.
 *
 * It is the MCP server's own configuration with one difference: the per-request bound
 * is the control bound (10 s), and the operator override
 * `DSH_DELEGATE_CONTROL_TIMEOUT_MS` may only LOWER it. A control answer is one bounded
 * read or one cancel, so "wait longer" is never what an operator wants here; a value
 * above the default is clamped DOWN to it rather than silently raising the bound the
 * comment (and the docs) promise.
 * @param {Record<string, string | undefined>} env - process environment.
 * @returns {{ baseUrl: string | null, discoveryFile: string, timeoutMs: number }} configuration.
 * @throws {Error} `MCP_CONFIG_INVALID` when the explicit endpoint override is unusable.
 */
export function readControlConfig(env = process.env) {
  const base = readConfig(env);
  const raw = Number(env.DSH_DELEGATE_CONTROL_TIMEOUT_MS);
  const requested = Number.isInteger(raw) && raw > 0 ? raw : null;
  return {
    baseUrl: base.baseUrl,
    discoveryFile: base.discoveryFile,
    timeoutMs: requested === null ? CONTROL_TIMEOUT_MS : Math.min(requested, CONTROL_TIMEOUT_MS),
  };
}

/** Longest string one published field may carry. */
const MAX_FIELD_CHARS = 400;

/** Fields of a nested object this CLI may publish, per key. */
const ROUTE_FIELDS = Object.freeze(['providerId', 'providerRoute', 'model', 'reasoningEffort', 'isolation']);
const TOOL_FIELDS = Object.freeze(['name', 'callId']);
const ERROR_FIELDS = Object.freeze(['code', 'message']);

/**
 * Bound one published scalar.
 *
 * Only a string, a finite number, a boolean or null is published, and a string is cut at
 * {@link MAX_FIELD_CHARS}. Everything else — an object where a name was expected, an
 * array, a function, a non-finite number — becomes null rather than reaching stdout as
 * an unbounded or mis-typed value.
 * @param {unknown} value - candidate.
 * @returns {string | number | boolean | null} bounded scalar.
 */
function boundedScalar(value) {
  if (typeof value === 'string') return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

/**
 * Bound one nested object to a fixed key set.
 * @param {unknown} value - candidate.
 * @param {readonly string[]} keys - the ONLY keys that may be published.
 * @returns {object | null} bounded object, or null when there is nothing to publish.
 */
function boundedObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    out[key] = boundedScalar(value[key]);
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Compact one task view for stdout.
 *
 * A control answer must never become a second `delegate_result`: no diff, no
 * execution text, no review prose, no conversation. Only identity, state, timing,
 * routing and the current tool are published. Every scalar is bounded and type-checked,
 * and the nested blocks are rebuilt from a fixed key list — so neither an oversized
 * field nor an unexpected nested object can make the answer unbounded or add fields
 * this CLI never promised.
 * @param {object | null | undefined} task - task view from the plane.
 * @returns {object} compact task.
 */
export function compactControlTask(task) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) return null;
  const out = {};
  for (const key of TASK_FIELDS) {
    if (task[key] === undefined) continue;
    const value = task[key];
    if (key === 'route') {
      const route = boundedObject(value, ROUTE_FIELDS);
      if (route !== null) out.route = route;
      continue;
    }
    if (key === 'currentTool') {
      const tool = boundedObject(value, TOOL_FIELDS);
      if (tool !== null) out.currentTool = tool;
      continue;
    }
    if (key === 'error') {
      const error = boundedObject(value, ERROR_FIELDS);
      if (error !== null) out.error = error;
      continue;
    }
    out[key] = boundedScalar(value);
  }
  return out;
}

/**
 * Validate one command line.
 * @param {string[]} argv - arguments after `node`.
 * @returns {{ ok: true, action: string, taskId: string } | { ok: false, code: string, message: string }} parsed command.
 */
export function parseControlArgs(argv) {
  if (argv.length !== 2) {
    return {
      ok: false,
      code: 'CONTROL_ARGS_INVALID',
      message: 'usage: dsh-delegate-control <status|cancel> <taskId>',
    };
  }
  const [action, taskId] = argv;
  if (!CONTROL_ACTIONS.includes(action)) {
    return {
      ok: false,
      code: 'CONTROL_ACTION_INVALID',
      message: `unknown action ${JSON.stringify(action)}; only ${CONTROL_ACTIONS.join(' and ')} exist`,
    };
  }
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    return { ok: false, code: 'CONTROL_TASK_ID_REQUIRED', message: 'a task id is required' };
  }
  // A task id is an opaque identifier the plugin issued. Rejecting control characters
  // and whitespace keeps the answer and the request body honest.
  if (!/^[A-Za-z0-9_.:-]{1,200}$/u.test(taskId)) {
    return { ok: false, code: 'CONTROL_TASK_ID_INVALID', message: 'the task id is not a task identifier this CLI accepts' };
  }
  return { ok: true, action, taskId };
}

/**
 * Run one control command against the loopback plane.
 *
 * This is the whole implementation, and it is injected-testable: `callExecution` is
 * the same seam the MCP server uses, so a test can prove the command reaches the
 * right plane route without a socket.
 * @param {string[]} argv - arguments after `node`.
 * @param {object} [deps] - `callExecution`, `config` (defaults to {@link readControlConfig}).
 * @returns {Promise<{ exitCode: number, output: object }>} exit code and the JSON document.
 */
export async function runControl(argv, deps = {}) {
  const parsed = parseControlArgs(argv);
  if (parsed.ok !== true) {
    return {
      exitCode: EXIT.usage,
      output: { ok: false, action: null, error: { code: parsed.code, message: parsed.message } },
    };
  }
  // Configuration is built INSIDE the guarded region: a bad `DSH_DELEGATE_BASE_URL`,
  // an unreadable env or an injectable client that throws while being created must
  // become the same bounded JSON refusal as any other failure, never an uncaught throw
  // that would reach `main` as a stack trace with non-JSON stdout.
  let callExecution;
  try {
    callExecution = deps.callExecution ?? createExecutionClient(deps.config ?? readControlConfig());
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'CONTROL_CONFIG_INVALID';
    const message = typeof error?.message === 'string'
      ? error.message.slice(0, MAX_FIELD_CHARS)
      : 'the control channel could not be configured';
    return {
      exitCode: EXIT.refused,
      output: { ok: false, action: parsed.action, taskId: parsed.taskId, error: { code, message } },
    };
  }
  try {
    if (parsed.action === 'status') {
      // The SAME bounded observation read the MCP wait composes, with a zero bound:
      // the plane answers with the task's current state immediately.
      const observation = await callExecution('observe', { taskId: parsed.taskId, waitMs: 0 });
      return {
        exitCode: EXIT.ok,
        output: {
          ok: true,
          action: 'status',
          taskId: parsed.taskId,
          // The compact state a host acts on. It is the plane's own report.
          reason: typeof observation?.reason === 'string' ? observation.reason : null,
          task: compactControlTask(observation?.task),
        },
      };
    }
    const result = await callExecution('cancel', { taskId: parsed.taskId });
    return {
      exitCode: EXIT.ok,
      output: {
        ok: true,
        action: 'cancel',
        taskId: parsed.taskId,
        state: typeof result?.task?.state === 'string' ? result.task.state : null,
        task: compactControlTask(result?.task),
      },
    };
  } catch (error) {
    // A refusal is the plane's answer, and it is reported as data: the caller learns
    // the stable code instead of a stack trace, and no message is invented here.
    const code = typeof error?.code === 'string' ? error.code : 'CONTROL_CALL_FAILED';
    const message = typeof error?.message === 'string' ? error.message.slice(0, 400) : 'the control request failed';
    return {
      exitCode: EXIT.refused,
      output: { ok: false, action: parsed.action, taskId: parsed.taskId, error: { code, message } },
    };
  }
}

/** Printed for `--help` and for a malformed command line. */
export const USAGE = [
  'Usage: dsh-delegate-control <status|cancel> <taskId>',
  '',
  '  status <taskId>   print the task\'s current compact state as JSON',
  '  cancel <taskId>   ask the harness to stop exactly that task, then print its state',
  '',
  'Uses the same loopback endpoint and discovery file as the dsh-delegate MCP server',
  '(DSH_DELEGATE_BASE_URL / DSH_DELEGATE_DISCOVERY_FILE are honoured identically).',
  'It cannot submit a task, change a setting, move the delegation switch, or cancel',
  'any task other than the one named. Exit code 0 = answered, 1 = refused, 2 = usage.',
].join('\n');

/**
 * Process entry point: one JSON document on stdout, diagnostics on stderr, and an
 * exit code that says what happened.
 * @param {string[]} argv - arguments after the script path.
 * @param {object} [io] - `stdout`/`stderr` writers, for tests.
 * @returns {Promise<number>} exit code.
 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const writeOut = io.stdout ?? ((text) => process.stdout.write(text));
  const writeErr = io.stderr ?? ((text) => process.stderr.write(text));
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    writeOut(`${USAGE}\n`);
    return EXIT.ok;
  }
  // A last line of defence: whatever happens below, stdout gets ONE JSON document and
  // nothing else. `runControl` already turns every failure it knows about into data, so
  // reaching this is a bug — but a bug must not become a stack trace on a channel whose
  // whole contract is machine-readable output.
  let outcome;
  try {
    outcome = await runControl(argv);
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'CONTROL_INTERNAL';
    outcome = { exitCode: EXIT.refused, output: { ok: false, action: null, error: { code, message: 'the control command failed' } } };
  }
  const { exitCode, output } = outcome;
  writeOut(`${JSON.stringify(output, null, 2)}\n`);
  if (exitCode !== EXIT.ok) {
    writeErr(`dsh-delegate-control: ${output?.error?.code ?? 'failed'}\n`);
  }
  return exitCode;
}

// Only run when executed directly; importing this module for tests must not read the
// environment, contact a plane or set an exit code.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = await main();
}
