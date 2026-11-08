// Model-selection compatibility: a run must really select the route it reports.
//
// The defect this file pins down is a CONVERSATION's model being assumed rather
// than verified. On a harness whose Agent exposes the modern model API
// (`agent.model.select` / `agent.model.current`, recorded in the Session's
// durable `modelSelection` projection), the legacy installer
// `installModelSelection(agentCtx, { current, assembled })` only installs the
// pre-step model-switch NOTICE listener: it carries no selection at all. A runner
// that kept calling it reported `applied: true` while the turn actually ran on the
// route the conversation already had — most visibly on a continued conversation.
//
// The contract asserted here, on BOTH the fresh setup and the resolved/continued
// path:
//  * the desired provider/model/effort is what the conversation reports after the
//    run's setup, before the prompt;
//  * a changed route on a follow-up REPLACES the previous selection;
//  * a throwing, empty or disagreeing readback delivers NO prompt and never reports
//    `applied: true` — and never falls back to the legacy path;
//  * a harness with no modern API keeps the legacy coupling it needs;
//  * a run that names a route and has no way to apply it is refused.
//
// The Agent here is a fake modelled on the native shape (see
// `tests/helpers/fakes.js` `fakeAgent`) so both capabilities can be exercised in
// one process. It is a compatibility unit: it states the runner's behaviour
// against each capability shape, NOT that the installed dependency set is 0.2.2 —
// that is a separate native check.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_CODES,
  RUN_OUTCOMES,
  RunError,
  SELECTION_MODES,
  SELECTION_REASONS,
  runAgent,
  selectionModeOf,
} from '../src/runtime/agent-runner.js';
import { fakeAgentPresets } from './helpers/fakes.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const ROUTE_A = Object.freeze({ providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' });
const ROUTE_B = Object.freeze({ providerRoute: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'high' });

/**
 * A Session stand-in carrying the durable facts the model path reads.
 *
 * `requestHeader()` is the native fold the notice listener compares against, and
 * `append()` is where a recorded `model/selection` lands. Modelling both means a
 * fake Agent behaves like the native one on the read a selection has to survive.
 * @param {string} id - session identity.
 * @param {string} [cwd] - session header cwd.
 * @returns {object} session.
 */
function fakeSession(id, cwd = CWD) {
  const log = [];
  return {
    id,
    header: { id, cwd },
    log,
    seq: 0,
    requestHeader: () => undefined,
    append(type, data) {
      const event = { type, seq: log.length, data: { ...data } };
      log.push(event);
      this.seq = log.length;
      return event;
    },
    selections() {
      return log.filter((event) => event.type === 'model/selection').map((event) => event.data);
    },
  };
}

/**
 * A native-shaped Agent with either capability, and a model surface built to fail.
 *
 * The modern surface mirrors `AgentModel`: `select()` records a `model/selection`
 * event and `current()` answers exactly that durable record (never the requested
 * argument), so a readback disagreement is a REAL state rather than a scripted
 * lie, and a `current()` that answers before any selection is a conversation that
 * started on another route (`routed`), exactly as the native options fallback does.
 * `broken` injects the per-call failures: `select` throws, `current` throws,
 * `current` answers nothing, or `current` answers another route.
 * `modelSurface` replaces the whole `agent.model` value with a scripted shape
 * (a half-installed or malformed API), which is how the fail-closed cases below
 * are built; `model: false` removes the surface entirely.
 * @param {object} [options] - `model: false` removes the modern API entirely;
 *   `routed`: route already configured on the conversation; `broken`:
 *   `'select'|'throw'|'empty'|'other'`; `modelSurface`: exact `agent.model` value.
 * @returns {Promise<object>} agent.
 */
async function fakeAgent(options = {}) {
  const agent = {
    id: 'session-1',
    session: fakeSession('session-1'),
    listeners: [],
    followups: [],
    cancels: [],
    ctx: null,
  };
  agent.ctx = {
    on(event, listener) {
      agent.listeners.push({ event, listener });
      return () => {};
    },
  };
  // Where the durable selection lives; `undefined` until one is recorded, exactly
  // as the native projection starts empty and `current()` falls back to options.
  let recorded;

  if (options.modelSurface !== undefined) {
    agent.model = options.modelSurface;
  } else if (options.model !== false) {
    agent.model = {
      select(selection) {
        if (options.broken === 'select') throw Object.assign(new Error('model not registered'), { code: 'model/unavailable' });
        recorded = { ...selection };
        agent.session.append('model/selection', recorded);
      },
      current() {
        if (options.broken === 'throw') throw Object.assign(new Error('projection unreadable'), { code: 'projection/unreadable' });
        if (options.broken === 'empty') return undefined;
        if (options.broken === 'other') return { provider: 'relay', model: 'someone-else', reasoningEffort: 'low' };
        if (recorded !== undefined) return { ...recorded };
        return options.routed === undefined ? undefined : { ...options.routed };
      },
    };
  }

  agent.followup = (message) => {
    agent.followups.push(message);
    for (const entry of agent.listeners) {
      if (entry.event !== 'session/event') continue;
      entry.listener({ id: agent.session.id }, { type: 'text-delta', index: 0, text: 'done' });
      entry.listener({ id: agent.session.id }, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'done' }] } },
      });
      entry.listener({ id: agent.session.id }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
    }
  };
  agent.whenIdle = async () => {};
  agent.cancel = (cause, cancelOptions) => { agent.cancels.push({ cause, options: cancelOptions }); };
  return agent;
}

/**
 * A call that must never happen on the path under test.
 * @param {string} name - the call's name, for the failure message.
 * @returns {Function} a function that always refuses.
 */
function notUsed(name) {
  return async () => { throw new Error(`${name} must not be called on this path`); };
}

/**
 * Dependency set with no controllers: every run below travels on an explicit
 * `placement` (the resolved/continued path) or on `allowUnplaced` (the created
 * path), so a placement resolution would be a wiring mistake.
 * @param {object} [agents] - the registry, when the path creates its agent.
 * @returns {object} deps.
 */
function baseDeps(agents = { create: notUsed('agents.create') }) {
  return { agents, agentPresets: fakeAgentPresets() };
}

/**
 * Run a CREATED agent (the path the review composition uses).
 * @param {object} [agentOptions] - forwarded to the fake Agent, so a create can be
 *   scripted with a half-installed or absent model surface.
 * @returns {object} deps whose registry records every create.
 */
function createdDeps(agentOptions = {}) {
  const created = [];
  return {
    created,
    deps: baseDeps({
      async create(request) {
        const agent = await fakeAgent(agentOptions);
        agent.id = request.sessionId;
        agent.session.id = request.sessionId;
        created.push({ request, agent, options: request.agentOptions });
        await request.setup(agent.ctx, agent);
        return { agent, dispose: async () => {} };
      },
    }),
  };
}

/**
 * Run through an explicit placement, which is how a worker run drives an Agent it
 * did not create — a new Session resolved to its Agent, or a continued thread.
 * @param {object} agent - agent to drive.
 * @param {object} [extra] - extra request fields.
 * @param {string} [kind] - placement kind (`new` or `continuation`).
 * @returns {Promise<object>} run result.
 */
async function runPlaced(agent, extra = {}, kind = 'new') {
  const continuation = kind === 'continuation';
  return await runAgent(baseDeps(), {
    prompt: 'do the thing',
    cwd: CWD,
    selection: ROUTE_A,
    timeoutMs: 5000,
    placement: {
      kind,
      continuedFromTaskId: continuation ? 'task-parent' : null,
      reused: continuation,
      workspaceId: 'ws-1',
      workspacePath: CWD,
      sessionId: agent.session.id,
      sessionCreated: !continuation,
      agent,
    },
    ...extra,
  });
}

// --- Capability detection ----------------------------------------------------

test('the selection capability is decided per agent, by API presence', async () => {
  const modern = await fakeAgent();
  const legacy = await fakeAgent({ model: false });
  assert.equal(selectionModeOf(modern), SELECTION_MODES.modern);
  // ONLY an absent model surface is the old release.
  assert.equal(selectionModeOf(legacy), SELECTION_MODES.legacy);
  assert.equal(selectionModeOf({ model: null }), SELECTION_MODES.legacy);
  assert.equal(selectionModeOf({ model: undefined }), SELECTION_MODES.legacy);
  // A half-present or malformed surface is neither shape: it cannot be read back,
  // so treating it as legacy would let the legacy installer claim a selection the
  // modern helper never applies.
  assert.equal(selectionModeOf({ model: { select() {} } }), SELECTION_MODES.unavailable);
  assert.equal(selectionModeOf({ model: { current() {} } }), SELECTION_MODES.unavailable);
  assert.equal(selectionModeOf({ model: {} }), SELECTION_MODES.unavailable);
  assert.equal(selectionModeOf({ model: 'relay' }), SELECTION_MODES.unavailable);
  assert.equal(selectionModeOf({ model: { select: 'nope', current() {} } }), SELECTION_MODES.unavailable);
  // No agent at all means no model surface was ever offered.
  assert.equal(selectionModeOf(undefined), SELECTION_MODES.legacy);
});

// --- Modern path: the route is really selected -------------------------------

test('a resolved run selects the desired provider/model/effort through the agent model API', async () => {
  const agent = await fakeAgent({ routed: { provider: 'relay', model: 'previous-model' } });

  const result = await runPlaced(agent);

  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  // The route the conversation now reports is the one the operator selected.
  assert.deepEqual(agent.model.current(), {
    provider: 'relay',
    model: 'deepseek-chat',
    reasoningEffort: 'medium',
  });
  assert.deepEqual(agent.session.selections(), [{
    provider: 'relay',
    model: 'deepseek-chat',
    reasoningEffort: 'medium',
  }], 'the selection is durable on the conversation, not just reported');
  assert.deepEqual(result.selection, {
    provider: 'relay',
    model: 'deepseek-chat',
    reasoningEffort: 'medium',
    applied: true,
  });
  assert.equal(agent.followups.length, 1, 'the prompt is delivered after the selection');
});

test('a created run selects the same way, through its own setup', async () => {
  const harness = createdDeps();

  const result = await runAgent(harness.deps, {
    prompt: 'review it',
    cwd: CWD,
    selection: ROUTE_A,
    timeoutMs: 5000,
    allowUnplaced: true,
  });

  assert.equal(harness.created.length, 1);
  const { agent } = harness.created[0];
  assert.deepEqual(agent.model.current(), {
    provider: 'relay',
    model: 'deepseek-chat',
    reasoningEffort: 'medium',
  });
  assert.equal(result.selection.applied, true);
  assert.equal(result.selection.model, 'deepseek-chat');
  // `maxTokens` still travels on the create options unchanged: the selection
  // adapter must not disturb the explicit request budget.
  assert.equal(harness.created[0].options.maxTokens, result.maxTokens);
});

test('an omitted effort is selected as absent and never defaulted by the runner', async () => {
  const agent = await fakeAgent();

  const result = await runPlaced(agent, {
    selection: { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: null },
  });

  assert.equal('reasoningEffort' in agent.model.current(), false, 'no effort is invented');
  assert.equal(result.selection.reasoningEffort, null);
  assert.equal(result.selection.applied, true);
});

test('a changed route on a follow-up replaces the previous selection', async () => {
  const agent = await fakeAgent({ routed: ROUTE_A });

  const first = await runPlaced(agent);
  assert.deepEqual(agent.model.current(), { provider: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' });

  const second = await runPlaced(agent, { selection: ROUTE_B });

  assert.deepEqual(agent.model.current(), {
    provider: 'relay',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  }, 'the second task runs on ITS route, not the first one');
  assert.deepEqual(second.selection, {
    provider: 'relay',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
    applied: true,
  });
  // Both turns were driven, and the durable log shows the replacement in order.
  assert.equal(agent.followups.length, 2);
  assert.deepEqual(agent.session.selections().at(-1), {
    provider: 'relay',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  });
  assert.notDeepEqual(first.selection, second.selection);
});

// --- Modern path: an unverified route is a refusal ---------------------------

/**
 * Every modern-path failure: no prompt, no `applied: true`, and a stated reason.
 * @returns {Promise<void>} resolves when all cases refused correctly.
 */
async function assertRefusedFor(broken, expectedReason) {
  const agent = await fakeAgent({ broken });

  await assert.rejects(
    () => runPlaced(agent),
    (error) => {
      assert.ok(error instanceof RunError, `expected a RunError, got ${error?.name}`);
      assert.equal(error.code, RUN_CODES.selectionUnavailable);
      assert.equal(error.details?.reason, expectedReason);
      return true;
    },
  );
  assert.equal(agent.followups.length, 0, 'no prompt reaches an unverified conversation');
  assert.equal(agent.cancels.length, 0, 'nothing was driven, so nothing was cancelled');
}

test('a rejected selection delivers no prompt', async () => {
  await assertRefusedFor('select', SELECTION_REASONS.writeFailed);
});

test('a throwing readback delivers no prompt', async () => {
  await assertRefusedFor('throw', SELECTION_REASONS.readbackFailed);
});

test('an empty readback delivers no prompt', async () => {
  await assertRefusedFor('empty', SELECTION_REASONS.readbackUnusable);
});

test('a disagreeing readback delivers no prompt and never reports applied', async () => {
  await assertRefusedFor('other', SELECTION_REASONS.routeMismatch);
});

test('a readback that drops the selected effort is refused as an effort mismatch', async () => {
  const agent = await fakeAgent();
  // A conversation that records the route but silently loses the effort.
  agent.model.select = () => {};
  agent.model.current = () => ({ provider: 'relay', model: 'deepseek-chat' });

  await assert.rejects(
    () => runPlaced(agent),
    (error) => {
      assert.equal(error.code, RUN_CODES.selectionUnavailable);
      assert.equal(error.details.reason, SELECTION_REASONS.effortMismatch);
      return true;
    },
  );
  assert.equal(agent.followups.length, 0);
});

test('a readback that carries an unrequested effort is refused, not reported as applied', async () => {
  const agent = await fakeAgent();
  agent.model.select = () => {};
  agent.model.current = () => ({ provider: 'relay', model: 'deepseek-chat', reasoningEffort: 'high' });

  await assert.rejects(
    () => runPlaced(agent, {
      selection: { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: null },
    }),
    (error) => {
      assert.equal(error.details.reason, SELECTION_REASONS.unrequestedEffort);
      return true;
    },
  );
  assert.equal(agent.followups.length, 0);
});

test('a modern API that fails is never silently replaced by the legacy path', async () => {
  // The legacy coupling would "succeed" here (it installs the model-switch notice
  // listener and reports success) while selecting nothing — which is the defect.
  // The run must refuse instead.
  const agent = await fakeAgent({ routed: { provider: 'relay', model: 'previous-model' }, broken: 'throw' });

  await assert.rejects(
    () => runPlaced(agent),
    (error) => {
      assert.equal(error.code, RUN_CODES.selectionUnavailable);
      assert.equal(error.details.reason, SELECTION_REASONS.readbackFailed);
      return true;
    },
  );

  // Nothing was driven, and no legacy coupling was installed in place of the
  // failed modern API: the run's own event collector is the only listener, and no
  // `agent/pre-step` / `system-prompt/assemble` / `agent/request` coupling — the
  // three listeners the legacy installer registers — exists. That absence is what
  // makes this a refusal rather than a silent fallback.
  assert.equal(agent.followups.length, 0);
  const installed = agent.listeners.map((entry) => entry.event);
  for (const legacyEvent of ['agent/pre-step', 'system-prompt/assemble', 'agent/request']) {
    assert.equal(installed.includes(legacyEvent), false, `no legacy ${legacyEvent} coupling may be installed`);
  }
});

test('a run that names no route on a modern API is refused, never defaulted', async () => {
  const agent = await fakeAgent();

  await assert.rejects(
    () => runPlaced(agent, { selection: { providerRoute: null, model: null, reasoningEffort: null } }),
    (error) => {
      assert.equal(error.code, RUN_CODES.selectionUnavailable);
      assert.equal(error.details.reason, SELECTION_REASONS.noCapability);
      return true;
    },
  );
  assert.equal(agent.followups.length, 0);
  assert.equal(agent.session.selections().length, 0);
});

// --- Legacy path: unchanged behaviour where no modern API exists -------------

test('a legacy harness with no agent model API is still driven on the selected route', async () => {
  const agent = await fakeAgent({ model: false });

  const result = await runPlaced(agent);

  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.deepEqual(result.selection, {
    provider: 'relay',
    model: 'deepseek-chat',
    reasoningEffort: 'medium',
    applied: true,
  });
  assert.equal(agent.followups.length, 1);
  // The legacy coupling is listener-based; the conversation records no durable
  // selection, which is exactly why the modern path cannot be faked on top of it.
  assert.equal(agent.session.selections().length, 0);
});

test('a legacy harness with no API and no requested route stays drivable (the review composition)', async () => {
  const agent = await fakeAgent({ model: false });

  const result = await runPlaced(agent, { selection: {} });

  assert.equal(result.outcome, RUN_OUTCOMES.completed);
  assert.equal(result.selection.applied, false, 'nothing was selected, so nothing is claimed');
  assert.equal(result.selection.provider, null);
  assert.equal(agent.followups.length, 1);
});

test('a route with no way to apply it is refused, and an unobservable agent is refused first', async () => {
  // An agent this run cannot observe at all (`ctx` missing): the runner's existing
  // refusal, which must still come before anything else.
  const agent = await fakeAgent({ model: false });
  agent.ctx = null;

  await assert.rejects(
    () => runPlaced(agent),
    (error) => {
      assert.equal(error.code, RUN_CODES.createFailed, 'an unobservable agent is refused first');
      return true;
    },
  );
  assert.equal(agent.followups.length, 0);
});

// --- Present but incomplete model surface: fail closed -----------------------

/**
 * Half-installed and malformed `agent.model` values, in the shapes a release
 * transition or a partial plugin really produces: the write half without the read
 * half, a namespace that exposes neither call, a non-function member, and a
 * surface that is not an object at all.
 * @returns {Array<{ name: string, surface: unknown }>} cases.
 */
function halfSurfaces() {
  return [
    { name: 'select only', surface: { select() { return undefined; } } },
    { name: 'current only', surface: { current() { return undefined; } } },
    { name: 'empty namespace', surface: {} },
    { name: 'non-function members', surface: { select: 'relay', current: 'relay' } },
    { name: 'non-object surface', surface: 'relay/deepseek-chat' },
  ];
}

/**
 * Assert one run refused an incomplete surface, and that the legacy coupling —
 * which would have installed the three waterfall listeners and reported
 * `applied: true` — was never reached.
 * @param {object} deps - dependency set.
 * @param {object} request - run request.
 * @param {object} agent - the agent the run would have driven.
 * @returns {Promise<void>} resolves when the refusal is confirmed.
 */
async function assertIncompleteRefused(deps, request, agent) {
  await assert.rejects(
    () => runAgent(deps, request),
    (error) => {
      assert.ok(error instanceof RunError, `expected a RunError, got ${error?.name}`);
      // The explicit code an operator sees in job history.
      assert.equal(error.code, 'RUN_MODEL_SELECTION_UNAVAILABLE');
      assert.equal(error.code, RUN_CODES.selectionUnavailable);
      assert.equal(error.details?.reason, SELECTION_REASONS.modelSurfaceIncomplete);
      // Only capability facts travel, never the surface itself.
      assert.equal(error.details?.surface?.kind, typeof agent.model);
      return true;
    },
  );
  assert.equal(agent.followups.length, 0, 'no prompt reaches an unselectable surface');
  assert.equal(agent.cancels.length, 0, 'nothing was driven, so nothing was cancelled');
  const installed = agent.listeners.map((entry) => entry.event);
  for (const legacyEvent of ['agent/pre-step', 'system-prompt/assemble', 'agent/request']) {
    assert.equal(installed.includes(legacyEvent), false, `no legacy ${legacyEvent} coupling may be installed`);
  }
}

test('an incomplete model surface is refused on the resolved path, never treated as legacy', async () => {
  for (const { name, surface } of halfSurfaces()) {
    const agent = await fakeAgent({ modelSurface: surface });
    assert.equal(selectionModeOf(agent), SELECTION_MODES.unavailable, name);
    await assertIncompleteRefused(baseDeps(), {
      prompt: 'do the thing',
      cwd: CWD,
      selection: ROUTE_A,
      timeoutMs: 5000,
      placement: {
        kind: 'continuation',
        continuedFromTaskId: 'task-parent',
        reused: true,
        workspaceId: 'ws-1',
        workspacePath: CWD,
        sessionId: agent.session.id,
        sessionCreated: false,
        agent,
      },
    }, agent);
  }
});

test('an incomplete model surface is refused on the created path, before the prompt', async () => {
  for (const { name, surface } of halfSurfaces()) {
    const harness = createdDeps({ modelSurface: surface });
    const run = runAgent(harness.deps, {
      prompt: 'review it',
      cwd: CWD,
      selection: ROUTE_A,
      timeoutMs: 5000,
      allowUnplaced: true,
    });
    // The refusal is what `agents.create`'s setup throws, so no handle is ever
    // published and the run reports a refusal rather than `applied: true`.
    await assert.rejects(
      () => run,
      (error) => {
        assert.equal(error.code, 'RUN_MODEL_SELECTION_UNAVAILABLE', name);
        assert.equal(error.details?.reason, SELECTION_REASONS.modelSurfaceIncomplete);
        return true;
      },
    );
    assert.equal(harness.created.length, 1);
    const { agent } = harness.created[0];
    assert.equal(agent.followups.length, 0, `${name}: no prompt is delivered`);
    const installed = agent.listeners.map((entry) => entry.event);
    for (const legacyEvent of ['agent/pre-step', 'system-prompt/assemble', 'agent/request']) {
      assert.equal(installed.includes(legacyEvent), false, `${name}: no legacy ${legacyEvent} coupling`);
    }
  }
});

test('an incomplete model surface refuses a run that named no route too, without claiming anything', async () => {
  // Even with no route requested, a present surface that cannot be read back is
  // not the old shape: the run cannot verify what the conversation would use.
  const agent = await fakeAgent({ modelSurface: { select() {} } });

  await assert.rejects(
    () => runPlaced(agent, { selection: {} }),
    (error) => {
      assert.equal(error.code, RUN_CODES.selectionUnavailable);
      assert.equal(error.details.reason, SELECTION_REASONS.modelSurfaceIncomplete);
      return true;
    },
  );
  assert.equal(agent.followups.length, 0);
});

test('an absent model surface keeps the legacy path; a present empty one does not', async () => {
  // `model: false` is an old release: the legacy coupling still applies and is
  // reported, as before.
  const legacy = await fakeAgent({ model: false });
  const legacyResult = await runPlaced(legacy);
  assert.equal(legacyResult.selection.applied, true);
  assert.equal(legacy.followups.length, 1);
  assert.equal(legacy.listeners.some((entry) => entry.event === 'agent/request'), true,
    'the real legacy coupling is what applies the route there');

  // `model: {}` is NOT: present but unable to select or report anything.
  const empty = await fakeAgent({ modelSurface: {} });
  await assertIncompleteRefused(baseDeps(), {
    prompt: 'do the thing',
    cwd: CWD,
    selection: ROUTE_A,
    timeoutMs: 5000,
    placement: { kind: 'new', sessionId: empty.session.id, sessionCreated: true, agent: empty },
  }, empty);
});

// --- Cancellation and budget are untouched ----------------------------------

test('a cancelled run never selects, never prompts and never reports applied', async () => {
  const agent = await fakeAgent();
  const controller = new AbortController();
  controller.abort();

  const result = await runPlaced(agent, { signal: controller.signal });

  assert.equal(result.outcome, RUN_OUTCOMES.cancelled);
  assert.equal(agent.followups.length, 0);
  assert.equal(agent.session.selections().length, 0, 'a cancelled run selects nothing');
  assert.equal(result.selection, null);
});

test('an explicit request budget still travels unchanged beside a verified selection', async () => {
  const agent = await fakeAgent();

  const result = await runPlaced(agent, { maxTokens: 8192 });

  assert.equal(result.maxTokens, 8192);
  assert.equal(result.selection.applied, true);
  assert.deepEqual(agent.model.current(), { provider: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' });
});
