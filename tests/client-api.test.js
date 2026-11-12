import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_ACTIONS, ROUTES, createStore, defaultDraft, documentFromDraft, draftFromSettings, exportDocument, formatDuration, hasLiveTasks, isLiveTask, minutesToSeconds, precheckDraft, precheckMonitoring, previewEffective, secondsToMinutes, taskActivity, taskProgress } from '../src/client/api.js';
import {
  CONVERSATION_LABELS,
  CONVERSATION_MODES,
  CONVERSATION_POLICY_LABEL,
  conversationOf,
} from '../src/client/api.js';
import { WAIT_REASON_LABELS, codexMcpDriftText, taskStateLabel } from '../src/client/api.js';

function configuredDraft(provider) {
  const draft = defaultDraft();
  draft.providers = [provider];
  draft.worker = {
    ...draft.worker,
    providerId: provider.id,
    model: provider.models[0].id,
    reasoningEffort: provider.models[0].efforts[0] ?? null,
  };
  return draft;
}

test('native provider source survives settings round trips without custom endpoint fields', () => {
  const settings = {
    schemaVersion: 1,
    providers: [{
      id: 'workbuddy',
      name: 'Workbuddy',
      source: 'native',
      models: [{ id: 'deepseek-v4.1-flash', efforts: ['high'] }],
    }],
  };

  const draft = draftFromSettings(settings);
  const [provider] = documentFromDraft(draft).providers;

  assert.equal(draft.providers[0].source, 'native');
  assert.equal(provider.source, 'native');
  assert.equal(Object.hasOwn(provider, 'baseUrl'), false);
  assert.equal(Object.hasOwn(provider, 'protocol'), false);
  assert.equal(Object.hasOwn(provider, 'credentialRef'), false);
});

test('native provider without a base URL passes client precheck', () => {
  const draft = configuredDraft({
    id: 'workbuddy',
    name: 'Workbuddy',
    source: 'native',
    models: [{ id: 'deepseek-v4.1-flash', efforts: ['high'] }],
  });

  assert.deepEqual(precheckDraft(draft), []);
});

test('custom provider still requires a base URL', () => {
  const draft = configuredDraft({
    id: 'relay',
    name: 'Relay',
    source: 'custom',
    protocol: 'openai-chat',
    baseUrl: '',
    models: [{ id: 'model-a', efforts: ['high'] }],
  });

  assert.ok(precheckDraft(draft).includes('提供方「relay」缺少接口地址'));
});

test('the Codex integration uses one route and offers no "status" action to the page', () => {
  // One path, two methods: `GET` diagnoses, `POST` performs one explicit action.
  assert.equal(ROUTES.codex, '/api/dsh-delegate/codex');
  assert.deepEqual([...CODEX_ACTIONS], ['install', 'repair', 'remove']);
  // `status` would be a write-less POST that looks like an action; the page reads
  // through `GET` instead, so it is absent from the action vocabulary.
  assert.equal(CODEX_ACTIONS.includes('status'), false);
  // The Codex settings are not part of the delegation document.
  assert.equal(JSON.stringify(defaultDraft()).includes('codex'), false);
});


// --- The retired conversation control ----------------------------------------
//
// There is no mode control on the page any more. What remains is a compatibility
// concern with one property: a save must not rewrite an operator's stored document
// into a state they did not choose, and the value must never influence a run.

test('the page has no conversation-mode choice left to offer', () => {
  assert.deepEqual([...CONVERSATION_MODES], ['new', 'reuse'], 'the ids still exist so a stored document renders');
  assert.match(CONVERSATION_LABELS.reuse, /已移除/, 'the label states that the capability is gone');
  assert.equal(typeof CONVERSATION_POLICY_LABEL, 'string');
  assert.match(CONVERSATION_POLICY_LABEL, /continueFromTaskId/);
});

test('a stored legacy reuse value is preserved verbatim, not silently rewritten', () => {
  const draft = draftFromSettings({ schemaVersion: 1, conversation: { mode: 'reuse' } });
  assert.deepEqual(draft.conversation, { mode: 'reuse' }, 'the page must reopen on what the document says');
  assert.deepEqual(documentFromDraft(draft).conversation, { mode: 'reuse' }, 'and it must be saved back unchanged');
});

test('a document with no conversation block opens as the default, and saving states it', () => {
  const draft = draftFromSettings({ schemaVersion: 1 });
  assert.deepEqual(draft.conversation, { mode: 'new' });
  assert.deepEqual(documentFromDraft(draft).conversation, { mode: 'new' });
});

test('an unknown stored mode falls back to the default instead of being echoed', () => {
  // The host refuses an unknown mode; the page must not send one back.
  const draft = draftFromSettings({ schemaVersion: 1, conversation: { mode: 'resume' } });
  assert.deepEqual(draft.conversation, { mode: 'new' });
  assert.deepEqual(documentFromDraft(draft).conversation, { mode: 'new' });
});

test('conversationOf resolves an absent or malformed block without inventing a mode', () => {
  assert.deepEqual(conversationOf(undefined), { mode: 'new' });
  assert.deepEqual(conversationOf(null), { mode: 'new' });
  assert.deepEqual(conversationOf({}), { mode: 'new' });
  assert.deepEqual(conversationOf({ conversation: { mode: 'reuse' } }), { mode: 'reuse' });
  assert.deepEqual(conversationOf({ conversation: true }), { mode: 'new' });
});


test('the built page no longer offers a conversation-mode control, and states the rule', async () => {
  // A control that is hidden in the source but present in the built bundle would
  // still reach an operator, so the assertion is on `lib/client.js`.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const built = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8');
  assert.equal(/dshdg-conversation-mode/u.test(built), false, 'the retired mode select must be gone from the bundle');
  assert.match(built, /dshdg-conversation-policy/u, 'the panel must state the per-task rule instead');
  assert.match(built, /continueFromTaskId/u, 'and name the only way to continue a thread');
  assert.match(built, /已移除/u, 'and say that the reuse setting was removed');
});

// ---------------------------------------------------------------------------
// Monitoring thresholds in the client document layer
// ---------------------------------------------------------------------------

test('a document without monitoring opens with the 5/10-minute defaults', () => {
  // An old stored file (and an old host) has no `monitoring` key at all.
  const draft = draftFromSettings({ schemaVersion: 1, providers: [] });
  assert.deepEqual(draft.monitoring, { selfCheckSeconds: 300, attentionSeconds: 600 });
  assert.equal(defaultDraft().monitoring.selfCheckSeconds, 300);
  assert.equal(defaultDraft().monitoring.attentionSeconds, 600);
});

test('monitoring survives draft, document and preview round trips as whole seconds', () => {
  const draft = draftFromSettings({
    schemaVersion: 1,
    providers: [],
    monitoring: { selfCheckSeconds: 90, attentionSeconds: 240 },
  });
  assert.deepEqual(draft.monitoring, { selfCheckSeconds: 90, attentionSeconds: 240 });
  assert.deepEqual(documentFromDraft(draft).monitoring, { selfCheckSeconds: 90, attentionSeconds: 240 });
  assert.deepEqual(previewEffective(draft, null).monitoring, { selfCheckSeconds: 90, attentionSeconds: 240 });
  // The export text is the same non-secret document, so it carries the block too.
  assert.match(exportDocument(draft), /"selfCheckSeconds": 90/u);
});

test('a fractional or non-numeric stored value is coerced to whole seconds', () => {
  const draft = draftFromSettings({ monitoring: { selfCheckSeconds: 90.7, attentionSeconds: '600' } });
  assert.equal(draft.monitoring.selfCheckSeconds, 90);
  // A non-finite value falls back to the documented default rather than NaN.
  assert.equal(draft.monitoring.attentionSeconds, 600);
});

test('minutes and seconds convert without inventing a value', () => {
  assert.equal(secondsToMinutes(300), 5);
  assert.equal(secondsToMinutes(90), 1.5);
  assert.equal(minutesToSeconds(5), 300);
  assert.equal(minutesToSeconds(1.5), 90);
  assert.equal(minutesToSeconds(''), Number.NaN);
  assert.equal(minutesToSeconds('abc'), Number.NaN);
});

test('the local precheck mirrors the host bounds and ordering rule', () => {
  assert.deepEqual(precheckMonitoring({ selfCheckSeconds: 300, attentionSeconds: 600 }), []);
  assert.equal(precheckMonitoring({ selfCheckSeconds: 29, attentionSeconds: 600 }).length, 1);
  assert.equal(precheckMonitoring({ selfCheckSeconds: 3601, attentionSeconds: 7200 }).length, 1);
  assert.equal(precheckMonitoring({ selfCheckSeconds: 300, attentionSeconds: 7201 }).length, 1);
  // Attention must be strictly greater than the self-check.
  assert.equal(precheckMonitoring({ selfCheckSeconds: 600, attentionSeconds: 600 }).length, 1);
  assert.match(precheckMonitoring({ selfCheckSeconds: 600, attentionSeconds: 300 })[0], /必须大于程序自检间隔/u);
  // A non-integer is refused, not rounded into a different setting.
  assert.equal(precheckMonitoring({ selfCheckSeconds: 300.5, attentionSeconds: 600 }).length >= 1, true);
  // And the combined precheck reports it too, so the save button blocks.
  assert.ok(precheckDraft({ ...defaultDraft(), monitoring: { selfCheckSeconds: 600, attentionSeconds: 300 } })
    .some((problem) => problem.includes('提醒')));
});

test('saving monitoring does not disturb an unsaved provider edit and keeps the draft dirty', async () => {
  const calls = [];
  const api = {
    async getSettings() { return { ok: true, settings: { schemaVersion: 1, providers: [] } }; },
    async putMonitoring(monitoring) {
      calls.push(monitoring);
      return { ok: true, monitoring, settings: { schemaVersion: 1, providers: [], monitoring } };
    },
  };
  const store = createStore({ api });
  await store.loadSettings();
  // A half-finished provider edit the operator has not saved yet.
  store.editDraft((draft) => {
    draft.workers = undefined;
    draft.providers.push({ id: 'relay', name: 'Relay', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1', models: [] });
  });
  assert.equal(store.getSnapshot().dirty, true);

  const result = await store.saveMonitoring({ selfCheckSeconds: 120, attentionSeconds: 300 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ selfCheckSeconds: 120, attentionSeconds: 300 }]);
  const after = store.getSnapshot();
  // The narrow save adopts the committed document for `settings`…
  assert.deepEqual(after.settings.monitoring, { selfCheckSeconds: 120, attentionSeconds: 300 });
  // …updates the draft's monitoring block…
  assert.deepEqual(after.draft.monitoring, { selfCheckSeconds: 120, attentionSeconds: 300 });
  // …and leaves the unsaved provider edit exactly where it was.
  assert.equal(after.draft.providers.length, 1);
  assert.equal(after.draft.providers[0].id, 'relay');
  assert.equal(after.dirty, true, 'an unsaved provider edit is still unsaved');
});

test('an invalid monitoring save is refused locally and writes nothing', async () => {
  let wrote = false;
  const store = createStore({
    api: {
      async getSettings() { return { ok: true, settings: { schemaVersion: 1, providers: [] } }; },
      async putMonitoring() { wrote = true; return { ok: true }; },
    },
  });
  await store.loadSettings();
  const result = await store.saveMonitoring({ selfCheckSeconds: 600, attentionSeconds: 300 });
  assert.equal(result.ok, false);
  assert.equal(wrote, false, 'the host is never called with a pair the precheck rejects');
});

// ---------------------------------------------------------------------------
// Task progress metadata and the bounded auto-refresh lifetime
// ---------------------------------------------------------------------------

/** @returns {object} a task view carrying a live activity block. */
function liveTaskView(overrides = {}) {
  return {
    taskId: 'task-live-1',
    state: 'running',
    phase: 'execute',
    activity: {
      lastActivityAt: 1_000_000,
      idleForMs: 42_000,
      waitingOn: 'tool',
      currentTool: { name: 'bash', callId: 'c1', startedAt: 1_000_000, elapsedMs: 300_000 },
      lastTool: { name: 'read', durationMs: 120 },
      events: 40,
      activityEvents: 12,
      toolCallsStarted: 2,
      toolCallsFinished: 1,
      selfCheckSeconds: 300,
      attentionSeconds: 600,
      selfCheck: { episode: 1, checkedAt: 1_300_000, verdict: 'tool-running' },
      finalizedAt: null,
    },
    ...overrides,
  };
}

test('a task with an activity block describes its phase, silence and running tool', () => {
  const progress = taskProgress(liveTaskView());
  assert.equal(progress.available, true);
  assert.match(progress.headline, /执行中/u);
  assert.match(progress.headline, /距上次进展 42 秒/u);
  assert.match(progress.headline, /正在运行 bash（已 5 分 0 秒）/u);
  assert.match(progress.detail, /某个工具调用仍在运行/u);
  assert.match(progress.detail, /程序自检结论：某个工具调用仍在运行/u);
  // No completion percentage is ever invented.
  assert.doesNotMatch(progress.headline, /%/u);
  assert.doesNotMatch(progress.detail, /%/u);
});

test('a record with no activity block is reported honestly, never as idle', () => {
  // Every task stored before this feature looks like this.
  const progress = taskProgress({ taskId: 'old', state: 'running', phase: 'execute' });
  assert.equal(progress.available, false);
  assert.match(progress.headline, /未采集到进展信息/u);
  assert.match(progress.detail, /没有信息不等于没有进展/u);
  assert.equal(taskActivity({ taskId: 'old' }), null);
});

test('a frozen activity block stops moving and says so', () => {
  const frozen = liveTaskView();
  frozen.state = 'awaiting-host-review';
  frozen.phase = 'awaiting-host-review';
  frozen.activity = { ...frozen.activity, finalizedAt: 1_400_000, currentTool: null, waitingOn: 'idle' };
  const progress = taskProgress(frozen);
  assert.match(progress.detail, /任务已结束，这些时间不再变化/u);
  assert.equal(progress.tone, 'off');
});

test('durations are bounded to two units and never invent a value', () => {
  assert.equal(formatDuration(0), '0 秒');
  assert.equal(formatDuration(42_000), '42 秒');
  assert.equal(formatDuration(300_000), '5 分 0 秒');
  assert.equal(formatDuration(3_930_000), '1 小时 5 分');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(-1), '—');
  assert.equal(formatDuration(Number.NaN), '—');
});

test('only pending and running tasks are live for refresh purposes', () => {
  assert.equal(isLiveTask({ state: 'running' }), true);
  assert.equal(isLiveTask({ state: 'pending' }), true);
  for (const state of ['awaiting-host-review', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(isLiveTask({ state }), false);
  }
  assert.equal(hasLiveTasks([]), false);
  assert.equal(hasLiveTasks([{ state: 'failed' }]), false);
  assert.equal(hasLiveTasks([{ state: 'failed' }, { state: 'running' }]), true);
});

test('a real interrupted history is shown as ended, never as still running', () => {
  // The state a restart leaves behind. The panel must say it will not continue; the
  // word "running" must not appear in either label.
  const label = taskStateLabel('interrupted');
  assert.match(label, /中断/u);
  assert.match(label, /不会继续执行/u);
  assert.doesNotMatch(label, /执行中|仍在运行/u);
  // The WAIT reason covers a LIVE task, a restart history AND an unreadable record, so
  // the label must not claim either outcome: it points at the fields that decide.
  assert.match(WAIT_REASON_LABELS.interrupted, /等待被中断/u);
  assert.doesNotMatch(WAIT_REASON_LABELS.interrupted, /任务本身没有停止/u,
    'an unknown record must not be described as definitely not stopped');
  assert.doesNotMatch(WAIT_REASON_LABELS.interrupted, /任务仍在运行/u,
    'and not as definitely still running either');
  assert.match(WAIT_REASON_LABELS.interrupted, /terminal/u, 'the label names the field that decides');
  // A progress line for such a record promises no further progress.
  const progress = taskProgress({
    taskId: 'task-1',
    state: 'interrupted',
    phase: 'execute',
    activity: { lastActivityAt: 1, idleForMs: 5_000, waitingOn: 'idle', currentTool: null, events: 3, activityEvents: 2 },
  });
  assert.match(progress.detail, /不会继续执行/u);
  assert.equal(progress.available, true);
});

test('an outdated managed MCP entry is described by the facts that are stale', () => {
  assert.match(codexMcpDriftText({ drift: ['tool_timeout_sec'] }), /工具超时/u);
  assert.match(codexMcpDriftText({ drift: ['tool_timeout_sec'] }), /工具超时/u);
  // No client is GUARANTEED to truncate a long call: the real 1.1 acceptance never proved
  // that attribution, so the label states a possibility instead of promising it.
  assert.doesNotMatch(codexMcpDriftText({ drift: ['tool_timeout_sec'] }), /会提前中断/u);
  assert.match(codexMcpDriftText({ drift: ['tool_timeout_sec'] }), /可能/u);
  assert.match(codexMcpDriftText({ drift: ['args'] }), /入口脚本路径/u);
  assert.match(codexMcpDriftText({ drift: ['tool_timeout_sec', 'args'] }), /工具超时.*入口脚本路径/u);
  assert.equal(codexMcpDriftText({ drift: [] }), '托管 MCP 条目需要更新');
  assert.equal(codexMcpDriftText({}), '托管 MCP 条目需要更新');
  // An unknown fact is shown by its own name rather than hidden.
  assert.equal(codexMcpDriftText({ drift: ['mystery'] }), 'mystery');
});

test('a background refresh publishes the list and the selected detail without a second read', async () => {
  const tasks = [liveTaskView(), { taskId: 'task-old', state: 'failed', phase: 'failed' }];
  let listCalls = 0;
  const store = createStore({
    api: {
      async listTasks() { listCalls += 1; return { ok: true, tasks }; },
      async getTask(taskId) { return { ok: true, task: tasks.find((task) => task.taskId === taskId) }; },
    },
  });
  await store.openTask('task-live-1');
  const result = await store.refreshTasks('auto');
  assert.equal(result.ok, true);
  assert.equal(listCalls, 1, 'one list read, no detail read');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.tasks.length, 2);
  assert.equal(snapshot.taskDetail.taskId, 'task-live-1', 'the selection is preserved');
  assert.equal(snapshot.taskDetail.activity.selfCheck.verdict, 'tool-running',
    'the detail came from the same snapshot');
});

test('a background refresh never notifies on failure and never clears the list', async () => {
  let fail = false;
  const store = createStore({
    api: {
      async listTasks() {
        if (fail) throw Object.assign(new Error('blip'), { code: 'HTTP_503', status: 503 });
        return { ok: true, tasks: [liveTaskView()] };
      },
    },
  });
  await store.refreshTasks('auto');
  assert.equal(store.getSnapshot().tasks.length, 1);
  const noticesBefore = store.getSnapshot().notices.length;
  fail = true;
  const result = await store.refreshTasks('auto');
  assert.equal(result.ok, false);
  assert.equal(store.getSnapshot().notices.length, noticesBefore, 'a silent refresh adds no notice');
  assert.equal(store.getSnapshot().tasks.length, 1, 'the previous list survives a failed read');
});

test('a refresh in flight suppresses a second one instead of overlapping', async () => {
  let resolveList;
  let listCalls = 0;
  const store = createStore({
    api: {
      listTasks() {
        listCalls += 1;
        return new Promise((resolvePromise) => { resolveList = resolvePromise; });
      },
    },
  });
  const first = store.refreshTasks('auto');
  const second = await store.refreshTasks('auto');
  assert.equal(second.skipped, 'in-flight');
  assert.equal(listCalls, 1, 'the overlapping call never reached the host');
  resolveList({ ok: true, tasks: [] });
  await first;
});
