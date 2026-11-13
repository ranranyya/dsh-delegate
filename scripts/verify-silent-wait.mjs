#!/usr/bin/env node
// Silent-wait acceptance probe: a REAL wait chain over REAL wall-clock time.
//
// What this measures, and what it does NOT:
//
//   * It builds the production `TaskMonitor` and the production `waitForTask` loop and
//     waits for real seconds. Nothing about the waiting chain is faked.
//   * The ACTIVITY is SIMULATED by this program on a timer: it emits the same native
//     event shapes a real run produces (`step/start`, `text-delta`, `reasoning-delta`,
//     `tool/call`, `tool/result`) at a steady cadence, so the run looks busy to the
//     monitor. At the end it settles the task to `awaiting-host-review`.
//   * It therefore proves "a busy task does not wake the host for N minutes", NOT
//     "a real provider run of N minutes behaves this way". No LLM is called, no
//     credential is read, no installed configuration is touched.
//
// It is deliberately NOT part of `npm test`: the default duration is minutes, and a
// suite must not take twenty of them. The host runs it inside a long `functions.exec` /
// `functions.wait` call with a large `yield_time_ms` (for example 1200000) to see whether
// the OUTER client returns early. If the exec cell comes back before the script prints
// its one-line JSON, the outer layer interrupted it and the plugin's wait did not fail.
//
// Usage:
//   node scripts/verify-silent-wait.mjs [--duration-seconds 1200] [--activity-seconds 25]
//                                      [--settle-seconds 1] [--stdout-events]
//
// Exit codes: 0 = the probe finished and every assertion held; 1 = an assertion failed;
//             2 = bad usage.

import process from 'node:process';

import { TaskMonitor, OBSERVE_REASONS } from '../src/jobs/activity.js';
import { OBSERVE_WAIT_MS } from '../src/mcp/server.js';
import { waitForTask } from '../src/mcp/wait.js';

/** Parsed command-line options. */
const USAGE = `usage: node scripts/verify-silent-wait.mjs [--duration-seconds N] [--activity-seconds N]
                                     [--settle-seconds N] [--stdout-events]`;

/**
 * Parse `--flag value` pairs.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{ durationSeconds: number, activitySeconds: number, settleSeconds: number, stdoutEvents: boolean }} options.
 * @throws {Error} on an unknown flag or a non-positive number.
 */
function parseArgs(argv) {
  const options = { durationSeconds: 1_200, activitySeconds: 25, settleSeconds: 1, stdoutEvents: false };
  const numeric = new Map([
    ['--duration-seconds', 'durationSeconds'],
    ['--activity-seconds', 'activitySeconds'],
    ['--settle-seconds', 'settleSeconds'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--stdout-events') {
      options.stdoutEvents = true;
      continue;
    }
    const key = numeric.get(flag);
    if (key === undefined) throw new Error(`unknown argument ${flag} (see ${USAGE})`);
    const raw = argv[index + 1];
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} needs a positive number, got ${String(raw)}`);
    options[key] = value;
    index += 1;
  }
  if (options.activitySeconds <= 0) throw new Error('--activity-seconds must be positive');
  return options;
}

/**
 * A task record shaped exactly like the engine's own, so the real monitor runs on it.
 * @returns {object} task record.
 */
function probeTask() {
  const startedAt = Date.now();
  return {
    taskId: 'task-verify-silent-wait',
    state: 'running',
    phase: 'execute',
    createdAt: startedAt,
    startedAt,
    endedAt: null,
    native: { started: true, settled: false },
    permission: { pending: null },
  };
}

/**
 * Emit one simulated "the model is still working" event to the monitor.
 *
 * The shapes are the durable native ones (`SessionEventMap` / `StreamChunk`), including a
 * reasoning delta, so a real monitor is exercised by realistic traffic rather than by a
 * single hand-picked type. Nothing here is content that would be retried or leaked; the
 * probe never prints event bodies unless `--stdout-events` is passed.
 * @param {TaskMonitor} monitor - the real monitor.
 * @param {number} tick - event counter.
 * @param {(message: string) => void} narrate - optional per-event logger.
 * @returns {void}
 */
function emitActivity(monitor, tick, narrate) {
  const at = Date.now();
  const kinds = [
    { type: 'step/start', data: { turn: tick, step: 1 } },
    { type: 'reasoning-delta', data: { index: 0, text: 'still thinking about the change' } },
    { type: 'text-delta', data: { index: 0, text: `working ${tick}` } },
    { type: 'tool/call', data: { turn: tick, step: 1, callId: `probe-${tick}`, name: 'read', arguments: '{"path":"a"}' } },
    { type: 'tool/result', data: { turn: tick, step: 1, message: { role: 'tool', toolCallId: `probe-${tick}`, content: [] } } },
  ];
  for (const event of kinds) {
    monitor.onEvent(event, at);
    narrate?.(event.type);
  }
}

/**
 * Run the probe.
 * @param {object} options - parsed options.
 * @returns {Promise<object>} the compact metrics report.
 */
async function run(options) {
  const task = probeTask();
  const monitor = new TaskMonitor(task, {
    // Real clock, real wait: the point of this script is wall-clock behaviour.
    now: () => Date.now(),
    waitSliceMs: 1_000,
    // The PRODUCTION defaults (5 / 10 minutes), not an artificially high threshold. A
    // 20-minute run therefore crosses both the self-check and the attention interval
    // while activity continues, which is exactly the claim under test: normal progress
    // resets the silence clock and never produces an `attention` answer.
    selfCheckSeconds: 300,
    attentionSeconds: 600,
    // And the production failure-reminder default, so a clean simulated run must never
    // trip it either.
    repeatFailureThreshold: 3,
  });
  task.monitor = monitor;

  const observed = [];
  const snapshotActivities = [];
  const startedAt = Date.now();
  const narrate = options.stdoutEvents ? (type) => process.stdout.write(`  activity ${type}\n`) : null;

  // Simulated activity never stops, so every observation ends as a heartbeat. That is the
  // property under test: a busy task must not wake the host even once.
  const activityTimer = setInterval(() => {
    emitActivity(monitor, Math.floor((Date.now() - startedAt) / 1_000), narrate);
  }, Math.max(1, options.activitySeconds) * 1_000);
  emitActivity(monitor, 0, narrate);

  // The observation port: exactly what the execution plane does, returning the engine's
  // own observation shape with `ok: true` in front of it.
  const callExecution = async (route, payload) => {
    if (route !== 'observe') throw new Error(`the probe only supports observe, got ${route}`);
    const observation = await monitor.observe({ waitMs: payload.waitMs });
    observed.push({ reason: observation.reason, waitedMs: observation.waitedMs });
    // Captured while the monitor is still live: `dispose()` runs in the `finally` below.
    snapshotActivities.push(monitor.snapshot({ at: Date.now() }));
    return { ok: true, task: { taskId: task.taskId, state: task.state, phase: task.phase }, ...observation };
  };

  let answer;
  let settleTimer;
  try {
    // Settle to `awaiting-host-review` shortly before the deadline, so the probe proves a
    // real terminal answer is returned rather than a `wait-limit`. This is the simulated
    // part: a real worker would reach its own outcome instead.
    const settleInMs = Math.max(1_000, options.durationSeconds * 1_000 - Math.max(1, options.settleSeconds) * 1_000);
    settleTimer = setTimeout(() => {
      emitActivity(monitor, 999_999, narrate);
      task.state = 'awaiting-host-review';
      task.phase = 'awaiting-host-review';
      task.endedAt = Date.now();
      task.native.settled = true;
    }, settleInMs);
    settleTimer.unref?.();

    answer = await waitForTask({
      callExecution,
      taskId: task.taskId,
      waitMs: options.durationSeconds * 1_000,
      observeWaitMs: OBSERVE_WAIT_MS,
      now: () => Date.now(),
    });
  } finally {
    clearInterval(activityTimer);
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    monitor.dispose();
  }

  const elapsedMs = Date.now() - startedAt;
  const heartbeats = observed.filter((entry) => entry.reason === OBSERVE_REASONS.heartbeat).length;
  const answers = observed.filter((entry) => entry.reason !== OBSERVE_REASONS.heartbeat);
  const answerKeys = Object.keys(answer ?? {});
  const serialized = JSON.stringify(answer ?? {});
  // The probe must never leak content: its own simulated text and any thinking must be absent.
  const leaked = ['still thinking', 'working 0', '"path":"a"', 'SECRET'].filter((needle) => serialized.includes(needle));

  const checks = [
    { name: 'answer-is-ready', ok: answer?.reason === 'ready', detail: `reason=${String(answer?.reason)}` },
    { name: 'task-not-terminal-early', ok: answer?.terminal === true, detail: `terminal=${String(answer?.terminal)}` },
    { name: 'exactly-one-business-answer', ok: answers.length === 1, detail: `answers=${answers.length}` },
    { name: 'heartbeats-consumed', ok: heartbeats >= 1 && answer?.metrics?.heartbeatsConsumed === heartbeats,
      detail: `observed=${heartbeats} reported=${String(answer?.metrics?.heartbeatsConsumed)}` },
    { name: 'waited-most-of-the-budget', ok: elapsedMs >= options.durationSeconds * 1_000 - 2_000,
      detail: `elapsedMs=${elapsedMs}` },
    { name: 'no-evidence-in-answer', ok: leaked.length === 0, detail: leaked.join(',') || 'none' },
    { name: 'no-intermediate-result-fields', ok: !answerKeys.includes('diff') && !answerKeys.includes('execution'),
      detail: answerKeys.join(',') },
    { name: 'metrics-reported', ok: Number.isInteger(answer?.metrics?.observationRequests),
      detail: `observationRequests=${String(answer?.metrics?.observationRequests)}` },
    // The 5/10-minute rules must NOT fire on a run that keeps producing progress, even
    // when the run is long enough to cross both thresholds several times.
    { name: 'no-silence-alert', ok: answers.every((entry) => entry.reason !== OBSERVE_REASONS.attention),
      detail: answers.map((entry) => entry.reason).join(',') || 'none' },
    { name: 'no-failure-reminder', ok: snapshotActivities.every((activity) => {
      const reported = activity?.repeatFailure?.reported;
      return !Array.isArray(reported) || reported.length === 0;
    }), detail: 'repeatFailure.reported must stay empty for a clean run' },
    // The probe must really have crossed the self-check interval, or the "no false alert"
    // claim above would be vacuous. A clean, busy run is expected to have produced a
    // self-check VERDICT only once the window elapsed; before that the field is null.
    { name: 'crossed-self-check-window',
      ok: options.durationSeconds <= 300 || elapsedMs > 300_000,
      detail: `elapsedMs=${elapsedMs}` },
    { name: 'silence-clock-stayed-reset',
      // The monitor's own idle span must never have approached the attention threshold,
      // which is the direct evidence that simulated progress kept resetting it.
      ok: snapshotActivities.every((activity) => (activity?.idleForMs ?? 0) < 600_000),
      detail: `maxIdleMs=${Math.max(0, ...snapshotActivities.map((activity) => activity?.idleForMs ?? 0))}` },
  ];

  return {
    ok: checks.every((check) => check.ok),
    kind: 'simulated-activity-real-wait-chain',
    // Stated explicitly so a reader cannot mistake this for a real provider run.
    disclaimer: 'activity is simulated by this program on a timer; the wait chain, monitor and wall clock are real; no LLM was called',
    durationSeconds: options.durationSeconds,
    activitySeconds: options.activitySeconds,
    elapsedMs,
    observationRequests: answer?.metrics?.observationRequests ?? observed.length,
    heartbeatsConsumed: heartbeats,
    answers: answers.length,
    internalWaitMs: answer?.metrics?.perRequestWaitMs ?? null,
    reason: answer?.reason ?? null,
    terminal: answer?.terminal ?? null,
    actionable: answer?.actionable ?? null,
    checks,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`verify-silent-wait: waiting ${options.durationSeconds}s with simulated activity every `
    + `${options.activitySeconds}s (real clock, no LLM)\n`);
  const report = await run(options);
  // One compact JSON line on stdout, so a host can capture it from a long call.
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.ok ? 0 : 1);
}

await main();
