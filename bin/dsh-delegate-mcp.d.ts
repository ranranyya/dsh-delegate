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

/** Execution-plane route names the MCP tools dispatch to. */
export type ExecutionRoute = 'submit' | 'status' | 'result' | 'cancel';

/**
 * Build the HTTP call the MCP tools use.
 *
 * Every refusal is normalized into an `McpError` carrying the harness's own code,
 * so a tool result says `GRANT_UNKNOWN` rather than `HTTP 404`.
 * @param config - value from {@link readConfig}.
 */
export declare function createExecutionClient(
  config: McpConfig,
): (route: ExecutionRoute, payload: object) => Promise<{ ok: true; [field: string]: unknown }>;
