// Durable job history tests: bounded entries, atomic upserts, restart states and
// the two refusals (untrustworthy document, unsatisfiable limits).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HISTORY_CODES, HistoryError, HistoryStore } from '../src/jobs/history.js';

const SECRET = 'sk-fixture00000000000000000000';

/**
 * Fresh data directory per test.
 * @returns {Promise<string>} absolute temp directory.
 */
async function dataDir() {
  return await mkdtemp(join(tmpdir(), 'dsh-history-'));
}

/** @returns {object} the file path inside a data directory. */
function historyFile(dir) {
  return join(dir, 'history.json');
}

/**
 * A public job view shaped like the engine's projection, with fixture values.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} view.
 */
function fixtureView(overrides = {}) {
  const createdAt = 1_700_000_000_000;
  const base = {
    taskId: 'task-fixture-1',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    createdAt,
    startedAt: createdAt + 1000,
    endedAt: createdAt + 2000,
    sourcePath: 'C:\\fixtures\\repo',
    workspacePath: 'C:\\fixtures\\repo',
    executionWorkspacePath: 'C:\\fixtures\\repo',
    isolation: 'shared',
    connectionId: 'conn-fixture-1',
    // Authorization state: stored nowhere, even when the caller passes it.
    grantId: 'grant-fixture-1',
    authorization: 'task',
    effective: {
      worker: {
        providerId: 'relay',
        model: 'deepseek-chat',
        reasoningEffort: 'medium',
        timeoutSeconds: 900,
        maxParallelism: 1,
        isolation: 'shared',
      },
      review: { enabled: false, providerId: null, model: null, reasoningEffort: null },
      provenance: { projectPath: 'C:\\fixtures\\repo', projectKey: 'c:\\fixtures\\repo', applied: ['global:worker'] },
    },
    route: { providerId: 'relay', providerRoute: 'relay', model: 'deepseek-chat', reasoningEffort: 'medium' },
    reviewRoute: null,
    reviewRouteError: null,
    worktree: null,
    baseline: {
      head: 'fixturehead0000000000000000000000000000',
      dirtyBaseline: false,
      preexistingChanges: 0,
      preexistingPaths: [],
      statusTruncated: false,
      statusFormat: 'porcelain-v1-z',
      capturedAt: createdAt + 500,
    },
    diff: {
      head: 'fixturehead0000000000000000000000000000',
      baseHead: 'fixturehead0000000000000000000000000000',
      dirtyBaseline: false,
      preexistingChanges: 0,
      files: [{ code: 'M', path: 'src/fixture.js', from: null }],
      fileCount: 1,
      truncatedFiles: false,
      changes: [{ added: 4, removed: 1, path: 'src/fixture.js', from: null }],
      sensitivePaths: [],
      sensitiveTouchedCount: 0,
      sensitiveContentWithheld: true,
      patchWithheld: false,
      patchText: 'diff --git a/src/fixture.js b/src/fixture.js\n+const fixture = 1;',
      patchTruncated: false,
      patchBytes: 64,
      capturedAt: createdAt + 1800,
    },
    execution: {
      workspacePath: 'C:\\fixtures\\repo',
      outcome: 'completed',
      text: 'changed one fixture file',
      reasoningOnly: false,
      textTruncated: false,
      usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49, reasoningTokens: 3 },
      turnEnd: { reason: 'completed' },
      agentId: 'agent-fixture-1',
      sessionId: 'session-fixture-1',
      cancelCause: null,
      error: null,
    },
    review: {
      state: 'not_run',
      verdict: null,
      text: '',
      error: null,
      selection: { providerId: null, model: null, reasoningEffort: null },
      denials: [],
      denialsDelivered: 0,
    },
    error: null,
    cancelledBy: null,
    hostAcceptance: null,
    selfApproved: false,
  };
  return { ...base, ...overrides };
}

/**
 * Write a document exactly as given.
 * @param {string} dir - data directory.
 * @param {unknown} document - JSON value.
 * @returns {Promise<string>} the raw text written.
 */
async function writeDocument(dir, document) {
  const raw = typeof document === 'string' ? document : `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(historyFile(dir), raw, 'utf8');
  return raw;
}

/** @returns {Promise<object>} the parsed document on disk. */
async function readDocument(dir) {
  return JSON.parse(await readFile(historyFile(dir), 'utf8'));
}

/**
 * Assert a promise rejects with one history refusal code.
 * @param {Promise<unknown>} promise - pending call.
 * @param {string} code - expected code.
 * @returns {Promise<HistoryError>} the refusal.
 */
async function rejectsWith(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HistoryError, `expected a HistoryError, got ${error?.name}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected a ${code} refusal`);
}

test('a saved view round-trips through the file and load is newest first', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ taskId: 'task-old', createdAt: 1000, state: 'failed', error: { code: 'JOB_FAILED', message: 'boom' } }));
    await store.save(fixtureView({ taskId: 'task-new', createdAt: 2000 }));

    const views = await store.load();
    assert.deepEqual(views.map((job) => job.taskId), ['task-new', 'task-old']);

    const document = await readDocument(dir);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.jobs.length, 2);
    // Creation order on disk keeps serialization deterministic.
    assert.deepEqual(document.jobs.map((job) => job.taskId), ['task-old', 'task-new']);

    const reloaded = new HistoryStore(dir);
    const fromDisk = await reloaded.load();
    assert.equal(fromDisk.length, 2);
    assert.equal(fromDisk[0].taskId, 'task-new');
    assert.equal(fromDisk[0].execution.usage.totalTokens, 49);
    assert.equal(fromDisk[0].diff.patchText.includes('+const fixture = 1;'), true);
    assert.equal(fromDisk[0].selfApproved, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing history file is an empty history and creates nothing', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await readdir(dir), [], 'load must not create a file');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parallel saves of distinct views all survive and the document stays valid', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await Promise.all(
      Array.from({ length: 24 }, (_unused, index) => store.save(fixtureView({
        taskId: `task-parallel-${index}`,
        createdAt: 1_700_000_000_000 + index,
      }))),
    );;
    await store.flush();

    const views = await store.load();
    assert.equal(views.length, 24);
    assert.equal(new Set(views.map((job) => job.taskId)).size, 24);
    assert.equal((await readDocument(dir)).jobs.length, 24);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parallel saves of one id upsert rather than duplicate', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await Promise.all(Array.from({ length: 8 }, (_unused, index) => store.save(fixtureView({
      taskId: 'task-same',
      execution: { ...fixtureView().execution, usage: { inputTokens: index } },
    }))));;
    const views = await store.load();
    assert.equal(views.length, 1);
    assert.equal(views[0].execution.usage.inputTokens >= 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed write is reported and a later save recovers', async () => {
  const dir = await dataDir();
  try {
    let writes = 0;
    const failingFs = {
      ...nodeFs,
      writeFile: async (...args) => {
        writes += 1;
        if (writes === 1) {
          const error = new Error('injected write failure');
          error.code = 'EIO';
          throw error;
        }
        return await nodeFs.writeFile(...args);
      },
    };
    const store = new HistoryStore(dir, { fs: failingFs });
    const error = await rejectsWith(store.save(fixtureView()), HISTORY_CODES.writeFailed);
    assert.equal(error.details.cause, 'EIO');
    assert.deepEqual(await readdir(dir), [], 'the failed temp file must be cleaned up');

    await store.save(fixtureView({ taskId: 'task-after-failure' }));
    const views = await store.load();
    assert.deepEqual(views.map((job) => job.taskId), ['task-after-failure']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed document is refused and never overwritten, even by a later save', async () => {
  const dir = await dataDir();
  try {
    const raw = await writeDocument(dir, '{"schemaVersion":1,"jobs":[{"taskId":');
    const store = new HistoryStore(dir);
    await rejectsWith(store.load(), HISTORY_CODES.malformed);
    await rejectsWith(store.load(), HISTORY_CODES.malformed);
    await rejectsWith(store.save(fixtureView()), HISTORY_CODES.malformed);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw, 'the source document must be untouched');

    // A new store sees the same source: the refusal is about the file, not the instance.
    const second = new HistoryStore(dir);
    await rejectsWith(second.load(), HISTORY_CODES.malformed);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unknown schemaVersion is refused and preserved for a later release', async () => {
  const dir = await dataDir();
  try {
    const raw = await writeDocument(dir, { schemaVersion: 99, jobs: [], futureField: true });
    const store = new HistoryStore(dir);
    const error = await rejectsWith(store.load(), HISTORY_CODES.schemaUnsupported);
    assert.equal(error.details.schemaVersion, 99);
    await rejectsWith(store.save(fixtureView()), HISTORY_CODES.schemaUnsupported);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an oversized document is refused before it is parsed', async () => {
  const dir = await dataDir();
  try {
    // Valid JSON would parse; the size bound must fire first, so the code proves order.
    const filler = 'x'.repeat(80 * 1024);
    const raw = await writeDocument(dir, JSON.stringify({ schemaVersion: 1, jobs: [], filler }));
    const store = new HistoryStore(dir, { maxEntries: 4, maxBytes: 8192, maxEntryBytes: 8192 });
    await rejectsWith(store.load(), HISTORY_CODES.fileTooLarge);
    assert.equal(await readFile(historyFile(dir), 'utf8'), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live job becomes interrupted on load with a restart code, and finished jobs keep their state', async () => {
  const dir = await dataDir();
  try {
    const writer = new HistoryStore(dir);
    await writer.save(fixtureView({ taskId: 'task-pending', state: 'pending', phase: 'authorize', endedAt: null }));
    await writer.save(fixtureView({ taskId: 'task-running', state: 'running', phase: 'execute', endedAt: null }));
    await writer.save(fixtureView({ taskId: 'task-failed', state: 'failed', createdAt: 1, error: { code: 'JOB_TIMEOUT', message: 'too slow' } }));
    await writer.save(fixtureView({ taskId: 'task-awaiting', createdAt: 2 }));
    await writer.dispose();

    const restarted = new HistoryStore(dir);
    const views = await restarted.load();
    const byId = new Map(views.map((job) => [job.taskId, job]));

    for (const id of ['task-pending', 'task-running']) {
      const job = byId.get(id);
      assert.equal(job.state, 'interrupted', id);
      assert.equal(job.error.code, 'JOB_INTERRUPTED_RESTART', id);
      assert.equal(job.interruptedFrom === 'pending' || job.interruptedFrom === 'running', true, id);
      assert.equal(Number.isFinite(job.endedAt), true, id);
    }
    assert.equal(byId.get('task-pending').interruptedFrom, 'pending');
    assert.equal(byId.get('task-running').interruptedFrom, 'running');
    assert.equal(byId.get('task-failed').state, 'failed');
    assert.equal(byId.get('task-failed').error.code, 'JOB_TIMEOUT');
    assert.equal(byId.get('task-awaiting').state, 'awaiting-host-review');
    // The interrupted record is stored, not merely projected.
    assert.deepEqual(
      (await readDocument(dir)).jobs.filter((job) => job.state === 'interrupted').length,
      2,
    );

    // A second restart is stable: nothing is rewritten and nothing is resubmitted.
    const before = await readFile(historyFile(dir), 'utf8');
    const third = new HistoryStore(dir);
    const again = await third.load();
    assert.equal(again.filter((job) => job.state === 'interrupted').length, 2);
    assert.equal(await readFile(historyFile(dir), 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('authorization handles, prompts and native handles are never stored', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView({
      prompt: `please use ${SECRET}`,
      controller: { aborted: false },
      locks: ['C:\\fixtures\\repo'],
    });
    await store.save(view);
    const raw = await readFile(historyFile(dir), 'utf8');
    for (const forbidden of ['grant-fixture-1', 'grantId', '"authorization"', 'agent-fixture-1', 'session-fixture-1', 'please use']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} must not be stored`);
    }
    const [job] = await store.load();
    assert.equal(job.grantId, undefined);
    assert.equal(job.authorization, undefined);
    assert.equal(job.execution.agentId, undefined);
    assert.equal(job.execution.sessionId, undefined);
    assert.equal(job.prompt, undefined);
    assert.equal(job.connectionId, 'conn-fixture-1', 'connection provenance is kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('credential-shaped values never reach the file or a loaded view', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      error: {
        code: 'JOB_EXECUTION_FAILED',
        message: `upstream refused: Authorization: Bearer ${SECRET}`,
        details: {
          apiKey: SECRET,
          endpoint: `https://relay.example/v1?key=${SECRET}`,
          nested: { access_token: SECRET, note: `token=${SECRET}` },
        },
      },
      execution: {
        ...fixtureView().execution,
        outcome: 'failed',
        text: `the model said ${SECRET}`,
        error: `client_secret=${SECRET}`,
        usage: { inputTokens: 11, outputTokens: 0, totalTokens: 11, reasoningTokens: 0 },
      },
    }));

    const raw = await readFile(historyFile(dir), 'utf8');
    assert.equal(raw.includes(SECRET), false, 'the credential value must not be stored');
    const views = await store.load();
    assert.equal(JSON.stringify(views).includes(SECRET), false);
    // The useful structure survives: usage stays numeric and the failure is described.
    assert.deepEqual(views[0].execution.usage, { inputTokens: 11, outputTokens: 0, totalTokens: 11, reasoningTokens: 0 });
    assert.equal(views[0].error.code, 'JOB_EXECUTION_FAILED');
    assert.equal(views[0].error.details.nested.access_token.includes(SECRET), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an oversized entry is truncated, not emptied, and keeps a clear marker', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir, { maxEntries: 4, maxBytes: 64 * 1024, maxEntryBytes: 16 * 1024 });
    const patchText = 'a'.repeat(400 * 1024);
    const text = 'b'.repeat(200 * 1024);
    const saved = await store.save(fixtureView({
      diff: { ...fixtureView().diff, patchText },
      execution: { ...fixtureView().execution, text },
      review: { ...fixtureView().review, text: 'c'.repeat(200 * 1024) },
    }));

    assert.equal(Buffer.byteLength(JSON.stringify(saved), 'utf8') <= 16 * 1024, true);
    assert.equal(saved.diff.patchText.length > 0, true, 'the patch is truncated, not dropped');
    assert.equal(saved.diff.patchText.endsWith('… [truncated]'), true);
    assert.equal(saved.diff.patchTruncated, true);
    assert.equal(saved.execution.usage.totalTokens, 49, 'useful fields survive truncation');
    assert.equal(saved.diff.files.length, 1);
    assert.deepEqual(saved.truncation.fields.includes('diff.patchText'), true);

    const [job] = await new HistoryStore(dir, { maxEntries: 4, maxBytes: 64 * 1024, maxEntryBytes: 16 * 1024 }).load();
    assert.equal(Buffer.byteLength(JSON.stringify(job), 'utf8') <= 16 * 1024, true);
    assert.equal(job.diff.patchText.endsWith('… [truncated]'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('maxEntries evicts the oldest terminal view first', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir, { maxEntries: 3 });
    for (let index = 0; index < 6; index += 1) {
      await store.save(fixtureView({ taskId: `task-${index}`, createdAt: 1_700_000_000_000 + index }));
    }
    const views = await store.load();
    assert.deepEqual(views.map((job) => job.taskId).sort(), ['task-3', 'task-4', 'task-5']);
    assert.equal((await readDocument(dir)).jobs.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('maxBytes evicts until the document fits', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir, { maxEntries: 100, maxBytes: 16 * 1024, maxEntryBytes: 8 * 1024 });
    for (let index = 0; index < 10; index += 1) {
      await store.save(fixtureView({
        taskId: `task-bytes-${index}`,
        createdAt: 1_700_000_000_000 + index,
        diff: { ...fixtureView().diff, patchText: 'p'.repeat(4096) },
      }));
    }
    const raw = await readFile(historyFile(dir), 'utf8');
    assert.equal(Buffer.byteLength(raw, 'utf8') <= 16 * 1024, true);
    const views = await store.load();
    assert.equal(views.length > 0, true);
    assert.equal(views[0].taskId, 'task-bytes-9', 'the newest view is retained');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a live view is never evicted; the save refuses instead', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir, { maxEntries: 1, maxBytes: 64 * 1024, maxEntryBytes: 16 * 1024 });
    await store.save(fixtureView({ taskId: 'task-live', state: 'running', endedAt: null }));

    await rejectsWith(store.save(fixtureView({ taskId: 'task-terminal' })), HISTORY_CODES.limitExceeded);

    const views = await store.load();
    assert.deepEqual(views.map((job) => job.taskId), ['task-live']);
    assert.equal(views[0].state, 'running');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a save updates an existing view in place without duplicating it', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ taskId: 'task-upsert', state: 'running', endedAt: null, review: null }));
    await store.save(fixtureView({ taskId: 'task-upsert', state: 'awaiting-host-review', endedAt: 1_700_000_002_000 }));

    const views = await store.load();
    assert.equal(views.length, 1);
    assert.equal(views[0].state, 'awaiting-host-review');
    assert.equal(views[0].endedAt, 1_700_000_002_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('input views are not mutated and loaded views are detached', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView();
    const snapshot = structuredClone(view);
    await store.save(view);
    assert.deepEqual(view, snapshot, 'the caller still owns its view');

    const first = await store.load();
    first[0].taskId = 'mutated';
    first[0].execution.usage.totalTokens = 999;
    first[0].diff.files.push({ code: 'A', path: 'injected.js', from: null });

    const second = await store.load();
    assert.equal(second[0].taskId, 'task-fixture-1');
    assert.equal(second[0].execution.usage.totalTokens, 49);
    assert.equal(second[0].diff.files.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a prototype-polluting view cannot reach Object.prototype', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView();
    view.error = {
      code: 'JOB_FAILED',
      message: 'boom',
      details: JSON.parse('{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"safe":1}'),
    };
    await store.save(view);
    const [job] = await store.load();
    assert.equal({}.polluted, undefined, 'Object.prototype must stay clean');
    assert.equal(job.error.details.safe, 1);
    assert.equal(Object.hasOwn(job.error.details, '__proto__'), false);
    assert.equal(Object.hasOwn(job.error.details, 'constructor'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispose flushes the last save and refuses every later save', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const pending = store.save(fixtureView({ taskId: 'task-flushed' }));
    await store.dispose();
    await pending;
    await store.flush();
    const [job] = await new HistoryStore(dir).load();
    assert.equal(job.taskId, 'task-flushed');
    await rejectsWith(store.save(fixtureView({ taskId: 'task-late' })), HISTORY_CODES.disposed);
    await store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bounds are validated at construction and an unusable view is refused', async () => {
  const dir = await dataDir();
  try {
    assert.throws(() => new HistoryStore(''), TypeError);
    assert.throws(() => new HistoryStore(dir, { maxEntries: 0 }), TypeError);
    assert.throws(() => new HistoryStore(dir, { maxEntryBytes: 1024 }), TypeError);
    assert.throws(() => new HistoryStore(dir, { maxBytes: 4096, maxEntryBytes: 8192 }), TypeError);

    const store = new HistoryStore(dir);
    await rejectsWith(store.save({ state: 'running' }), HISTORY_CODES.viewInvalid);
    await rejectsWith(store.save(fixtureView({ state: 'approved' })), HISTORY_CODES.viewInvalid);
    await rejectsWith(store.save(null), HISTORY_CODES.viewInvalid);
    assert.deepEqual(await store.load(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('timestamps and counters are stored only as finite numbers', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      createdAt: Number.NaN,
      startedAt: -5,
      endedAt: 1e300,
      execution: {
        ...fixtureView().execution,
        usage: { inputTokens: 12, outputTokens: -1, totalTokens: Number.POSITIVE_INFINITY, reasoningTokens: 4 },
      },
    }));
    const [job] = await store.load();
    assert.equal(job.createdAt, null);
    assert.equal(job.startedAt, null);
    assert.equal(job.endedAt, null);
    assert.deepEqual(job.execution.usage, { inputTokens: 12, reasoningTokens: 4 });
    assert.equal(Number.isFinite(job.execution.usage.inputTokens), true);

    const raw = await readFile(historyFile(dir), 'utf8');
    assert.equal(raw.includes('Infinity'), false);
    assert.equal(raw.includes('NaN'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Activity metadata: safe round-trip and interrupted semantics
// ---------------------------------------------------------------------------

/**
 * An activity block shaped exactly like the engine's projection.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} activity summary.
 */
function fixtureActivity(overrides = {}) {
  return {
    lastActivityAt: 1_700_000_001_500,
    idleForMs: 12_000,
    waitingOn: 'tool',
    currentTool: { name: 'bash', callId: 'call-1', startedAt: 1_700_000_001_500, elapsedMs: 12_000 },
    lastTool: { name: 'read', durationMs: 340 },
    events: 41,
    activityEvents: 17,
    toolCallsStarted: 3,
    toolCallsFinished: 2,
    selfCheckSeconds: 300,
    attentionSeconds: 600,
    selfCheck: { episode: 4, checkedAt: 1_700_000_030_000, verdict: 'tool-running' },
    kinds: { 'text-delta': 9, 'tool-call': 3, 'tool-result': 2 },
    ...overrides,
  };
}

test('a bounded activity summary round-trips through the file unchanged', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({ activity: fixtureActivity() }));
    await store.flush();
    const reloaded = new HistoryStore(dir);
    const [row] = await reloaded.load();
    assert.equal(row.activity.events, 41);
    assert.equal(row.activity.activityEvents, 17);
    assert.equal(row.activity.waitingOn, 'tool');
    assert.equal(row.activity.currentTool.name, 'bash');
    assert.equal(row.activity.currentTool.elapsedMs, 12_000);
    assert.equal(row.activity.kinds['text-delta'], 9);
    assert.equal(row.activity.selfCheck.verdict, 'tool-running');
    assert.equal(row.activity.selfCheckSeconds, 300);
    // Storing and reloading twice must not rewrite the document.
    const first = await readFile(historyFile(dir), 'utf8');
    await new HistoryStore(dir).load();
    assert.equal(await readFile(historyFile(dir), 'utf8'), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('activity content that is not metadata can never reach the file', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      activity: fixtureActivity({
        // A hostile/over-eager summary: text, reasoning, arguments and results.
        text: 'MODEL OUTPUT TEXT',
        reasoning: 'PRIVATE CHAIN OF THOUGHT',
        currentTool: {
          name: 'bash',
          callId: 'call-1',
          startedAt: 1_700_000_001_500,
          elapsedMs: 12_000,
          arguments: '{"command":"curl -H Authorization: Bearer sk-live-abcdefghijklmnop"}',
          result: 'TOOL RESULT BODY',
        },
        transcript: [{ role: 'assistant', text: 'PRIVATE ANSWER' }],
        kinds: { 'text-delta': 9, 'made-up-kind-with-a-secret': 'sk-live-abcdefghijklmnop' },
      }),
    }));
    await store.flush();
    const raw = await readFile(historyFile(dir), 'utf8');
    for (const forbidden of ['MODEL OUTPUT TEXT', 'PRIVATE CHAIN', 'TOOL RESULT BODY', 'PRIVATE ANSWER', 'sk-live']) {
      assert.equal(raw.includes(forbidden), false, `${forbidden} must not be stored`);
    }
    const [row] = await new HistoryStore(dir).load();
    assert.equal(Object.hasOwn(row.activity, 'text'), false);
    assert.equal(Object.hasOwn(row.activity.currentTool, 'arguments'), false);
    assert.equal(row.activity.kinds['made-up-kind-with-a-secret'], undefined, 'a non-numeric counter is dropped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted run reports its activity as interrupted, never as a growing idle span', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      taskId: 'task-live',
      state: 'running',
      phase: 'execute',
      endedAt: null,
      activity: fixtureActivity(),
    }));
    await store.flush();

    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.state, 'interrupted');
    assert.equal(row.interruptedFrom, 'running');
    assert.equal(row.endedAt > 0, true, 'the interrupt is stamped');
    assert.equal(row.activity.interrupted, true);
    // The open span is closed and preserved as evidence rather than reported as
    // current: a restarted record must not claim a tool is still running.
    assert.equal(row.activity.currentTool, null);
    assert.equal(row.activity.waitingOn, null);
    assert.equal(row.activity.idleForMs, null);
    assert.equal(row.activity.interruptedTool.name, 'bash');
    assert.equal(row.activity.interruptedTool.callId, 'call-1');
    // The bounded counts survive, so history still says how much work happened.
    assert.equal(row.activity.events, 41);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history records no executor, no session and no way to replay an approval', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      state: 'running',
      activity: fixtureActivity(),
      execution: null,
      permission: {
        bridged: true,
        waiting: true,
        pending: {
          requestId: 'permission-1',
          taskId: 'task-fixture-1',
          callId: 'call-1',
          toolName: 'bash',
          state: 'pending',
          fingerprint: 'a'.repeat(64),
          arguments: '{"command":"npm test"}',
          completeness: 'complete',
        },
        evidence: [],
        pausedExecutionMs: 5000,
      },
    }));
    await store.flush();
    const raw = await readFile(historyFile(dir), 'utf8');
    // The manager/agent/session VALUES are never projected, and the exact
    // fingerprint is deliberately absent from a stored request. (The permission
    // view carries a `sessionId` KEY with a null value by its own allow-list, so
    // this asserts on values rather than on key names.)
    const parsed = JSON.parse(raw);
    const anywhere = JSON.stringify(parsed);
    for (const forbidden of ['agent-fixture-1', 'session-fixture-1', 'a'.repeat(64)]) {
      assert.equal(anywhere.includes(forbidden), false, `${forbidden} must not be stored`);
    }
    const stored = parsed.jobs[0];
    assert.equal(Object.hasOwn(stored, 'controller'), false);
    assert.equal(Object.hasOwn(stored, 'handle'), false);
    assert.equal(stored.execution, null);
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.activity.interrupted, true);
    assert.equal(row.permission.pending.state, 'unavailable', 'a stored request can never be decided');
    assert.equal(row.permission.interrupted, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the frozen monitoring thresholds are stored with the effective snapshot', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView();
    // A monitor and the task it measures must agree after a restart, and the live
    // settings may have changed since.
    view.effective = {
      ...view.effective,
      monitoring: { selfCheckSeconds: 120, attentionSeconds: 240 },
    };
    view.activity = fixtureActivity({ selfCheckSeconds: 120, attentionSeconds: 240, finalizedAt: view.endedAt });
    await store.save(view);
    await store.flush();

    const [row] = await new HistoryStore(dir).load();
    assert.deepEqual(row.effective.monitoring, { selfCheckSeconds: 120, attentionSeconds: 240 });
    // The activity block keeps the same thresholds, so a stored "idle for 12 min"
    // can still be interpreted against the threshold it was measured under.
    assert.equal(row.activity.selfCheckSeconds, 120);
    assert.equal(row.activity.attentionSeconds, 240);
    assert.equal(row.activity.finalizedAt, view.endedAt, 'a final span is marked as final');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a frozen activity record does not drift between loads', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    const view = fixtureView();
    view.activity = fixtureActivity({ finalizedAt: view.endedAt, idleForMs: 120_000 });
    await store.save(view);
    await store.flush();
    const first = await readFile(historyFile(dir), 'utf8');
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.activity.idleForMs, 120_000);
    // Reloading rewrites nothing: a stored span is already the final one.
    assert.equal(await readFile(historyFile(dir), 'utf8'), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted record keeps the cut-off tool call as evidence', async () => {
  const dir = await dataDir();
  try {
    const store = new HistoryStore(dir);
    await store.save(fixtureView({
      state: 'running',
      endedAt: null,
      activity: fixtureActivity(),
    }));
    await store.flush();
    const [row] = await new HistoryStore(dir).load();
    assert.equal(row.activity.interrupted, true);
    assert.equal(row.activity.currentTool, null);
    // The call that was in flight is preserved, not deleted: it is how a reader
    // learns the run was cut off mid-tool rather than simply idle.
    assert.equal(row.activity.interruptedTool.name, 'bash');
    assert.equal(row.activity.interruptedTool.callId, 'call-1');
    assert.equal(typeof row.activity.interruptedTool.elapsedMs, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
