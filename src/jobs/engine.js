// Job engine: the only component that can turn a request into model work.
//
// Authorization order is fixed and every step can refuse:
//   1. the caller presents a connection identity and a grant;
//   2. the task grant is consumed atomically — one task, one consumption;
//   3. an immutable effective configuration snapshot is resolved and validated;
//   4. the workspace is resolved, audited and locked;
//   5. the route is confirmed against the native LLM seam;
//   6. only then does an agent exist.
//
// A job that completes is NOT accepted. It becomes `awaiting-host-review`, and
// the host decides. Nothing in this module can mark a job approved.

import { randomUUID } from 'node:crypto';
import { defaultSettings, LIMITS } from '../config/defaults.js';
import { redactDeep, redactText } from '../config/redact.js';
import { resolveEffectiveConfig } from '../config/settings.js';
import { AUTH_CODES, AuthError } from '../auth/grants.js';
import { resolveRoute } from '../model/routing.js';
import { RUN_OUTCOMES, RunError, diagnostic, runAgent } from '../runtime/agent-runner.js';
import { REVIEW_STATES, reviewWork } from '../review/reviewer.js';
import { buildReviewPrompt, buildWorkerPrompt } from '../review/prompts.js';
import { assertWorktreeCapable, captureBaseline, captureDiff } from '../workspace/audit.js';
import { LOCK_CODES, WorkspaceError, resolveWorkspacePath } from '../workspace/locks.js';

/** Task lifecycle states. `awaiting-host-review` is terminal for this plugin. */
export const TASK_STATES = Object.freeze({
  pending: 'pending',
  running: 'running',
  awaitingHostReview: 'awaiting-host-review',
  failed: 'failed',
  cancelled: 'cancelled',
});

/** Terminal states: a task in one of these may not be driven again. */
const TERMINAL = new Set([TASK_STATES.awaitingHostReview, TASK_STATES.failed, TASK_STATES.cancelled]);

/** Job-level refusal codes. */
export const JOB_CODES = Object.freeze({
  notAuthorized: 'JOB_NOT_AUTHORIZED',
  taskNotFound: 'JOB_TASK_NOT_FOUND',
  taskTerminal: 'JOB_TASK_TERMINAL',
  promptRequired: 'JOB_PROMPT_REQUIRED',
  workspaceRequired: 'JOB_WORKSPACE_REQUIRED',
  noProviders: 'JOB_NO_PROVIDERS',
  isolationRefused: 'JOB_ISOLATION_REFUSED',
  busy: 'JOB_WORKSPACE_BUSY',
  concurrency: 'JOB_CONCURRENCY_LIMIT',
});

/** Raised for job-level refusals. */
export class JobError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded, redacted details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Task engine. Holds at most a bounded number of live tasks in memory; nothing
 * is persisted, so a restart begins with no tasks and no authorization.
 */
export class JobEngine {
  /**
   * @param {object} deps - native services and plugin components.
   */
  constructor(deps) {
    this.deps = deps;
    this.settings = deps.settings;
    this.auth = deps.auth;
    this.locks = deps.locks;
    this.tasks = new Map();
    this.aborted = false;
  }

  /**
   * Report whether delegation may run at all right now.
   * @returns {{ authorized: boolean, reason: string | null }} current posture.
   */
  posture() {
    if (this.aborted) return { authorized: false, reason: 'the plugin has been disposed' };
    if (this.auth.isDelegationAuthorized() !== true) {
      return { authorized: false, reason: 'no live delegation authorization exists' };
    }
    return { authorized: true, reason: null };
  }

  /**
   * Start one delegated task.
   *
   * The authorization is consumed before anything else happens, so a failure
   * later in the pipeline still costs the caller its grant. That is deliberate:
   * a grant authorizes one attempt at one task, not a free retry loop.
   * @param {object} request - `connectionId`, `grantId`, `workspacePath`, `prompt`, `overrides`,
   *   and `authorization` (`'task'` consumes a single-use grant, `'session'` checks a live session grant).
   * @returns {Promise<object>} the created task view.
   */
  async start(request) {
    const posture = this.posture();
    if (!posture.authorized) {
      throw new JobError(JOB_CODES.notAuthorized, posture.reason ?? 'delegation is not authorized', {});
    }

    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (prompt === '') throw new JobError(JOB_CODES.promptRequired, 'a task prompt is required', {});
    if (prompt.length > LIMITS.promptChars) {
      throw new JobError('JOB_PROMPT_TOO_LARGE', `the task prompt exceeds ${LIMITS.promptChars} characters`, {
        limit: LIMITS.promptChars,
      });
    }

    const taskId = `task-${randomUUID()}`;
    const workspacePath = await resolveWorkspacePath(request?.workspacePath).catch((error) => {
      if (error instanceof WorkspaceError) {
        throw new JobError(JOB_CODES.workspaceRequired, error.message, error.details);
      }
      throw error;
    });

    // Authorization is settled before any side effect. A task grant is consumed
    // here and only here, so a replayed request cannot start a second task; a
    // session grant is re-checked so revoking it stops further starts at once.
    const authorization = request?.authorization === 'session' ? 'session' : 'task';
    const grant = authorization === 'session'
      ? this.auth.requireSessionGrant({
        connectionId: request?.connectionId,
        workspacePath,
      })
      : this.auth.consumeTaskGrant({
        connectionId: request?.connectionId,
        grantId: request?.grantId,
        taskId,
        workspacePath,
      });

    const settings = await this.settings.read();
    if (settings.providers.length === 0) {
      throw new JobError(JOB_CODES.noProviders, 'no provider profile is configured', {});
    }

    const overrides = grant.overrides ?? request?.overrides ?? {};
    let effective;
    try {
      effective = resolveEffectiveConfig(settings, { projectPath: workspacePath, overrides });
    } catch (error) {
      throw new JobError('JOB_ROUTING_REFUSED', error?.message ?? 'the effective configuration was refused', {
        cause: error?.code ?? null,
        details: error?.details ?? null,
      });
    }

    const running = [...this.tasks.values()].filter((task) => task.state === TASK_STATES.running);
    if (running.length >= effective.worker.maxParallelism) {
      throw new JobError(JOB_CODES.concurrency, `at most ${effective.worker.maxParallelism} task(s) may run at once`, {
        limit: effective.worker.maxParallelism,
        running: running.length,
      });
    }

    // Isolation is honoured or refused; it is never silently downgraded.
    if (effective.worker.isolation === 'worktree') {
      try {
        await assertWorktreeCapable(this.deps, workspacePath);
      } catch (error) {
        throw new JobError(JOB_CODES.isolationRefused, error?.message ?? 'worktree isolation is not available', {
          cause: error?.code ?? null,
        });
      }
      throw new JobError(
        JOB_CODES.isolationRefused,
        'worktree isolation is not implemented in this stage; select shared isolation explicitly',
        { requested: 'worktree' },
      );
    }

    let baseline;
    try {
      baseline = await captureBaseline(this.deps, workspacePath);
    } catch (error) {
      throw new JobError('JOB_AUDIT_UNAVAILABLE', error?.message ?? 'the workspace could not be audited', {
        cause: error?.code ?? null,
      });
    }

    let lease;
    try {
      lease = this.locks.acquire(workspacePath, { taskId });
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === LOCK_CODES.busy) {
        throw new JobError(JOB_CODES.busy, error.message, error.details);
      }
      throw error;
    }

    // Routing is confirmed against the native seam before an agent exists.
    let route;
    try {
      route = await resolveRoute(this.deps, {
        providerId: effective.worker.providerId,
        providerRoute: effective.worker.providerRoute,
        model: effective.worker.model,
        reasoningEffort: effective.worker.reasoningEffort,
      });
    } catch (error) {
      this.locks.release(workspacePath, lease.nonce);
      throw new JobError('JOB_ROUTING_REFUSED', error?.message ?? 'the route could not be confirmed', {
        cause: error?.code ?? null,
        details: error?.details ?? null,
      });
    }

    const task = {
      taskId,
      state: TASK_STATES.pending,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      workspacePath,
      prompt,
      connectionId: grant.connectionId ?? request?.connectionId ?? null,
      grantId: grant.grantId,
      effective,
      route,
      baseline,
      leaseNonce: lease.nonce,
      diff: null,
      execution: null,
      review: { state: REVIEW_STATES.notRun, verdict: null, text: '', error: null },
      error: null,
      cancelRequested: false,
      controller: new AbortController(),
      // Host acceptance is never granted here; it is the host's own record.
      hostAcceptance: null,
      cancelledBy: null,
    };
    this.tasks.set(taskId, task);

    // Execution is not awaited: the caller receives the task id immediately and
    // observes progress through the task view. The promise is tracked so tests
    // and dispose can await settlement.
    task.settled = this.execute(task).catch((error) => {
      // execute() already records failures; this guards against a programming
      // error escaping an already-settled task.
      if (task.state === TASK_STATES.running || task.state === TASK_STATES.pending) {
        task.state = TASK_STATES.failed;
        task.error = task.error ?? { code: 'JOB_INTERNAL', message: diagnostic(error?.message ?? error) };
        task.endedAt = Date.now();
      }
    });

    return this.view(task, { includePrompt: true });
  }

  /**
   * Execute one task end to end. Records failures on the task; never throws.
   * @param {object} task - task record.
   * @returns {Promise<void>} resolves when the task reaches a terminal state.
   */
  async execute(task) {
    task.state = TASK_STATES.running;
    task.startedAt = Date.now();
    try {
      const workerSelection = {
        providerId: task.route.providerRoute,
        providerRoute: task.route.providerRoute,
        model: task.route.model,
        reasoningEffort: task.route.reasoningEffort,
      };
      const prompt = buildWorkerPrompt({
        taskId: task.taskId,
        prompt: task.prompt,
        workspacePath: task.workspacePath,
        isolation: task.effective.worker.isolation,
        baseline: task.baseline,
      });

      const run = await runAgent(this.deps, {
        prompt,
        cwd: task.workspacePath,
        selection: workerSelection,
        timeoutMs: task.effective.worker.timeoutSeconds * 1000,
        signal: task.controller.signal,
      });

      task.execution = {
        outcome: run.outcome,
        text: run.text,
        reasoningOnly: run.reasoningOnly,
        usage: run.usage,
        turnEnd: run.turnEnd,
        agentId: run.agentId,
        sessionId: run.sessionId,
        cancelCause: run.cancelCause,
        error: run.error,
      };

      // Evidence is captured even for a failed or cancelled run: a partial
      // change still needs to be visible to the host.
      task.diff = await captureDiff(this.deps, task.workspacePath, task.baseline).catch((error) => ({
        error: {
          code: error?.code ?? 'AUDIT_FAILED',
          message: diagnostic(error?.message ?? error, 300),
        },
        files: [],
        fileCount: 0,
        patchText: '',
        patchTruncated: false,
      }));

      if (run.outcome === RUN_OUTCOMES.cancelled) {
        task.state = TASK_STATES.cancelled;
        // Preserve the provenance recorded by cancel()/dispose(); only fall back
        // to the agent's own abort when nothing requested the cancellation.
        task.cancelledBy = task.cancelledBy ?? (task.cancelRequested ? 'request' : 'agent');
        task.endedAt = Date.now();
        return;
      }
      if (run.outcome === RUN_OUTCOMES.timedOut) {
        task.state = TASK_STATES.failed;
        task.error = { code: 'JOB_TIMEOUT', message: 'the task exceeded its time budget' };
        task.endedAt = Date.now();
        return;
      }
      if (run.outcome !== RUN_OUTCOMES.completed) {
        task.state = TASK_STATES.failed;
        // An agent-reported error is an execution failure; silence is its own
        // distinct condition so an operator can tell the two apart.
        task.error = {
          code: run.error !== null && run.error !== undefined ? 'JOB_EXECUTION_FAILED' : 'JOB_NO_OUTPUT',
          message: run.error ?? 'the delegated run produced no output',
        };
        task.endedAt = Date.now();
        return;
      }

      // Review runs only for a completed execution, and only when enabled.
      task.review = await this.runReview(task);

      task.state = TASK_STATES.awaitingHostReview;
      task.endedAt = Date.now();
    } catch (error) {
      task.state = task.cancelRequested ? TASK_STATES.cancelled : TASK_STATES.failed;
      task.error = error instanceof RunError
        ? { code: error.code, message: error.message, details: redactDeep(error.details ?? null) }
        : { code: 'JOB_FAILED', message: diagnostic(error?.message ?? error) };
      task.endedAt = Date.now();
    } finally {
      try {
        this.locks.release(task.workspacePath, task.leaseNonce);
      } catch {
        // Releasing a lease we no longer hold is a no-op by design.
      }
    }
  }

  /**
   * Run the optional independent review.
   * @param {object} task - completed execution task.
   * @returns {Promise<object>} review record.
   */
  async runReview(task) {
    if (task.effective.review.enabled !== true) {
      return { state: REVIEW_STATES.disabled, verdict: null, text: '', error: null };
    }
    let route;
    try {
      route = await resolveRoute(this.deps, {
        providerId: task.effective.review.providerId,
        providerRoute: task.effective.review.providerRoute,
        model: task.effective.review.model,
        reasoningEffort: task.effective.review.reasoningEffort,
      });
    } catch (error) {
      // A review routing failure is a review failure, not a task failure.
      return {
        state: REVIEW_STATES.failed,
        verdict: null,
        text: '',
        error: {
          code: 'REVIEW_ROUTING_REFUSED',
          message: error?.message ?? 'the review route could not be confirmed',
          cause: error?.code ?? null,
        },
      };
    }
    const prompt = buildReviewPrompt({
      taskId: task.taskId,
      taskPrompt: task.prompt,
      workerSummary: task.execution?.text ?? '',
      evidence: task.diff,
    });
    const result = await reviewWork(this.deps, {
      taskId: task.taskId,
      cwd: task.workspacePath,
      selection: {
        providerId: route.providerRoute,
        providerRoute: route.providerRoute,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
      },
      prompt,
      evidence: task.diff,
      timeoutMs: Math.min(task.effective.worker.timeoutSeconds, 1800) * 1000,
    });
    return {
      state: result.state,
      verdict: result.verdict,
      text: result.text ?? '',
      error: result.error ?? null,
      denials: result.denials ?? [],
      denialsDelivered: (result.denials ?? []).length,
      selection: result.selection ?? null,
    };
  }

  /**
   * Request cancellation of one task.
   * @param {string} taskId - task to cancel.
   * @param {string} reason - recorded provenance.
   * @returns {object} the task view.
   */
  async cancel(taskId, reason = 'request') {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new JobError(JOB_CODES.taskNotFound, 'no such task', { taskId });
    if (TERMINAL.has(task.state)) return this.view(task);
    task.cancelRequested = true;
    task.cancelledBy = reason;
    try {
      task.controller.abort();
    } catch {
      // AbortController.abort() does not throw; kept for defence in depth.
    }
    // Give the run a bounded window to observe the cancellation and clean up.
    await Promise.race([
      task.settled ?? Promise.resolve(),
      new Promise((resolvePromise) => { setTimeout(resolvePromise, 5000).unref?.(); }),
    ]);
    return this.view(task);
  }

  /**
   * Read one task.
   * @param {string} taskId - task id.
   * @param {object} [options] - `includePrompt` adds the prompt text.
   * @returns {object} task view.
   */
  get(taskId, options = {}) {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new JobError(JOB_CODES.taskNotFound, 'no such task', { taskId });
    return this.view(task, options);
  }

  /**
   * List tasks, optionally filtered by connection.
   * @param {object} [options] - `connectionId`.
   * @returns {object[]} task views, newest first.
   */
  list(options = {}) {
    const out = [];
    for (const task of this.tasks.values()) {
      if (options.connectionId !== undefined && task.connectionId !== options.connectionId) continue;
      out.push(this.view(task));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Public projection of one task.
   *
   * The projection is structural, not incidental: no credential, no provider
   * endpoint, and no un-redacted text leaves this method.
   * @param {object} task - task record.
   * @param {object} [options] - `includePrompt`.
   * @returns {object} redacted view.
   */
  view(task, options = {}) {
    const view = {
      taskId: task.taskId,
      state: task.state,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      workspacePath: task.workspacePath,
      connectionId: task.connectionId,
      grantId: task.grantId,
      effective: {
        worker: { ...task.effective.worker },
        review: { ...task.effective.review },
        provenance: task.effective.provenance,
      },
      route: {
        providerId: task.route.providerRoute,
        model: task.route.model,
        reasoningEffort: task.route.reasoningEffort,
      },
      baseline: task.baseline,
      diff: task.diff,
      execution: task.execution === null ? null : {
        outcome: task.execution.outcome,
        text: task.execution.text,
        reasoningOnly: task.execution.reasoningOnly,
        usage: task.execution.usage,
        turnEnd: task.execution.turnEnd,
        agentId: task.execution.agentId,
        sessionId: task.execution.sessionId,
        cancelCause: task.execution.cancelCause,
        error: task.execution.error,
      },
      review: task.review,
      error: task.error,
      cancelledBy: task.cancelledBy,
      hostAcceptance: task.hostAcceptance,
      // Stated explicitly so no consumer can read `awaiting-host-review` as
      // "done and approved".
      selfApproved: false,
    };
    if (options.includePrompt === true) view.prompt = redactText(task.prompt);
    return redactDeep(view);
  }

  /**
   * Abort every live task and release every lease. Called on dispose.
   * @returns {Promise<number>} number of tasks asked to stop.
   */
  async dispose() {
    this.aborted = true;
    let count = 0;
    for (const task of this.tasks.values()) {
      if (TERMINAL.has(task.state)) continue;
      task.cancelRequested = true;
      task.cancelledBy = 'dispose';
      try {
        task.controller.abort();
      } catch {
        // ignore
      }
      count += 1;
    }
    await Promise.race([
      Promise.allSettled([...this.tasks.values()].map((task) => task.settled ?? Promise.resolve())),
      new Promise((resolvePromise) => { setTimeout(resolvePromise, 5000).unref?.(); }),
    ]);
    this.locks.releaseAll();
    return count;
  }
}

/**
 * Validate the shape a caller-supplied override may take before it reaches the
 * settings validator. Kept here so the engine never trusts a raw object.
 * @param {unknown} value - raw override object.
 * @returns {object} shallow copy with only known keys.
 */
export function sanitizeOverrides(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new JobError('JOB_OVERRIDE_INVALID', 'overrides must be an object', {});
  }
  const allowed = ['providerId', 'model', 'reasoningEffort', 'timeoutSeconds', 'isolation'];
  const out = {};
  for (const key of allowed) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

export { AuthError, AUTH_CODES, defaultSettings };
