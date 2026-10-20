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
 * Fake native agent registry.
 *
 * The handle exposes `agent.followup`, `agent.cancel`, `agent.whenIdle` and
 * `dispose`, matching `AgentHandle`. Each created agent records the options it
 * was given, so a test can assert the exact provider/model/effort triple that
 * reached the harness instead of trusting the plugin's own report.
 *
 * `respond` models one turn the way the agent loop does it: the turn's events are
 * emitted *when the prompt is delivered*, and only then does the agent become
 * idle. Settling on creation instead would race the runner's own idle wait and
 * hide an ordering bug.
 * @param {object} [options] - `respond` plan and optional `script(agent, record)` hook.
 * @returns {object} fake registry with `created` and `disposed` history.
 */
export function fakeAgents(options = {}) {
  const created = [];
  const disposed = [];
  const listeners = [];

  const registry = {
    created,
    disposed,
    listeners,
    async create(request) {
      if (typeof request?.sessionId !== 'string' && request?.sessionId !== undefined) {
        throw new Error('agents.create: sessionId must be a string when present');
      }
      if (typeof request?.meta?.cwd !== 'string') {
        throw new Error('agents.create: meta.cwd is required');
      }
      const record = {
        options: request.agentOptions ?? {},
        meta: request.meta,
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
        id: `agent-${created.length}`,
        session: { id: request.sessionId ?? `session-${created.length}` },
        followup(message) {
          record.followups.push(message);
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
          record.idle = false;
          if (plan.reasoning !== undefined) {
            emitSessionEvent(listeners, record, { type: 'reasoning-delta', index: 0, text: plan.reasoning });
          }
          if (plan.error !== undefined) {
            emitAgentError(listeners, record, plan.error);
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
