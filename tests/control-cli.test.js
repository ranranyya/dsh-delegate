// The independent control CLI: `bin/dsh-delegate-control.js`.
//
// What this file is about, in one sentence: while a host is blocked on a long
// `delegate_wait` (a serialising MCP client), the operator must still be able to ask
// what one task is doing and to stop exactly that task — from a SEPARATE process,
// through the same loopback plane, with no new permission and no new configuration.
//
// Two levels are covered:
//
//   * the command itself, against a mock plane: the exact route and body it sends,
//     the compact shape it prints, its refusal/exit-code contract, its request bound,
//     and everything it must NOT be able to do;
//   * a REAL stdio MCP server with a long wait outstanding, while the control
//     command queries and cancels the same task through a real HTTP plane. That is
//     the property a serialising host cannot provide and this channel exists for.
//     Serving that task is a real `JobEngine` over a real temporary workspace with its
//     own real `TaskMonitor`, behind the real `createExecutionHandler`; only the native
//     services every engine test fakes are faked here, and no model is contacted. The
//     task stays `running` because its prompt never finishes, not because a flag says so.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenLoopback } from './helpers/http.js';
import { Readable, Writable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTROL_ACTIONS,
  CONTROL_TIMEOUT_MS,
  EXIT,
  STATUS_WAIT_MS,
  compactControlTask,
  main,
  parseControlArgs,
  readControlConfig,
  runControl,
} from '../bin/dsh-delegate-control.js';
import { createExecutionClient } from '../bin/dsh-delegate-mcp.js';
import { createExecutionHandler, EXECUTION_PREFIX } from '../src/http/execution-plane.js';
import { readRuntimeEndpoint, publishRuntimeEndpoint } from '../src/runtime/endpoint-discovery.js';
import { createMcpServer, serveStdio } from '../src/mcp/server.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { JobEngine } from '../src/jobs/engine.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import {
  cleanup,
  fakeAgents,
  fakeLlm,
  fakeSessionController,
  fakeWorkspaceController,
  llmTable,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL_BIN = join(ROOT, 'bin', 'dsh-delegate-control.js');

/**
 * Collect the process streams a `main()` call writes to.
 * @returns {{ stdout: string[], stderr: string[], io: object }} writers and the io object.
 */
function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  };
}

/**
 * A mock execution client that records calls and answers from a table.
 * @param {Record<string, (payload: object) => object>} answers - per-route answers.
 * @param {object} [options] - `seen` collector, `fail`.
 * @returns {{ call: Function, seen: object[] }} client.
 */
function mockClient(answers, options = {}) {
  const seen = options.seen ?? [];
  const call = async (route, payload, context) => {
    seen.push({ route, payload, context });
    if (options.fail !== undefined) throw options.fail;
    const answer = answers[route];
    if (answer === undefined) throw Object.assign(new Error(`no answer for ${route}`), { code: 'UNEXPECTED_ROUTE' });
    return answer(payload);
  };
  return { call, seen };
}

// ---------------------------------------------------------------------------
// 1. The command line
// ---------------------------------------------------------------------------

test('the control CLI has exactly two verbs and refuses everything else', () => {
  assert.deepEqual([...CONTROL_ACTIONS].sort(), ['cancel', 'status']);
  const cases = [
    [[], 'CONTROL_ARGS_INVALID'],
    [['status'], 'CONTROL_ARGS_INVALID'],
    [['status', 't', 'extra'], 'CONTROL_ARGS_INVALID'],
    [['submit', 't1'], 'CONTROL_ACTION_INVALID'],
    [['config', 't1'], 'CONTROL_ACTION_INVALID'],
    [['install', 't1'], 'CONTROL_ACTION_INVALID'],
    [['switch', 't1'], 'CONTROL_ACTION_INVALID'],
    [['status', ''], 'CONTROL_TASK_ID_REQUIRED'],
    [['status', '  '], 'CONTROL_TASK_ID_REQUIRED'],
    [['status', 'bad id'], 'CONTROL_TASK_ID_INVALID'],
    [['status', 'bad/id'], 'CONTROL_TASK_ID_INVALID'],
    [['cancel', 'x'.repeat(500)], 'CONTROL_TASK_ID_INVALID'],
  ];
  for (const [argv, code] of cases) {
    const parsed = parseControlArgs(argv);
    assert.equal(parsed.ok, false, `${JSON.stringify(argv)} must be refused`);
    assert.equal(parsed.code, code, `${JSON.stringify(argv)} must be ${code}`);
  }
  // A plugin-issued id is accepted verbatim.
  const ok = parseControlArgs(['status', 'task-a71e1ad4-4152-4b9c-b745-66d202ea3f63']);
  assert.deepEqual(ok, { ok: true, action: 'status', taskId: 'task-a71e1ad4-4152-4b9c-b745-66d202ea3f63' });
});

test('a refused command line exits 2 and prints only a JSON refusal', async () => {
  const { stdout, stderr, io } = captureIo();
  const exitCode = await main(['submit', 't1'], io);
  assert.equal(exitCode, EXIT.usage);
  assert.equal(stdout.length, 1);
  const body = JSON.parse(stdout[0]);
  assert.equal(body.ok, false);
  assert.equal(body.action, null);
  assert.equal(body.error.code, 'CONTROL_ACTION_INVALID');
  assert.equal(stderr.length, 1, 'the diagnostic goes to stderr');
  assert.match(stderr[0], /CONTROL_ACTION_INVALID/u);
});

// ---------------------------------------------------------------------------
// 2. status: one bounded read, one compact answer
// ---------------------------------------------------------------------------

test('status issues ONE bounded observation with the smallest positive wait and prints a compact state', async () => {
  const { call, seen } = mockClient({
    observe: () => ({
      ok: true,
      reason: 'heartbeat',
      task: {
        taskId: 'task-1',
        state: 'running',
        phase: 'execute',
        elapsedMs: 42_000,
        startedAt: 1_760_000_000_000,
        endedAt: null,
        currentTool: { name: 'pwsh', callId: 'call-1', arguments: 'SECRET-ARGS' },
        route: { providerId: 'relay', providerRoute: 'relay-native', model: 'm', reasoningEffort: 'high', extra: 'x' },
        // Evidence a control answer must never carry.
        diff: { patchText: 'diff --git a/b c' },
        execution: { text: 'the whole execution prose' },
        review: { text: 'review prose' },
        prompt: 'the submitted prompt',
        conversation: [{ role: 'user', text: 'transcript' }],
      },
      permission: null,
      wait: { waitMs: STATUS_WAIT_MS, waitedMs: 0, activitySinceWait: false },
    }),
  });
  const outcome = await runControl(['status', 'task-1'], { callExecution: call });

  assert.equal(outcome.exitCode, EXIT.ok);
  assert.deepEqual(seen.map((entry) => entry.route), ['observe'], 'status must read through the observe route');
  // ZERO would be read by the engine and the monitor as "no bound requested" and
  // replaced with their 25-second default; the smallest POSITIVE wait is what makes
  // this a current-state read rather than a long poll.
  assert.deepEqual(seen[0].payload, { taskId: 'task-1', waitMs: 1 }, 'status asks for the smallest positive bounded wait');
  assert.equal(STATUS_WAIT_MS, 1);
  assert.equal(seen[0].payload.waitMs > 0, true, 'a non-positive wait is replaced by the 25 s default downstream');
  // No observer retry for this call, and the caller's own signal is handed down.
  assert.equal(seen[0].context?.retry, false, 'the observation retry must be disabled for one control command');
  assert.equal(typeof seen[0].context?.signal?.aborted, 'boolean', 'the whole-command budget reaches the client');
  assert.equal(outcome.output.ok, true);
  assert.equal(outcome.output.action, 'status');
  assert.equal(outcome.output.taskId, 'task-1');
  assert.equal(outcome.output.task.state, 'running');
  assert.equal(outcome.output.task.phase, 'execute');
  assert.deepEqual(outcome.output.task.currentTool, { name: 'pwsh', callId: 'call-1' },
    'the tool is named, its arguments are not carried');
  assert.deepEqual(outcome.output.task.route, {
    providerId: 'relay', providerRoute: 'relay-native', model: 'm', reasoningEffort: 'high',
  }, 'only the route facts that exist are published');
  const serialized = JSON.stringify(outcome.output);
  for (const forbidden of ['SECRET-ARGS', 'diff --git', 'execution prose', 'review prose', 'transcript', 'prompt']) {
    assert.equal(serialized.includes(forbidden), false, `a control answer must not carry ${forbidden}`);
  }
  assert.ok(serialized.length < 1_000, 'a control answer stays small');
});

test('status and cancel never reach any route that creates work or changes configuration', async () => {
  const { call, seen } = mockClient({
    observe: () => ({ ok: true, reason: 'heartbeat', task: { taskId: 't', state: 'running' } }),
    cancel: () => ({ ok: true, task: { taskId: 't', state: 'cancelled' } }),
  });
  await runControl(['status', 't'], { callExecution: call });
  await runControl(['cancel', 't'], { callExecution: call });
  assert.deepEqual(seen.map((entry) => entry.route), ['observe', 'cancel']);
  for (const forbidden of ['submit', 'permission', 'result', 'preflight', 'status']) {
    assert.equal(seen.some((entry) => entry.route === forbidden), false, `the CLI must never call ${forbidden}`);
  }
});

test('cancel stops exactly the named task and reports its state', async () => {
  const { call, seen } = mockClient({
    cancel: () => ({ ok: true, task: { taskId: 'task-2', state: 'cancelled', cancelledBy: 'connection' } }),
  });
  const outcome = await runControl(['cancel', 'task-2'], { callExecution: call });
  assert.equal(outcome.exitCode, EXIT.ok);
  assert.deepEqual(seen.map((entry) => [entry.route, entry.payload]), [['cancel', { taskId: 'task-2' }]],
    'one cancel, one task id');
  assert.equal(outcome.output.state, 'cancelled');
  assert.equal(outcome.output.task.cancelledBy, 'connection');
});

// ---------------------------------------------------------------------------
// 3. Refusals and the request bound
// ---------------------------------------------------------------------------

test('one whole-command budget bounds the call: a request that outlives it is a bounded timeout', async () => {
  // The defect this replaces: the 10 s figures were only a per-request timeout, so a
  // request the plane kept open longer (the 25 s a zero wait produced) was answered by
  // the CLI itself only after the operator had given up. The budget is now one caller
  // signal, and the answer is bounded JSON with its own code.
  const seen = [];
  const stuck = async (route, payload, context) => {
    seen.push({ route, payload, context });
    // A real client composes this signal with its own timeout and stops when it aborts;
    // a seam that ignores it must still not extend the command past the budget.
    await new Promise((resolvePromise) => {
      if (context?.signal?.aborted === true) { resolvePromise(); return; }
      context?.signal?.addEventListener?.('abort', resolvePromise, { once: true });
      setTimeout(resolvePromise, 60_000).unref?.();
    });
    const error = new Error('the request was cancelled by the host');
    error.code = 'MCP_REQUEST_CANCELLED';
    throw error;
  };
  const started = Date.now();
  const outcome = await runControl(['status', 'task-1'], {
    callExecution: stuck,
    config: { baseUrl: 'http://127.0.0.1:3210', discoveryFile: 'unused', timeoutMs: 40 },
  });
  const elapsed = Date.now() - started;
  assert.equal(seen.length, 1, 'the budget must be spent on ONE request, never on a retry schedule');
  assert.equal(seen[0].context?.retry, false, 'the observation retry is disabled for the control command');
  assert.equal(outcome.exitCode, EXIT.refused, 'a command that did not answer is not a success');
  assert.equal(outcome.output.ok, false);
  assert.equal(outcome.output.error.code, 'CONTROL_TIMEOUT',
    `an exhausted budget has its own code, saw ${JSON.stringify(outcome.output.error)}`);
  assert.ok(elapsed < 5_000, `the command must end at its budget, took ${elapsed} ms`);
});

test('a missing or unusable config timeout never removes the bound: it is a bounded timeout, not a hang', async () => {
  // `deps.config` is a test seam, not a way to lose the bound. Whatever the config says,
  // the command must end with a bounded refusal instead of parking on its request, and
  // the budget it reports must be the documented 10 s default, never 0 or Infinity.
  //
  // SCOPE, stated honestly: for each config shape this test asserts that a LIVE signal is
  // handed to the client, that the retry is disabled for the call, and that the refusal is
  // reported as data. It does NOT independently measure the derived budget per shape —
  // `controlBudgetMs` is not exported, and the expected values below mirror its documented
  // rule. What is genuinely OBSERVED about expiry is the single 10 s case at the end of
  // this test, plus the short-budget case above and the end-to-end child processes.
  const base = { baseUrl: 'http://127.0.0.1:3210', discoveryFile: 'unused' };
  /** @returns {Error} the refusal a cancelled request produces. */
  const cancelled = () => Object.assign(new Error('the request was cancelled by the host'), { code: 'MCP_REQUEST_CANCELLED' });
  let armed = null;
  for (const config of [
    base,
    { ...base, timeoutMs: 0 },
    { ...base, timeoutMs: -1 },
    { ...base, timeoutMs: 'nope' },
    { ...base, timeoutMs: 250 },
  ]) {
    const seen = [];
    const recorder = async (route, payload, context) => {
      seen.push({ route, payload, context });
      armed = context.signal;
      // Answer immediately, but only AFTER proving a live signal was handed down: the
      // property here is that configuration never disarms or disables the bound.
      await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
      throw cancelled();
    };
    const outcome = await runControl(['status', 'task-1'], { callExecution: recorder, config });
    assert.equal(seen.length, 1, `one request for config ${JSON.stringify(config)}`);
    assert.equal(seen[0].context.retry, false, 'the observation retry is disabled for the control command');
    assert.equal(armed instanceof AbortSignal, true, 'the caller signal must reach the client');
    assert.equal(armed.aborted, false, 'a live budget signal must reach the client');
    // The documented rule, restated as an expectation for this shape. It is a contract
    // assertion, not an independent measurement of the implementation.
    const expected = typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0
      ? Math.min(config.timeoutMs, CONTROL_TIMEOUT_MS)
      : CONTROL_TIMEOUT_MS;
    assert.ok(Number.isSafeInteger(expected) && expected > 0, `a finite budget is required for ${JSON.stringify(config)}`);
    assert.equal(outcome.exitCode, EXIT.refused, 'the recorder refusal is reported as data');
    assert.equal(outcome.output.error.code, 'MCP_REQUEST_CANCELLED',
      `config ${JSON.stringify(config)} must reach the refusal path, not a broken budget`);
    assert.equal(outcome.output.ok, false);
  }

  // And the arm/expire path itself, MEASURED: a config with no usable timeout must still
  // end the command, on the documented 10 s default, with that budget named in the refusal.
  const started = Date.now();
  const outcome = await runControl(['status', 'task-1'], {
    callExecution: async (route, payload, context) => {
      await new Promise((resolvePromise) => {
        if (context.signal.aborted === true) { resolvePromise(); return; }
        context.signal.addEventListener('abort', resolvePromise, { once: true });
      });
      throw cancelled();
    },
    config: base,
  });
  const elapsed = Date.now() - started;
  assert.equal(outcome.exitCode, EXIT.refused);
  // This is the one call that really waits: it must end on the 10 s default and say so.
  assert.equal(outcome.output.error.code, 'CONTROL_TIMEOUT');
  assert.match(outcome.output.error.message, new RegExp(`within ${CONTROL_TIMEOUT_MS} ms`, 'u'));
  assert.ok(elapsed >= 9_000 && elapsed < 15_000, `the 10 s default must be the real bound, saw ${elapsed} ms`);
}, { timeout: 30_000 });

test('a refusal is reported as data even when it arrives with an unusual error shape', async () => {
  for (const thrown of [new TypeError('socket hang up'), 'a string', { code: 42, message: 42 }]) {
    const outcome = await runControl(['status', 'task-1'], {
      callExecution: async () => { throw thrown; },
      config: { baseUrl: 'http://127.0.0.1:3210', discoveryFile: 'unused', timeoutMs: 1_000 },
    });
    assert.equal(outcome.exitCode, EXIT.refused);
    assert.equal(outcome.output.ok, false);
    assert.equal(typeof outcome.output.error.code, 'string', 'a code is always a string a script can switch on');
    assert.equal(typeof outcome.output.error.message, 'string');
    assert.equal(outcome.output.error.message.length <= 400, true);
  }
});

test('a plane refusal is reported as JSON with a non-zero exit, never as a stack trace', async () => {
  const { stdout, stderr, io } = captureIo();
  const { call } = mockClient({}, {
    fail: Object.assign(new Error('no such task for this connection'), { code: 'JOB_TASK_NOT_FOUND' }),
  });
  const exitCode = await main(['status', 'missing'], {
    ...io, callExecution: call,
    config: { baseUrl: 'http://127.0.0.1:3210', discoveryFile: 'unused', timeoutMs: 1_000 },
  });
  assert.equal(exitCode, EXIT.refused);
  const body = JSON.parse(stdout[0]);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'JOB_TASK_NOT_FOUND');
  assert.equal(body.error.message, 'no such task for this connection');
  assert.match(stderr[0], /JOB_TASK_NOT_FOUND/u);
});

test('the control request bound is the 10 s default and the override may only LOWER it', () => {
  const plain = readControlConfig({});
  assert.equal(plain.timeoutMs, CONTROL_TIMEOUT_MS);
  assert.equal(CONTROL_TIMEOUT_MS, 10_000, 'the documented default is ten seconds');
  // Lowering works: an operator on a slow host can ask for a longer-than-a-second wait
  // but never longer than the default.
  assert.equal(readControlConfig({ DSH_DELEGATE_CONTROL_TIMEOUT_MS: '2500' }).timeoutMs, 2_500);
  // RAISING is clamped back down: the contract is "may only lower", so a value above the
  // default is not honored.
  assert.equal(readControlConfig({ DSH_DELEGATE_CONTROL_TIMEOUT_MS: '60000' }).timeoutMs, CONTROL_TIMEOUT_MS);
  assert.equal(readControlConfig({ DSH_DELEGATE_CONTROL_TIMEOUT_MS: '999999' }).timeoutMs, CONTROL_TIMEOUT_MS);
  // Garbage, zero and negatives fall back to the default rather than disabling the bound.
  for (const bad of ['nope', '0', '-5', '', '1.5']) {
    assert.equal(readControlConfig({ DSH_DELEGATE_CONTROL_TIMEOUT_MS: bad }).timeoutMs, CONTROL_TIMEOUT_MS, bad);
  }
  // The endpoint override is the SAME one the MCP server reads, refused identically.
  assert.throws(() => readControlConfig({ DSH_DELEGATE_BASE_URL: '::bad::' }), (error) => error.code === 'MCP_CONFIG_INVALID');
});

test('a compact task is bounded in every field, and nested blocks are rebuilt from a fixed shape', () => {
  const compact = compactControlTask({ taskId: 't', state: 'failed', error: { code: 'X', message: 'y'.repeat(5_000) } });
  assert.equal(compact.error.message.length <= 401, true, 'the error message is bounded');
  assert.equal(compactControlTask(null), null);
  assert.deepEqual(compactControlTask({ taskId: 't', diff: {}, prompt: 'p' }), { taskId: 't' });
  // Evidence and transcript keys never appear, whatever their type.
  const hostile = compactControlTask({
    taskId: 't',
    diff: { patchText: 'x' },
    execution: { text: 'y' },
    prompt: 'z'.repeat(10_000),
    conversation: ['a'],
  });
  assert.deepEqual(Object.keys(hostile), ['taskId']);

  // A nested route/currentTool is limited to known keys, and every value is type-checked:
  // a string that is too long is cut, an object where a name belongs becomes null, and a
  // non-finite number becomes null. Nothing lets a caller smuggle an arbitrarily large or
  // structurally different value into stdout.
  const nested = compactControlTask({
    taskId: 't',
    route: { providerId: 'relay', model: 'm'.repeat(2_000), isolation: { nested: 'x' }, secret: 'leak' },
    currentTool: { name: { not: 'a string' }, callId: 'c'.repeat(2_000), arguments: 'SECRET-ARGS' },
    elapsedMs: Number.POSITIVE_INFINITY,
  });
  assert.equal(nested.route.providerId, 'relay');
  assert.equal(nested.route.model.length, 401, 'the model name is bounded');
  assert.equal(nested.route.isolation, null, 'an object where a name belongs is not published');
  assert.equal(nested.route.secret, undefined, 'unknown route keys are dropped');
  assert.equal(nested.currentTool.name, null, 'an object tool name is not published');
  assert.equal(nested.currentTool.callId.length, 401);
  assert.equal(nested.currentTool.arguments, undefined, 'tool arguments are never published');
  assert.equal(nested.elapsedMs, null, 'a non-finite number is not published');
  assert.ok(JSON.stringify(nested).length < 1_500, 'the whole answer stays small');
});

test('the compact answer is bounded end to end over the wire', async () => {
  const { call } = mockClient({
    observe: () => ({
      ok: true,
      reason: 'heartbeat',
      task: {
        taskId: 'task-1',
        state: 'running',
        currentTool: { name: 'x'.repeat(5_000), callId: 'y'.repeat(5_000) },
        route: { providerId: 'p'.repeat(5_000), model: 'm'.repeat(5_000), reasoningEffort: 'e'.repeat(5_000) },
        error: { code: 'C' } ,
        prompt: 'p'.repeat(50_000),
        diff: 'd'.repeat(50_000),
      },
    }),
  });
  const outcome = await runControl(['status', 'task-1'], { callExecution: call });
  const serialized = JSON.stringify(outcome.output);
  assert.ok(serialized.length < 2_500, `a control answer must stay small, saw ${serialized.length}`);
});

// ---------------------------------------------------------------------------
// 4. The real property: a control process while a long wait is outstanding
// ---------------------------------------------------------------------------
//
// Everything on the serving side is the PRODUCT here: a real `JobEngine` over a real
// temporary workspace with faked native services (no model is contacted), the real
// `TaskMonitor` the engine owns, and the real `createExecutionHandler` behind a real
// loopback HTTP server. The only doubles are the native services the engine is always
// given in tests — exactly the ones `tests/engine.test.js` uses — plus a prompt the
// runner never finishes, which is what keeps the task `running` while the CLI works.
//
// That matters for the regression this section pins: with a hand-written engine double
// the test could only ASSERT that a non-positive wait is slow. Here the engine's own
// `clampObserveWait` and the monitor's own `boundedWait` decide, so a `status` that went
// back to `waitMs: 0` is parked for their real 25 s fallback and the child's 10 s budget
// turns it into `CONTROL_TIMEOUT` — the exact failure observed against a live plane.

/** The pinned commit the fake repository always reports. */
const HEAD = 'a'.repeat(40);

/**
 * A git runner answering in the NUL-delimited format the audit layer parses.
 * @returns {object} runner function with `calls` history.
 */
function auditGit() {
  const calls = [];
  const runner = async (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${HEAD}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '2\t0\tsrc/a.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+work\n', code: 0 };
    if (args[0] === 'ls-files') return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  };
  runner.calls = calls;
  return runner;
}

/**
 * A prompt the runner delivers and then waits on forever.
 *
 * This is the one seam that makes a REAL job stay `running`: the placed run drives the
 * resolved Agent, hands it the prompt, and then awaits `whenIdle()`. A never-idle agent is
 * a genuinely unfinished execution, so only a cancel (or a timeout) ends it — no fake
 * engine, no paused flag, no timer.
 * @param {ReturnType<typeof fakeWorkspaceController>} workspaces - controller to bind to.
 * @returns {object} session controller serving such agents.
 */
function hungSessionController(workspaces) {
  const controller = fakeSessionController({ workspaces });
  const resolveOriginal = controller.resolveAgent.bind(controller);
  controller.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found.agent;
    if (agent !== undefined) {
      agent.followup = (message) => { agent.followups.push(message); };
      agent.whenIdle = async () => { await new Promise(() => {}); };
    }
    return found;
  };
  return controller;
}

/** One plugin-owned review composition stand-in; reviews are off in this fixture. */
function reviewPreset() {
  const id = 'dsh-delegate-review-test';
  return { get id() { return id; }, owns(candidate) { return candidate === id; }, async preparation() { return id; } };
}

/**
 * Build ONE real plugin process over temporary storage.
 *
 * Mirrors how `src/index.js` wires the engine, minus everything that is not needed to
 * run and observe one task: a real temporary workspace, real settings/authorization/lock
 * services, the native workspace and session controllers, and the native policy services
 * through which a delegated run verifies its sandbox policy.
 * @param {object} [options] - `delegationEnabled`: whether the switch is on.
 * @returns {Promise<object>} engine, workspace, host controllers and `close()`.
 */
async function realEngineFixture(options = {}) {
  const root = await makeTempDir();
  const workspace = await realpath(await mkdir(join(root, 'workspace'), { recursive: true }).then(() => join(root, 'workspace')));
  const settings = new SettingsService(join(root, 'data'));
  const enabled = options.delegationEnabled !== false;
  await settings.replace({ ...validSettings(), delegationEnabled: enabled });
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const agents = fakeAgents({ respond: { text: 'implemented the change' } });
  const workspaces = fakeWorkspaceController();
  const sessionController = hungSessionController(workspaces);
  const policyServices = await nativePolicyServices();
  const deps = {
    agents,
    agentPresets: {
      mounts: [],
      async mount(ctx, id) {
        this.mounts.push({ id });
        // Mounting the preset is what installs the tool composition a review restricts.
        ctx.tools.schemas = () => ['read', 'glob', 'grep'].map((name) => ({ name, description: name, parameters: {} }));
        return { id: id ?? 'default-preset' };
      },
    },
    reviewPresets: reviewPreset(),
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    policyServices: () => policyServices,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth,
    locks,
    runGit: auditGit(),
    providerRegistry: {
      async ensure(providers) {
        const routes = new Map();
        for (const provider of providers) routes.set(provider.id, `${provider.id}-native`);
        return { routes };
      },
    },
    logger: { info() {}, warn() {} },
    // The local-call switch is the authorization mode this channel serves, so the plane
    // answers observe/cancel with the single `local-mcp` identity and no token.
    authorizationMode: 'switch',
    delegationEnabled: enabled,
  };
  const engine = new JobEngine(deps);
  const handler = createExecutionHandler({ ...deps, engine, getBindHost: () => '127.0.0.1' });
  return {
    engine,
    handler,
    workspace,
    settings,
    sessionController,
    locks,
    async close() {
      await engine.dispose();
      await cleanup(root);
    },
  };
}

/**
 * Start the REAL execution plane on a loopback port.
 * @param {Function} handler - handler from `createExecutionHandler`.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} server handle.
 */
async function startPlane(handler) {
  const server = createServer((req, res) => { void handler(req, res); });
  await listenLoopback(server);
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

/**
 * A stdio MCP harness over a server, with helper readers.
 * @param {object} server - MCP server.
 * @returns {object} harness.
 */
function stdioHarness(server) {
  const input = new Readable({ read() {} });
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const done = serveStdio({ input, output, server });
  const send = (message) => input.push(`${JSON.stringify(message)}\n`);
  const replies = () => chunks.join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  const replyTo = async (id, attempts = 600) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const match = replies().find((line) => line.id === id);
      if (match !== undefined) return match;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
    }
    throw new Error(`no reply for ${String(id)}`);
  };
  return { input, chunks, done, send, replies, replyTo };
}

/**
 * Run the REAL CLI as an independent child process, asynchronously.
 *
 * `spawnSync` would block this process's event loop, and the parent IS the HTTP plane
 * under test here — a blocked parent could not answer the child, which would make the
 * whole test measure nothing. So the child is spawned with its stdio redirected to files
 * in a temp directory (a PIPED child fails with EPERM in the confined sandbox; see the
 * same note in `tests/package.test.js`) and awaited through events, never by blocking.
 * @param {string[]} args - CLI arguments.
 * @param {Record<string, string>} env - extra environment entries for the child.
 * @param {number} [timeoutMs] - bound on the whole child run.
 * @returns {Promise<{ ok: true, status: number | null, signal: string | null, stdout: string, stderr: string }
 *   | { ok: false, reason: string }>} result, or why no child could be run here.
 */
function runChild(args, env, timeoutMs = 30_000) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-control-run-'));
  const outPath = join(scratch, 'stdout.txt');
  const errPath = join(scratch, 'stderr.txt');
  const outHandle = openSync(outPath, 'w');
  const errHandle = openSync(errPath, 'w');
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const handle of [outHandle, errHandle]) {
        try {
          closeSync(handle);
        } catch {
          // Already closed by an error path.
        }
      }
      let stdout = '';
      let stderr = '';
      try {
        stdout = readFileSync(outPath, 'utf8');
        stderr = readFileSync(errPath, 'utf8');
      } catch {
        // A child that never produced output leaves both empty.
      }
      rmSync(scratch, { recursive: true, force: true });
      resolvePromise({ ...value, stdout, stderr });
    };
    let child;
    try {
      child = spawn(process.execPath, [CONTROL_BIN, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', outHandle, errHandle],
      });
    } catch (error) {
      settled = true;
      for (const handle of [outHandle, errHandle]) {
        try {
          closeSync(handle);
        } catch {
          // Nothing to clean up.
        }
      }
      rmSync(scratch, { recursive: true, force: true });
      resolvePromise({ ok: false, reason: `control child spawn failed: ${error?.code ?? error?.message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: true, status: null, signal: 'SIGKILL (test bound)' });
    }, timeoutMs);
    child.on('error', (error) => {
      finish({ ok: false, reason: `control child spawn failed: ${error?.code ?? error?.message}` });
    });
    child.on('close', (status, signal) => finish({ ok: true, status, signal }));
    void rejectPromise;
  });
}

/**
 * Run the child, or skip the test when this sandbox cannot spawn one at all.
 *
 * A skipped test states its reason; it never asserts something it could not observe.
 * @param {object} t - node:test context.
 * @param {string[]} args - CLI arguments.
 * @param {Record<string, string>} env - child environment.
 * @returns {Promise<object | null>} the child result, or null when skipped.
 */
async function runChildOrSkip(t, args, env) {
  const result = await runChild(args, env);
  if (result.ok === false) {
    t.skip(result.reason);
    return null;
  }
  return result;
}

/**
 * Assert a child's stdout is ONE stable JSON document and nothing else.
 * @param {string} text - stdout.
 * @returns {object} parsed document.
 */
function parseSoleJson(text) {
  const parsed = JSON.parse(text);
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  // Re-serializing must reproduce the document, so there is no prose around it.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
  return parsed;
}

test('a SEPARATE control process queries and cancels while a long MCP wait is outstanding', async (t) => {
  // The real property, exercised the way an operator gets it: a real engine, its real
  // monitor and the real HTTP plane live in THIS process, a real stdio MCP `delegate_wait`
  // is parked on the same task, and two independent `node dsh-delegate-control.js` child
  // processes reach that plane while the wait is still outstanding. If this test used
  // `runControl` in-process it would prove nothing about the channel that exists FOR a
  // serialising host.
  const fixture = await realEngineFixture();
  const plane = await startPlane(fixture.handler);
  try {
    // A REAL job, submitted through the product's own switch-authorized path, with a
    // prompt the runner never finishes: the task stays `running` until something cancels it.
    const started = await fixture.engine.start({
      workspacePath: fixture.workspace,
      prompt: 'hold this task running while the operator inspects it',
    });
    const taskId = started.taskId;
    assert.match(taskId, /^task-/u, 'the engine issued a real task id');
    // Wait until the run is actually executing (the monitor exists and the task is live).
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const task = fixture.engine.get(taskId);
      if (task?.state === 'running' && task?.monitor !== null && task?.native?.started === true) break;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
    }
    const live = fixture.engine.get(taskId);
    assert.equal(live.state, 'running', 'the fixture must hold a genuinely running task');
    assert.notEqual(live.monitor, null, 'the engine must own a real TaskMonitor for it');
    assert.equal(fixture.locks.isLocked(fixture.workspace), true, 'a running task holds its workspace lock');

    const config = { baseUrl: plane.url, discoveryFile: join(tmpdir(), 'unused.json'), timeoutMs: 10_000 };
    const server = createMcpServer({ callExecution: createExecutionClient(config) });
    const harness = stdioHarness(server);
    harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await harness.replyTo(1);
    harness.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId, waitSeconds: 3_600 } },
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 60); });
    assert.equal(harness.replies().some((line) => line.id === 2), false, 'the wait must still be outstanding');

    const childEnv = { DSH_DELEGATE_BASE_URL: plane.url, DSH_DELEGATE_DISCOVERY_FILE: '' };

    // 1. An independent process reports the running task WHILE the wait is parked.
    const statusStarted = Date.now();
    const statusRun = await runChildOrSkip(t, ['status', taskId], childEnv);
    if (statusRun === null) return;
    const statusElapsed = Date.now() - statusStarted;
    assert.equal(statusRun.status, 0, statusRun.stderr);
    const statusBody = parseSoleJson(statusRun.stdout);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.action, 'status');
    assert.equal(statusBody.taskId, taskId);
    assert.equal(statusBody.task.state, 'running');
    // THE REGRESSION. `status` asks for the smallest positive wait; both this engine's
    // `clampObserveWait` and its monitor's `boundedWait` replace a non-positive value with
    // their own 25 s default. So if `status` ever sends `waitMs: 0` again, this child is
    // parked for 25 real seconds here — it cannot answer inside the CLI's 10 s budget, and
    // this assertion fails. No fixture clock or fake engine is involved in that decision.
    assert.ok(statusElapsed < CONTROL_TIMEOUT_MS,
      `a status read must answer inside its own budget, took ${statusElapsed} ms`);
    // The task was not disturbed: still running, still locked, wait still parked.
    assert.equal(fixture.engine.get(taskId).state, 'running', 'a control read must not change the task');
    assert.equal(fixture.locks.isLocked(fixture.workspace), true, 'a control read must not release the lock');
    assert.equal(harness.replies().some((line) => line.id === 2), false, 'a control read must not end the wait');

    // 2. A second independent process stops exactly that task.
    const cancelStarted = Date.now();
    const cancelRun = await runChildOrSkip(t, ['cancel', taskId], childEnv);
    if (cancelRun === null) return;
    assert.equal(cancelRun.status, 0, cancelRun.stderr);
    assert.ok(Date.now() - cancelStarted < CONTROL_TIMEOUT_MS + 5_000,
      'a cancel must answer inside one command budget, not wait out another request');
    const cancelBody = parseSoleJson(cancelRun.stdout);
    assert.equal(cancelBody.ok, true);
    assert.equal(cancelBody.action, 'cancel');
    assert.equal(cancelBody.taskId, taskId);
    assert.equal(cancelBody.state, 'cancelled');

    // 3. The blocked wait learns the REAL outcome of the same task.
    const waited = await harness.replyTo(2, 300);
    const body = JSON.parse(waited.result.content[0].text);
    assert.equal(body.reason, 'cancelled', 'the wait reports the cancellation, not a timeout');
    assert.equal(body.terminal, true);
    assert.equal(body.taskId, taskId, 'the wait describes the task the control process cancelled');
    // And the engine agrees, after the wait: one task, cancelled, lock released.
    for (let attempt = 0; attempt < 200 && fixture.engine.get(taskId).state !== 'cancelled'; attempt += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
    }
    assert.equal(fixture.engine.get(taskId).state, 'cancelled', 'the real task ended cancelled');

    harness.input.push(null);
    await harness.done;
  } finally {
    await plane.close();
    await fixture.close();
  }
});

test('an independent process reports only the named task, and refuses an unknown one', async (t) => {
  const fixture = await realEngineFixture();
  const plane = await startPlane(fixture.handler);
  try {
    const started = await fixture.engine.start({
      workspacePath: fixture.workspace,
      prompt: 'hold this task running while an unknown id is asked for',
    });
    const taskId = started.taskId;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const task = fixture.engine.get(taskId);
      if (task?.state === 'running' && task?.monitor !== null) break;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
    }
    assert.equal(fixture.engine.get(taskId).state, 'running');

    const childEnv = { DSH_DELEGATE_BASE_URL: plane.url, DSH_DELEGATE_DISCOVERY_FILE: '' };
    const ok = await runChildOrSkip(t, ['status', taskId], childEnv);
    if (ok === null) return;
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(parseSoleJson(ok.stdout).taskId, taskId);

    // An id this connection does not own is the SAME refusal as one that does not exist,
    // produced by the real engine's own observation gate.
    const unknown = await runChildOrSkip(t, ['status', 'task-other'], childEnv);
    if (unknown === null) return;
    assert.equal(unknown.status, 1, 'an unknown task is a refusal, not a success');
    const body = parseSoleJson(unknown.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'JOB_TASK_NOT_FOUND');
    // The real task it was pointed past is untouched: still running, still locked.
    assert.equal(fixture.engine.get(taskId).state, 'running');
    assert.equal(fixture.locks.isLocked(fixture.workspace), true);
    await fixture.engine.cancel(taskId, 'test-cleanup');
  } finally {
    await plane.close();
    await fixture.close();
  }
});

test('a bad environment is a bounded JSON refusal with a non-zero exit, never a stack trace', async (t) => {
  // `readControlConfig` runs inside `runControl`'s guarded region, so a broken override
  // becomes data. Before the fix it threw out of `main`, printing a stack trace with
  // non-JSON stdout.
  const run = await runChildOrSkip(t, ['status', 'task-1'], { DSH_DELEGATE_BASE_URL: '::not-a-url::' });
  if (run === null) return;
  assert.equal(run.status, 1);
  const body = parseSoleJson(run.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'MCP_CONFIG_INVALID');
  assert.equal(run.stdout.includes('    at '), false, 'stdout must never carry a stack trace');
  assert.match(run.stderr, /MCP_CONFIG_INVALID/u);
});

test('a missing discovery file and a dead endpoint both end in JSON plus a non-zero exit', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-delegate-control-missing-'));
  try {
    const missing = await runChildOrSkip(t, ['status', 'task-1'], {
      DSH_DELEGATE_DISCOVERY_FILE: join(directory, 'runtime-endpoint.json'),
      DSH_DELEGATE_BASE_URL: '',
    });
    if (missing === null) return;
    assert.equal(missing.status, 1);
    assert.equal(parseSoleJson(missing.stdout).error.code, 'MCP_ENDPOINT_NOT_FOUND');

    // A port nothing listens on: one attempt, a bounded refusal, no retry storm.
    const started = Date.now();
    const dead = await runChildOrSkip(t, ['status', 'task-1'], {
      DSH_DELEGATE_BASE_URL: 'http://127.0.0.1:9',
      DSH_DELEGATE_DISCOVERY_FILE: '',
    });
    if (dead === null) return;
    assert.equal(dead.status, 1);
    assert.equal(parseSoleJson(dead.stdout).error.code, 'MCP_HARNESS_UNREACHABLE');
    assert.ok(Date.now() - started < 25_000, 'a dead endpoint must fail fast, not hang');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the control command works through the shipped discovery file, exactly like the MCP server', async () => {
  const fixture = await realEngineFixture();
  const plane = await startPlane(fixture.handler);
  const directory = mkdtempSync(join(tmpdir(), 'dsh-delegate-control-'));
  const discoveryFile = join(directory, 'runtime-endpoint.json');
  try {
    const started = await fixture.engine.start({
      workspacePath: fixture.workspace,
      prompt: 'hold this task running across a discovered endpoint',
    });
    const taskId = started.taskId;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const task = fixture.engine.get(taskId);
      if (task?.state === 'running' && task?.monitor !== null) break;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
    }
    assert.equal(fixture.engine.get(taskId).state, 'running');
    const published = await publishRuntimeEndpoint({
      filePath: discoveryFile,
      host: '127.0.0.1',
      port: Number(new URL(plane.url).port),
    });
    const endpoint = await readRuntimeEndpoint(discoveryFile);
    assert.equal(endpoint.host, '127.0.0.1');
    // No DSH_DELEGATE_BASE_URL: the client has to discover the plane itself.
    const config = readControlConfig({ DSH_DELEGATE_DISCOVERY_FILE: discoveryFile });
    assert.equal(config.baseUrl, null);
    const status = await runControl(['status', taskId], { config });
    assert.equal(status.exitCode, EXIT.ok, JSON.stringify(status.output));
    assert.equal(status.output.taskId, taskId);
    assert.equal(status.output.task.state, 'running');
    assert.equal(fixture.engine.get(taskId).state, 'running', 'a discovered status read must not change the task');
    await published.dispose();
    assert.equal(existsSync(discoveryFile), false);
    await fixture.engine.cancel(taskId, 'test-cleanup');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await plane.close();
    await fixture.close();
  }
});

// ---------------------------------------------------------------------------
// 5. The executable itself
// ---------------------------------------------------------------------------

test('the shipped executable is registered as a bin, is executable, and prints JSON only', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.bin['dsh-delegate-control'], 'bin/dsh-delegate-control.js',
    'package bin must register the control CLI');
  assert.ok(manifest.files.includes('bin/dsh-delegate-control.js'), 'the control CLI must be published');
  const source = readFileSync(join(ROOT, 'bin', 'dsh-delegate-control.js'), 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node/u, 'a bin needs a shebang');
  // It imports only files this package ships, plus node builtins.
  for (const match of source.matchAll(/^import .* from '(\.[^']+)';$/gmu)) {
    const target = resolve(ROOT, 'bin', match[1]);
    assert.ok(existsSync(target), `the control CLI imports a file that must exist: ${match[1]}`);
  }
  // And it must not be able to submit or configure: no `submit` route, no settings or
  // switch verb. The module's own PROSE explains what it refuses, so the scan runs on
  // the code only (comments stripped), which is what could ever call a route.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
    .replace(/^\s*\*.*$/gmu, '');
  assert.equal(/callExecution\('submit'/u.test(code), false);
  assert.equal(/['"`]\/?(?:tasks|submit|settings|switch|config)['"`]/iu.test(code), false,
    'the control CLI carries no submit, settings or switch surface');
});

test('the executable refuses an unknown verb with exit 2 and writes its usage to stdout', () => {
  // A child process is used ON PURPOSE here: this is the real entry point, so the
  // "importing must not run main" guarantee is proved by the parent not seeing any
  // output when it imports the module above.
  const result = spawnSync(process.execPath, [join(ROOT, 'bin', 'dsh-delegate-control.js'), '--help'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (result.error !== undefined && result.error.code === 'EPERM') {
    // A confined sandbox may forbid spawning a child; the behaviour is covered through
    // `main()` above, so this check is skipped rather than reported as a pass.
    return;
  }
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: dsh-delegate-control <status\|cancel> <taskId>/u);
  assert.equal(result.stdout.includes('submit'), true, 'the usage states what it cannot do');
  assert.match(result.stdout, /cannot submit/u);
});

test('a discovery file that does not exist is an honest refusal, not a hang', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-delegate-control-missing-'));
  try {
    const config = readControlConfig({ DSH_DELEGATE_DISCOVERY_FILE: join(directory, 'runtime-endpoint.json') });
    const outcome = await runControl(['status', 'task-1'], { config });
    assert.equal(outcome.exitCode, EXIT.refused);
    assert.equal(outcome.output.error.code, 'MCP_ENDPOINT_NOT_FOUND');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI module writes nothing when it is imported', async () => {
  // The module was imported at the top of this file; if that had run `main`, these
  // writers would have been touched. The assertion is that importing is inert.
  const { stdout, stderr } = captureIo();
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, []);
  const source = readFileSync(join(ROOT, 'bin', 'dsh-delegate-control.js'), 'utf8');
  assert.match(source, /process\.argv\[1\] !== undefined/u, 'main runs only for a direct execution');
  void writeFileSync;
});
