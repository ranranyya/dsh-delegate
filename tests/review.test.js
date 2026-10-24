// Independent review tests.
//
// Review is only worth having if it is genuinely separate from the worker:
// different model selection, a real (not decorative) read-only tool policy, and
// no authority to approve. Each of those is asserted here rather than described
// in a comment.
//
// The agent fake is local to this file because the shared helper predates the
// native tool inventory: review must ask the registry what tools exist
// (`tools.schemas(scope)`) and must fail closed when that answer is unavailable.
// The tool surface it exposes is `fakeToolRegistry` from the shared helpers,
// which mirrors the REAL native semantics rather than an idealized filter:
// `tools.restrict()` filters only the INHERITED surface and never a scope's own
// registrations. That is why review also registers a `system-prompt/assemble`
// transform, and why this fake implements the native waterfall contract
// (`(assembly, context, next)`, `PromptAssembly` = sections/contexts/tools/
// variables) instead of letting a test read the transform's opinion directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksMutating,
  parseVerdict,
  REVIEW_CODES,
  REVIEW_STATES,
  reviewWork,
  reviewerToolAllowList,
} from '../src/review/reviewer.js';
import { buildReviewPrompt, buildWorkerPrompt, renderEvidence } from '../src/review/prompts.js';
import { ReviewPreset, PRESET_CODES, reviewCompositionRows, reviewPresetDefinition } from '../src/review/preset.js';
import { DEFAULT_MAX_TOKENS } from '../src/runtime/agent-runner.js';
import { fakeToolRegistry, nativePresetRegistry } from './helpers/fakes.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const SELECTION = { providerId: 'reviewer', providerRoute: 'reviewer', model: 'audit-model', reasoningEffort: 'high' };

/** The inventory a stock DSH deployment registers: four read tools plus writers. */
const STOCK_INVENTORY = ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'shell'];

/**
 * The read-only set every reference assembly below is filtered down to, in the
 * canonical (lexicographic) order the native assembler sorts tools into.
 *
 * Declared here, in the test, rather than imported from the module under test:
 * a test that asks the implementation what to expect cannot catch the
 * implementation widening its own allow-list.
 */
const READ_ONLY = ['glob', 'grep', 'read', 'read_image'];

/**
 * Build a `PromptAssembly` from tool names, in canonical (lexicographic) order
 * and with the other three fields present, as the native assembler produces it.
 * @param {string[]} names - tool names the assembly would carry.
 * @returns {object} assembly.
 */
function assemblyOf(names) {
  return {
    sections: [{ name: 'deployment:persona-prefix', text: 'persona' }],
    contexts: [{ name: 'sandbox', text: 'policy' }],
    tools: [...names].sort().map((name) => ({ name, description: name, parameters: {} })),
    variables: { workspace: CWD },
  };
}

/**
 * Invoke the registered waterfall listeners the way Cordis does.
 *
 * A waterfall listener wraps the rest of the chain: the last argument is the
 * innermost `next`, listeners run outermost-first, and the outermost return
 * value is the assembly the caller uses. Calling the listener directly with
 * hand-written `next` functions would bypass that nesting, so the fake composes
 * it exactly as `EventService.waterfall` does.
 * @param {object[]} entries - `{ listener }` records in registration order.
 * @param {object} assembly - the pre-waterfall assembly.
 * @param {object} context - the assembly context.
 * @returns {Promise<object>} the post-waterfall assembly.
 */
async function runWaterfall(entries, assembly, context) {
  const listeners = entries.map((entry) => entry.listener);
  const invoke = (index) => {
    if (index >= listeners.length) return Promise.resolve(assembly);
    return listeners[index](assembly, context, () => invoke(index + 1));
  };
  return await invoke(0);
}

/**
 * Build a strict fake agent registry for review.
 *
 * Differences from the shared helper, all of them contract mirrors:
 *  - `setup(agentCtx, agent)` receives the agent, because an agent's tools live
 *    on its own scope plane;
 *  - `tools.schemas(scope)`, `restrict()` and `guard()` come from
 *    {@link fakeToolRegistry}, which applies restrictions to the inherited
 *    surface only and keeps the scope's own registrations — the native
 *    `ToolRuntime.view()` rule;
 *  - `options.local` tools are registered into the agent's OWN layer before
 *    setup runs, which is exactly how `dsh-tool-subagent` appears to a
 *    composing agent;
 *  - `agentCtx.on('system-prompt/assemble', …)` records a listener and
 *    `request(assembly, context)` runs the recorded waterfall over whatever the
 *    native assembler collected, which is the list the model is actually sent.
 * @param {object} [options] - test knobs.
 * @returns {object} fake registry.
 */
function reviewAgents(options = {}) {
  const created = [];
  const disposed = [];
  const listeners = [];
  const order = options.order ?? [];
  const inventory = options.inventory ?? STOCK_INVENTORY;
  // The global layer is the inventory; `composed` is what a preset contributes,
  // so an inventory that no longer includes a name really is absent.
  const tools = fakeToolRegistry({
    global: options.global ?? inventory,
    parent: options.composed ?? inventory,
  });
  const omit = new Set(options.omit ?? []);

  /**
   * Assemble one reviewer's model-facing prompt, exactly as the Agent loop does
   * before it issues a request.
   *
   * The native assembler collects sections/contexts/tools/variables and THEN
   * runs the `system-prompt/assemble` waterfall over the result; the waterfall's
   * return value is the request. A throw therefore happens upstream of the
   * request, which is why both `registry.request()` and `agent.followup()` go
   * through this one function: neither can record a request the assembly
   * refused to produce.
   * @param {object} record - the reviewer record.
   * @returns {Promise<object>} the assembly the request would carry.
   */
  const runAssembly = async (record) => {
    const names = record?.agent === undefined ? [] : tools.advertised(record.agent);
    const preWaterfall = options.assemblyOverride !== undefined
      ? options.assemblyOverride
      : assemblyOf(names);
    return await runWaterfall(
      listeners.filter((entry) => entry.record === record && entry.event === 'system-prompt/assemble'),
      preWaterfall,
      { agent: record?.agent, scope: record?.agent },
    );
  };

  const registry = {
    created,
    disposed,
    order,
    tools,
    /**
     * The review's own assembly transform.
     *
     * The runner's model-selection listener is also registered on this scope
     * (inside `setup`, after the review's), so registration order — not the
     * event name — identifies the review's. It is the FIRST listener, because
     * setup installs it before the selection; the assertion in the transform
     * test pins that it is also the only one that rewrites `tools`.
     * @param {object} record - the reviewer record; the first by default.
     * @returns {object[]} the review transform's registration.
     */
    assemblyListeners(record = created[0]) {
      const entries = listeners.filter(
        (entry) => entry.record === record && entry.event === 'system-prompt/assemble',
      );
      return entries.slice(0, 1);
    },
    /** Every waterfall listener registered on a reviewer's scope. */
    allAssemblyListeners(record = created[0]) {
      return listeners.filter((entry) => entry.record === record && entry.event === 'system-prompt/assemble');
    },
    /**
     * Run the reviewer's model-facing prompt assembly, over the tools the
     * harness would collect for this scope at request time. This is the
     * request's own tools.
     *
     * `preWaterfall` is the assembly the native assembler produced BEFORE the
     * waterfall runs. It is the same seam {@link runAssembly} (and therefore
     * `agent.followup()`) uses to decide the request, so a test that injects a
     * broken one here drives the exact path a broken deployment would.
     * @param {object} [target] - the record to assemble for; the first by default.
     * @param {object} [preWaterfall] - override for the pre-waterfall assembly.
     * @returns {Promise<object>} the assembly the model would receive.
     */
    async request(target = created[0], preWaterfall = undefined) {
      if (preWaterfall === undefined) return await runAssembly(target);
      return await runWaterfall(
        listeners.filter((entry) => entry.record === target && entry.event === 'system-prompt/assemble'),
        preWaterfall,
        { agent: target?.agent, scope: target?.agent },
      );
    },
    async create(request) {
      if (typeof request?.meta?.cwd !== 'string') {
        throw new Error('agents.create: meta.cwd is required');
      }
      if (typeof request?.setup !== 'function') {
        throw new Error('agents.create: review must install its tool policy in setup');
      }
      if (options.defer !== undefined) await options.defer;

      const record = {
        options: request.agentOptions ?? {},
        meta: request.meta,
        followups: [],
        // One entry per simulated model request, appended only AFTER the
        // waterfall has produced the assembly the request would carry.
        requests: [],
        cancels: [],
        idleWaiters: [],
        idle: true,
        disposed: false,
      };
      const settle = () => {
        record.idle = true;
        for (const waiter of record.idleWaiters.splice(0)) waiter();
      };
      // `followup()` mirrors the native Agent loop, and the order inside it is
      // the whole point of these tests: the harness assembles the prompt (which
      // runs the registered `system-prompt/assemble` waterfall) BEFORE the
      // request exists. A fake that recorded the request first would let a
      // broken assembly look like a completed review plus a separate error.
      const agent = {
        id: `agent-${created.length}`,
        session: { id: request.sessionId ?? `session-${created.length}` },
        // Mirrors the native Agent loop's ORDER, which is the property under
        // test: the harness assembles the prompt — running the registered
        // `system-prompt/assemble` waterfall — BEFORE a request exists. A fake
        // that recorded the request first would let a broken assembly look like
        // a completed review plus a separate error.
        followup(message) {
          record.idle = false;
          // The gate is a real promise: it resolves to the filtered assembly, or
          // it REJECTS and the request never happens. The `catch` below is
          // attached immediately so the refusal is observed exactly once — a
          // rejected promise nobody consumed would surface as a process-level
          // unhandled rejection, which is not what this test is about.
          const assembled = runAssembly(record);
          const guarded = assembled.then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
          );
          return guarded.then((outcome) => {
            if (!outcome.ok) {
              // A refused assembly means no request is made: the turn is
              // recorded as failed and nothing below runs, so no followup and no
              // request exist. The failure is reported on the two channels the
              // native loop uses — `agent/error` (so the runner records WHY) and
              // `turn/end` (so the turn is closed) — rather than by rejecting
              // this promise, whose caller is not awaited by every harness and
              // whose rejection would surface as an unhandled rejection.
              record.idle = true;
              record.assemblyFailure = outcome.error;
              order.push('assembly-failed');
              // The native payload shape the runner reads is `{ error }`, where
              // `error` carries `code` and `message` so the WHY is reported.
              for (const entry of listeners) {
                if (entry.record !== record || entry.event !== 'agent/error') continue;
                entry.listener({ id: agent.session.id }, { error: outcome.error });
              }
              for (const entry of listeners) {
                if (entry.record !== record || entry.event !== 'session/event') continue;
                entry.listener({ id: agent.session.id }, {
                  type: 'turn/end',
                  data: { reason: { kind: 'error' } },
                });
              }
              settle();
              return;
            }
            const { value: assembly } = outcome;
            const toolNames = Array.isArray(assembly?.tools)
              ? assembly.tools.map((schema) => schema?.name).sort()
              : [];
            record.followups.push(message);
            // The simulated model request: it exists only because the assembly
            // was produced, and it carries exactly the tools that assembly held.
            record.requests.push({
              message,
              toolNames,
              assembly,
              tools: assembly?.tools ?? [],
            });
            order.push('followup');
            const plan = options.respond ?? {};
            if (plan.text !== undefined) {
              for (const entry of listeners) {
                if (entry.record !== record || entry.event !== 'session/event') continue;
                entry.listener({ id: agent.session.id }, {
                  type: 'assistant/message',
                  data: { message: { content: [{ type: 'text', text: plan.text }] } },
                });
              }
            }
            for (const entry of listeners) {
              if (entry.record !== record || entry.event !== 'session/event') continue;
              entry.listener({ id: agent.session.id }, {
                type: 'turn/end',
                data: { reason: { kind: plan.reason ?? 'completed' } },
              });
            }
            settle();
          });
        },
        cancel(cause, cancelOptions) {
          record.cancels.push({ cause, options: cancelOptions });
          settle();
        },
        async whenIdle() {
          if (record.idle) return;
          await new Promise((resolvePromise) => { record.idleWaiters.push(resolvePromise); });
        },
      };
      record.agent = agent;
      const handle = {
        agent,
        async dispose() {
          record.disposed = true;
          disposed.push(record);
        },
      };
      created.push(record);

      // The composing plugin's tool: registered into the agent's own layer
      // before the agent's setup hook runs, as `dsh-tool-subagent` does.
      // The composing plugin's tool: registered into the agent's own layer
      // before the agent's setup hook runs, as `dsh-tool-subagent` does.
      for (const name of options.local ?? []) tools.registerLocal(agent, name);

      // Distinguishes a refused registration (`false`) from an accepted one. The
      // review's transform is registered FIRST on this scope, before the
      // runner's model-selection listener, which is how the fake tells them
      // apart (see `assemblyListeners`).
      let settingUp = true;
      const agentCtx = {
        on(event, listener) {
          order.push('listen');
          // The native registration answers with a disposer, and `false` for an
          // event it cannot hold; the tests below drive both.
          if (omit.has('on')) return false;
          if (omit.has('assemble') && settingUp) return false;
          listeners.push({ event, listener, record, owner: settingUp ? 'review' : 'harness' });
          return () => true;
        },
        tools: tools.toolsFor(null, agent),
      };
      if (omit.has('schemas')) delete agentCtx.tools.schemas;
      if (omit.has('restrict')) delete agentCtx.tools.restrict;
      if (omit.has('guard')) delete agentCtx.tools.guard;
      if (omit.has('on')) delete agentCtx.on;
      if (options.restrictThrows !== undefined) {
        // A registry that refuses the restriction: the surface is unchanged and
        // the refusal must fail the review closed.
        agentCtx.tools.restrict = () => {
          order.push('restrict');
          throw options.restrictThrows;
        };
      } else if (!omit.has('restrict')) {
        const nativeRestrict = agentCtx.tools.restrict;
        agentCtx.tools.restrict = (filter) => {
          order.push('restrict');
          return nativeRestrict.call(agentCtx.tools, filter);
        };
      }
      if (options.surfaceScript !== undefined) {
        // A scripted answer per read, for the registry that reports one surface
        // and advertises another.
        let read = 0;
        agentCtx.tools.schemas = () => {
          const names = options.surfaceScript[Math.min(read, options.surfaceScript.length - 1)];
          read += 1;
          return names.map((name) => ({ name, description: name, parameters: {} }));
        };
      }
      record.restrictCalls = tools.restrictCalls;
      record.guards = tools.guards;
      record.agentCtx = agentCtx;
      try {
        await request.setup(agentCtx, agent);
      } finally {
        settingUp = false;
      }
      record.handle = handle;
      return handle;
    },
  };
  return registry;
}

/**
 * The tool names a review actually sends to the model.
 *
 * Reading `agents.request()` is deliberate: it runs the registered waterfall,
 * so the answer is the request's tools, not the registry's visible set and not
 * a private field of the implementation.
 * @param {object} agents - fake registry (see {@link reviewAgents}).
 * @returns {Promise<string[]>} sorted model-facing tool names.
 */
async function requestToolNames(agents) {
  const assembly = await agents.request();
  return assembly.tools.map((schema) => schema.name).sort();
}

/**
 * Dependency set every review needs: the agent registry, the preset registry and
 * the plugin-owned composition.
 *
 * `reviewPresets` is not decoration. Without it review refuses, because there is
 * nothing to compose a read-only reviewer FROM: the default composition of a
 * stock deployment mounts `subagent`, which a scope restriction cannot remove.
 * The composer here is the production class over a fake registry, so the tests
 * that matter exercise the real preparation sequence (register -> resolve ->
 * mount with the owned id) rather than a stub that answers "yes".
 * @param {object} agents - fake agent registry (see {@link reviewAgents}).
 * @param {object} [presets] - preset registry; a registering one by default.
 * @param {object} [composerOptions] - overrides for {@link ReviewPreset}.
 * @returns {object} dependency object.
 */
function reviewDeps(agents, presets = undefined, composerOptions = undefined) {
  const registry = presets ?? registeringPresets();
  const reviewPresets = new ReviewPreset({
    registry,
    id: composerOptions?.id ?? 'dsh-delegate-review-test',
    // The composition rows are real packages; nothing is imported in these tests.
    importer: composerOptions?.importer ?? (async () => ({ apply() {} })),
    ...composerOptions,
  });
  return { agents, agentPresets: registry, reviewPresets };
}

/**
 * A preset registry that can register a composition, and that mounts the id it
 * was asked for. Mounting an unknown id fails the way the native registry does.
 * @param {object} [options] - forwarded to {@link nativePresetRegistry}.
 * @returns {object} registry.
 */
function registeringPresets(options = {}) {
  const registry = nativePresetRegistry(options);
  registry.mounts = [];
  registry.mount = async (ctx, id) => {
    registry.mounts.push({ ctx, id });
    const wanted = id ?? registry.defaultId;
    if (!registry.definitions.has(wanted)) throw new Error(`Unknown agent preset: ${wanted}`);
    return { id: wanted };
  };
  return registry;
}

function allowListOf(record, index = 0) {
  return record.restrictCalls[index]?.allow ?? [];
}

/** The guard this review installed, evaluated the way the native runtime does. */
function guardOf(agents, name) {
  const record = agents.created[0];
  return agents.tools.denyReason({ name, agent: record.agent });
}

test('the reviewer runs on its own provider, model and effort', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve\nREASON: looks correct' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  const options = agents.created[0].options;
  assert.equal(options.provider, 'reviewer');
  assert.equal(options.model, 'audit-model');
  assert.equal(options.reasoningEffort, 'high');
  assert.equal(result.state, REVIEW_STATES.completed);
  assert.equal(result.verdict.verdict, 'approve');
  assert.equal(result.verdict.reason, 'looks correct');
});

test('an independent review request also gets at least 32768 output tokens', async () => {
  // A review reads a patch and reasons about it. A budget below the worker's own
  // allowance would starve the reviewer into an apparent timeout instead of a
  // verdict, so the reviewer asks for the same practical allowance.
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.completed);
  const options = agents.created[0].options;
  assert.ok(options.maxTokens >= 32768, `a reviewer budget must be at least 32768, got ${options.maxTokens}`);
  assert.equal(options.maxTokens, DEFAULT_MAX_TOKENS);
});

test('an explicit reviewer budget is preserved, and an invalid one is refused', async () => {
  const explicit = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(explicit), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
    maxTokens: 4096,
  });
  assert.equal(explicit.created[0].options.maxTokens, 4096, 'a caller decision must not be replaced by the default');

  // An unusable budget never reaches a request: the review reports the run refusal
  // as a review failure instead of prompting with an unbounded or clamped value.
  const refused = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(refused), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
    maxTokens: 0,
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.verdict, null, 'a refused budget must never look like an approval');
  assert.equal(refused.created.length, 0, 'no reviewer may be created for an unusable budget');
});

test('an omitted effort reaches the harness as absent, never defaulted', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: { providerId: 'reviewer', providerRoute: 'reviewer', model: 'audit-model', reasoningEffort: null },
    prompt: 'review this',
  });
  assert.equal('reasoningEffort' in agents.created[0].options, false);
});

test('the restriction is intersected with the real tool inventory', async () => {
  // A deployment without the image reader must not be restricted to a name it
  // does not have: `tools.restrict()` throws on an unknown name.
  const agents = reviewAgents({
    inventory: ['read', 'glob', 'grep', 'write', 'edit', 'shell'],
    respond: { text: 'VERDICT: approve' },
  });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.completed);
  assert.deepEqual(allowListOf(agents.created[0]), ['read', 'glob', 'grep']);
  assert.equal(allowListOf(agents.created[0]).includes('read_image'), false);
  assert.equal(allowListOf(agents.created[0]).includes('write'), false);
  // The inventory was read for the agent's own scope: an agent's tools are
  // mounted on a scope plane, and calling with a foreign scope throws in the fake.
  assert.deepEqual(
    agents.tools.advertised(agents.created[0].agent),
    ['glob', 'grep', 'read'],
    'the only advertised tools must be the read-only intersection',
  );
});

test('the preset mount happens before the restriction, and the restriction before the prompt', async () => {
  const order = [];
  const presets = registeringPresets();
  const agents = reviewAgents({ order, respond: { text: 'VERDICT: approve' } });

  await reviewWork(reviewDeps(agents, presets), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(presets.mounts.length, 1, 'exactly one composition must be mounted');
  // The composition the review measured, not the deployment default.
  assert.equal(presets.mounts[0].id, 'dsh-delegate-review-test');
  assert.equal(presets.definitions.has('dsh-delegate-review-test'), true);
  // Only the boundary that matters is asserted: the composition exists before the
  // policy, and no turn starts before the policy is installed and proven.
  assert.ok(order.indexOf('restrict') > -1, 'the restriction must be installed');
  assert.ok(order.indexOf('restrict') < order.indexOf('followup'), 'the policy must precede the turn');
  assert.equal(order.at(-1), 'followup', 'nothing may run after the prompt is delivered');
  assert.equal(agents.tools.restrictCalls.length, 1, 'exactly one restriction is installed');
  assert.equal(presets.mounts[0].ctx, agents.created[0].agentCtx);
});

test('the guard denies every name outside the allow-list, not only mutation-shaped ones', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(agents.created[0].guards.length, 1, 'an execution guard must be installed');
  for (const name of ['read', 'read_image', 'grep', 'glob']) {
    assert.equal(guardOf(agents, name), undefined, `${name} must be allowed`);
  }
  for (const name of ['write', 'edit', 'shell', 'subagent', 'apply_patch', 'some_unknown_tool', 'read_file']) {
    assert.match(String(guardOf(agents, name)), /read-only|not permitted/, name);
  }
  assert.match(String(guardOf(agents, '')), /no identity|identity missing/);
});

test('an agent-local subagent tool survives the same-layer restriction', async () => {
  // The native rule this test exists for: `tools.restrict()` filters what a scope
  // INHERITS, never what its own layer registers. `dsh-tool-subagent` installs
  // the delegation tool into a composing agent's own layer, so a restriction can
  // leave it advertised. If this fake ever "fixed" that, the review regression
  // below would pass for the wrong reason.
  const tools = fakeToolRegistry({ global: STOCK_INVENTORY, parent: STOCK_INVENTORY });
  const scope = { id: 'agent-local' };
  tools.registerLocal(scope, 'subagent');

  assert.deepEqual(tools.advertised(scope), ['edit', 'glob', 'grep', 'read', 'read_image', 'shell', 'subagent', 'write']);
  tools.toolsFor(null, scope).restrict({ allow: ['read', 'read_image', 'glob', 'grep'] });

  const advertised = tools.advertised(scope);
  assert.deepEqual(advertised, ['glob', 'grep', 'read', 'read_image', 'subagent']);
  assert.equal(advertised.includes('write'), false, 'inherited writers must be removed');
  assert.equal(advertised.includes('subagent'), true, 'a scope-local tool is not removable by restrict()');
});

test('the dedicated composition never asks for a scope-local tool, and the request proves it', async () => {
  // On the shipped deployment the reviewer used to join the DEFAULT composition,
  // which mounts `dsh-tool-subagent`, so a `subagent` tool was registered into the
  // reviewer's own layer and survived the scope restriction. Review now composes
  // its own preset with no delegation row, AND filters the model-facing assembly,
  // so the request is read-only even on an agent that ends up with a local tool.
  //
  // The audit trail is checked here too: the tool must be gone from the request
  // without the runtime registry being patched (the review does not and cannot
  // deregister another plugin's tool), which is the difference between filtering
  // the model's view and claiming a global removal.
  const agents = reviewAgents({
    local: ['subagent'],
    respond: { text: 'VERDICT: approve' },
  });
  const deps = reviewDeps(agents);
  const result = await reviewWork(deps, {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.completed);
  assert.equal(result.verdict.verdict, 'approve');
  assert.deepEqual(await requestToolNames(agents), READ_ONLY, 'the request carries only the read-only set');
  assert.deepEqual(result.denials, [], 'no denied execution was attempted');

  // The scope-local registration is still there: the review filters the model
  // view, it does not (and no supported API could) delete another plugin's tool.
  assert.equal(agents.tools.advertised(agents.created[0].agent).includes('subagent'), true);
  assert.deepEqual(agents.tools.removeCalls, [], 'no tool was deregistered out of the runtime registry');

  // And it is not executable for this reviewer either.
  assert.equal(agents.tools.canExecute(agents.created[0].agent, 'subagent'), false);

  // The composition that was mounted is the dedicated one, not the default.
  assert.equal(deps.agentPresets.mounts.length, 1);
  assert.equal(deps.agentPresets.mounts[0].id, 'dsh-delegate-review-test');
});

test('a scope-local subagent survives the native restriction but never reaches the model request', async () => {
  // The exact regression this change exists for. The restriction is native and
  // honest: it removes inherited names and keeps the scope's own, so `subagent`
  // stays visible to the registry. The model-facing assembly is the surface that
  // decides what the request carries, and it is filtered and proven.
  const agents = reviewAgents({ local: ['subagent'], respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.completed);
  assert.equal(result.verdict.verdict, 'approve', 'the normal review still completes');
  const scope = agents.created[0].agent;
  // Native semantics: still advertised for the scope, inherited writers removed.
  assert.deepEqual(agents.tools.advertised(scope), ['glob', 'grep', 'read', 'read_image', 'subagent']);
  // Model-facing semantics, read from the REQUEST the fake actually issued while
  // the review ran: the delegation tool is absent, writers are absent, and the
  // four read tools are exactly what the model was sent.
  const record = agents.created[0];
  assert.equal(record.requests.length, 1, 'the completed review issued exactly one request');
  assert.deepEqual(record.requests[0].toolNames, ['glob', 'grep', 'read', 'read_image']);
  assert.deepEqual(record.requests[0].toolNames, READ_ONLY);
  assert.equal(record.requests[0].toolNames.includes('subagent'), false);
  assert.equal(record.requests[0].toolNames.includes('write'), false);
  assert.equal(record.requests[0].toolNames.includes('shell'), false);
  // The replay through the registry agrees with the recorded request, so the two
  // seams cannot drift apart.
  assert.deepEqual(await requestToolNames(agents), record.requests[0].toolNames);

  // The other fields of the assembly are passed through untouched: the filter
  // replaces `tools` and nothing else. (The reviewed model's own selection
  // listener contributes variables, so those are asserted as a superset.)
  const assembly = await agents.request();
  assert.deepEqual(assembly.sections, [{ name: 'deployment:persona-prefix', text: 'persona' }]);
  assert.deepEqual(assembly.contexts, [{ name: 'sandbox', text: 'policy' }]);
  assert.equal(assembly.variables.workspace, CWD, 'variables from the assembler survive the filter');

  // A denied attempt is still denied at execution time, and recorded as evidence.
  assert.match(String(guardOf(agents, 'subagent')), /read-only|not permitted/);
  assert.equal(agents.tools.canExecute(scope, 'subagent'), false);
});

test('a harmless composition completes on exactly the read-only set', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.completed);
  assert.deepEqual(await requestToolNames(agents), READ_ONLY);
  // Every read-only tool is still executable: the filter may not over-restrict.
  const scope = agents.created[0].agent;
  for (const name of READ_ONLY) {
    assert.equal(agents.tools.canExecute(scope, name), true, `${name} must remain executable`);
  }
  for (const name of ['write', 'edit', 'shell', 'subagent', 'workflow', 'run_code']) {
    assert.equal(agents.tools.canExecute(scope, name), false, `${name} must not be executable`);
  }
});

test('the assembly transform is registered on the reviewer, not on the deployment', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  const reviewers = agents.assemblyListeners();
  assert.equal(reviewers.length, 1, 'exactly one review transform must be installed');
  // The model-selection listener the runner installs has no tool authority: only
  // the review transform may rewrite `tools`.
  assert.equal(agents.allAssemblyListeners().length > reviewers.length, true);
  // The transform is per-assembly fail-closed: a missing continuation does not
  // silently pass the assembly through.
  await assert.rejects(
    () => reviewers[0].listener(assemblyOf(READ_ONLY), {}, undefined),
    (error) => error.code === REVIEW_CODES.assemblyMismatch,
  );
});

test('a registry that can only mount uses the default composition and still refuses a delegation tool', async () => {
  // The fail-closed reason must stay distinct: a registry that cannot register
  // the dedicated composition reports that it could not COMPOSE the review, not
  // that a composition it composed turned out to be unsafe. The refusal happens
  // before any agent exists, so no delegation tool is ever reachable.
  const agents = reviewAgents({ local: ['subagent'], respond: { text: 'VERDICT: approve' } });
  const mountOnly = { async mount() { return { id: 'standard' }; } };
  const result = await reviewWork({
    agents,
    agentPresets: mountOnly,
    reviewPresets: new ReviewPreset({ registry: mountOnly, importer: async () => ({ apply() {} }) }),
  }, {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.presetPrepareFailed);
  assert.equal(result.error.reason, PRESET_CODES.unsupported);
  assert.equal(result.verdict, null);
  assert.equal(agents.created.length, 0, 'a review that cannot be composed must not create an agent');

  // Without any composer in the dependency set the same refusal is reported, so
  // an activation that forgot the preset lifecycle cannot silently review on the
  // deployment default.
  const withoutComposer = await reviewWork({ agents, agentPresets: mountOnly }, {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(withoutComposer.state, REVIEW_STATES.failed);
  assert.equal(withoutComposer.error.code, REVIEW_CODES.presetPrepareFailed);
  assert.equal(withoutComposer.error.reason, PRESET_CODES.unsupported);
  assert.equal(agents.created.length, 0);
});

test('a refused reviewer records no denials and leaves its own turn unended', async () => {
  // A refused setup must not be mistaken for a completed review: the agent is
  // disposed inside creation, so no verdict and no prompt can escape. The
  // refusal modelled here is a missing assembly transform — the case where the
  // reviewer could not filter its own request.
  const agents = reviewAgents({ omit: ['assemble'], respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.deepEqual(result.denials, []);
  assert.equal(result.text, '');
  assert.equal(result.selection.model, 'audit-model', 'the failure must still name the selection that failed');
  assert.equal(agents.created.length, 1);
  assert.equal(agents.created[0].followups.length, 0);
});

test('a read-only reviewer advertises exactly read, read_image, glob and grep', async () => {
  // Same acceptance shape, without the local delegation tool: the only tools the
  // model may see, and the only tools it may execute, are the read-only set.
  const agents = reviewAgents({
    global: ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'shell', 'workflow'],
    composed: ['read', 'read_image', 'glob', 'grep', 'write', 'edit', 'shell', 'workflow'],
    respond: { text: 'VERDICT: approve\nREASON: fine' },
  });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.completed);
  const scope = agents.created[0].agent;
  assert.deepEqual(agents.tools.advertised(scope), ['glob', 'grep', 'read', 'read_image']);
  for (const name of ['read', 'read_image', 'glob', 'grep']) {
    assert.equal(agents.tools.canExecute(scope, name), true, `${name} must execute`);
  }
  for (const name of ['write', 'edit', 'shell', 'workflow', 'subagent', 'run_code']) {
    assert.equal(agents.tools.canExecute(scope, name), false, `${name} must not execute`);
  }
});

test('a surface that lost a read-only tool after the restriction fails closed', async () => {
  // A registry whose post-policy surface is not the computed read-only set cannot
  // prove the review is read-only, so the review refuses before the prompt,
  // rather than prompting on a surface it just measured as different.
  const agents = reviewAgents({
    respond: { text: 'VERDICT: approve' },
    surfaceScript: [
      // First read: the pre-policy inventory.
      STOCK_INVENTORY,
      // Second read: the post-policy surface, missing a name the policy installed.
      ['read', 'glob', 'grep'],
    ],
  });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.surfaceMismatch);
  assert.match(result.error.detail ?? '', /read_image/);
  assert.equal(agents.created[0].followups.length, 0, 'a mismatched surface must not be prompted');
});

test('an operator tool request cannot widen the read-only allow-list', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
    extraAllowedTools: ['write', 'shell', 'edit'],
  });

  const allow = allowListOf(agents.created[0]);
  for (const name of ['write', 'shell', 'edit']) {
    assert.equal(allow.includes(name), false, `${name} must not be restricted into visibility`);
    assert.notEqual(guardOf(agents, name), undefined, `${name} must be denied`);
    assert.equal(agents.tools.canExecute(agents.created[0].agent, name), false, `${name} must be unexecutable`);
  }
  // The exported allow-list keeps the same fixed shape regardless of the request.
  for (const name of ['write', 'shell', 'edit']) {
    assert.equal(reviewerToolAllowList(['write', 'shell', 'edit']).has(name), false);
  }
});

test('a registry that does not know a restricted name fails the review closed', async () => {
  // The inventory advertises the tools but the registry refuses the restriction.
  // Review must not fall back to an unrestricted agent.
  const agents = reviewAgents({
    restrictThrows: new Error('tools.restrict() names unknown global tool "read"'),
    respond: { text: 'VERDICT: approve' },
  });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.restrictRefused);
  assert.equal(result.verdict, null);
  assert.equal(agents.created[0].followups.length, 0, 'an unrestricted reviewer must not be prompted');
  assert.equal(agents.created[0].guards.length, 0, 'a refused restriction installs no guard');
  assert.equal(agents.assemblyListeners().length, 0, 'and no assembly transform is left behind either');
});

// ---------------------------------------------------------------------------
// The model-facing assembly
//
// `tools.restrict()` keeps a scope's own registrations, and no supported API
// removes another plugin's scope-local tool. What decides the request is the
// `system-prompt/assemble` waterfall, so every path that could send a request
// with an unaccounted tool has to fail BEFORE the request. These tests drive the
// registered transform the way Cordis and the Agent loop do.
// ---------------------------------------------------------------------------

test('an assembly with no tools fails closed before any model request', async () => {
  // The whole path, not a hand-wired listener call: the fake's `followup()` runs
  // the registered waterfall BEFORE it records a request (exactly as the Agent
  // loop assembles before it prompts), so a pre-waterfall assembly the review
  // cannot account for must abort the review with no request behind it.
  //
  // `PromptAssembly` without a `tools` array is what an assembler that collected
  // nothing usable produces. The review transform is the only thing standing
  // between it and the provider, so it throws out of the waterfall.
  const agents = reviewAgents({
    respond: { text: 'VERDICT: approve' },
    assemblyOverride: { sections: [], contexts: [], variables: {} },
  });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.failed, 'a review whose request cannot be proven must fail');
  assert.equal(result.verdict, null, 'no verdict may be parsed from a review that never ran');
  assert.equal('approved' in result, false, 'and nothing named approval may appear');
  assert.equal('accepted' in result, false);

  // The call order is the evidence: the waterfall refused, so no turn began and
  // no request reached the (simulated) model.
  assert.equal(agents.created.length, 1, 'the agent existed; the failure is at the request, not the creation');
  const record = agents.created[0];
  assert.equal(record.assemblyFailure?.code, REVIEW_CODES.assemblyMismatch,
    'the refusal is the review transform\'s, raised while assembling');
  assert.match(String(record.assemblyFailure?.message), /missing its tools/i);
  assert.equal(record.followups.length, 0, 'zero followups were recorded');
  assert.deepEqual(record.requests, [], 'zero model requests were recorded');
  assert.equal(agents.order.includes('followup'), false, 'no turn may be recorded as started');
  // The ordering itself: assembly ran and failed BEFORE anything a request could
  // have produced, so `assembly-failed` is the last thing that happened.
  assert.equal(agents.order.at(-1), 'assembly-failed', 'the refusal is the last act: nothing ran after it');
  // The review is reported as a failure with no text: nothing was ever sent, so
  // there is nothing to parse and nothing that could read as approval.
  assert.equal(result.text, '');
});

test('a successfully assembled review request carries exactly the read-only set', async () => {
  // The positive half of the ordering proof. The same seam that refuses a broken
  // assembly records the assembly a good one produced, so the request the model
  // would receive is read from the REQUEST rather than from a separate
  // `agents.request()` replay.
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  assert.equal(result.state, REVIEW_STATES.completed);
  const record = agents.created[0];
  assert.equal(record.followups.length, 1, 'the review is prompted exactly once');
  assert.equal(record.requests.length, 1, 'and issues exactly one model request');
  assert.deepEqual(record.requests[0].toolNames, READ_ONLY, 'the request carries only the read-only set');
  assert.deepEqual(record.requests[0].tools.map((schema) => schema.name).sort(), READ_ONLY);
  // The request the fake recorded is the assembly the review transform returned:
  // the non-tool fields are untouched, and it is not the pre-filter assembly.
  assert.deepEqual(record.requests[0].assembly.sections, [{ name: 'deployment:persona-prefix', text: 'persona' }]);
  assert.deepEqual(record.requests[0].assembly.contexts, [{ name: 'sandbox', text: 'policy' }]);
  assert.equal(record.requests[0].assembly.variables.workspace, CWD);
});

test('an assembly that would still carry a non-read tool is filtered, and one it cannot prove is refused', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  const listener = agents.assemblyListeners()[0].listener;
  const upstream = assemblyOf(READ_ONLY);

  // The point of the filter: a downstream assembly that still carries
  // `subagent` is DROPPED, and what is returned is exactly the read-only set.
  const filtered = await listener(upstream, {}, async () => assemblyOf([...READ_ONLY, 'subagent']));
  assert.deepEqual(filtered.tools.map((schema) => schema.name).sort(), READ_ONLY);
  assert.equal(filtered.tools.some((schema) => schema.name === 'subagent'), false);

  // A downstream assembly that never carried a read-only tool cannot be turned
  // into the computed set by filtering, so it is refused with the name as
  // evidence rather than silently under-provisioning the reviewer.
  await assert.rejects(
    () => listener(upstream, {}, async () => assemblyOf(['read', 'glob', 'grep'])),
    (error) => error.code === REVIEW_CODES.assemblyMismatch
      && JSON.stringify(error.details.missing).includes('read_image'),
  );
});

test('a malformed downstream assembly fails closed instead of passing through', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  const listener = agents.assemblyListeners()[0].listener;
  const upstream = assemblyOf(READ_ONLY);

  // A downstream provider that returns nothing at all.
  await assert.rejects(
    () => listener(upstream, {}, async () => undefined),
    (error) => error.code === REVIEW_CODES.assemblyMismatch,
  );
  // A downstream assembly whose `tools` is not a list.
  await assert.rejects(
    () => listener(upstream, {}, async () => ({ ...upstream, tools: 'read' })),
    (error) => error.code === REVIEW_CODES.assemblyMismatch && /not a list/.test(error.message),
  );
  // A schema with no name: unaccountable, so it may not travel.
  await assert.rejects(
    () => listener(upstream, {}, async () => ({ ...upstream, tools: [{ description: 'anon', parameters: {} }] })),
    (error) => error.code === REVIEW_CODES.assemblyMismatch && /no name/.test(error.message),
  );
});

test('a context that cannot register the assembly transform fails before any prompt', async () => {
  // No `on` at all: the model-facing tools could not be filtered.
  const withoutOn = reviewAgents({ omit: ['on'], respond: { text: 'VERDICT: approve' } });
  const noOnResult = await reviewWork(reviewDeps(withoutOn), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(noOnResult.state, REVIEW_STATES.failed);
  assert.equal(noOnResult.error.code, REVIEW_CODES.assemblyUnavailable);
  assert.equal(withoutOn.created[0].followups.length, 0, 'no prompt may be delivered without the filter');
  assert.equal(withoutOn.tools.guards.length, 0, 'a refused review leaves no half-installed policy');

  // An `on` that answers `false`: the registration was refused by the context.
  const refused = reviewAgents({ omit: ['assemble'], respond: { text: 'VERDICT: approve' } });
  const refusedResult = await reviewWork(reviewDeps(refused), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(refusedResult.state, REVIEW_STATES.failed);
  assert.equal(refusedResult.error.code, REVIEW_CODES.assemblyUnavailable);
  assert.equal(refused.created[0].followups.length, 0);
  assert.equal(refused.assemblyListeners().length, 0);
});

test('a tool the pre-policy inventory never reported is refused as unenforceable', async () => {
  // The computed set is only as good as the inventory it came from. A post-policy
  // surface naming something that inventory never contained means the registry's
  // own evidence no longer describes the scope, so nothing can be proven about it.
  const agents = reviewAgents({
    respond: { text: 'VERDICT: approve' },
    surfaceScript: [
      STOCK_INVENTORY,
      // The pre-policy inventory plus a name that appeared from nowhere.
      [...STOCK_INVENTORY, 'mystery_tool'],
      // The post-policy surface the transform would be filtered against.
      [...READ_ONLY, 'mystery_tool'],
      [...READ_ONLY, 'mystery_tool'],
    ],
  });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.scopeUnenforceable);
  assert.match(result.error.detail ?? '', /mystery_tool/);
  assert.equal(agents.created[0].followups.length, 0);
});

test('the allow-list the restriction and the filter share cannot be widened by input', async () => {
  // The assembly filter is driven by the same computed set as the restriction.
  // A caller asking for a wider list must change neither the restricted allow
  // list nor the tools the model is sent.
  const agents = reviewAgents({ local: ['subagent'], respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
    extraAllowedTools: ['write', 'subagent', 'shell', 'workflow'],
  });

  assert.equal(result.state, REVIEW_STATES.completed);
  assert.deepEqual(allowListOf(agents.created[0]).sort(), READ_ONLY);
  assert.deepEqual(await requestToolNames(agents), READ_ONLY);
  for (const name of ['write', 'subagent', 'shell', 'workflow']) {
    assert.equal(agents.tools.canExecute(agents.created[0].agent, name), false, `${name} must not execute`);
  }
});

test('a missing guard fails the review closed and delivers no prompt', async () => {
  const agents = reviewAgents({ omit: ['guard'], respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.guardUnavailable);
  assert.equal(agents.created[0].followups.length, 0);
  assert.equal(agents.tools.restrictCalls.length, 0, 'no half-installed policy may be left behind');
});

test('a missing restriction fails the review closed and delivers no prompt', async () => {
  const agents = reviewAgents({ omit: ['restrict'], respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.restrictUnavailable);
  assert.equal(agents.created[0].followups.length, 0);
});

test('a registry without a tool inventory fails the review closed', async () => {
  const agents = reviewAgents({ omit: ['schemas'], respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.inventoryUnavailable);
  assert.equal(agents.created[0].followups.length, 0);
});

test('an inventory with no read tools cannot produce a read-only review', async () => {
  const agents = reviewAgents({ inventory: ['write', 'edit', 'shell'], respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.noReadTools);
  assert.equal(agents.created[0].followups.length, 0);
});

test('a missing preset registry fails the review before an agent exists', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const result = await reviewWork({ agents }, {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.presetsUnavailable);
  assert.equal(agents.created.length, 0);
});

test('review denials are recorded as bounded, redacted evidence', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const deps = reviewDeps(agents);
  const pending = reviewWork(deps, {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  // The guard exists as soon as setup has run; deny through it before the turn
  // settles so the record proves what the reviewer tried to execute.
  const result = await pending;
  for (const name of ['write', 'unknown_tool', 'sk-abcdefghijklmnopqrstuvwx']) {
    assert.notEqual(guardOf(agents, name), undefined, name);
  }
  for (let index = 0; index < 200; index += 1) guardOf(agents, `probe_${index}`);

  assert.equal(result.denials.length, 100, 'the denial log must be bounded');
  assert.match(result.denials[0].reason, /read-only|allow-list/);
  const serialized = JSON.stringify(result.denials);
  assert.equal(serialized.includes('sk-abcdefghijklmnopqrstuvwx'), false, 'a secret-shaped tool name must be redacted');
});

test('the reviewer cannot approve on the host behalf', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve\nREASON: fine' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  // The record exposes a verdict, and nothing named approval/acceptance.
  assert.equal(result.verdict.verdict, 'approve');
  assert.equal('approved' in result, false);
  assert.equal('accepted' in result, false);
});

test('a changes-requested verdict is reported without triggering a repair round', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: changes-requested\nREASON: missing tests' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.verdict.verdict, 'changes-requested');
  assert.equal(result.verdict.reason, 'missing tests');
  assert.equal(agents.created.length, 1, 'no second agent may be spawned to repair');
});

test('a reviewer with no parsable verdict yields unknown, never approval', async () => {
  const agents = reviewAgents({ respond: { text: 'I think it is probably fine.' } });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.verdict.verdict, 'unknown');
});

test('a review failure is distinct from an execution failure', async () => {
  const agents = {
    async create() { throw new Error('reviewer provider unreachable'); },
  };
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.verdict, null);
  assert.equal(result.error.code, REVIEW_CODES.failed);
});

test('a missing agent registry fails the review rather than skipping it silently', async () => {
  const result = await reviewWork({}, {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.agentsUnavailable);
});

test('an empty review prompt is refused before an agent exists', async () => {
  const agents = reviewAgents();
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: '',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.promptEmpty);
  assert.equal(agents.created.length, 0);
});

test('an oversized review prompt is refused before an agent exists', async () => {
  const agents = reviewAgents();
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'x'.repeat(200_001),
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.promptTooLarge);
  assert.equal(agents.created.length, 0);
});

test('cancelling during pending creation disposes the late handle and never prompts', async () => {
  let releaseCreate;
  const gate = new Promise((resolvePromise) => { releaseCreate = resolvePromise; });
  const agents = reviewAgents({ defer: gate, respond: { text: 'VERDICT: approve' } });

  const controller = new AbortController();
  const pending = reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
    timeoutMs: 60_000,
    signal: controller.signal,
  });

  controller.abort();
  releaseCreate();
  const result = await pending;
  // The abandoned factory is still unwinding; the runner disposes the handle as
  // soon as it exists, so give it the tick it needs before asserting ownership.
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });

  assert.equal(result.state, REVIEW_STATES.cancelled);
  assert.equal(result.error.code, REVIEW_CODES.cancelled);
  assert.equal(result.verdict, null);
  for (const record of agents.created) {
    assert.equal(record.followups.length, 0, 'a cancelled review must never be prompted');
    assert.equal(record.disposed, true, 'the late handle must not outlive the review');
  }
});

test('a timeout that lands during pending creation ends the review and disposes the handle', async () => {
  let releaseCreate;
  const gate = new Promise((resolvePromise) => { releaseCreate = resolvePromise; });
  const agents = reviewAgents({ defer: gate, respond: { text: 'VERDICT: approve' } });

  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
    timeoutMs: 20,
  });
  releaseCreate();
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });

  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.timeout);
  for (const record of agents.created) {
    assert.equal(record.followups.length, 0, 'a timed-out review must never be prompted');
    assert.equal(record.disposed, true);
  }
});

test('review output and diagnostics are redacted', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwx';
  const agents = reviewAgents({
    respond: { text: `VERDICT: approve\nREASON: the worker left ${secret} in a log line` },
  });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.completed);
  assert.equal(result.text.includes(secret), false);
  assert.equal(result.verdict.reason.includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false, 'no field of the record may carry a credential');
  assert.match(result.text, /••••/);
});

test('the allow-list and mutation detector classify tool names correctly', () => {
  const allowed = reviewerToolAllowList();
  assert.equal(allowed.has('read'), true);
  assert.equal(allowed.has('read_image'), true);
  assert.equal(allowed.has('glob'), true);
  assert.equal(allowed.has('grep'), true);
  // Names the native tools never used must not appear: restrict() would throw.
  assert.equal(allowed.has('read_file'), false);
  assert.equal(allowed.has('list_directory'), false);
  assert.equal(allowed.size, 4);
  for (const name of ['write', 'edit', 'apply_patch', 'shell', 'git_commit', 'run_command']) {
    assert.equal(looksMutating(name), true, name);
  }
  for (const name of ['read', 'read_image', 'glob', 'grep']) {
    assert.equal(looksMutating(name), false, name);
  }
});

test('the review prompt states its read-only limits and required output', () => {
  const prompt = buildReviewPrompt({
    taskId: 'task-1',
    taskPrompt: 'add a function',
    workerSummary: 'added a function',
    evidence: { files: [{ status: 'modified', path: 'src/a.js' }], fileCount: 1, patchText: '+x' },
  });
  assert.match(prompt, /read-only/);
  assert.match(prompt, /cannot approve work on behalf of the host/);
  assert.match(prompt, /VERDICT: approve/);
  assert.match(prompt, /REASON:/);
  assert.match(prompt, /src\/a\.js/);
});

test('the worker prompt forbids self-approval and history rewriting', () => {
  const prompt = buildWorkerPrompt({
    taskId: 'task-1',
    prompt: 'add a function',
    workspacePath: CWD,
    isolation: 'shared',
  });
  assert.match(prompt, /Do not commit, push, tag, or rewrite git history/);
  assert.match(prompt, /You cannot approve your own work/);
  assert.match(prompt, /Do not claim checks you did not run/);
});

test('evidence rendering discloses sensitive paths without their content', () => {
  const block = renderEvidence({
    dirtyBaseline: true,
    preexistingChanges: 3,
    files: [
      { status: 'modified', path: '.env', sensitive: true },
      { status: 'modified', path: 'src/a.js', sensitive: false },
    ],
    fileCount: 2,
    sensitivePaths: ['.env'],
    patchText: 'diff --git a/src/a.js b/src/a.js\n+ok\n',
  });
  assert.match(block, /\.env/);
  assert.match(block, /content withheld/);
  assert.match(block, /pre-existing change/);
  assert.match(block, /\+ok/);
});

test('evidence rendering bounds an oversized patch', () => {
  const block = renderEvidence({
    files: [],
    fileCount: 0,
    patchText: 'x'.repeat(50_000),
  });
  assert.ok(block.length < 30_000);
  assert.match(block, /truncated for review/);
});

test('verdict parsing is case-insensitive and bounded', () => {
  assert.deepEqual(parseVerdict('verdict:  APPROVE'), { verdict: 'approve', reason: null });
  assert.deepEqual(parseVerdict('VERDICT: changes-requested\nREASON: needs work'), { verdict: 'changes-requested', reason: 'needs work' });
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict('nothing useful').verdict, 'unknown');
  const long = parseVerdict(`VERDICT: approve\nREASON: ${'y'.repeat(1000)}`);
  assert.ok(long.reason.length <= 400);
});

// ---------------------------------------------------------------------------
// The plugin-owned read-only composition
//
// Review is only reachable on a real deployment if it composes its OWN agent
// preset: the shipped default mounts `dsh-tool-subagent`, whose tool a scope
// restriction cannot remove, so a reviewer joining it can never be proven
// read-only. These tests pin the composition's contents and the lifecycle that
// makes registering it safe (idempotent, lazy, bounded, releasable).
// ---------------------------------------------------------------------------

test('the review composition contains only read surfaces and excludes delegation', () => {
  const rows = reviewCompositionRows();
  const names = rows.map((row) => row.name);
  assert.deepEqual(names, ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search']);

  const fs = rows.find((row) => row.name === '@deepseek-ai/dsh-tool-fs');
  assert.equal(fs.config.read, true);
  assert.equal(fs.config.readImage, true);
  // Composition-level exclusion: these tools are never registered in this plane.
  assert.equal(fs.config.write, false);
  assert.equal(fs.config.edit, false);

  const search = rows.find((row) => row.name === '@deepseek-ai/dsh-tool-fs-search');
  assert.equal(search.config.sampleOverCapGlobResults, false, 'the deterministic glob page must be explicit');

  // Nothing that can delegate, mutate, spawn or schedule may appear by name.
  for (const forbidden of [
    'dsh-tool-subagent', 'dsh-tool-subagent-control', 'dsh-tool-workflow', 'dsh-workflow-ptc',
    'dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-tool-bash-persistent', 'dsh-tool-pwsh-persistent',
    'dsh-tool-schedule', 'dsh-skill-filesystem', 'dsh-tool-skill', 'dsh-tool-jobs',
    'dsh-tool-web', 'dsh-tool-todo', 'dsh-tool-goal', 'dsh-plan-mode',
  ]) {
    assert.equal(
      rows.some((row) => String(row.name).includes(forbidden)),
      false,
      `${forbidden} must not be part of the review composition`,
    );
  }

  // Definition metadata: namespaced, ordered after the shipped presets, and never
  // presented as something an operator should select for their own sessions.
  const definition = reviewPresetDefinition('dsh-delegate-review-abc123');
  assert.equal(definition.id, 'dsh-delegate-review-abc123');
  assert.deepEqual(definition.plugins, rows);
  assert.equal(definition.order > 1, true, 'the plugin composition must sort after the shipped presets');
  assert.match(definition.name, /plugin-owned/);
});

test('the composition is registered once, lazily, and every concurrent review shares it', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets();
  const deps = reviewDeps(agents, presets);
  assert.equal(presets.registerCalls, 0, 'registration must be lazy, not part of plugin activation');

  await Promise.all([
    reviewWork(deps, { taskId: 't1', cwd: CWD, selection: SELECTION, prompt: 'a' }),
    reviewWork(deps, { taskId: 't2', cwd: CWD, selection: SELECTION, prompt: 'b' }),
    reviewWork(deps, { taskId: 't3', cwd: CWD, selection: SELECTION, prompt: 'c' }),
  ]);

  assert.equal(presets.registerCalls, 1, 'one registration serves every concurrent review');
  assert.equal(presets.definitions.size, 1);
  assert.deepEqual(presets.mounts.map((mount) => mount.id), [
    'dsh-delegate-review-test', 'dsh-delegate-review-test', 'dsh-delegate-review-test',
  ]);

  // A later review reuses the same registration rather than creating another one.
  await reviewWork(deps, { taskId: 't4', cwd: CWD, selection: SELECTION, prompt: 'd' });
  assert.equal(presets.registerCalls, 1);
});

test('a duplicate preset id is refused instead of mounting another owner composition', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets();
  // Another owner already uses the id this instance would claim.
  await presets.register({ id: 'dsh-delegate-review-test', plugins: [{ name: '@deepseek-ai/dsh-tool-subagent' }] });
  const deps = reviewDeps(agents, presets);

  const result = await reviewWork(deps, { taskId: 't', cwd: CWD, selection: SELECTION, prompt: 'review this' });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.presetPrepareFailed);
  assert.equal(result.error.reason, PRESET_CODES.registerFailed);
  assert.match(result.error.detail ?? '', /Duplicate agent preset/);
  assert.equal(agents.created.length, 0, 'a review that cannot claim its own composition must not run');
  // The other owner's composition is untouched.
  assert.equal(presets.definitions.get('dsh-delegate-review-test').config.plugins[0].name, '@deepseek-ai/dsh-tool-subagent');
});

test('a composition whose rows failed to mount is reported as unusable, not as registered', async () => {
  // The native registry RESOLVES for such a definition and reports the failure
  // from `resolve()`. Treating "register() resolved" as success would mount a
  // composition with no tools and call the review read-only.
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets({
    broken: { 'dsh-delegate-review-test': 'tool-fs (@deepseek-ai/dsh-tool-fs): waiting for fs' },
  });
  const result = await reviewWork(reviewDeps(agents, presets), {
    taskId: 't', cwd: CWD, selection: SELECTION, prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.presetPrepareFailed);
  assert.equal(result.error.reason, PRESET_CODES.unusable);
  assert.match(result.error.detail ?? '', /dsh-tool-fs/);
  assert.equal(agents.created.length, 0);
});

test('absent native tool packages are reported before anything is registered', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets();
  const deps = reviewDeps(agents, presets, {
    importer: async (specifier) => {
      const error = new Error('Cannot find package');
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw Object.assign(error, { specifier });
    },
  });
  const result = await reviewWork(deps, { taskId: 't', cwd: CWD, selection: SELECTION, prompt: 'review this' });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.presetPrepareFailed);
  assert.equal(result.error.reason, PRESET_CODES.rowsUnavailable);
  assert.equal(presets.registerCalls, 0);
  assert.equal(agents.created.length, 0);
});

test('a preparation that cannot finish in its bound fails the review without creating an agent', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets();
  let releaseRegister;
  const never = new Promise((resolvePromise) => { releaseRegister = resolvePromise; });
  presets.register = async () => never;

  const result = await reviewWork(reviewDeps(agents, presets), {
    taskId: 't',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
    prepareTimeoutMs: 20,
  });
  releaseRegister(() => {});
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.presetPrepareFailed);
  assert.equal(result.error.reason, PRESET_CODES.prepareTimeout);
  assert.equal(agents.created.length, 0, 'no agent may exist before its composition is known');
});

test('a review cancelled during preparation reports cancelled and creates no agent', async () => {
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets();
  presets.resolve = async () => await new Promise(() => {});
  const controller = new AbortController();
  const pending = reviewWork(reviewDeps(agents, presets), {
    taskId: 't',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
    signal: controller.signal,
  });
  controller.abort();
  const result = await pending;
  assert.equal(result.state, REVIEW_STATES.cancelled);
  assert.equal(result.error.code, REVIEW_CODES.cancelled);
  assert.equal(result.verdict, null);
  assert.equal(agents.created.length, 0);
});

test('the plugin disposes its composition, and a later review refuses instead of remounting it', async () => {
  const presets = registeringPresets();
  const composer = new ReviewPreset({ registry: presets, id: 'dsh-delegate-review-life', importer: async () => ({ apply() {} }) });
  const id = await composer.preparation({});
  assert.equal(presets.definitions.has(id), true, 'preparation registers the composition');

  await composer.dispose();
  assert.equal(presets.definitions.has(id), false, 'unload must remove the composition');
  await assert.rejects(
    () => composer.preparation({}),
    (error) => error.code === PRESET_CODES.disposed,
  );
});

test('a registry without register/resolve is refused with the distinct unsupported code', async () => {
  const mountOnly = { async mount() { return { id: 'standard' }; } };
  const composer = new ReviewPreset({ registry: mountOnly, importer: async () => ({ apply() {} }) });
  assert.equal(composer.supported, false);
  await assert.rejects(
    () => composer.preparation({}),
    (error) => error.code === PRESET_CODES.unsupported,
  );

  // Attaching a capable registry later recovers without keeping the old verdict.
  const capable = registeringPresets();
  const recovered = new ReviewPreset({ registry: capable, id: 'dsh-delegate-review-test', importer: async () => ({ apply() {} }) });
  recovered.attach(capable);
  assert.equal(await recovered.preparation({}), 'dsh-delegate-review-test');
  assert.equal(capable.registerCalls, 1);
  // A second attach of the SAME registry is a no-op, not a second registration.
  recovered.attach(capable);
  assert.equal(await recovered.preparation({}), 'dsh-delegate-review-test');
  assert.equal(capable.registerCalls, 1);
  await recovered.dispose();
});

test('a failed preparation is retried rather than poisoning the instance', async () => {
  const presets = registeringPresets();
  let attempts = 0;
  const nativeRegister = presets.register.bind(presets);
  presets.register = async (definition) => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient loader failure');
    return await nativeRegister(definition);
  };
  const composer = new ReviewPreset({ registry: presets, id: 'dsh-delegate-review-retry', importer: async () => ({ apply() {} }) });
  await assert.rejects(() => composer.preparation({}), (error) => error.code === PRESET_CODES.registerFailed);
  assert.equal(await composer.preparation({}), 'dsh-delegate-review-retry');
  assert.equal(attempts, 2);
  await composer.dispose();
});

test('a review only mounts a preset the composer owns', async () => {
  // The mount is the one step that decides the tool surface. A review must never
  // be able to name a composition it does not own, even through the run request.
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets();
  await presets.register({ id: 'somebody-elses-preset', plugins: [{ name: '@deepseek-ai/dsh-tool-subagent' }] });
  const deps = reviewDeps(agents, presets);
  // Force the review onto a foreign id: the composer cannot own it.
  deps.reviewPresets = {
    id: 'somebody-elses-preset',
    owns: () => false,
    preparation: async () => 'somebody-elses-preset',
  };

  const result = await reviewWork(deps, { taskId: 't', cwd: CWD, selection: SELECTION, prompt: 'review this' });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.presetPrepareFailed);
  assert.equal(result.error.reason, 'RUN_PRESET_NOT_OWNED');
  assert.equal(agents.created.length, 0, 'a foreign composition must not even create the agent');
});

// ---------------------------------------------------------------------------
// Preparation races, retries and lifecycle
//
// The composition is registered from a request handler, so every one of these
// races is reachable in production: a resolve that fails after a good register,
// a register that answers after its caller gave up, two callers with different
// budgets, and a registry swapped underneath a live composition. Each test pins
// the invariant that used to be violated rather than the current code shape.
// ---------------------------------------------------------------------------

/** A composer over a fake registry, with the review entry's own id and importer. */
function composerOver(registry, options = {}) {
  return new ReviewPreset({
    registry,
    id: options.id ?? 'dsh-delegate-review-test',
    importer: options.importer ?? (async () => ({ apply() {} })),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

test('a failed verification leaves the composition unready, and the next review retries', async () => {
  // `register()` resolves for a definition whose rows failed to mount, so
  // readiness must come from `resolve()`. When resolve itself fails, the
  // instance must not keep the registration it cannot verify: the next review
  // has to start a NEW attempt, not mount the half-proved one.
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets();
  const nativeResolve = presets.resolve.bind(presets);
  let resolveAttempts = 0;
  presets.resolve = async (wanted) => {
    resolveAttempts += 1;
    if (resolveAttempts === 1) throw new Error('registry is still settling');
    return await nativeResolve(wanted);
  };
  const composer = composerOver(presets);
  const deps = { agents, agentPresets: presets, reviewPresets: composer };

  const first = await reviewWork(deps, { taskId: 't1', cwd: CWD, selection: SELECTION, prompt: 'a' });
  assert.equal(first.state, REVIEW_STATES.failed);
  assert.equal(first.error.reason, PRESET_CODES.unusable);
  assert.equal(composer.createdId, null, 'an unverified composition must not be published as owned');
  assert.equal(composer.owns('dsh-delegate-review-test'), false);
  assert.equal(presets.definitions.size, 0, 'the unverified registration must be retired');
  assert.equal(agents.created.length, 0, 'and no reviewer may be created for it');

  // The retry registers fresh and succeeds; the earlier failure poisoned nothing.
  const second = await reviewWork(deps, { taskId: 't2', cwd: CWD, selection: SELECTION, prompt: 'b' });
  assert.equal(second.state, REVIEW_STATES.completed);
  assert.equal(presets.definitions.has('dsh-delegate-review-test'), true);
  assert.equal(composer.owns('dsh-delegate-review-test'), true);
  await composer.dispose();
});

test('a verification that reports a broken row retires that registration too', async () => {
  const presets = registeringPresets({
    broken: { 'dsh-delegate-review-test': 'tool-fs (@deepseek-ai/dsh-tool-fs): waiting for fs' },
  });
  const composer = composerOver(presets);
  await assert.rejects(
    () => composer.preparation({}),
    (error) => error.code === PRESET_CODES.unusable && /dsh-tool-fs/.test(JSON.stringify(error.details)),
  );
  assert.equal(composer.createdId, null);
  assert.equal(presets.definitions.size, 0, 'a broken composition must not be left registered');
});

test('a registration that completes after its caller gave up is retired, not published', async () => {
  // The register call outlives the caller's bound. Its disposer arrives late; if
  // it is dropped the composition lives for the life of the process AND a later
  // preparation would publish an id nothing here ever verified.
  const presets = registeringPresets();
  const nativeRegister = presets.register.bind(presets);
  let releaseRegister;
  const gate = new Promise((resolvePromise) => { releaseRegister = resolvePromise; });
  presets.register = async (definition) => {
    await gate;
    return await nativeRegister(definition);
  };
  const composer = composerOver(presets);

  await assert.rejects(
    () => composer.preparation({ timeoutMs: 15 }),
    (error) => error.code === PRESET_CODES.prepareTimeout,
  );
  releaseRegister();
  // Let the abandoned registration settle so its disposer runs.
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });

  assert.equal(composer.createdId, null, 'the late registration must not republish ownership');
  assert.equal(composer.ready, false);
  assert.equal(presets.definitions.size, 0, 'the late registration must be retired from the registry');

  // A later preparation registers its own composition and is the only owner.
  assert.equal(await composer.preparation({}), 'dsh-delegate-review-test');
  assert.equal(presets.registerCalls, 2);
  assert.equal(presets.definitions.size, 1);
  await composer.dispose();
});

/**
 * A fake registry whose FIRST `register()` call parks until it is released.
 *
 * Used to put a preparation deterministically inside `register()` without any
 * wall-clock delay: the gate is announced by `entered` (the attempt is inside
 * the native call, so its early steps have completed) and opened by `release()`
 * (the registration resolves only when the test says so). Later calls are not
 * gated, so a retry can still be observed.
 * @returns {object} registry with `entered`, `release()` and `disposerCalls`.
 */
function gatedPresets() {
  const registry = registeringPresets();
  const nativeRegister = registry.register.bind(registry);
  let openGate;
  let announceEntered;
  let gated = true;
  registry.entered = new Promise((resolvePromise) => { announceEntered = resolvePromise; });
  const closed = new Promise((resolvePromise) => { openGate = resolvePromise; });
  registry.disposerCalls = 0;
  registry.registerEntered = 0;
  registry.release = () => openGate();
  registry.register = async (definition) => {
    registry.registerEntered += 1;
    if (gated) {
      gated = false;
      announceEntered();
      await closed;
    }
    const disposer = await nativeRegister(definition);
    // Counted here, i.e. where the native disposer actually runs.
    return async () => {
      registry.disposerCalls += 1;
      return await disposer();
    };
  };
  return registry;
}

test('a register that resolves after dispose completed is retired, never republished', async () => {
  // The unload wins the race against a registration an external loader has not
  // answered yet. `dispose()` can only retire the claims it can SEE, and at that
  // moment there is no claim: the disposer does not exist until `register()`
  // resolves. So the late registration must retire itself on arrival instead of
  // becoming this instance's claim — otherwise unload leaves a live composition
  // in the registry AND the instance republishes an id it no longer serves.
  const presets = gatedPresets();
  const composer = composerOver(presets);

  const preparation = composer.preparation({}).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error.code }),
  );
  // Deterministic parking: `entered` settles from inside register(), so every
  // earlier step has run and nothing can advance further until `release()`.
  await presets.entered;
  assert.equal(presets.registerEntered, 1, 'the attempt must be parked inside register()');
  assert.equal(composer.state, 'preparing');
  assert.notEqual(composer.pending, null, 'and the shared attempt must still own the slot');

  await composer.dispose();
  assert.equal(composer.state, 'disposed', 'dispose must have completed before register resolves');

  presets.release();
  const outcome = await preparation;

  // Refusal, not a silently dropped success: an unloaded plugin cannot serve the
  // composition the caller asked for.
  assert.deepEqual(outcome, { ok: false, code: PRESET_CODES.disposed });
  assert.equal(composer.state, 'disposed', 'a late registration must not move the state back');
  assert.equal(composer.createdId, null, 'and must not republish ownership');
  assert.equal(composer.ready, false);
  assert.equal(composer.owns('dsh-delegate-review-test'), false);
  assert.equal(presets.disposerCalls, 1, 'its disposer runs exactly once');
  assert.equal(presets.definitions.size, 0, 'the late registration must not be left in the registry');

  // Still unusable afterwards, and the registration is neither re-created nor
  // retired a second time.
  await assert.rejects(
    () => composer.preparation({}),
    (error) => error.code === PRESET_CODES.disposed,
  );
  assert.equal(presets.registerEntered, 1, 'a disposed instance must never register again');
  assert.equal(presets.disposerCalls, 1, 'no second retirement of the same registration');
  assert.equal(presets.definitions.size, 0);
});

test('simultaneous preparations each honour their own bound while sharing one registration', async () => {
  // Native registry: one `register()` per composition. Two reviews starting at
  // once must not register twice, and a review that runs out of ITS OWN budget
  // must not cancel the one that is still waiting.
  const presets = registeringPresets();
  const nativeRegister = presets.register.bind(presets);
  let releaseRegister;
  const gate = new Promise((resolvePromise) => { releaseRegister = resolvePromise; });
  presets.register = async (definition) => {
    await gate;
    return await nativeRegister(definition);
  };
  const composer = composerOver(presets);

  const impatient = composer.preparation({ timeoutMs: 10 }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error.code }),
  );
  const patient = composer.preparation({ timeoutMs: 5000 }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, code: error.code }),
  );

  const first = await impatient;
  assert.deepEqual(first, { ok: false, code: PRESET_CODES.prepareTimeout }, 'the short budget refuses its own caller');
  releaseRegister();
  const second = await patient;
  assert.deepEqual(second, { ok: true, value: 'dsh-delegate-review-test' }, 'the waiting caller still gets the id');
  assert.equal(presets.registerCalls, 1, 'both callers shared exactly one registration');
  assert.equal(composer.owns('dsh-delegate-review-test'), true);
  await composer.dispose();
});

test('one caller cancelling its signal does not cancel the shared preparation', async () => {
  const presets = registeringPresets();
  const nativeRegister = presets.register.bind(presets);
  let releaseRegister;
  const gate = new Promise((resolvePromise) => { releaseRegister = resolvePromise; });
  presets.register = async (definition) => {
    await gate;
    return await nativeRegister(definition);
  };
  const composer = composerOver(presets);
  const controller = new AbortController();

  const cancelled = composer.preparation({ signal: controller.signal }).then(
    () => null,
    (error) => error.code,
  );
  const kept = composer.preparation({ timeoutMs: 5000 }).then((value) => value, () => null);
  controller.abort();
  assert.equal(await cancelled, PRESET_CODES.cancelled);
  releaseRegister();
  assert.equal(await kept, 'dsh-delegate-review-test');
  await composer.dispose();
});

test('attaching a new registry retires the old composition instead of forgetting it', async () => {
  // `attach` is called on every review because the registry service can appear or
  // be replaced after load. Dropping the old disposer would leave the previous
  // composition live in a registry this plugin no longer talks to.
  const oldRegistry = registeringPresets();
  const composer = composerOver(oldRegistry);
  assert.equal(await composer.preparation({}), 'dsh-delegate-review-test');
  assert.equal(oldRegistry.definitions.size, 1);

  const newRegistry = registeringPresets();
  composer.attach(newRegistry);
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });

  assert.equal(oldRegistry.definitions.size, 0, 'the old composition must be unregistered');
  assert.equal(composer.createdId, null, 'and its ownership must not survive the swap');
  assert.equal(composer.owns('dsh-delegate-review-test'), false);

  assert.equal(await composer.preparation({}), 'dsh-delegate-review-test');
  assert.equal(newRegistry.definitions.size, 1, 'the new registry gets its own registration');
  assert.equal(oldRegistry.definitions.size, 0);
  await composer.dispose();
  assert.equal(newRegistry.definitions.size, 0);
});

test('a stale verification finishing after a registry swap cannot republish the old id', async () => {
  // The swap happens while `resolve()` is still in flight for the old registry.
  // That resolve must retire itself: publishing it would let a review mount an
  // id that only exists in the registry this instance no longer uses.
  const oldRegistry = registeringPresets();
  let releaseResolve;
  const gate = new Promise((resolvePromise) => { releaseResolve = resolvePromise; });
  const nativeResolve = oldRegistry.resolve.bind(oldRegistry);
  oldRegistry.resolve = async (wanted) => {
    await gate;
    return await nativeResolve(wanted);
  };
  const composer = composerOver(oldRegistry);
  const inFlight = composer.preparation({}).then(() => 'ready', (error) => error.code);

  // Swap while the verification is pending.
  const newRegistry = registeringPresets();
  composer.attach(newRegistry);
  releaseResolve();
  const outcome = await inFlight;
  assert.notEqual(outcome, 'ready', 'the superseded attempt must not report readiness');
  assert.equal(composer.createdId, null, 'nor publish an id from the previous registry');
  assert.equal(oldRegistry.definitions.size, 0, 'its registration is retired');

  assert.equal(await composer.preparation({}), 'dsh-delegate-review-test');
  assert.equal(newRegistry.definitions.size, 1);
  await composer.dispose();
});

test('unload does not block forever on a disposer that never settles', async () => {
  // The disposer is an external promise owned by the registry. A plugin unload
  // must not wait for a foreign plugin that never finishes: it clears every
  // published fact synchronously and abandons the pending teardown.
  const presets = registeringPresets();
  const nativeRegister = presets.register.bind(presets);
  presets.register = async (definition) => {
    await nativeRegister(definition);
    return () => new Promise(() => {});
  };
  const composer = composerOver(presets);
  assert.equal(await composer.preparation({}), 'dsh-delegate-review-test');

  const started = Date.now();
  await composer.dispose();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `unload returned in ${elapsed}ms instead of waiting forever`);
  assert.equal(composer.createdId, null, 'the id is gone as soon as unload starts');
  assert.equal(composer.owns('dsh-delegate-review-test'), false);
  await assert.rejects(
    () => composer.preparation({}),
    (error) => error.code === PRESET_CODES.disposed,
    'a review after unload refuses instead of remounting',
  );
});

test('reading the native packages is bounded like every other preparation step', async () => {
  // A package solve is normally a file read, but the importer is a seam: it can
  // be a host resolver that never settles. Preparation must not hang on it.
  const presets = registeringPresets();
  const composer = composerOver(presets, { importer: async () => new Promise(() => {}) });
  await assert.rejects(
    () => composer.preparation({ timeoutMs: 20 }),
    (error) => error.code === PRESET_CODES.prepareTimeout,
  );
  assert.equal(presets.registerCalls, 0, 'nothing may be registered for a composition that never loaded');
  assert.equal(composer.createdId, null);
});

test('a late rejection after the caller gave up is never an unhandled rejection', async () => {
  // The abandoned registration rejects instead of resolving. Nobody awaits it,
  // so the module must observe it: an unhandled rejection in a host request
  // handler is a process-level fault, not a review failure.
  const presets = registeringPresets();
  let releaseRegister;
  const gate = new Promise((resolvePromise) => { releaseRegister = resolvePromise; });
  presets.register = async () => {
    await gate;
    throw new Error('the loader died after the deadline');
  };
  const composer = composerOver(presets);

  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      () => composer.preparation({ timeoutMs: 15 }),
      (error) => error.code === PRESET_CODES.prepareTimeout,
    );
    releaseRegister();
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 60); });
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, [], 'a late failure must be observed, not leaked');
  assert.equal(composer.state, 'idle', 'the instance stays retryable');
});

test('a review refused during preparation creates no agent and reports its own reason', async () => {
  // End to end: the composer refuses, and the review record keeps the preset
  // code as `reason` while mapping the failure to the review vocabulary.
  const agents = reviewAgents({ respond: { text: 'VERDICT: approve' } });
  const presets = registeringPresets({
    broken: { 'dsh-delegate-review-test': 'tool-fs (@deepseek-ai/dsh-tool-fs): waiting for fs' },
  });
  const result = await reviewWork(reviewDeps(agents, presets), {
    taskId: 't', cwd: CWD, selection: SELECTION, prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, REVIEW_CODES.presetPrepareFailed);
  assert.equal(result.error.reason, PRESET_CODES.unusable);
  assert.equal(result.verdict, null);
  assert.equal(agents.created.length, 0);
  assert.equal(agents.created.length === 0 && presets.mounts.length, 0, 'no mount may be attempted');
});
