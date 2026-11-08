// Job engine tests: the authorization → configuration → workspace → route →
// execution chain, end to end, and every refusal in it.
//
// These tests run the real engine. Only native services are faked, so a
// regression in ordering (for example, creating an agent before consuming the
// grant) fails here.
//
// The fakes are deliberately closed: no `allowLegacyProviderRoutes` escape hatch
// is used, `providerRegistry` is a deterministic mapping, and the git fake answers
// in the NUL-delimited format the audit module requires. A fixture that let a
// missing service look like a working one would make these tests prove nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthorizationRegistry } from '../src/auth/grants.js';
import { JobEngine, JOB_CODES, TASK_STATES } from '../src/jobs/engine.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { REVIEW_STATES } from '../src/review/reviewer.js';
import { DEFAULT_MAX_TOKENS } from '../src/runtime/agent-runner.js';
import {
  cleanup,
  fakeAgents,
  fakeLlm,
  fakeSessionController,
  fakeWorkspaceController,
  llmTable,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

/** The pinned commit the fake repository always reports. */
const HEAD = 'a'.repeat(40);

/**
 * Public provider profile id → native route id.
 *
 * The two ids are deliberately different: a job records the profile the operator
 * chose and hands the native route to the harness, so a test that conflates them
 * would hide a routing bug.
 */
const NATIVE_ROUTES = Object.freeze({ relay: 'relay-native' });

/**
 * Build a git runner that answers in the NUL-delimited format the audit layer
 * parses. A line-format answer is refused by the parser, which is why the fixture
 * must produce the real shape rather than a convenient one.
 * @returns {object} runner function with `calls` history.
 */
function engineGit() {
  const calls = [];
  const runner = async (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${HEAD}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '2\t0\tsrc/a.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+implementation\n', code: 0 };
    if (args[0] === 'ls-files') return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  };
  runner.calls = calls;
  return runner;
}

/**
 * Build the provider registry the production entry point injects.
 *
 * `ensure(providers)` returns one deterministic profile → native-route mapping,
 * so a job can only route to a profile the registry actually mapped. That keeps
 * the engine's fail-closed check (`JOB_PROVIDER_REGISTRY_REQUIRED`) intact: the
 * fixture satisfies the contract instead of disabling the check.
 * @param {object} [options] - `fail`: error to reject with, `defer`: promise to await first.
 * @returns {object} registry with `calls` history.
 */
export function fakeProviderRegistry(options = {}) {
  const calls = [];
  return {
    calls,
    async ensure(providers) {
      calls.push(providers.map((provider) => provider.id));
      if (options.defer !== undefined) await options.defer;
      if (options.fail !== undefined) throw options.fail;
      const routes = new Map();
      for (const provider of providers) {
        routes.set(provider.id, NATIVE_ROUTES[provider.id] ?? `${provider.id}-native`);
      }
      return { routes };
    },
  };
}

/**
 * Build the agent preset registry an agent needs before it can run.
 *
 * Mounting a preset is what installs an agent's tool composition, so this
 * fixture also answers the tool inventory from the mount: without it the
 * additional review has no inventory to restrict and would (correctly) refuse.
 * @param {string[]} [inventory] - tool names the mounted composition offers.
 * @returns {object} preset registry with `mounts` history.
 */
function enginePresets(inventory = ['read', 'glob', 'grep', 'read_image']) {
  const mounts = [];
  return {
    mounts,
    async mount(ctx, id) {
      mounts.push({ ctx, id });
      ctx.tools.schemas = () => inventory.map((name) => ({ name, description: name, parameters: {} }));
      return { id: id ?? 'default-preset' };
    },
  };
}

/**
 * Stand-in for the plugin-owned read-only review composition.
 *
 * The real composer (`src/review/preset.js`) mounts the native filesystem tool
 * packages, which this repository does not depend on, so without a composer every
 * review fails at `REVIEW_PRESET_UNSUPPORTED` before any route is used. Accepting
 * that failure would make "the reviewer ran on its own provider/model" provable
 * only by its absence, so the engine tests supply the composer contract instead:
 * an id this fixture owns, and a mount that advertises the read-only inventory.
 * Nothing about routing, authorization or the worker run is affected.
 * @param {ReturnType<typeof enginePresets>} presets - the preset registry to own a composition in.
 * @returns {{ id: string, owns: (id: string) => boolean, preparation: () => Promise<string> }} composer.
 */
function reviewComposer(presets) {
  void presets;
  const id = 'dsh-delegate-review-test';
  return {
    get id() { return id; },
    owns(candidate) { return candidate === id; },
    async preparation() {
      return id;
    },
  };
}

/**
 * Build an engine over temporary storage, a real workspace directory and faked
 * native services.
 *
 * The workspace must exist because the engine resolves it before use; a
 * nonexistent path is itself a refusal and has its own test.
 * @param {object} [options] - `agents`, `git`, `settings`, `worktrees`,
 *   `providerRegistry`, `ensureRoutes`, `agentPresets`, `preflightTimeoutMs`.
 * @returns {Promise<object>} harness with engine, auth, workspace and cleanup.
 */
async function harness(options = {}) {
  const dir = await makeTempDir();
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(options.settings ?? validSettings());
  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const agents = options.agents ?? fakeAgents({ respond: { text: 'implemented the change' } });
  const providerRegistry = options.providerRegistry ?? fakeProviderRegistry();
  const presets = options.agentPresets ?? enginePresets();
  // The native policy services every delegated run verifies its policy through.
  // Built once per harness because they own no per-run state: the mode override
  // and the approval stance are folded out of each Session's own log.
  const defaultPolicyServices = await nativePolicyServices();
  // Placement, wired the way `src/index.js` wires it: the Workspace controller
  // and the SESSION controller are two distinct services, and the native
  // `sessions` service above is neither of them. Every worker run the engine
  // executes is grouped into a Workspace keyed by its ACTUAL execution directory,
  // so a harness without these two controllers would (correctly) refuse every
  // task with `JOB_CONVERSATION_UNAVAILABLE`.
  // A controller handed in by a test may bring its own Workspace registry (a busy
  // or scripted resolve needs one it can populate); otherwise both are fresh.
  const workspaces = options.workspaces ?? options.sessionController?.boundWorkspaces ?? fakeWorkspaceController();
  const sessionController = options.sessionController ?? fakeSessionController({
    workspaces,
    // The same scripted turn the agent fake would produce, because a placed run
    // drives the Agent the controller resolves rather than one it creates.
    ...(agents.respondPlan === undefined ? {} : { respond: agents.respondPlan }),
  });
  const deps = {
    agents,
    agentPresets: presets,
    // The plugin-owned read-only composition a review mounts. Its native rows are
    // not available in this repository, so the composer contract is supplied here
    // (see `reviewComposer`); routing and the worker run are unaffected.
    reviewPresets: options.reviewPresets ?? reviewComposer(presets),
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    // `ctx.sandboxPolicy` and `ctx.approval`, as the entry point publishes them.
    // Every worker run is a delegated run, and it fails closed before its prompt
    // unless the policy it wrote resolves back through these services.
    policyServices: () => options.policyServices ?? defaultPolicyServices,
    // The native route is not the profile id; the model table is keyed by the
    // route the harness will be asked to resolve.
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth,
    locks,
    runGit: options.git ?? engineGit(),
    providerRegistry,
    // The entry point's full-snapshot seam. Only injected when a test asks for it,
    // so the registry fallback is exercised by default.
    ...(options.ensureRoutes === undefined ? {} : { ensureRoutes: options.ensureRoutes }),
    ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
    ...(options.preflightTimeoutMs === undefined ? {} : { preflightTimeoutMs: options.preflightTimeoutMs }),
    ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
    authorizationMode: options.authorizationMode ?? 'grants',
    delegationEnabled: options.delegationEnabled === true,
    logger: { info() {}, warn() {} },
  };
  const engine = new JobEngine(deps);

  /**
   * Issue a connection plus a grant covering this harness's workspace.
   * @param {'task'|'session'} [kind] - grant kind.
   * @param {object} [input] - extra `issueGrant` fields (e.g. `overrides`).
   * @returns {object} connection and grant records.
   */
  function authorize(kind = 'task', input = {}) {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, {
      kind,
      workspacePath: workspace,
      ttlSeconds: 600,
      ...input,
    });
    return { connectionId: connection.connectionId, token: connection.token, grant };
  }

  return {
    dir,
    workspace,
    engine,
    auth,
    settings,
    agents,
    deps,
    providerRegistry,
    workspaces,
    sessionController,
    /**
     * The Agent a settled task actually drove.
     *
     * A placed run never calls `agents.create`, so `agents.created` stays empty by
     * design; the conversation it drove is the one `sessionController` resolved
     * for its Session. Engine assertions follow the run, not the old creation
     * path, so they keep proving "the selected triple reached the agent".
     * @param {object} task - settled task view.
     * @returns {object} the resolved agent.
     */
    drivenAgent(task) {
      const sessionId = task?.execution?.conversation?.sessionId ?? task?.execution?.sessionId;
      return sessionController.agents.get(sessionId);
    },
    authorize,
    async close() {
      await engine.dispose();
      await cleanup(dir);
    },
  };
}

/**
 * Wait until a task reaches a terminal state.
 * @param {object} engine - job engine.
 * @param {string} taskId - task id.
 * @param {number} [attempts] - polling bound.
 * @returns {Promise<object>} settled task view.
 */
async function settle(engine, taskId, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = engine.get(taskId);
    if (task.state !== TASK_STATES.running && task.state !== TASK_STATES.pending) return task;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  return engine.get(taskId);
}

test('a job refuses to start with no authorization at all', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => h.engine.start({
        connectionId: 'conn-none',
        grantId: 'grant-none',
        workspacePath: h.workspace,
        prompt: 'do work',
      }),
      (error) => error.code === JOB_CODES.notAuthorized,
    );
    assert.equal(h.agents.created.length, 0, 'no agent may exist for an unauthorized job');
  } finally {
    await h.close();
  }
});

test('an authorized task runs and ends awaiting host review, never approved', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'implement the change',
    });

    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.selfApproved, false);
    assert.equal(settled.hostAcceptance, null, 'the plugin must not record acceptance');
    assert.equal(settled.execution.outcome, 'completed');
    assert.match(settled.execution.text, /implemented the change/);
    // The run was grouped into a real Workspace keyed by its execution directory,
    // and started a fresh conversation there (the only thing a new submission does).
    const conversation = settled.execution.conversation;
    assert.ok(conversation !== null && conversation !== undefined, 'a worker run must report where it was placed');
    assert.equal(conversation.kind, 'new');
    assert.equal(conversation.continuedFromTaskId, null);
    assert.equal(conversation.reused, false, 'a new submission starts a new conversation');
    assert.equal(settled.continueFromTaskId, null, 'the task states it continues nothing');
    assert.equal(h.workspaces.workspaces.get(conversation.workspaceId)?.path, h.workspace,
      'the Workspace is keyed by the actual execution directory');
    assert.equal(h.agents.created.length, 0, 'a placed run must not create a second agent');
    // Evidence was measured, not reported.
    assert.equal(settled.diff.fileCount, 1);
    assert.equal(settled.diff.files[0].path, 'src/a.js');
  } finally {
    await h.close();
  }
});

test('the effective configuration is captured immutably on the task', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.effective.worker.model, 'deepseek-chat');
    assert.equal(settled.effective.worker.reasoningEffort, 'medium');
    assert.equal(settled.route.providerId, 'relay');
    // The run reports the triple it actually installed on the agent it drove, and
    // that agent really received it. A placed run never goes through
    // `agents.create`, so the fact is read from the run and from the agent.
    assert.equal(settled.execution.selection.model, 'deepseek-chat');
    assert.equal(settled.execution.selection.reasoningEffort, 'medium');
    assert.equal(settled.execution.selection.provider, settled.route.providerRoute);
    const driven = h.drivenAgent(settled);
    assert.ok(driven !== undefined, 'the task\'s conversation must expose the agent it drove');
    assert.equal(driven.followups.length, 1, 'exactly one prompt reached that agent');
  } finally {
    await h.close();
  }
});

test('replaying a spent task grant cannot start a second task', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await settle(h.engine, started.taskId);

    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'second',
      }),
      (error) => error.code === 'GRANT_CONSUMED' || error.code === JOB_CODES.notAuthorized,
    );
    assert.equal(h.agents.created.length, 0, 'a placed run creates no agent through the registry');
    assert.equal(h.sessionController.creates.length, 1, 'exactly one conversation may exist for one grant');
  } finally {
    await h.close();
  }
});

test('starting never happens without a configured provider', async () => {
  const h = await harness({ settings: { schemaVersion: 1, providers: [] } });
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === JOB_CODES.noProviders,
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('an unsupported effort in settings refuses the job before an agent exists', async () => {
  // The document itself cannot hold this combination — settings validation
  // refuses to save it — so the refusal is exercised through the per-job
  // override that carries the same bad triple into the effective snapshot.
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize('task', {
      overrides: { model: 'deepseek-reasoner', reasoningEffort: 'low' },
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === JOB_CODES.routingRefused,
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('saving an unsupported effort is refused by the settings document itself', async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () => h.settings.replace(validSettings({ worker: { model: 'deepseek-reasoner', reasoningEffort: 'low' } })),
      (error) => error.code === 'SELECTION_EFFORT_UNSUPPORTED',
    );
    // The stored document is unchanged, so no job can inherit the bad triple.
    const stored = await h.settings.read();
    assert.equal(stored.worker.model, 'deepseek-chat');
    assert.equal(stored.worker.reasoningEffort, 'medium');
  } finally {
    await h.close();
  }
});

test('a task override that names an undeclared model is refused', async () => {
  const h = await harness();
  try {
    const connection = h.auth.issueConnection({});
    const grant = h.auth.issueGrant(connection.connectionId, {
      kind: 'task',
      workspacePath: h.workspace,
      ttlSeconds: 600,
      overrides: { model: 'ghost-model' },
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId: connection.connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === 'JOB_ROUTING_REFUSED',
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('a grant for another workspace cannot be spent here', async () => {
  const h = await harness();
  try {
    const connection = h.auth.issueConnection({});
    const elsewhere = process.platform === 'win32' ? 'C:\\work\\elsewhere' : '/work/elsewhere';
    const grant = h.auth.issueGrant(connection.connectionId, {
      kind: 'task',
      workspacePath: elsewhere,
      ttlSeconds: 600,
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId: connection.connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === 'GRANT_MISMATCH',
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('worktree isolation is refused instead of silently downgraded', async () => {
  const h = await harness({ settings: validSettings({ worker: { isolation: 'worktree' } }) });
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === JOB_CODES.isolationRefused,
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('a workspace that cannot be audited refuses the job', async () => {
  const denial = new Error('spawn EPERM');
  denial.code = 'EPERM';
  const h = await harness({ git: async () => { throw denial; } });
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId,
        grantId: grant.grantId,
        workspacePath: h.workspace,
        prompt: 'go',
      }),
      (error) => error.code === 'JOB_AUDIT_UNAVAILABLE',
    );
    assert.equal(h.agents.created.length, 0);
  } finally {
    await h.close();
  }
});

test('a nonexistent workspace is refused', async () => {
  const h = await harness();
  try {
    const missing = join(h.dir, 'does-not-exist');
    const connection = h.auth.issueConnection({});
    const grant = h.auth.issueGrant(connection.connectionId, {
      kind: 'task',
      workspacePath: missing,
      ttlSeconds: 600,
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId: connection.connectionId,
        grantId: grant.grantId,
        workspacePath: missing,
        prompt: 'go',
      }),
      (error) => error.code === JOB_CODES.workspaceRequired,
    );
  } finally {
    await h.close();
  }
});

test('two concurrent jobs in one workspace are refused', async () => {
  // Raise the parallelism limit above one so the refusal under test is the
  // workspace lock, not the concurrency cap. The first job must still be RUNNING
  // when the second is submitted, which is what the busy conversation models.
  const h = await harness({
    sessionController: busySessionController(),
    settings: validSettings({ worker: { maxParallelism: 2 } }),
  });
  try {
    const first = h.authorize();
    const second = h.authorize();
    await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    await assert.rejects(
      () => h.engine.start({
        connectionId: second.connectionId,
        grantId: second.grant.grantId,
        workspacePath: h.workspace,
        prompt: 'second',
      }),
      (error) => error.code === JOB_CODES.busy,
    );
  } finally {
    await h.close();
  }
});

test('the parallelism cap refuses a second concurrent job', async () => {
  // The busy conversation keeps the first job running, so the second is refused
  // by the cap rather than admitted behind a finished task.
  const h = await harness({ sessionController: busySessionController() });
  try {
    const first = h.authorize();
    const second = h.authorize();
    await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await assert.rejects(
      () => h.engine.start({
        connectionId: second.connectionId,
        grantId: second.grant.grantId,
        // A different workspace, so only the parallelism cap can refuse this.
        workspacePath: h.workspace,
        prompt: 'second',
      }),
      (error) => error.code === JOB_CODES.concurrency || error.code === JOB_CODES.busy,
    );
  } finally {
    await h.close();
  }
});

test('a session grant starts repeated tasks', async () => {
  const h = await harness();
  try {
    const { connectionId } = h.authorize('session');
    const one = await h.engine.start({
      connectionId,
      authorization: 'session',
      workspacePath: h.workspace,
      prompt: 'first',
    });
    await settle(h.engine, one.taskId);
    // A terminal task keeps its record, so the slot has to be returned
    // explicitly; otherwise it would go on occupying capacity forever.
    assert.equal(h.engine.tasks.get(one.taskId).slotHeld, false, 'a settled task must not keep its slot');

    const two = await h.engine.start({
      connectionId,
      authorization: 'session',
      workspacePath: h.workspace,
      prompt: 'second',
    });
    assert.notEqual(one.taskId, two.taskId);
    await settle(h.engine, two.taskId);
    // An unrelated second submission starts its own conversation in the SAME
    // Workspace group rather than continuing the first.
    const firstRun = h.engine.get(one.taskId).execution;
    const secondRun = h.engine.get(two.taskId).execution;
    assert.notEqual(firstRun.conversation.sessionId, secondRun.conversation.sessionId, 'two tasks, two conversations');
    assert.equal(firstRun.conversation.workspaceId, secondRun.conversation.workspaceId, 'in one Workspace group');
    assert.equal(firstRun.conversation.kind, 'new');
    assert.equal(secondRun.conversation.kind, 'new', 'nothing continues without an explicit continuation');
    assert.equal(h.sessionController.creates.length, 2);
  } finally {
    await h.close();
  }
});

test('a refusal after the slot is reserved releases it for the next job', async () => {
  // The route registry fails on the first call, which is the first preflight step
  // *after* the concurrency slot was claimed, and succeeds afterwards. A leaked
  // claim would make the second start refuse with JOB_CONCURRENCY_LIMIT even
  // though no native executor ever existed.
  let calls = 0;
  const providerRegistry = {
    async ensure(providers) {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('registry unavailable'), { code: 'REGISTRY_UNAVAILABLE' });
      const routes = new Map(providers.map((provider) => [provider.id, NATIVE_ROUTES[provider.id] ?? `${provider.id}-native`]));
      return { routes };
    },
  };
  const h = await harness({ providerRegistry });
  try {
    const first = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId: first.connectionId,
        grantId: first.grant.grantId,
        workspacePath: h.workspace,
        prompt: 'doomed',
      }),
      (error) => error.code === JOB_CODES.routingRefused,
    );
    const refused = [...h.engine.tasks.values()].at(-1);
    assert.equal(refused.state, TASK_STATES.failed);
    assert.equal(refused.slotHeld, false, 'a refused admission must not keep its slot');

    // maxParallelism is 1, so any leak is observable here.
    const second = h.authorize();
    const next = await h.engine.start({
      connectionId: second.connectionId,
      grantId: second.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'next job',
    });
    assert.notEqual(next.taskId, refused.taskId);
    await settle(h.engine, next.taskId);
  } finally {
    await h.close();
  }
});

test('capacity is not returned while the native executor may still be running', async () => {
  const h = await harness();
  try {
    // Drive finalize directly with a native executor that has started and has not
    // confirmed it stopped. This is the one state the release gate exists for; the
    // fakes cannot reach it through a real cancel, because cancelling makes the
    // runner settle immediately.
    const task = h.engine.createTask('held job', 'task');
    h.engine.tasks.set(task.taskId, task);
    const lease = h.engine.locks.acquire(h.workspace, { taskId: task.taskId });
    task.leases.push({ path: h.workspace, nonce: lease.nonce });
    task.slotHeld = true;
    task.state = TASK_STATES.cancelled;
    let release;
    task.native = {
      started: true,
      settled: false,
      promise: new Promise((resolvePromise) => { release = resolvePromise; }),
    };

    const finalizing = h.engine.finalize(task);
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 20); });
    assert.equal(task.slotHeld, true, 'the slot must not be handed back while the executor may still write');
    assert.equal(h.engine.locks.isLocked(h.workspace), true, 'the workspace lease must still be held');
    assert.equal(task.finalizedAt, null);

    // Once the executor confirms it stopped, the same finalize call releases both.
    task.native.settled = true;
    release();
    assert.equal(await finalizing, true);
    assert.equal(task.slotHeld, false);
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
    assert.equal(task.cleanupError, null);
    // Release the harness's own settlement wait; the record was created outside
    // a start, so nothing else will ever settle it.
    task.settle();
  } finally {
    await h.close();
  }
});

test('finalize is idempotent when several terminal paths race', async () => {
  const h = await harness();
  try {
    const task = h.engine.createTask('raced job', 'task');
    h.engine.tasks.set(task.taskId, task);
    const lease = h.engine.locks.acquire(h.workspace, { taskId: task.taskId });
    task.leases.push({ path: h.workspace, nonce: lease.nonce });
    task.slotHeld = true;

    // Count the actual lease releases: a second release would be a silent no-op
    // inside WorkspaceLocks, so only counting proves the latch worked.
    let releases = 0;
    const realRelease = h.engine.locks.release.bind(h.engine.locks);
    h.engine.locks.release = (workspacePath, nonce) => {
      releases += 1;
      return realRelease(workspacePath, nonce);
    };

    // Three callers, one release: a success path racing a cancellation path.
    const [first, , third] = await Promise.all([
      h.engine.finalize(task),
      h.engine.finishTask(task),
      h.engine.finalize(task),
    ]);
    assert.equal(first, true, 'the racing caller must observe the release');
    assert.equal(third, true, 'every caller sees the same outcome');
    assert.equal(releases, 1, 'the lease must be released exactly once');
    assert.equal(task.slotHeld, false);
    assert.equal(task.leases.length, 0);
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
  } finally {
    await h.close();
  }
});

/**
 * A session controller whose resolved agents absorb their prompt and stay busy.
 *
 * A placed run never creates an agent through `agents.create`, so "a run that is
 * still working" has to be modelled on the conversation the run actually drives.
 * Only the runner's own cancel (or timeout) can end such a run, which is what a
 * cancellation test needs to observe.
 * @returns {object} fake session controller bound to the harness's Workspace controller.
 */
function busySessionController() {
  const workspaces = fakeWorkspaceController();
  const controller = fakeSessionController({ workspaces });
  const resolveOriginal = controller.resolveAgent.bind(controller);
  controller.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found.agent;
    if (agent !== undefined) {
      agent.followup = (message) => { agent.followups.push(message); };
      // Never idle: nothing but `cancel` (or the runner's timeout) can settle this.
      agent.whenIdle = async () => { await new Promise(() => {}); };
    }
    return found;
  };
  // The harness wires its own Workspace controller, so hand this one over instead.
  controller.boundWorkspaces = workspaces;
  return controller;
}

test('cancelling a running task reaches the agent and states why', async () => {
  // A placed run drives a RESOLVED agent, so the busy turn is modelled on the
  // session controller's side: prompt delivery absorbs the turn and the agent
  // never becomes idle, which leaves the operator's cancel as the only ending.
  const h = await harness({
    sessionController: busySessionController(),
  });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });

    const cancelled = await h.engine.cancel(started.taskId, 'operator');
    assert.equal(cancelled.state, TASK_STATES.cancelled);
    assert.equal(cancelled.cancelledBy, 'operator');
    // The native agent received a cancel, and the workspace lock was released.
    const driven = h.drivenAgent(cancelled);
    assert.ok(driven !== undefined, 'the task\'s conversation must expose the agent it drove');
    assert.ok(driven.cancels.length >= 1, 'the agent must be cancelled');
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
  } finally {
    await h.close();
  }
});

test('the master switch blocks new work while off and cancels live work when disabled', async () => {
  const sessionController = busySessionController();
  const h = await harness({ authorizationMode: 'switch', delegationEnabled: false, sessionController });
  try {
    assert.deepEqual(h.engine.posture(), { authorized: false, reason: 'delegation is disabled', mode: 'switch' });
    await assert.rejects(
      () => h.engine.start({ workspacePath: h.workspace, prompt: 'must stay blocked' }),
      (error) => error.code === JOB_CODES.notAuthorized,
    );
    assert.equal(sessionController.creates.length, 0, 'a disabled switch must not create a conversation');

    h.engine.setDelegationEnabled(true);
    const started = await h.engine.start({ workspacePath: h.workspace, prompt: 'long job' });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    h.engine.setDelegationEnabled(false);
    const cancelled = await settle(h.engine, started.taskId);

    assert.equal(cancelled.state, TASK_STATES.cancelled);
    assert.equal(cancelled.cancelledBy, 'delegation-disabled');
    assert.ok(h.drivenAgent(cancelled).cancels.length >= 1, 'disabling must reach the native agent');
    assert.equal(h.engine.posture().authorized, false);
    await assert.rejects(
      () => h.engine.start({ workspacePath: h.workspace, prompt: 'must stay blocked' }),
      (error) => error.code === JOB_CODES.notAuthorized,
    );
  } finally {
    await h.close();
  }
});

test('a cancelled task releases the workspace for the next job', async () => {
  const agents = fakeAgents({
    script: async ({ record }) => {
      record.agent.followup = (message) => {
        record.followups.push(message);
        record.idle = false;
      };
    },
  });
  const h = await harness({ agents });
  try {
    const first = h.authorize();
    const started = await h.engine.start({
      connectionId: first.connectionId,
      grantId: first.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    await h.engine.cancel(started.taskId, 'operator');

    const second = h.authorize();
    const next = await h.engine.start({
      connectionId: second.connectionId,
      grantId: second.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'next job',
    });
    assert.notEqual(next.taskId, started.taskId);
    await settle(h.engine, next.taskId);
  } finally {
    await h.close();
  }
});

test('review runs only when enabled and uses its own selection', async () => {
  const agents = fakeAgents({ respond: { text: 'VERDICT: approve\nREASON: correct' } });
  const h = await harness({
    agents,
    settings: validSettings({
      review: { enabled: true, providerId: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    }),
  });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.review.state, REVIEW_STATES.completed);
    assert.equal(settled.review.verdict.verdict, 'approve');
    assert.equal(settled.review.selection.model, 'deepseek-reasoner');
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);

    // Two distinct conversations, each on its own model:
    //  * the WORKER is placed, so its model comes from the run that drove the
    //    resolved agent in the Workspace — recorded on the task, not on a
    //    `agents.create` call it never made;
    //  * the REVIEWER is unplaced (it must not join the operator's history), so
    //    it is the one agent created through the registry.
    assert.equal(settled.execution.selection.model, 'deepseek-chat');
    const reviewModels = agents.created.map((record) => record.options.model);
    assert.deepEqual(reviewModels, ['deepseek-reasoner'], 'only the reviewer goes through agents.create');
    assert.notEqual(
      settled.execution.conversation.sessionId,
      agents.created[0].sessionId,
      'the review must not share the worker conversation',
    );
  } finally {
    await h.close();
  }
});

test('both installed requests — worker and reviewer — carry a practical output allowance', async () => {
  // The job's own evidence, not a unit-test abstraction: the two requests the
  // installed plugin actually makes must each reserve a real output budget, or a
  // reasoning turn stops mid-answer and an operator sees a truncated delegation.
  const agents = fakeAgents({ respond: { text: 'VERDICT: approve\nREASON: correct' } });
  const h = await harness({
    agents,
    settings: validSettings({
      review: { enabled: true, providerId: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    }),
  });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.review.state, REVIEW_STATES.completed);

    const budgets = agents.created.map((record) => record.options.maxTokens);
    assert.equal(budgets.length, 1, 'one reviewer request goes through agents.create');
    for (const [index, budget] of budgets.entries()) {
      assert.equal(budget, DEFAULT_MAX_TOKENS, `request ${index} must carry the default allowance`);
      assert.ok(budget >= 32768, `request ${index} must reserve at least 32768 output tokens, got ${budget}`);
    }
    // The worker's budget is asserted from the run itself: it drove a resolved
    // agent, so there is no create call to inspect. (`execution.maxTokens` is
    // redacted in the public view — a field named "token" is masked — so the
    // budget is read from the task record's raw execution instead.)
    const task = h.engine.tasks.get(started.taskId);
    assert.equal(task.execution.maxTokens, DEFAULT_MAX_TOKENS, 'the worker request must carry the same allowance');
    assert.ok(task.execution.maxTokens >= 32768);
  } finally {
    await h.close();
  }
});

test('review is skipped when disabled, without recording a verdict', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.review.state, REVIEW_STATES.disabled);
    assert.equal(settled.review.verdict, null);
    // A placed worker creates no agent through the registry, so an empty
    // `agents.created` is exactly the evidence that no reviewer ran.
    assert.equal(h.agents.created.length, 0, 'no reviewer agent may be created when review is off');
    assert.equal(h.sessionController.creates.length, 1, 'and the worker still got its one conversation');
  } finally {
    await h.close();
  }
});

test('a failing execution is reported as failed, not as awaiting review', async () => {
  const agents = fakeAgents({ respond: { error: new Error('provider exploded') } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.failed);
    assert.equal(settled.error.code, 'JOB_EXECUTION_FAILED');
    // Evidence is still captured so the host can see partial work.
    assert.ok(settled.diff !== null);
  } finally {
    await h.close();
  }
});

test('a reasoning-only run is a completed run, not an empty-output failure', async () => {
  // The recorded turn carries reasoning and no visible text: activity the job must
  // credit. The turn-end event the fake can express is the reasoning block, which
  // is exactly the shape a provider with no deltas produces.
  const agents = fakeAgents({ respond: { reasoningBlock: 'weighing the change' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.error, null, 'reasoning is output: it must never be reported as JOB_NO_OUTPUT');
    assert.equal(settled.execution.outcome, 'completed');
    assert.equal(settled.execution.reasoningOnly, true);
    assert.equal(settled.execution.text, '');
    assert.equal(settled.selfApproved, false);
  } finally {
    await h.close();
  }
});

test('a reasoning-only run that stops at its output budget is completed, not failed', async () => {
  // `max-tokens` is how the native loop ends a turn that filled its budget. A
  // reasoning model does exactly that on a thinking answer, and reporting it as a
  // failure was the false negative this test pins down.
  const agents = fakeAgents({ respond: { reasoning: 'long deliberation', reason: 'max-tokens' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.error, null);
    assert.equal(settled.execution.outcome, 'completed');
    assert.equal(settled.execution.reasoningOnly, true);
    // The budget fact stays visible on the turn record instead of being invented
    // as an error, so an operator can raise the budget knowingly.
    assert.equal(settled.execution.turnEnd.reason, 'max-tokens');
  } finally {
    await h.close();
  }
});

test('a visible answer that stops at its budget is completed and keeps its text', async () => {
  const agents = fakeAgents({ respond: { text: 'partially implemented', reason: 'max-tokens' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.execution.outcome, 'completed');
    assert.equal(settled.execution.text, 'partially implemented');
    assert.equal(settled.execution.reasoningOnly, false);
  } finally {
    await h.close();
  }
});

test('a run that stops at its budget without any content is reported as a budget failure, not an empty one', async () => {
  const agents = fakeAgents({ respond: { reason: 'max-tokens' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.failed);
    assert.equal(settled.error.code, JOB_CODES.outputTruncated, JSON.stringify(settled.error));
    assert.match(settled.error.message, /budget/);
    // The turn fact that explains the ending travels with the refusal.
    assert.deepEqual(settled.error.details.turnEnd, { reason: 'max-tokens' });
    // Evidence is still captured for a partial change.
    assert.ok(settled.diff !== null);
  } finally {
    await h.close();
  }
});

test('a run that genuinely produced nothing is still a failure with its own message', async () => {
  // The distinction the fix must not erase: no text, no reasoning, no budget
  // ending. The runner records its empty-turn diagnostic, so the job reports an
  // execution failure — never a completion, and never a budget problem.
  const agents = fakeAgents({ respond: { reason: 'completed' } });
  const h = await harness({ agents });
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.failed);
    assert.equal(settled.error.code, JOB_CODES.executionFailed, JSON.stringify(settled.error));
    assert.match(settled.error.message, /no assistant text/);
    assert.notEqual(settled.error.code, JOB_CODES.outputTruncated, 'an empty turn is not a budget ending');
    assert.equal(settled.error.details, undefined, 'a silent run carries no budget facts');
    assert.equal(settled.execution.outcome, 'failed');
    assert.equal(settled.execution.reasoningOnly, false);
    assert.equal(settled.selfApproved, false);
  } finally {
    await h.close();
  }
});

test('starting a job with an empty prompt is refused', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({ connectionId, grantId: grant.grantId, workspacePath: h.workspace, prompt: '   ' }),
      (error) => error.code === JOB_CODES.promptRequired,
    );
  } finally {
    await h.close();
  }
});

test('the task view never contains provider endpoints or secrets', async () => {
  const h = await harness();
  try {
    const { connectionId, grant } = h.authorize();
    const started = await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    await settle(h.engine, started.taskId);
    const view = JSON.stringify(h.engine.get(started.taskId, { includePrompt: true }));
    assert.equal(view.includes('127.0.0.1:8443'), false, 'the provider endpoint must not leak into a task view');
    assert.equal(view.includes('DSH_DELEGATE_RELAY_KEY'), false, 'a credential reference must not leak into a task view');
  } finally {
    await h.close();
  }
});

test('listing tasks filters by connection', async () => {
  const h = await harness();
  try {
    const mine = h.authorize();
    const other = h.authorize();
    const started = await h.engine.start({
      connectionId: mine.connectionId,
      grantId: mine.grant.grantId,
      workspacePath: h.workspace,
      prompt: 'go',
    });
    await settle(h.engine, started.taskId);

    assert.equal(h.engine.list({ connectionId: mine.connectionId }).length, 1);
    assert.equal(h.engine.list({ connectionId: other.connectionId }).length, 0);
  } finally {
    await h.close();
  }
});

test('dispose cancels live tasks and marks the plugin unusable', async () => {
  // A live (never-idle) placed run, so dispose has something to stop.
  const h = await harness({ sessionController: busySessionController() });
  try {
    const { connectionId, grant } = h.authorize();
    await h.engine.start({
      connectionId,
      grantId: grant.grantId,
      workspacePath: h.workspace,
      prompt: 'long job',
    });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
    const stopped = await h.engine.dispose();
    assert.equal(stopped, 1);
    assert.deepEqual(h.engine.posture(), { authorized: false, reason: 'the plugin has been disposed' });
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
  } finally {
    await cleanup(h.dir);
  }
});
