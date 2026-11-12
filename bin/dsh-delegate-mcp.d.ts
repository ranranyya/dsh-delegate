// Type declarations for the stdio MCP executable (`bin/dsh-delegate-mcp.js`).
//
// The file is both an executable and an importable module: importing it must not
// start a stdio loop or touch `process.exitCode`, which is what lets a test drive
// {@link readConfig} and {@link createExecutionClient} directly. These declarations
// describe that importable surface.

/**
 * Process configuration parsed from the environment (never from argv).
 *
 * The base URL is discovered from the running DSH plugin unless explicitly set
 * through `DSH_DELEGATE_BASE_URL`. The discovery file can be overridden with
 * `DSH_DELEGATE_DISCOVERY_FILE`; otherwise it follows `DSH_HOME` or `~/.dsh`.
 */
export interface McpConfig {
  /** Configured origin, or null to reread the running DSH endpoint on each call. */
  baseUrl: string | null;
  /** Absolute path to the DSH plugin's runtime endpoint discovery record. */
  discoveryFile: string;
  /** Per-call bound in milliseconds. */
  timeoutMs: number;
}

/** Error codes `readConfig` refuses with. */
export type McpConfigErrorCode = 'MCP_CONFIG_INVALID';

/**
 * Read the environment configuration this process needs.
 *
 * Throws an `McpError` with code {@link McpConfigErrorCode} when an explicit
 * base URL is not an absolute http(s) URL.
 * @param env - process environment.
 */
export declare function readConfig(env: Record<string, string | undefined>): McpConfig;

/**
 * Execution-plane route names the MCP tools dispatch to.
 *
 * Each name maps to one exact registered path:
 *
 * - `status`    → `GET  /dsh-delegate/x/status`
 * - `submit`    → `POST /dsh-delegate/x/tasks`
 * - `result`    → `POST /dsh-delegate/x/tasks/get`
 * - `observe`   → `POST /dsh-delegate/x/tasks/observe` (bounded long-poll read)
 * - `cancel`    → `POST /dsh-delegate/x/tasks/cancel`
 * - `permission`→ `POST /dsh-delegate/x/tasks/permission`
 * - `preflight` → `POST /dsh-delegate/x/workspace/preflight`
 *
 * `observe` backs `delegate_wait`; `preflight` is the read-only workspace
 * inspection behind `delegate_preflight`, and it creates nothing.
 */
export type ExecutionRoute = 'submit' | 'status' | 'result' | 'observe' | 'cancel' | 'permission' | 'preflight';

/**
 * Per-call context passed beside the route and payload.
 *
 * `signal` is the host's own cancellation of THIS request (for example a JSON-RPC
 * `notifications/cancelled`). It is composed with the client's request timeout, so
 * an aborted call ends the HTTP request and nothing else: the harness answers a
 * disconnected observer without changing the task it was observing.
 */
export interface ExecutionCallContext {
  signal?: AbortSignal;
}

/**
 * One execution-plane answer. Every successful route answers `ok: true`; a refusal
 * is thrown as an `McpError` carrying the harness's own code.
 */
export interface ExecutionAnswer {
  ok: true;
  [field: string]: unknown;
}

/**
 * Backoff between attempts while the endpoint is unreachable, in milliseconds.
 *
 * The sum (8 s) is far below {@link ENDPOINT_RETRY_BUDGET_MS}; a permanently dead
 * endpoint therefore produces a compact refusal instead of a hanging wait.
 */
export declare const ENDPOINT_RETRY_DELAYS_MS: readonly number[];

/** Total budget for retrying one internal request, in milliseconds. */
export declare const ENDPOINT_RETRY_BUDGET_MS: number;

/**
 * Injectable seams for tests. Production passes none of them.
 *
 * `sleep` is used between endpoint retries; a test replaces it so a transient
 * disconnect can be exercised without actually waiting seconds. `fetch` replaces the
 * global transport for a caller that owns its own HTTP stack (and for a test that must
 * not open a socket); the retry policy, timeout and refusal mapping are unchanged.
 */
export interface ExecutionClientOptions {
  sleep?: (ms: number) => Promise<void>;
  fetch?: (url: string, init: object) => Promise<{ ok: boolean, status: number, json: () => Promise<unknown> }>;
}

/**
 * Build the HTTP call the MCP tools use.
 *
 * Every refusal is normalized into an `McpError` carrying the harness's own code,
 * so a tool result says `GRANT_UNKNOWN` rather than `HTTP 404`. The runtime
 * discovery record is reread before EACH internal request, so a wait survives a
 * DSH restart onto another port; only the `observe` route retries an unreachable
 * endpoint (bounded backoff), because repeating a submission would be unsafe.
 * @param config - value from {@link readConfig}.
 * @param options - optional test seams.
 */
export declare function createExecutionClient(
  config: McpConfig,
  options?: ExecutionClientOptions,
): (route: ExecutionRoute, payload: object, context?: ExecutionCallContext) => Promise<ExecutionAnswer>;
