// Type declarations for the independent control CLI (`bin/dsh-delegate-control.js`).
//
// The file is both an executable and an importable module: importing it must not read
// the environment, contact a plane or touch `process.exitCode`. These declarations
// describe that importable surface, which is what the tests drive.

import type { ExecutionCallContext, ExecutionAnswer, ExecutionRoute, McpConfig } from './dsh-delegate-mcp.js';

/** The only two verbs this CLI has. There is no submit, settings or switch verb. */
export declare const CONTROL_ACTIONS: readonly ['status', 'cancel'];

/** How long ONE control command may take end to end, in milliseconds (10 s). */
export declare const CONTROL_TIMEOUT_MS: number;

/**
 * The observation bound `status` requests, in milliseconds (1).
 *
 * The smallest POSITIVE wait: the engine and the monitor treat a non-positive wait as
 * "unspecified" and substitute their 25 s default, so `0` would be a long poll, not a
 * status read.
 */
export declare const STATUS_WAIT_MS: number;

/** Exit codes: a script can tell a refusal from a failure. */
export declare const EXIT: Readonly<{ ok: 0, refused: 1, usage: 2 }>;

/**
 * Configuration for one control invocation.
 *
 * `timeoutMs` is the WHOLE-COMMAND budget and is at most {@link CONTROL_TIMEOUT_MS}: the
 * operator override `DSH_DELEGATE_CONTROL_TIMEOUT_MS` may only LOWER the bound, never
 * raise it. A missing or unusable `timeoutMs` falls back to the 10 s default.
 */
export interface ControlConfig extends McpConfig {}

/** Read the control configuration from the environment. */
export declare function readControlConfig(env?: Record<string, string | undefined>): ControlConfig;

/** Compact one task view for stdout (no diff, no conversation, no secrets). */
export declare function compactControlTask(task: object | null | undefined): object | null;

/** One published scalar: a bounded string, a finite number, a boolean, or null. */
export type ControlScalar = string | number | boolean | null;

/**
 * Validate one command line.
 *
 * A malformed command line answers `{ ok: false, code, message }`; the codes are
 * `CONTROL_ARGS_INVALID`, `CONTROL_ACTION_INVALID`, `CONTROL_TASK_ID_REQUIRED` and
 * `CONTROL_TASK_ID_INVALID`.
 */
export declare function parseControlArgs(
  argv: string[],
): { ok: true, action: 'status' | 'cancel', taskId: string } | { ok: false, code: string, message: string };

/** One answer: the exit code and the single JSON document for stdout. */
export interface ControlOutcome {
  exitCode: number;
  output: Record<string, unknown>;
}

/**
 * Run one control command against the loopback plane.
 *
 * `status` issues exactly one bounded `observe` with `waitMs: STATUS_WAIT_MS`; `cancel`
 * issues one `cancel` for the named task and nothing else. The whole command runs under
 * one caller budget: the client receives `{ signal, retry: false }`, so the observation
 * retry is disabled for it and nothing keeps running after the answer. A refusal —
 * including an exhausted budget (`CONTROL_TIMEOUT`) — is reported as data
 * (`{ ok: false, error: { code, message } }`) with a non-zero exit code.
 */
export declare function runControl(
  argv: string[],
  deps?: {
    callExecution?: (route: ExecutionRoute, payload: object, context?: ExecutionCallContext) => Promise<ExecutionAnswer>;
    config?: ControlConfig;
  },
): Promise<ControlOutcome>;

/** The usage text printed for `--help`. */
export declare const USAGE: string;

/**
 * Process entry point: one JSON document on stdout, diagnostics on stderr, and an
 * exit code that says what happened.
 */
export declare function main(
  argv?: string[],
  io?: { stdout?: (text: string) => void, stderr?: (text: string) => void },
): Promise<number>;
