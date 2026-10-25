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
  // Read-only workspace facts. Registered on the execution plane beside `/status`
  // so it answers with the switch off; it creates nothing to clean up.
  preflight: Object.freeze({ method: 'POST', path: '/workspace/preflight' }),
});

/**
 * Build the HTTP call the MCP tools use.
 *
 * Every refusal is normalized into an `McpError` carrying the harness's own code,
 * so a tool result says `GRANT_UNKNOWN` rather than `HTTP 404`.
 * @param {object} config - value from {@link readConfig}.
 * @returns {(route: string, payload: object) => Promise<object>} call function.
 */
export function createExecutionClient(config) {
  return async function callExecution(route, payload) {
    const entry = ROUTES[route];
    if (entry === undefined) {
      // An unmapped route would otherwise be sent as a path the plane does not
      // serve, which surfaces as an HTTP 404 that looks like a harness fault.
      throw new McpError('MCP_ROUTE_UNMAPPED', `no execution-plane route is defined for ${JSON.stringify(route)}`);
    }
    const method = entry.method;
    const path = `${EXECUTION_PREFIX}${entry.path}`;
    const baseUrl = config.baseUrl ?? (await readRuntimeEndpoint(config.discoveryFile)).baseUrl;
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
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
  };
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
