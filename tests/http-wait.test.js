// Execution-plane `POST /tasks/observe` contract tests.
//
// The route is the HTTP half of a silent wait: it is the one route a host calls
// repeatedly (or for a long time) while a worker runs. What is proven here is the
// part a fake cannot prove for it — the real handler's validation, ownership rule,
// wait bound, and — most importantly — that a caller who goes away ends ONLY the
// observation, never the worker.
//
// The engine is a fake that satisfies the documented `observeTask` contract, because
// the real engine method is being implemented independently (work unit A). The fake
// is deliberately strict: it rejects any options object it does not recognise, so a
// route that passed an invented option would fail here rather than silently work
// against a more forgiving implementation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createExecutionHandler, EXECUTION_PREFIX, MAX_OBSERVE_WAIT_MS } from '../src/http/execution-plane.js';
import { mockResponse } from './helpers/node-http-mocks.js';

/**
 * A request double that is a real EventEmitter, like `IncomingMessage`.
 *
 * The shared `mockRequest` is a bare object, which is enough for every earlier route
 * — none of them listens for anything. A long observation must listen for `aborted`
 * and `close`, so its request has to behave like the node object it models: an
 * emitter whose body is async-iterable and whose `readableEnded` flips once the body
 * has been consumed. Using the real `EventEmitter` (rather than a hand-rolled
 * subscribe list) means `once`/`off` semantics are the ones the plane actually calls.
 * @param {object} options - `method`, `url`, `headers`, `body`, `remoteAddress`.
 * @returns {EventEmitter & object} request double.
 */
function emitterRequest({ method = 'POST', url = '/', headers = {}, body = '', remoteAddress = '127.0.0.1' } = {}) {
  const emitter = new EventEmitter();
  emitter.method = method;
  emitter.url = url;
  emitter.headers = headers;
  emitter.socket = { remoteAddress };
  emitter.readableEnded = false;
  emitter.aborted = false;
  emitter[Symbol.asyncIterator] = async function* iterate() {
    if (body !== '') yield Buffer.from(body, 'utf8');
    // node sets this once the stream ends, BEFORE the handler finishes; that is the
    // fact the plane uses to tell a consumed body from an abandoned connection.
    emitter.readableEnded = true;
  };
  return emitter;
}

// ---------------------------------------------------------------------------
// A strict fake of the engine's observation contract
// ---------------------------------------------------------------------------

/** The reasons the contract allows. `heartbeat` is included: the plane forwards it. */
const REASONS = ['heartbeat', 'attention', 'permission', 'ready', 'failed', 'cancelled', 'interrupted'];

/**
 * Build one compact task summary in the documented shape.
 * @param {object} [overrides] - fields to override.
 * @returns {object} compact task.
 */
function compactTask(overrides = {}) {
  return {
    taskId: 'task-1',
    state: 'running',
    phase: 'execute',
    elapsedMs: 1_000,
    lastActivityAt: 1_760_000_000_000,
    currentTool: 'pwsh',
    idleForMs: 10,
    route: { providerId: 'relay', providerRoute: 'relay-native', model: 'm', reasoningEffort: 'high' },
    activity: { toolCalls: 3, turns: 1 },
    selfCheck: { ok: true },
    // NOT part of the contract: included deliberately so a route that forwarded the
    // whole engine view instead of the compact summary would leak it and fail.
    diff: { patchText: 'diff --git a/secret b/secret\n+leak\n' },
    execution: { text: 'the whole execution prose' },
    ...overrides,
  };
}

/**
 * A pending permission request in the documented shape, including the fields a
 * decision is bound to.
 * @param {object} [overrides] - fields to override.
 * @returns {object} pending operation.
 */
function pendingOperation(overrides = {}) {
  return {
    requestId: 'permission-task-1-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    toolName: 'pwsh',
    callId: 'call-1',
    state: 'pending',
    completeness: 'complete',
    argumentsComplete: true,
    allowBlocked: null,
    fingerprint: `sha256:${'a'.repeat(64)}`,
    arguments: JSON.stringify({ command: 'Get-ChildItem C:\\' }),
    argumentKeys: ['command'],
    requestedAccess: { kind: 'sandbox-escalation', mode: 'danger-full-access' },
    reason: 'listing a directory outside the workspace',
    reasonSource: 'asker-claim',
    boundsApplied: [],
    omitted: { valueChars: 0, keys: 0, depth: 0, items: 0 },
    ...overrides,
  };
}

/**
 * Build the engine fake plus a record of what the route asked it for.
 *
 * `observeTask` honours its whole documented contract: prompt resolution, deadline
 * honouring through the injected clock, abort propagation, and the identical
 * not-found refusal for an unknown task and another connection's task.
 * @param {object} [options] - `script`: an array of answers (or functions of the
 *   call) consumed one per call; `connectionId`: the owner of `task-1`.
 * @returns {object} fixture.
 */
function engineFixture(options = {}) {
  const observed = [];
  const script = [...(options.script ?? [])];
  const owner = options.connectionId ?? 'local-mcp';
  const tasks = new Map([
    ['task-1', { connectionId: owner }],
    ['task-other', { connectionId: 'someone-else' }],
  ]);

  const engine = {
    authorizationMode: 'switch',
    posture: () => ({ authorized: options.authorized ?? true, reason: null, mode: 'switch' }),
    get(taskId) {
      const record = tasks.get(taskId);
      if (record === undefined) throw Object.assign(new Error('no such task'), { code: 'JOB_TASK_NOT_FOUND' });
      return { taskId, connectionId: record.connectionId };
    },
    list: () => [],
    cancel: async () => ({}),
    /**
     * The contract under test.
     * @param {string} taskId - task to observe.
     * @param {object} request - `connectionId`, `waitMs`, `signal`.
     * @returns {Promise<object>} observation.
     */
    async observeTask(taskId, request) {
      // Strict: an invented option is a contract violation, not something to ignore.
      for (const key of Object.keys(request)) {
        if (!['connectionId', 'waitMs', 'signal'].includes(key)) {
          throw new Error(`observeTask received an undeclared option ${key}`);
        }
      }
      observed.push({ taskId, ...request });
      const record = tasks.get(taskId);
      if (record === undefined || record.connectionId !== request.connectionId) {
        // One identical answer for both cases: a distinct code would confirm that a
        // task id exists somewhere else.
        throw Object.assign(new Error('no such task for this connection'), { code: 'JOB_TASK_NOT_FOUND' });
      }
      if (request.signal?.aborted === true) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'OBSERVE_CLIENT_ABORTED' });
      }
      const next = script.shift();
      if (next === undefined) {
        return {
          task: compactTask({ taskId }),
          reason: 'heartbeat',
          permission: null,
          activity: { toolCalls: 3 },
          selfCheck: { ok: true },
          wait: { waitMs: request.waitMs, waitedMs: request.waitMs, activitySinceWait: false },
        };
      }
      return await (typeof next === 'function' ? next({ taskId, request }) : next);
    },
  };
  return { engine, observed, tasks };
}

/**
 * Build the plane handler over a fake engine.
 * @param {object} options - engine fixture options.
 * @returns {{ handler: Function, observed: object[], engine: object, dispose: () => void }} fixture.
 */
function planeFixture(options = {}) {
  const fake = engineFixture(options);
  const handler = createExecutionHandler({
    engine: fake.engine,
    auth: { authenticate: () => null, listGrants: () => [] },
    settings: {},
    logger: { warn() {} },
    runGit: async () => ({ stdout: '', code: 0 }),
    getBindHost: () => '127.0.0.1',
  });
  return { handler, observed: fake.observed, engine: fake.engine };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Common headers for a loopback, non-browser request. */
const LOOPBACK_HEADERS = Object.freeze({ host: '127.0.0.1:3210', 'sec-fetch-site': 'none' });

/**
 * Drive the plane with a request double.
 *
 * The returned promise also exposes `.request` and `.response` IMMEDIATELY, before
 * the handler settles, so a test can act on a request while its observation is
 * still in flight (that is the only way to model a disconnect mid-wait).
 * @param {Function} handler - plane handler.
 * @param {object} [options] - `method`, `path`, `body`, `headers`, request overrides.
 * @returns {Promise<{ status: number|null, body: object, response: object, request: object }> & { request: object, response: object }} result.
 */
function callPlane(handler, options = {}) {
  const {
    method = 'POST',
    path = '/tasks/observe',
    body = { taskId: 'task-1' },
    headers = {},
    requestOverrides = {},
    responseOptions = {},
  } = options;
  const request = emitterRequest({
    method,
    url: `${EXECUTION_PREFIX}${path}`,
    headers: {
      ...LOOPBACK_HEADERS,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? '' : JSON.stringify(body),
  });
  Object.assign(request, requestOverrides);
  const response = mockResponse(responseOptions);
  const promise = (async () => {
    await handler(request, response);
    const text = response.text();
    return {
      status: response.status,
      body: text === '' ? {} : JSON.parse(text),
      response,
      request,
    };
  })();
  promise.request = request;
  promise.response = response;
  return promise;
}

// ---------------------------------------------------------------------------
// 1. Route shape and validation
// ---------------------------------------------------------------------------

test('POST /tasks/observe answers an observation with the compact task and the reason', async () => {
  const { handler } = planeFixture({
    script: [{
      task: compactTask(),
      reason: 'ready',
      permission: null,
      activity: { toolCalls: 4 },
      selfCheck: { ok: true },
      wait: { waitMs: 25_000, waitedMs: 900, activitySinceWait: true },
    }],
  });
  const result = await callPlane(handler, { body: { taskId: 'task-1', waitMs: 1_000 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.reason, 'ready');
  assert.equal(result.body.task.taskId, 'task-1');
  assert.equal(result.body.task.state, 'running');
  // The observation is exactly what the engine returned — the route adds `ok` and
  // nothing else, so it cannot be the place where a diff is introduced.
  assert.deepEqual(result.body.wait, { waitMs: 25_000, waitedMs: 900, activitySinceWait: true });
});

test('the observation is bounded at 25 seconds, and a larger waitMs is clamped rather than refused', async () => {
  const { handler, observed } = planeFixture();
  assert.equal(MAX_OBSERVE_WAIT_MS, 25_000);
  const oversized = await callPlane(handler, { body: { taskId: 'task-1', waitMs: 600_000 } });
  assert.equal(oversized.status, 200);
  assert.equal(observed[0].waitMs, MAX_OBSERVE_WAIT_MS, 'a longer request must be clamped to the bound');

  // An omitted waitMs means the maximum, not zero: a caller who wants a snapshot
  // sends 0 explicitly.
  const omitted = await callPlane(handler, { body: { taskId: 'task-1' } });
  assert.equal(omitted.status, 200);
  assert.equal(observed[1].waitMs, MAX_OBSERVE_WAIT_MS);

  const explicitZero = await callPlane(handler, { body: { taskId: 'task-1', waitMs: 0 } });
  assert.equal(explicitZero.status, 200);
  assert.equal(observed[2].waitMs, 0, 'waitMs 0 is a snapshot and must not be raised to the bound');
});

test('observe refuses an unknown field, a wrong type and a negative wait before touching the engine', async () => {
  const { handler, observed } = planeFixture();
  const cases = [
    [{ taskId: 'task-1', conversationMode: 'new' }, 'OBSERVE_ARGUMENT_UNKNOWN'],
    [{ taskId: 'task-1', connectionId: 'other' }, 'OBSERVE_ARGUMENT_UNKNOWN'],
    [{}, 'TASK_ID_REQUIRED'],
    [{ taskId: '   ' }, 'TASK_ID_REQUIRED'],
    [{ taskId: 42 }, 'TASK_ID_REQUIRED'],
    [{ taskId: 'task-1', waitMs: '1000' }, 'OBSERVE_WAIT_INVALID'],
    [{ taskId: 'task-1', waitMs: 1000.5 }, 'OBSERVE_WAIT_INVALID'],
    [{ taskId: 'task-1', waitMs: -1 }, 'OBSERVE_WAIT_INVALID'],
    [{ taskId: 'task-1', waitMs: true }, 'OBSERVE_WAIT_INVALID'],
  ];
  for (const [body, code] of cases) {
    const result = await callPlane(handler, { body });
    assert.equal(result.status, 400, `${JSON.stringify(body)} must be a 400`);
    assert.equal(result.body.error.code, code, `${JSON.stringify(body)} must be ${code}`);
  }
  assert.deepEqual(observed, [], 'a refused request must never reach the engine');
});

test('an unknown task and another connection\'s task get one indistinguishable answer', async () => {
  const { handler } = planeFixture();
  const unknown = await callPlane(handler, { body: { taskId: 'task-nowhere' } });
  const foreign = await callPlane(handler, { body: { taskId: 'task-other' } });
  assert.equal(unknown.status, foreign.status, 'the two cases must share a status');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body.error, foreign.body.error, 'the two cases must share one error object');
  assert.equal(unknown.body.error.code, 'JOB_TASK_NOT_FOUND');
});

test('the observe route stays answerable while the switch is off', async () => {
  // Read availability follows result/cancel: an operator must be able to look at
  // work that already exists after turning delegation off.
  const { handler, observed } = planeFixture({ authorized: false });
  const result = await callPlane(handler, { body: { taskId: 'task-1' }, headers: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(observed.length, 1);
});

test('the observe route applies the same transport fence as every other route', async () => {
  const { handler, observed } = planeFixture();
  const offLoopback = await callPlane(handler, { requestOverrides: { socket: { remoteAddress: '10.0.0.9' } } });
  assert.equal(offLoopback.status, 403);
  assert.equal(offLoopback.body.error.code, 'CONNECTION_NOT_LOCAL');

  const foreignHost = await callPlane(handler, { headers: { host: 'example.com:3210' } });
  assert.equal(foreignHost.status, 403);
  assert.equal(foreignHost.body.error.code, 'CONNECTION_HOST_NOT_LOCAL');

  const crossOrigin = await callPlane(handler, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.body.error.code, 'CONNECTION_CROSS_ORIGIN');
  assert.deepEqual(observed, [], 'no request may reach the engine through a refused fence');
});

// ---------------------------------------------------------------------------
// 2. Abandonment: the observer stops, the worker does not
// ---------------------------------------------------------------------------

/** A promise plus its resolver, for ordering a test against real work. */
function deferred() {
  let settle;
  const handle = { settled: false };
  handle.promise = new Promise((resolve) => { settle = resolve; });
  handle.resolve = (value) => { handle.settled = true; settle(value); };
  return handle;
}

test('a real request abort aborts only this observation, and leaves the task alone', async () => {
  // The observation waits on the signal the route supplies, as the real engine does.
  // The test then fires the request's own `aborted` event — what node emits when the
  // caller disappears — and asserts three things: the observation was aborted, the
  // engine was asked for the task exactly once (no retry, no resubmission), and no
  // observation of another task was affected.
  const entered = deferred();
  const aborted = deferred();
  const calls = [];
  const plane = planeFixture({ script: [
    async ({ taskId, request }) => {
      calls.push({ taskId, waitMs: request.waitMs });
      entered.resolve();
      await new Promise((resolvePromise) => {
        if (request.signal.aborted) { resolvePromise(); return; }
        request.signal.addEventListener('abort', resolvePromise, { once: true });
      });
      aborted.resolve(request.signal.reason?.code ?? 'aborted');
      throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'OBSERVE_CLIENT_ABORTED' });
    },
    // A second, independent observation of the SAME task must still be answerable.
    {
      task: compactTask(),
      reason: 'ready',
      permission: null,
      activity: {},
      selfCheck: {},
      wait: { waitMs: 25_000, waitedMs: 1, activitySinceWait: false },
    },
  ] });

  const abandoned = callPlane(plane.handler, { body: { taskId: 'task-1', waitMs: 25_000 } });
  await entered.promise;
  assert.equal(aborted.settled, false, 'the observation is genuinely in flight');

  // Fire the event node emits when the peer disconnects mid-request. The request is
  // exposed on the running promise, so nothing here waits for the handler.
  abandoned.request.aborted = true;
  fireAborted(abandoned.request);
  await aborted.promise;

  const second = await callPlane(plane.handler, { body: { taskId: 'task-1', waitMs: 1_000 } });
  assert.equal(second.status, 200, 'the task itself is untouched by the abandoned observer');
  assert.equal(second.body.reason, 'ready');
  assert.equal(calls.length, 1,
    'an abandoned observation is not retried and does not resubmit the task');

  // The abandoned request DOES answer — with the harness's own refusal, as a tool
  // error would be. What must never happen is a successful observation being
  // written to a socket whose caller is gone, which the destroyed-socket test covers.
  try {
    await abandoned.promise;
  } catch {
    // The handler itself rejected after the caller vanished; that is not an answer,
    // and the assertions below are about the response object, not the promise.
  }
  assert.equal(abandoned.response.status, 400);
});

test('a normal request close after body consumption is NOT abandonment', async () => {
  // The regression this pins: node emits `close` on the request for EVERY request
  // once its body has been read. Treating that as abandonment would abort every
  // observation, including the ones that are working perfectly.
  const { handler, observed } = planeFixture({
    script: [{
      task: compactTask(),
      reason: 'ready',
      permission: null,
      activity: {},
      selfCheck: {},
      wait: { waitMs: 25_000, waitedMs: 10, activitySinceWait: false },
    }],
  });
  const request = emitterRequest({ method: 'POST', url: `${EXECUTION_PREFIX}/tasks/observe`,
    headers: { ...LOOPBACK_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'task-1' }) });
  const response = mockResponse();

  const running = handler(request, response);
  // `close` fires while the handler is still working — after the body was consumed,
  // with `readableEnded` true. It must be ignored.
  await waitFor(() => request.readableEnded === true);
  request.emit('close');
  await running;

  assert.equal(response.status, 200, 'a consumed body followed by close is a normal request');
  assert.equal(response.parsed().reason, 'ready');
  assert.equal(observed.length, 1);
});

test('an aborted request ends the observation with no JSON written to the socket', async () => {
  // A destroyed response must not be written to: `sendJson` would throw from
  // `writeHead`, and the refusal path would then try to write again.
  const { handler } = planeFixture({ script: [async ({ request }) => {
    // Abort the observation from inside the engine, exactly as a disconnect does.
    request.signal.dispatchEvent?.(new Event('abort'));
    throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'OBSERVE_CLIENT_ABORTED' });
  }] });
  const written = [];
  const request = emitterRequest({ method: 'POST', url: `${EXECUTION_PREFIX}/tasks/observe`,
    headers: { ...LOOPBACK_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'task-1' }) });
  const response = {
    headersSent: false,
    writableEnded: false,
    destroyed: true,
    writeHead(status) { written.push(status); this.headersSent = true; },
    end() { written.push('end'); },
    once() {},
    off() {},
  };
  await handler(request, response);
  assert.deepEqual(written, [], 'nothing may be written to a destroyed socket');
});

// ---------------------------------------------------------------------------
// 3. Permission preservation through the route
// ---------------------------------------------------------------------------

test('a permission observation carries the whole existing redacted operation', async () => {
  const pending = pendingOperation();
  const { handler } = planeFixture({
    script: [{
      task: compactTask({ state: 'running', phase: 'awaiting-permission' }),
      reason: 'permission',
      permission: pending,
      activity: {},
      selfCheck: {},
      wait: { waitMs: 25_000, waitedMs: 400, activitySinceWait: true },
    }],
  });
  const result = await callPlane(handler, { body: { taskId: 'task-1' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.reason, 'permission');
  assert.deepEqual(result.body.permission, pending, 'the route must forward the pending request unchanged');
  assert.equal(result.body.permission.fingerprint, pending.fingerprint);
  assert.equal(result.body.permission.completeness, 'complete');
  assert.equal(result.body.permission.argumentsComplete, true);
});

test('an incomplete operation stays marked unapprovable through the route', async () => {
  const { handler } = planeFixture({
    script: [{
      task: compactTask({ phase: 'awaiting-permission' }),
      reason: 'permission',
      permission: pendingOperation({
        completeness: 'truncated',
        argumentsComplete: false,
        allowBlocked: 'the operation was shortened by a bound, so an allow cannot be granted on it',
        boundsApplied: ['value'],
      }),
      activity: {},
      selfCheck: {},
      wait: { waitMs: 25_000, waitedMs: 400, activitySinceWait: true },
    }],
  });
  const result = await callPlane(handler, { body: { taskId: 'task-1' } });
  assert.equal(result.body.permission.argumentsComplete, false);
  assert.equal(result.body.permission.completeness, 'truncated');
  assert.match(result.body.permission.allowBlocked, /cannot be granted/u);
});

// ---------------------------------------------------------------------------
// 4. The wait request the engine receives
// ---------------------------------------------------------------------------

test('every reason in the contract is forwarded verbatim', async () => {
  for (const reason of REASONS) {
    const { handler } = planeFixture({
      script: [{
        task: compactTask(),
        reason,
        permission: reason === 'permission' ? pendingOperation() : null,
        activity: {},
        selfCheck: {},
        wait: { waitMs: 25_000, waitedMs: 1, activitySinceWait: false },
      }],
    });
    const result = await callPlane(handler, { body: { taskId: 'task-1' } });
    assert.equal(result.body.reason, reason, `${reason} must be forwarded unchanged`);
  }
});

test('the route never invents a task or a reason when the engine cannot answer', async () => {
  const { handler } = planeFixture({
    script: [() => { throw Object.assign(new Error('no such task'), { code: 'JOB_TASK_NOT_FOUND' }); }],
  });
  const result = await callPlane(handler, { body: { taskId: 'task-1' } });
  assert.equal(result.status, 404);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, 'JOB_TASK_NOT_FOUND');
  assert.equal(result.body.reason, undefined, 'a refusal is not a reason');
});

/**
 * Expose the request object a still-running `callPlane` is using.
 *
 * `callPlane` resolves only after the handler settles, so a test that must act on
 * the request WHILE the observation is in flight needs the object earlier. The
 * closure is captured at construction and read here, after the handler has started.
 * @param {Promise<object>} pending - the running `callPlane` promise.
 * @returns {Promise<object>} the request double.
 */
async function pendingRequest(pending) {
  // `callPlane` attaches `.request` before awaiting the handler (see below), so a
  // microtask turn is enough for it to be visible. The loop keeps the helper honest
  // if that ordering ever changes.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = pending.request;
    if (found !== undefined) return found;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 1); });
  }
  throw new Error('the request object was never exposed');
}

/**
 * Fire the event node emits when the peer disconnects mid-request.
 *
 * `aborted` is the real signal for "the caller went away before the request
 * completed"; it is what the plane listens for. Emitting it here is exactly what a
 * destroyed socket does.
 * @param {object} request - request double.
 * @returns {void}
 */
function fireAborted(request) {
  request.emit('aborted');
}

/**
 * Resolve once `predicate` is true, giving up after a few seconds.
 * @param {() => boolean} predicate - condition.
 * @returns {Promise<void>} resolves when true.
 */
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
}
