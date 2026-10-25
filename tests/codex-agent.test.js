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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { manageCodexAgent, resolveCodexHome } from '../bin/dsh-delegate-codex-agent.js';

function temporaryCodexHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-delegate-codex-'));
}

/** Environment with only the given Codex home; no DSH overrides leak in. */
function isolatedEnv(codexHome) {
  return { CODEX_HOME: codexHome, DSH_HOME: '', DSH_DELEGATE_DISCOVERY_FILE: '' };
}

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
    assert.ok(readFileSync(installed.path, 'utf8').includes('name = "dsh-delegate"'));
    assert.ok(readFileSync(installed.mcpPath, 'utf8').startsWith(`model = "keep-me"`) || readFileSync(installed.mcpPath, 'utf8').includes(original));
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('an existing custom agent is not overwritten or removed', async () => {
  const codexHome = temporaryCodexHome();
  const agentPath = join(codexHome, 'agents', 'dsh-delegate.toml');
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
