// Independent review tests.
//
// Review is only worth having if it is genuinely separate from the worker:
// different model selection, read-only tools, and no authority to approve. Each
// of those is asserted here rather than described in a comment.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksMutating,
  parseVerdict,
  REVIEW_STATES,
  reviewWork,
  reviewerToolAllowList,
} from '../src/review/reviewer.js';
import { buildReviewPrompt, buildWorkerPrompt, renderEvidence } from '../src/review/prompts.js';
import { fakeAgents } from './helpers/fakes.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const SELECTION = { providerId: 'reviewer', providerRoute: 'reviewer', model: 'audit-model', reasoningEffort: 'high' };

function reviewDeps(agents) {
  return { agents };
}

test('the reviewer runs on its own provider, model and effort', async () => {
  const agents = fakeAgents({ respond: { text: 'VERDICT: approve\nREASON: looks correct' } });
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

test('the reviewer installs both a visibility restriction and an execution guard', async () => {
  const agents = fakeAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  const tools = agents.created[0].agentCtx.tools;
  assert.equal(tools.restrictFilters.length, 1, 'a restriction must be installed');
  assert.equal(tools.guards.length, 1, 'an execution guard must be installed');
  assert.deepEqual(tools.restrictFilters[0].allow.includes('read_file'), true);
  assert.equal(tools.restrictFilters[0].allow.includes('write_file'), false);
});

test('the read-only guard denies a mutation-shaped tool', async () => {
  const agents = fakeAgents({ respond: { text: 'VERDICT: approve' } });
  await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });

  const guard = agents.created[0].agentCtx.tools.guards[0];
  assert.equal(guard({ name: 'read_file' }), undefined, 'a read tool must be allowed');
  assert.match(guard({ name: 'write_file' }), /read-only/);
  assert.match(guard({ name: 'shell_exec' }), /read-only/);
  assert.match(guard({ name: 'git_commit' }), /read-only/);
  assert.match(guard({ name: 'apply_patch' }), /read-only/);
  // A tool that is neither clearly read-only nor mutation-shaped is still denied,
  // because the allow-list is deny-by-default.
  assert.match(guard({ name: 'some_unknown_tool' }), /not permitted/);
  assert.match(guard({}), /identity missing/);
});

test('review denials are recorded as evidence', async () => {
  const agents = fakeAgents({
    respond: { text: 'VERDICT: approve' },
    script: async ({ record }) => {
      const guard = record.agentCtx.tools.guards[0];
      guard({ name: 'write_file' });
      guard({ name: 'unknown_tool' });
    },
  });
  const result = await reviewWork(reviewDeps(agents), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.denials.length, 2);
  assert.match(result.denials[0].reason, /mutation|read-only/);
});

test('the reviewer cannot approve on the host behalf', async () => {
  const agents = fakeAgents({ respond: { text: 'VERDICT: approve\nREASON: fine' } });
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
  const agents = fakeAgents({ respond: { text: 'VERDICT: changes-requested\nREASON: missing tests' } });
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
  const agents = fakeAgents({ respond: { text: 'I think it is probably fine.' } });
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
  assert.equal(result.error.code, 'REVIEW_FAILED');
});

test('a missing agent registry fails the review rather than skipping it silently', async () => {
  const result = await reviewWork({}, {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: 'review this',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, 'REVIEW_AGENTS_UNAVAILABLE');
});

test('an empty review prompt is refused', async () => {
  const result = await reviewWork(reviewDeps(fakeAgents()), {
    taskId: 'task-1',
    cwd: CWD,
    selection: SELECTION,
    prompt: '',
  });
  assert.equal(result.state, REVIEW_STATES.failed);
  assert.equal(result.error.code, 'REVIEW_PROMPT_EMPTY');
});

test('the allow-list and mutation detector classify tool names correctly', () => {
  const allowed = reviewerToolAllowList();
  assert.equal(allowed.has('read_file'), true);
  assert.equal(allowed.has('write_file'), false);
  for (const name of ['write_file', 'edit_file', 'apply_patch', 'delete_file', 'shell_exec', 'git_commit', 'run_command']) {
    assert.equal(looksMutating(name), true, name);
  }
  for (const name of ['read_file', 'list_directory', 'search_files', 'grep']) {
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
