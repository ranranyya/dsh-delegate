// MCP surface tests.
//
// Two property classes are proven here:
//
//   1. **Control-plane separation.** The external MCP surface can exercise an
//      authorization and nothing else. There is no tool that creates a
//      connection, issues/widens a grant, edits settings or touches a credential,
//      and the tool set is asserted as an exact list so a future addition cannot
//      slip in unnoticed. Each tool is also proven to reach only its own
//      execution-plane route — a tool that quietly widened its scope would pass a
//      "does the tool exist" test.
//
//   2. **Secret hygiene.** The connection token is presented on every call and is
//      never present in any tool result or refusal, including the failures an
//      operator is most likely to share (a rejected grant, an unreachable host).
//
// The transport is exercised through an injected `callExecution`, so no socket is
// opened; a separate test drives `createExecutionClient` against a fake fetch to
// prove the wire shape (method, path, bearer header) without a live harness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import {
  LATEST_PROTOCOL_VERSION,
  MAX_TOOL_TEXT_CHARS,
  RPC_ERRORS,
  SUPPORTED_PROTOCOL_VERSIONS,
  TOOLS,
  createMcpServer,
  serveStdio,
} from '../src/mcp/server.js';
import { createExecutionClient, readConfig } from '../bin/dsh-delegate-mcp.js';
import { publishRuntimeEndpoint } from '../src/runtime/endpoint-discovery.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { createExecutionHandler, EXECUTION_PREFIX } from '../src/http/execution-plane.js';
import { JobEngine, TASK_STATES } from '../src/jobs/engine.js';
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
  validSettings,
} from './helpers/fakes.js';

const TOKEN = 'connection-token-value-never-echoed-abc123';

/**
 * Build a server over a recording `callExecution`.
 * @param {object} [options] - `answer`: value to resolve, `fail`: error to throw.
 * @returns {object} server plus `seen` calls.
 */
function fixture(options = {}) {
  const seen = [];
  const server = createMcpServer({
    async callExecution(route, payload) {
      seen.push({ route, payload });
      if (options.fail !== undefined) throw options.fail;
      return options.answer ?? { ok: true, route };
    },
  });
  return { server, seen };
}

/**
 * The tool-name list, sorted, asserted as an exact closed set.
 *
 * `delegate_preflight` is included deliberately: it is a read-only workspace read,
 * not a fifth control-plane verb, so it belongs in the closed set rather than
 * beside it. Anything else appearing here must be a decision, not a diff.
 */
const EXPECTED_TOOLS = ['delegate_cancel', 'delegate_preflight', 'delegate_result', 'delegate_status', 'delegate_submit'];

// ---------------------------------------------------------------------------
// 1. The exposed surface cannot authorize, configure or touch credentials
// ---------------------------------------------------------------------------

test('the MCP surface exposes exactly five bounded tools and no control-plane tool', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  // Named explicitly so the reason is in the failure message, not only in a diff.
  for (const forbidden of ['connection', 'grant', 'settings', 'credential', 'secret', 'authorize']) {
    for (const tool of TOOLS) {
      assert.equal(tool.name.includes(forbidden), false, `${tool.name} must not name a control-plane action`);
    }
  }
});

test('no tool argument can carry a connection token, a credential value or a settings document', () => {
  for (const tool of TOOLS) {
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    for (const forbidden of ['token', 'secret', 'apiKey', 'credential', 'settings']) {
      assert.equal(properties.includes(forbidden), false, `${tool.name} must not accept ${forbidden}`);
    }
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must refuse undeclared arguments`);
  }
});

test('each tool reaches exactly its own execution-plane route', async () => {
  const { server, seen } = fixture();
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
  const cases = [
    ['delegate_status', {}, 'status', {}],
    ['delegate_submit', { workspacePath: 'C:\\w', prompt: 'go' }, 'submit',
      { workspacePath: 'C:\\w', prompt: 'go' }],
    ['delegate_result', { taskId: 't1' }, 'result', { taskId: 't1' }],
    ['delegate_cancel', { taskId: 't1' }, 'cancel', { taskId: 't1' }],
    ['delegate_preflight', { workspacePath: 'C:\\w' }, 'preflight', { workspacePath: 'C:\\w' }],
    ['delegate_preflight', { workspacePath: 'C:\\w', allowShared: true }, 'preflight',
      { workspacePath: 'C:\\w', allowShared: true }],
  ];
  for (const [name, args, route, forwarded] of cases) {
    seen.length = 0;
    const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(response.result.isError, undefined, `${name} must not be an error`);
    assert.deepEqual(seen, [{ route, payload: forwarded }], `${name} must reach only ${route}`);
  }
});

test('delegate_preflight refuses a missing, non-boolean or undeclared argument', async () => {
  const { server, seen } = fixture();
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const cases = [
    [{}, 'MCP_ARGUMENT_REQUIRED'],
    [{ workspacePath: '   ' }, 'MCP_ARGUMENT_REQUIRED'],
    [{ workspacePath: 'C:\\w', allowShared: 'true' }, 'MCP_ARGUMENT_TYPE'],
    [{ workspacePath: 'C:\\w', isolation: 'worktree' }, 'MCP_ARGUMENT_UNKNOWN'],
    [{ workspacePath: 'C:\\w', prompt: 'go' }, 'MCP_ARGUMENT_UNKNOWN'],
  ];
  for (const [args, code] of cases) {
    const response = await server.handle({
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_preflight', arguments: args },
    });
    assert.equal(response.result.isError, true, `${JSON.stringify(args)} must be refused`);
    assert.equal(JSON.parse(response.result.content[0].text).error.code, code);
  }
  // A refused call reaches no route at all: the plane is never asked to guess.
  assert.deepEqual(seen, []);
});

test('submit does not accept connection or per-task authorization parameters', async () => {
  const { server, seen } = fixture();
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const grantResponse = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/w', prompt: 'go', grantId: 'g1' } },
  });
  assert.equal(grantResponse.result.isError, true);
  assert.equal(JSON.parse(grantResponse.result.content[0].text).error.code, 'MCP_ARGUMENT_UNKNOWN');
  const response = await server.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/w', prompt: 'go', authorization: 'session' } },
  });
  assert.equal(response.result.isError, true);
  assert.equal(JSON.parse(response.result.content[0].text).error.code, 'MCP_ARGUMENT_UNKNOWN');
  assert.deepEqual(seen, [], 'legacy authorization parameters must not reach the execution plane');
});

test('an undeclared argument is refused before any harness call', async () => {
  const { server, seen } = fixture();
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_result', arguments: { taskId: 't1', workspacePath: '/etc' } },
  });
  assert.equal(response.result.isError, true);
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.error.code, 'MCP_ARGUMENT_UNKNOWN');
  assert.deepEqual(seen, [], 'a malformed argument must not reach the harness');
});

test('a local MCP submission needs no grant parameter', async () => {
  const { server, seen } = fixture();
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/w', prompt: 'go' } },
  });
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(seen[0].payload, { workspacePath: '/w', prompt: 'go' });
});

// ---------------------------------------------------------------------------
// 2. Protocol behaviour
// ---------------------------------------------------------------------------

test('initialize answers with a protocol version this server can actually speak', async () => {
  const { server } = fixture();
  const known = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(known.result.protocolVersion, '2025-03-26');
  assert.deepEqual(known.result.capabilities, { tools: { listChanged: false } });
  assert.equal(known.result.serverInfo.name, 'dsh-delegate');

  // An unknown revision is answered with this server's latest, which is what the
  // protocol requires: the client decides whether it can proceed.
  const unknown = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(unknown.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(unknown.result.protocolVersion));
});

test('tools are not served before initialize, and a notification is never answered', async () => {
  const { server } = fixture();
  const early = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(early.error.code, RPC_ERRORS.invalidRequest);

  const notification = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification, null, 'a notification must produce no response');
});

test('an unknown method is a protocol error and an unknown tool is an invalid-params error', async () => {
  const { server } = fixture();
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const unknownMethod = await server.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
  assert.equal(unknownMethod.error.code, RPC_ERRORS.methodNotFound);

  const unknownTool = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_grant' } });
  assert.equal(unknownTool.error.code, RPC_ERRORS.invalidParams);
});

test('a harness refusal becomes a tool error carrying the harness code, not a protocol failure', async () => {
  const { server } = fixture({
    fail: Object.assign(new Error('no such grant for this connection'), { code: 'GRANT_UNKNOWN' }),
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delegate_submit', arguments: { workspacePath: '/w', prompt: 'go' } },
  });
  assert.equal(response.result.isError, true);
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'GRANT_UNKNOWN');
  assert.equal(JSON.stringify(response).includes(TOKEN), false);
});

// ---------------------------------------------------------------------------
// 3. Bounded results stay parseable JSON
// ---------------------------------------------------------------------------
//
// A concrete plugin-self-development failure is pinned here: `delegate_result`
// over a dirty repository whose audit diff exceeded the bound returned text that
// *began* as JSON and ended with a plain `…[truncated: …]` note. The coordinator's
// MCP client called `JSON.parse` on that text, which threw, and the delegation had
// to be cancelled — losing a finished task's result entirely.
//
// The contract these tests hold is therefore stronger than "fits the bound":
// every `tools/call` answer must be valid JSON, within the bound in both
// compact and pretty encodings, and — when it had to be trimmed — must say so
// structurally, with task identity, state, phase, routing, refusal and
// acceptance intact.

/**
 * A realistic settled task view, as the engine's `view()` shapes it.
 * @param {object} [overrides] - fields merged over the base task.
 * @returns {object} `{ ok: true, task }` answer.
 */
function resultAnswer(overrides = {}) {
  return {
    ok: true,
    task: {
      taskId: 'task-20261023-abcdef',
      state: 'awaiting-host-review',
      phase: 'review',
      createdAt: 1_760_000_000_000,
      startedAt: 1_760_000_000_100,
      endedAt: 1_760_000_000_900,
      sourcePath: '/repo',
      workspacePath: '/repo',
      executionWorkspacePath: null,
      isolation: 'none',
      connectionId: 'conn-1',
      grantId: 'grant-1',
      authorization: 'task',
      effective: {
        worker: { model: 'deepseek-v4.1-flash', reasoningEffort: 'high', isolation: 'none' },
        review: { model: 'deepseek-v4.1-flash', reasoningEffort: 'medium' },
        provenance: 'settings',
      },
      route: {
        providerId: 'deepseek', providerRoute: 'deepseek-native', model: 'deepseek-v4.1-flash', reasoningEffort: 'high',
      },
      reviewRoute: {
        providerId: 'deepseek', providerRoute: 'deepseek-native', model: 'deepseek-v4.1-flash', reasoningEffort: 'medium',
      },
      reviewRouteError: null,
      worktree: null,
      baseline: { head: 'a'.repeat(40), dirtyBaseline: true, preexistingChanges: 3 },
      diff: {
        head: 'a'.repeat(40),
        files: ['src/mcp/server.js', 'tests/mcp.test.js'],
        fileCount: 2,
        changes: [{ path: 'src/mcp/server.js', added: 120, removed: 8 }],
        patchText: 'diff --git a/src/mcp/server.js b/src/mcp/server.js\n+fixed\n',
        patchTruncated: false,
        sensitiveContentWithheld: true,
        capturedAt: 1_760_000_000_950,
      },
      execution: {
        outcome: 'completed',
        text: 'implemented the bounded projection',
        reasoningOnly: false,
        usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
        turnEnd: 'end_turn',
        agentId: 'agent-1',
        sessionId: 'session-1',
        cancelCause: null,
        error: null,
      },
      review: { state: 'completed', verdict: 'approve', text: 'looks correct', error: null, denials: [] },
      error: null,
      cancelledBy: null,
      hostAcceptance: null,
      selfApproved: false,
      ...overrides,
    },
  };
}

/**
 * Call one tool over an already-initialized server and return its text plus the
 * parsed body, failing explicitly if the text is not JSON.
 * @param {object} server - MCP server.
 * @param {string} name - tool name.
 * @param {object} args - arguments.
 * @returns {Promise<{ text: string, body: object, response: object }>} outcome.
 */
async function callTool(server, name, args) {
  const response = await server.handle({
    jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args },
  });
  const text = response.result.content[0].text;
  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} returned text that is not JSON (${error.message}):\n${text.slice(0, 400)}`);
  }
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS, `${name} answer is ${text.length} chars, above the ${MAX_TOOL_TEXT_CHARS} bound`);
  assert.ok(
    JSON.stringify(body).length <= MAX_TOOL_TEXT_CHARS,
    `${name} answer exceeds the bound once re-serialized compact`,
  );
  return { text, body, response };
}

/** Build an initialized server that always answers with one fixed value. */
async function answering(answer) {
  const { server, seen } = fixture({ answer });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  return { server, seen };
}

test('an oversized delegate_result is still valid JSON within the bound, with its identity and routing intact', async () => {
  // The exact shape that broke a coordinator: a huge audit diff.
  const answer = resultAnswer();
  answer.task.diff.patchText = 'x'.repeat(MAX_TOOL_TEXT_CHARS * 40);
  const { server } = await answering(answer);
  const { body } = await callTool(server, 'delegate_result', { taskId: answer.task.taskId });

  assert.equal(body.ok, true, 'a trimmed answer is still a successful result, not an error payload');
  assert.equal(body.task.taskId, answer.task.taskId, 'task identity must survive truncation');
  assert.equal(body.task.state, answer.task.state, 'state must survive truncation');
  assert.equal(body.task.phase, answer.task.phase, 'phase must survive truncation');
  assert.deepEqual(body.task.route, answer.task.route, 'worker routing must survive truncation');
  assert.deepEqual(body.task.reviewRoute, answer.task.reviewRoute, 'review routing must survive truncation');
  assert.equal(body.task.hostAcceptance, null);
  assert.equal(body.task.selfApproved, false, 'a trimmed result is still not host acceptance');

  // Truncation is stated, structurally, and never as prose appended to JSON.
  assert.equal(body.truncation.truncated, true);
  assert.equal(body.truncation.fullResultIncluded, false);
  assert.equal(typeof body.truncation.fullTextChars, 'number');
  assert.equal(body.truncation.boundChars, MAX_TOOL_TEXT_CHARS);
  const patchCut = body.truncation.fields.find((field) => field.path === 'task.diff.patchText');
  assert.ok(patchCut, 'the trimmed patch must be named in truncation.fields');
  assert.equal(patchCut.field, 'text');
  assert.ok(patchCut.omittedChars > 0);
});

test('a trimmed result keeps bounded execution, review and diff headline rather than dropping them', async () => {
  const answer = resultAnswer();
  answer.task.diff.patchText = 'y'.repeat(MAX_TOOL_TEXT_CHARS * 3);
  answer.task.execution.text = 'step detail '.repeat(4_000);
  answer.task.review.text = 'review note '.repeat(3_000);
  const { server } = await answering(answer);
  const { body } = await callTool(server, 'delegate_result', { taskId: answer.task.taskId });

  // Bounded prose: present, shortened, and not silently emptied.
  assert.ok(body.task.execution.text.length > 0, 'execution text must survive in bounded form');
  assert.ok(body.task.execution.text.length < answer.task.execution.text.length);
  assert.ok(body.task.review.text.length > 0, 'review text must survive in bounded form');
  assert.equal(body.task.review.verdict, 'approve', 'the review verdict is a critical field');
  assert.deepEqual(body.task.execution.usage, answer.task.execution.usage, 'usage counters must survive');

  // Evidence is kept as a headline: which files changed is what a caller acts on.
  assert.deepEqual(body.task.diff.files, answer.task.diff.files);
  assert.equal(body.task.diff.fileCount, answer.task.diff.fileCount);
  assert.equal(body.task.diff.patchText, '', 'the patch body is dropped when the answer does not fit');
  assert.equal(body.task.diff.patchTruncated, true, 'a dropped patch must be marked truncated');

  for (const field of ['task.execution.text', 'task.review.text']) {
    assert.ok(
      body.truncation.fields.some((record) => record.path === field),
      `${field} must be listed as truncated`,
    );
  }
});

test('a truncated answer never claims to be the full result and never leaks the connection token', async () => {
  const answer = resultAnswer();
  answer.task.diff.patchText = `+LEAK ${TOKEN}\n`.repeat(20_000);
  answer.task.execution.text = `Authorization: Bearer ${TOKEN}`;
  const { server } = await answering(answer);
  const { text, body } = await callTool(server, 'delegate_result', { taskId: answer.task.taskId });

  assert.equal(text.includes(TOKEN), false, 'the token the server was started with must never be echoed');
  assert.equal(body.truncation.fullResultIncluded, false, 'a trimmed answer must not be labelled full');
  assert.doesNotMatch(text, /\[truncated: the full result is/u, 'no prose truncation note may be appended to JSON');
});

test('errors are bounded JSON too, including a very long refusal message', async () => {
  const { server } = fixture({ fail: Object.assign(new Error('E'.repeat(MAX_TOOL_TEXT_CHARS * 3)), { code: 'GRANT_UNKNOWN' }) });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_result', arguments: { taskId: 't1' } },
  });
  assert.equal(response.result.isError, true);
  const text = response.result.content[0].text;
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS);
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'GRANT_UNKNOWN');
});

test('unicode, emoji and multi-byte text survive the bound without producing invalid JSON', async () => {
  // A model writing CJK review prose or emoji in a diff is ordinary, and a naive
  // byte/UTF-16 cut can split a surrogate pair and corrupt the string.
  const answer = resultAnswer();
  answer.task.review.text = '审查通过 ✅🚀 '.repeat(6_000);
  answer.task.execution.text = '已实现 🧪'.repeat(5_000);
  answer.task.diff.patchText = '差异 🔧\n'.repeat(20_000);
  answer.task.error = { code: 'NONE', message: '无' };
  const { server } = await answering(answer);
  const { text, body } = await callTool(server, 'delegate_result', { taskId: answer.task.taskId });

  assert.equal(body.truncation.truncated, true);
  // A lone surrogate would re-encode as U+FFFD and is what a naive slice produces.
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(text), false, 'no lone high surrogate may be left behind');
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text), false, 'no lone low surrogate may be left behind');
  assert.equal(text.includes('\uFFFD'), false);
});

test('a task list with many large entries is bounded per entry and still parses', async () => {
  const tasks = Array.from({ length: 40 }, (_unused, index) => resultAnswer({
    taskId: `task-${index}`,
    state: 'completed',
  }).task);
  for (const task of tasks) task.diff.patchText = 'z'.repeat(20_000);
  const { server } = await answering({ ok: true, tasks });
  const { body } = await callTool(server, 'delegate_result', { taskId: 'task-0' });

  assert.ok(Array.isArray(body.tasks));
  assert.ok(body.tasks.length > 0);
  assert.equal(body.tasks[0].taskId, tasks[0].taskId, 'the first task identity must survive');
  for (const task of body.tasks) {
    assert.equal(typeof task.taskId, 'string');
    assert.equal(typeof task.state, 'string');
    assert.ok((task.diff?.patchText ?? '').length < 20_000, 'each entry patch must be trimmed');
  }
  assert.equal(body.truncation.truncated, true);
});

test('a small result passes through byte-for-byte with no truncation marker', async () => {
  const answer = resultAnswer();
  const { server } = await answering(answer);
  const { text } = await callTool(server, 'delegate_result', { taskId: answer.task.taskId });
  // Unchanged values must not be rewritten: a caller diffing two reads of the same
  // task must see identical text.
  assert.equal(text, JSON.stringify(answer, null, 2));
  assert.equal('truncation' in JSON.parse(text), false);
});

test('an unrepresentable answer is an explicit refusal, not a silent success', async () => {
  const { server } = await answering({ ok: true, task: { taskId: 't1', state: 'completed', bogus: 10n } });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate_result', arguments: { taskId: 't1' } },
  });
  assert.equal(response.result.isError, true, 'a value that cannot be serialized must not look like a result');
  const body = JSON.parse(response.result.content[0].text);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'MCP_RESULT_UNSERIALIZABLE');
});

test('delegate_submit and delegate_cancel answers are bounded the same way', async () => {
  for (const tool of ['delegate_submit', 'delegate_cancel']) {
    const answer = resultAnswer();
    answer.task.diff.patchText = 's'.repeat(MAX_TOOL_TEXT_CHARS * 5);
    const { server } = await answering(answer);
    const args = tool === 'delegate_submit'
      ? { workspacePath: '/w', prompt: 'go' }
      : { taskId: answer.task.taskId };
    const { body } = await callTool(server, tool, args);
    assert.equal(body.task.taskId, answer.task.taskId, `${tool} must keep the task identity`);
    assert.equal(body.task.state, answer.task.state);
    assert.equal(body.truncation.truncated, true, `${tool} must state its truncation`);
  }
});

// ---------------------------------------------------------------------------
// 4. Wire shape and configuration
// ---------------------------------------------------------------------------

test('the execution client uses the loopback endpoint without a connection token', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, tasks: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const client = createExecutionClient({
      baseUrl: 'http://127.0.0.1:3210',
      token: TOKEN,
      timeoutMs: 1000,
    });
    await client('status', {});
    await client('submit', { workspacePath: '/w', prompt: 'go' });

    assert.equal(calls[0].url, 'http://127.0.0.1:3210/dsh-delegate/x/status');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[1].url, 'http://127.0.0.1:3210/dsh-delegate/x/tasks');
    assert.equal(calls[1].init.method, 'POST');
    for (const call of calls) {
      assert.equal(call.init.headers.authorization, undefined);
      assert.equal(call.url.includes(TOKEN), false, 'a token must never appear in a URL');
    }
    assert.equal(calls[0].init.body, undefined, 'a GET must carry no body');
  } finally {
    globalThis.fetch = original;
  }
});

test('a harness failure is surfaced with its own code, and a non-JSON answer is refused', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: { code: 'CONNECTION_UNKNOWN', message: 'no' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
    const client = createExecutionClient({ baseUrl: 'http://127.0.0.1:3210', token: TOKEN, timeoutMs: 1000 });
    await assert.rejects(() => client('status', {}), (error) => {
      assert.equal(error.code, 'CONNECTION_UNKNOWN');
      return true;
    });

    globalThis.fetch = async () => new Response('<html>nope</html>', { status: 502 });
    await assert.rejects(() => client('status', {}), (error) => {
      assert.equal(error.code, 'MCP_HARNESS_MALFORMED');
      return true;
    });

    globalThis.fetch = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' });
    };
    await assert.rejects(() => client('status', {}), (error) => {
      assert.equal(error.code, 'MCP_HARNESS_UNREACHABLE');
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('configuration defaults to live endpoint discovery and ignores legacy token variables', () => {
  const discoveryFile = readConfig({}).discoveryFile;
  assert.deepEqual(readConfig({ DSH_DELEGATE_TOKEN: 'x' }), {
    baseUrl: null,
    discoveryFile,
    timeoutMs: 30_000,
  });
  assert.equal(readConfig({ DSH_DELEGATE_TOKEN: 'x', DSH_DELEGATE_BASE_URL: 'http://localhost:4000/' }).baseUrl,
    'http://localhost:4000', 'a trailing slash must not produce a double slash in a route');
  assert.equal(readConfig({ DSH_HOME: 'C:\\dsh-home' }).discoveryFile,
    'C:\\dsh-home\\data\\dsh-delegate\\runtime-endpoint.json');
  assert.equal(readConfig({ DSH_DELEGATE_DISCOVERY_FILE: 'C:\\custom\\endpoint.json' }).discoveryFile,
    'C:\\custom\\endpoint.json');
  assert.throws(() => readConfig({ DSH_DELEGATE_TOKEN: 'x', DSH_DELEGATE_BASE_URL: 'file:///etc' }), (error) => {
    assert.equal(error.code, 'MCP_CONFIG_INVALID');
    return true;
  });
});

test('the execution client rereads the DSH endpoint before every tool call', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'dsh-endpoint-client-'));
  const discoveryFile = join(directory, 'runtime-endpoint.json');
  const seen = [];
  const original = globalThis.fetch;
  let firstLease;
  let secondLease;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const config = readConfig({ DSH_DELEGATE_DISCOVERY_FILE: discoveryFile });
    const client = createExecutionClient(config);
    firstLease = await publishRuntimeEndpoint({ filePath: discoveryFile, host: '127.0.0.1', port: 49111 });
    await client('status', {});

    secondLease = await publishRuntimeEndpoint({ filePath: discoveryFile, host: '127.0.0.1', port: 49112 });
    await client('status', {});

    assert.deepEqual(seen, [
      'http://127.0.0.1:49111/dsh-delegate/x/status',
      'http://127.0.0.1:49112/dsh-delegate/x/status',
    ]);
  } finally {
    globalThis.fetch = original;
    await firstLease?.dispose();
    await secondLease?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the execution client reports a missing discovery record without making a request', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'dsh-endpoint-missing-'));
  const original = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return new Response('{}');
  };
  try {
    const client = createExecutionClient(readConfig({ DSH_DELEGATE_DISCOVERY_FILE: join(directory, 'missing.json') }));
    await assert.rejects(() => client('status', {}), (error) => {
      assert.equal(error.code, 'MCP_ENDPOINT_NOT_FOUND');
      return true;
    });
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test('the stdio loop answers one message per line and survives a malformed line', async () => {
  const { Readable, Writable } = await import('node:stream');
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
    // A broken line must not end the session.
    'this is not json\n',
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`,
  ]);
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const { server } = fixture();
  await serveStdio({ input, output, server });

  const lines = chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].result.serverInfo.name, 'dsh-delegate');
  assert.equal(lines[1].error.code, RPC_ERRORS.parse);
  assert.equal(lines[2].result.tools.length, 5);
});

/**
 * Collect the transitive static-import closure of one ES module.
 *
 * Only relative specifiers are followed; a bare specifier is recorded as an
 * external dependency of the importing file. Dynamic `import()` and `require`
 * are deliberately not followed — the contract under test is about what Node
 * links before the first line of `main` runs, which is exactly the static graph.
 * @param {URL} entry - absolute file URL to start from.
 * @returns {Promise<{ files: Map<string, string[]>, externals: Map<string, Set<string>> }>} closure.
 */
async function staticImportClosure(entry) {
  const { readFile } = await import('node:fs/promises');
  const files = new Map();
  const externals = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const url = queue.shift();
    const key = url.href;
    if (files.has(key)) continue;
    const source = await readFile(url, 'utf8');
    const specifiers = [];
    // Static import/export forms only: `import … from 'x'`, `export … from 'x'`,
    // and side-effect `import 'x'`.
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/gmu)) {
      specifiers.push(match[1]);
    }
    for (const match of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gmu)) {
      specifiers.push(match[1]);
    }
    const relatives = [];
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        relatives.push(specifier);
      } else if (!specifier.startsWith('node:')) {
        if (!externals.has(key)) externals.set(key, new Set());
        externals.get(key).add(specifier);
      }
    }
    files.set(key, relatives);
    for (const specifier of relatives) queue.push(new URL(specifier, url));
  }
  return { files, externals };
}

test('the stdio executable links no DSH runtime package, so any MCP host can spawn it', async () => {
  // A concrete install blocker, pinned: `bin/dsh-delegate-mcp.js` used to import
  // `diagnostic` from `runtime/agent-runner.js`, whose static graph includes
  // `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-agent`. Those are host services,
  // not packaged dependencies, so an MCP client outside DSH got
  //   ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm'
  // at link time — before the executable could even report a missing token.
  //
  // The whole point of this entry is to be spawned by an arbitrary host, so the
  // rule is absolute: its static closure may import Node builtins and this
  // package's own files, and nothing else.
  const { externals, files } = await staticImportClosure(new URL('../bin/dsh-delegate-mcp.js', import.meta.url));

  const offenders = [];
  for (const [file, specifiers] of externals) {
    for (const specifier of specifiers) offenders.push(`${file.slice(file.lastIndexOf('/') + 1)} -> ${specifier}`);
  }
  assert.deepEqual(offenders, [], `the MCP executable must not link external packages;\n${offenders.join('\n')}`);

  // Sanity: the closure is non-trivial, so the assertion above is not vacuous.
  assert.ok(files.size >= 2, `expected a real import graph, saw ${String(files.size)} module(s)`);
  assert.ok(
    [...files.keys()].some((key) => key.endsWith('/src/config/redact.js')),
    'diagnostic is expected to resolve through the dependency-free redaction module',
  );
});

// ---------------------------------------------------------------------------
// 5. Real wire contract: this client against the real execution plane
// ---------------------------------------------------------------------------
//
// Every test above reasons about one side in isolation, and that is exactly how
// the shipped adapter broke: the tool header said `POST /tasks/get`, the tool
// table said route `result`, and the client turned `result` into
// `POST /dsh-delegate/x/tasks/result` — a path the plane has never registered.
// A fake that answers whatever URL it is handed cannot catch that, so the tests
// below put the real `createExecutionClient` in front of the real
// `createExecutionHandler` and assert on the task the plane actually returned.
//
// `globalThis.fetch` is redirected onto the real handler, which is the only seam
// needed: the client still builds its URL, method, headers and body exactly as it
// does in a spawned MCP server, and the plane still applies its transport fence
// (loopback peer and Host, supplied here as a socket would), its exact route
// table, its bearer-token lookup and its connection ownership rules.

/**
 * Run one fetch-style call through the real request/response path the plane uses.
 *
 * The request is a readable stream carrying the JSON body, and the response is a
 * minimal writeHead/end object; both are the shapes the plane's helpers expect,
 * so `readJsonBody` and `sendJson` run unmodified. The barrier is what makes the
 * response reliable: the plane answers synchronously, but the client still reads
 * an actual status code and body, so a refusal cannot be mistaken for data.
 * @param {object} handler - node-style handler from `createExecutionHandler`.
 * @param {string} url - absolute URL.
 * @param {object} init - fetch init.
 * @returns {Promise<Response>} the real response.
 */
async function dispatch(handler, url, init) {
  const { Readable } = await import('node:stream');
  const target = new URL(url);
  const request = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body, 'utf8')]);
  request.url = `${target.pathname}${target.search}`;
  request.method = init.method ?? 'GET';
  request.headers = { ...init.headers };
  // The fence runs in the plane, not in the transport, so the fixture supplies
  // what a real loopback socket would supply: a loopback peer and a loopback
  // Host header. Nothing here bypasses a check the plane still performs.
  request.socket = { remoteAddress: '127.0.0.1' };
  if (request.headers.host === undefined) request.headers.host = target.host;

  const chunks = [];
  const headers = {};
  let status = 200;
  const response = {
    headersSent: false,
    writeHead(code, values) {
      status = code;
      this.headersSent = true;
      Object.assign(headers, values);
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body));
    },
  };
  const barrier = new Promise((resolvePromise) => {
    const originalEnd = response.end.bind(response);
    response.end = (body) => {
      originalEnd(body);
      resolvePromise();
    };
  });
  await handler(request, response);
  await barrier;
  return new Response(Buffer.concat(chunks).toString('utf8'), { status, headers });
}

/**
 * Build the whole serving side for one test: a temporary workspace, a real
 * `AuthorizationRegistry` with an issued connection and token, a real
 * `JobEngine` over faked native services (no model and no API key is contacted),
 * and the real execution-plane handler.
 * @param {object} [options] - `agents`: override the fake agent registry.
 * @returns {Promise<{connection: object, grant: object, workspace: string, handler: Function, engine: object, close: () => Promise<void>}>} fixture.
 */
async function executionPlaneFixture(options = {}) {
  const dir = await makeTempDir();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  const enabled = options.delegationEnabled !== false;
  await settings.replace({ ...validSettings(), delegationEnabled: enabled });
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  // The fakes answer the provider route and one assistant turn in memory. No
  // credential, endpoint or model is reached.
  const agents = options.agents ?? fakeAgents({ respond: { text: 'implemented the change' } });
  // A placed run drives the Agent the session controller resolves, so the
  // controller gets the same scripted turn the agent fake would have produced.
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({
    workspaces,
    ...(options.busy === true
      // A never-idle conversation: only a cancel can end such a run.
      ? {}
      : (agents.respondPlan === undefined ? {} : { respond: agents.respondPlan })),
  });
  if (options.busy === true) {
    const resolveOriginal = sessionController.resolveAgent.bind(sessionController);
    sessionController.resolveAgent = async (sessionId) => {
      const found = await resolveOriginal(sessionId);
      const agent = found.agent;
      if (agent !== undefined) {
        agent.followup = (message) => { agent.followups.push(message); };
        agent.whenIdle = async () => { await new Promise(() => {}); };
      }
      return found;
    };
  }
  const deps = {
    agents,
    agentPresets: {
      mounts: [],
      async mount(ctx, id) {
        this.mounts.push({ id });
        ctx.tools.schemas = () => ['read', 'glob', 'grep'].map((name) => ({ name, description: name, parameters: {} }));
        return { id: id ?? 'default-preset' };
      },
    },
    sessions: { async flush() {} },
    // Placement, wired the way `src/index.js` wires it: a worker run must be
    // grouped into a real DSH Workspace keyed by its execution directory. Without
    // these the engine (correctly) refuses every dispatch with
    // `JOB_CONVERSATION_UNAVAILABLE`, which is not what these tests measure.
    workspaces,
    sessionController,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth,
    locks,
    runGit: options.runGit ?? (async (_cwd, args) => {
      const key = args.join(' ');
      if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
      if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
      if (key === 'rev-parse --verify HEAD') return { stdout: `${'a'.repeat(40)}\n`, code: 0 };
      if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
      if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '2\t0\tsrc/a.js\u0000', code: 0 };
      if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+implementation\n', code: 0 };
      return { stdout: '', code: 0 };
    }),
    providerRegistry: {
      async ensure(providers) {
        const routes = new Map();
        for (const provider of providers) routes.set(provider.id, `${provider.id}-native`);
        return { routes };
      },
    },
    logger: { info() {}, warn() {} },
    authorizationMode: 'switch',
    delegationEnabled: enabled,
  };
  const engine = new JobEngine(deps);
  deps.engine = engine;
  const handler = createExecutionHandler({ ...deps, getBindHost: () => '127.0.0.1' });

  const connection = { connectionId: 'local-mcp', label: 'Local MCP', token: null };
  const grant = null;

  return {
    connection,
    grant,
    workspace,
    engine,
    handler,
    agents,
    async close() {
      await engine.dispose();
      await cleanup(dir);
    },
  };
}

/**
 * Poll one task view through the real engine until it leaves preflight.
 * @param {object} engine - job engine.
 * @param {string} taskId - task id.
 * @param {string} connectionId - owning connection.
 * @returns {Promise<object>} the settled view.
 */
async function settleTask(engine, taskId, connectionId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = engine.get(taskId);
    if (task.connectionId === connectionId && task.state !== TASK_STATES.pending && task.state !== TASK_STATES.running) {
      return task;
    }
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  return engine.get(taskId);
}

/**
 * Run a body with `globalThis.fetch` redirected onto one plane fixture.
 *
 * The bridge is origin-checked: a URL outside the fake origin would be a bug in
 * the client under test, not something to paper over by answering it anyway.
 * @param {object} plane - fixture from {@link executionPlaneFixture}.
 * @param {string} origin - base URL the client is configured with.
 * @param {(client: Function) => Promise<void>} body - test body.
 * @param {object} [config] - extra client config fields.
 * @returns {Promise<void>} resolves after the body.
 */
async function withPlane(plane, origin, body, config = {}) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith(`${origin}/`), `the client must address the configured origin, saw ${String(url)}`);
    seen.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
    return await dispatch(plane.handler, String(url), init ?? {});
  };
  try {
    const client = createExecutionClient({ baseUrl: origin, timeoutMs: 5_000, ...config });
    await body(client, seen);
  } finally {
    globalThis.fetch = original;
  }
}

test('delegate_result retrieves the intended task through the real execution plane', async () => {
  const plane = await executionPlaneFixture();
  const origin = 'http://127.0.0.1:3210';
  try {
    const server = createMcpServer({
      callExecution: createExecutionClient({ baseUrl: origin, timeoutMs: 5_000 }),
    });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const original = globalThis.fetch;
    const wire = [];
    globalThis.fetch = async (url, init) => {
      wire.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return await dispatch(plane.handler, String(url), init ?? {});
    };
    try {
      const submitted = await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'delegate_submit',
          arguments: { workspacePath: plane.workspace, prompt: 'implement the change' },
        },
      });
      assert.equal(submitted.result.isError, undefined, submitted.result.content?.[0]?.text);
      const taskId = JSON.parse(submitted.result.content[0].text).task.taskId;
      assert.match(taskId, /^task-/u);
      await settleTask(plane.engine, taskId, 'local-mcp');

      const read = await server.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'delegate_result', arguments: { taskId } },
      });
      // The heart of the regression: before the fix this was `isError` with
      // EXECUTION_ROUTE_UNKNOWN, because the client asked for /tasks/result.
      assert.equal(read.result.isError, undefined, `delegate_result failed: ${read.result.content[0].text}`);
      const body = JSON.parse(read.result.content[0].text);
      assert.equal(body.ok, true);
      assert.equal(body.task.taskId, taskId, 'the read must return the task that was submitted');
      assert.equal(body.task.connectionId, 'local-mcp');
      assert.equal(body.task.execution.text, 'implemented the change');

      // The wire, not just the answer: the plane's own routes received the calls.
      assert.deepEqual(wire, [
        `POST ${EXECUTION_PREFIX}/tasks`,
        `POST ${EXECUTION_PREFIX}/tasks/get`,
      ]);
      assert.equal(wire.includes(`POST ${EXECUTION_PREFIX}/tasks/result`), false, 'the plane serves no /tasks/result route');
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    await plane.close();
  }
});

test('a real task with an audit diff over the bound still reads back as parseable JSON', async () => {
  // The reported failure, end to end: a dirty repository whose audit diff exceeds
  // the tool-text bound. Earlier the text was sliced and a prose note appended, so
  // the coordinator's `JSON.parse` threw and the delegation had to be cancelled.
  // This drives the real engine, the real plane and the real client, and asserts
  // the answer parses, fits, and still says what task it describes.
  const bigDiff = `diff --git a/huge.txt b/huge.txt\n${'+generated line payload\n'.repeat(60_000)}`;
  const plane = await executionPlaneFixture({
    runGit: async (_cwd, args) => {
      const key = args.join(' ');
      if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
      if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
      if (key === 'rev-parse --verify HEAD') return { stdout: `${'a'.repeat(40)}\n`, code: 0 };
      if (args[0] === 'status') return { stdout: ' M huge.txt\u0000', code: 0 };
      if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '60000\t0\thuge.txt\u0000', code: 0 };
      if (args[0] === 'diff') return { stdout: bigDiff, code: 0 };
      // A bounded patch read asks for the file's content; give it the same bulk.
      if (args[0] === 'show' || args[0] === 'cat-file') return { stdout: bigDiff, code: 0 };
      return { stdout: '', code: 0 };
    },
  });
  const origin = 'http://127.0.0.1:3210';
  try {
    const server = createMcpServer({
      callExecution: createExecutionClient({ baseUrl: origin, timeoutMs: 5_000 }),
    });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => await dispatch(plane.handler, String(url), init ?? {});
    try {
      const submitted = await server.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'delegate_submit',
          arguments: { workspacePath: plane.workspace, prompt: 'generate a large change' },
        },
      });
      assert.equal(submitted.result.isError, undefined, submitted.result.content?.[0]?.text);
      const taskId = JSON.parse(submitted.result.content[0].text).task.taskId;
      await settleTask(plane.engine, taskId, 'local-mcp');

      // The engine really produced an oversized view; otherwise this test would be
      // vacuous and prove nothing about the bound.
      const settled = plane.engine.get(taskId);
      const full = JSON.stringify(settled);
      assert.ok(full.length > MAX_TOOL_TEXT_CHARS, `the fixture diff must exceed the bound, saw ${full.length} chars`);

      const read = await server.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'delegate_result', arguments: { taskId } },
      });
      const text = read.result.content[0].text;
      // The regression itself: this call used to throw here rather than answer.
      const body = JSON.parse(text);
      assert.ok(text.length <= MAX_TOOL_TEXT_CHARS, `answer is ${text.length} chars, above ${MAX_TOOL_TEXT_CHARS}`);
      assert.equal(read.result.isError, undefined, 'a trimmed result of a completed task is not an error');

      assert.equal(body.ok, true);
      assert.equal(body.task.taskId, taskId, 'the trimmed answer still names the task');
      assert.equal(body.task.connectionId, 'local-mcp');
      assert.equal(body.task.state, settled.state);
      assert.equal(body.task.phase, settled.phase, 'phase must be carried through unchanged');
      assert.equal(body.task.route.providerRoute, settled.route.providerRoute, 'worker routing must survive');
      assert.deepEqual(body.task.reviewRoute, settled.reviewRoute, 'review routing must survive unchanged');
      assert.equal(body.task.review.verdict, settled.review.verdict);
      assert.equal(body.task.selfApproved, false);
      assert.equal(body.task.hostAcceptance, null);

      assert.equal(body.truncation.truncated, true);
      assert.equal(body.truncation.fullResultIncluded, false);
      assert.ok(
        body.truncation.fields.some((field) => field.path.startsWith('task.diff')),
        'the trimmed diff must be named in truncation.fields',
      );
      // The changed-file headline is what a caller acts on, so it must survive even
      // when the patch itself does not.
      assert.deepEqual(body.task.diff.files, settled.diff.files, 'the changed-file headline survives unchanged');
      assert.equal(body.task.diff.fileCount, settled.diff.fileCount);
    } finally {
      globalThis.fetch = original;
    }
  } finally {
    await plane.close();
  }
});

test('every tool route the client builds exists on the real plane', async () => {
  const plane = await executionPlaneFixture();
  const origin = 'http://127.0.0.1:3210';
  try {
    await withPlane(plane, origin, async (client, seen) => {
      // status: the plane answers with this connection's grants and posture.
      const status = await client('status', {});
      assert.equal(status.ok, true);
      assert.equal(status.connection.connectionId, 'local-mcp');
      assert.deepEqual(status.grants, []);
      assert.equal(typeof status.delegation, 'object');

      // submit uses only the DSH-side switch; no connection token or grant is sent.
      const submitted = await client('submit', {
        workspacePath: plane.workspace,
        prompt: 'implement the change',
      });
      const taskId = submitted.task.taskId;
      assert.equal(submitted.task.connectionId, 'local-mcp');

      // result: reads that same task back through POST /tasks/get.
      const read = await client('result', { taskId });
      assert.equal(read.task.taskId, taskId);

      // cancel: cancel is only meaningful while a task is still live, so this
      // reads the view first and asks only if the run has not already settled.
      // The assertion is on the route (below) and on a task of this connection
      // coming back, never on a state the engine decides for itself.
      await settleTask(plane.engine, taskId, 'local-mcp');
      const cancelled = await client('cancel', { taskId });
      assert.equal(cancelled.task.taskId, taskId);
      assert.equal(cancelled.task.connectionId, 'local-mcp');

      // Each call reached exactly one plane route, and none of them 404'd on a
      // path the plane does not register.
      assert.deepEqual(seen, [
        `GET ${EXECUTION_PREFIX}/status`,
        `POST ${EXECUTION_PREFIX}/tasks`,
        `POST ${EXECUTION_PREFIX}/tasks/get`,
        `POST ${EXECUTION_PREFIX}/tasks/cancel`,
      ]);
    });
  } finally {
    await plane.close();
  }
});

test('the real MCP execution plane refuses submissions while the master switch is off', async () => {
  const plane = await executionPlaneFixture({ delegationEnabled: false });
  const origin = 'http://127.0.0.1:3210';
  try {
    await withPlane(plane, origin, async (client) => {
      const status = await client('status', {});
      assert.equal(status.delegation.authorized, false);
      await assert.rejects(
        () => client('submit', { workspacePath: plane.workspace, prompt: 'must be refused' }),
        (error) => error.code === 'DELEGATION_DISABLED',
      );
    });
    assert.equal(plane.agents.created.length, 0, 'the disabled plane must not create an agent');
  } finally {
    await plane.close();
  }
});

test('the plane refuses an unrouted path, so the route table cannot be slack', async () => {
  // Pins the failure that was actually observed: the historical client path
  // /tasks/result is not a route, and the refusal is EXECUTION_ROUTE_UNKNOWN.
  // If the plane ever grew that alias, this test would fail and the mapping
  // would have to be reconsidered rather than silently accepted.
  const plane = await executionPlaneFixture();
  const origin = 'http://127.0.0.1:3210';
  try {
    const attempts = [
      ['GET', `${EXECUTION_PREFIX}/status`],
      ['POST', `${EXECUTION_PREFIX}/tasks`],
      ['POST', `${EXECUTION_PREFIX}/tasks/get`],
      ['POST', `${EXECUTION_PREFIX}/tasks/cancel`],
    ];
    for (const [method, path] of attempts) {
      const response = await dispatch(plane.handler, `${origin}${path}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      const body = await response.json();
      // Every real route is reached and fails only on its own argument check,
      // never with a routing refusal.
      assert.notEqual(body?.error?.code, 'EXECUTION_ROUTE_UNKNOWN', `${method} ${path} must be a registered plane route`);
    }
    const stale = await dispatch(plane.handler, `${origin}${EXECUTION_PREFIX}/tasks/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-x' }),
    });
    assert.equal(stale.status, 404);
    assert.equal((await stale.json()).error.code, 'EXECUTION_ROUTE_UNKNOWN');
  } finally {
    await plane.close();
  }
});

test('delegate_cancel stops a live task through the real plane and records its origin', async () => {
  // A live cancel is the only case that proves the route, because cancelling an
  // already-terminal task is a legitimate no-op. A PLACED run drives a resolved
  // agent, so the busy turn is modelled on the session controller's side: its
  // agent absorbs the prompt and never becomes idle, which keeps the task
  // genuinely running until the tool call arrives.
  const plane = await executionPlaneFixture({ busy: true });
  const origin = 'http://127.0.0.1:3210';
  try {
    await withPlane(plane, origin, async (client) => {
      const submitted = await client('submit', {
        workspacePath: plane.workspace,
        prompt: 'long running change',
      });
      const taskId = submitted.task.taskId;
      const cancelled = await client('cancel', { taskId });
      assert.equal(cancelled.task.taskId, taskId);
      assert.equal(cancelled.task.state, TASK_STATES.cancelled, 'a live task must end cancelled');
      assert.equal(cancelled.task.cancelledBy, 'connection', 'the MCP cancellation must retain its origin');
    });
  } finally {
    await plane.close();
  }
});

test('an unmapped route is refused locally instead of being sent as a guessed path', async () => {
  // The previous scheme derived the path from the route name, so any route
  // string became a request. Now the table is closed: an unknown route is a
  // local refusal with its own code, and nothing is put on the wire.
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = createExecutionClient({ baseUrl: 'http://127.0.0.1:3210', token: TOKEN, timeoutMs: 1000 });
    for (const route of ['tasks/result', '']) {
      await assert.rejects(() => client(route, { taskId: 't1' }), (error) => {
        assert.equal(error.code, 'MCP_ROUTE_UNMAPPED');
        return true;
      }, `route ${JSON.stringify(route)} must be refused locally`);
    }
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls, [], 'an unmapped route must not be turned into an HTTP request');
});
