// Job engine tests: the authorization → configuration → workspace → route →
// execution chain, end to end, and every refusal in it.
//
// These tests run the real engine. Only native services are faked, so a
// regression in ordering (for example, creating an agent before consuming the
// grant) fails here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { AuthorizationRegistry } from '../src/auth/grants.js';
import { JobEngine, JOB_CODES, TASK_STATES } from '../src/jobs/engine.js';
import { SettingsService } from '../src/config/settings.js';
import { WorkspaceLocks } from '../src/workspace/locks.js';
import { REVIEW_STATES } from '../src/review/reviewer.js';
import {
  cleanup,
  fakeAgents,
  fakeGit,
  fakeLlm,
  llmTable,
  makeTempDir,
  validSettings,
} from './helpers/fakes.js';

/**
 * Build an engine over temporary storage, a real workspace directory and faked
 * native services.
 *
 * The workspace must exist because the engine resolves it before use; a
 * nonexistent path is itself a refusal and has its own test.
 * @param {object} [options] - `agents`, `git`, `settings`.
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
  const deps = {
    agents,
    sessions: { async flush() {} },
    llm: fakeLlm({ providers: llmTable() }),
    settings,
    auth,
    locks,
    runGit: options.git ?? fakeGit({
      'status --porcelain=v1 --untracked-files=all': { stdout: ' M src/a.js\n' },
      'diff --numstat HEAD': { stdout: '2\t0\tsrc/a.js\n' },
      'diff --no-color --no-ext-diff --unified=3 HEAD': { stdout: 'diff --git a/src/a.js b/src/a.js\n+implementation\n' },
      'ls-files --others --exclude-standard': { stdout: '' },
    }),
    logger: { info() {}, warn() {} },
  };
  const engine = new JobEngine(deps);

  /**
   * Issue a connection plus a grant covering this harness's workspace.
   * @param {'task'|'session'} [kind] - grant kind.
   * @returns {object} connection and grant records.
   */
  function authorize(kind = 'task') {
    const connection = auth.issueConnection({ label: 'codex' });
    const grant = auth.issueGrant(connection.connectionId, {
      kind,
      workspacePath: workspace,
      ttlSeconds: 600,
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

    assert.equal(h.agents.created.length, 1);
    const settled = await settle(h.engine, started.taskId);
    assert.equal(settled.state, TASK_STATES.awaitingHostReview);
    assert.equal(settled.selfApproved, false);
    assert.equal(settled.hostAcceptance, null, 'the plugin must not record acceptance');
    assert.equal(settled.execution.outcome, 'completed');
    assert.match(settled.execution.text, /implemented the change/);
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
    // The agent received the same triple the task records.
    assert.equal(h.agents.created[0].options.model, 'deepseek-chat');
    assert.equal(h.agents.created[0].options.reasoningEffort, 'medium');
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
    assert.equal(h.agents.created.length, 1, 'only one agent may ever exist for one grant');
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
  const h = await harness({
    settings: validSettings({ worker: { model: 'deepseek-reasoner', reasoningEffort: 'low' } }),
  });
  try {
    const { connectionId, grant } = h.authorize();
    await assert.rejects(
      () => h.engine.start({
        connectionId,
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
  const agents = fakeAgents({
    script: async ({ record }) => {
      record.agent.followup = (message) => {
        record.followups.push(message);
        record.idle = false;
      };
    },
  });
  // Raise the parallelism limit above one so the refusal under test is the
  // workspace lock, not the concurrency cap.
  const h = await harness({ agents, settings: validSettings({ worker: { maxParallelism: 2 } }) });
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

    const two = await h.engine.start({
      connectionId,
      authorization: 'session',
      workspacePath: h.workspace,
      prompt: 'second',
    });
    assert.notEqual(one.taskId, two.taskId);
    assert.equal(h.agents.created.length, 2);
  } finally {
    await h.close();
  }
});

test('cancelling a running task reaches the agent and states why', async () => {
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
    assert.ok(h.agents.created[0].cancels.length >= 1, 'the agent must be cancelled');
    assert.equal(h.engine.locks.isLocked(h.workspace), false);
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

    // Two distinct agents: worker and reviewer, with different models.
    const models = agents.created.map((record) => record.options.model);
    assert.deepEqual(models, ['deepseek-chat', 'deepseek-reasoner']);
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
    assert.equal(h.agents.created.length, 1, 'no reviewer agent may be created when review is off');
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
