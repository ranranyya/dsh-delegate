// Compatibility test for the pre-0.1.6 Codex companion installer API.
//
// `bin/dsh-delegate-codex-agent.js` used to export `manageCodexAgent(action, {
// codexHome })` and to write only `agents/dsh-delegate.toml`. The 0.1.6 release
// moved that logic into `src/codex/installer.js` and widened it to register the MCP
// server as well, so the old entry points are kept as thin adapters and pinned here.
//
// The properties are the ones the earlier suite established and that must not
// regress: CODEX_HOME is honoured, install is exclusive and idempotent, a
// different same-name file is never overwritten or removed, and `remove` deletes
// only the exact bundled template.

import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manageCodexAgent, resolveCodexHome } from '../bin/dsh-delegate-codex-agent.js';
import { useDirectoryClassifier } from '../src/codex/installer.js';

/** Repository root, so the shipped agent template can be read and compared. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function temporaryCodexHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-delegate-codex-'));
}

/** Environment with only the given Codex home; no DSH overrides leak in. */
function isolatedEnv(codexHome) {
  return { CODEX_HOME: codexHome, DSH_HOME: '', DSH_DELEGATE_DISCOVERY_FILE: '' };
}

// The installer proves `$CODEX_HOME` and `$CODEX_HOME/agents` are real directories.
// On Windows that answer comes from a `powershell.exe` child, and this suite has to run
// where a child cannot be spawned at all, so the suite answers through the documented
// classifier hook. `lstat` still does the work; only the platform verdict is supplied.
// Without it every temp home below would be reported `conflict`/`boundary-unverified`,
// which is the honest answer to "I cannot see whether this is a junction".
useDirectoryClassifier(async (paths) => {
  const kinds = new Map();
  for (const path of paths) {
    let info = null;
    try {
      info = lstatSync(path);
    } catch {
      info = null;
    }
    if (info === null) kinds.set(path, 'missing');
    else if (info.isSymbolicLink()) kinds.set(path, 'link');
    else if (info.isDirectory()) kinds.set(path, 'directory');
    else kinds.set(path, 'other');
  }
  return kinds;
});

test('CODEX_HOME is honored and the default remains the user Codex directory', () => {
  const configured = join(tmpdir(), 'dsh-codex-home');
  const homeDirectory = join(tmpdir(), 'dsh-codex-user');
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: configured } }), resolve(configured));
  assert.equal(resolveCodexHome({ env: {}, homeDirectory }), join(resolve(homeDirectory), '.codex'));
});

test('install is exclusive and idempotent, and does not disturb an existing config', async () => {
  const codexHome = temporaryCodexHome();
  try {
    const configPath = join(codexHome, 'config.toml');
    const original = 'model = "keep-me"\n';
    writeFileSync(configPath, original);

    const env = isolatedEnv(codexHome);
    assert.equal((await manageCodexAgent('status', { codexHome, env })).state, 'not-installed');
    const installed = await manageCodexAgent('install', { codexHome, env });
    assert.equal(installed.state, 'installed');
    assert.equal(installed.mcpState, 'configured');
    assert.equal((await manageCodexAgent('install', { codexHome, env })).state, 'installed');
    assert.equal((await manageCodexAgent('status', { codexHome, env })).state, 'installed');
    assert.ok(readFileSync(installed.path, 'utf8').includes('name = "dsh-taskbridge"'));
    assert.ok(readFileSync(installed.mcpPath, 'utf8').startsWith(`model = "keep-me"`) || readFileSync(installed.mcpPath, 'utf8').includes(original));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('an existing custom agent is not overwritten or removed', async () => {
  const codexHome = temporaryCodexHome();
  const agentPath = join(codexHome, 'agents', 'dsh-taskbridge.toml');
  const custom = 'name = "my-dsh-delegate"\n';
  try {
    mkdirSync(dirname(agentPath), { recursive: true });
    writeFileSync(agentPath, custom);

    const env = isolatedEnv(codexHome);
    // A different same-name file is reported with the 0.1.6 state name for it.
    assert.equal((await manageCodexAgent('install', { codexHome, env })).state, 'modified');
    assert.equal((await manageCodexAgent('status', { codexHome, env })).state, 'modified');
    assert.equal((await manageCodexAgent('remove', { codexHome, env })).state, 'modified');
    assert.equal(readFileSync(agentPath, 'utf8'), custom);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('remove deletes only the exact bundled template', async () => {
  const codexHome = temporaryCodexHome();
  try {
    const env = isolatedEnv(codexHome);
    await manageCodexAgent('install', { codexHome, env });
    const removed = await manageCodexAgent('remove', { codexHome, env });
    // The old adapter reported `removed`; 0.1.6 reports the state after the action.
    // What matters is that the file is gone and a repeat is a no-op.
    assert.ok(removed.changed.includes('agent'));
    assert.equal(removed.state, 'not-installed');
    assert.equal(readFileSync(removed.mcpPath, 'utf8').includes('mcp_servers.dsh-delegate'), false);
    assert.equal((await manageCodexAgent('status', { codexHome, env })).state, 'not-installed');
    assert.deepEqual((await manageCodexAgent('remove', { codexHome, env })).changed, []);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

// --- The shipped dispatcher rules --------------------------------------------
//
// The task-thread rule has to reach the host as an INSTRUCTION, not only as a
// schema: a model that never reads `continueFromTaskId` will keep omitting it (and
// so never continue anything), or will reuse an id "to keep context" (and so join
// the wrong thread). These assertions pin the sentence, not only the field.

test('the shipped dispatcher tells the host when to pass continueFromTaskId', () => {
  const template = readFileSync(join(ROOT, 'codex', 'dsh-taskbridge.toml'), 'utf8');
  const raw = /developer_instructions = """([\s\S]*?)"""/u.exec(template)?.[1] ?? '';
  // The instruction block is TOML prose: its line wrapping is not part of the rule,
  // so the assertions run on unwrapped text.
  const instructions = raw.replace(/\s+/gu, ' ');
  assert.ok(instructions.length > 0, 'the shipped agent must carry developer instructions');

  // The rule, in both halves: follow-ups continue, unrelated tasks do not.
  assert.match(instructions, /continueFromTaskId/u);
  assert.match(instructions, /NEW DSH task conversation/u);
  assert.match(instructions, /ONLY when this submission is a follow-up/u);
  assert.match(instructions, /latest prior task id/u);
  assert.match(instructions, /Omit `continueFromTaskId` entirely for an unrelated task/u);

  // It must also say what to do with a worktree parent, because "reuse the tree" is
  // the one case where the right path is not the source checkout.
  assert.match(instructions, /original managed tree/u);
  // And that a refusal is reported, not worked around.
  assert.match(instructions, /do not retry as a new task/u);
  // The retired setting must not be described as available.
  assert.doesNotMatch(instructions, /conversation mode is `reuse`/u);
});

test('the shipped dispatcher rules are what install actually writes', async () => {
  const codexHome = temporaryCodexHome();
  try {
    const env = isolatedEnv(codexHome);
    const installed = await manageCodexAgent('install', { codexHome, env });
    const written = readFileSync(installed.path, 'utf8');
    const version = /^version = "(.*)"$/mu.exec(written)?.[1] ?? '';
    const shipped = readFileSync(join(ROOT, 'codex', 'dsh-taskbridge.toml'), 'utf8');
    assert.match(written, /continueFromTaskId/u, 'the installed file must carry the continuation rule');
    // The only difference between the shipped template and the installed copy is
    // the version line the installer renders, so the rules a host reads are the
    // rules this repository reviews.
    assert.equal(written, shipped.replace(/^version = ".*"$/mu, `version = "${version}"`));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1.1.0 companion template: wait-based dispatch, no local implementation
// ---------------------------------------------------------------------------

test('the shipped companion drives delegate_wait and never polls delegate_result in a loop', () => {
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'codex', 'dsh-taskbridge.toml'), 'utf8');
  // The wait tool is the loop; the old "poll delegate_result until terminal" rule is gone.
  assert.match(template, /delegate_wait/u);
  assert.doesNotMatch(template, /poll `delegate_result` for that\s+same task until terminal/u);
  assert.doesNotMatch(template, /Keep polling the SAME task/u);
  // Every actionable reason is named with its policy.
  for (const reason of ['heartbeat', 'attention', 'permission', 'ready', 'failed', 'cancelled', 'interrupted', 'wait-limit']) {
    assert.match(template, new RegExp(`\`${reason}\``, 'u'), `the template must state the ${reason} policy`);
  }
  // Heartbeat is internal: it must not be described as something to act on.
  assert.match(template, /`heartbeat`: nothing to report/u);
  // Ready is explicitly not acceptance.
  assert.match(template, /is not\s+acceptance/iu);
  // Attention defaults to waiting, not to cancelling or failing.
  assert.match(template, /DEFAULT: keep waiting/u);
  assert.match(template, /Never cancel, never mark the task failed/u);
  // Result evidence is read ONCE, not repeatedly.
  assert.match(template, /`delegate_result` ONCE/u);
});

test('the shipped companion distinguishes an interrupted WAIT from an interrupted RUN, and names the control channel', () => {
  // 1.2.0: the real acceptance defect was a host told that a healthy run had ended,
  // and an operator who could not stop a task while the host blocked the connection.
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'codex', 'dsh-taskbridge.toml'), 'utf8');
  // The live case keeps waiting on the SAME task and forbids the other three reactions.
  assert.match(template, /`interrupted`: the wait itself was cut off/u);
  assert.match(template, /It does NOT mean the execution stopped/u);
  assert.match(template, /never resubmit, never implement locally,\s+never cancel for\s+this reason/iu);
  // ...and an UNKNOWN record is not a blanket "keep waiting": check one fact first.
  assert.match(template, /do NOT assume it is still running and do NOT assume it\s+stopped/u);
  assert.match(template, /FIRST check one fact with `delegate_result`/u);
  assert.match(template, /Do not\s+re-wait indefinitely on a task you cannot classify/u);
  // The terminal case is identified by the plugin's own fields, not by the word.
  assert.match(template, /`terminal: true`/u);
  assert.match(template, /`state: "interrupted"`/u);
  assert.match(template, /do not\s+keep calling `delegate_wait` on it/u);
  // The control channel: derived from this plugin's own MCP configuration, two verbs only.
  assert.match(template, /WHEN THE HOST CANNOT SEND A SECOND CALL/u);
  assert.match(template, /`dsh-taskbridge-control`/u);
  assert.match(template, /status <taskId>/u);
  assert.match(template, /cancel <taskId>/u);
  assert.match(template, /NEXT TO this plugin's MCP\s+script/u);
  assert.match(template, /never call an\s+unrelated script/u);
  assert.match(template, /Neither can submit a task, change a setting/u);
  // ...and only for an explicit operator request, with silence otherwise.
  assert.match(template, /explicit operator request to inspect or stop that task/u);
  assert.match(template, /Otherwise stay silent and keep\s+waiting/u);
});

test('the shipped companion forbids local implementation while a worker runs', () => {
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'codex', 'dsh-taskbridge.toml'), 'utf8');
  assert.match(template, /DO NOT IMPLEMENT LOCALLY WHILE A DELEGATED WORKER RUNS/u);
  assert.match(template, /single-writer/u);
  // The one exception is an explicit user-authorized takeover, and nothing weaker.
  assert.match(template, /user-authorized takeover/u);
  assert.match(template, /long silence, a permission refusal, a failed run or your own judgement/u);
  // Corrections go back through continueFromTaskId on the same source path.
  assert.match(template, /continueFromTaskId/u);
});

test('the shipped companion keeps its activation and safety rules unchanged', () => {
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'codex', 'dsh-taskbridge.toml'), 'utf8');
  for (const anchor of [
    'ACTIVATION (check this before anything else)',
    'delegate_preflight',
    'Never open the switch yourself',
    'delegate_permission_decide',
    'fingerprint',
    'REVIEW BOUNDARY',
  ]) {
    assert.ok(template.includes(anchor), `the template must still contain ${anchor}`);
  }
});
