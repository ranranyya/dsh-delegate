// Test helpers: a fake DSH host.
//
// Every native seam this plugin touches is exercised through an interface the
// real harness also satisfies. The fakes therefore cannot make an invalid call
// look valid: they accept only the documented arguments and fail loudly on a
// shape the real service would reject. Route/effort metadata is returned in the
// exact shape `LlmRuntime.normalizeModelInfo` produces.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a temporary directory that the caller removes with {@link cleanup}.
 * @returns {Promise<string>} absolute directory path.
 */
export async function makeTempDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-delegate-test-'));
}

/**
 * Remove a temporary directory.
 * @param {string} dir - directory path.
 * @returns {Promise<void>} resolves when removed.
 */
export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Fake LLM service mirroring the parts of `LlmRuntime` this plugin uses.
 *
 * `resolveModelInfo` returns the post-validation shape: `{ provider, id, name,
 * reasoning?: { efforts: [{ id, name }], defaultEffort? } }`. A model absent
 * from `models` fails the way an unregistered route does.
 * @param {object} [options] - `providers`: `{ [providerId]: { [model]: string[] } }`.
 * @returns {object} fake service.
 */
export function fakeLlm(options = {}) {
  const providers = options.providers ?? {};
  const calls = { listProviders: 0, resolveModelInfo: 0, stream: 0 };
  const streamScript = options.streamScript ?? null;

  return {
    calls,
    listProviders() {
      calls.listProviders += 1;
      return Object.keys(providers).map((id) => ({ id, name: id }));
    },
    async listModels(provider) {
      return Object.keys(providers[provider] ?? {}).map((id) => ({ id, name: id }));
    },
    async resolveModelInfo(provider, model) {
      calls.resolveModelInfo += 1;
      const efforts = providers[provider]?.[model];
      if (efforts === undefined) {
        const error = new Error(`provider "${provider}" model "${model}" is not registered`);
        error.code = 'UNKNOWN_PROVIDER';
        throw error;
      }
      return {
        provider,
        id: model,
        name: model,
        ...(efforts.length === 0
          ? {}
          : { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } }),
      };
    },
    async *stream(request) {
      calls.stream += 1;
      if (streamScript !== null) {
        yield* streamScript(request);
        return;
      }
      yield { type: 'text-delta', index: 0, text: 'ready' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

/**
 * Fake native agent preset registry.
 *
 * `agentPresets.mount(ctx, id?)` is the call that joins an Agent to a preset
 * revision and mounts its plugin subtree, so an Agent that never received it has
 * no tools at all. The fake records every mount with the context and the
 * requested id, which lets a test prove the mount happened *before* the prompt
 * was delivered rather than inferring it from a report.
 * @param {object} [options] - `fail`: error to reject mounts with, `defer`: promise to await first.
 * @returns {object} fake registry with `mounts` history.
 */
export function fakeAgentPresets(options = {}) {
  const mounts = [];
  const order = options.order ?? null;
  const registry = {
    mounts,
    async mount(ctx, id) {
      mounts.push({ ctx, id });
      order?.push('mount');
      if (options.defer !== undefined) await options.defer;
      if (options.fail !== undefined) throw options.fail;
      return { id: id ?? 'default-preset' };
    },
  };
  if (options.register === true) {
    Object.assign(registry, nativePresetRegistry(options));
    // The surface probes the review performs are capability checks on the
    // registry it was handed, so a registry that registers must also mount: the
    // two are one API, and splitting them would model a host that cannot exist.
    registry.mount = async (ctx, id) => {
      mounts.push({ ctx, id });
      order?.push('mount');
      const resolved = id ?? registry.defaultId;
      if (!registry.definitions.has(resolved)) throw new Error(`Unknown agent preset: ${resolved}`);
      if (registry.definitions.get(resolved).broken !== undefined) {
        throw new Error(registry.definitions.get(resolved).broken);
      }
      return { id: resolved };
    };
  }
  return registry;
}

/**
 * The native preset registry contract, as far as a test needs it.
 *
 * Mirrors `AgentPresetRegistry` (0.2.0/0.2.1) on the three calls the review
 * composition uses, including the two behaviours that shaped the production
 * code:
 *  - `register()` refuses a duplicate id with the native message, and
 *  - `register()` RESOLVES for a definition whose rows failed to mount: the
 *    failure is reported by `resolve()`, not by the registration.
 * @param {object} [options] - `broken`: id -> diagnostic text to report for that
 *   definition (rows that failed to mount); `registerFails`: error to reject
 *   `register()` with; `defaultId`: configured default.
 * @returns {object} registry with `definitions`, `registrations`, `resolutions`.
 */
export function nativePresetRegistry(options = {}) {
  const definitions = new Map();
  const registrations = [];
  const resolutions = [];
  const broken = options.broken ?? {};
  const registry = {
    definitions,
    registrations,
    resolutions,
    defaultId: options.defaultId ?? 'standard',
    registerCalls: 0,
    async register(definition) {
      registry.registerCalls += 1;
      if (options.registerFails !== undefined) throw options.registerFails;
      if (typeof definition?.id !== 'string' || definition.id.trim() === '') {
        throw new Error('Preset id must not be empty');
      }
      if (definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
      const record = {
        config: definition,
        broken: broken[definition.id],
        disposed: false,
      };
      definitions.set(definition.id, record);
      registrations.push(record);
      return async () => {
        if (record.disposed) return;
        record.disposed = true;
        definitions.delete(definition.id);
      };
    },
    async resolve(id) {
      const wanted = id ?? registry.defaultId;
      resolutions.push(wanted);
      const record = definitions.get(wanted);
      if (record === undefined) throw new Error(`Unknown agent preset: ${wanted}`);
      return { id: wanted, ...(record.broken === undefined ? {} : { broken: record.broken }) };
    },
  };
  return registry;
}

/**
 * Fake native agent registry.
 *
 * The handle exposes `agent.followup`, `agent.cancel`, `agent.whenIdle` and
 * `dispose`, matching `AgentHandle`. Each created agent records the options it
 * was given, so a test can assert the exact provider/model/effort triple that
 * reached the harness instead of trusting the plugin's own report.
 *
 * Identity is modelled the way the native factory does it, because that is the
 * failure this fake has to be able to reproduce: `CreateAgentOptions.sessionId`
 * is REQUIRED and the session is created under exactly that string, and
 * `AgentRegistry.enter()` publishes the agent only when its id equals its
 * session's id. A create call that omits the identity therefore fails here with
 * the native message instead of quietly minting one, so a runner that forgot to
 * generate an identity cannot look healthy in tests.
 *
 * `respond` models one turn the way the agent loop does it: the turn's events are
 * emitted *when the prompt is delivered*, and only then does the agent become
 * idle. Settling on creation instead would race the runner's own idle wait and
 * hide an ordering bug. `respond.deltas` streams `text-delta` events first and
 * then emits the completed `assistant/message`, which is the native duplication
 * hazard; `respond.text` alone models a final message with no stream.
 * @param {object} [options] - `respond` plan, `script(agent, record)` hook, shared `order` log.
 * @returns {object} fake registry with `created`, `disposed` and `order` history.
 */
export function fakeAgents(options = {}) {
  const created = [];
  const disposed = [];
  const listeners = [];
  // A shared, externally supplied log lets a test order events that cross the
  // agent registry boundary — specifically that the preset mount happened
  // before the prompt was delivered.
  const order = options.order ?? [];

  const registry = {
    created,
    disposed,
    listeners,
    order,
    /**
     * Whether an identity is live in this registry, as `AgentRegistry.get` is
     * used by the runner's pre-create admission check.
     * @param {string} id - session/agent identity.
     * @returns {object|undefined} the live agent, or undefined.
     */
    get(id) {
      return created.find((record) => record.agent?.id === id)?.agent;
    },
    async create(request) {
      // The native contract: the caller supplies the identity, and the factory
      // creates the session AND the agent under it. Nothing is minted here.
      if (typeof request?.sessionId !== 'string') {
        throw new Error(`agent id "undefined" does not match session id "${String(request?.sessionId)}"`);
      }
      if (request.sessionId.trim() === '') {
        throw new Error('agents.create: sessionId must not be blank');
      }
      if (typeof request?.meta?.cwd !== 'string') {
        throw new Error('agents.create: meta.cwd is required');
      }
      const record = {
        options: request.agentOptions ?? {},
        meta: request.meta,
        sessionId: request.sessionId,
        index: created.length,
        followups: [],
        cancels: [],
        idleWaiters: [],
        idle: true,
        disposed: false,
      };
      const settle = () => {
        record.idle = true;
        for (const waiter of record.idleWaiters.splice(0)) waiter();
      };
      const agent = {
        // Entered by identity, exactly as `AgentRegistry.enter()` validates it.
        id: request.sessionId,
        session: { id: request.sessionId },
        followup(message) {
          record.followups.push(message);
          order.push('followup');
          record.idle = false;
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
      if (typeof request.setup === 'function') {
        const agentCtx = {
          on(event, listener) {
            listeners.push({ event, listener, record });
          },
          tools: {
            restrictFilters: [],
            guards: [],
            restrict(filter) {
              agentCtx.tools.restrictFilters.push(filter);
              return () => {};
            },
            guard(fn) {
              agentCtx.tools.guards.push(fn);
              return () => {};
            },
          },
        };
        record.agentCtx = agentCtx;
        await request.setup(agentCtx);
      }
      record.handle = handle;

      if (options.respond !== undefined) {
        const plan = options.respond;
        agent.followup = (message) => {
          record.followups.push(message);
          order.push('followup');
          record.idle = false;
          if (plan.reasoning !== undefined) {
            emitSessionEvent(listeners, record, { type: 'reasoning-delta', index: 0, text: plan.reasoning });
          }
          if (plan.error !== undefined) {
            emitAgentError(listeners, record, plan.error);
          }
          // Stream the answer the way the loop does: `text-delta` events, then the
          // completed `assistant/message` carrying the same text.
          if (plan.deltas !== undefined) {
            for (const [index, text] of plan.deltas.entries()) {
              emitSessionEvent(listeners, record, { type: 'text-delta', index, text });
            }
          }
          if (plan.text !== undefined) {
            emitSessionEvent(listeners, record, {
              type: 'assistant/message',
              data: {
                message: { content: [{ type: 'text', text: plan.text }] },
                ...(plan.usage === undefined ? {} : { usage: plan.usage }),
              },
            });
          }
          // A message carrying only a reasoning block: the reasoning-only response
          // that must count as activity rather than as an empty turn.
          if (plan.reasoningBlock !== undefined) {
            emitSessionEvent(listeners, record, {
              type: 'assistant/message',
              data: {
                message: { content: [{ type: 'reasoning', text: plan.reasoningBlock }] },
                ...(plan.usage === undefined ? {} : { usage: plan.usage }),
              },
            });
          }
          if (plan.extraDeltas !== undefined) {
            for (const [index, text] of plan.extraDeltas.entries()) {
              emitSessionEvent(listeners, record, { type: 'text-delta', index, text });
            }
          }
          emitSessionEvent(listeners, record, {
            type: 'turn/end',
            data: { reason: { kind: plan.reason ?? (plan.error === undefined ? 'completed' : 'error') } },
          });
          settle();
        };
      }

      if (typeof options.script === 'function') await options.script({ agent, record, listeners });
      return handle;
    },
  };
  return registry;
}

/**
 * Emit a `session/event` to the listeners registered on one agent's scope.
 * @param {object[]} listeners - listener records produced by {@link fakeAgents}.
 * @param {object} record - agent record whose listeners should fire.
 * @param {object} event - event payload.
 * @returns {void}
 */
export function emitSessionEvent(listeners, record, event) {
  for (const entry of listeners) {
    if (entry.record !== record) continue;
    if (entry.event !== 'session/event') continue;
    entry.listener({ id: record.agent?.session?.id }, event);
  }
}

/**
 * Emit an `agent/error` to the listeners registered on one agent's scope.
 * @param {object[]} listeners - listener records.
 * @param {object} record - agent record.
 * @param {unknown} error - error payload.
 * @returns {void}
 */
export function emitAgentError(listeners, record, error) {
  for (const entry of listeners) {
    if (entry.record !== record) continue;
    if (entry.event !== 'agent/error') continue;
    entry.listener({ error });
  }
}

/**
 * Build a fake `runGit` runner that answers from a scripted table.
 *
 * Commands the test does not script resolve to an empty successful result, which
 * is what an unmodified repository looks like. A scripted failure returns a
 * non-zero code so callers can prove they treat git failure as a refusal rather
 * than as "no changes".
 * @param {object} [table] - `{ 'args key': { stdout, code } }`, keyed by joined argv.
 * @returns {object} runner function with `calls` history.
 */
export function fakeGit(table = {}) {
  const calls = [];
  const runner = async (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    const entry = table[key];
    if (entry === undefined) {
      if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
      if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
      if (key === 'rev-parse --verify HEAD') return { stdout: 'a'.repeat(40) + '\n', code: 0 };
      return { stdout: '', code: 0 };
    }
    if (entry instanceof Error) throw entry;
    return { stdout: entry.stdout ?? '', code: entry.code ?? 0 };
  };
  runner.calls = calls;
  return runner;
}

/**
 * Strict fake of the native tool registry's restriction semantics.
 *
 * It mirrors `ToolRuntime` in `@deepseek-ai/dsh-tools` rather than modelling an
 * idealized filter, because the difference is the bug this fake exists to catch:
 *  - the visible surface is the INHERITED set (global plus every ancestor scope)
 *    filtered by every restriction on the chain, then unioned with what the
 *    scope's OWN layer registers;
 *  - a restriction therefore never removes a scope-local tool, exactly as
 *    `ToolRuntime.view()` documents ("a restriction filters what a scope
 *    inherits … and never what its OWN layer registers");
 *  - `restrict()` refuses an unknown GLOBAL name and refuses an unscoped call,
 *    matching the native error conditions;
 *  - `guard()` is monotonic and scope-routed: a guard registered through a
 *    scope context runs only for executions whose `agent` is that scope.
 *
 * The only addition is the supported way to widen a scope: `registerLocal`,
 * which stands in for a plugin that composes into an agent's own layer (the
 * shipped `dsh-tool-subagent` installs its delegation tool that way).
 * @param {object} [options] - `global`: names in the global layer; `parent`:
 *   names composed into the preset (ancestor) layer.
 * @returns {object} fake registry exposing `toolsFor(ctx, scope)`, `restrict`,
 *   `guard`, `schemas`, `get`, `registerLocal`, `removeLocal` and history.
 */
export function fakeToolRegistry(options = {}) {
  const globals = new Set(options.global ?? []);
  const parentNames = new Set(options.parent ?? []);
  const locals = new Map();
  const restrictions = [];
  const guards = [];
  const restrictCalls = [];
  const removeCalls = [];

  const localScopeOf = (scope) => {
    if (!locals.has(scope)) locals.set(scope, new Map());
    return locals.get(scope);
  };
  const inherited = () => new Set([...globals, ...parentNames]);
  const visible = (scope) => {
    const admitted = [...inherited()].filter((name) => restrictions.every((filter) => {
      const allow = filter.allow;
      const deny = filter.deny;
      return !((allow !== undefined && !allow.has(name)) || (deny !== undefined && deny.has(name)));
    }));
    const out = new Set(admitted);
    for (const name of locals.get(scope)?.keys() ?? []) out.add(name);
    return out;
  };

  const scopedTools = (scope) => {
    const tools = {
      schemas(target) {
        if (target !== undefined && target !== scope) throw new Error('tools.schemas() was called for another scope');
        return [...visible(scope)].sort().map((name) => ({ name, description: name, parameters: {} }));
      },
      get(name, target) {
        if (target !== undefined && target !== scope) return undefined;
        return visible(scope).has(name) ? { name } : undefined;
      },
      restrict(filter) {
        restrictCalls.push(filter);
        if (scope === undefined) {
          throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead');
        }
        const allow = filter.allow;
        const deny = filter.deny;
        if (allow === undefined && deny === undefined) {
          throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)');
        }
        const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !inherited().has(name));
        if (unknown.length > 0) {
          throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...inherited()].sort().join(', ') || '(none)'}`);
        }
        const compiled = {
          ...allow === undefined ? {} : { allow: new Set(allow) },
          ...deny === undefined ? {} : { deny: new Set(deny) },
        };
        restrictions.push(compiled);
        return () => {
          const index = restrictions.indexOf(compiled);
          if (index >= 0) restrictions.splice(index, 1);
        };
      },
      guard(fn) {
        const entry = { fn, scope };
        guards.push(entry);
        return () => {
          const index = guards.indexOf(entry);
          if (index >= 0) guards.splice(index, 1);
        };
      },
    };
    return tools;
  };

  return {
    restrictCalls,
    guards,
    restrictions,
    removeCalls,
    locals,
    /** The tools facade `agentCtx.tools` a scoped context would expose. */
    toolsFor(_ctx, scope) {
      return scopedTools(scope);
    },
    /** Advertised names for a scope, as the model would receive them. */
    advertised(scope) {
      return [...visible(scope)].sort();
    },
    /** Register a tool into one scope's own layer (a composing plugin). */
    registerLocal(scope, name) {
      localScopeOf(scope).set(name, { name, local: true });
      return () => { localScopeOf(scope).delete(name); };
    },
    /** Remove one scope-local tool, as an explicit lifecycle teardown would. */
    removeLocal(scope, name) {
      removeCalls.push(name);
      localScopeOf(scope).delete(name);
    },
    /** Evaluate every guard an execution would pass, like `guardReason()`. */
    denyReason(execution) {
      for (const entry of guards) {
        if (entry.scope !== undefined && entry.scope !== execution?.agent) continue;
        const reason = entry.fn(execution);
        if (reason !== undefined) return reason;
      }
      return undefined;
    },
    /** Whether the scope may execute a name right now (visibility and guards). */
    canExecute(scope, name) {
      if (!visible(scope).has(name)) return false;
      return this.denyReason({ name, agent: scope }) === undefined;
    },
    agentCtx(scope, extra = {}) {
      return { tools: scopedTools(scope), on() { return () => {}; }, ...extra };
    },
  };
}

/**
 * A representative valid settings document for tests.
 * @param {object} [overrides] - shallow merges for the worker/review blocks.
 * @returns {object} settings document.
 */
export function validSettings(overrides = {}) {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'relay',
      name: 'Local relay',
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:8443/v1',
      credentialRef: 'DSH_DELEGATE_RELAY_KEY',
      models: [
        { id: 'deepseek-chat', efforts: ['low', 'medium', 'high'] },
        { id: 'deepseek-reasoner', efforts: ['medium', 'high'] },
      ],
    }],
    worker: {
      providerId: 'relay',
      model: 'deepseek-chat',
      reasoningEffort: 'medium',
      timeoutSeconds: 600,
      maxParallelism: 1,
      isolation: 'shared',
      ...(overrides.worker ?? {}),
    },
    review: {
      enabled: false,
      providerId: null,
      model: null,
      reasoningEffort: null,
      ...(overrides.review ?? {}),
    },
    authorization: { taskGrantTtlSeconds: 900, sessionGrantTtlSeconds: 3600 },
    projectOverrides: overrides.projectOverrides ?? {},
  };
}

/**
 * Provider/model/effort table matching {@link validSettings}.
 * @returns {object} map for {@link fakeLlm}.
 */
export function llmTable() {
  return {
    relay: {
      'deepseek-chat': ['low', 'medium', 'high'],
      'deepseek-reasoner': ['medium', 'high'],
    },
  };
}
