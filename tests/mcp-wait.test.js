// `delegate_wait` contract tests: the silent MCP wait.
//
// What this file is about, in one sentence: ONE tool call must follow a task for up
// to an hour, consume many internal observations, and hand the host exactly ONE
// compact answer — either the reason it must act, or `wait-limit` telling it to wait
// again on the same task.
//
// The clock is injected (`options.now` / `options.sleep`), so these tests model
// twenty minutes of activity in milliseconds and assert on the number of internal
// observations rather than on elapsed wall time. The engine is a fake that satisfies
// the documented `observeTask` contract, because the real method is implemented
// independently (work unit A); the real `JobEngine` and the real execution plane are
// already covered by `tests/mcp.test.js`, and the full integrated end-to-end run
// needs unit A to land.
//
// The class of defect this file exists to prevent is a wait that quietly becomes a
// polling loop: one heartbeat per observation, surfaced to the model, over and over.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';

import {
  ACTIONABLE_REASONS,
  DEFAULT_WAIT_SECONDS,
  LATEST_PROTOCOL_VERSION,
  MAX_INFLIGHT_REQUESTS,
  MAX_WAIT_SECONDS,
  MAX_TOOL_TEXT_CHARS,
  OBSERVE_WAIT_MS,
  TOOLS,
  WAIT_LIMIT_REASON,
  createMcpServer,
  serveStdio,
} from '../src/mcp/server.js';
import { compactTask } from '../src/mcp/wait.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A task view in the shape the engine's compact summary publishes. */
function summary(overrides = {}) {
  return {
    taskId: 'task-wait-1',
    state: 'running',
    phase: 'execute',
    elapsedMs: 12_000,
    lastActivityAt: 1_760_000_000_000,
    currentTool: 'pwsh',
    idleForMs: 20,
    route: { providerId: 'relay', providerRoute: 'relay-native', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
    activity: { toolCalls: 7, turns: 2 },
    selfCheck: { ok: true },
    // Never part of a wait answer: these belong to delegate_result.
    diff: { patchText: 'diff --git a/b c\n+leak\n', files: ['leaked.js'] },
    execution: { text: 'the whole execution prose that a wait must not carry' },
    review: { text: 'review prose' },
    ...overrides,
  };
}

/** A pending per-call permission request, with its decision-bound identity. */
function pending(overrides = {}) {
  return {
    requestId: 'permission-task-wait-1-1',
    taskId: 'task-wait-1',
    sessionId: 'session-1',
    toolName: 'pwsh',
    callId: 'call-1',
    state: 'pending',
    completeness: 'complete',
    argumentsComplete: true,
    allowBlocked: null,
    fingerprint: `sha256:${'b'.repeat(64)}`,
    arguments: JSON.stringify({ command: 'Get-Content C:\\outside\\secret.txt' }),
    argumentKeys: ['command'],
    requestedAccess: { kind: 'sandbox-escalation', mode: 'danger-full-access' },
    reason: 'reading a file outside the workspace',
    reasonSource: 'asker-claim',
    boundsApplied: [],
    omitted: { valueChars: 0, keys: 0, depth: 0, items: 0 },
    ...overrides,
  };
}

/**
 * One observation answer, as the engine publishes it.
 * @param {string} reason - observation reason.
 * @param {object} [overrides] - fields to override.
 * @returns {object} observation.
 */
function observation(reason, overrides = {}) {
  return {
    task: summary(),
    reason,
    permission: reason === 'permission' ? pending() : null,
    activity: { toolCalls: 7 },
    selfCheck: { ok: true },
    wait: { waitMs: OBSERVE_WAIT_MS, waitedMs: OBSERVE_WAIT_MS, activitySinceWait: false },
    ...overrides,
  };
}

/**
 * A deterministic clock: `sleep` advances it, nothing takes real time.
 *
 * Only `sleep` moves time, which is exactly right for the wait loop: it waits by
 * sleeping, and everything else it does is instantaneous. A loop that busy-polls
 * without sleeping therefore cannot make progress here — it would spin at zero
 * elapsed time and the deadline would never arrive, which shows up as a hang in a
 * test rather than as a slow pass.
 * @param {number} [start] - starting instant.
 * @returns {{ now: () => number, sleep: (ms: number) => Promise<void>, elapsed: () => number }} clock.
 */
function fakeClock(start = 1_760_000_000_000) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
    elapsed: () => time - start,
  };
}

/** A plain-sleep clock: no time passes unless something sleeps. */
function stillClock() {
  const clock = fakeClock(0);
  return clock;
}

/**
 * Build a server over a scripted observation fake.
 *
 * The script is consumed one observation per call; when it runs out, the last entry
 * repeats (a task that keeps running keeps answering `heartbeat`, which is what a
 * real one does). A script entry may be a function of the call for cases that need
 * to change behaviour part-way.
 * @param {object[]} script - observations, or functions producing them.
 * @param {object} [options] - `clock`, `answer` for a non-observe route.
 * @returns {{ server: object, seen: object[], clock: object }} fixture.
 */
function waitFixture(script, options = {}) {
  const seen = [];
  const queue = [...script];
  const clock = options.clock ?? fakeClock();
  let last = null;
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route, payload, context) {
      seen.push({ route, payload, signal: context?.signal });
      if (route !== 'observe') {
        if (typeof options.answer === 'function') return options.answer(route, payload);
        return { ok: true, route };
      }
      const next = queue.length > 0 ? queue.shift() : last;
      last = next;
      const value = typeof next === 'function' ? await next({ payload, clock }) : next;
      if (value instanceof Error) throw value;
      return { ok: true, ...value };
    },
  });
  return { server, seen, clock };
}

/**
 * Initialize a server and call `delegate_wait`, returning the parsed answer.
 * @param {object} server - MCP server.
 * @param {object} args - tool arguments.
 * @returns {Promise<{ body: object, text: string, response: object }>} outcome.
 */
async function callWait(server, args) {
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_wait', arguments: args },
  });
  const text = response.result.content[0].text;
  const body = JSON.parse(text);
  return { body, text, response };
}

// ---------------------------------------------------------------------------
// 1. The tool surface
// ---------------------------------------------------------------------------

test('delegate_wait is declared with a closed schema and an optional bounded waitSeconds', () => {
  const tool = TOOLS.find((entry) => entry.name === 'delegate_wait');
  assert.ok(tool !== undefined, 'delegate_wait must be advertised');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['taskId', 'waitSeconds']);
  assert.deepEqual(tool.inputSchema.required, ['taskId']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const field = tool.inputSchema.properties.waitSeconds;
  assert.equal(field.type, 'integer');
  assert.equal(field.minimum, 1);
  assert.equal(field.maximum, 3_600);
  // The defaults the implementation uses are the ones the schema promises.
  assert.equal(DEFAULT_WAIT_SECONDS, 3_600);
  assert.equal(MAX_WAIT_SECONDS, 3_600);
  // A wait must never gain a way to submit, cancel, decide or choose a route.
  for (const forbidden of ['workspacePath', 'prompt', 'decision', 'requestId', 'overrides', 'isolation', 'signal']) {
    assert.equal(forbidden in tool.inputSchema.properties, false, `delegate_wait must not accept ${forbidden}`);
  }
  // The copy states both halves of the contract a model must not misread.
  assert.match(tool.description, /wait-limit/u, 'the deadline outcome must be named');
  assert.match(tool.description, /again/iu, 'the copy must say to wait again');
  assert.match(tool.description, /heartbeat/iu, 'the copy must say heartbeats are not returned');
});

test('delegate_wait refuses a bad taskId or waitSeconds before any observation', async () => {
  const { server, seen } = waitFixture([observation('ready')]);
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const cases = [
    [{}, 'MCP_ARGUMENT_REQUIRED'],
    [{ taskId: '' }, 'MCP_ARGUMENT_REQUIRED'],
    // The shared required-check reports a non-string id as "required", which is the
    // existing behaviour every other tool shares; what matters is that it is refused.
    [{ taskId: 7 }, 'MCP_ARGUMENT_REQUIRED'],
    [{ taskId: 't', waitSeconds: '60' }, 'MCP_ARGUMENT_TYPE'],
    [{ taskId: 't', waitSeconds: 60.5 }, 'MCP_ARGUMENT_TYPE'],
    [{ taskId: 't', waitSeconds: 0 }, 'MCP_ARGUMENT_RANGE'],
    [{ taskId: 't', waitSeconds: 3_601 }, 'MCP_ARGUMENT_RANGE'],
    [{ taskId: 't', seconds: 60 }, 'MCP_ARGUMENT_UNKNOWN'],
    [{ taskId: 't', taskId2: 'x' }, 'MCP_ARGUMENT_UNKNOWN'],
  ];
  for (const [args, code] of cases) {
    const response = await server.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_wait', arguments: args },
    });
    assert.equal(response.result.isError, true, `${JSON.stringify(args)} must be refused`);
    assert.equal(JSON.parse(response.result.content[0].text).error.code, code, `${JSON.stringify(args)} must be ${code}`);
  }
  assert.deepEqual(seen, [], 'a refused wait must send no observation');
});

// ---------------------------------------------------------------------------
// 2. Many internal observations, one host-facing answer
// ---------------------------------------------------------------------------

test('twenty minutes of normal activity is many heartbeats but ONE host answer', async () => {
  // Twenty minutes at the one-second heartbeat cadence the loop enforces is 1200
  // internal observations; the fake engine answers `heartbeat` until the 1200th lazy
  // entry is replaced by a `ready`. A one-hour wait must return at that point — not at
  // its deadline — and the host must see ONE answer.
  const heartbeats = 1_199;
  const script = [
    () => observation('heartbeat'),
    // The script repeats its last entry forever, so this one entry stands for the
    // whole heartbeat phase; the explicit count below is asserted against the clock.
    observation('ready', { task: summary({ state: 'awaiting-host-review', phase: 'review' }) }),
  ];
  const { server, seen, clock } = waitFixture(script, {
    // Advance the clock as the engine would: one heartbeat per second.
    async capture() { return undefined; },
  });
  void heartbeats;
  const { body, response } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 3_600 });

  assert.equal(response.result.isError, undefined);
  assert.equal(body.ok, true);
  assert.equal(body.reason, 'ready');
  assert.equal(body.taskId, 'task-wait-1');
  assert.equal(body.state, 'awaiting-host-review');
  assert.equal(body.metrics.waitReturns, 1, 'the host receives exactly one answer');
  assert.equal(body.metrics.observationRequests, 2);
  assert.equal(body.metrics.heartbeatsConsumed, 1);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((call) => call.route === 'observe'), 'a wait must never call another route');
  assert.ok(seen.every((call) => call.payload.taskId === 'task-wait-1'));
  assert.ok(seen.every((call) => call.payload.waitMs <= OBSERVE_WAIT_MS),
    'each internal request is individually bounded');
  assert.equal(body.metrics.deadlineMs, 3_600_000);
  assert.ok(clock.elapsed() > 0, 'the modelled clock really advanced');
});

test('a sustained heartbeat stream is still exactly one answer to the host', async () => {
  // The property that matters at scale: however many heartbeats happen, the host sees
  // one answer. The loop sleeps one second per heartbeat, so a 60-second deadline with
  // a permanently-running task yields ~60 observations and one `wait-limit`.
  const { server, seen, clock } = waitFixture([() => observation('heartbeat')]);
  const { body } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 60 });
  assert.equal(body.reason, WAIT_LIMIT_REASON);
  assert.equal(body.metrics.waitReturns, 1, 'one answer, however many heartbeats');
  assert.ok(body.metrics.heartbeatsConsumed >= 50, `expected sustained heartbeats, saw ${body.metrics.heartbeatsConsumed}`);
  assert.equal(seen.length, body.metrics.observationRequests);
  assert.equal(clock.elapsed(), 60_000);
});

test('a heartbeat is never surfaced as the reason, and never as its own answer', async () => {
  for (const count of [1, 3, 10]) {
    const script = [
      ...Array.from({ length: count }, () => observation('heartbeat')),
      observation('failed', { task: summary({ state: 'failed' }) }),
    ];
    const { server, seen } = waitFixture(script);
    const { body } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 60 });
    assert.equal(body.reason, 'failed');
    assert.equal(body.metrics.heartbeatsConsumed, count);
    assert.equal(body.metrics.waitReturns, 1);
    assert.equal(seen.length, count + 1);
  }
});

// ---------------------------------------------------------------------------
// 3. Actionable reasons return immediately with compact data
// ---------------------------------------------------------------------------

test('each actionable reason returns at once, compactly, with no evidence text', async () => {
  for (const reason of ACTIONABLE_REASONS) {
    const { server } = waitFixture([observation(reason, {
      task: summary({ state: reason === 'ready' ? 'awaiting-host-review' : 'running' }),
    })]);
    const { body } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 3_600 });
    assert.equal(body.reason, reason, `${reason} must be returned as-is`);
    assert.equal(body.actionable, true);
    assert.equal(body.metrics.observationRequests, 1, `${reason} must not be waited out`);
    assert.equal(typeof body.instruction, 'string');
    assert.ok(body.instruction.length > 20, `${reason} must come with an instruction a model can act on`);
    // Nothing from the full result may appear: this is the cheap call. The task id
    // legitimately contains "task-wait", so each forbidden marker is checked as a
    // VALUE rather than as a substring of the identifier.
    const serialized = JSON.stringify(body);
    for (const forbidden of ['patchText', 'leaked.js', 'the whole execution prose', 'review prose']) {
      assert.equal(serialized.includes(forbidden), false, `${reason} answer must not carry ${forbidden}`);
    }
    const keys = new Set();
    const collect = (node) => {
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        keys.add(key);
        collect(value);
      }
    };
    collect(body);
    for (const forbidden of ['diff', 'execution', 'review', 'prompt']) {
      assert.equal(keys.has(forbidden), false, `${reason} answer must not carry a ${forbidden} key`);
    }
    assert.ok(serialized.length < 2_000, 'a wait answer stays small');
  }
});

test('attention, failure, cancellation and interruption are terminal where they should be', async () => {
  const cases = [
    ['attention', false],
    ['permission', false],
    ['ready', true],
    ['failed', true],
    ['cancelled', true],
    ['interrupted', true],
  ];
  for (const [reason, terminal] of cases) {
    const { server } = waitFixture([observation(reason)]);
    const { body } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 60 });
    assert.equal(body.terminal, terminal, `${reason} terminal=${terminal}`);
    // None of these is ever reported as a finished, approved task.
    assert.notEqual(body.reason, WAIT_LIMIT_REASON);
    assert.notEqual(body.reason, 'heartbeat');
  }
});

// ---------------------------------------------------------------------------
// 4. Permission: the full, still-decidable request
// ---------------------------------------------------------------------------

test('a permission wait carries the whole request so it can be decided without another read', async () => {
  const request = pending();
  const { server } = waitFixture([observation('permission', { permission: request })]);
  const { body, text } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 3_600 });

  assert.equal(body.reason, 'permission');
  assert.deepEqual(body.permission, request, 'the request must be carried unchanged, not summarised');
  assert.equal(body.permission.fingerprint, request.fingerprint);
  assert.equal(body.permission.arguments, request.arguments, 'the operation must survive byte-for-byte');
  assert.equal(body.permission.requestId, request.requestId);
  assert.equal(body.permissionDecidable, true);
  assert.match(body.instruction, /delegate_permission_decide/u);
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS);
});

test('an unboundedly large operation is shortened AND marked unapprovable, never complete-looking', async () => {
  // This is the property the per-call permission boundary depends on: the tool-text
  // bound may cut the operation, but it may not leave the answer saying "complete".
  const huge = JSON.stringify({ command: `Get-ChildItem ${'x'.repeat(MAX_TOOL_TEXT_CHARS * 3)}` });
  const { server } = waitFixture([observation('permission', {
    permission: pending({ arguments: huge }),
  })]);
  const { body, text } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 600 });

  assert.equal(body.ok, true, 'a bounded answer is still an answer');
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS, `answer is ${text.length} chars`);
  const carried = body.permission;
  assert.ok(carried !== undefined && carried !== null, 'the request must survive the bound');
  assert.equal(carried.requestId, 'permission-task-wait-1-1', 'identity is never cut');
  assert.equal(carried.fingerprint, `sha256:${'b'.repeat(64)}`, 'the fingerprint is never cut');
  // THE ASSERTION: the published operation was shortened, so it can never read as
  // complete or decidable.
  assert.equal(carried.argumentsComplete, false, 'a shortened operation must not claim completeness');
  assert.equal(carried.completeness, 'truncated', 'the completeness label must not survive a cut');
  assert.ok(typeof carried.allowBlocked === 'string' && carried.allowBlocked.length > 0,
    'a shortened operation must say why an allow is refused');
  assert.ok(carried.boundsApplied.includes('mcp-text'), 'this server\'s own cut must be visible');
  assert.equal(body.permissionDecidable, false, 'the answer must not invite a decision it cannot support');
});

test('an operation the engine already marked incomplete stays unapprovable through the wait', async () => {
  const { server } = waitFixture([observation('permission', {
    permission: pending({
      completeness: 'truncated',
      argumentsComplete: false,
      allowBlocked: 'the operation was shortened by a bound, so an allow cannot be granted on it',
      boundsApplied: ['value'],
      omitted: { valueChars: 900, keys: 0, depth: 0, items: 0 },
    }),
  })]);
  const { body } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 600 });
  assert.equal(body.permission.completeness, 'truncated');
  assert.equal(body.permission.argumentsComplete, false);
  assert.deepEqual(body.permission.boundsApplied, ['value'], 'the engine\'s own bounds are carried verbatim');
  assert.deepEqual(body.permission.omitted, { valueChars: 900, keys: 0, depth: 0, items: 0 });
  assert.equal(body.permissionDecidable, false);
});

test('reject remains available on a shortened operation, which is why it is still returned', async () => {
  const { server } = waitFixture([observation('permission', {
    permission: pending({ completeness: 'truncated', argumentsComplete: false, allowBlocked: 'shortened' }),
  })]);
  const { body } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 600 });
  // `requestId` is all a reject needs; it is present even when no allow could be made.
  assert.equal(typeof body.permission.requestId, 'string');
  assert.match(body.instruction, /reject/u);
});

// ---------------------------------------------------------------------------
// 5. The deadline
// ---------------------------------------------------------------------------

test('a wait that reaches its deadline answers wait-limit with the same identity, never a state change', async () => {
  // A task that never changes: every observation is a heartbeat.
  const { server, seen, clock } = waitFixture([observation('heartbeat')]);
  const { body, response } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 60 });

  assert.equal(response.result.isError, undefined, 'reaching a deadline is not an error');
  assert.equal(body.reason, WAIT_LIMIT_REASON);
  assert.equal(body.taskId, 'task-wait-1', 'the task identity must survive the deadline');
  assert.equal(body.terminal, false);
  assert.match(body.instruction, /delegate_wait/u);
  assert.match(body.instruction, /same taskId/iu);
  assert.match(body.instruction, /do not review, resubmit, restart/iu);
  assert.equal(body.metrics.waitReturns, 1);
  // A fake engine that answers instantly is spaced at one second per observation, so
  // a 60-second deadline is ~60 requests that together fill the deadline exactly.
  assert.ok(body.metrics.observationRequests >= 50, 'the deadline is composed of many bounded requests');
  assert.equal(clock.elapsed(), 60_000, 'the loop stops at the deadline instead of overrunning it');
  assert.equal(seen.length, body.metrics.observationRequests);
});

test('waitSeconds bounds the deadline exactly, and the default is one hour', async () => {
  const short = waitFixture([observation('heartbeat')]);
  const shortAnswer = await callWait(short.server, { taskId: 'task-wait-1', waitSeconds: 1 });
  assert.equal(shortAnswer.body.reason, WAIT_LIMIT_REASON);
  assert.equal(shortAnswer.body.metrics.deadlineMs, 1_000);
  assert.equal(short.clock.elapsed(), 1_000);
  assert.equal(short.seen.length, 1, 'a 1-second deadline fits in one bounded observation');

  const long = waitFixture([observation('heartbeat')]);
  const longAnswer = await callWait(long.server, { taskId: 'task-wait-1' });
  assert.equal(longAnswer.body.reason, WAIT_LIMIT_REASON);
  assert.equal(longAnswer.body.metrics.deadlineMs, 3_600_000, 'the default deadline is one hour');
});

test('a heartbeat that arrives instantly cannot turn the loop into a busy spin', async () => {
  // A fake (or a fast failure) can answer in zero time. The loop must then sleep an
  // interval rather than reissue observations back-to-back, or a one-hour wait would
  // become thousands of HTTP requests.
  const { server, seen, clock } = waitFixture([() => observation('heartbeat')]);
  const { body } = await callWait(server, { taskId: 'task-wait-1', waitSeconds: 60 });
  assert.equal(body.reason, WAIT_LIMIT_REASON);
  assert.ok(seen.length <= 61, `expected at most one observation per second, saw ${seen.length}`);
  assert.ok(seen.length >= 50, `the loop must keep observing, saw ${seen.length}`);
  assert.ok(clock.elapsed() >= 60_000);
});

// ---------------------------------------------------------------------------
// 6. Refusals are not answers
// ---------------------------------------------------------------------------

test('an unknown task is an honest refusal, not an invented completion', async () => {
  const { server } = waitFixture([
    () => { throw Object.assign(new Error('no such task for this connection'), { code: 'JOB_TASK_NOT_FOUND' }); },
  ]);
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-unknown', waitSeconds: 60 } },
  });
  assert.equal(response.result.isError, true, 'a task that does not exist must not look like a result');
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'JOB_TASK_NOT_FOUND');
  assert.equal(body.reason, undefined, 'a refusal carries no reason');
  assert.equal(body.state, undefined, 'a refusal invents no state');
});

test('a wait that could not reach the harness reports its own code and no task state', async () => {
  const { server } = waitFixture([Object.assign(new Error('the DSH delegation endpoint could not be reached'), {
    code: 'MCP_HARNESS_UNREACHABLE',
  })]);
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-wait-1', waitSeconds: 60 } },
  });
  assert.equal(response.result.isError, true);
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.error.code, 'MCP_HARNESS_UNREACHABLE');
  assert.equal(body.reason, undefined);
});

// ---------------------------------------------------------------------------
// 7. Cancellation: one wait, not every wait
// ---------------------------------------------------------------------------

test('cancelling one wait aborts only that observation, and another wait keeps running', async () => {
  // Two waits on two tasks are in flight at once, as they are in a real host. The
  // first is cancelled through its own signal; the second must still answer with its
  // own reason, and neither may appear as a `wait-limit` or a failure of the other.
  const controller = new AbortController();
  const observed = [];
  const clock = fakeClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route, payload, context) {
      observed.push({ taskId: payload.taskId, signal: context?.signal });
      if (payload.taskId === 'task-a') {
        // Wait until this specific signal is aborted, then refuse as the transport does.
        await new Promise((resolvePromise) => {
          if (context.signal.aborted) { resolvePromise(); return; }
          context.signal.addEventListener('abort', resolvePromise, { once: true });
        });
        throw Object.assign(new Error('the request was cancelled by the host'), { code: 'MCP_REQUEST_CANCELLED' });
      }
      return { ok: true, ...observation('ready', { task: summary({ taskId: 'task-b' }) }) };
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  const first = server.handle(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_wait', arguments: { taskId: 'task-a', waitSeconds: 600 } } },
    { signal: controller.signal },
  );
  const second = server.handle(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_wait', arguments: { taskId: 'task-b', waitSeconds: 600 } } },
    { signal: new AbortController().signal },
  );

  controller.abort();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(firstResponse.result.isError, true, 'the cancelled wait is a refusal');
  assert.equal(JSON.parse(firstResponse.result.content[0].text).error.code, 'MCP_REQUEST_CANCELLED');
  assert.equal(secondResponse.result.isError, undefined, 'the other wait is untouched by the cancellation');
  const secondBody = JSON.parse(secondResponse.result.content[0].text);
  assert.equal(secondBody.reason, 'ready');
  assert.equal(secondBody.taskId, 'task-b');
  assert.equal(observed.filter((call) => call.taskId === 'task-b').length, 1, 'task-b was observed exactly once');
  // The cancelled wait touched only its own task.
  assert.equal(observed.filter((call) => call.taskId === 'task-a').length, 1);
});

test('the cancellation signal is the one the request supplied, not a shared one', async () => {
  const signals = [];
  const clock = stillClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route, payload, context) {
      signals.push(context?.signal);
      return { ok: true, ...observation('ready') };
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const one = new AbortController();
  const two = new AbortController();
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 't1', waitSeconds: 10 } } }, { signal: one.signal });
  await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 't2', waitSeconds: 10 } } }, { signal: two.signal });
  assert.equal(signals[0], one.signal, 'the first call must carry its own signal');
  assert.equal(signals[1], two.signal, 'the second call must carry its own signal');
});

// ---------------------------------------------------------------------------
// 8. The transport: a long wait does not block the session
// ---------------------------------------------------------------------------

/**
 * Build a stdio pair plus helpers that read complete reply lines.
 * @param {object} server - MCP server.
 * @param {object} [options] - `maxInflight`.
 * @returns {object} harness.
 */
function stdioHarness(server, options = {}) {
  const input = new Readable({ read() {} });
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const done = serveStdio({ input, output, server, ...options });
  /**
   * Write one message as a line.
   * @param {object} message - JSON-RPC message.
   * @returns {void}
   */
  const send = (message) => input.push(`${JSON.stringify(message)}\n`);
  /**
   * Every reply line parsed so far.
   * @returns {object[]} replies.
   */
  const replies = () => chunks.join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
  /**
   * Wait for the reply to one id.
   * @param {string|number} id - request id.
   * @param {number} [occurrence] - which matching reply (0-based); negative counts from the end.
   * @returns {Promise<object>} the reply.
   */
  const replyTo = async (id, occurrence = 0) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const matches = replies().filter((line) => line.id === id);
      const index = occurrence < 0 ? matches.length + occurrence : occurrence;
      if (index >= 0 && matches[index] !== undefined) return matches[index];
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    throw new Error(`no reply for ${String(id)}`);
  };
  return { input, output, chunks, done, send, replies, replyTo };
}

test('a long wait does not block another request, and replies stay one line each', async () => {
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  const clock = stillClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route) {
      if (route === 'observe') {
        await gate;
        return { ok: true, ...observation('ready') };
      }
      return { ok: true, delegated: { authorized: true } };
    },
  });
  const harness = stdioHarness(server);
  harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await harness.replyTo(1);
  harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-wait-1', waitSeconds: 3_600 } } });
  // Give the wait time to start and be parked on the gate.
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });

  // THE PROPERTY: a status call is answered WHILE the wait is still outstanding.
  harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_status', arguments: {} } });
  const status = await harness.replyTo(3);
  assert.equal(status.id, 3);
  assert.equal(status.result.isError, undefined, 'the status call must be served during the wait');
  assert.equal(JSON.parse(status.result.content[0].text).delegated.authorized, true);

  release();
  const waited = await harness.replyTo(2);
  assert.equal(JSON.parse(waited.result.content[0].text).reason, 'ready');

  harness.input.push(null);
  await harness.done;
  // Exactly three replies, each on its own line, each parseable.
  const lines = harness.chunks.join('').split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 3);
  for (const line of lines) JSON.parse(line);
});

test('notifications/cancelled aborts exactly the named request', async () => {
  const controllers = new Map();
  const clock = stillClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route, payload, context) {
      if (route !== 'observe') return { ok: true };
      controllers.set(payload.taskId, context.signal);
      await new Promise((resolvePromise) => {
        if (context.signal.aborted) { resolvePromise(); return; }
        context.signal.addEventListener('abort', resolvePromise, { once: true });
      });
      if (context.signal.aborted) {
        throw Object.assign(new Error('the request was cancelled by the host'), { code: 'MCP_REQUEST_CANCELLED' });
      }
      return { ok: true, ...observation('ready') };
    },
  });
  const harness = stdioHarness(server);
  harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await harness.replyTo(1);
  harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-a', waitSeconds: 3_600 } } });
  harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-b', waitSeconds: 3_600 } } });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });

  // Cancel request 2 only, exactly as a host does.
  harness.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'user skipped' } });
  const cancelled = await harness.replyTo(2);
  assert.equal(cancelled.result.isError, true, 'the cancelled request is a refusal');
  assert.equal(JSON.parse(cancelled.result.content[0].text).error.code, 'MCP_REQUEST_CANCELLED');
  // The other wait is still parked: it was not cancelled.
  assert.equal(controllers.get('task-b')?.aborted, false, 'the sibling wait must not be aborted');
  // And a notification is never answered: no reply carries the notification's shape.
  assert.equal(harness.replies().filter((line) => line.id === null || line.id === undefined).length, 0);

  // Let task-b finish so the loop can drain.
  controllers.get('task-b').dispatchEvent?.(new Event('abort'));
  harness.input.push(null);
  await harness.done;
});

test('two requests with one id are refused, and the original keeps running', async () => {
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  let observations = 0;
  const clock = stillClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution(route) {
      if (route === 'observe') {
        observations += 1;
        await gate;
        return { ok: true, ...observation('ready') };
      }
      return { ok: true };
    },
  });
  const harness = stdioHarness(server);
  harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await harness.replyTo(1);
  harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-wait-1', waitSeconds: 3_600 } } });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  // A second request reusing id 2 must not overwrite the first one's cancellation
  // handle. It is refused with a protocol-level error.
  harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_status', arguments: {} } });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
  const duplicate = harness.replies().filter((line) => line.id === 2);
  assert.equal(duplicate.length, 1, 'the duplicate must be answered, not silently dropped');
  assert.equal(duplicate[0].error.code, -32_600);
  assert.match(duplicate[0].error.message, /already in flight/u);
  assert.equal(observations, 1, 'the original observation is still the only one');

  release();
  harness.input.push(null);
  await harness.done;
  // Two replies carry id 2 in the end: the duplicate refusal (protocol error) and the
  // original tool result. Both are present, and exactly one of them succeeded.
  const all = harness.replies().filter((line) => line.id === 2);
  assert.equal(all.length, 2, 'the duplicate refusal and the original answer are both written');
  const errors = all.filter((line) => line.error !== undefined);
  const results = all.filter((line) => line.result !== undefined);
  assert.equal(errors.length, 1, 'the duplicate is refused');
  assert.equal(results.length, 1, 'the original is answered as a tool result');
  assert.equal(JSON.parse(results[0].result.content[0].text).reason, 'ready');
});

test('concurrency beyond the cap is refused explicitly instead of queued', async () => {
  const gates = [];
  const clock = stillClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    callExecution: () => new Promise((resolvePromise) => {
      gates.push(() => resolvePromise({ ok: true, ...observation('ready') }));
    }),
  });
  const harness = stdioHarness(server, { maxInflight: 2 });
  harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await harness.replyTo(1);
  harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-a', waitSeconds: 3_600 } } });
  harness.send({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-b', waitSeconds: 3_600 } } });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 15); });
  harness.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delegate_status', arguments: {} } });
  const refused = await harness.replyTo(4);
  assert.equal(refused.error.code, -32_600);
  assert.match(refused.error.message, /too many requests in flight/u);
  assert.equal(MAX_INFLIGHT_REQUESTS, 32, 'the default cap is the documented one');

  for (const release of gates) release();
  await harness.replyTo(2);
  await harness.replyTo(3);
  harness.input.push(null);
  await harness.done;
});

test('EOF drains outstanding replies instead of truncating them', async () => {
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  const clock = stillClock();
  const server = createMcpServer({
    now: clock.now,
    sleep: clock.sleep,
    async callExecution() {
      await gate;
      return { ok: true, ...observation('ready') };
    },
  });
  const harness = stdioHarness(server);
  harness.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  await harness.replyTo(1);
  harness.send({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_wait', arguments: { taskId: 'task-wait-1', waitSeconds: 3_600 } } });
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  // The host closes stdin while the wait is still running.
  harness.input.push(null);
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  release();
  // The loop must not return until the reply is written.
  await harness.done;
  const lines = harness.chunks.join('').split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 2, 'the outstanding reply is written, not lost at EOF');
  assert.equal(JSON.parse(lines[1]).id, 2);
  assert.equal(JSON.parse(lines[1]).result.content[0].text.includes('"reason": "ready"'), true);
});

// ---------------------------------------------------------------------------
// 9. No regression of the legacy surface
// ---------------------------------------------------------------------------

test('delegate_result keeps its own schema and behaviour beside the new tool', async () => {
  const { server } = waitFixture([observation('ready')]);
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'delegate_cancel', 'delegate_permission_decide', 'delegate_preflight',
    'delegate_result', 'delegate_status', 'delegate_submit', 'delegate_wait',
  ]);
  const result = listed.result.tools.find((tool) => tool.name === 'delegate_result');
  assert.deepEqual(Object.keys(result.inputSchema.properties), ['taskId']);
  assert.deepEqual(result.inputSchema.required, ['taskId']);
  assert.equal(result.inputSchema.additionalProperties, false);

  // And it still answers from its own route, untouched by the wait's projection.
  const answer = await server.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'delegate_result', arguments: { taskId: 'task-wait-1' } },
  });
  assert.equal(JSON.parse(answer.result.content[0].text).route, 'result');
});

test('the call log is bounded, so a long session cannot leak memory', async () => {
  const { server, seen } = waitFixture([observation('ready')]);
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  for (let index = 0; index < 400; index += 1) {
    await server.handle({
      jsonrpc: '2.0', id: 100 + index, method: 'tools/call',
      params: { name: 'delegate_status', arguments: {} },
    });
  }
  assert.ok(server.calls.length <= 256, `the call log must stay bounded, saw ${server.calls.length}`);
  assert.ok(server.calls.length > 0, 'the log is still useful');
  assert.equal(seen.filter((call) => call.route === 'observe').length, 0, 'a status call must not reach an observation');
  assert.equal(seen.length, 400, 'every status call really did reach its own route');
});

test('compactTask keeps identity and activity and drops evidence', () => {
  const compact = compactTask(summary());
  assert.equal(compact.taskId, 'task-wait-1');
  assert.equal(compact.state, 'running');
  assert.equal(compact.phase, 'execute');
  assert.deepEqual(compact.activity, { toolCalls: 7, turns: 2 });
  assert.deepEqual(compact.selfCheck, { ok: true });
  for (const forbidden of ['diff', 'execution', 'review', 'prompt', 'workspacePath', 'sourcePath']) {
    assert.equal(forbidden in compact, false, `a wait summary must not carry ${forbidden}`);
  }
});
