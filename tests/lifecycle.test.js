// Agent lifecycle tests: model handoff, waiting for idle, cancellation,
// timeout, late-handle cleanup, and redacted diagnostics.
//
// The assertions target the native call shape, because a plugin that reports the
// right model but passes a different one to `agents.create` is worse than one
// that fails.

import test from 'node:test';
import assert from 'node:assert/strict';

import { diagnostic, RUN_CODES, RUN_OUTCOMES, RunError, runAgent, userMessage } from '../src/runtime/agent-runner.js';
import { fakeAgents } from './helpers/fakes.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const SELECTION = { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' };

test('a run passes the exact provider, model and effort to the harness', async () => {
  const agents = fakeAgents({
    respond: { text: 'done: changed 2 files', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  });

  const result = await runAgent({ agents }, {
    prompt: 'do the thing',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });

  assert.equal(agents.created.length, 1);
  const options = agents.created[0].options;
  assert.equal(options.provider, 'relay');
  assert.equal(options.model, 'deepseek-chat');
  assert.equal(options.reasoningEffort, 'medium');
  // A usable output budget, not 1: a reasoning model must not be starved.
  assert.ok(options.maxTokens >= 1024, `unexpected maxTokens ${options.maxTokens}`);

  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.equal(result.text, 'done: changed 2 files');
  assert.equal(result.usage.totalTokens, 15);
  assert.equal(agents.created[0].disposed, true, 'the handle must be disposed');
  assert.equal(agents.created[0].followups.length, 1, 'exactly one prompt delivery');
});

test('the workspace cwd reaches the native session metadata', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await runAgent({ agents }, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(agents.created[0].meta.cwd, CWD);
});

test('an omitted effort is sent as absent, never defaulted', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await runAgent({ agents }, {
    prompt: 'go',
    cwd: CWD,
    selection: { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: null },
    timeoutMs: 5000,
  });
  assert.equal('reasoningEffort' in agents.created[0].options, false);
});

test('cancellation before creation settles still disposes the arriving handle', async () => {
  let releaseCreate;
  const agents = {
    created: [],
    disposed: [],
    async create(request) {
      // Resolve creation only when the test says so, to model a slow factory.
      await new Promise((resolvePromise) => { releaseCreate = resolvePromise; });
      const record = { options: request.agentOptions ?? {}, meta: request.meta, followups: [], cancels: [], disposed: false };
      record.agent = {
        id: 'agent-late',
        session: { id: 'session-late' },
        followup: (message) => record.followups.push(message),
        cancel: () => {},
        whenIdle: async () => {},
      };
      const handle = {
        agent: record.agent,
        dispose: async () => {
          record.disposed = true;
          agents.disposed.push(record);
        },
      };
      agents.created.push(record);
      return handle;
    },
  };

  const controller = new AbortController();
  const pending = runAgent({ agents }, {
    prompt: 'long task',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  // Cancel while creation is still in flight.
  controller.abort();
  releaseCreate();
  const result = await pending;

  assert.equal(result.outcome, RUN_OUTCOMES.cancelled);
  assert.equal(agents.created.length, 1);
  assert.equal(agents.created[0].followups.length, 0, 'the prompt must not reach a cancelled run');
  assert.equal(agents.disposed.length, 1, 'the late handle must be disposed');
});

test('a timeout produces a distinct outcome and disposes the agent', async () => {
  const agents = fakeAgents({
    script: async ({ record }) => {
      // Absorb the prompt and stay busy, so the agent never becomes idle and only
      // the runner's own timeout can end this run.
      record.agent.followup = (message) => {
        record.followups.push(message);
        record.idle = false;
      };
    },
  });

  const result = await runAgent({ agents }, {
    prompt: 'slow task',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 60,
  });

  assert.equal(result.outcome, RUN_OUTCOMES.timedOut);
  assert.equal(agents.created[0].disposed, true);
});

test('an empty run is a failure, not a silent success', async () => {
  const agents = fakeAgents({ respond: { reason: 'completed' } });
  const result = await runAgent({ agents }, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.failed);
  assert.ok(result.error.length > 0);
});

test('a reasoning-only response counts as activity', async () => {
  const agents = fakeAgents({ respond: { reasoning: 'thinking hard' } });
  const result = await runAgent({ agents }, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.equal(result.reasoningOnly, true);
  assert.equal(result.text, '');
});

test('an aborted turn is reported as cancelled, not failed', async () => {
  const agents = fakeAgents({ respond: { reason: 'aborted', text: 'partial' } });
  const result = await runAgent({ agents }, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.cancelled);
});

test('an agent error is recorded and redacted', async () => {
  const agents = fakeAgents({
    respond: { error: new Error('401 unauthorized: key sk-abcdefghijklmnopqrstuvwx') },
  });
  const result = await runAgent({ agents }, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.failed);
  assert.equal(result.error.includes('sk-abcdefghijklmnopqrstuvwx'), false, 'credentials must not survive into diagnostics');
  assert.match(result.error, /••••/);
});

test('an oversized prompt is refused before an agent exists', async () => {
  const agents = fakeAgents();
  await assert.rejects(
    () => runAgent({ agents }, { prompt: 'x'.repeat(200_001), cwd: CWD, selection: SELECTION }),
    (error) => error instanceof RunError && error.code === RUN_CODES.promptTooLarge,
  );
  assert.equal(agents.created.length, 0);
});

test('a missing agent registry is a refusal', async () => {
  await assert.rejects(
    () => runAgent({}, { prompt: 'go', cwd: CWD, selection: SELECTION }),
    (error) => error.code === RUN_CODES.agentsUnavailable,
  );
});

test('created user messages carry the native required fields', () => {
  const message = userMessage('hello');
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(message.source, { kind: 'user' });
  assert.equal(Object.isFrozen(message), true);
});

test('diagnostics are bounded and redacted', () => {
  assert.equal(diagnostic(null), null);
  assert.equal(diagnostic(''), null);
  const long = diagnostic('x'.repeat(2000), 100);
  assert.equal(long.length, 100);
  assert.equal(diagnostic('token=abcdefghij').includes('abcdefghij'), false);
});
