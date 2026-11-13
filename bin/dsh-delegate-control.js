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
//   * `status` uses the bounded `observe` read with the SMALLEST POSITIVE wait
//     (`waitMs: 1`) — a compact task status answered at once, never a diff and never a
//     conversation transcript. It is deliberately not `waitMs: 0`: the engine and the
//     monitor treat a non-positive wait as "unspecified" and substitute their own
//     default bound (25 s), so a zero here waits exactly as long as a full long-poll
//     and blows this command's budget. `1` is the smallest value both sides keep;
//   * the WHOLE command — every attempt included — runs inside one caller budget
//     (10 s by default, may be lowered): one `AbortSignal` composed with the request
//     timeout, and the observation retry disabled for this call. Nothing is left
//     running after the answer, so no promise is raced against the process exiting;
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
 * How long one control command may take END TO END, in ms.
 *
 * The bound covers the whole command: client configuration, discovery, the request,
 * the request timeout and any retry the client would otherwise perform. A control
 * command is one bounded read (`observe` with the smallest positive wait) or one
 * cancel, so it is fast by construction. The bound is deliberately much shorter than
 * the MCP server's own `DEFAULT_REQUEST_TIMEOUT_MS` (30 s): an operator asking "what
 * is this task doing" wants an answer or a clear failure, never a long block — that
 * is the whole point of a second channel.
 *
 * It was already 10 s before this bound became real. What was NOT real: `status` sent
 * `waitMs: 0`, the engine and the monitor both treat a non-positive wait as
 * "unspecified" and substitute 25 s, so the request could not finish inside 10 s and
 * the observation retry then extended the whole command further. Both are fixed at
 * their source — the wait is {@link STATUS_WAIT_MS} and the retry is disabled for
 * this call — and the single signal below is what makes the budget the real bound
 * for every attempt rather than for one try.
 */
export const CONTROL_TIMEOUT_MS = 10_000;

/**
 * The observation bound `status` asks for, in ms.
 *
 * ONE millisecond, not zero. Zero is ACCEPTED by the HTTP route and then read by the
 * engine (`clampObserveWait`) and the monitor (`boundedWait`) as "no wait requested",
 * which they replace with their own 25-second default — the opposite of an immediate
 * answer, and longer than this command's whole budget. One millisecond is the smallest
 * positive value those two clamps keep, and it still answers from the task's CURRENT
 * state: a terminal task and a pending permission request are returned before any
 * timer is armed, an unfinished wait observes exactly one slice, and `status` never
 * reads a full result or a diff.
 */
export const STATUS_WAIT_MS = 1;

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
 *
 * That 10 s default is a WHOLE-COMMAND budget, not a per-attempt timeout: `runControl`
 * derives the single {@link AbortSignal} that bounds discovery, the request and the
 * client's own retry schedule from it. The default therefore applies even when a
 * caller passes a `deps.config` that carries no usable `timeoutMs` — an explicit
 * config is not a way to lose the bound.
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

/**
 * The whole-command budget one run may use, in ms.
 *
 * Read from the configuration the run actually uses, and never above
 * {@link CONTROL_TIMEOUT_MS}: a config whose `timeoutMs` is missing, non-finite or not
 * positive gets the documented default instead of an unbounded run, and a larger one
 * is clamped back to the documented maximum. A caller may only ever SHORTEN the
 * command, which is the same rule the environment override already follows.
 * @param {object | undefined} config - the run's configuration.
 * @returns {number} budget in milliseconds.
 */
function controlBudgetMs(config) {
  const configured = config?.timeoutMs;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) return CONTROL_TIMEOUT_MS;
  return Math.min(CONTROL_TIMEOUT_MS, Math.max(1, Math.trunc(configured)));
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
 *
 * ONE budget bounds the whole command. The caller's {@link AbortSignal} is handed to
 * the execution client, which composes it with its own per-request timeout, and the
 * observation retry is disabled for this call (`{ retry: false }`): a control command
 * must neither wait out a backoff schedule nor leave a request running after it has
 * answered. There is no `Promise.race` here on purpose — a race would answer while the
 * request it abandoned kept running, which is exactly what a second channel must not
 * do. The signal is the bound, and the client honours it before and after every
 * attempt.
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
  let config;
  try {
    config = deps.config ?? readControlConfig();
    callExecution = deps.callExecution ?? createExecutionClient(config);
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
  // The single bound of this command. It starts here — after the command line and the
  // configuration, which are local and synchronous — and is cleared in `finally`, so a
  // command that answered early leaves no armed timer behind.
  const budgetMs = controlBudgetMs(config);
  const budget = new AbortController();
  const timer = setTimeout(() => {
    try {
      budget.abort();
    } catch {
      // Abort is idempotent and cannot throw in practice.
    }
  }, budgetMs);
  timer.unref?.();
  const context = { signal: budget.signal, retry: false };
  try {
    let outcome;
    if (parsed.action === 'status') {
      // A compact status read, not a long poll: the smallest POSITIVE wait the engine
      // and the monitor both keep (see {@link STATUS_WAIT_MS}), against the existing
      // observation route. Nothing here can read a diff, a result body or a transcript.
      const observation = await callExecution('observe', { taskId: parsed.taskId, waitMs: STATUS_WAIT_MS }, context);
      outcome = {
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
    } else {
      const result = await callExecution('cancel', { taskId: parsed.taskId }, context);
      outcome = {
        exitCode: EXIT.ok,
        output: {
          ok: true,
          action: 'cancel',
          taskId: parsed.taskId,
          state: typeof result?.task?.state === 'string' ? result.task.state : null,
          task: compactControlTask(result?.task),
        },
      };
    }
    // The budget expiring while the answer was being assembled is still a timeout: the
    // client was told to give up at that instant, so an answer arriving afterwards is
    // not reported as success.
    if (budget.signal.aborted === true) throw budgetExpired(budgetMs);
    return outcome;
  } catch (error) {
    // A refusal is the plane's answer, and it is reported as data: the caller learns
    // the stable code instead of a stack trace, and no message is invented here. An
    // exhausted budget is its own code, so an operator can tell "too slow" from
    // "refused".
    const expired = budget.signal.aborted === true;
    const code = expired ? 'CONTROL_TIMEOUT' : (typeof error?.code === 'string' ? error.code : 'CONTROL_CALL_FAILED');
    const message = expired
      ? `the control command did not answer within ${budgetMs} ms`
      : (typeof error?.message === 'string' ? error.message.slice(0, MAX_FIELD_CHARS) : 'the control request failed');
    return {
      exitCode: EXIT.refused,
      output: { ok: false, action: parsed.action, taskId: parsed.taskId, error: { code, message } },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The error shape of an exhausted command budget.
 * @param {number} budgetMs - the budget that expired.
 * @returns {Error} error carrying the stable code.
 */
function budgetExpired(budgetMs) {
  const error = new Error(`the control command did not answer within ${budgetMs} ms`);
  error.code = 'CONTROL_TIMEOUT';
  return error;
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
  'One command answers within a single bound: 10 s by default, and',
  'DSH_DELEGATE_CONTROL_TIMEOUT_MS may only lower it. It never retries, and it does not',
  'poll: a normal wait stays silent.',
  'It cannot submit a task, change a setting, move the delegation switch, or cancel',
  'any task other than the one named. Exit code 0 = answered, 1 = refused or timed out,',
  '2 = usage.',
].join('\n');

/**
 * Process entry point: one JSON document on stdout, diagnostics on stderr, and an
 * exit code that says what happened.
 * @param {string[]} argv - arguments after the script path.
 * @param {object} [io] - `stdout`/`stderr` writers and optional `callExecution`/`config`
 *   dependencies, so an imported entry-point test never contacts the real harness.
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
    outcome = await runControl(argv, io);
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
