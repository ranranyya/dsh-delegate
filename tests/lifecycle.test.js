// Agent lifecycle tests: model handoff, preset mounting, waiting for idle,
// cancellation, timeout, late-handle cleanup, bounded output and redacted
// diagnostics.
//
// The assertions target the native call shape, because a plugin that reports the
// right model but passes a different one to `agents.create` is worse than one
// that fails.

import test from 'node:test';
import assert from 'node:assert/strict';

// The installed native registry, used to prove the runner's identity call shape
// against the real validation instead of only against the fake.
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { Context } from '@deepseek-ai/cordis';

import {
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_BOUNDS,
  diagnostic,
  RUN_CODES,
  RUN_OUTCOMES,
  RunError,
  resolveSessionIdentity,
  runAgent,
  userMessage,
} from '../src/runtime/agent-runner.js';
import { fakeAgentPresets, fakeAgents } from './helpers/fakes.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const SELECTION = { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' };

/**
 * Dependency set every run needs: the agent registry plus the preset registry
 * its setup mounts. A test that omits `agentPresets` is asserting the refusal.
 * @param {object} agents - fake agent registry.
 * @param {object} [presets] - fake preset registry.
 * @returns {object} dependency object.
 */
function depsFor(agents, presets = fakeAgentPresets()) {
  return { agents, agentPresets: presets };
}

test('a run passes the exact provider, model and effort to the harness', async () => {
  const agents = fakeAgents({
    respond: { text: 'done: changed 2 files', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  });

  const result = await runAgent(depsFor(agents), {
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

// --- Request output budget ---------------------------------------------------
//
// The model request the worker makes carries an explicit output allowance. "Not
// 1" was never the bar: an installed worker stopped mid-answer because the
// allowance it was given was a fraction of what its model serves.

test('a native worker request gets at least 32768 output tokens by default', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });

  const options = agents.created[0].options;
  assert.equal(options.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(DEFAULT_MAX_TOKENS, 32768);
  assert.ok(options.maxTokens >= 32768, `a default worker budget must be at least 32768, got ${options.maxTokens}`);
});

test('an explicit, valid caller budget is preserved unchanged', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  for (const requested of [MAX_TOKENS_BOUNDS.min, 4096, MAX_TOKENS_BOUNDS.max]) {
    await runAgent(depsFor(agents), {
      prompt: 'go',
      cwd: CWD,
      selection: SELECTION,
      timeoutMs: 5000,
      maxTokens: requested,
    });
    assert.equal(agents.created.at(-1).options.maxTokens, requested, `budget ${requested} must travel unchanged`);
  }
});

test('an invalid budget is refused before an agent exists, never clamped or dropped', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  for (const requested of [
    0,
    -1,
    1,
    MAX_TOKENS_BOUNDS.min - 1,
    MAX_TOKENS_BOUNDS.max + 1,
    1.5,
    Number.NaN,
    '8192',
    true,
  ]) {
    await assert.rejects(
      () => runAgent(depsFor(agents), {
        prompt: 'go',
        cwd: CWD,
        selection: SELECTION,
        timeoutMs: 5000,
        maxTokens: requested,
      }),
      (error) => error instanceof RunError && error.code === RUN_CODES.maxTokensUnusable,
      `budget ${String(requested)} must be refused`,
    );
  }
  assert.equal(agents.created.length, 0, 'no request may be made with an unusable budget');
});

test('the default preset is mounted before the prompt is delivered', async () => {
  const order = [];
  const presets = fakeAgentPresets({ order });
  const agents = fakeAgents({ respond: { text: 'ok' }, order });

  await runAgent(depsFor(agents, presets), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });

  assert.equal(presets.mounts.length, 1, 'the default native preset must be mounted exactly once');
  // The preset identity is left to the registry: no id means "the default".
  assert.equal(presets.mounts[0].id, undefined);
  assert.deepEqual(order, ['mount', 'followup'], 'the composition must exist before the turn starts');
  assert.equal(presets.mounts[0].ctx, agents.created[0].agentCtx, 'the mount must join this agent scope');
});

test('a missing preset registry is refused before an agent exists', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await assert.rejects(
    () => runAgent({ agents }, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 }),
    (error) => error instanceof RunError && error.code === RUN_CODES.agentPresetsUnavailable,
  );
  assert.equal(agents.created.length, 0);
});

// --- Explicit preset selection ----------------------------------------------
//
// The worker path keeps leaving the identity to the registry, so nothing about a
// default deployment changes. The review path names the composition it measured,
// and the runner is the one place that decides whether such a name may be
// mounted at all: a caller that does not OWN the id cannot re-point a run at a
// composition it did not define.

test('a caller-owned preset id is forwarded to the mount, and the default is still default', async () => {
  const presets = fakeAgentPresets();
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const ownership = { owns: (id) => id === 'owned-review-preset' };

  await runAgent(depsFor(agents, presets), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    presetId: 'owned-review-preset',
    presetOwnership: ownership,
  });
  assert.equal(presets.mounts[0].id, 'owned-review-preset', 'the named composition must be the one mounted');

  // A run that names nothing still asks for the registry default.
  await runAgent(depsFor(agents, presets), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(presets.mounts[1].id, undefined);
});

test('a preset id the caller does not own is refused before an agent exists', async () => {
  const presets = fakeAgentPresets();
  const agents = fakeAgents({ respond: { text: 'ok' } });

  for (const request of [
    { presetId: 'somebody-elses-preset' },
    { presetId: 'somebody-elses-preset', presetOwnership: { owns: () => false } },
    // A "ownership" object without the call the runner needs is not ownership.
    { presetId: 'x', presetOwnership: { owns: 'yes' } },
    { presetId: 'x', presetOwnership: {} },
  ]) {
    await assert.rejects(
      () => runAgent(depsFor(agents, presets), {
        prompt: 'go',
        cwd: CWD,
        selection: SELECTION,
        timeoutMs: 5000,
        ...request,
      }),
      (error) => error instanceof RunError && error.code === RUN_CODES.presetNotOwned,
      JSON.stringify(request),
    );
  }
  assert.equal(agents.created.length, 0, 'no agent may be created for a preset the caller does not own');
  assert.equal(presets.mounts.length, 0, 'and no composition may be mounted');
});

test('a preset registry without mount is refused the same way', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await assert.rejects(
    () => runAgent({ agents, agentPresets: {} }, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 }),
    (error) => error instanceof RunError && error.code === RUN_CODES.agentPresetsUnavailable,
  );
  assert.equal(agents.created.length, 0);
});

test('a preset mount failure fails the run closed and delivers no prompt', async () => {
  const presets = fakeAgentPresets({ fail: new Error('preset roster is empty') });
  const agents = fakeAgents({ respond: { text: 'should not run' } });

  await assert.rejects(
    () => runAgent(depsFor(agents, presets), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 }),
    (error) => error instanceof RunError && error.code === RUN_CODES.presetMountFailed,
  );
  assert.equal(presets.mounts.length, 1);
  assert.equal(agents.created.length, 1, 'the attempted agent is still accounted for');
  assert.equal(agents.created[0].followups.length, 0, 'no prompt may reach an unmounted agent');
  assert.equal(agents.created[0].disposed, false, 'a factory that never published sells no handle to dispose');
});

test('the plugin-owned review composition never becomes the registry default', async () => {
  // The review's own preset is an ADDITION: a worker run must keep joining the
  // configured default, and registering the review composition must not create,
  // select or shadow a deployment preset. This is the property an operator
  // depends on, so it is asserted rather than described.
  const { ReviewPreset, reviewPresetDefinition } = await import('../src/review/preset.js');
  const { nativePresetRegistry } = await import('./helpers/fakes.js');
  const registry = nativePresetRegistry({ defaultId: 'standard' });
  registry.mounts = [];
  registry.mount = async (ctx, id) => {
    // Record exactly what the runner asked for, which is how "the default" is
    // distinguished from "a named composition".
    registry.mounts.push({ ctx, requested: id, mounted: id ?? registry.defaultId });
    return { id: id ?? registry.defaultId };
  };
  const composer = new ReviewPreset({ registry, id: 'dsh-delegate-review-life', importer: async () => ({ apply() {} }) });

  const owned = await composer.preparation({});
  assert.equal(owned, 'dsh-delegate-review-life');
  assert.equal(registry.defaultId, 'standard', 'the configured default is untouched');
  assert.equal(registry.definitions.has('standard'), false, 'no deployment preset is created or selected');
  assert.equal(registry.definitions.size, 1, 'exactly the plugin-owned composition exists');

  // A worker run still joins the default; only the review names the owned id.
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await runAgent(depsFor(agents, registry), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  const workerRun = registry.mounts.at(-1);
  assert.equal(workerRun.requested, undefined, 'a worker run leaves the preset identity to the registry');
  assert.equal(workerRun.mounted, 'standard', 'and therefore still joins the configured default');

  const definition = reviewPresetDefinition('dsh-delegate-review-life');
  assert.deepEqual(
    definition.plugins.map((row) => row.name),
    ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search'],
    'the composition adds no tool rows beyond the two read surfaces',
  );

  await composer.dispose();
  assert.equal(registry.definitions.size, 0, 'unload removes only the plugin-owned composition');
  assert.equal(registry.defaultId, 'standard');
});

test('the workspace cwd reaches the native session metadata', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(agents.created[0].meta.cwd, CWD);
});

test('an omitted effort is sent as absent, never defaulted', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await runAgent(depsFor(agents), {
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
  const pending = runAgent(depsFor(agents), {
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

test('an already-cancelled signal never creates an agent', async () => {
  const agents = fakeAgents({ respond: { text: 'should not run' } });
  const presets = fakeAgentPresets();
  const controller = new AbortController();
  controller.abort();

  const result = await runAgent(depsFor(agents, presets), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  assert.equal(result.outcome, RUN_OUTCOMES.cancelled);
  assert.equal(result.aborted, true);
  assert.equal(agents.created.length, 0, 'a cancelled run must not create an agent at all');
  assert.equal(presets.mounts.length, 0, 'nor mount a composition for it');
});

test('cancellation during a pending mount disposes the late handle and never prompts', async () => {
  let releaseMount;
  const mountGate = new Promise((resolvePromise) => { releaseMount = resolvePromise; });
  const presets = fakeAgentPresets({ defer: mountGate });
  const agents = fakeAgents({ respond: { text: 'should not run' } });

  const controller = new AbortController();
  const pending = runAgent(depsFor(agents, presets), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  // Cancel while setup (the preset mount) is still in flight.
  controller.abort();
  releaseMount();
  const result = await pending;
  // The run is already terminal, but the factory it abandoned is still
  // unwinding; the runner disposes the handle as soon as that handle exists, so
  // give it the tick it needs before asserting ownership is gone.
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });

  assert.equal(result.outcome, RUN_OUTCOMES.cancelled);
  assert.equal(presets.mounts.length, 1, 'the mount was entered before the latch closed');
  assert.ok(agents.created.length <= 1);
  for (const record of agents.created) {
    assert.equal(record.followups.length, 0, 'the prompt must not reach a cancelled run');
    assert.equal(record.disposed, true, 'the handle must not outlive the run');
  }
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

  const result = await runAgent(depsFor(agents), {
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
  const result = await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.failed);
  assert.ok(result.error.length > 0);
});

test('a reasoning-only response counts as activity', async () => {
  const agents = fakeAgents({ respond: { reasoning: 'thinking hard' } });
  const result = await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.equal(result.reasoningOnly, true);
  assert.equal(result.text, '');
});

test('a reasoning block in the final message is reasoning-only activity', async () => {
  // A model that answers with a reasoning block and no text block at all. This
  // is the connectivity case that must not be misreported as a timeout.
  const agents = fakeAgents({ respond: { reasoningBlock: 'deliberated, no answer' } });
  const result = await runAgent(depsFor(agents), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });
  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.equal(result.reasoningOnly, true);
  assert.equal(result.text, '');
});

test('an aborted turn is reported as cancelled, not failed', async () => {
  const agents = fakeAgents({ respond: { reason: 'aborted', text: 'partial' } });
  const result = await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.cancelled);
});

test('an agent error is recorded and redacted', async () => {
  const agents = fakeAgents({
    respond: { error: new Error('401 unauthorized: key sk-abcdefghijklmnopqrstuvwx') },
  });
  const result = await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.failed);
  assert.equal(result.error.includes('sk-abcdefghijklmnopqrstuvwx'), false, 'credentials must not survive into diagnostics');
  assert.match(result.error, /••••/);
});

test('an agent error keeps its provider code', async () => {
  const failure = new Error('context length exceeded');
  failure.code = 'CONTEXT_LENGTH_EXCEEDED';
  const agents = fakeAgents({ respond: { error: failure } });
  const result = await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.outcome, RUN_OUTCOMES.failed);
  assert.match(result.error, /^CONTEXT_LENGTH_EXCEEDED: context length exceeded$/);
});

test('a streamed answer that is also delivered as a final message is counted once', async () => {
  const agents = fakeAgents({
    respond: {
      // The native loop's real shape: deltas first, then the completed message
      // carrying the same text.
      deltas: ['changed ', '2 files'],
      text: 'changed 2 files',
    },
  });
  const result = await runAgent(depsFor(agents), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });

  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.equal(result.text, 'changed 2 files', 'the streamed text must not be duplicated');
  assert.equal(result.textTruncated, false);
});

test('a final message without prior deltas still yields its text', async () => {
  const agents = fakeAgents({ respond: { text: 'only a final message' } });
  const result = await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  assert.equal(result.text, 'only a final message');
});

test('a runaway stream is clamped while it is collected', async () => {
  const agents = fakeAgents({
    respond: {
      // Far past any sane bound: 200 chunks of 1000 characters is 200k of text.
      deltas: Array.from({ length: 200 }, () => 'x'.repeat(1000)),
      reason: 'completed',
    },
  });
  const result = await runAgent(depsFor(agents), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });

  assert.equal(result.textTruncated, true, 'the run must report that it was bounded');
  assert.ok(result.text.length <= 64_000, `retained ${result.text.length} characters`);
  assert.ok(result.text.length >= 63_000, 'the bound must keep usable output, not discard it');
});

test('an oversized prompt is refused before an agent exists', async () => {
  const agents = fakeAgents();
  await assert.rejects(
    () => runAgent(depsFor(agents), { prompt: 'x'.repeat(200_001), cwd: CWD, selection: SELECTION }),
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

// --- Session/agent identity -------------------------------------------------
//
// `CreateAgentOptions.sessionId` is REQUIRED and the native factory creates the
// session, and the agent, under exactly that id: `AgentRegistry.enter()` throws
// `agent id "<id>" does not match session id "<session>"` otherwise, which is how
// a real DSH run failed with `agent id "undefined" does not match session id
// "session-1"`. These tests pin the identity contract from both ends — a fake
// that enforces it and the installed registry that defines it.

const SESSION_ID_SHAPE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('an omitted session id is generated once and used for creation', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  const result = await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });

  assert.equal(agents.created.length, 1);
  const passed = agents.created[0].sessionId;
  assert.equal(typeof passed, 'string', 'agents.create must receive a string identity');
  assert.match(passed, SESSION_ID_SHAPE);
  // The identity that was created is the identity that is reported, on both
  // fields, because the native registry publishes them as one value.
  assert.equal(result.sessionId, passed);
  assert.equal(result.agentId, passed);
});

test('two runs without an id receive two distinct identities', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  const first = await runAgent(depsFor(agents), { prompt: 'a', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  const second = await runAgent(depsFor(agents), { prompt: 'b', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });

  assert.equal(agents.created.length, 2);
  assert.notEqual(agents.created[0].sessionId, agents.created[1].sessionId, 'a shared id would collide in the registry');
  assert.notEqual(first.sessionId, second.sessionId);
  assert.match(first.sessionId, SESSION_ID_SHAPE);
  assert.match(second.sessionId, SESSION_ID_SHAPE);
});

test('a null session id counts as absent and is generated', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const result = await runAgent(depsFor(agents), {
    sessionId: null,
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });
  assert.match(agents.created[0].sessionId, SESSION_ID_SHAPE);
  assert.equal(result.sessionId, agents.created[0].sessionId);
});

test('an explicit session id is preserved verbatim', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  const result = await runAgent(depsFor(agents), {
    sessionId: 'session-caller-owned-7',
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });

  assert.equal(agents.created[0].sessionId, 'session-caller-owned-7', 'the caller owns the identity it supplied');
  assert.equal(result.sessionId, 'session-caller-owned-7');
  assert.equal(result.agentId, 'session-caller-owned-7');
});

test('the identity resolver preserves what it is given and fills only an omission', () => {
  assert.deepEqual(resolveSessionIdentity('session-given'), { value: 'session-given', generated: false });
  const absent = resolveSessionIdentity(undefined);
  assert.equal(absent.generated, true);
  assert.match(absent.value, SESSION_ID_SHAPE);
  assert.notEqual(resolveSessionIdentity(undefined).value, resolveSessionIdentity(undefined).value);
  const nulled = resolveSessionIdentity(null);
  assert.equal(nulled.generated, true);
  assert.match(nulled.value, SESSION_ID_SHAPE);
  // A wrong type is the caller's bug, not an omission: it is not silently
  // replaced by a generated identity.
  assert.deepEqual(resolveSessionIdentity(42), { value: 42, generated: false });
});

test('a session id the native registry cannot admit is refused before any agent exists', async () => {
  for (const [requested, pattern] of [
    ['   ', /blank/],
    [42, /string/],
  ]) {
    const agents = fakeAgents({ respond: { text: 'ok' } });
    await assert.rejects(
      () => runAgent(depsFor(agents), {
        sessionId: requested,
        prompt: 'go',
        cwd: CWD,
        selection: SELECTION,
        timeoutMs: 5000,
      }),
      (error) => error instanceof RunError
        && error.code === RUN_CODES.sessionIdUnusable
        && pattern.test(error.details.reason),
      `sessionId ${JSON.stringify(requested)} must be refused with a stated reason`,
    );
    assert.equal(agents.created.length, 0, 'no agent may be created under an unusable identity');
  }
});

test('a session id already live in the process is refused before any agent exists', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const first = await runAgent(depsFor(agents), {
    sessionId: 'session-live-dup',
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });
  assert.equal(first.outcome, RUN_OUTCOMES.completed);

  await assert.rejects(
    () => runAgent(depsFor(agents), {
      sessionId: 'session-live-dup',
      prompt: 'go again',
      cwd: CWD,
      selection: SELECTION,
      timeoutMs: 5000,
    }),
    (error) => error instanceof RunError
      && error.code === RUN_CODES.sessionIdUnusable
      && /live agent already owns/.test(error.details.reason),
  );
  assert.equal(agents.created.length, 1, 'the second run must not attempt a duplicate identity');
});

test('the runner refuses a factory that would mint no identity, rather than reporting a mismatch', async () => {
  // The strict fake is the guard: it rejects a create call without a string
  // identity with the native registry's own message. A runner that regressed to
  // `sessionId: undefined` would fail here instead of shipping a run whose agent
  // could never be published.
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const strictCall = await agents.create({ meta: { cwd: CWD } }).catch((error) => error);
  assert.ok(strictCall instanceof Error);
  assert.match(strictCall.message, /agent id "undefined" does not match session id/);
});

test('the installed AgentRegistry rejects a create call with no identity, so the runner must generate one', async () => {
  // The acceptance failure reproduced against the real native validation: an
  // agent constructed with no id cannot be entered beside a real session id.
  const ctx = new Context();
  try {
    const registry = new AgentRegistry(ctx);
    assert.throws(
      () => registry.enter({ id: undefined, session: { id: 'session-1' } }, undefined),
      /agent id "undefined" does not match session id "session-1"/,
      'the native registry is the authority this change is shaped around',
    );
    // The shape the runner now produces enters cleanly.
    const detach = registry.enter({ id: 'session-1', session: { id: 'session-1' } }, undefined);
    assert.equal(typeof detach, 'function');
    assert.equal(registry.get('session-1')?.id, 'session-1');
    detach();
    assert.equal(registry.get('session-1'), undefined);
  } finally {
    await ctx.dispose?.();
  }
});

test('a cancelled run still reports the identity it owns', async () => {
  const agents = fakeAgents({ respond: { text: 'should not run' } });
  const controller = new AbortController();
  controller.abort();

  const result = await runAgent(depsFor(agents), {
    sessionId: 'session-cancel-owned',
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  assert.equal(result.outcome, RUN_OUTCOMES.cancelled);
  assert.equal(agents.created.length, 0);
  // No handle exists, so the agent id names the identity the run would have
  // owned instead of being null beside a live session id.
  assert.equal(result.sessionId, 'session-cancel-owned');
  assert.equal(result.agentId, 'session-cancel-owned');
});
