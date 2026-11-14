// R2 (page refresh) and R5 (long-note display and compact reads).
//
// R2: the page must keep refreshing while a RECORD may still change — a task awaiting host
// review, or a review being written from outside — not only while something executes. It
// must stop once every visible conclusion is durable, pause while hidden, read once
// immediately when the page comes back, never overlap, and keep the content it already has
// when a refresh fails.
//
// R5: the list shows at most 200 code points of the note with a clear way to read the rest;
// the detail expands/copies the WHOLE note; and a wait carries only the conclusion's status,
// time and length. The whole note stays readable through a paged `delegate_result` read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECORD_REFRESH_INTERVAL_MS,
  REVIEW_NOTE_PREVIEW_CHARS,
  hasChangingRecords,
  isTaskRecordChanging,
  recordRefreshPlan,
  reviewNotePreview,
  taskOutcome,
} from '../src/client/api.js';
import {
  DEFAULT_REVIEW_NOTE_PAGE_CHARS,
  MAX_REVIEW_NOTE_PAGE_CHARS,
  MAX_TOOL_TEXT_CHARS,
  createMcpServer,
} from '../src/mcp/server.js';
import { compactTask } from '../src/mcp/wait.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_SOURCE = readFileSync(join(ROOT, 'src', 'client', 'index.jsx'), 'utf8');

/** A finished task waiting for review, with nothing written yet. */
const WAITING = Object.freeze({
  taskId: 't-waiting',
  state: 'awaiting-host-review',
  phase: 'awaiting-host-review',
  hostAcceptance: null,
  reviewPersistence: { state: 'none', durable: false, pending: false },
});

/**
 * A note of exactly `count` code points, mixing emoji, Chinese and JSON-sensitive text.
 * @param {number} count - code points.
 * @returns {string} note.
 */
function mixedNote(count) {
  const pieces = ['😀', '中', '"', '\\', '\n', 'a'];
  let out = '';
  for (let index = 0; Array.from(out).length < count; index += 1) out += pieces[index % pieces.length];
  return Array.from(out).slice(0, Math.max(1, count - 1)).concat('末').slice(0, count).join('');
}

// ---------------------------------------------------------------------------
// R2: what keeps the page polling
// ---------------------------------------------------------------------------

test('a record is changing while it runs, waits for review, or its conclusion is being written', () => {
  assert.equal(isTaskRecordChanging({ state: 'pending' }), true);
  assert.equal(isTaskRecordChanging({ state: 'running', phase: 'execute' }), true);
  // A finished run whose review has not been recorded yet: the commander may write it now.
  assert.equal(isTaskRecordChanging(WAITING), true);
  // A review mid-save, including one whose wait expired but whose write still runs.
  assert.equal(isTaskRecordChanging({
    ...WAITING,
    reviewPersistence: { state: 'saving', durable: false, pending: true },
  }), true);
  assert.equal(isTaskRecordChanging({
    ...WAITING,
    reviewPersistence: { state: 'timed-out', durable: false, pending: true },
  }), true);
  // A durable conclusion with nothing else in flight is settled.
  assert.equal(isTaskRecordChanging({
    ...WAITING,
    hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1, note: 'ok' },
    reviewPersistence: { state: 'saved', durable: true, pending: false },
  }), false);
  assert.equal(isTaskRecordChanging({ state: 'failed' }), false);
  assert.equal(isTaskRecordChanging({ state: 'cancelled' }), false);
  assert.equal(isTaskRecordChanging(null), false);
});

test('the refresh plan pauses when hidden, skips while loading, and stops when settled', () => {
  const tasks = [WAITING];
  assert.deepEqual(recordRefreshPlan({ tasks, visible: true }), {
    refresh: true, intervalMs: RECORD_REFRESH_INTERVAL_MS, reason: 'changing',
  });
  assert.equal(RECORD_REFRESH_INTERVAL_MS, 5_000, 'the page refreshes every 5 seconds');
  // Hidden: no polling at all.
  assert.equal(recordRefreshPlan({ tasks, visible: false }).reason, 'hidden');
  assert.equal(recordRefreshPlan({ tasks, visible: false }).refresh, false);
  // A request already in flight owns the next tick, so reads never overlap.
  assert.equal(recordRefreshPlan({ tasks, visible: true, loading: true }).reason, 'loading');
  assert.equal(recordRefreshPlan({ tasks, visible: true, loading: true }).refresh, false);
  // A page of settled conclusions does not poll.
  const settled = [{
    state: 'awaiting-host-review',
    hostAcceptance: { accepted: true, accepted: false, state: 'changes-requested', acceptedAt: 1, note: 'redo' },
    reviewPersistence: { state: 'saved', durable: true, pending: false },
  }];
  assert.equal(recordRefreshPlan({ tasks: settled, visible: true }).reason, 'settled');
  // The SELECTED detail counts too: a stale list row must not hide a changing detail.
  assert.equal(recordRefreshPlan({ tasks: [], selectedTask: WAITING, visible: true }).refresh, true);
  assert.equal(hasChangingRecords(settled), false);
});

test('the page keeps polling for review but offers no cancel and no "running" claim', () => {
  // The hook is driven by the record predicate, not by "is live".
  assert.match(PAGE_SOURCE, /recordRefreshPlan\(/u);
  assert.match(PAGE_SOURCE, /hasChangingRecords\(/u);
  // Hidden tabs pause, and returning reads immediately.
  assert.match(PAGE_SOURCE, /visibilitychange/u);
  assert.match(PAGE_SOURCE, /document\?\.hidden === true/u);
  // No overlapping reads.
  assert.match(PAGE_SOURCE, /if \(inFlight\) return/u);
  // A failed refresh is stated, not turned into a lost task.
  assert.match(PAGE_SOURCE, /自动刷新失败/u);
  // A waiting task is still not cancellable and not described as executing.
  assert.equal(taskOutcome(WAITING).label, '等待宿主审查');
  assert.notEqual(taskOutcome(WAITING).label, '执行中');
});

test('a conclusion being saved is never shown as accepted', () => {
  const base = { taskId: 't', state: 'awaiting-host-review', phase: 'awaiting-host-review' };
  assert.equal(taskOutcome({
    ...base,
    reviewPersistence: { state: 'saving', durable: false, pending: true, decision: 'accepted' },
  }).label, '审查结论保存中');
  assert.equal(taskOutcome({
    ...base,
    reviewPersistence: { state: 'timed-out', durable: false, pending: true, decision: 'accepted' },
  }).label, '审查结论保存未确认');
  assert.equal(taskOutcome({
    ...base,
    reviewPersistence: { state: 'failed', durable: false, pending: false, error: { code: 'HISTORY_WRITE_FAILED' } },
  }).label, '审查结论保存失败');
  // Only a durable conclusion reads as 审查通过 — and the saving states never do.
  for (const state of ['saving', 'timed-out', 'failed']) {
    const outcome = taskOutcome({
      ...base,
      hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1, note: 'x' },
      reviewPersistence: { state, durable: false, pending: state !== 'failed' },
    });
    assert.notEqual(outcome.accepted, true, `${state} must not be accepted`);
    assert.notEqual(outcome.label, '审查通过');
  }
  assert.equal(taskOutcome({
    ...base,
    hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1, note: 'x' },
    reviewPersistence: { state: 'saved', durable: true, pending: false },
  }).label, '审查通过');
});

// ---------------------------------------------------------------------------
// R5: the list preview and the detail's full text
// ---------------------------------------------------------------------------

test('the list preview is at most 200 code points and says the whole note is longer', () => {
  const note = mixedNote(8_000);
  const preview = reviewNotePreview({
    hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1, note },
  });
  assert.equal(REVIEW_NOTE_PREVIEW_CHARS, 200);
  assert.equal(Array.from(preview.text).length, 200);
  assert.equal(preview.chars, 8_000, 'the length is the WHOLE saved note');
  assert.equal(preview.truncated, true);
  assert.equal(note.startsWith(preview.text), true, 'the preview is a prefix of the saved text');
  // Short notes are shown whole and need no "view full" affordance.
  const short = reviewNotePreview({ hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1, note: '挺好' } });
  assert.equal(short.text, '挺好');
  assert.equal(short.truncated, false);
  // A compact answer that omitted the body still states its existence and length.
  const omitted = reviewNotePreview({ hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1, noteChars: 8_000, noteOmitted: true } });
  assert.equal(omitted.omitted, true);
  assert.equal(omitted.chars, 8_000);
  // No conclusion, no preview.
  assert.equal(reviewNotePreview({ hostAcceptance: null }), null);
});

test('the page renders a 200-code-point preview, an expanded full text and a copy action', () => {
  assert.match(PAGE_SOURCE, /function TaskListNote/u);
  assert.match(PAGE_SOURCE, /查看完整审查意见/u);
  assert.match(PAGE_SOURCE, /function ReviewNoteDetail/u);
  assert.match(PAGE_SOURCE, /展开全文/u);
  assert.match(PAGE_SOURCE, /复制全文/u);
  // A failed copy says so instead of pretending the clipboard holds it.
  assert.match(PAGE_SOURCE, /复制失败/u);
  // The detail renders the SAVED body, not the preview.
  assert.match(PAGE_SOURCE, /\{full\}/u);
});

// ---------------------------------------------------------------------------
// R5: a wait stays short, and the full body is read in pages
// ---------------------------------------------------------------------------

test('a wait carries the conclusion status and length, never the note body', () => {
  const note = mixedNote(8_000);
  const task = {
    taskId: 't',
    state: 'awaiting-host-review',
    phase: 'awaiting-host-review',
    hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, by: 'host-commander', note },
    reviewPersistence: { state: 'saved', durable: true, pending: false },
  };
  const compact = compactTask(task);
  assert.equal(compact.hostAcceptance.accepted, true);
  assert.equal(compact.hostAcceptance.noteOmitted, true);
  assert.equal(compact.hostAcceptance.noteChars, 8_000);
  assert.equal('note' in compact.hostAcceptance, false, 'the body never travels on a wait');
  assert.equal(compact.reviewPersistence.durable, true);
  // The answer does NOT grow with the note: a 1-character note and an 8000 one are the
  // same size apart from the digits of the length.
  const short = compactTask({
    ...task,
    hostAcceptance: { ...task.hostAcceptance, note: 'ok' },
  });
  assert.ok(JSON.stringify(compact).length - JSON.stringify(short).length < 16);

});

test('a paged read returns the exact note, page by page', async () => {
  const note = mixedNote(8_000);
  const task = {
    taskId: 't-page',
    state: 'awaiting-host-review',
    hostAcceptance: { accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, by: 'host-commander', note },
    reviewPersistence: { state: 'saved', durable: true, pending: false },
  };
  const server = createMcpServer({ async callExecution() { return { ok: true, task }; } });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  const read = async (args) => {
    const answer = await server.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_result', arguments: { taskId: 't-page', ...args } },
    });
    assert.equal(answer.result.isError, undefined);
    return JSON.parse(answer.result.content[0].text);
  };

  assert.equal(DEFAULT_REVIEW_NOTE_PAGE_CHARS, 2_000);
  assert.equal(MAX_REVIEW_NOTE_PAGE_CHARS, 2_000);

  const pages = [];
  let offset = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await read({ reviewNoteOffset: offset });
    assert.equal(page.reviewNote.offset, offset);
    assert.equal(page.reviewNote.noteChars, 8_000);
    assert.equal(Array.from(page.reviewNote.text).length <= MAX_REVIEW_NOTE_PAGE_CHARS, true);
    pages.push(page.reviewNote.text);
    if (page.reviewNote.complete === true) break;
    assert.equal(typeof page.reviewNote.nextOffset, 'number');
    offset = page.reviewNote.nextOffset;
  }
  assert.equal(pages.join(''), note, 'the pages reassemble the saved note EXACTLY');
  assert.equal(pages.length, 4, '8000 code points in 2000-code-point pages');

  // An explicit smaller page size is honoured and still reassembles.
  const first = await read({ reviewNoteOffset: 0, reviewNoteLimit: 7 });
  assert.equal(Array.from(first.reviewNote.text).length, 7);
  assert.equal(first.reviewNote.nextOffset, 7);
  assert.equal(first.reviewNote.complete, false);
  // Reading past the end is an empty, complete page rather than an error.
  const past = await read({ reviewNoteOffset: 8_000 });
  assert.equal(past.reviewNote.text, '');
  assert.equal(past.reviewNote.complete, true);
  assert.equal(past.reviewNote.nextOffset, null);
  // A page stays small: far under the tool-text bound.
  const page = await read({ reviewNoteOffset: 0 });
  assert.ok(JSON.stringify(page).length < MAX_TOOL_TEXT_CHARS / 2);
});

test('the paged read refuses a page larger than the bound', async () => {
  const server = createMcpServer({ async callExecution() { return { ok: true, task: null }; } });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  for (const args of [
    { reviewNoteOffset: 0, reviewNoteLimit: 2_001 },
    { reviewNoteOffset: 0, reviewNoteLimit: 0 },
    { reviewNoteOffset: -1 },
    { reviewNoteLimit: 7 },
  ]) {
    const answer = await server.handle({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'delegate_result', arguments: { taskId: 't', ...args } },
    });
    assert.equal(answer.result.isError, true, JSON.stringify(args));
  }
});

test('a full result that cannot carry the note says so instead of shortening it', async () => {
  const note = mixedNote(8_000);
  // The same note appears twice in a real answer (top-level and inside the task), which is
  // what pushes a large result past the tool-text bound.
  const big = 'x'.repeat(12_000);
  const acceptance = {
    accepted: true, state: 'accepted', acceptedAt: 1_700_000_000_000, by: 'host-commander', note,
  };
  const server = createMcpServer({
    async callExecution() {
      return {
        ok: true,
        hostAcceptance: acceptance,
        task: {
          taskId: 't-big',
          state: 'awaiting-host-review',
          hostAcceptance: acceptance,
          execution: { outcome: 'completed', text: big },
          diff: { patchText: big },
        },
      };
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const answer = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'delegate_result', arguments: { taskId: 't-big' } },
  });
  assert.equal(answer.result.isError, undefined);
  const text = answer.result.content[0].text;
  assert.ok(text.length <= MAX_TOOL_TEXT_CHARS);
  const body = JSON.parse(text);
  const acceptanceOut = body.task?.hostAcceptance ?? body.hostAcceptance;
  // Either the whole note traveled, or it is explicitly omitted — never a shortened body.
  if (typeof acceptanceOut.note === 'string') {
    assert.equal(acceptanceOut.note, note,
      `a carried note is the whole note; length=${Array.from(acceptanceOut.note).length}; `
      + `truncation=${JSON.stringify(body.truncation ?? null)}`);
  } else {
    assert.equal(acceptanceOut.noteOmitted, true);
    assert.equal(acceptanceOut.noteChars, 8_000);
    assert.match(text, /reviewNoteOffset/u);
  }
  assert.equal(text.includes('… [truncated]') && acceptanceOut.note?.includes('末'), false);
});
