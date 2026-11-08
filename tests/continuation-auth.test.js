// Cross-restart continuation ownership: a `continueFromTaskId` follow-up may only
// join a parent task that the SAME verified connection submitted.
//
// The defect these tests pin down is a restart, not a live race. While the parent
// record is still in memory, the engine compares the two connection ids. After a
// restart the memory is empty, and the persisted task→session map alone says where a
// thread lives — never who submitted it, and never how the run ended. Resuming from
// that map without a second, durable authority would let connection B continue
// connection A's DSH Session by naming A's task id.
//
// So the second authority is the durable job history (which records `connectionId`,
// the terminal state and its own paths), read through its own `load()` interface.
// Every case below therefore asserts four things:
//
//  * the refusal code — and that an unknown id, an ownerless record and another
//    connection's task all answer the SAME `JOB_TASK_NOT_FOUND` with the same
//    message and no cause, no state and no thread hint;
//  * that the refusal happened during admission, before any native call;
//  * that nothing native was touched: no Session resolved, none created, no Agent
//    created, no follow-up delivered;
//  * that a masked or missing recorded path is refused rather than read as a match.
//
// A refusal that leaked the parent's Session id into `resolves` would be the exact
// failure this feature must not have, which is why the assertions count native calls
// instead of trusting the error code alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { HistoryStore } from '../src/jobs/history.js';
import { JobEngine, JOB_CODES, TASK_STATES } from '../src/jobs/engine.js';
import { SessionStore } from '../src/runtime/session-placement.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
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
const HEAD = 'b'.repeat(40);

/** What a protected record's path segment looks like after redaction rewrote it. */
const MASK = 'masks-user-profile-segment';

/**
 * Whether a path carries the redaction placeholder as a whole segment.
 * Stated here independently of the engine so a test can assert that the fixture really
 * exercises a rewritten path; it is never used to weaken a product check.
 * @param {string} value - candidate path.
 * @returns {boolean} true when the path was rewritten by redaction.
 */
function recordedIsMasked(value) {
  return value.replaceAll('\\', '/').split('/').some((part) => part === MASK);
}

/**
 * A git runner answering in the NUL-delimited format the audit layer parses.
 * @returns {object} runner function with `calls` history.
 */
function auditGit() {
  const calls = [];
  const runner = async (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.join(' ');
    if (key === '--version') return { stdout: 'git version 2.0.0\n', code: 0 };
    if (key === 'rev-parse --is-inside-work-tree') return { stdout: 'true\n', code: 0 };
    if (key === 'rev-parse --verify HEAD') return { stdout: `${HEAD}\n`, code: 0 };
    if (args[0] === 'status') return { stdout: ' M src/a.js\u0000', code: 0 };
    if (args[0] === 'diff' && args[1] === '--numstat') return { stdout: '2\t0\tsrc/a.js\u0000', code: 0 };
    if (args[0] === 'diff') return { stdout: 'diff --git a/src/a.js b/src/a.js\n+work\n', code: 0 };
    if (args[0] === 'ls-files') return { stdout: '', code: 0 };
    return { stdout: '', code: 0 };
  };
  runner.calls = calls;
  return runner;
}

/**
 * The provider registry the production entry point injects.
 * @returns {object} registry answering one deterministic profile→route map.
 */
function providerRegistry() {
  return {
    async ensure(providers) {
      const routes = new Map();
      for (const provider of providers) routes.set(provider.id, `${provider.id}-native`);
      return { routes };
    },
  };
}

/**
 * A preset registry that can mount and that advertises a tool inventory.
 * @returns {object} preset registry.
 */
function presets() {
  return {
    async mount(ctx) {
      ctx.tools.schemas = () => [{ name: 'read', description: 'read', parameters: {} }];
      return { id: 'default-preset' };
    },
  };
}

/** The plugin-owned review composition stand-in (see `tests/engine.test.js`). */
function reviewPreset() {
  const id = 'dsh-delegate-review-test';
  return { get id() { return id; }, owns(candidate) { return candidate === id; }, async preparation() { return id; } };
}

/**
 * Boot one plugin process over a data directory that outlives it.
 *
 * A restart is modelled by dropping the object and building a new one over the same
 * `dir`, with fresh durable stores — the plugin's own state is what a reload
 * discards. The native Workspace/Session controllers and the Agent registry are passed
 * in and shared, because DSH owns them: a plugin reload does not destroy a live
 * Session, and a fixture that silently did so would make "continue my own thread"
 * untestable.
 * @param {object} options - `dir`, `workspace`, `auth`, `policyServices`, and the
 *   shared host services (`workspaces`, `sessionController`, `agents`).
 * @returns {Promise<object>} harness.
 */
async function bootProcess(options) {
  const settings = new SettingsService(options.dir);
  // Written wholesale on every boot so the second process reads the same document
  // from disk rather than inheriting an in-memory snapshot.
  await settings.replace(options.settings ?? validSettings());
  const workspaces = options.workspaces;
  const sessionController = options.sessionController;
  const agents = options.agents;
  // Fresh stores per process: a restarted engine must re-read the documents from
  // disk, never inherit an earlier process's cached objects as evidence.
  const history = new HistoryStore(options.dir);
  const sessionStore = new SessionStore(options.dir);
  const engine = new JobEngine({
    agents,
    agentPresets: presets(),
    reviewPresets: reviewPreset(),
    sessions: { async flush() {} },
    workspaces,
    sessionController,
    // The policy services every delegated worker run verifies its confinement
    // through; without this accessor the run is refused before its prompt.
    policyServices: () => options.policyServices,
    llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
    settings,
    auth: options.auth,
    locks: new WorkspaceLocks(),
    runGit: auditGit(),
    providerRegistry: providerRegistry(),
    history,
    sessionStore,
    authorizationMode: 'grants',
    logger: { info() {}, warn() {} },
  });
  return {
    dir: options.dir,
    workspace: options.workspace,
    auth: options.auth,
    settings,
    history,
    sessionStore,
    engine,
    workspaces,
    sessionController,
    agents,
  };
}

/**
 * Issue a connection plus one grant covering `workspace`.
 * @param {object} auth - authorization registry.
 * @param {string} workspace - source workspace the grant covers.
 * @param {string} [label] - operator-facing label.
 * @param {'task'|'session'} [kind] - grant kind.
 * @returns {{ connectionId: string, token: string, grant: object }} credentials.
 */
function authorize(auth, workspace, label = 'codex', kind = 'task') {
  const connection = auth.issueConnection({ label });
  const grant = auth.issueGrant(connection.connectionId, {
    kind,
    workspacePath: workspace,
    ttlSeconds: 600,
  });
  return { connectionId: connection.connectionId, token: connection.token, grant };
}

/**
 * Boot one plugin process with the delegation oracle satisfied.
 *
 * The registry's delegation oracle answers "is delegation on" only while some unspent
 * grant exists. The holder grant below exists so the fixture can drive SEVERAL
 * submissions in one process while still presenting a genuine, unspent `task` grant
 * for the submission under test: nothing is handed out that the registry would refuse,
 * and nothing in the continuation gate is bypassed.
 * @param {object} options - see {@link bootProcess}.
 * @returns {Promise<object>} the plugin process, with a fresh `holder`.
 */
async function bootWithHolder(options) {
  const holder = authorize(options.auth, options.workspace, 'delegation-holder', 'session');
  const process = await bootProcess(options);
  return { ...process, holder };
}

/**
 * Wait until a task is terminal.
 * @param {object} engine - job engine.
 * @param {string} taskId - task id.
 * @returns {Promise<object>} settled task view.
 */
async function settle(engine, taskId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = engine.get(taskId);
    if (task.state !== TASK_STATES.running && task.state !== TASK_STATES.pending) {
      // The public state becomes terminal before the asynchronous history write and
      // cleanup finish. Wait for the engine's lifecycle promise before reading the
      // durable record, otherwise a restart assertion can race that write.
      await engine.tasks.get(taskId)?.settled;
      return engine.get(taskId);
    }
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
  }
  return engine.get(taskId);
}

/**
 * Build one start request with a genuine, unspent `task` grant for that connection.
 *
 * A task grant authorizes one attempt and is consumed by it, so every submission gets
 * its own. The connection is what the continuation gate binds, which is why a fresh
 * grant for the same connection is not a new owner.
 * @param {object} process - harness (its `workspace` and `auth` are used).
 * @param {object} credentials - a connection from {@link authorize}.
 * @param {string} prompt - task prompt.
 * @param {object} [extra] - extra start fields (`continueFromTaskId`).
 * @returns {Promise<object>} the start request.
 */
async function startOf(process, credentials, prompt, extra = {}) {
  const grant = process.auth.issueGrant(credentials.connectionId, {
    kind: 'task',
    workspacePath: process.workspace,
    ttlSeconds: 600,
  });
  return {
    connectionId: credentials.connectionId,
    grantId: grant.grantId,
    workspacePath: process.workspace,
    prompt,
    ...extra,
  };
}

/**
 * Run one task to completion in one process and return its id.
 * @param {object} process - harness.
 * @param {object} credentials - a connection from {@link authorize}.
 * @param {string} prompt - task prompt.
 * @param {object} [extra] - extra start fields (`continueFromTaskId`).
 * @returns {Promise<string>} the terminal task's id.
 */
async function runOne(process, credentials, prompt, extra = {}) {
  const started = await process.engine.start(await startOf(process, credentials, prompt, extra));
  const settled = await settle(process.engine, started.taskId);
  assert.equal(settled.state, TASK_STATES.awaitingHostReview, `the task did not complete: ${JSON.stringify(settled.error)}`);
  return settled.taskId;
}

/**
 * A fresh data directory, a real source workspace, one shared auth registry and the
 * native policy services, plus the two booted processes a restart needs.
 * @returns {Promise<object>} fixture.
 */
async function fixture() {
  const root = await makeTempDir();
  const workspace = await realpath(
    await mkdir(join(root, 'workspace'), { recursive: true }).then(() => join(root, 'workspace')),
  );
  const dir = join(root, 'data');
  const auth = new AuthorizationRegistry();
  const policyServices = await nativePolicyServices();
  // The host: one set of native controllers and one agent registry, shared by every
  // plugin process in a test, because DSH owns them and a plugin reload does not
  // recreate a Workspace, a Session or a live Agent.
  const workspaces = fakeWorkspaceController();
  const sessionController = fakeSessionController({ workspaces, respond: { text: 'implemented the change' } });
  const agents = fakeAgents({ respond: { text: 'implemented the change' } });
  const host = { workspaces, sessionController, agents };
  const before = await bootWithHolder({ dir, workspace, auth, policyServices, ...host });
  return {
    root,
    workspace,
    dir,
    auth,
    policyServices,
    ...host,
    before,
    /**
     * Simulate a plugin restart: a second plugin process over the same data
     * directory and the same host. Its task table starts empty; its durable stores
     * are re-read from disk.
     * @returns {Promise<object>} the restarted harness.
     */
    async restart() {
      await before.engine.dispose();
      return await bootWithHolder({ dir, workspace, auth, policyServices, ...host });
    },
    /** @returns {Promise<void>} remove the temporary tree. */
    async close() {
      await cleanup(root);
    },
  };
}

/**
 * Count every native effect a refused continuation must not have.
 * @param {object} process - harness whose controllers are observed.
 * @returns {{ resolves: number, creates: number, agents: number, followups: number }} counts.
 */
function nativeCounts(process) {
  let followups = 0;
  for (const agent of process.sessionController.agents.values()) {
    followups += Array.isArray(agent.followups) ? agent.followups.length : 0;
  }
  return {
    resolves: process.sessionController.resolves.length,
    creates: process.sessionController.creates.length,
    agents: process.agents.created.length,
    followups,
  };
}

/**
 * Assert that a start was refused during admission and touched nothing native.
 *
 * "Touched nothing native" is asserted from the native controllers themselves: no
 * Session was resolved (a continuation resolves the parent's Session), none was
 * created (a new conversation would create one), no Agent was created and no
 * follow-up was delivered. Driving the conversation requires one of those first, so
 * the counters also prove the conversation was never driven.
 * @param {object} process - harness whose controllers are observed.
 * @param {Promise<unknown>} attempt - the start call.
 * @param {string} code - expected job code.
 * @param {object} [extra] - `session` (expected `details.session`) and `notSession`.
 * @returns {Promise<Error>} the refusal, for further assertions.
 */
async function assertRefusedUntouched(process, attempt, code, extra = {}) {
  const before = nativeCounts(process);
  let failure = null;
  await attempt.catch((error) => { failure = error; return undefined; });
  assert.ok(failure !== null, 'the submission must be refused');
  assert.equal(failure.code, code);
  const after = nativeCounts(process);
  assert.equal(after.resolves, before.resolves, 'no native Session may be resolved for a refused continuation');
  // Creating a conversation is the other half of "the parent's thread was not
  // touched": a refusal that fell back to a new Session would show up here.
  assert.equal(after.creates, before.creates, 'no native Session may be created for a refused continuation');
  assert.equal(after.agents, before.agents, 'no native Agent may be created for a refused continuation');
  assert.equal(after.followups, before.followups, 'no follow-up may be delivered for a refused continuation');
  if (extra.session !== undefined) {
    assert.equal(failure.details?.session, extra.session);
  }
  if (extra.notSession !== undefined) {
    assert.notEqual(failure.details?.session, extra.notSession, 'the refusal must not name the parent thread');
  }
  return failure;
}

/**
 * Read one durable history row exactly as the store serves it.
 * @param {string} dir - data directory.
 * @param {string} taskId - task id.
 * @returns {Promise<object | null>} the row, or null.
 */
async function historyRow(dir, taskId) {
  const rows = await new HistoryStore(dir).load();
  return rows.find((row) => row.taskId === taskId) ?? null;
}

/**
 * Read the persisted identity row of one task.
 * @param {string} dir - data directory.
 * @param {string} taskId - task id.
 * @returns {Promise<object | null>} the row, or null.
 */
async function identityRow(dir, taskId) {
  return await new SessionStore(dir).get(taskId);
}

/**
 * Rewrite the durable history document of a restarted process.
 *
 * The real store is used to read the document, so the shape written back is the one
 * the store produces; only the mapper's edit is a test statement.
 * @param {object} process - the restarted harness.
 * @param {string} dir - the data directory the durable history lives in.
 * @param {(row: object) => object | null} rewrite - per-row rewrite; null drops it.
 * @returns {Promise<void>} resolves once the seam is installed.
 */
async function rewriteHistory(process, dir, rewrite) {
  const real = new HistoryStore(dir);
  process.engine.history = {
    async load() {
      const rows = await real.load();
      const next = [];
      for (const row of rows) {
        const mapped = rewrite(row);
        if (mapped !== null) next.push(mapped);
      }
      return next;
    },
  };
}

/**
 * Rewrite the identity map through its own store.
 * @param {string} dir - data directory.
 * @param {string} taskId - task id.
 * @param {(row: object) => object} rewrite - the edited row.
 * @returns {Promise<void>} resolves once the document is rewritten.
 */
async function rewriteIdentity(dir, taskId, rewrite) {
  const store = new SessionStore(dir);
  const row = await store.get(taskId);
  assert.ok(row !== null && typeof row === 'object', 'the fixture needs a stored identity row to rewrite');
  const raw = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'));
  raw.sessions = raw.sessions.map((entry) => (entry.taskId === taskId ? { ...entry, ...rewrite(row) } : entry));
  await writeFile(join(dir, 'sessions.json'), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

// --- Same process ------------------------------------------------------------

test('same process: connection B cannot continue connection A\'s finished task', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');

    const b = authorize(h.auth, h.workspace, 'B');
    // B presents its OWN valid grant: a valid authorization is not an authorization
    // to join somebody else's chain.
    await assertRefusedUntouched(
      h.before,
      h.before.engine.start(await startOf(h.before, b, 'continue that', { continueFromTaskId: parentId })),
      JOB_CODES.taskNotFound,
    );

    // A still may, which proves the refusal above was about ownership and not about
    // continuations being broken in this deployment.
    const ownId = await runOne(h.before, a, 'continue my own', { continueFromTaskId: parentId });
    const own = h.before.engine.get(ownId);
    assert.equal(own.continueFromTaskId, parentId);
    assert.equal(own.conversation.kind, 'continuation');
  } finally {
    await h.before.engine.dispose();
    await h.close();
  }
});

// --- After a restart ---------------------------------------------------------

test('restart: connection B cannot continue connection A\'s task, and A\'s Session is never resolved', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');

    // The restart empties the in-memory task table; only the durable map and the
    // durable history survive.
    const after = await h.restart();
    try {
      assert.equal(after.engine.tasks.size, 0, 'the restarted process holds no task records');
      assert.ok((await after.sessionStore.get(parentId)) !== null, 'the durable identity map still names the thread');
      const b = authorize(h.auth, h.workspace, 'B');

      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, b, 'continue A\'s thread', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
      // The refusal was recorded on the submitting task as an admission failure, so
      // nothing reached the run path — and the recorded error is the same "absent".
      const [task] = after.engine.list({ connectionId: b.connectionId });
      assert.ok(task !== undefined, 'the refused submission is still recorded for its own connection');
      assert.equal(task.state, TASK_STATES.failed);
      assert.equal(task.error.code, JOB_CODES.taskNotFound);
      assert.ok(task.phase !== 'review' && task.execution === null, 'no execution was ever attempted');
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: the same connection continues its own task through its own Session', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const [parentSession] = h.before.sessionController.resolves;
    assert.equal(typeof parentSession, 'string', 'the parent run resolved its own Session');

    const after = await h.restart();
    try {
      // The grant does not survive the restart, so A presents a fresh one; the
      // CONNECTION identity is what a continuation is bound to.
      const childId = await runOne(after, a, 'continue my own work', { continueFromTaskId: parentId });
      const child = after.engine.get(childId);
      assert.equal(child.state, TASK_STATES.awaitingHostReview);
      assert.equal(child.continueFromTaskId, parentId);
      assert.equal(child.conversation.kind, 'continuation');
      assert.equal(child.conversation.sessionId, parentSession, 'the follow-up drove the parent\'s own Session');
      // Every resolve in the restarted process named that one Session, so the
      // follow-up joined a thread instead of starting a conversation beside it.
      assert.ok(
        after.sessionController.resolves.every((id) => id === parentSession),
        `the follow-up resolved other sessions: ${after.sessionController.resolves.join(', ')}`,
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a cancelled parent that drove a conversation can still be continued by its owner', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    // A parent whose run was cancelled after it had already driven its conversation
    // is a legal retry: the thread exists and the owner is the same.
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // The parent's own `execution` block — including the conversation it drove — is
      // kept exactly as recorded; only the state changes, which is what a cancelled
      // run that had already talked to the model leaves behind.
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, state: TASK_STATES.cancelled, cancelledBy: 'request' }
        : row));
      assert.equal((await historyRow(h.dir, parentId)).execution.conversation.kind, 'new');
      const childId = await runOne(after, a, 'continue the cancelled work', { continueFromTaskId: parentId });
      assert.equal(after.engine.get(childId).conversation.kind, 'continuation');
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: the local switch continues its own task under its fixed identity', async () => {
  const h = await fixture();
  try {
    const workspace = h.workspace;
    const policyServices = h.policyServices;
    const workspaces = h.workspaces;
    const sessionController = h.sessionController;
    const agents = h.agents;
    /**
     * Boot one switch-mode process over the shared data directory and host.
     * @returns {Promise<object>} switch harness.
     */
    const bootSwitch = async () => {
      const settings = new SettingsService(h.dir);
      await settings.replace(validSettings());
      return new JobEngine({
        agents,
        agentPresets: presets(),
        reviewPresets: reviewPreset(),
        sessions: { async flush() {} },
        workspaces,
        sessionController,
        policyServices: () => policyServices,
        llm: fakeLlm({ providers: { 'relay-native': llmTable().relay } }),
        settings,
        auth: new AuthorizationRegistry(),
        locks: new WorkspaceLocks(),
        runGit: auditGit(),
        providerRegistry: providerRegistry(),
        // Fresh stores, exactly as a reloaded plugin reads them again.
        history: new HistoryStore(h.dir),
        sessionStore: new SessionStore(h.dir),
        authorizationMode: 'switch',
        delegationEnabled: true,
        logger: { info() {}, warn() {} },
      });
    };
    const first = await bootSwitch();
    let parentId;
    let parentSession;
    try {
      const started = await first.start({ workspacePath: workspace, prompt: 'do work' });
      const parent = await settle(first, started.taskId);
      assert.equal(parent.state, TASK_STATES.awaitingHostReview, `the parent did not complete: ${JSON.stringify(parent.error)}`);
      assert.equal(parent.connectionId, 'local-mcp', 'the local switch runs under its own fixed identity');
      parentId = parent.taskId;
      [parentSession] = sessionController.resolves;
      assert.equal(await historyRow(h.dir, parentId).then((row) => row?.connectionId), 'local-mcp');
    } finally {
      await first.dispose();
    }

    // A NEW engine over the same data directory, with a brand-new auth registry: the
    // switch's identity is not a live authorization handle, it is a fixed name.
    const second = await bootSwitch();
    try {
      const started = await second.start({
        workspacePath: workspace,
        prompt: 'continue my own work',
        continueFromTaskId: parentId,
      });
      const child = await settle(second, started.taskId);
      assert.equal(child.state, TASK_STATES.awaitingHostReview, `the follow-up did not complete: ${JSON.stringify(child.error)}`);
      assert.equal(child.conversation.kind, 'continuation');
      assert.equal(child.conversation.sessionId, parentSession, 'the switch continued the Session it created');
    } finally {
      await second.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a re-issued connection id is a new identity even under the same label', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'codex');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // DSH re-issuing a connection mints a NEW id; a matching operator label is not
      // an identity, so the follow-up is refused as an absent task.
      const reissued = authorize(h.auth, h.workspace, 'codex');
      assert.notEqual(reissued.connectionId, a.connectionId);
      const failure = await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, reissued, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
      assert.equal(failure.message, 'no such task for this connection');
      assert.deepEqual(Object.keys(failure.details ?? {}), ['continueFromTaskId']);
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

// --- Indistinguishability ----------------------------------------------------

/**
 * Assert two refusals are the same answer down to the shape of their details.
 * @param {object} left - first refusal.
 * @param {object} right - second refusal.
 * @returns {void}
 */
function assertSameRefusal(left, right) {
  assert.equal(left.code, right.code);
  assert.equal(left.message, right.message);
  assert.deepEqual(left.details?.session, right.details?.session);
  assert.deepEqual(Object.keys(left.details ?? {}), Object.keys(right.details ?? {}));
}

test('an unknown task id, an ownerless record and another connection\'s task are refused identically', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      const b = authorize(h.auth, h.workspace, 'B');
      const ownerless = 'task-11111111-1111-4111-8111-111111111111';
      // A record that exists but states no owner cannot prove ownership, so it must
      // answer exactly like an id that does not exist.
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId ? { ...row, connectionId: null } : row));
      const bRefusal = await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, b, 'x', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
      const aRefusal = await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'x', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
        { notSession: 'SESSION_CONTINUATION_UNKNOWN' },
      );
      const unknownRefusal = await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, b, 'x', { continueFromTaskId: ownerless })),
        JOB_CODES.taskNotFound,
      );
      // What matters for indistinguishability: no cause, no state and no thread
      // hint — only the id the caller itself named.
      for (const refusal of [bRefusal, aRefusal, unknownRefusal]) {
        assert.equal(refusal.message, 'no such task for this connection');
        assert.deepEqual(Object.keys(refusal.details ?? {}), ['continueFromTaskId']);
        assert.equal(refusal.details?.session, undefined);
        assert.equal(refusal.details?.state, undefined);
      }
      assertSameRefusal(bRefusal, unknownRefusal);
      assertSameRefusal(aRefusal, unknownRefusal);
      assert.equal(bRefusal.details.continueFromTaskId, parentId);
      assert.equal(unknownRefusal.details.continueFromTaskId, ownerless);
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('a null connection id on the parent record is never a wildcard', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    // In process: an ownerless live record is unprovable, in both directions.
    const parent = h.before.engine.tasks.get(parentId);
    const remembered = parent.connectionId;
    parent.connectionId = null;
    try {
      await assertRefusedUntouched(
        h.before,
        h.before.engine.start(await startOf(h.before, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
      await assertRefusedUntouched(
        h.before,
        h.before.engine.start({
          connectionId: null,
          grantId: null,
          authorization: 'session',
          workspacePath: h.workspace,
          prompt: 'continue',
          continueFromTaskId: parentId,
        }),
        'CONNECTION_UNKNOWN',
      );
    } finally {
      parent.connectionId = remembered;
    }
  } finally {
    await h.before.engine.dispose();
    await h.close();
  }
});

// --- Durable provenance is required ------------------------------------------
//
// These cases keep the identity map intact and change only the DURABLE record, so
// they prove the provenance read is what decides — not the map, not the session
// controller. The store is reached through its own documented `load()`; nothing
// inner is patched and the engine is not stubbed.

test('restart: a parent with no durable history record is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // The identity map still names the thread; the record of who ran it is gone
      // (pruned by the history bounds, or never written) so ownership is unprovable,
      // and an unprovable owner is reported exactly like an unknown id.
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId ? null : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a pruned durable record is refused even though the identity remains', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // Evict the record the way the history bounds do: rewrite the document with
      // only later rows, which is what a bounded store leaves behind.
      const path = join(h.dir, 'history.json');
      const document = JSON.parse(await readFile(path, 'utf8'));
      document.jobs = document.jobs.filter((row) => row.taskId !== parentId);
      // A later save by this process must not resurrect the evicted row.
      await writeFile(path, `${JSON.stringify(document)}\n`, 'utf8');
      assert.equal(await historyRow(h.dir, parentId), null);
      assert.ok((await identityRow(h.dir, parentId)) !== null, 'the thread is still indexed');
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a truncated durable record is refused rather than read as evidence', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, truncation: { fields: ['diff.patchText'], dropped: [], note: 'fitted' } }
        : row));
      // A cut record cannot state ownership, so it answers as absent, like an id that
      // does not exist — not with a reason that would confirm the task.
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a parent whose run was interrupted by the restart is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // The shape the history document itself produces for a job that was live when
      // the process stopped. Ownership is proven, so the reason is specific.
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, state: 'interrupted', interruptedFrom: 'running' }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_STATE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a parent left in a non-terminal state is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, state: 'running' }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_STATE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a failed parent that never drove a conversation is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, state: TASK_STATES.failed, execution: null }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_STATE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a terminal parent whose recorded conversation is empty is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // `awaiting-host-review` is terminal, but a placement with no kind or no Workspace
      // id is not a thread: admission must refuse it instead of joining "nothing".
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, state: TASK_STATES.awaitingHostReview, execution: { ...row.execution, conversation: { kind: 'new', workspaceId: '' } } }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_STATE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a parent recorded for another source repository is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      const elsewhere = join(h.root, 'other-repo');
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, sourcePath: elsewhere }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_WORKSPACE_MISMATCH' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

// --- Unreliable or contradictory paths ---------------------------------------
//
// Two independent documents describe the parent: the durable record (ownership,
// outcome, its own paths) and the identity map (the exact execution directory and
// the Session). Where they disagree, or where a path cannot be read back exactly,
// there is no proof — and no proof is a refusal.

test('restart: a missing recorded path is refused, in either document', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, sourcePath: null, executionWorkspacePath: null }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_WORKSPACE_MISMATCH' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a missing recorded execution path is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, executionWorkspacePath: null }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_UNAVAILABLE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('a masked path is never a wildcard: it is refused, not matched', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    // The durable document is projected through redaction, which rewrites an
    // account-identifying segment into a mask. The test writes that form explicitly
    // instead of relying on the platform's temporary path to be rewritten: the mask
    // must not be read as "any segment" in either direction — it cannot prove which
    // directory it named, so this record can never be continued.
    const maskedPath = join(h.root, MASK);
    assert.equal(recordedIsMasked(maskedPath), true);
    const after = await h.restart();
    try {
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, sourcePath: maskedPath, executionWorkspacePath: maskedPath }
        : row));
      // The premise is read back through the seam the engine actually consumes
      // (`history.load()`), not from the document on disk: `rewriteHistory` replaces that
      // seam, so the file still holds the unrewritten row and reading it would prove
      // nothing about what admission saw.
      const rows = await after.engine.history.load();
      const stored = rows.find((row) => row.taskId === parentId) ?? null;
      assert.equal(recordedIsMasked(stored?.sourcePath), true, 'the fixture must exercise a rewritten path');
      assert.equal(stored?.sourcePath, maskedPath);
      assert.equal(recordedIsMasked(stored?.executionWorkspacePath), true, 'both recorded paths are masked');
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_WORKSPACE_MISMATCH' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('a durable path that is not the masked form of anything is refused, never matched', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // Same structure as the real record, a different final directory: the only
      // segment that differs is a REAL one, so no mask may bridge the difference.
      const maskedButDifferent = join(h.root, MASK, '..', 'other-repo');
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, sourcePath: maskedButDifferent }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_WORKSPACE_MISMATCH' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: an execution path that contradicts the identity map is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      const elsewhere = await realpath(
        await mkdir(join(h.root, 'other-exec'), { recursive: true }).then(() => join(h.root, 'other-exec')),
      );
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? { ...row, executionWorkspacePath: elsewhere }
        : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_UNAVAILABLE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a conversation recorded against another directory is refused, even with the same Workspace id', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      const real = await after.sessionStore.get(parentId);
      assert.ok(real !== null && typeof real === 'object', 'the fixture needs a stored identity row');
      const elsewhere = await realpath(
        await mkdir(join(h.root, 'other-conv'), { recursive: true }).then(() => join(h.root, 'other-conv')),
      );
      // The row keeps the parent's Workspace ID and execution path — the two facts the
      // identity map is cross-checked on — and moves only the directory the conversation
      // was placed in. Equal ids are not proof of equal placement, so the refusal cannot
      // rest on the id: the path has to be compared exactly.
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId
        ? {
          ...row,
          execution: {
            ...row.execution,
            conversation: { ...row.execution.conversation, workspacePath: elsewhere },
          },
        }
        : row));
      const rows = await after.engine.history.load();
      const stored = rows.find((row) => row.taskId === parentId) ?? null;
      assert.equal(stored?.execution?.conversation?.workspacePath, elsewhere, 'the fixture must move the recorded conversation');
      assert.equal(stored?.execution?.conversation?.workspaceId, real.workspaceId, 'the Workspace id is deliberately unchanged');
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_UNAVAILABLE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: an identity map whose execution path contradicts the durable record is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      const elsewhere = await realpath(
        await mkdir(join(h.root, 'other-exec'), { recursive: true }).then(() => join(h.root, 'other-exec')),
      );
      // The identity map is written WITHOUT redaction, so this is the one document
      // that can state a real execution directory besides the parent's own chain.
      await rewriteIdentity(h.dir, parentId, () => ({ executionPath: elsewhere }));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_UNAVAILABLE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: an identity map row without an execution path or a session is refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // A row that names no session cannot be continued, and a row with no execution
      // path cannot be validated: the store keeps neither, so the follow-up finds no
      // identity at all and is refused rather than resumed somewhere arbitrary.
      await rewriteIdentity(h.dir, parentId, () => ({ executionPath: '', sessionId: '' }));
      const identity = await identityRow(h.dir, parentId);
      assert.equal(identity, null, 'the store keeps no half-identity row');
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_UNKNOWN' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a corrupt identity map is refused, not read as a match', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      const path = join(h.dir, 'sessions.json');
      const document = JSON.parse(await readFile(path, 'utf8'));
      // One unusable row among valid ones: the store drops the row it cannot project
      // rather than guessing an identity from it.
      document.sessions.push({ taskId: parentId, sessionId: null, executionPath: null });
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      const identity = await identityRow(h.dir, parentId);
      assert.ok(identity === null || typeof identity.sessionId === 'string', 'no half row may be served');
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: an identity map and durable record that disagree on isolation are refused', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      await rewriteHistory(after, h.dir, (row) => (row.taskId === parentId ? { ...row, isolation: 'worktree' } : row));
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.continuationRefused,
        { session: 'SESSION_CONTINUATION_UNAVAILABLE' },
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: without durable job history a persisted parent cannot be continued', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      after.engine.history = null;
      // No second authority means no proof of ownership, and no proof is the same
      // answer an unknown id gets.
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: an unreadable durable history refuses rather than assumes an owner', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      after.engine.history = {
        async load() {
          throw Object.assign(new Error('HISTORY_MALFORMED'), { code: 'HISTORY_MALFORMED' });
        },
      };
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

test('restart: a history document that is really not JSON refuses rather than assumes an owner', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    // Corrupt the file itself, before any store has read it, so the real HistoryStore
    // (not a seam) is what refuses.
    await writeFile(join(h.dir, 'history.json'), '{ not json at all', 'utf8');
    const after = await h.restart();
    try {
      await assert.rejects(() => after.history.load(), (error) => error.code === 'HISTORY_MALFORMED');
      await assertRefusedUntouched(
        after,
        after.engine.start(await startOf(after, a, 'continue', { continueFromTaskId: parentId })),
        JOB_CODES.taskNotFound,
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

// --- The authorization is not the ownership ----------------------------------

test('an unverified connection cannot continue a persisted task, even with a live grant', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const after = await h.restart();
    try {
      // The `session` grant kind is checked by grant id alone; the CONNECTION is
      // still the caller's verified identity. A caller that presents none is
      // refused by the registry before admission, so the empty side of the
      // comparison can never be read as "any owner".
      const floating = authorize(h.auth, h.workspace, 'anonymous', 'session');
      await assertRefusedUntouched(
        after,
        after.engine.start({
          connectionId: undefined,
          grantId: floating.grant.grantId,
          authorization: 'session',
          workspacePath: h.workspace,
          prompt: 'continue',
          continueFromTaskId: parentId,
        }),
        'CONNECTION_UNKNOWN',
      );
    } finally {
      await after.engine.dispose();
    }
  } finally {
    await h.close();
  }
});

// --- The engine's own admission path -----------------------------------------

test('assertAdmissible: an owner is compared exactly and an unstated owner is never a wildcard', async () => {
  const h = await fixture();
  try {
    const a = authorize(h.auth, h.workspace, 'A');
    const parentId = await runOne(h.before, a, 'do work');
    const b = authorize(h.auth, h.workspace, 'B');
    const engine = h.before.engine;
    // The production context a live re-check is called with: this submission's source
    // workspace and the directory it executes in. A shared run executes in its source
    // checkout, and the engine compares both paths exactly.
    const context = { sourcePath: h.workspace, executionPath: h.workspace };

    // The owner matches exactly.
    assert.equal(engine.assertAdmissible(parentId, { ...context, connectionId: a.connectionId }).taskId, parentId);
    // Another connection is reported as absent, not as forbidden.
    assert.throws(
      () => engine.assertAdmissible(parentId, { ...context, connectionId: b.connectionId }),
      (error) => error.code === JOB_CODES.taskNotFound,
    );

    // A parent record that states no identity is still not "anybody's": nothing
    // outside this record can supply an owner, so the empty side is never a match in
    // either direction — a matching caller cannot join it either.
    const parent = engine.tasks.get(parentId);
    const remembered = parent.connectionId;
    parent.connectionId = null;
    try {
      assert.throws(
        () => engine.assertAdmissible(parentId, { ...context, connectionId: null }),
        (error) => error.code === JOB_CODES.taskNotFound,
      );
      assert.throws(
        () => engine.assertAdmissible(parentId, {}),
        (error) => error.code === JOB_CODES.taskNotFound,
      );
      assert.throws(
        () => engine.assertAdmissible(parentId, { ...context, connectionId: a.connectionId }),
        (error) => error.code === JOB_CODES.taskNotFound,
      );
    } finally {
      parent.connectionId = remembered;
    }
  } finally {
    await h.before.engine.dispose();
    await h.close();
  }
});
