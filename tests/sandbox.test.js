// Delegated sandbox policy: the worker Session must be WRITABLE in its own
// workspace and must never wait for a host approval this plugin cannot answer.
//
// The defect this file pins down is a policy that looks installed. The previous
// implementation appended `sandbox/mode` and `approval/policy` to the Session log
// and reported the worker as confined without ever asking the two services that
// own those events what they resolve to. On a harness where the services were
// absent, refused, or folded a different value, the run still drove a prompt — so
// "protected" was stated by the writer instead of proved by a reader.
//
// Every test below therefore asserts against the NATIVE services
// (`@deepseek-ai/dsh-sandbox-policy`, `@deepseek-ai/dsh-user-approval`) reading
// the log back, and the refusal tests assert that no prompt was delivered at all.
// Nothing here touches the network: the services are the installed ones, the
// Sessions are the installed `Session` or the faithful fake, and the turn is a
// scripted fake.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { ApprovalService } from '@deepseek-ai/dsh-user-approval';

import {
  DELEGATE_APPROVAL_POLICY,
  DELEGATE_SANDBOX_MODE,
  SANDBOX_CODES,
  SandboxPolicyError,
  configureDelegatedSession,
} from '../src/runtime/sandbox.js';
import { RUN_CODES, RunError, runAgent } from '../src/runtime/agent-runner.js';
import { JobEngine } from '../src/jobs/engine.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import {
  cleanup,
  fakeAgentPresets,
  fakeAgents,
  fakeLlm,
  fakeSession,
  fakeSessionController,
  fakeWorkspaceController,
  llmTable,
  makeTempDir,
  nativePolicyServices,
  policyServicesFor,
  validSettings,
} from './helpers/fakes.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\delegated' : '/work/delegated';
const SELECTION = { providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' };
const MESSAGES = Object.freeze({
  noPolicyService: 'the DSH sandbox policy service is unavailable, so the worker could not be confined',
  noApprovalService: 'the DSH approval service is unavailable, so the worker\'s approval stance could not be established',
});

/**
 * A real native Session, created detached with the header the placement validated.
 *
 * The installed `Session.create` is used rather than a fake wherever the point of
 * the test is that the native services read the native log.
 * @param {string} [id] - session identity.
 * @param {string} [cwd] - the session header cwd.
 * @returns {object} native Session.
 */
function nativeSession(id = 'session-native-1', cwd = CWD) {
  const sessionId = SessionId(id);
  return Session.create(sessionId, [], {
    version: 4,
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
  });
}

/**
 * The dependency set a delegated run needs, with the native policy services.
 *
 * `policyServices` is the live accessor the entry point publishes, so a run
 * reads the services per call exactly as production does.
 * @param {object} agents - fake agent registry.
 * @param {object} services - `{ sandboxPolicy, approval }`.
 * @param {object} [options] - `presets`, `placement`.
 * @returns {object} dependency object.
 */
function depsFor(agents, services, options = {}) {
  const workspaces = options.placement?.workspaces ?? fakeWorkspaceController();
  const sessionController = options.placement?.sessionController
    ?? fakeSessionController({ workspaces, ...(agents.respondPlan === undefined ? {} : { respond: agents.respondPlan }) });
  return {
    agents,
    agentPresets: options.presets ?? fakeAgentPresets(),
    workspaces,
    sessionController,
    policyServices: () => (typeof services === 'function' ? services() : services),
    testControllers: { workspaces, sessionController },
  };
}

/**
 * Run one delegated (worker) run.
 * @param {object} deps - dependency object.
 * @param {object} [extra] - extra request fields.
 * @returns {Promise<object>} run result.
 */
async function delegatedRun(deps, extra = {}) {
  return await runAgent(deps, {
    prompt: 'do the delegated thing',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    delegated: true,
    ...extra,
  });
}

/**
 * The policy events one Session log carries, in order.
 * @param {object} session - native or fake Session.
 * @returns {object[]} the `sandbox/mode` and `approval/policy` events.
 */
function policyEventsOf(session) {
  const events = [];
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (event?.type === 'sandbox/mode' || event?.type === 'approval/policy') events.push(event);
  }
  return events;
}

// --- The policy itself, against the installed services ------------------------

test('the delegated policy resolves back through the native services it writes', async () => {
  const services = await nativePolicyServices();
  const session = nativeSession();
  const applied = configureDelegatedSession({ session }, services);

  assert.equal(applied.mode, DELEGATE_SANDBOX_MODE);
  assert.equal(applied.approvalPolicy, DELEGATE_APPROVAL_POLICY);
  assert.equal(applied.workspaceRoot, CWD, 'the workspace root is the session\'s own directory');

  // Read back through the SAME calls enforcement uses, not through the log.
  assert.equal(services.sandboxPolicy.resolve({ session }).mode, 'workspace-write');
  assert.equal(services.sandboxPolicy.resolve({ session }).workspaceRoot, CWD);
  assert.equal(services.approval.effectivePolicy(session), 'never');

  // The deployment default of the fake service is `read-only`, so a resolved
  // `workspace-write` can only come from the event this policy wrote.
  assert.equal(services.sandboxPolicy.defaultMode, 'read-only');

  const events = policyEventsOf(session);
  assert.deepEqual(events.map((event) => event.type), ['sandbox/mode', 'approval/policy']);
  assert.deepEqual(events[0].data, { mode: 'workspace-write' });
  assert.deepEqual(events[1].data, { policy: 'never' });
});

test('a delegated session is refused when either policy service is missing', async () => {
  const services = await nativePolicyServices();

  await assert.rejects(
    async () => configureDelegatedSession({ session: nativeSession() }, { approval: services.approval }),
    (error) => {
      assert.ok(error instanceof SandboxPolicyError);
      assert.equal(error.code, SANDBOX_CODES.unavailable);
      assert.equal(error.details.reason, 'sandbox policy service unavailable');
      assert.match(error.message, /sandbox policy service is unavailable/);
      return true;
    },
  );

  await assert.rejects(
    async () => configureDelegatedSession({ session: nativeSession() }, { sandboxPolicy: services.sandboxPolicy }),
    (error) => {
      assert.ok(error instanceof SandboxPolicyError);
      assert.equal(error.code, SANDBOX_CODES.unavailable);
      assert.equal(error.details.reason, 'approval service unavailable');
      return true;
    },
  );

  // Neither refusal wrote anything: capability is checked before the log changes.
  const session = nativeSession();
  await assert.rejects(
    async () => configureDelegatedSession({ session }, { sandboxPolicy: services.sandboxPolicy }),
  );
  // The installed `Session.create` stamps one format marker before the caller's
  // log starts, so the assertion is about POLICY events, not the raw log length.
  assert.deepEqual(policyEventsOf(session), [], 'a session with no approval service must not be given half a policy');
});

test('a refused session cannot be given a policy at all', async () => {
  const services = await nativePolicyServices();
  await assert.rejects(
    async () => configureDelegatedSession({ session: { append: 'not a function' } }, services),
    (error) => {
      assert.equal(error.code, SANDBOX_CODES.unavailable);
      assert.equal(error.details.reason, 'session.append unavailable');
      return true;
    },
  );
  await assert.rejects(
    async () => configureDelegatedSession(null, services),
    (error) => error instanceof SandboxPolicyError && error.code === SANDBOX_CODES.unavailable,
  );
});

test('a service that refuses to answer is a refusal, not a silent success', async () => {
  const services = await nativePolicyServices();
  const session = nativeSession();

  const throwingSandbox = {
    resolve() { throw new Error('projection registry unavailable'); },
  };
  await assert.rejects(
    async () => configureDelegatedSession({ session }, { ...services, sandboxPolicy: throwingSandbox }),
    (error) => {
      assert.equal(error.code, SANDBOX_CODES.unavailable);
      assert.equal(error.details.reason, 'sandbox policy could not be read back');
      return true;
    },
  );

  const throwingApproval = {
    effectivePolicy() { throw new Error('approval config unreadable'); },
  };
  await assert.rejects(
    async () => configureDelegatedSession({ session }, { ...services, approval: throwingApproval }),
    (error) => {
      assert.equal(error.code, SANDBOX_CODES.unavailable);
      assert.equal(error.details.reason, 'approval policy could not be read back');
      return true;
    },
  );

  // A service that answers nothing usable is equally a refusal.
  await assert.rejects(
    async () => configureDelegatedSession({ session }, { ...services, sandboxPolicy: { resolve() { return null; } } }),
    (error) => error.details.reason === 'sandbox policy could not be read back',
  );
});

test('a policy that does not read back as written is refused', async () => {
  const services = await nativePolicyServices();

  // A service that answers a different mode (a stale fold, a replaced deployment
  // default, an override this policy did not write).
  const staleMode = { resolve: () => ({ mode: 'read-only', workspaceRoot: CWD }) };
  await assert.rejects(
    async () => configureDelegatedSession({ session: nativeSession() }, { ...services, sandboxPolicy: staleMode }),
    (error) => {
      assert.equal(error.code, SANDBOX_CODES.unavailable);
      assert.equal(error.details.reason, 'sandbox policy read back disagrees');
      assert.equal(error.details.expected, 'workspace-write');
      assert.equal(error.details.observed, 'read-only');
      return true;
    },
  );

  // A root that is not this session's directory: the confinement would cover
  // another workspace than the one the run writes to.
  const otherRoot = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: `${CWD}-elsewhere` }) };
  await assert.rejects(
    async () => configureDelegatedSession({ session: nativeSession() }, { ...services, sandboxPolicy: otherRoot }),
    (error) => {
      assert.equal(error.code, SANDBOX_CODES.unavailable);
      assert.equal(error.details.reason, 'sandbox policy read back disagrees');
      return true;
    },
  );

  // A missing root for a `workspace-write` session writes nowhere.
  const noRoot = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '' }) };
  await assert.rejects(
    async () => configureDelegatedSession({ session: nativeSession() }, { ...services, sandboxPolicy: noRoot }),
    (error) => error.details.reason === 'sandbox policy read back disagrees',
  );

  // An approval stance that does not fold to `never` would let the worker wait on
  // an approval prompt this plugin cannot answer.
  const asker = { effectivePolicy: () => 'ask' };
  await assert.rejects(
    async () => configureDelegatedSession({ session: nativeSession() }, { ...services, approval: asker }),
    (error) => {
      assert.equal(error.code, SANDBOX_CODES.unavailable);
      assert.equal(error.details.reason, 'approval policy read back disagrees');
      assert.equal(error.details.expected, 'never');
      return true;
    },
  );
});

test('a workspace root that is the same directory in another spelling is accepted', async () => {
  // The comparison is `sameSessionPath`, shared with session placement, so one
  // directory written two ways is one directory here too: a trailing separator, the
  // other separator character, and (on Windows, where NTFS is case-insensitive) a
  // different letter case. None of these may be reported as "another workspace".
  const services = await nativePolicyServices();
  const spellings = [
    `${CWD}/`,
    `${CWD}${CWD.includes('\\') ? '/' : '\\'}`,
    process.platform === 'win32' ? CWD.toUpperCase() : CWD,
  ];
  for (const spelling of spellings) {
    const alias = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: spelling }) };
    const applied = configureDelegatedSession({ session: nativeSession() }, { ...services, sandboxPolicy: alias });
    assert.equal(applied.workspaceRoot, spelling, `the resolved root is reported as the service returned it: ${spelling}`);
  }
});

test('a genuinely different workspace root is still refused', async () => {
  // The alias tolerance above must not widen the check: a directory that only shares
  // a prefix, or that differs in a path segment, is a different workspace.
  const services = await nativePolicyServices();
  const separator = CWD.includes('\\') ? '\\' : '/';
  for (const other of [`${CWD}${separator}elsewhere`, `${CWD}-elsewhere`]) {
    const different = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: other }) };
    await assert.rejects(
      async () => configureDelegatedSession({ session: nativeSession() }, { ...services, sandboxPolicy: different }),
      (error) => {
        assert.equal(error.code, SANDBOX_CODES.unavailable);
        assert.equal(error.details.reason, 'sandbox policy read back disagrees');
        return true;
      },
      `${other} must not be accepted as ${CWD}`,
    );
  }
});

test('the installed approval service rejects an escalation immediately under never', async () => {
  // The native behaviour the delegate stance relies on: with `never` in effect,
  // `decide()` returns `rejected` WITHOUT dispatching through the answerer
  // waterfall, so no host prompt is ever produced and no network is involved.
  const { Context } = await import('@deepseek-ai/cordis');
  const { sandboxPolicy } = await nativePolicyServices();
  const ctx = new Context();
  // A waterfall that would be reached by any interactive ask. Under `never` it
  // must never be consulted — that is exactly what "no approval wait" means.
  ctx.waterfall = () => { throw new Error('the approval answerer waterfall must not be reached under never'); };
  const approval = new ApprovalService(ctx, { policy: 'ask' });
  const session = nativeSession('session-approval-1');
  assert.equal(approval.effectivePolicy(session), 'ask', 'the deployment default is interactive');

  configureDelegatedSession({ session }, { sandboxPolicy, approval });
  assert.equal(approval.effectivePolicy(session), 'never');

  // The decision is the native one, on the policy alone: an escalation is
  // rejected without consulting any answerer.
  const decided = await approval.decide({ agent: { session }, toolName: 'bash', signal: undefined }, session);
  assert.equal(decided, 'rejected');
});

// --- Before the prompt: the new-session path ---------------------------------

test('a delegated unplaced run writes the policy and verifies it before prompting', async () => {
  // The unplaced path is the one that CREATES its own agent, so the policy is
  // installed inside `agents.create`'s setup — before the handle is published and
  // therefore before any prompt can be delivered.
  const services = await policyServicesFor();
  const agents = fakeAgents({ respond: { text: 'done' } });
  const deps = depsFor(agents, services);

  const result = await delegatedRun(deps, { allowUnplaced: true });

  assert.equal(result.outcome, 'completed');
  assert.equal(agents.created.length, 1, 'the unplaced delegated path creates its own agent');
  const agent = agents.created[0].agent;

  // The policy is in the Session log and reads back through the native services.
  assert.deepEqual(policyEventsOf(agent.session).map((event) => event.type), ['sandbox/mode', 'approval/policy']);
  assert.equal(services.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write');
  assert.equal(services.approval.effectivePolicy(agent.session), 'never');
  assert.equal(agents.created[0].followups.length, 1, 'exactly one prompt was delivered');

  // The two policy events precede the delivery in the SAME log the prompt is
  // recorded in: setup writes them before the handle exists, and `followup` is
  // called only after it does. Asserting the log order is what makes "before the
  // prompt" a fact rather than an inference from two separate counters.
  const types = agent.session.log.map((event) => event.type);
  assert.deepEqual(types.slice(0, 2), ['sandbox/mode', 'approval/policy']);
});

test('a delegated run whose policy cannot be verified delivers no prompt', async () => {
  const cases = [
    {
      name: 'sandbox policy service missing',
      services: await policyServicesFor({ missing: 'sandboxPolicy' }),
      message: MESSAGES.noPolicyService,
    },
    {
      name: 'approval service missing',
      services: await policyServicesFor({ missing: 'approval' }),
      message: MESSAGES.noApprovalService,
    },
    {
      name: 'sandbox policy resolution throws',
      services: await policyServicesFor({
        broken: { sandboxPolicy: { resolve() { throw Object.assign(new Error('denied'), { code: 'DENIED' }); } } },
      }),
      message: 'the DSH sandbox policy could not be resolved for this session, so the worker was not started',
    },
    {
      name: 'approval policy does not fold to never',
      services: await policyServicesFor({ broken: { approval: { effectivePolicy: () => 'ask' } } }),
      message: 'the DSH approval policy does not resolve as installed, so the worker was not started',
    },
  ];

  for (const testCase of cases) {
    const agents = fakeAgents({ respond: { text: 'must not be delivered' } });
    await assert.rejects(
      async () => delegatedRun(depsFor(agents, testCase.services), { allowUnplaced: true }),
      (error) => {
        assert.ok(error instanceof RunError, `${testCase.name}: expected a run refusal`);
        assert.equal(error.code, RUN_CODES.sandboxPolicyUnavailable, testCase.name);
        assert.equal(error.message, testCase.message, testCase.name);
        return true;
      },
      testCase.name,
    );

    // Fail closed: the turn was never delivered. The agent's own disposal is not
    // observable here for the FIRST case only because the policy services are
    // checked before `agents.create` even reaches `setup` — a run refused there
    // never publishes a handle at all, which is a stronger fail-closed result.
    if (agents.created.length > 0) {
      assert.equal(agents.created[0].followups.length, 0, `${testCase.name}: no prompt may be delivered`);
    }
  }
});

test('a request with no policy accessor is refused instead of trusted', async () => {
  // The accessor is the only way the runner can read the policy back. A caller
  // that supplies none gets the same refusal as a missing service: an
  // unverifiable policy is indistinguishable from no policy.
  const agents = fakeAgents({ respond: { text: 'must not be delivered' } });
  const deps = depsFor(agents, await policyServicesFor());
  delete deps.policyServices;

  await assert.rejects(
    async () => delegatedRun(deps, { allowUnplaced: true }),
    (error) => {
      assert.equal(error.code, RUN_CODES.sandboxPolicyUnavailable);
      assert.equal(error.message, MESSAGES.noPolicyService);
      return true;
    },
  );
  assert.equal(agents.created[0].followups.length, 0, 'no prompt may be delivered');
});

test('a non-delegated run is not given a sandbox policy at all', async () => {
  // The read-only review drives an unplaced run of its own. It must not be put
  // into a worker sandbox, and it must not be refused for lacking the policy
  // services either.
  const agents = fakeAgents({ respond: { text: 'reviewed' } });
  const deps = depsFor(agents, await policyServicesFor({ missing: 'sandboxPolicy' }));
  delete deps.policyServices;

  const result = await runAgent(deps, {
    prompt: 'review this',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });

  assert.equal(result.outcome, 'completed');
  const session = agents.created[0].agent.session;
  assert.equal(policyEventsOf(session).length, 0, 'an ordinary session carries no delegate policy');

  // Its stance is whatever the deployment configures, not the delegate stance:
  // read back through the native service the review's own harness would use.
  const { approval } = await policyServicesFor();
  assert.equal(approval.effectivePolicy(session), 'ask', 'an ordinary session keeps the configured stance');
});

// --- Before the prompt: the placed and continued paths -----------------------

test('a placed delegated run verifies the policy on the resolved session before prompting', async () => {
  const services = await policyServicesFor();
  const agents = fakeAgents({ respond: { text: 'placed' } });
  const deps = depsFor(agents, services);

  const result = await delegatedRun(deps);

  assert.equal(result.outcome, 'completed');
  assert.equal(agents.created.length, 0, 'a placed run drives the resolved agent');
  const agent = deps.testControllers.sessionController.agents.get(result.conversation.sessionId);
  assert.ok(agent !== undefined);

  // The policy landed on the RESOLVED session, in the run's own workspace.
  assert.equal(services.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write');
  assert.equal(services.approval.effectivePolicy(agent.session), 'never');
  assert.equal(agent.followups.length, 1);
  assert.deepEqual(
    policyEventsOf(agent.session).map((event) => event.type),
    ['sandbox/mode', 'approval/policy'],
    'both policy events were written to the placed session',
  );
});

test('a placed delegated run writes its events BEFORE the prompt is delivered', async () => {
  const services = await policyServicesFor();
  const agents = fakeAgents({ respond: { text: 'placed' } });
  const deps = depsFor(agents, services);
  // Wrap the resolved agent's followup so the policy state at prompt time is
  // recorded from the session log itself, not from a report.
  const controller = deps.testControllers.sessionController;
  const resolve = controller.resolveAgent.bind(controller);
  const seen = [];
  controller.resolveAgent = async (sessionId) => {
    const found = await resolve(sessionId);
    const agent = found.agent;
    if (agent === undefined) return found;
    const followup = agent.followup.bind(agent);
    agent.followup = (message) => {
      seen.push({
        modes: policyEventsOf(agent.session).map((event) => event.type),
        mode: services.sandboxPolicy.resolve({ session: agent.session }).mode,
        stance: services.approval.effectivePolicy(agent.session),
      });
      followup(message);
    };
    return found;
  };

  const result = await delegatedRun(deps);
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(seen, [{
    modes: ['sandbox/mode', 'approval/policy'],
    mode: 'workspace-write',
    stance: 'never',
  }], 'the policy was in force at the moment the prompt was delivered');
});

test('a placed delegated run with no verifiable policy delivers no prompt', async () => {
  const agents = fakeAgents({ respond: { text: 'must not be delivered' } });
  const deps = depsFor(agents, await policyServicesFor({ missing: 'approval' }));

  await assert.rejects(
    async () => delegatedRun(deps),
    (error) => {
      assert.equal(error.code, RUN_CODES.sandboxPolicyUnavailable);
      assert.equal(error.message, MESSAGES.noApprovalService);
      return true;
    },
  );

  // The conversation exists (placement happened first), but nothing was driven.
  const sessionId = deps.testControllers.sessionController.sessions.keys().next().value;
  assert.equal(deps.testControllers.sessionController.creates.length, 1);
  const agent = deps.testControllers.sessionController.agents.get(sessionId);
  assert.equal(agent?.followups.length ?? 0, 0, 'a refused run never prompts the conversation it placed');
});

test('the real engine re-applies the policy on a continuation, before each prompt', async () => {
  const dir = await makeTempDir();
  try {
    const { mkdir, realpath } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { WorkspaceLocks } = await import('../src/workspace/locks.js');
    const { SettingsService } = await import('../src/config/settings.js');
    const { SessionStore } = await import('../src/runtime/session-placement.js');
    const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
    const settings = new SettingsService(join(dir, 'data'));
    await settings.replace(validSettings());
    // The task-to-conversation map a `continueFromTaskId` follow-up is validated
    // against. Without it the engine refuses the continuation before placing it,
    // which is a different test.
    const sessionStore = new SessionStore(join(dir, 'data'));
    const auth = new AuthorizationRegistry();
    const services = await policyServicesFor();
    const agents = fakeAgents({ respond: { text: 'turn' } });
    const workspaces = fakeWorkspaceController();
    const sessionController = fakeSessionController({ workspaces, respond: { text: 'turn' } });

    const engine = new JobEngine({
      agents,
      agentPresets: fakeAgentPresets(),
      sessions: { async flush() {} },
      workspaces,
      sessionController,
      sessionStore,
      // The live accessor the entry point publishes; the engine forwards it on
      // every worker run, which is what makes a continuation re-verify the policy.
      policyServices: () => services,
      llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
      settings,
      auth,
      locks: new WorkspaceLocks(),
      runGit: async (cwd, args) => {
        const key = Array.isArray(args) ? args.join(' ') : '';
        if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
        if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
        if (key === 'rev-parse --verify HEAD') return { stdout: `${'a'.repeat(40)}\n`, code: 0 };
        return { stdout: '', code: 0 };
      },
      providerRegistry: {
        async ensure(providers) {
          return { routes: new Map(providers.map((provider) => [provider.id, `${provider.id}-native`])) };
        },
      },
      delegationEnabled: true,
      authorizationMode: 'switch',
      logger: { info() {}, warn() {} },
    });

    try {
      const connection = auth.issueConnection({ label: 'test' });
      // The local-call switch needs a grant covering the directory, exactly as a
      // real dispatch does; issuing one here keeps the engine's own admission
      // checks in the path instead of bypassing them.
      const grant = auth.issueGrant(connection.connectionId, {
        kind: 'session',
        workspacePath: workspace,
        ttlSeconds: 600,
      });
      void grant;

      /**
       * Start one task and wait for it to settle.
       * @param {string} prompt - prompt text.
       * @param {object} [extra] - extra start fields.
       * @returns {Promise<object>} settled task view.
       */
      const runTask = async (prompt, extra = {}) => {
        const started = await engine.start({
          connectionId: connection.connectionId,
          token: connection.token,
          workspacePath: workspace,
          prompt,
          ...extra,
        });
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const task = engine.get(started.taskId);
          if (task.state !== 'running' && task.state !== 'pending') return task;
          await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
        }
        return engine.get(started.taskId);
      };

      const root = await runTask('start the delegated thread');
      assert.equal(root.state, 'awaiting-host-review', JSON.stringify(root.error ?? null));
      const continued = await runTask('carry on', { continueFromTaskId: root.taskId });
      assert.equal(continued.state, 'awaiting-host-review', JSON.stringify(continued.error ?? null));
      assert.equal(continued.execution.conversation.kind, 'continuation');

      // One conversation, two runs — and the resumed session resolves the policy
      // again, because each run re-applies it before its own prompt.
      const sessionId = root.execution.conversation.sessionId;
      const agent = sessionController.agents.get(sessionId);
      assert.equal(agent.followups.length, 2, 'both turns were delivered to the same conversation');
      assert.equal(services.approval.effectivePolicy(agent.session), 'never');
      assert.equal(services.sandboxPolicy.resolve({ session: agent.session }).mode, 'workspace-write');
      assert.equal(
        policyEventsOf(agent.session).filter((event) => event.type === 'sandbox/mode').length,
        2,
        'the continuation re-applied the mode instead of inheriting it',
      );
    } finally {
      await engine.dispose();
    }
  } finally {
    await cleanup(dir);
  }
});

// --- The fake itself cannot hide a half-installed policy ---------------------

test('a fake session refuses a non-JSON payload exactly where the native log does', () => {
  const session = fakeSession({ id: 'session-fake-1', cwd: CWD });
  const event = session.append('sandbox/mode', { mode: 'workspace-write' });
  assert.deepEqual(event, { type: 'sandbox/mode', seq: 0, time: event.time, data: { mode: 'workspace-write' } });
  assert.equal(session.seq, 1);
  assert.equal(session.eventAt(0)?.type, 'sandbox/mode');
  assert.equal(session.eventAt(5), undefined);
  assert.throws(() => session.append('approval/policy', 'never'), /non-JSON-serializable data/);
  assert.throws(() => session.append('approval/policy', null), /non-JSON-serializable data/);
  assert.throws(() => session.append('approval/policy'), /non-JSON-serializable data/);
});

test('the fakes hand the setup callback the agent, so a policy can be written', async () => {
  // `AgentSetup` is `(agentCtx, agent)`. A fake that passed only the context made
  // the delegated policy THROW on this path, which is what the previous round
  // reported as `RUN_SANDBOX_POLICY_UNAVAILABLE` on every placed run.
  const agents = fakeAgents({ respond: { text: 'ok' } });
  const handle = await agents.create({
    sessionId: 'session-setup-1',
    meta: { cwd: CWD },
    setup: async (agentCtx, agent) => {
      assert.equal(typeof agentCtx.on, 'function');
      assert.equal(agent.id, 'session-setup-1');
      agent.session.append('sandbox/mode', { mode: 'workspace-write' });
    },
  });
  assert.equal(handle.agent.session.eventAt(0).type, 'sandbox/mode');
  assert.equal(handle.agent.session.header.cwd, CWD);
});
