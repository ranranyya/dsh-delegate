#!/usr/bin/env node
// Stdio MCP entry point.
//
// This is the executable a DSH `mcp-client` instance spawns. It is deliberately
// thin: resolve the DSH listener from its runtime discovery file, forward each
// tool call to the loopback execution plane, and print JSON-RPC on stdout. It
// holds no state, opens no port, and writes nothing to stdout except protocol messages — a stray
// `console.log` here would corrupt the stream, so diagnostics go to stderr.
//
//   DSH_DELEGATE_BASE_URL       optional fixed endpoint override
//   DSH_DELEGATE_DISCOVERY_FILE optional discovery-file override

import { fileURLToPath } from 'node:url';

import { createMcpServer, serveStdio, DEFAULT_REQUEST_TIMEOUT_MS, McpError } from '../src/mcp/server.js';
import { readRuntimeEndpoint, resolveEndpointDiscoveryPath } from '../src/runtime/endpoint-discovery.js';

/**
 * Read the endpoint configuration for the local DSH instance.
 * @param {Record<string, string | undefined>} env - process environment.
 * @returns {{ baseUrl: string | null, discoveryFile: string, timeoutMs: number }} configuration.
 */
export function readConfig(env) {
  const configuredUrl = (env.DSH_DELEGATE_BASE_URL ?? '').trim();
  let baseUrl = null;
  if (configuredUrl !== '') {
    let parsed;
    try {
      parsed = new URL(configuredUrl);
    } catch {
      throw new McpError('MCP_CONFIG_INVALID', 'DSH_DELEGATE_BASE_URL is not an absolute URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new McpError('MCP_CONFIG_INVALID', 'DSH_DELEGATE_BASE_URL must be http or https');
    }
    baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/$/u, '')}`;
  }
  const raw = Number(env.DSH_DELEGATE_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 600_000) : DEFAULT_REQUEST_TIMEOUT_MS;
  return {
    baseUrl,
    discoveryFile: resolveEndpointDiscoveryPath(env),
    timeoutMs,
  };
}

/** Execution-plane prefix, relative to the base URL. */
const EXECUTION_PREFIX = '/dsh-delegate/x';

/**
 * Tool route → the exact `METHOD path` the execution plane registers.
 *
 * This table is the whole wire contract, and it is derived from the serving side
 * (`src/http/execution-plane.js`) rather than from the tool names. The tool named
 * `delegate_result` reads through the plane's `POST /tasks/get` route: the plane
 * has never served `/tasks/result`, so a name-to-path scheme produced a 404
 * `EXECUTION_ROUTE_UNKNOWN` for every result read. Routes are spelled out here,
 * one per tool, and no path is accepted that the plane does not register.
 */
const ROUTES = Object.freeze({
  status: Object.freeze({ method: 'GET', path: '/status' }),
  submit: Object.freeze({ method: 'POST', path: '/tasks' }),
  result: Object.freeze({ method: 'POST', path: '/tasks/get' }),
  cancel: Object.freeze({ method: 'POST', path: '/tasks/cancel' }),
  // A bounded long-poll read used by `delegate_wait`. Spelled out like every other
  // route: it is the one call a long wait repeats, so a guessed path would 404 on
  // the only mechanism a host has to follow a task without polling `result`.
  observe: Object.freeze({ method: 'POST', path: '/tasks/observe' }),
  // The one per-call permission decision. Spelled out like every other route: the
  // plane registers exactly this path, and a name-to-path guess would 404 with
  // `EXECUTION_ROUTE_UNKNOWN` on the one call that unblocks a paused worker.
  permission: Object.freeze({ method: 'POST', path: '/tasks/permission' }),
  // Read-only workspace facts. Registered on the execution plane beside `/status`
  // so it answers with the switch off; it creates nothing to clean up.
  preflight: Object.freeze({ method: 'POST', path: '/workspace/preflight' }),
});

/**
 * Backoff between attempts while the DSH endpoint cannot be reached, in ms.
 *
 * `delegate_wait` may spend minutes following one task, and over that time the DSH
 * process can restart (a new port, or none for a moment). Treating that as a
 * terminal MCP failure would make a host believe the delegation had ended. The
 * schedule is deliberately short and finite: three sleeps, so a permanently dead
 * endpoint produces a compact actionable error inside ~8 s instead of hanging.
 */
export const ENDPOINT_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000]);

/**
 * Total budget for retrying one internal request, in ms.
 *
 * The sum of {@link ENDPOINT_RETRY_DELAYS_MS} is 8 s, so this is never the binding
 * constraint in practice; it is stated so a future change to the schedule cannot
 * silently turn a bounded wait into an unbounded one.
 */
export const ENDPOINT_RETRY_BUDGET_MS = 30_000;

/**
 * Build the HTTP call the MCP tools use.
 *
 * Every refusal is normalized into an `McpError` carrying the harness's own code,
 * so a tool result says `GRANT_UNKNOWN` rather than `HTTP 404`.
 *
 * `context.signal` is the caller's own cancellation (one MCP request, e.g. a
 * `notifications/cancelled`). It is composed with the per-request timeout into a
 * single signal, so an aborted wait ends the FETCH and nothing else: the harness
 * answers a disconnected observer without changing the task it was observing. The
 * timeout must remain in force on its own, so the composition is `AbortSignal.any`
 * of the two rather than one replacing the other.
 *
 * Discovery is reread on EVERY internal request (not cached per call), which is
 * what lets a wait survive a DSH restart onto a new port. Only unpolled failures
 * are retried, and only for the observation route: an ordinary tool call keeps its
 * single attempt, because repeating a submission is not a safe thing to do.
 *
 * `context.retry === false` disables that observation retry for ONE call. It exists
 * for the control CLI, whose whole contract is "answer inside one short budget": the
 * retry schedule (1 s + 2 s + 5 s of sleeping, plus four attempts) would either
 * outlive that budget or leave a request running after the CLI has answered. The
 * default (absent context, or any other value) is unchanged, so `delegate_wait`
 * keeps following a DSH restart exactly as before.
 * @param {object} config - value from {@link readConfig}.
 * @param {object} [options] - `sleep` (injectable for tests), `now`, `fetch` (injectable
 *   transport, for tests and for a caller that owns its own HTTP stack).
 * @returns {(route: string, payload: object, context?: { signal?: AbortSignal, retry?: boolean }) => Promise<object>} call function.
 */
export function createExecutionClient(config, options = {}) {
  const sleep = options.sleep ?? ((ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); }));
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : null;

  /**
   * Perform one request, with the retry policy of its route.
   * @param {string} route - route name.
   * @param {object} entry - route table entry.
   * @param {object} payload - request body.
   * @param {AbortSignal | undefined} callerSignal - the caller's own cancellation.
   * @returns {Promise<object>} parsed `ok:true` body.
   */
  return async function callExecution(route, payload, context = {}) {
    const entry = ROUTES[route];
    if (entry === undefined) {
      // An unmapped route would otherwise be sent as a path the plane does not
      // serve, which surfaces as an HTTP 404 that looks like a harness fault.
      throw new McpError('MCP_ROUTE_UNMAPPED', `no execution-plane route is defined for ${JSON.stringify(route)}`);
    }
    const callerSignal = context?.signal;
    // A route that is safe to repeat may back off and try again; everything else
    // gets exactly one attempt. A caller may also opt out of the retry for its own
    // call (`context.retry === false`): only an explicit `false` disables it, so a
    // caller that passes no context keeps the default MCP policy untouched.
    const retryable = route === 'observe' && context?.retry !== false;
    const delays = retryable ? ENDPOINT_RETRY_DELAYS_MS : [];
    let spent = 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await attemptOnce(entry, payload, callerSignal, config);
      } catch (error) {
        const delay = delays[attempt];
        const retry = error?.code === 'MCP_HARNESS_UNREACHABLE'
          && typeof delay === 'number'
          && spent + delay <= ENDPOINT_RETRY_BUDGET_MS
          && callerSignal?.aborted !== true;
        if (!retry) throw error;
        spent += delay;
        await sleep(delay);
        if (callerSignal?.aborted === true) throw abortedError();
      }
    }
  };

  /**
   * One attempt at one execution-plane request.
   * @param {object} entry - route table entry.
   * @param {object} payload - request body.
   * @param {AbortSignal | undefined} callerSignal - cancellation.
   * @param {object} configValue - client configuration.
   * @returns {Promise<object>} parsed `ok:true` body.
   */
  async function attemptOnce(entry, payload, callerSignal, configValue) {
    const method = entry.method;
    const path = `${EXECUTION_PREFIX}${entry.path}`;
    const baseUrl = configValue.baseUrl ?? (await readRuntimeEndpoint(configValue.discoveryFile)).baseUrl;
    const timeout = AbortSignal.timeout(configValue.timeoutMs);
    // `AbortSignal.any` is absent on a host that is older than the runtimes this
    // package supports; the timeout alone then applies, which is the behaviour
    // before this argument existed and still bounds every request.
    const signal = callerSignal !== undefined && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeout, callerSignal])
      : timeout;
    let response;
    try {
      const doFetch = fetchImpl ?? fetch;
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
        signal,
      });
    } catch (error) {
      // Our own cancellation is reported as such, with no URL and no socket text:
      // the caller asked for this and knows which request it cancelled.
      if (callerSignal?.aborted === true) throw abortedError();
      // The transport failure is reported without the URL: it may carry a port an
      // operator considers private, and it never helps the caller.
      throw new McpError(
        'MCP_HARNESS_UNREACHABLE',
        `the DSH delegation endpoint could not be reached (${error?.name ?? 'transport error'})`,
      );
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      if (callerSignal?.aborted === true) throw abortedError();
      body = null;
    }
    if (body === null || typeof body !== 'object') {
      throw new McpError('MCP_HARNESS_MALFORMED', `the delegation endpoint answered HTTP ${response.status} without JSON`);
    }
    if (response.ok !== true || body.ok !== true) {
      const failure = typeof body.error === 'object' && body.error !== null ? body.error : {};
      throw new McpError(
        typeof failure.code === 'string' ? failure.code : `MCP_HTTP_${response.status}`,
        typeof failure.message === 'string' ? failure.message : `the delegation endpoint answered HTTP ${response.status}`,
      );
    }
    return body;
  }
}

/**
 * The one refusal a locally cancelled request throws.
 * @returns {McpError} refusal carrying the stable code.
 */
function abortedError() {
  return new McpError('MCP_REQUEST_CANCELLED', 'the request was cancelled by the host');
}

/**
 * Start the server on stdio.
 * @returns {Promise<void>} resolves when stdin closes.
 */
async function main() {
  let config;
  try {
    config = readConfig(process.env);
  } catch (error) {
    // Startup refusal goes to stderr and the exit code is non-zero, so the DSH
    // mcp-client reports a failed server rather than a connected one with no tools.
    process.stderr.write(`dsh-delegate-mcp: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const server = createMcpServer({
    callExecution: createExecutionClient(config),
    logger: { warn: (...args) => process.stderr.write(`dsh-delegate-mcp: ${args.join(' ')}\n`) },
  });
  await serveStdio({
    input: process.stdin,
    output: process.stdout,
    server,
    onError: (error) => process.stderr.write(`dsh-delegate-mcp: ${error?.name ?? 'error'}\n`),
  });
}

// Only run when executed directly; importing this module for tests must not start
// a stdio loop or touch process.exitCode.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
