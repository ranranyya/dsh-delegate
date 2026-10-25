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
import { fakeAgentPresets, fakeAgents, fakeSessionController, fakeWorkspaceController } from './helpers/fakes.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const SELECTION = { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' };

/**
 * Dependency set every run needs: the agent registry, the preset registry its
 * setup mounts, and the two native controllers that place the run in a DSH
 * Workspace. A run WITHOUT placement is a separate, explicit mode; the default
 * every worker run takes is grouped, so the fakes are grouped by default too.
 * A test that omits `agentPresets` is asserting the refusal.
 *
 * The two controller names are the ones the production wiring uses, and they are
 * deliberately distinct: `workspaces` is `ctx.workspaceController` and
 * `sessionController` is `ctx.sessionController`. `sessions` is the native
 * persistence service the runner flushes through, which is why `placement.sessions`
 * is wired to `sessionController` and NOT to `sessions` — a deps object that put a
 * session planner under `sessions` would be a wiring bug this helper cannot mask.
 * @param {object} agents - fake agent registry.
 * @param {object} [presets] - fake preset registry.
 * @param {object} [placement] - `workspaces`, `sessionController`, `sessionStore`, `sessions` (flush).
 * @returns {object} dependency object.
 */
function depsFor(agents, presets = fakeAgentPresets(), placement = {}) {
  const workspaces = placement.workspaces ?? fakeWorkspaceController();
  // A placed run drives the Agent the controller RESOLVED for its Session (in
  // both conversation modes), not one this run created, so the controller is
  // given the same scripted turn the test handed to the agent registry: the
  // assertions below then read the reply from the conversation the run actually
  // drove, which is the point of placing it.
  const sessionController = placement.sessionController
    ?? fakeSessionController({ workspaces, ...(agents.respondPlan === undefined ? {} : { respond: agents.respondPlan }) });
  return {
    agents,
    agentPresets: presets,
    workspaces,
    // `ctx.sessionController`: the only service that can create or resolve a
    // Session. Not `ctx.sessions`, which cannot.
    sessionController,
    ...(placement.sessionStore === undefined ? {} : { sessionStore: placement.sessionStore }),
    ...(placement.sessions === undefined ? {} : { sessions: placement.sessions }),
    // Test-only handle on the controller, so an assertion can read the Agent the
    // run drove without the test holding a second reference to the same fake.
    // Never read by production code.
    testControllers: { workspaces, sessionController },
  };
}

/**
 * The Agent a placed run actually drove, found in the session controller that
 * resolved it.
 *
 * A placed run never calls `agents.create`, so `agents.created` is empty by
 * design; the conversation it drove is the one the controller resolved for its
 * Session. Reading it from there is what lets a lifecycle assertion follow the
 * run instead of the old creation path.
 * @param {object} result - a run result with `conversation`.
 * @param {object} deps - the dependency object the run was given.
 * @returns {object} the resolved agent.
 */
function drivenAgentOf(result, deps) {
  const controller = deps?.testControllers?.sessionController;
  const sessionId = result?.conversation?.sessionId ?? result?.sessionId;
  assert.ok(controller !== undefined, 'a placed run needs its session controller to read the driven agent');
  const agent = controller.agents.get(sessionId);
  assert.ok(agent !== undefined, `no agent was resolved for session ${sessionId}`);
  return agent;
}

test('a run passes the exact provider, model and effort to the harness', async () => {
  const agents = fakeAgents({
    respond: { text: 'done: changed 2 files', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  });

  const deps = depsFor(agents);
  const result = await runAgent(deps, {
    prompt: 'do the thing',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });

  // A placed run drives the Agent the session controller resolved for its
  // Session, so the selection is asserted where it was actually installed: on
  // that Agent's own context, reported back as the run's `selection` fact.
  assert.equal(result.selection.provider, 'relay');
  assert.equal(result.selection.model, 'deepseek-chat');
  assert.equal(result.selection.reasoningEffort, 'medium');
  assert.equal(result.selection.applied, true, 'the selection must reach the agent, not just be reported');
  // A usable output budget, not 1: a reasoning model must not be starved.
  assert.ok(result.maxTokens >= 1024, `unexpected maxTokens ${result.maxTokens}`);

  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.equal(result.text, 'done: changed 2 files');
  assert.equal(result.usage.totalTokens, 15);
  const driven = drivenAgentOf(result, deps);
  assert.equal(driven.followups.length, 1, 'exactly one prompt delivery');
  assert.equal(agents.created.length, 0, 'a placed run must not create a second agent beside its Session');
});

// --- Request output budget ---------------------------------------------------
//
// The model request the worker makes carries an explicit output allowance. "Not
// 1" was never the bar: an installed worker stopped mid-answer because the
// allowance it was given was a fraction of what its model serves.

test('a native worker request gets at least 32768 output tokens by default', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  const result = await runAgent(depsFor(agents), { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });

  assert.equal(result.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(DEFAULT_MAX_TOKENS, 32768);
  assert.ok(result.maxTokens >= 32768, `a default worker budget must be at least 32768, got ${result.maxTokens}`);
});

test('an explicit, valid caller budget is preserved unchanged', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  for (const requested of [MAX_TOKENS_BOUNDS.min, 4096, MAX_TOKENS_BOUNDS.max]) {
    const result = await runAgent(depsFor(agents), {
      prompt: 'go',
      cwd: CWD,
      selection: SELECTION,
      timeoutMs: 5000,
      maxTokens: requested,
    });
    assert.equal(result.maxTokens, requested, `budget ${requested} must travel unchanged`);
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

// --- The unplaced creation contract -----------------------------------------
//
// Two paths exist in the runner and they are not interchangeable:
//
//  * a PLACED run (the default for every worker task) drives the Agent that
//    `ctx.sessionController.resolveAgent` returns for a Session already created
//    in a DSH Workspace. It never calls `agents.create`, never mounts a preset
//    (the Session's own composition is what the Agent joined), and its identity
//    is the Session's;
//  * an UNPLACED run (`allowUnplaced: true`) creates its own Agent through
//    `agents.create`, which is where the preset mount, the `meta.cwd`, the model
//    options and the caller-owned session identity are observable.
//
// The review is the production caller of the unplaced path (it must not join the
// operator's Workspace history or be resumable by a later `reuse` run), so the
// tests below — which all assert on the CREATION call — state that mode
// explicitly instead of relying on it as an implicit default.

test('the default preset is mounted before the prompt is delivered', async () => {
  const order = [];
  const presets = fakeAgentPresets({ order });
  const agents = fakeAgents({ respond: { text: 'ok' }, order });

  await runAgent(depsFor(agents, presets), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });

  assert.equal(presets.mounts.length, 1, 'the default native preset must be mounted exactly once');
  // The preset identity is left to the registry: no id means "the default".
  assert.equal(presets.mounts[0].id, undefined);
  assert.deepEqual(order, ['mount', 'followup'], 'the composition must exist before the turn starts');
  assert.equal(presets.mounts[0].ctx, agents.created[0].agentCtx, 'the mount must join this agent scope');
});

test('a placed run mounts no second composition onto its resolved agent', async () => {
  // The property that keeps a worker run's tool surface intact: the Agent it
  // drives already joined a composition when the Session was created, and
  // mounting another one here would stack two presets on one agent.
  const presets = fakeAgentPresets();
  const agents = fakeAgents({ respond: { text: 'ok' } });

  const result = await runAgent(depsFor(agents, presets), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
  });

  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.equal(presets.mounts.length, 0, 'a resolved agent must not receive a second preset mount');
  assert.equal(agents.created.length, 0, 'and no agent may be created beside the Session');
});

test('a missing preset registry is refused before an agent exists', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const workspaces = fakeWorkspaceController();
  await assert.rejects(
    () => runAgent({ agents, workspaces, sessionController: fakeSessionController({ workspaces }) }, {
      prompt: 'go',
      cwd: CWD,
      selection: SELECTION,
      timeoutMs: 5000,
    }),
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
    allowUnplaced: true,
  });
  assert.equal(presets.mounts[0].id, 'owned-review-preset', 'the named composition must be the one mounted');

  // A run that names nothing still asks for the registry default.
  await runAgent(depsFor(agents, presets), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });
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
        allowUnplaced: true,
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
  const workspaces = fakeWorkspaceController();
  await assert.rejects(
    () => runAgent({ agents, agentPresets: {}, workspaces, sessionController: fakeSessionController({ workspaces }) }, {
      prompt: 'go',
      cwd: CWD,
      selection: SELECTION,
      timeoutMs: 5000,
    }),
    (error) => error instanceof RunError && error.code === RUN_CODES.agentPresetsUnavailable,
  );
  assert.equal(agents.created.length, 0);
});

test('a preset mount failure fails the run closed and delivers no prompt', async () => {
  const presets = fakeAgentPresets({ fail: new Error('preset roster is empty') });
  const agents = fakeAgents({ respond: { text: 'should not run' } });

  await assert.rejects(
    () => runAgent(depsFor(agents, presets), {
      prompt: 'go',
      cwd: CWD,
      selection: SELECTION,
      timeoutMs: 5000,
      allowUnplaced: true,
    }),
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
  // Asserted on the unplaced creation path, which is where a mount happens.
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await runAgent(depsFor(agents, registry), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });
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
  await runAgent(depsFor(agents), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });
  assert.equal(agents.created[0].meta.cwd, CWD);
});

test('a placed run resolves its Session in the run\'s execution directory', async () => {
  // The placed counterpart of the assertion above: the cwd is not metadata on a
  // create call any more, it is the directory the Session was created in, which is
  // what makes the Workspace group and the `reuse` scope correct.
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const deps = depsFor(agents);
  const result = await runAgent(deps, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });

  const workspace = deps.testControllers.workspaces.workspaces.get(result.conversation.workspaceId);
  assert.ok(workspace !== undefined, 'the run must be grouped into a real Workspace');
  assert.equal(workspace.path, CWD, 'the Workspace must be the execution directory');
  const session = deps.testControllers.sessionController.sessions.get(result.conversation.sessionId);
  assert.equal(session.cwd, CWD, 'the Session must run in that directory');
});

test('an omitted effort is sent as absent, never defaulted', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const result = await runAgent(depsFor(agents), {
    prompt: 'go',
    cwd: CWD,
    selection: { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: null },
    timeoutMs: 5000,
  });
  assert.equal(result.selection.reasoningEffort, null, 'an omitted effort must stay absent');
});

test('an omitted effort is absent in the unplaced create options too', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  await runAgent(depsFor(agents), {
    prompt: 'go',
    cwd: CWD,
    selection: { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: null },
    timeoutMs: 5000,
    allowUnplaced: true,
  });
  assert.equal('reasoningEffort' in agents.created[0].options, false);
});

test('cancellation before creation settles still disposes the arriving handle', async () => {
  let releaseCreate;
  // Resolved once the factory has actually been entered, so the abort below
  // happens mid-creation rather than before the run started (a run aborted before
  // it starts never reaches the factory at all — that is a separate case).
  let creationEntered;
  const entered = new Promise((resolvePromise) => { creationEntered = resolvePromise; });
  const agents = {
    created: [],
    disposed: [],
    async create(request) {
      // Resolve creation only when the test says so, to model a slow factory.
      const gate = new Promise((resolvePromise) => { releaseCreate = resolvePromise; });
      creationEntered();
      await gate;
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
  // This test is about the creation/disposal race on the CREATION path, so it
  // states `allowUnplaced` and a caller-owned identity: a placed run never calls
  // `agents.create` and therefore has no creation race to model.
  const pending = runAgent({ agents, agentPresets: fakeAgentPresets() }, {
    prompt: 'long task',
    cwd: CWD,
    sessionId: 'session-late',
    selection: SELECTION,
    timeoutMs: 60_000,
    signal: controller.signal,
    allowUnplaced: true,
  });

  // Cancel while creation is still in flight.
  await entered;
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

test('a run cancelled before it starts creates no Workspace and no Session', async () => {
  // The orphan this guards against: a cancelled task that still claimed a
  // Workspace (and created a Session in it) leaves an empty group in DSH that no
  // run will ever use, and a conversation a later `reuse` run could resume into.
  const agents = fakeAgents({ respond: { text: 'should not run' } });
  const deps = depsFor(agents);
  const controller = new AbortController();
  controller.abort();

  const result = await runAgent(deps, {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  assert.equal(result.outcome, RUN_OUTCOMES.cancelled);
  assert.equal(deps.testControllers.workspaces.creates.length, 0, 'no Workspace may be created for a cancelled run');
  assert.equal(deps.testControllers.sessionController.creates.length, 0, 'no Session may be created for it either');
  assert.equal(deps.testControllers.sessionController.resolves.length, 0, 'nor may an Agent be resolved');
  assert.equal(agents.created.length, 0);
  assert.equal(result.conversation, null, 'a run that was never placed reports no placement');
});

test('cancellation during a pending mount disposes the late handle and never prompts', async () => {
  let releaseMount;
  const mountGate = new Promise((resolvePromise) => { releaseMount = resolvePromise; });
  const presets = fakeAgentPresets({ defer: mountGate });
  const agents = fakeAgents({ respond: { text: 'should not run' } });

  const controller = new AbortController();
  // The unplaced creation path: this test is about a run cancelled while its
  // preset mount is still in flight, which only the created-agent path performs.
  const pending = runAgent({ agents, agentPresets: presets }, {
    prompt: 'go',
    cwd: CWD,
    sessionId: 'session-mount-late',
    selection: SELECTION,
    timeoutMs: 60_000,
    signal: controller.signal,
    allowUnplaced: true,
  });

  // The mount is entered asynchronously inside `agents.create`, so wait until it
  // has actually been entered before aborting: an abort that lands before the
  // factory is reached is the "already cancelled" case, not this one.
  while (presets.mounts.length === 0) await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
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
    allowUnplaced: true,
  });

  assert.equal(result.outcome, RUN_OUTCOMES.timedOut);
  assert.equal(agents.created[0].disposed, true);
});

test('a placed run times out the same way, and the resolved agent is never disposed', async () => {
  // Two facts, and the second is the one `reuse` depends on: the timeout ends the
  // run, and the Agent it was driving belongs to the Session, so the run must not
  // end the conversation on its way out.
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const workspaces = fakeWorkspaceController();
  // A resolved agent that absorbs its prompt and stays busy: only the runner's own
  // timer can end this run.
  const sessionController = fakeSessionController({ workspaces });
  const resolveOriginal = sessionController.resolveAgent.bind(sessionController);
  sessionController.resolveAgent = async (id) => {
    const found = await resolveOriginal(id);
    if (found.agent !== undefined) {
      found.agent.followup = (message) => { found.agent.followups.push(message); };
      found.agent.whenIdle = async () => { await new Promise(() => {}); };
    }
    return found;
  };
  const deps = depsFor(agents, fakeAgentPresets(), { workspaces, sessionController });

  const result = await runAgent(deps, {
    prompt: 'slow task',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 60,
  });

  assert.equal(result.outcome, RUN_OUTCOMES.timedOut);
  const driven = deps.testControllers.sessionController.agents.get(result.conversation.sessionId);
  assert.ok(driven !== undefined, 'the conversation must still exist after the timeout');
  assert.equal(driven.cancels.length, 1, 'the timeout must cancel the live agent');
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

  const result = await runAgent(depsFor(agents), {
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });

  assert.equal(agents.created.length, 1);
  const passed = agents.created[0].sessionId;
  assert.equal(typeof passed, 'string', 'agents.create must receive a string identity');
  assert.match(passed, SESSION_ID_SHAPE);
  // The identity that was created is the identity that is reported, on both
  // fields, because the native registry publishes them as one value.
  assert.equal(result.sessionId, passed);
  assert.equal(result.agentId, passed);
});

test('a placed run takes its identity from the Session, and mints none of its own', async () => {
  // The placed counterpart: the identity is the DSH Session's, not a generated
  // one, and no `agents.create` call happens at all.
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const deps = depsFor(agents);

  const result = await runAgent(deps, { prompt: 'go', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });

  assert.equal(agents.created.length, 0, 'a placed run must not create an agent');
  const created = deps.testControllers.sessionController.creates;
  assert.equal(created.length, 1, 'exactly one Session is created for one run');
  assert.equal(result.sessionId, result.conversation.sessionId);
  assert.match(result.sessionId, /^session-\d+$/, 'a placed identity is the Session the controller created');
});

test('two runs without an id receive two distinct identities', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });

  const first = await runAgent(depsFor(agents), {
    prompt: 'a',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });
  const second = await runAgent(depsFor(agents), {
    prompt: 'b',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });

  assert.equal(agents.created.length, 2);
  assert.notEqual(agents.created[0].sessionId, agents.created[1].sessionId, 'a shared id would collide in the registry');
  assert.notEqual(first.sessionId, second.sessionId);
  assert.match(first.sessionId, SESSION_ID_SHAPE);
  assert.match(second.sessionId, SESSION_ID_SHAPE);
});

test('two placed runs in one directory get two Sessions in one Workspace', async () => {
  // `new` mode is the default: same directory, same Workspace group, two separate
  // conversations. That is the behaviour the mode exists to guarantee.
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const deps = depsFor(agents);

  const first = await runAgent(deps, { prompt: 'a', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });
  const second = await runAgent(deps, { prompt: 'b', cwd: CWD, selection: SELECTION, timeoutMs: 5000 });

  assert.notEqual(first.sessionId, second.sessionId, 'new mode must not continue the previous conversation');
  assert.equal(first.conversation.workspaceId, second.conversation.workspaceId, 'both runs belong to one Workspace group');
  assert.equal(first.conversation.reused, false);
  assert.equal(second.conversation.reused, false);
  assert.equal(deps.testControllers.workspaces.creates.length, 2, 'the Workspace is resolved once per run');
});

test('a null session id counts as absent and is generated', async () => {
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const result = await runAgent(depsFor(agents), {
    sessionId: null,
    prompt: 'go',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
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
