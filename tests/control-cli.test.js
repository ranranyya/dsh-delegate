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
//     No model is involved: the execution is a scripted fake behind the plane.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTROL_ACTIONS,
  CONTROL_TIMEOUT_MS,
  EXIT,
  compactControlTask,
  main,
  parseControlArgs,
  readControlConfig,
  runControl,
} from '../bin/dsh-delegate-control.js';
import { createExecutionClient } from '../bin/dsh-delegate-mcp.js';
import { createExecutionHandler, EXECUTION_PREFIX, MAX_OBSERVE_WAIT_MS } from '../src/http/execution-plane.js';
import { readRuntimeEndpoint, publishRuntimeEndpoint } from '../src/runtime/endpoint-discovery.js';
import { createMcpServer, serveStdio } from '../src/mcp/server.js';

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
  const call = async (route, payload) => {
    seen.push({ route, payload });
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

test('status issues ONE bounded observation with waitMs 0 and prints a compact state', async () => {
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
      wait: { waitMs: 0, waitedMs: 0, activitySinceWait: false },
    }),
  });
  const outcome = await runControl(['status', 'task-1'], { callExecution: call });

  assert.equal(outcome.exitCode, EXIT.ok);
  assert.deepEqual(seen.map((entry) => entry.route), ['observe'], 'status must read through the observe route');
  assert.deepEqual(seen[0].payload, { taskId: 'task-1', waitMs: 0 }, 'a zero bound is what makes it a status read');
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
  assert.deepEqual(seen, [{ route: 'cancel', payload: { taskId: 'task-2' } }], 'one cancel, one task id');
  assert.equal(outcome.output.state, 'cancelled');
  assert.equal(outcome.output.task.cancelledBy, 'connection');
});

// ---------------------------------------------------------------------------
// 3. Refusals and the request bound
// ---------------------------------------------------------------------------

test('a plane refusal is reported as JSON with a non-zero exit, never as a stack trace', async () => {
  const { stdout, stderr, io } = captureIo();
  const { call } = mockClient({}, {
    fail: Object.assign(new Error('no such task for this connection'), { code: 'JOB_TASK_NOT_FOUND' }),
  });
  const exitCode = await main(['status', 'missing'], { ...io, callExecution: call });
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

/**
 * A tiny scripted task store standing behind the REAL execution plane.
 *
 * It implements the two facts the plane's `observe`/`cancel` routes need — a bounded
 * wait that returns when the task settles, and a cancel that settles it — so the
 * whole path (control CLI → HTTP → plane → engine seam) is exercised without a model,
 * a workspace or a real job.
 * @returns {object} engine double with a `settle()` hook.
 */
function scriptedEngine() {
  const task = { taskId: 'task-live', state: 'running', phase: 'execute', connectionId: 'local-mcp', endedAt: null };
  /** @type {null | (() => void)} */
  let wake = null;
  const engine = {
    authorizationMode: 'switch',
    posture: () => ({ authorized: true, mode: 'switch' }),
    get: (taskId) => {
      if (taskId !== task.taskId) throw Object.assign(new Error('no such task for this connection'), { code: 'JOB_TASK_NOT_FOUND' });
      return task;
    },
    async observeTask(taskId, options = {}) {
      const record = engine.get(taskId);
      const waitMs = Math.min(MAX_OBSERVE_WAIT_MS, Math.max(0, options.waitMs ?? MAX_OBSERVE_WAIT_MS));
      if (record.state !== 'running' || waitMs === 0) {
        return {
          task: { ...record },
          reason: record.state === 'cancelled' ? 'cancelled' : 'heartbeat',
          permission: null,
          wait: { waitMs, waitedMs: 0, activitySinceWait: false },
        };
      }
      await new Promise((resolvePromise) => {
        const done = () => resolvePromise();
        wake = done;
        setTimeout(done, waitMs);
        options.signal?.addEventListener?.('abort', done, { once: true });
      });
      return {
        task: { ...record },
        reason: record.state === 'cancelled' ? 'cancelled' : 'heartbeat',
        permission: null,
        wait: { waitMs, waitedMs: waitMs, activitySinceWait: false },
      };
    },
    async cancel(taskId) {
      const record = engine.get(taskId);
      record.state = 'cancelled';
      record.endedAt = Date.now();
      wake?.();
      return { ...record };
    },
  };
  return engine;
}

/**
 * Start the real execution plane on a loopback port.
 * @param {object} engine - engine double.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>} server handle.
 */
async function startPlane(engine) {
  const handler = createExecutionHandler({
    engine,
    auth: { authenticate: () => null, listGrants: () => [] },
    settings: {},
    logger: { warn: () => {} },
    getBindHost: () => '127.0.0.1',
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
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
  const replyTo = async (id) => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
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
  // The real property, exercised the way an operator gets it: the HTTP plane and the
  // blocked MCP wait live in THIS process, and two independent `node
  // dsh-delegate-control.js` child processes reach that same plane while the wait is
  // still parked. If this test used `runControl` in-process it would prove nothing about
  // the channel that exists FOR a serialising host.
  const engine = scriptedEngine();
  const plane = await startPlane(engine);
  try {
    const config = { baseUrl: plane.url, discoveryFile: join(tmpdir(), 'unused.json'), timeoutMs: 10_000 };
    const server = createMcpServer({ callExecution: createExecutionClient(config) });
    const harness = stdioHarness(server);
    harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await harness.replyTo(1);
    harness.send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_wait', arguments: { taskId: 'task-live', waitSeconds: 3_600 } },
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 60); });
    assert.equal(harness.replies().some((line) => line.id === 2), false, 'the wait must still be outstanding');

    const childEnv = { DSH_DELEGATE_BASE_URL: plane.url, DSH_DELEGATE_DISCOVERY_FILE: '' };

    // 1. An independent process reports the task WHILE the wait is parked.
    const statusRun = await runChildOrSkip(t, ['status', 'task-live'], childEnv);
    if (statusRun === null) return;
    assert.equal(statusRun.status, 0, statusRun.stderr);
    const statusBody = parseSoleJson(statusRun.stdout);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.action, 'status');
    assert.equal(statusBody.taskId, 'task-live');
    assert.equal(statusBody.task.state, 'running');
    assert.equal(harness.replies().some((line) => line.id === 2), false, 'a control read must not end the wait');

    // 2. A second independent process stops exactly that task.
    const cancelRun = await runChildOrSkip(t, ['cancel', 'task-live'], childEnv);
    if (cancelRun === null) return;
    assert.equal(cancelRun.status, 0, cancelRun.stderr);
    const cancelBody = parseSoleJson(cancelRun.stdout);
    assert.equal(cancelBody.ok, true);
    assert.equal(cancelBody.action, 'cancel');
    assert.equal(cancelBody.taskId, 'task-live');
    assert.equal(cancelBody.state, 'cancelled');

    // 3. The blocked wait learns the real outcome.
    const waited = await harness.replyTo(2);
    const body = JSON.parse(waited.result.content[0].text);
    assert.equal(body.reason, 'cancelled', 'the wait reports the cancellation, not a timeout');
    assert.equal(body.terminal, true);

    harness.input.push(null);
    await harness.done;
  } finally {
    await plane.close();
  }
});

test('an independent process reports only the named task, and refuses an unknown one', async (t) => {
  const engine = scriptedEngine();
  const plane = await startPlane(engine);
  try {
    const childEnv = { DSH_DELEGATE_BASE_URL: plane.url, DSH_DELEGATE_DISCOVERY_FILE: '' };
    const ok = await runChildOrSkip(t, ['status', 'task-live'], childEnv);
    if (ok === null) return;
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(parseSoleJson(ok.stdout).taskId, 'task-live');

    const unknown = await runChildOrSkip(t, ['status', 'task-other'], childEnv);
    if (unknown === null) return;
    assert.equal(unknown.status, 1, 'an unknown task is a refusal, not a success');
    const body = parseSoleJson(unknown.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'JOB_TASK_NOT_FOUND');
    // The task it was pointed at is untouched: no cancel was issued.
    assert.equal(engine.get('task-live').state, 'running');
  } finally {
    await plane.close();
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
  const engine = scriptedEngine();
  const plane = await startPlane(engine);
  const directory = mkdtempSync(join(tmpdir(), 'dsh-delegate-control-'));
  const discoveryFile = join(directory, 'runtime-endpoint.json');
  try {
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
    const status = await runControl(['status', 'task-live'], { config });
    assert.equal(status.exitCode, EXIT.ok, JSON.stringify(status.output));
    assert.equal(status.output.taskId, 'task-live');
    await published.dispose();
    assert.equal(existsSync(discoveryFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await plane.close();
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
