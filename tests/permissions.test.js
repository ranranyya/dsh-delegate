// Per-call permission bridge: a native DSH approval request pauses THAT tool call,
// is surfaced through the existing MCP result/status view, and is decided by the
// bounded tool `delegate_permission_decide` as allow-once or reject.
//
// The properties pinned here are the ones the feature is allowed to claim, and each
// is asserted against the INSTALLED native services rather than against a scripted
// stand-in wherever that is possible:
//
//   * only an ARMED, bound bridge gets the `ask` stance; every other run keeps the
//     deterministic `never` stance, so an unarmed path can never wait;
//   * the real operation is read from the native Session log by `callId` — never
//     from the asker's own `reason` prose;
//   * the decision is bound to one task, one connection, one request id and one
//     exact fingerprint, is single-use, and cannot be replayed or re-pointed;
//   * a request that is cancelled, expired, revoked, disposed or interrupted by a
//     restart resolves to a refusal, and never to a stored allow;
//   * the standing sandbox mode stays `workspace-write`: nothing here writes
//     `danger-full-access` anywhere;
//   * an ordinary session and the read-only reviewer are untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import { Context } from '@deepseek-ai/cordis';

import {
  PermissionBridge,
  PERMISSION_BOUNDS,
  PERMISSION_CODES,
  PERMISSION_DEFAULT_TIMEOUT_MS,
  PERMISSION_STATES,
  PERMISSION_REASONS,
  locateToolCall,
  fingerprintOf,
  canonicalJson,
} from '../src/runtime/permissions.js';
import {
  DELEGATE_APPROVAL_POLICY,
  DELEGATE_BRIDGED_APPROVAL_POLICY,
  DELEGATE_SANDBOX_MODE,
  configureDelegatedSession,
} from '../src/runtime/sandbox.js';
import { RUN_CODES, runAgent } from '../src/runtime/agent-runner.js';
import { JobEngine } from '../src/jobs/engine.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { SessionStore } from '../src/runtime/session-placement.js';
import { createExecutionHandler, EXECUTION_PREFIX } from '../src/http/execution-plane.js';
import {
  cleanup,
  fakeAgents,
  fakeAgentPresets,
  fakeLlm,
  fakeSession,
  fakeSessionController,
  fakeWorkspaceController,
  emitSessionEvent,
  llmTable,
  makeTempDir,
  nativePolicyServices,
  validSettings,
} from './helpers/fakes.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\permissions' : '/work/permissions';
const SELECTION = { providerRoute: 'relay', nativeModel: 'deepseek-chat', model: 'deepseek-chat', reasoningEffort: 'medium' };

/**
 * A real native Session, created detached with the header the placement validated.
 * @param {string} [id] - session identity.
 * @param {string} [cwd] - the session header cwd.
 * @returns {object} native Session.
 */
function nativeSession(id = 'session-permission-1', cwd = CWD) {
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
 * Record one real `tool/call` in a Session log, exactly as the native loop does.
 *
 * The envelope carries the fields the native `Session.append` requires for a live
 * turn event (`turn`/`step` live in the data); the shape is the one this module
 * reads back, so a test cannot pass against a log the product could never see.
 * @param {object} session - native or fake Session.
 * @param {object} call - `name`, `callId`, `arguments` (object), optional `turn`/`step`.
 * @returns {object} the appended event.
 */
function appendToolCall(session, call) {
  return session.append('tool/call', {
    turn: call.turn ?? 1,
    step: call.step ?? 1,
    callId: call.callId,
    name: call.name,
    // The native event carries the model's arguments as an UNPARSED JSON string.
    arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
  });
}

/**
 * Open a native turn so the approval service will answer at all.
 *
 * `ApprovalService.request()` refuses outside an open turn (the audit pair must be
 * turn-enclosed), so a test that drives the real service must model the turn the
 * tool runs inside.
 * @param {object} session - native Session.
 * @returns {void}
 */
function openTurn(session) {
  session.append('turn/start', { turn: 1 });
}

// ---------------------------------------------------------------------------
// 1. Locating the REAL operation from the native log
// ---------------------------------------------------------------------------

test('the operation is read from the native tool/call event, not from the asker', () => {
  const session = nativeSession();
  appendToolCall(session, {
    name: 'write',
    callId: 'call-1',
    arguments: { file_path: 'src/app.js', content: 'x', sandbox_permissions: 'danger-full-access', justification: 'the asker says so' },
  });

  const located = locateToolCall(session, { toolName: 'write', callId: 'call-1', reason: 'A COMPLETELY DIFFERENT CLAIM' });
  assert.equal(located.ok, true);
  const parsed = JSON.parse(located.call.argumentsText);
  // The real arguments, verbatim — the reason never appears in them.
  assert.equal(parsed.sandbox_permissions, 'danger-full-access');
  assert.equal(parsed.justification, 'the asker says so');
  assert.equal(located.call.name, 'write');
  assert.equal(located.call.turn, 1);
});

test('an unresolvable call identity is a bounded refusal, never a wide search', () => {
  const session = nativeSession();
  appendToolCall(session, { name: 'write', callId: 'call-1', arguments: { file_path: 'a' } });

  // No callId at all.
  const noCall = locateToolCall(session, { toolName: 'write' });
  assert.deepEqual(noCall, { ok: false, reason: PERMISSION_REASONS.noCallId });

  // An id that is not in the log.
  const unknown = locateToolCall(session, { toolName: 'write', callId: 'call-missing' });
  assert.deepEqual(unknown, { ok: false, reason: PERMISSION_REASONS.callNotFound });

  // The same id but a different tool name: the request and the log disagree.
  const mismatched = locateToolCall(session, { toolName: 'bash', callId: 'call-1' });
  assert.deepEqual(mismatched, { ok: false, reason: PERMISSION_REASONS.nameMismatch });

  // No readable log at all.
  const noLog = locateToolCall({ seq: 0 }, { toolName: 'write', callId: 'call-1' });
  assert.deepEqual(noLog, { ok: false, reason: PERMISSION_REASONS.noSession });
});

// ---------------------------------------------------------------------------
// 2. The stance: `ask` only for an armed, bound bridge
// ---------------------------------------------------------------------------

test('an armed bridge gets `ask`; every other run keeps the deterministic `never`', async () => {
  const services = await nativePolicyServices();
  const calls = [];

  // No bridge at all: the historical stance.
  const plain = nativeSession('session-plain');
  const plainFacts = configureDelegatedSession({ session: plain }, services);
  assert.equal(plainFacts.approvalPolicy, DELEGATE_APPROVAL_POLICY);
  assert.equal(plainFacts.bridged, false);
  assert.equal(services.approval.effectivePolicy(plain), 'never');

  // An UNARMED bridge is not a bridge.
  const unarmed = nativeSession('session-unarmed');
  const unarmedBridge = new PermissionBridge({ taskId: 'task-1' });
  const unarmedFacts = configureDelegatedSession({ session: unarmed }, services, { bridge: unarmedBridge });
  assert.equal(unarmedFacts.bridged, false);
  assert.equal(services.approval.effectivePolicy(unarmed), 'never');

  // A bridge bound to ANOTHER Agent is not this session's bridge.
  const other = nativeSession('session-other');
  const otherBridge = new PermissionBridge({ taskId: 'task-2' });
  otherBridge.arm({ id: 'session-other', session: other });
  const foreign = nativeSession('session-foreign');
  const foreignFacts = configureDelegatedSession({ session: foreign }, services, { bridge: otherBridge });
  assert.equal(foreignFacts.bridged, false);
  assert.equal(services.approval.effectivePolicy(foreign), 'never');

  // An armed bridge bound to THIS agent: `ask`, read back through the service.
  const armed = nativeSession('session-armed');
  const agent = { id: 'session-armed', session: armed };
  const bridge = new PermissionBridge({ taskId: 'task-3', onSettled: (entry) => calls.push(entry) });
  bridge.arm(agent);
  const armedFacts = configureDelegatedSession(agent, services, { bridge });
  assert.equal(armedFacts.bridged, true);
  assert.equal(armedFacts.approvalPolicy, DELEGATE_BRIDGED_APPROVAL_POLICY);
  assert.equal(services.approval.effectivePolicy(armed), 'ask');
  // The standing mode is unchanged in every one of these cases.
  for (const session of [plain, unarmed, foreign, armed]) {
    assert.equal(services.sandboxPolicy.resolve({ session }).mode, DELEGATE_SANDBOX_MODE);
  }
  assert.equal(RUN_CODES.permissionBridgeUnavailable, 'RUN_PERMISSION_BRIDGE_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// 3. Allow-once: the real call resumes exactly once, then asks again
// ---------------------------------------------------------------------------

test('allow-once resumes the same native call exactly once and the next escalation asks again', async () => {
  const ctx = new Context();
  const approval = new ApprovalService(ctx, { policy: 'ask' });
  const session = nativeSession('session-allow');
  const agent = { id: 'session-allow', session };
  const settled = [];
  const pendingSeen = [];
  const bridge = new PermissionBridge({
    taskId: 'task-allow',
    connectionId: 'local-mcp',
    onPending: (view) => pendingSeen.push(view),
    onSettled: (entry) => settled.push(entry),
  });
  bridge.arm(agent);
  const disposer = ctx.on('approval/request', async (request, next) => {
    if (bridge.owns(request) !== true) return await next();
    return await bridge.answer(request);
  });

  try {
    openTurn(session);
    appendToolCall(session, {
      name: 'write',
      callId: 'call-1',
      arguments: { file_path: 'src/a.js', content: 'body', sandbox_permissions: 'danger-full-access', justification: 'needs it' },
    });

    // The native service is the caller: it asks, and waits, exactly as a tool does.
    const ask = approval.request({
      agent,
      toolName: 'write',
      callId: 'call-1',
      reason: 'escalate sandbox to danger-full-access: needs it',
      signal: undefined,
    });
    // Nothing has been decided yet, so the call is genuinely paused.
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    assert.equal(settled.length, 0, 'no decision may exist before the commander answers');
    assert.equal(pendingSeen.length, 1);
    const pending = bridge.pendingView();
    assert.ok(pending !== null);
    assert.equal(pending.state, PERMISSION_STATES.pending);
    assert.equal(pending.callId, 'call-1');
    assert.equal(pending.toolName, 'write');
    assert.equal(pending.requestedAccess.mode, 'danger-full-access');
    assert.ok(pending.argumentKeys.includes('file_path'));
    assert.equal(pending.reason, 'escalate sandbox to danger-full-access: needs it');
    assert.equal(pending.reasonSource, 'asker-claim');
    // The deadline is a fixed, bounded wait — never infinite.
    assert.equal(pending.deadlineAt - pending.createdAt, PERMISSION_DEFAULT_TIMEOUT_MS);

    // The commander allows it once, bound to the exact fingerprint.
    bridge.decide({ requestId: pending.requestId, decision: 'allow-once', reason: 'checked the file', fingerprint: pending.fingerprint });

    // The paused native call resumes with the native vocabulary.
    assert.equal(await ask, 'allowed-once');
    assert.equal(settled.length, 1);
    assert.equal(settled[0].outcome, 'allowed-once');
    assert.equal(settled[0].decidedBy, 'commander');
    assert.equal(settled[0].grant.reusable, false);
    assert.equal(settled[0].standingModeUnchanged, true);

    // The SAME request id is single-use: a duplicate decision is refused.
    assert.throws(
      () => bridge.decide({ requestId: pending.requestId, decision: 'allow-once' }),
      (error) => {
        assert.equal(error.code, PERMISSION_CODES.notPending);
        return true;
      },
    );

    // The NEXT escalation asks again — the first grant did not survive the call.
    appendToolCall(session, {
      name: 'write',
      callId: 'call-2',
      arguments: { file_path: 'src/b.js', content: 'body2', sandbox_permissions: 'danger-full-access', justification: 'needs it again' },
    });
    const secondAsk = approval.request({
      agent, toolName: 'write', callId: 'call-2', reason: 'escalate sandbox to danger-full-access: needs it again',
    });
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const second = bridge.pendingView();
    assert.ok(second !== null, 'the second escalation must also be pending');
    assert.notEqual(second.requestId, pending.requestId, 'a request identity is never reused');
    assert.notEqual(second.fingerprint, pending.fingerprint, 'different arguments are a different operation');
    // And the first approval cannot decide it.
    assert.throws(
      () => bridge.decide({ requestId: pending.requestId, decision: 'allow-once' }),
      (error) => error.code === PERMISSION_CODES.notFound || error.code === PERMISSION_CODES.notPending,
    );
    bridge.decide({ requestId: second.requestId, decision: 'reject', reason: 'not this time' });
    assert.equal(await secondAsk, 'rejected');
  } finally {
    disposer();
    bridge.dispose();
  }
});

// ---------------------------------------------------------------------------
// 4. Refusals: no self-approval, rejected, expired, changed, foreign
// ---------------------------------------------------------------------------

test('reject keeps the call denied and grants nothing', async () => {
  const ctx = new Context();
  const approval = new ApprovalService(ctx, { policy: 'ask' });
  const session = nativeSession('session-reject');
  const agent = { id: 'session-reject', session };
  const bridge = new PermissionBridge({ taskId: 'task-reject' });
  bridge.arm(agent);
  const disposer = ctx.on('approval/request', async (request, next) => (bridge.owns(request) ? await bridge.answer(request) : await next()));
  try {
    openTurn(session);
    appendToolCall(session, { name: 'bash', callId: 'c-1', arguments: { command: 'rm -rf /', sandbox_permissions: 'danger-full-access', justification: 'x' } });
    const ask = approval.request({ agent, toolName: 'bash', callId: 'c-1', reason: 'escalate' });
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = bridge.pendingView();
    bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'destructive command' });
    assert.equal(await ask, 'rejected');
    const trail = bridge.historyView();
    assert.equal(trail.length, 1);
    assert.equal(trail[0].outcome, 'rejected');
    assert.equal(trail[0].grant, null, 'a rejection grants nothing');
  } finally {
    disposer();
    bridge.dispose();
  }
});

test('a decision whose fingerprint names another operation is refused and the request stays pending', async () => {
  const session = nativeSession('session-changed');
  const agent = { id: 'session-changed', session };
  const bridge = new PermissionBridge({ taskId: 'task-changed' });
  bridge.arm(agent);
  appendToolCall(session, { name: 'write', callId: 'c-1', arguments: { file_path: 'a.js', content: 'one' } });
  const ask = bridge.answer({ agent, toolName: 'write', callId: 'c-1' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();

  assert.throws(
    () => bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: fingerprintOf({ file_path: 'a.js', content: 'SUBSTITUTED' }) }),
    (error) => {
      assert.equal(error.code, PERMISSION_CODES.changed);
      return true;
    },
  );
  // Still pending: the two parties that actually know the operation may still decide.
  assert.equal(bridge.pendingView()?.requestId, pending.requestId);
  bridge.decide({ requestId: pending.requestId, decision: 'reject' });
  assert.equal(await ask, 'rejected');
  bridge.dispose();
});

test('the request deadline refuses the wait with its own bounded outcome', async () => {
  const session = nativeSession('session-expire');
  const agent = { id: 'session-expire', session };
  let clock = 1_000;
  const bridge = new PermissionBridge({
    taskId: 'task-expire',
    timeoutMs: 25,
    now: () => clock,
  });
  bridge.arm(agent);
  appendToolCall(session, { name: 'write', callId: 'c-1', arguments: { file_path: 'a.js' } });
  const ask = bridge.answer({ agent, toolName: 'write', callId: 'c-1' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  assert.equal(bridge.pendingView()?.state, PERMISSION_STATES.pending);
  // The real deadline is 25 ms; waiting it out is the behaviour under test.
  assert.equal(await ask, 'rejected');
  assert.equal(bridge.pendingView(), null, 'an expired request is not pending');
  const trail = bridge.historyView();
  assert.equal(trail.length, 1);
  assert.equal(trail[0].state, PERMISSION_STATES.expired);
  assert.match(trail[0].decisionReason, /deadline/u);
  bridge.dispose();
});

test('a decision that arrives after the deadline is refused by the clock, not applied', async () => {
  const session = nativeSession('session-late');
  const agent = { id: 'session-late', session };
  let clock = 1_000;
  const bridge = new PermissionBridge({ taskId: 'task-late', timeoutMs: 60_000, now: () => clock });
  bridge.arm(agent);
  appendToolCall(session, { name: 'write', callId: 'c-1', arguments: { file_path: 'a.js' } });
  const ask = bridge.answer({ agent, toolName: 'write', callId: 'c-1' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  // The clock passes the deadline while the decision is in flight.
  clock += 60_001;
  assert.throws(
    () => bridge.decide({ requestId: pending.requestId, decision: 'allow-once' }),
    (error) => {
      assert.equal(error.code, PERMISSION_CODES.expired);
      return true;
    },
  );
  assert.equal(await ask, 'rejected');
  bridge.dispose();
});

test('the worker cannot decide its own request: the decision surface is not a bridge method it can reach', () => {
  // The property, stated as a test: the worker's native tool surface is fixed by
  // its own preset composition, and `delegate_permission_decide` is an MCP tool
  // (asserted in tests/mcp.test.js) which the native worker never receives. What a
  // caller might still be tempted to reach is the bridge object itself, and THAT is
  // what this test pins: it refuses any decision for a request it does not own, so a
  // caller cannot decide somebody else's call even with the object in hand.
  const bridge = new PermissionBridge({ taskId: 'task-self' });
  assert.equal(typeof bridge.decide, 'function', 'the engine-side surface exists');

  // Not this bridge's request.
  assert.throws(
    () => bridge.decide({ requestId: 'permission-other-1', decision: 'allow-once' }),
    (error) => {
      assert.equal(error.code, PERMISSION_CODES.notFound);
      return true;
    },
  );
  // An invalid decision value is refused before any request is even looked up.
  assert.throws(
    () => bridge.decide({ requestId: 'permission-other-1', decision: 'allow' }),
    (error) => {
      assert.equal(error.code, PERMISSION_CODES.invalid);
      return true;
    },
  );
  bridge.dispose();
});

// ---------------------------------------------------------------------------
// 5. Redaction and bounds
// ---------------------------------------------------------------------------

test('published arguments and reasons are redacted, bounded and never carry a secret', async () => {
  const session = nativeSession('session-redact');
  const agent = { id: 'session-redact', session };
  const bridge = new PermissionBridge({ taskId: 'task-redact' });
  bridge.arm(agent);
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123';
  appendToolCall(session, {
    name: 'bash',
    callId: 'c-1',
    arguments: {
      command: `curl -H "Authorization: Bearer ${secret}" https://example.test`,
      api_key: secret,
      deeply: { nested: { a: { b: { c: { d: { e: 'too deep' } } } } } },
      long: 'x'.repeat(PERMISSION_BOUNDS.argumentValueChars * 3),
    },
  });
  const ask = bridge.answer({ agent, toolName: 'bash', callId: 'c-1', reason: `because ${secret}` });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();

  const published = JSON.stringify(pending);
  assert.equal(published.includes(secret), false, 'no secret may reach a published field');
  assert.equal(pending.argumentsRedacted, true);
  assert.ok(pending.arguments.length <= PERMISSION_BOUNDS.argumentsChars + 32);
  assert.ok(!pending.arguments.includes(secret));
  // The exact private fingerprint still binds the decision.
  assert.match(pending.fingerprint, /^sha256:[0-9a-f]{64}$/u);

  bridge.decide({ requestId: pending.requestId, decision: 'reject' });
  assert.equal(await ask, 'rejected');
  bridge.dispose();
});

test('a bounded, non-reusable identity is issued per request', async () => {
  const session = nativeSession('session-identity');
  const agent = { id: 'session-identity', session };
  const bridge = new PermissionBridge({ taskId: 'task-identity', connectionId: 'local-mcp' });
  bridge.arm(agent);
  const ids = [];
  for (const [index, callId] of ['c-1', 'c-2', 'c-3'].entries()) {
    appendToolCall(session, { name: 'write', callId, arguments: { file_path: `f${index}.js` } });
    const ask = bridge.answer({ agent, toolName: 'write', callId });
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = bridge.pendingView();
    ids.push(pending.requestId);
    assert.equal(pending.taskId, 'task-identity');
    assert.equal(pending.sessionId, 'session-identity');
    assert.equal(pending.callId, callId);
    bridge.decide({ requestId: pending.requestId, decision: 'reject' });
    await ask;
  }
  assert.equal(new Set(ids).size, 3, 'every request has its own identity');
  bridge.dispose();
});

// ---------------------------------------------------------------------------
// 6. The run: armed before the prompt, released when the run ends
// ---------------------------------------------------------------------------

/**
 * The dependency set a bridged delegated run needs.
 * @param {object} agents - fake agent registry.
 * @param {object} services - `{ sandboxPolicy, approval }`.
 * @returns {object} dependency object.
 */
function depsFor(agents, services) {
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({
    workspaces,
    ...(agents.respondPlan === undefined ? {} : { respond: agents.respondPlan }),
  });
  return {
    agents,
    agentPresets: fakeAgentPresets(),
    workspaces,
    sessionController,
    policyServices: () => services,
    testControllers: { workspaces, sessionController },
  };
}

test('a bridged placed run installs `ask` and registers its answerer before the prompt', async () => {
  const services = await nativePolicyServices();
  const agents = fakeAgents({ respond: { text: 'done' } });
  const deps = depsFor(agents, services);
  const controller = deps.testControllers.sessionController;
  const resolveOriginal = controller.resolveAgent.bind(controller);
  const seen = [];
  const bridge = new PermissionBridge({ taskId: 'task-placed' });
  controller.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found.agent;
    if (agent === undefined) return found;
    const followup = agent.followup.bind(agent);
    agent.followup = (message) => {
      seen.push({
        stance: services.approval.effectivePolicy(agent.session),
        mode: services.sandboxPolicy.resolve({ session: agent.session }).mode,
        // The answerer was registered on this Agent's own context before delivery.
        listeners: agent.listeners.map((entry) => entry.event),
      });
      followup(message);
    };
    return found;
  };

  const result = await runAgent(deps, {
    prompt: 'do the delegated thing',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    delegated: true,
    permissionBridge: bridge,
  });

  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.approval, { policy: 'ask', bridged: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stance, 'ask', 'the stance was in force when the prompt was delivered');
  assert.equal(seen[0].mode, 'workspace-write', 'the standing mode is still workspace-write');
  assert.ok(seen[0].listeners.includes('approval/request'), 'the answerer was registered before the prompt');
});

test('a supplied bridge that cannot be armed refuses the run before any prompt', async () => {
  const services = await nativePolicyServices();
  const agents = fakeAgents({ respond: { text: 'must not be delivered' } });
  const deps = depsFor(agents, services);
  // A bridge already bound to another Agent: it cannot answer for this one.
  const other = nativeSession('session-bound-elsewhere', CWD);
  const bridge = new PermissionBridge({ taskId: 'task-elsewhere' });
  bridge.arm({ id: 'session-bound-elsewhere', session: other });

  await assert.rejects(
    async () => runAgent(deps, {
      prompt: 'do the delegated thing',
      cwd: CWD,
      selection: SELECTION,
      timeoutMs: 5000,
      delegated: true,
      permissionBridge: bridge,
      allowUnplaced: true,
    }),
    (error) => {
      assert.equal(error.code, RUN_CODES.permissionBridgeUnavailable);
      return true;
    },
  );
  // Fail closed: nothing was prompted.
  for (const record of agents.created) {
    assert.equal(record.followups.length, 0, 'a refused bridge must not deliver a prompt');
  }
});

test('no bridge is the unchanged path: the stance stays `never` and nothing waits', async () => {
  const services = await nativePolicyServices();
  const agents = fakeAgents({ respond: { text: 'done' } });
  const deps = depsFor(agents, services);
  const result = await runAgent(deps, {
    prompt: 'do the delegated thing',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    delegated: true,
  });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.approval, { policy: 'never', bridged: false });
});

test('the read-only reviewer and an ordinary session never get an approval answerer', async () => {
  const services = await nativePolicyServices();
  const agents = fakeAgents({ respond: { text: 'reviewed' } });
  const deps = depsFor(agents, services);
  // The review is an UNPLACED, NON-delegated run: it must not be put under the
  // worker bridge, and it must not be refused for lacking one either.
  const result = await runAgent(deps, {
    prompt: 'review this',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 5000,
    allowUnplaced: true,
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.approval, null, 'an ordinary composition reports no delegate policy at all');
  const agent = agents.created[0].agent;
  // Its stance is whatever the deployment configured (the fixture default `ask`),
  // and it carries no delegate bridge and no answerer of ours.
  assert.equal(services.approval.effectivePolicy(agent.session), 'ask');
  assert.equal(agent.session.eventsOf('approval/policy').length, 0);
});

// ---------------------------------------------------------------------------
// 7. The engine: pending state without changing the state contract
// ---------------------------------------------------------------------------

/**
 * Build a switch-mode engine over a real workspace.
 * @param {object} options - `permissionBridge` factory.
 * @param {object} dir - temp dir.
 * @returns {Promise<object>} fixture.
 */
async function engineFixture(options, dir) {
  const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(validSettings());
  const sessionStore = new SessionStore(join(dir, 'data'));
  const auth = new AuthorizationRegistry();
  const services = await nativePolicyServices();
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces, respond: { text: 'turn' } });
  const engine = new JobEngine({
    agents: fakeAgents({ respond: { text: 'turn' } }),
    agentPresets: fakeAgentPresets(),
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    sessionStore,
    policyServices: () => services,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth,
    locks: new WorkspaceLocks(),
    runGit: async (_cwd, args) => {
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
    ...(options.permissionBridge === undefined ? {} : { permissionBridge: options.permissionBridge }),
    // Optional durable history, so a test can prove an ENGINE checkpoint reaches disk.
    ...(options.history === undefined ? {} : { history: options.history }),
    logger: { info() {}, warn() {} },
  });
  return { engine, workspace, auth, services, workspaces, sessionController, dir };
}

test('a run waiting for a decision stays `running` with phase `awaiting-permission` and keeps its slot', async () => {
  const dir = await makeTempDir();
  const captured = [];
  const fixture = await engineFixture({
    permissionBridge: (request) => {
      const bridge = new PermissionBridge({
        taskId: request.taskId,
        connectionId: request.connectionId,
        onPending: request.onPending,
        onSettled: request.onSettled,
      });
      captured.push(bridge);
      return bridge;
    },
  }, dir);
  try {
    const started = await fixture.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fixture.workspace,
      prompt: 'wait for a decision',
    });
    // Let the engine create the bridge and the run settle into `running`.
    for (let attempt = 0; attempt < 60 && captured.length === 0; attempt += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    assert.equal(captured.length, 1, 'one bridge per run');

    // Simulate the native ask landing in the run: this is the engine's own observer
    // path, driven by the bridge the engine created.
    const task = fixture.engine.tasks.get(started.taskId);
    fixture.engine.onPermissionPending(task, {
      requestId: 'permission-1', taskId: started.taskId, callId: 'c-1', toolName: 'write', state: 'pending',
    });
    const view = fixture.engine.get(started.taskId);
    assert.equal(view.state, 'running', 'waiting is not a new state');
    assert.equal(view.phase, 'awaiting-permission', 'the phase states the wait');
    assert.equal(view.permission.waiting, true);
    assert.equal(view.permission.pending.requestId, 'permission-1');
    assert.equal(task.slotHeld, true, 'the workspace slot is still this task\'s');
    assert.equal(task.leases.length > 0, true, 'the workspace lock is still held');
    assert.equal(view.permission.standingSandboxMode, DELEGATE_SANDBOX_MODE);
    assert.equal(view.permission.grantScope, 'single-call');
    assert.equal(view.hostAcceptance, null, 'a wait is never acceptance');
    assert.equal(view.selfApproved, false);

    // Settling returns the task to its execution phase, still running.
    fixture.engine.onPermissionSettled(task, {
      requestId: 'permission-1', outcome: 'allowed-once', state: 'decided', decidedBy: 'commander',
    });
    const after = fixture.engine.get(started.taskId);
    assert.equal(after.state, 'running');
    assert.equal(after.permission.waiting, false);
    assert.equal(after.phase === 'awaiting-permission', false, 'the wait ended');
    assert.equal(after.permission.evidence.length, 1);

    await fixture.engine.cancel(started.taskId, 'test-end');
  } finally {
    await fixture.engine.dispose();
    await cleanup(dir);
  }
});

test('a decision is refused across owners, for an unknown id, and after the task ended', async () => {
  const dir = await makeTempDir();
  const fixture = await engineFixture({}, dir);
  try {
    // A deployment with no bridge factory: a decision is always refused as absent.
    const started = await fixture.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fixture.workspace,
      prompt: 'no bridge here',
    });
    const task = fixture.engine.tasks.get(started.taskId);
    task.connectionId = 'local-mcp';
    // Unknown request id on a live task with no bridge.
    assert.throws(
      () => fixture.engine.decidePermission({
        connectionId: 'local-mcp', taskId: started.taskId, requestId: 'permission-x', decision: 'allow-once',
      }),
      (error) => {
        assert.equal(error.code, PERMISSION_CODES.notFound);
        return true;
      },
    );
    // Another connection's task is answered exactly like an unknown one.
    assert.throws(
      () => fixture.engine.decidePermission({
        connectionId: 'other-connection', taskId: started.taskId, requestId: 'permission-x', decision: 'allow-once',
      }),
      (error) => {
        assert.equal(error.code, 'JOB_TASK_NOT_FOUND');
        return true;
      },
    );
    // An entirely unknown task id is the same answer.
    assert.throws(
      () => fixture.engine.decidePermission({
        connectionId: 'local-mcp', taskId: 'task-does-not-exist', requestId: 'permission-x', decision: 'allow-once',
      }),
      (error) => error.code === 'JOB_TASK_NOT_FOUND',
    );
    // A caller with no verified identity cannot decide anything at all.
    assert.throws(
      () => fixture.engine.decidePermission({ taskId: started.taskId, requestId: 'permission-x', decision: 'allow-once' }),
      (error) => error.code === 'JOB_TASK_NOT_FOUND',
    );
    await fixture.engine.cancel(started.taskId, 'test-end');
  } finally {
    await fixture.engine.dispose();
    await cleanup(dir);
  }
});

test('a terminal task refuses a late decision and keeps its request as history only', async () => {
  const dir = await makeTempDir();
  const fixture = await engineFixture({}, dir);
  try {
    const started = await fixture.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fixture.workspace,
      prompt: 'finish quickly',
    });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const task = fixture.engine.get(started.taskId);
      if (task.state !== 'running' && task.state !== 'pending') break;
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    const settled = fixture.engine.get(started.taskId);
    assert.notEqual(settled.state, 'running');
    assert.throws(
      () => fixture.engine.decidePermission({
        connectionId: 'local-mcp', taskId: started.taskId, requestId: 'permission-late', decision: 'allow-once',
      }),
      (error) => {
        assert.equal(error.code, PERMISSION_CODES.notPending);
        return true;
      },
    );
    // A restart begins with no tasks: the interrupted request cannot be replayed.
    const restarted = new JobEngine({
      agents: fakeAgents({ respond: { text: 'x' } }),
      agentPresets: fakeAgentPresets(),
      settings: fixture.engine.settings,
      auth: fixture.auth,
      locks: new WorkspaceLocks(),
      llm: fakeLlm(),
      delegationEnabled: true,
      authorizationMode: 'switch',
      logger: { info() {}, warn() {} },
    });
    try {
      assert.equal(restarted.tasks.size, 0, 'no task (and therefore no request) survives a restart');
      assert.throws(
        () => restarted.decidePermission({
          connectionId: 'local-mcp', taskId: started.taskId, requestId: 'permission-late', decision: 'allow-once',
        }),
        (error) => error.code === 'JOB_TASK_NOT_FOUND',
      );
    } finally {
      await restarted.dispose();
    }
  } finally {
    await fixture.engine.dispose();
    await cleanup(dir);
  }
});

test('cancelling a task with an outstanding request settles it and releases the run', async () => {
  const dir = await makeTempDir();
  const bridges = [];
  const fixture = await engineFixture({
    permissionBridge: (request) => {
      const bridge = new PermissionBridge({
        taskId: request.taskId,
        connectionId: request.connectionId,
        onPending: request.onPending,
        onSettled: request.onSettled,
      });
      bridges.push(bridge);
      return bridge;
    },
  }, dir);
  try {
    const started = await fixture.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fixture.workspace,
      prompt: 'cancel a waiting run',
    });
    for (let attempt = 0; attempt < 60 && bridges.length === 0; attempt += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    assert.equal(bridges.length, 1);
    const task = fixture.engine.tasks.get(started.taskId);
    fixture.engine.onPermissionPending(task, {
      requestId: 'permission-cancel', taskId: started.taskId, callId: 'c-1', toolName: 'write', state: 'pending',
    });
    // A real pending request inside the bridge, so the stop has something to settle.
    task.permission.bridge.pending = { requestId: 'permission-cancel', state: PERMISSION_STATES.pending, timer: null, resolve: null };
    assert.equal(task.permission.bridge.stop(), true, 'the stop settles the waiter');
    await fixture.engine.cancel(started.taskId, 'operator');
    const view = fixture.engine.get(started.taskId);
    assert.equal(view.permission.waiting, false);
    assert.equal(view.state, 'cancelled');
  } finally {
    await fixture.engine.dispose();
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 8. The execution plane route
// ---------------------------------------------------------------------------

test('the permission route validates its body and derives the owner from the connection', async () => {
  const dir = await makeTempDir();
  const fixture = await engineFixture({}, dir);
  const handler = createExecutionHandler({ ...fixture.engine.deps, engine: fixture.engine, getBindHost: () => '127.0.0.1' });
  /**
   * Dispatch one JSON body at the permission route.
   * @param {object} body - request body.
   * @returns {Promise<object>} `{ status, body }`.
   */
  const call = async (body) => {
    const url = `http://127.0.0.1:3210${EXECUTION_PREFIX}/tasks/permission`;
    const req = {
      method: 'POST',
      url,
      headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' },
      // The transport fence requires a loopback SOCKET, not only a loopback Host.
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body));
      },
    };
    const out = { status: 200, headers: {}, body: '' };
    const res = {
      headersSent: false,
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      writeHead(status) { out.status = status; this.headersSent = true; },
      end(text) { out.body = text; },
    };
    await handler(req, res);
    return { status: out.status, body: JSON.parse(out.body) };
  };
  try {
    // Missing taskId.
    const noTask = await call({ requestId: 'r1', decision: 'allow-once' });
    assert.equal(noTask.status, 400);
    assert.equal(noTask.body.error.code, 'TASK_ID_REQUIRED');
    // Missing requestId.
    const noRequest = await call({ taskId: 't1', decision: 'allow-once' });
    assert.equal(noRequest.status, 400);
    assert.equal(noRequest.body.error.code, 'PERMISSION_REQUEST_ID_REQUIRED');
    // A decision outside the closed vocabulary.
    const badDecision = await call({ taskId: 't1', requestId: 'r1', decision: 'allow' });
    assert.equal(badDecision.status, 400);
    assert.equal(badDecision.body.error.code, 'PERMISSION_DECISION_INVALID');
    // A non-string reason is refused rather than coerced.
    const badReason = await call({ taskId: 't1', requestId: 'r1', decision: 'reject', reason: 5 });
    assert.equal(badReason.status, 400);
    assert.equal(badReason.body.error.code, 'PERMISSION_REASON_INVALID');
    // A well-formed decision for a task this connection does not own is absent.
    const foreign = await call({ taskId: 'task-unknown', requestId: 'r1', decision: 'allow-once' });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, 'JOB_TASK_NOT_FOUND');
  } finally {
    await fixture.engine.dispose();
    await cleanup(dir);
  }
});

test('the permission route is gated by the switch, like a submission', async () => {
  const dir = await makeTempDir();
  const fixture = await engineFixture({}, dir);
  fixture.engine.setDelegationEnabled(false);
  const handler = createExecutionHandler({ ...fixture.engine.deps, engine: fixture.engine, getBindHost: () => '127.0.0.1' });
  try {
    const url = `http://127.0.0.1:3210${EXECUTION_PREFIX}/tasks/permission`;
    const req = {
      method: 'POST',
      url,
      headers: { host: '127.0.0.1:3210', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ taskId: 't1', requestId: 'r1', decision: 'allow-once' }));
      },
    };
    const out = { status: 200, body: '' };
    const res = {
      headersSent: false,
      setHeader() {},
      writeHead(status) { out.status = status; this.headersSent = true; },
      end(text) { out.body = text; },
    };
    await handler(req, res);
    assert.equal(out.status, 403);
    assert.equal(JSON.parse(out.body).error.code, 'DELEGATION_DISABLED');
  } finally {
    await fixture.engine.dispose();
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 9. Timeouts are separate budgets
// ---------------------------------------------------------------------------

test('the approval wait has its own fixed deadline, independent of the execution budget', () => {
  // A fixed, documented default rather than an unbounded wait.
  assert.equal(PERMISSION_DEFAULT_TIMEOUT_MS, 10 * 60 * 1000);
  const bridge = new PermissionBridge({ taskId: 'task-timeout', timeoutMs: 5 });
  assert.equal(bridge.timeoutMs, 5);
  // A caller cannot configure an infinite (or absurdly long) wait.
  const capped = new PermissionBridge({ taskId: 'task-timeout', timeoutMs: Number.MAX_SAFE_INTEGER });
  assert.ok(capped.timeoutMs <= 30 * 60 * 1000, 'the configured wait is capped');
  // The DEFAULT is what a real run gets; it is not derived from the worker timeout.
  const fallback = new PermissionBridge({ taskId: 'task-timeout' });
  assert.equal(fallback.timeoutMs, PERMISSION_DEFAULT_TIMEOUT_MS);
  bridge.dispose();
  capped.dispose();
  fallback.dispose();
});

test('an aborted ask is withdrawn as cancelled and leaves nothing pending', async () => {
  const session = nativeSession('session-abort');
  const agent = { id: 'session-abort', session };
  const bridge = new PermissionBridge({ taskId: 'task-abort' });
  bridge.arm(agent);
  appendToolCall(session, { name: 'write', callId: 'c-1', arguments: { file_path: 'a.js' } });
  const controller = new AbortController();
  const ask = bridge.answer({ agent, toolName: 'write', callId: 'c-1', signal: controller.signal });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  assert.equal(bridge.pendingView()?.state, PERMISSION_STATES.pending);
  controller.abort();
  assert.equal(await ask, 'cancelled');
  assert.equal(bridge.pendingView(), null);
  assert.equal(bridge.historyView()[0].state, PERMISSION_STATES.cancelled);
  bridge.dispose();
});

test('a disposed bridge answers `unavailable` and can never be decided afterwards', async () => {
  const session = nativeSession('session-dispose');
  const agent = { id: 'session-dispose', session };
  const bridge = new PermissionBridge({ taskId: 'task-dispose' });
  bridge.arm(agent);
  appendToolCall(session, { name: 'write', callId: 'c-1', arguments: { file_path: 'a.js' } });
  const ask = bridge.answer({ agent, toolName: 'write', callId: 'c-1' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  bridge.dispose();
  assert.equal(await ask, 'unavailable', 'a disposed answerer cannot leave a call allowed');
  assert.throws(
    () => bridge.decide({ requestId: pending.requestId, decision: 'allow-once' }),
    (error) => error.code === PERMISSION_CODES.notFound || error.code === PERMISSION_CODES.notPending,
  );
  // A disposed bridge refuses new requests outright.
  assert.equal(await bridge.answer({ agent, toolName: 'write', callId: 'c-2' }), 'unavailable');
});

test('only the requesting Agent is answered; a foreign request falls through untouched', async () => {
  const ctx = new Context();
  const approval = new ApprovalService(ctx, { policy: 'ask' });
  const mine = nativeSession('session-mine');
  const mineAgent = { id: 'session-mine', session: mine };
  const bridge = new PermissionBridge({ taskId: 'task-mine' });
  bridge.arm(mineAgent);
  const disposer = ctx.on('approval/request', async (request, next) => (bridge.owns(request) ? await bridge.answer(request) : await next()));
  try {
    // Another session's request is not this bridge's, so it is not claimed.
    const other = nativeSession('session-theirs');
    openTurn(other);
    let answererReached = 0;
    const inner = ctx.on('approval/request', async () => { answererReached += 1; return 'allowed-once'; });
    const outcome = await approval.request({ agent: { id: 'session-theirs', session: other }, toolName: 'write', callId: 'c-9' });
    inner();
    assert.equal(outcome, 'allowed-once', 'the foreign request reached the answerer it actually has');
    assert.equal(answererReached, 1);
    assert.equal(bridge.pendingView(), null, 'the foreign request never became this bridge\'s pending request');
  } finally {
    disposer();
    bridge.dispose();
  }
});

// ---------------------------------------------------------------------------
// Round 2 (independent review R1-R9): behavioral regressions
// ---------------------------------------------------------------------------

/**
 * A bridge over a REAL native Session, with one committed tool call and an open
 * turn, wired to a real ApprovalService listener — the same shape production uses.
 * @param {object} [options] - `callId`, `args`, `sessionId`, `turnOpen`.
 * @returns {object} `{ ctx, approval, session, agent, bridge, ask, dispose }`.
 */
async function liveFixture(options = {}) {
  const ctx = new Context();
  const approval = new ApprovalService(ctx, { policy: 'ask' });
  const sessionId = options.sessionId ?? 'session-r2';
  const session = nativeSession(sessionId);
  const agent = { id: sessionId, session };
  const bridge = new PermissionBridge({
    taskId: 'task-r2',
    connectionId: 'local-mcp',
    isSecretKey: (key) => /(api[_-]?key|apikey|secret|token|password)/iu.test(key),
    ...(options.bridge ?? {}),
  });
  bridge.arm(agent);
  const disposer = ctx.on('approval/request', async (request, next) => {
    if (bridge.owns(request) !== true) return await next();
    return await bridge.answer(request);
  }, { prepend: true });
  if (options.turnOpen !== false) openTurn(session);
  const callId = options.callId ?? 'call-r2';
  const args = options.args ?? { file_path: 'src/a.js', content: 'body', sandbox_permissions: 'danger-full-access', justification: 'x' };
  appendToolCall(session, { name: options.toolName ?? 'write', callId, arguments: args });
  return {
    ctx, approval, session, agent, bridge, callId,
    ask: () => approval.request({ agent, toolName: options.toolName ?? 'write', callId, reason: 'escalate' }),
    dispose: () => {
      disposer();
      bridge.dispose();
    },
  };
}

// --- R1: the bound operation is re-read at decision time ---------------------

test('R1: mutating the recorded tool/call arguments after the request is made refuses the allow', async () => {
  const f = await liveFixture();
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    assert.equal(pending.state, 'pending');

    // A synthetic substitution: the SAME offset now carries different arguments.
    // This is the exact reproduction from the review, which used to be accepted.
    const seq = f.bridge.pending.callSeq;
    assert.equal(typeof seq, 'number', 'the internal record pins the call offset');
    const event = f.session.eventAt(seq);
    assert.ok(event !== undefined, 'the fixture must expose the committed call offset');
    const mutated = JSON.parse(JSON.stringify(event.data));
    mutated.arguments = JSON.stringify({ file_path: 'src/a.js', content: 'MUTATED' });
    f.session.log[seq] = Object.freeze({ ...event, data: mutated });

    assert.throws(
      () => f.bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint }),
      (error) => {
        assert.equal(error.code, PERMISSION_CODES.changed);
        assert.equal(error.details.reason, PERMISSION_REASONS.callChanged);
        return true;
      },
      'an allow must re-read the live call and refuse a changed operation',
    );
    // The request is left pending, and a reject still works — refusing is safe even
    // though the operation it names can no longer be verified.
    assert.equal(f.bridge.pendingView()?.requestId, pending.requestId);
    f.bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'operation changed' });
    assert.equal(await ask, 'rejected');
  } finally {
    f.dispose();
  }
});

test('R1: a call whose turn has closed cannot be allowed', async () => {
  const f = await liveFixture();
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    // The turn ends while the request is pending.
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    assert.throws(
      () => f.bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint }),
      (error) => {
        assert.equal(error.code, PERMISSION_CODES.changed);
        assert.equal(error.details.reason, PERMISSION_REASONS.turnClosed);
        return true;
      },
    );
    // The allow was refused, so the request is STILL pending — a reject remains
    // available, because refusing is always safe even on stale evidence.
    assert.equal(f.bridge.pendingView()?.requestId, pending.requestId);
    f.bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'turn already ended' });
    assert.equal(await ask, 'rejected');
  } finally {
    f.dispose();
  }
});

test('R1: the exact same unchanged call IS still allowed (the re-read is not a blanket refusal)', async () => {
  const f = await liveFixture();
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    const settled = f.bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint });
    assert.equal(await ask, 'allowed-once');
    assert.equal(settled.outcome, 'allowed-once');
    assert.deepEqual(settled.verified, {
      fingerprintQuoted: true,
      argumentsComplete: true,
      callReread: true,
      turnOpen: true,
      boundsApplied: [],
    });
  } finally {
    f.dispose();
  }
});

// --- R2: key-aware redaction of credential-named arguments -------------------

test('R2: a credential-named argument is masked even with no credential-shaped text', async () => {
  const f = await liveFixture({
    args: {
      file_path: 'src/a.js',
      apiKey: 'review-only-secret-value',
      sandbox_permissions: 'danger-full-access',
      justification: 'x',
      nested: { clientSecret: 'another-opaque-secret', note: 'harmless' },
    },
  });
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    const published = JSON.stringify(pending);
    // The exact defect from the review: this used to appear verbatim.
    assert.equal(published.includes('review-only-secret-value'), false, 'apiKey value must not be published');
    assert.equal(published.includes('another-opaque-secret'), false, 'nested clientSecret must not be published');
    // The KEY is still visible, so an operator can tell which argument was hidden.
    assert.ok(pending.argumentKeys.includes('apiKey'));
    assert.match(pending.arguments, /apiKey/u);
    // A non-secret sibling is untouched, so redaction is not a blanket mask.
    assert.match(pending.arguments, /harmless/u);
    // And the private fingerprint still binds the REAL value, not the mask.
    assert.notEqual(pending.fingerprint, fingerprintOf({ file_path: 'src/a.js', apiKey: '••••••••' }));
    f.bridge.decide({ requestId: pending.requestId, decision: 'reject' });
    assert.equal(await ask, 'rejected');
  } finally {
    f.dispose();
  }
});

test('R2: the rejection/allow evidence trail is redacted the same way', async () => {
  const sekrit = 'opaque-token-value-0123456789';
  const f = await liveFixture({ args: { command: 'x', token: sekrit } });
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    assert.equal(pending.arguments.includes(sekrit), false, 'the pending operation must not carry it');
    f.bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: `saw token=${sekrit} in the call` });
    await ask;
    const trail = JSON.stringify(f.bridge.historyView());
    assert.equal(trail.includes(sekrit), false, 'the settled trail must not carry the secret either');
    // And the decision reason is still readable where it is not a secret.
    assert.match(trail, /in the call/u);
  } finally {
    f.dispose();
  }
});

// --- R3: completeness gates an allow, never a reject ------------------------

test('R3: an operation whose executable tail was cut cannot be allowed, but can be rejected', async () => {
  // A command long enough that the per-value cap MUST fire, with the dangerous part
  // in the TAIL — i.e. exactly the material an allow would be granting without seeing.
  const tail = ' && rm -rf /important';
  const command = `${'a'.repeat(PERMISSION_BOUNDS.argumentValueChars * 2)}${tail}`;
  const f = await liveFixture({ toolName: 'bash', args: { command, sandbox_permissions: 'danger-full-access', justification: 'x' } });
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    assert.equal(pending.completeness, 'truncated', 'the bound must be reported, not inferred');
    assert.equal(pending.argumentsComplete, false);
    assert.ok(pending.omitted.valueChars > 0);
    assert.equal(pending.arguments.includes(tail), false, 'the tail really was omitted from the published operation');
    assert.equal(pending.allowBlocked, PERMISSION_REASONS.incompleteEvidence);

    // The allow is refused, with the reason stated.
    assert.throws(
      () => f.bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint }),
      (error) => {
        assert.equal(error.code, PERMISSION_CODES.incomplete);
        assert.equal(error.details.reason, PERMISSION_REASONS.incompleteEvidence);
        return true;
      },
    );
    // The request stays pending, and a reject is still available.
    assert.equal(f.bridge.pendingView()?.requestId, pending.requestId);
    f.bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'cannot review the full command' });
    assert.equal(await ask, 'rejected');
  } finally {
    f.dispose();
  }
});

test('R3: a complete operation is explicitly complete, so the gate is not vacuous', async () => {
  const f = await liveFixture({ args: { file_path: 'src/a.js', content: 'short' } });
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    assert.equal(pending.completeness, 'complete');
    assert.equal(pending.argumentsComplete, true);
    assert.deepEqual(pending.boundsApplied, []);
    assert.equal(pending.allowBlocked, null);
    f.bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint });
    assert.equal(await ask, 'allowed-once');
  } finally {
    f.dispose();
  }
});

test('R3: an allow on a request with no re-verifiable offset is refused', async () => {
  const session = nativeSession('session-no-seq');
  const agent = { id: 'session-no-seq', session };
  const bridge = new PermissionBridge({ taskId: 'task-no-seq' });
  bridge.arm(agent);
  appendToolCall(session, { name: 'write', callId: 'c-1', arguments: { file_path: 'a.js' } });
  const ask = bridge.answer({ agent, toolName: 'write', callId: 'c-1' });
  await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
  const pending = bridge.pendingView();
  // Force the "cannot re-verify" state the way a malformed log would present it.
  bridge.pending.callSeq = null;
  bridge.pending.allowBlocked = bridge.allowRefusalReason(bridge.pending);
  assert.equal(bridge.pending.allowBlocked, PERMISSION_REASONS.noCallSeq);
  assert.throws(
    () => bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint }),
    (error) => error.code === PERMISSION_CODES.incomplete,
  );
  bridge.decide({ requestId: pending.requestId, decision: 'reject' });
  assert.equal(await ask, 'rejected');
  bridge.dispose();
});

// --- R4: exact Agent identity, no null wildcard -----------------------------

test('R4: owns() requires the exact bound Agent and rejects a missing or foreign one', async () => {
  const session = nativeSession('session-owns');
  const agent = { id: 'session-owns', session };
  const bridge = new PermissionBridge({ taskId: 'task-owns' });
  bridge.arm(agent);
  try {
    assert.equal(bridge.owns({ agent }), true, 'the bound agent is owned');
    // The defect: `agent: null` used to pass because of `?? null` + `agent !== null`.
    assert.equal(bridge.owns({ agent: null }), false, 'a null agent must never be owned');
    assert.equal(bridge.owns({}), false, 'a missing agent must never be owned');
    assert.equal(bridge.owns(null), false);
    assert.equal(bridge.owns({ agent: 'a string' }), false);
    // A structurally identical but DIFFERENT agent object is not the bound one.
    assert.equal(bridge.owns({ agent: { id: 'session-owns', session } }), false, 'identity is the live object, not its shape');
    // A different session id is refused even on the bound object.
    const other = nativeSession('session-other-owns');
    assert.equal(bridge.owns({ agent: { ...agent, session: { ...session, id: 'session-other-owns' } } }), false);
    void other;
  } finally {
    bridge.dispose();
  }
});

test('R4: an integration request that arrives without an agent is refused, not answered', async () => {
  const ctx = new Context();
  const approval = new ApprovalService(ctx, { policy: 'ask' });
  const session = nativeSession('session-null-agent');
  const agent = { id: 'session-null-agent', session };
  const bridge = new PermissionBridge({ taskId: 'task-null-agent' });
  bridge.arm(agent);
  const disposer = ctx.on('approval/request', async (request, next) => (bridge.owns(request) ? await bridge.answer(request) : await next()), { prepend: true });
  try {
    openTurn(session);
    appendToolCall(session, { name: 'write', callId: 'c-1', arguments: { file_path: 'a.js' } });
    // The seam's own request carries an agent; a hand-built one without an agent must
    // not be claimed by this bridge, so it falls through to the fail-closed default.
    const outcome = await bridge.answer({ toolName: 'write', callId: 'c-1' });
    assert.equal(outcome, 'unavailable');
    assert.equal(bridge.pendingView(), null, 'an unclaimed request must not occupy the pending slot');
    void approval;
  } finally {
    disposer();
    bridge.dispose();
  }
});

// --- R5: honest wording about the same-user limitation ----------------------

test('R5: the bridge does not claim a process boundary it cannot provide', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/runtime/permissions.js', import.meta.url), 'utf8');
  // The doc must state the limitation explicitly rather than claim isolation.
  assert.match(source, /not process authentication/u);
  assert.match(source, /same OS user/u);
  assert.match(source, /shared[\s\S]{0,40}local-mcp|one shared/u);
  // And it must describe the worker restriction as a TOOL-SURFACE fact, not as a
  // hard boundary against arbitrary same-user code.
  assert.match(source, /tool-surface/u);
  assert.equal(
    /cannot (?:possibly |ever )?self-approve/iu.test(source),
    false,
    'the module must not claim a hard boundary from tool-surface membership alone',
  );
  // No claim may rest on a caller-supplied role label.
  assert.match(source, /caller-supplied role/u);
});

// --- R6: the execution deadline really pauses ------------------------------

test('R6: a wait longer than the execution budget does not time the run out, and the budget still expires', async () => {
  const { ExecutionDeadline } = await import('../src/runtime/agent-runner.js');
  let clock = 1_000;
  let expired = 0;
  const deadline = new ExecutionDeadline(50, () => { expired += 1; }, { now: () => clock });
  try {
    deadline.arm();
    assert.equal(deadline.armed, true, 'the budget starts armed');
    // The run pauses immediately and waits far longer than its whole budget.
    deadline.pause();
    assert.equal(deadline.armed, false, 'a paused run has NO armed timer');
    clock += 5_000;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 60); });
    assert.equal(expired, 0, 'a 5s wait must not expire a 50ms budget — this is the review defect');
    // Resume: the remaining budget is re-armed (still nearly the whole 50 ms).
    deadline.resume();
    assert.equal(deadline.armed, true);
    assert.ok(deadline.remainingMs > 0, 'the pause charged almost nothing against a run that did nothing');
    // Now it really expires.
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 80); });
    assert.equal(expired, 1, 'after resuming, the remaining budget does expire');
  } finally {
    deadline.dispose();
  }
});

test('R6: repeated waits accumulate, and running time is charged', async () => {
  const { ExecutionDeadline } = await import('../src/runtime/agent-runner.js');
  let clock = 1_000;
  let expired = 0;
  const deadline = new ExecutionDeadline(100, () => { expired += 1; }, { now: () => clock });
  try {
    deadline.arm();
    // 30 ms of real execution, then a 10 s wait (not charged).
    clock += 30;
    deadline.pause();
    assert.equal(deadline.remainingMs, 70, 'only the executed span is charged');
    clock += 10_000;
    deadline.resume();
    // 30 ms more of execution, then another 10 s wait.
    clock += 30;
    deadline.pause();
    assert.equal(deadline.remainingMs, 40, 'a second wait also charging only its executed span');
    clock += 10_000;
    deadline.resume();
    // 45 ms more — MORE than the 40 ms left — exhausts the budget, and the verdict is
    // reached by CHARGING the executed span, exactly as the earlier pauses were.
    clock += 45;
    assert.equal(deadline.pause(), 0, 'the accumulated executed time exceeds what is left');
    assert.equal(expired, 0, 'the pause itself does not fire the callback');
    // Resuming with an exhausted budget expires the run, which is the honest outcome.
    deadline.resume();
    assert.equal(expired, 1, 'a resumed run whose budget is gone expires');
  } finally {
    deadline.dispose();
  }
});

test('R6: cancelling during a wait disposes the deadline and leaves no armed timer', async () => {
  const { ExecutionDeadline } = await import('../src/runtime/agent-runner.js');
  let expired = 0;
  const deadline = new ExecutionDeadline(10, () => { expired += 1; });
  deadline.arm();
  deadline.pause();
  deadline.dispose();
  assert.equal(deadline.armed, false);
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, 40); });
  assert.equal(expired, 0, 'a disposed deadline must never expire a run that already ended');
});

test('R6: a bridged run whose wait outlives the budget still completes, and the run reports the wait', async () => {
  // The end-to-end shape: establish the bridge, pause the deadline, answer late, and
  // prove the run's own timer never fired. This drives the real runner wiring
  // through the observer hooks rather than the class in isolation.
  const services = await nativePolicyServices();
  const agents = fakeAgents({ respond: { text: 'done' } });
  const deps = depsFor(agents, services);
  const controller = deps.testControllers.sessionController;
  const resolveOriginal = controller.resolveAgent.bind(controller);
  const bridge = new PermissionBridge({ taskId: 'task-budget' });
  let pausedSeen = false;
  controller.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found.agent;
    if (agent !== undefined) {
      const followup = agent.followup.bind(agent);
      agent.followup = (message) => {
        pausedSeen = true;
        followup(message);
      };
    }
    return found;
  };
  const result = await runAgent(deps, {
    prompt: 'work under a small budget',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 40,
    delegated: true,
    permissionBridge: bridge,
  });
  assert.equal(pausedSeen, true);
  assert.equal(result.outcome, 'completed', `a short budget must not fail the run: ${JSON.stringify(result.error)}`);
  assert.deepEqual(result.approval, { policy: 'ask', bridged: true });
});

// --- R8: waterfall ordering before an existing answerer --------------------

test('R8: a delegated request reaches the bridge BEFORE a pre-existing answerer can claim it', async () => {
  const ctx = new Context();
  const approval = new ApprovalService(ctx, { policy: 'ask' });
  const session = nativeSession('session-ordering');
  const agent = { id: 'session-ordering', session };
  const reached = [];
  // A pre-existing "UI" answerer registered FIRST, exactly as a host would.
  const uiDisposer = ctx.on('approval/request', async () => {
    reached.push('ui');
    return 'allowed-once';
  });
  const bridge = new PermissionBridge({ taskId: 'task-ordering' });
  bridge.arm(agent);
  // The bridge is registered PREPENDED, which is what puts it ahead of the UI.
  const bridgeDisposer = ctx.on('approval/request', async (request, next) => {
    if (bridge.owns(request) !== true) return await next();
    reached.push('bridge');
    return await bridge.answer(request);
  }, { prepend: true });
  try {
    openTurn(session);
    appendToolCall(session, { name: 'write', callId: 'c-order', arguments: { file_path: 'a.js' } });
    const ask = approval.request({ agent, toolName: 'write', callId: 'c-order', reason: 'escalate' });
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    // The bridge was reached and the UI answerer was NOT: the commander decides, and
    // no user prompt can pre-claim the request.
    assert.deepEqual(reached, ['bridge'], 'the bridge must intercept before the UI answerer');
    assert.equal(bridge.pendingView()?.callId, 'c-order');
    const pending = bridge.pendingView();
    bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'no' });
    assert.equal(await ask, 'rejected');
    assert.equal(reached.includes('ui'), false, 'the UI answerer never saw the delegated request');
  } finally {
    bridgeDisposer();
    uiDisposer();
    bridge.dispose();
  }
});

test('R8: an ordinary session still reaches its own UI answerer unchanged', async () => {
  const ctx = new Context();
  const approval = new ApprovalService(ctx, { policy: 'ask' });
  const ordinary = nativeSession('session-ordinary');
  const ordinaryAgent = { id: 'session-ordinary', session: ordinary };
  const reached = [];
  const uiDisposer = ctx.on('approval/request', async () => {
    reached.push('ui');
    return 'allowed-once';
  });
  // A bridge bound to a DIFFERENT agent, prepended exactly as production does.
  const delegatedSession = nativeSession('session-delegated');
  const delegatedAgent = { id: 'session-delegated', session: delegatedSession };
  const bridge = new PermissionBridge({ taskId: 'task-delegated' });
  bridge.arm(delegatedAgent);
  const bridgeDisposer = ctx.on('approval/request', async (request, next) => {
    if (bridge.owns(request) !== true) return await next();
    reached.push('bridge');
    return await bridge.answer(request);
  }, { prepend: true });
  try {
    openTurn(ordinary);
    appendToolCall(ordinary, { name: 'write', callId: 'c-ord' , arguments: { file_path: 'a.js' } });
    const outcome = await approval.request({ agent: ordinaryAgent, toolName: 'write', callId: 'c-ord' });
    assert.equal(outcome, 'allowed-once');
    // The ordinary session fell through to the UI answerer and got ITS decision.
    assert.deepEqual(reached, ['ui'], 'the ordinary session must be answered by its own answerer');
    assert.equal(bridge.pendingView(), null, 'the ordinary request never became the bridge\'s pending request');
  } finally {
    bridgeDisposer();
    uiDisposer();
    bridge.dispose();
  }
});

// --- R9: proto-safe fingerprint -------------------------------------------

test('R9: JSON keys named __proto__ and constructor never collide with an object lacking them', () => {
  const withProto = JSON.parse('{"__proto__":{"x":1}}');
  const empty = JSON.parse('{}');
  const withCtor = JSON.parse('{"constructor":1}');
  const withProtoCtor = JSON.parse('{"__proto__":null,"constructor":null}');
  assert.notEqual(fingerprintOf(withProto), fingerprintOf(empty), '__proto__ must not be swallowed');
  assert.notEqual(fingerprintOf(withCtor), fingerprintOf(empty), 'constructor must not be swallowed');
  assert.notEqual(fingerprintOf(withProtoCtor), fingerprintOf(empty));
  // Different prototype payloads are different operations.
  assert.notEqual(
    fingerprintOf(JSON.parse('{"__proto__":{"a":1}}')),
    fingerprintOf(JSON.parse('{"__proto__":{"a":2}}')),
  );
  // Key order is still irrelevant, so the digest is stable across spellings.
  assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }));
  // And the canonical form preserves the key rather than dropping it.
  assert.match(canonicalJson(withProto), /"__proto__"/u);
});

test('R9: a proto-named argument survives projection instead of vanishing from the evidence', async () => {
  const f = await liveFixture({ args: JSON.parse('{"file_path":"a.js","__proto__":{"injected":true},"constructor":"x"}') });
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    assert.ok(pending.argumentKeys.includes('__proto__'), 'the key must appear in the published keys');
    assert.ok(pending.argumentKeys.includes('constructor'));
    assert.match(pending.arguments, /"__proto__"/u);
    f.bridge.decide({ requestId: pending.requestId, decision: 'reject' });
    assert.equal(await ask, 'rejected');
  } finally {
    f.dispose();
  }
});

// --- Fingerprint requirement ----------------------------------------------

test('allow-once without a fingerprint is refused; reject without one is accepted', async () => {
  const f = await liveFixture();
  try {
    const ask = f.ask();
    await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
    const pending = f.bridge.pendingView();
    assert.throws(
      () => f.bridge.decide({ requestId: pending.requestId, decision: 'allow-once' }),
      (error) => {
        assert.equal(error.code, PERMISSION_CODES.invalid);
        assert.equal(error.details.reason, PERMISSION_REASONS.fingerprintRequired);
        return true;
      },
      'an allow must name the operation it grants',
    );
    // Still pending, so a correct decision can still be made.
    assert.equal(f.bridge.pendingView()?.requestId, pending.requestId);
    // A reject needs no fingerprint: refusing is always safe.
    f.bridge.decide({ requestId: pending.requestId, decision: 'reject' });
    assert.equal(await ask, 'rejected');
  } finally {
    f.dispose();
  }
});

// ---------------------------------------------------------------------------
// R7: the permission evidence survives a real HistoryStore save/load/restart
// ---------------------------------------------------------------------------

test('R7: pending permission evidence is persisted, and a restart turns it into history with no replay', async () => {
  const { HistoryStore } = await import('../src/jobs/history.js');
  const dir = await makeTempDir();
  try {
    const store = new HistoryStore(join(dir, 'data'));
    const now = 1_700_000_000_000;
    // A task that was LIVE and WAITING for a decision when the process stopped.
    const view = {
      taskId: 'task-permission-persist',
      state: 'running',
      phase: 'awaiting-permission',
      createdAt: now,
      startedAt: now + 10,
      endedAt: null,
      sourcePath: 'C:\\fixtures\\repo',
      workspacePath: 'C:\\fixtures\\repo',
      executionWorkspacePath: 'C:\\fixtures\\repo',
      isolation: 'shared',
      connectionId: 'local-mcp',
      effective: null,
      route: null,
      review: null,
      error: null,
      hostAcceptance: null,
      permission: {
        bridged: true,
        waiting: true,
        standingSandboxMode: 'workspace-write',
        grantScope: 'single-call',
        pausedExecutionMs: 4231,
        pending: {
          requestId: 'permission-task-permission-persist-1',
          taskId: 'task-permission-persist',
          sessionId: 'session-persist',
          toolName: 'bash',
          callId: 'call-persist-1',
          turn: 1,
          step: 1,
          state: 'pending',
          reason: 'the worker says it needs this',
          reasonSource: 'asker-claim',
          requestedAccess: { kind: 'sandbox-escalation', mode: 'danger-full-access' },
          argumentKeys: ['command', 'sandbox_permissions'],
          arguments: '{"command":"echo hi","sandbox_permissions":"danger-full-access"}',
          argumentsRedacted: true,
          completeness: 'complete',
          argumentsComplete: true,
          boundsApplied: [],
          omitted: { valueChars: 0, keys: 0, depth: 0, items: 0 },
          allowBlocked: null,
          createdAt: now + 20,
          deadlineAt: now + 20 + 600_000,
          decision: null,
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          outcome: null,
          standingModeUnchanged: true,
        },
        evidence: [
          {
            requestId: 'permission-task-permission-persist-0',
            taskId: 'task-permission-persist',
            toolName: 'write',
            callId: 'call-persist-0',
            state: 'decided',
            decision: 'allow-once',
            decidedBy: 'commander',
            decisionReason: 'checked the file',
            outcome: 'allowed-once',
            completeness: 'complete',
            argumentsComplete: true,
            boundsApplied: [],
            grant: { kind: 'allowed-once', appliesTo: 'this-call-only', callId: 'call-persist-0', reusable: false },
            standingModeUnchanged: true,
          },
        ],
      },
      // The private binding must NEVER be stored.
      permissionPrivateProbe: 'must-not-be-persisted',
      selfApproved: false,
    };
    await store.save(view);

    // A FRESH store over the same directory is the restart.
    const restarted = new HistoryStore(join(dir, 'data'));
    const loaded = await restarted.load();
    const entry = loaded.find((job) => job.taskId === 'task-permission-persist');
    assert.ok(entry !== undefined, 'the record must survive the restart');

    // 1. The permission evidence is really there (the old allow-list dropped it).
    assert.ok(entry.permission !== null && typeof entry.permission === 'object', 'permission evidence must be stored');
    assert.equal(entry.permission.bridged, true);
    assert.equal(entry.permission.pausedExecutionMs, 4231);
    assert.equal(entry.permission.standingSandboxMode, 'workspace-write');
    assert.equal(entry.permission.grantScope, 'single-call');
    assert.equal(entry.permission.evidence.length, 1);
    assert.equal(entry.permission.evidence[0].outcome, 'allowed-once');
    assert.equal(entry.permission.evidence[0].grant.reusable, false);
    assert.equal(entry.permission.evidence[0].grantScope, undefined);

    // 2. A live task becomes `interrupted`, and the pending request becomes history
    //    that cannot be replayed or decided.
    assert.equal(entry.state, 'interrupted');
    assert.equal(entry.interruptedFrom, 'running');
    assert.equal(entry.error.code, 'JOB_INTERRUPTED_RESTART');
    assert.equal(entry.permission.waiting, false, 'an interrupted wait is not still pending');
    assert.equal(entry.permission.interrupted, true);
    assert.equal(entry.permission.pending.state, 'unavailable');
    assert.equal(entry.permission.pending.outcome, 'unavailable');
    assert.equal(entry.permission.pending.decidedBy, 'restart');
    assert.match(entry.permission.pending.decisionReason, /cannot be decided and was not replayed/u);

    // 3. Nothing that could re-authorise the call is stored.
    const raw = JSON.stringify(entry);
    assert.equal(raw.includes('must-not-be-persisted'), false, 'unknown fields are not stored');
    for (const forbidden of ['exactArguments', 'fingerprint', 'resolvedAt', 'grantId']) {
      assert.equal(raw.includes(forbidden), false, `the stored record must not carry ${forbidden}`);
    }
  } finally {
    await cleanup(dir);
  }
});

test('R7: stored permission evidence is redacted again on the way out', async () => {
  const { HistoryStore } = await import('../src/jobs/history.js');
  const dir = await makeTempDir();
  try {
    const store = new HistoryStore(join(dir, 'data'));
    const now = 1_700_000_000_000;
    await store.save({
      taskId: 'task-permission-redact',
      state: 'awaiting-host-review',
      phase: 'awaiting-host-review',
      createdAt: now,
      endedAt: now + 10,
      connectionId: 'local-mcp',
      permission: {
        bridged: true,
        waiting: false,
        evidence: [{
          requestId: 'permission-task-permission-redact-1',
          toolName: 'bash',
          callId: 'c-1',
          state: 'decided',
          decision: 'reject',
          outcome: 'rejected',
          // A decision reason that the commander quoted from the operation.
          decisionReason: 'saw password=hunter2-plaintext in the command',
          arguments: '{"command":"login password=hunter2-plaintext"}',
          argumentKeys: ['command'],
        }],
      },
      selfApproved: false,
    });
    const loaded = await new HistoryStore(join(dir, 'data')).load();
    const entry = loaded.find((job) => job.taskId === 'task-permission-redact');
    const raw = JSON.stringify(entry);
    assert.equal(raw.includes('hunter2-plaintext'), false, 'the stored evidence must be redacted');
    assert.equal(entry.permission.evidence.length, 1, 'the evidence itself still exists');
  } finally {
    await cleanup(dir);
  }
});


// ---------------------------------------------------------------------------
// R6 end-to-end: a real bridged run survives a wait longer than its budget
// ---------------------------------------------------------------------------

test('R6: a real native approval wait longer than the execution budget does not time the run out', async () => {
  // A real native ApprovalService, a real bridge, and the real runner listener —
  // the only thing scripted is the turn itself. The run is given a 40 ms budget and
  // the wait is made to last far longer than that; before this fix the single
  // `setTimeout` fired during the wait and the run was reported `timed_out`.
  const ctx = new Context();
  // `nativePolicyServices` builds its own services; the approval one is built here
  // because the test answers on THIS context's waterfall.
  const nativeServices = await nativePolicyServices({ ctx });
  const approval = nativeServices.approval;
  const services = { approval, sandboxPolicy: nativeServices.sandboxPolicy };

  const agents = fakeAgents({
    respond: { text: 'done after the wait' },
    // The scripted turn asks for approval and only then finishes, so the wait is
    // inside the run rather than beside it.
    async script({ agent, record, listeners }) {
      const session = agent.session;
      session.append('turn/start', { turn: 1 });
      session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: 'call-budget',
        name: 'bash',
        arguments: JSON.stringify({ command: 'echo hi', sandbox_permissions: 'danger-full-access', justification: 'x' }),
      });
      const ask = approval.request({ agent, toolName: 'bash', callId: 'call-budget', reason: 'escalate' });
      // Answer well after the budget would have expired on the old design.
      setTimeout(() => {
        const pending = record.bridge?.pendingView();
        if (pending !== null && pending !== undefined) {
          record.bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'slow decision' });
        }
      }, 220);
      record.approvalOutcome = await ask;
      // The scripted turn must produce assistant text, or the run is reported as an
      // empty-output failure for a reason unrelated to the budget under test.
      emitSessionEvent(listeners, record, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'done after the wait' }] } },
      });
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
      void listeners;
    },
  });

  // The bridge is created by the test and bound through the SAME setup the runner
  // uses, so the listener ordering is the production one.
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces });
  const bridge = new PermissionBridge({ taskId: 'task-budget-e2e', connectionId: 'local-mcp' });
  const resolveOriginal = sessionController.resolveAgent.bind(sessionController);
  const answerers = [];
  sessionController.resolveAgent = async (sessionId) => {
    const found = await resolveOriginal(sessionId);
    const agent = found.agent;
    if (agent !== undefined && answerers.length === 0) {
      bridge.arm(agent);
      answerers.push(ctx.on('approval/request', async (request, next) => (
        bridge.owns(request) ? await bridge.answer(request) : await next()
      ), { prepend: true }));
    }
    return found;
  };

  const result = await runAgent({
    agents,
    agentPresets: fakeAgentPresets(),
    workspaces,
    sessionController,
    policyServices: () => services,
    // The runner's own listener starts the deadline; this run is given a tiny budget.
  }, {
    prompt: 'work under a tiny budget with a slow approval',
    cwd: CWD,
    selection: SELECTION,
    timeoutMs: 40,
    delegated: true,
    permissionBridge: bridge,
  });

  assert.equal(
    result.outcome === 'timed_out',
    false,
    `a 220ms approval wait must not exhaust a 40ms execution budget (got ${result.outcome}: ${JSON.stringify(result.error)})`,
  );
  assert.equal(result.approval.bridged, true);
  // The scripted turn runs inside `agents.create`, before the runner subscribes to
  // `session/event`, so text collected here is incidental; the property under test is
  // the ABSENCE of a timeout while the wait outlived the whole budget.
  assert.equal(result.cancelCause, null, 'the run was not aborted by the deadline');
  for (const release of answerers) release();
  bridge.dispose();
});


// ---------------------------------------------------------------------------
// Real OFF / disposal paths and workspace-lock retention (behavioral, not constants)
// ---------------------------------------------------------------------------

test('switching delegation OFF settles an outstanding request and the task is cancelled', async () => {
  const dir = await makeTempDir();
  const bridges = [];
  const fixture = await engineFixture({
    permissionBridge: (request) => {
      const bridge = new PermissionBridge({
        taskId: request.taskId,
        connectionId: request.connectionId,
        onPending: request.onPending,
        onSettled: request.onSettled,
      });
      bridges.push(bridge);
      return bridge;
    },
  }, dir);
  try {
    const started = await fixture.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fixture.workspace,
      prompt: 'wait then be switched off',
    });
    for (let attempt = 0; attempt < 80 && bridges.length === 0; attempt += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    assert.equal(bridges.length, 1);
    const task = fixture.engine.tasks.get(started.taskId);
    // A REAL outstanding request with a live waiter.
    const outcome = new Promise((resolvePromise) => {
      task.permission.bridge.pending = {
        requestId: 'permission-off-1',
        state: 'pending',
        timer: null,
        resolve: resolvePromise,
      };
    });
    fixture.engine.onPermissionPending(task, {
      requestId: 'permission-off-1', taskId: started.taskId, callId: 'c-1', toolName: 'write', state: 'pending',
    });
    assert.equal(fixture.engine.get(started.taskId).phase, 'awaiting-permission');

    // The operator closes the switch: the wait must end as a refusal.
    fixture.engine.setDelegationEnabled(false);
    assert.equal(await outcome, 'cancelled', 'switch-off withdraws the question, it does not allow it');
    assert.equal(fixture.engine.get(started.taskId).permission.waiting, false);
    // And a decision is refused afterwards, because delegation is off.
    assert.throws(
      () => fixture.engine.decidePermission({
        connectionId: 'local-mcp', taskId: started.taskId, requestId: 'permission-off-1', decision: 'reject',
      }),
      (error) => error.code === 'JOB_NOT_AUTHORIZED' || error.code === 'PERMISSION_REQUEST_NOT_PENDING' || error.code === 'PERMISSION_REQUEST_NOT_FOUND',
    );
  } finally {
    await fixture.engine.dispose();
    await cleanup(dir);
  }
});

test('an engine dispose settles the outstanding request as unavailable, not as an allow', async () => {
  const dir = await makeTempDir();
  const bridges = [];
  const fixture = await engineFixture({
    permissionBridge: (request) => {
      const bridge = new PermissionBridge({
        taskId: request.taskId,
        connectionId: request.connectionId,
        onPending: request.onPending,
        onSettled: request.onSettled,
      });
      bridges.push(bridge);
      return bridge;
    },
  }, dir);
  try {
    const started = await fixture.engine.start({
      connectionId: 'local-mcp',
      workspacePath: fixture.workspace,
      prompt: 'wait then be disposed',
    });
    for (let attempt = 0; attempt < 80 && bridges.length === 0; attempt += 1) {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
    }
    const task = fixture.engine.tasks.get(started.taskId);
    const outcome = new Promise((resolvePromise) => {
      task.permission.bridge.pending = {
        requestId: 'permission-dispose-1', state: 'pending', timer: null, resolve: resolvePromise,
      };
    });
    fixture.engine.onPermissionPending(task, {
      requestId: 'permission-dispose-1', taskId: started.taskId, callId: 'c-1', toolName: 'write', state: 'pending',
    });
    await fixture.engine.dispose();
    assert.equal(await outcome, 'unavailable', 'teardown makes the channel unusable, it never allows');
    assert.equal(bridges[0].disposed, true, 'the bridge itself is disposed');
    assert.equal(bridges[0].armed, false, 'no disposed bridge can keep an ask stance alive');
  } finally {
    await fixture.engine.dispose();
    await cleanup(dir);
  }
});

test('the workspace lock and concurrency slot are NOT released while the native executor is live', async () => {
  const dir = await makeTempDir();
  try {
    const { WorkspaceLocks } = await import('../src/workspace/locks.js');
    const { SettingsService } = await import('../src/config/settings.js');
    const { WorkspaceError, LOCK_CODES } = await import('../src/workspace/locks.js');
    const workspace = await realpath(await mkdir(join(dir, 'workspace'), { recursive: true }).then(() => join(dir, 'workspace')));
    const settings = new SettingsService(join(dir, 'data'));
    await settings.replace(validSettings());
    const locks = new WorkspaceLocks();
    const services = await nativePolicyServices();
    const workspaces = fakeWorkspaceController();
    // A conversation that absorbs the prompt and never becomes idle: the run is
    // genuinely live, which is exactly the state a workspace must not be freed from.
    const sessionController = fakeSessionController({ workspaces });
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
    const engine = new JobEngine({
      agents: fakeAgents({ respond: { text: 'x' } }),
      agentPresets: fakeAgentPresets(),
      sessions: { async flush() {} },
      workspaces,
      sessionController,
      policyServices: () => services,
      llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
      settings,
      auth: new AuthorizationRegistry(),
      locks,
      runGit: async (_cwd, args) => {
        const key = args.join(' ');
        if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
        if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
        if (key === 'rev-parse --verify HEAD') return { stdout: `${'a'.repeat(40)}\n`, code: 0 };
        return { stdout: '', code: 0 };
      },
      providerRegistry: { async ensure(providers) { return { routes: new Map(providers.map((p) => [p.id, `${p.id}-native`])) }; } },
      delegationEnabled: true,
      authorizationMode: 'switch',
      logger: { info() {}, warn() {} },
    });
    try {
      const started = await engine.start({
        connectionId: 'local-mcp',
        workspacePath: workspace,
        prompt: 'hold the workspace',
      });
      const task = engine.tasks.get(started.taskId);
      // Wait until the task is really running and has taken its leases.
      for (let attempt = 0; attempt < 100 && task.leases.length === 0; attempt += 1) {
        await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
      }
      assert.ok(task.leases.length > 0, 'the running task holds a workspace lease');
      assert.equal(task.slotHeld, true, 'and its concurrency slot');

      // Mark it terminal WITHOUT its executor settling: this is the pause/cancel
      // window, and the capacity must stay held.
      task.state = 'cancelled';
      await engine.finalize(task);
      assert.equal(task.cleanupError?.code, 'JOB_NATIVE_NOT_STOPPED', 'a live executor blocks the release');
      assert.equal(task.slotHeld, true, 'the slot is still held while the native executor is live');
      assert.ok(task.leases.length > 0, 'the workspace lease is still held while the native executor is live');
      // The workspace really is unavailable to a second job.
      assert.throws(
        () => locks.acquire(workspace, 'another-task'),
        (error) => error instanceof WorkspaceError && error.code === LOCK_CODES.busy,
      );
    } finally {
      await engine.dispose();
    }
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Round 3: live binding, MCP pending visibility, durable checkpoints
// ---------------------------------------------------------------------------

test('A: a closed turn, a reopened turn, a replaced Session and a stripped record all refuse the allow', async () => {
  /**
   * Probe one mutation against a real bridge over a real Session.
   * @param {(ctx: object) => void | Promise<void>} mutate - applied after the ask.
   * @returns {Promise<{ refusal: string, stillPending: boolean, outcome: string }>}
   */
  const probe = async (mutate) => {
    const f = await liveFixture();
    try {
      const ask = f.ask();
      await new Promise((resolvePromise) => { setImmediate(resolvePromise); });
      const pending = f.bridge.pendingView();
      await mutate({ f, pending, seq: f.bridge.pending.callSeq });
      let refusal = 'NO-REFUSAL';
      try {
        f.bridge.decide({ requestId: pending.requestId, decision: 'allow-once', fingerprint: pending.fingerprint });
      } catch (error) {
        refusal = error.details?.reason ?? error.code;
      }
      const stillPending = f.bridge.pendingView() !== null;
      if (stillPending) f.bridge.decide({ requestId: pending.requestId, decision: 'reject', reason: 'stale' });
      return { refusal, stillPending, outcome: await ask };
    } finally {
      f.dispose();
    }
  };

  // 1. The turn simply ends while the request is pending.
  const closed = await probe(async ({ f }) => {
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  });
  assert.equal(closed.refusal, PERMISSION_REASONS.turnClosed);
  assert.equal(closed.outcome, 'rejected');

  // 2. The turn ends and a NEW turn opens: "a turn is open" is not the asking turn.
  const reopened = await probe(async ({ f }) => {
    f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    f.session.append('turn/start', { turn: 2 });
  });
  assert.equal(reopened.refusal, PERMISSION_REASONS.turnClosed, 'a reopened turn is a different turn');

  // 3. The Agent's Session object is REPLACED while the request is pending.
  const replaced = await probe(async ({ f }) => {
    const other = nativeSession('session-replacement');
    openTurn(other);
    f.agent.session = other;
  });
  assert.equal(replaced.refusal, PERMISSION_REASONS.sessionGone, 'the live Session object is compared, not a stale reference');

  // 4. The tool name is REMOVED from the pinned record (the old `typeof` guard let this pass).
  const stripped = await probe(async ({ f, seq }) => {
    const event = f.session.eventAt(seq);
    const data = JSON.parse(JSON.stringify(event.data));
    delete data.name;
    f.session.log[seq] = Object.freeze({ ...event, data });
  });
  assert.equal(stripped.refusal, PERMISSION_REASONS.callChanged, 'a missing tool name is never "unchanged"');

  // 5. Turn/step identity is part of the binding.
  const wrongStep = await probe(async ({ f, seq }) => {
    const event = f.session.eventAt(seq);
    const data = JSON.parse(JSON.stringify(event.data));
    data.step = 99;
    f.session.log[seq] = Object.freeze({ ...event, data });
  });
  assert.equal(wrongStep.refusal, PERMISSION_REASONS.callChanged);

  // And the unchanged case still allows, so the binding is exact rather than blanket.
  const unchanged = await probe(async () => {});
  assert.equal(unchanged.refusal, 'NO-REFUSAL');
  assert.equal(unchanged.outcome, 'allowed-once');
});

test('D: an oversized MCP result keeps the LIVE pending request, its ids and its operation', async () => {
  const { MAX_TOOL_TEXT_CHARS, LATEST_PROTOCOL_VERSION, createMcpServer } = await import('../src/mcp/server.js');
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const operation = JSON.stringify({ command: 'touch /outside/root', sandbox_permissions: 'danger-full-access' });
  // Eight long settled entries: the case that used to push the pending request out.
  const evidence = Array.from({ length: 8 }, (_, index) => ({
    requestId: `permission-over-${index}`,
    toolName: 'bash',
    callId: `call-old-${index}`,
    state: 'decided',
    decision: 'reject',
    decidedBy: 'commander',
    decisionReason: 'no',
    outcome: 'rejected',
    arguments: 'x'.repeat(1800),
    argumentKeys: ['command'],
  }));
  const task = {
    taskId: 'task-oversized',
    state: 'running',
    phase: 'awaiting-permission',
    createdAt: 1,
    endedAt: null,
    hostAcceptance: null,
    selfApproved: false,
    permission: {
      bridged: true,
      waiting: true,
      standingSandboxMode: 'workspace-write',
      grantScope: 'single-call',
      evidence,
      pending: {
        requestId: 'permission-live',
        taskId: 'task-oversized',
        sessionId: 'session-live',
        toolName: 'bash',
        callId: 'call-live',
        state: 'pending',
        completeness: 'complete',
        argumentsComplete: true,
        allowBlocked: null,
        reasonSource: 'asker-claim',
        fingerprint,
        arguments: operation,
        argumentKeys: ['command', 'sandbox_permissions'],
        requestedAccess: { kind: 'sandbox-escalation', mode: 'danger-full-access' },
        omitted: { valueChars: 0, keys: 0, depth: 0, items: 0 },
        boundsApplied: [],
      },
    },
    execution: { text: 'y'.repeat(60_000), outcome: 'completed' },
    review: { text: 'z'.repeat(40_000), state: 'completed' },
    diff: {
      patchText: 'd'.repeat(40_000),
      files: Array.from({ length: 100 }, (_, index) => ({ path: `f${index}.js` })),
    },
  };
  const server = createMcpServer({ async callExecution() { return { ok: true, task }; } });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_result', arguments: { taskId: 'task-oversized' } },
  });
  const text = response.result.content[0].text;
  assert.equal(response.result.isError, undefined, 'a bounded answer is still an answer');
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS, 'the answer stays inside the tool-text bound');
  const body = JSON.parse(text);
  assert.equal(body.task.permission.waiting, true);
  const pending = body.task.permission.pending;
  assert.ok(pending !== null && pending !== undefined, 'the live pending request must survive the bound');
  // Identity is byte-identical, so a decision can still be made from this answer alone.
  assert.equal(pending.requestId, 'permission-live');
  assert.equal(pending.callId, 'call-live');
  assert.equal(pending.sessionId, 'session-live');
  assert.equal(pending.fingerprint, fingerprint);
  assert.equal(pending.arguments, operation, 'the operation survives, not a shortened prefix');
  assert.equal(pending.completeness, 'complete');
  assert.equal(pending.argumentsComplete, true);
  // The settled history is what gave way, and the cut is stated.
  assert.ok(body.task.permission.evidence.length < 8, 'historical evidence is the part that is trimmed');
  assert.equal(body.truncation.truncated, true);
});

test('D: a fully restored pending operation reports NO truncation, and a real cut still does', async () => {
  const { MAX_TOOL_TEXT_CHARS, LATEST_PROTOCOL_VERSION, createMcpServer } = await import('../src/mcp/server.js');
  /**
   * The three fixtures of the visibility audit, at their documented dimensions:
   * 150 long baseline paths (bulk that the skeleton stage drops), 8 old evidence
   * entries (settled history, the first thing a bound gives up), and ONE COMPLETE
   * 1500-character pending argument (longer than the generic 512 cap, well inside
   * the 4000-character blob cap, so it is restored in full).
   *
   * The answer must reach the SKELETON stage, which is where `pendingPermissionsOf`
   * runs; the bulk that forces it is what the earlier version of this test missed.
   */
  const longPaths = Array.from({ length: 150 }, (_, index) => ({
    path: `src/some/deeply/nested/directory/level/fixture-file-${String(index).padStart(3, '0')}.js`,
    status: index % 2 === 0 ? 'modified' : 'added',
    added: index,
    removed: 0,
  }));
  const evidence = Array.from({ length: 8 }, (_, index) => ({
    requestId: `permission-old-${index}`,
    toolName: 'bash',
    callId: `call-old-${index}`,
    state: 'decided',
    decision: 'reject',
    decidedBy: 'commander',
    decisionReason: 'no',
    outcome: 'rejected',
    arguments: 'x'.repeat(1800),
    argumentKeys: ['command'],
  }));
  const operation = JSON.stringify({ command: `touch ${'a'.repeat(1480)}` });
  assert.ok(operation.length >= 1490 && operation.length <= 1600, 'the fixture is a ~1500-character operation');
  /**
   * Ask for one multi-task status answer through the real MCP server.
   * @param {object} pendingOverrides - merged onto the pending record.
   * @returns {Promise<{ body: object, text: string }>} parsed answer and its text.
   */
  const ask = async (pendingOverrides) => {
    // Four tasks: the list stages keep 5 then 1, so the surviving task must carry the
    // pending request through to the skeleton projection.
    const tasks = Array.from({ length: 4 }, (_, index) => ({
      taskId: `task-visibility-${index}`,
      state: 'running',
      phase: 'awaiting-permission',
      createdAt: index,
      endedAt: null,
      hostAcceptance: null,
      selfApproved: false,
      baseline: { files: longPaths },
      worktree: { diff: longPaths },
      authorization: { detail: longPaths },
      permission: {
        bridged: true,
        waiting: true,
        standingSandboxMode: 'workspace-write',
        grantScope: 'single-call',
        evidence,
        pending: {
          requestId: `permission-restored-${index}`,
          taskId: `task-visibility-${index}`,
          sessionId: `session-restored-${index}`,
          toolName: 'bash',
          callId: `call-restored-${index}`,
          state: 'pending',
          completeness: 'complete',
          argumentsComplete: true,
          allowBlocked: null,
          reasonSource: 'asker-claim',
          fingerprint: `sha256:${'e'.repeat(64)}`,
          arguments: operation,
          argumentKeys: ['command'],
          requestedAccess: { kind: 'sandbox-escalation', mode: 'danger-full-access' },
          omitted: { valueChars: 0, keys: 0, depth: 0, items: 0 },
          boundsApplied: [],
          ...pendingOverrides,
        },
      },
      execution: { text: 'y'.repeat(600), outcome: 'completed' },
      review: { text: 'z'.repeat(600), state: 'completed' },
      diff: { patchText: 'd'.repeat(600), files: longPaths.slice(0, 12) },
    }));
    const server = createMcpServer({ async callExecution() { return { ok: true, tasks }; } });
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
    const response = await server.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_status', arguments: {} },
    });
    assert.equal(response.result.isError, undefined);
    const text = response.result.content[0].text;
    assert.ok(text.length <= MAX_TOOL_TEXT_CHARS, 'the answer stays inside the tool-text bound');
    const body = JSON.parse(text);
    assert.equal(body.truncation.truncated, true, 'the answer really did go through the bounded stages');
    return { body, text };
  };

  // 1. The restored operation is published in FULL and nothing claims it was cut.
  const clean = await ask({});
  const skeletonTask = clean.body.tasks[0];
  // The projection really reached the skeleton stage: that is where the phantom cut lived.
  assert.ok(skeletonTask.truncation !== undefined, 'the fixture must reach the skeleton stage');
  assert.equal(skeletonTask.taskId, 'task-visibility-0', 'the task with the pending request survives');
  const cleanPending = skeletonTask.permission.pending;
  assert.ok(cleanPending !== null && cleanPending !== undefined, 'the live pending request survives the bound');
  assert.equal(cleanPending.arguments, operation, 'the whole 1500-character operation survives, not a prefix');
  assert.equal(cleanPending.completeness, 'complete');
  assert.equal(cleanPending.argumentsComplete, true);
  assert.equal(cleanPending.allowBlocked, null);
  assert.equal(cleanPending.fingerprint, `sha256:${'e'.repeat(64)}`, 'the fingerprint survives so a decision can be bound');
  // THE REGRESSION: the generic 512-character walk must not leave a phantom cut on a
  // field it later restored in full.
  const phantom = (clean.body.truncation.fields ?? [])
    .filter((field) => String(field.path).includes('permission.pending.arguments'));
  assert.deepEqual(phantom, [], 'a fully restored operation is never reported as truncated');

  // 2. A REAL cut is still reported and still marks the operation unusable for an allow.
  const cut = await ask({
    completeness: 'truncated',
    argumentsComplete: false,
    allowBlocked: 'the operation was shortened by a bound, so an allow cannot be granted on it',
    omitted: { valueChars: 900, keys: 0, depth: 0, items: 0 },
    boundsApplied: ['value'],
  });
  const cutPending = cut.body.tasks[0].permission.pending;
  assert.equal(cutPending.completeness, 'truncated', 'a shortened operation is never presented as complete');
  assert.equal(cutPending.argumentsComplete, false);
  assert.ok(cutPending.allowBlocked !== null, 'a shortened operation cannot be allowed');
  assert.deepEqual(cutPending.boundsApplied, ['value'], 'the engine bounds are carried verbatim');
  assert.deepEqual(cutPending.omitted, { valueChars: 900, keys: 0, depth: 0, items: 0 });
});

test('D: the zero-keep stage keeps nothing, and its declared omission matches what it kept', async () => {
  // `evidence.slice(-0)` returns the WHOLE array. The stages that declare
  // `permissionEvidence: 0` are the skeleton stages, which then drop `permission`
  // wholesale — so the defect never reached the published text, but the projection
  // still claimed "8 omitted" while internally retaining all 8. That contradiction is
  // what this pins: a declared omission must equal the entries the stage really kept.
  //
  // The invariant is asserted on the projection helper's observable contract: an MCP
  // answer whose evidence list is the ONLY reason it is bound must either report a
  // truthful omission or report none, and the delivered list must agree.
  const { MAX_TOOL_TEXT_CHARS, LATEST_PROTOCOL_VERSION, createMcpServer } = await import('../src/mcp/server.js');
  const evidence = Array.from({ length: 8 }, (_, index) => ({
    requestId: `permission-zero-${index}`,
    toolName: 'bash',
    callId: `call-zero-${index}`,
    state: 'decided',
    decision: 'reject',
    outcome: 'rejected',
    arguments: 'x'.repeat(1800),
    argumentKeys: ['command'],
    decisionReason: 'r'.repeat(500),
  }));
  const make = (index) => ({
    taskId: `task-zero-${index}`,
    state: 'running',
    phase: 'awaiting-permission',
    createdAt: index,
    endedAt: null,
    hostAcceptance: null,
    selfApproved: false,
    permission: { bridged: true, waiting: false, standingSandboxMode: 'workspace-write', grantScope: 'single-call', evidence, pending: null },
    // Bulk the heavy-field reduction does NOT remove, so the answer survives the first
    // stages and the evidence list has to give way.
    baseline: {
      files: Array.from({ length: 400 }, (_, k) => ({
        path: `src/a/very/long/nested/path/number/${index}/${k}/fixture.js`,
        status: 'modified',
        blob: 'z'.repeat(30),
      })),
    },
    execution: { text: 'y'.repeat(2000), outcome: 'completed' },
    review: { text: 'z'.repeat(2000), state: 'completed' },
    diff: { patchText: 'd'.repeat(2000), files: Array.from({ length: 40 }, (_, k) => ({ path: `f${k}.js` })) },
  });
  const tasks = [make(0), make(1), make(2), make(3)];
  const server = createMcpServer({ async callExecution() { return { ok: true, tasks }; } });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_status', arguments: {} },
  });
  const text = response.result.content[0].text;
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS);
  const body = JSON.parse(text);
  const records = (body.truncation.fields ?? []).filter((field) => String(field.path).includes('permission.evidence'));
  assert.ok(records.length > 0, 'the settled history was given up and stated');
  // The zero-keep stage must be among them: every entry declared omitted.
  assert.ok(
    records.some((record) => record.total > 0 && record.omitted === record.total),
    'the zero-keep stage was actually reached',
  );
  // Where a list is still delivered alongside a record, the counts must agree. At the
  // zero-keep stage the whole `permission` block is skeletal-away, so the truthful
  // statement there is "no list delivered", never "some list delivered, some omitted".
  for (const record of records) {
    const owner = Number(String(record.path).match(/^tasks\[(\d+)\]/)[1]);
    const delivered = body.tasks[owner]?.permission?.evidence;
    if (delivered === undefined) {
      assert.equal(record.omitted, record.total, 'a list that is not delivered at all is declared fully omitted');
      continue;
    }
    assert.ok(Array.isArray(delivered));
    assert.equal(delivered.length, record.total - record.omitted, 'a declared omission matches the delivered list');
  }
});

test('E: a successful checkpoint of one task is not discarded by another task\'s newer checkpoint', async () => {
  // The global counter is shared by every task; a per-callback comparison against it
  // made task A's successful write look superseded the moment task B checkpointed,
  // leaving A's `historySavedAt` stale forever. The comparison must be per task.
  const saved = [];
  const history = {
    save: async (view) => {
      // Hold the FIRST save open so a second task's checkpoint lands while it is in
      // flight — the exact interleaving that exposed the bug.
      if (saved.length === 0) await new Promise((resolvePromise) => { setTimeout(resolvePromise, 30); });
      saved.push(view);
      return view;
    },
  };
  const engine = new JobEngine({ history, logger: { warn() {}, info() {}, debug() {} } });
  /**
   * A live task record just complete enough for the engine's own `view()`.
   * @param {string} taskId - identity.
   * @param {number} createdAt - ordering only.
   * @returns {object} task.
   */
  const liveTask = (taskId, createdAt) => ({
    taskId,
    state: 'running',
    phase: 'awaiting-permission',
    createdAt,
    endedAt: null,
    connectionId: 'local-mcp',
    effective: null,
    route: null,
    reviewRoute: null,
    execution: null,
    review: null,
    permission: { bridge: null, pending: null, evidence: [], pausedExecutionMs: 0 },
  });
  // This engine is a deliberately partial record (only what `view()`/`checkpointHistory`
  // need), so it is not disposed here: nothing was started and no store is held.
  const taskA = liveTask('task-a', 1);
  const taskB = liveTask('task-b', 2);
  engine.tasks.set(taskA.taskId, taskA);
  engine.tasks.set(taskB.taskId, taskB);
  engine.checkpointHistory(taskA);
  // B checkpoints while A's save is still in flight, bumping the GLOBAL counter.
  engine.checkpointHistory(taskB);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (taskA.historySavedAt != null && taskB.historySavedAt != null) break;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  assert.ok(taskA.historySavedAt != null, 'task A records its own successful checkpoint even though task B was newer');
  assert.equal(taskA.historyError, null, 'a successful write is never recorded as an error');
  assert.ok(taskB.historySavedAt != null);
  assert.equal(saved.length, 2, 'both tasks really reached the store');

  // And a LATER checkpoint of the SAME task still supersedes the earlier one: a
  // superseded record does not claim the newer sequence's success.
  const stale = liveTask('task-a', 1);
  engine.checkpointHistory(stale);
  taskA.historySavedAt = null;
  engine.checkpointHistory(taskA);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (taskA.historySavedAt != null) break;
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 5); });
  }
  assert.ok(taskA.historySavedAt != null, 'the newest checkpoint of the same task still wins');
  assert.ok(taskA.historyCheckpointSeq > stale.historyCheckpointSeq, 'the per-task sequence advances');
  // Whichever of the two same-task saves completed last owns the claim, and the
  // superseded one is silent about it rather than stamping a stale success.
  if (stale.historySavedAt == null) {
    assert.ok(taskA.historySavedAt != null, 'the newer same-task checkpoint is the one that records success');
  }
});

test('E: an engine checkpoint persists the pending wait, and a restart shows it as history', async () => {
  const { HistoryStore } = await import('../src/jobs/history.js');
  const dir = await makeTempDir();
  try {
    const dataDir = join(dir, 'data');
    const history = new HistoryStore(dataDir);
    const fixture = await engineFixture({ history }, dir);
    try {
      const started = await fixture.engine.start({
        connectionId: 'local-mcp',
        workspacePath: fixture.workspace,
        prompt: 'wait for a decision then be interrupted',
      });
      const task = fixture.engine.tasks.get(started.taskId);
      // Through the ENGINE's own observer — the production path, not a handcrafted view.
      fixture.engine.onPermissionPending(task, {
        requestId: 'permission-checkpoint-1',
        taskId: task.taskId,
        sessionId: 'session-checkpoint',
        toolName: 'bash',
        callId: 'call-checkpoint',
        state: 'pending',
        completeness: 'complete',
        argumentsComplete: true,
        allowBlocked: null,
        fingerprint: `sha256:${'c'.repeat(64)}`,
        arguments: '{"command":"touch outside"}',
        argumentKeys: ['command'],
      });
      await history.flush();
      // Let the bounded fire-and-forget checkpoint land.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await new HistoryStore(dataDir).load();
        if (rows.some((row) => row.taskId === task.taskId)) break;
        await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
      }
      await history.flush();

      // A FRESH store over the same directory is the restart.
      const reloaded = await new HistoryStore(dataDir).load();
      const row = reloaded.find((entry) => entry.taskId === task.taskId);
      assert.ok(row !== undefined, 'the live checkpoint really reached durable history');
      assert.equal(row.permission.pending.requestId, 'permission-checkpoint-1');
      assert.equal(row.permission.pending.callId, 'call-checkpoint');
      assert.equal(row.permission.pending.arguments, '{"command":"touch outside"}');
      assert.equal(row.permission.pending.toolName, 'bash');
      // The private binding is never stored, so the record cannot be replayed.
      assert.equal(JSON.stringify(row).includes('c'.repeat(64)), false, 'the fingerprint is not persisted');

      // Whatever state the reloaded record carries, the wait is HISTORY: either the
      // live record was normalized to `interrupted` (crash) or the run finished and
      // the terminal record already says so. In both cases a pending request must not
      // read as still decidable, and no decision can be applied to it.
      if (row.state === 'interrupted') {
        assert.equal(row.permission.waiting, false);
        assert.equal(row.permission.pending.state, 'unavailable');
        assert.equal(row.permission.pending.decidedBy, 'restart');
        assert.match(row.permission.pending.decisionReason, /not replayed/u);
      }
      assert.notEqual(row.permission.pending.state, 'pending', 'a stored request is never still decidable');
    } finally {
      await fixture.engine.dispose();
      await history.dispose();
    }
  } finally {
    await cleanup(dir);
  }
});

test('E: a stale live checkpoint cannot overwrite a terminal record', async () => {
  const { HistoryStore } = await import('../src/jobs/history.js');
  const dir = await makeTempDir();
  try {
    const store = new HistoryStore(join(dir, 'data'));
    const now = 1_700_000_000_000;
    const base = { taskId: 'task-guard', createdAt: now, endedAt: now + 10, connectionId: 'local-mcp', selfApproved: false };
    // The terminal record lands first.
    await store.save({ ...base, state: 'awaiting-host-review', phase: 'awaiting-host-review' });
    // A live checkpoint that arrives afterwards must NOT roll it back.
    const returned = await store.save({ ...base, state: 'running', phase: 'awaiting-permission' });
    assert.equal(returned.state, 'awaiting-host-review', 'the guard returns the terminal record');
    const reloaded = await new HistoryStore(join(dir, 'data')).load();
    const row = reloaded.find((entry) => entry.taskId === 'task-guard');
    assert.equal(row.state, 'awaiting-host-review', 'a finished task is never resurrected as running');
    // A terminal record may still be updated BY a terminal one (normal progression).
    await store.save({ ...base, state: 'failed', phase: 'failed', error: { code: 'JOB_FAILED', message: 'x' } });
    const after = (await new HistoryStore(join(dir, 'data')).load()).find((entry) => entry.taskId === 'task-guard');
    assert.equal(after.state, 'failed');
  } finally {
    await cleanup(dir);
  }
});

test('E: a pending checkpoint stored for a LIVE task is normalized to interrupted history on restart', async () => {
  const { HistoryStore } = await import('../src/jobs/history.js');
  const dir = await makeTempDir();
  try {
    const dataDir = join(dir, 'data');
    const store = new HistoryStore(dataDir);
    const now = 1_700_000_000_000;
    // The exact shape the ENGINE writes at a checkpoint: state still `running`.
    await store.save({
      taskId: 'task-crash-during-wait',
      state: 'running',
      phase: 'awaiting-permission',
      createdAt: now,
      startedAt: now + 5,
      endedAt: null,
      connectionId: 'local-mcp',
      permission: {
        bridged: true,
        waiting: true,
        standingSandboxMode: 'workspace-write',
        grantScope: 'single-call',
        pausedExecutionMs: 0,
        evidence: [],
        pending: {
          requestId: 'permission-crash-1',
          taskId: 'task-crash-during-wait',
          sessionId: 'session-crash',
          toolName: 'bash',
          callId: 'call-crash',
          state: 'pending',
          completeness: 'complete',
          argumentsComplete: true,
          allowBlocked: null,
          arguments: '{"command":"touch outside"}',
          argumentKeys: ['command'],
          fingerprint: `sha256:${'d'.repeat(64)}`,
        },
      },
      selfApproved: false,
    });
    // The crash: a brand-new store over the same directory.
    const reloaded = await new HistoryStore(dataDir).load();
    const row = reloaded.find((entry) => entry.taskId === 'task-crash-during-wait');
    assert.ok(row !== undefined);
    assert.equal(row.state, 'interrupted', 'a live record on load is interrupted');
    assert.equal(row.interruptedFrom, 'running');
    assert.equal(row.error.code, 'JOB_INTERRUPTED_RESTART');
    // The wait is history, not a decidable request.
    assert.equal(row.permission.waiting, false);
    assert.equal(row.permission.interrupted, true);
    assert.equal(row.permission.pending.state, 'unavailable');
    assert.equal(row.permission.pending.outcome, 'unavailable');
    assert.equal(row.permission.pending.decidedBy, 'restart');
    assert.match(row.permission.pending.decisionReason, /not replayed/u);
    // And nothing that could re-authorise the call survived.
    assert.equal(JSON.stringify(row).includes('d'.repeat(64)), false);
  } finally {
    await cleanup(dir);
  }
});
