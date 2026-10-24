import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { manageCodexAgent, resolveCodexHome } from '../bin/dsh-delegate-codex-agent.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'bin', 'dsh-delegate-codex-agent.js');

function temporaryCodexHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-delegate-codex-'));
}

test('CODEX_HOME is honored and the default remains the user Codex directory', () => {
  const configured = join(tmpdir(), 'dsh-codex-home');
  const homeDirectory = join(tmpdir(), 'dsh-codex-user');
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: configured } }), resolve(configured));
  assert.equal(resolveCodexHome({ env: {}, homeDirectory }), join(resolve(homeDirectory), '.codex'));
});

test('install is exclusive and idempotent, and status sees only the managed agent file', async () => {
  const codexHome = temporaryCodexHome();
  try {
    const configPath = join(codexHome, 'config.toml');
    writeFileSync(configPath, 'model = "keep-me"\n');

    assert.equal((await manageCodexAgent('status', { codexHome })).state, 'not-installed');
    const installed = await manageCodexAgent('install', { codexHome });
    assert.equal(installed.state, 'installed');
    assert.equal((await manageCodexAgent('install', { codexHome })).state, 'installed');
    assert.equal((await manageCodexAgent('status', { codexHome })).state, 'installed');
    assert.equal(readFileSync(configPath, 'utf8'), 'model = "keep-me"\n');
    assert.ok(readFileSync(installed.path, 'utf8').includes('name = "dsh-delegate"'));
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

    assert.equal((await manageCodexAgent('install', { codexHome })).state, 'conflict');
    assert.equal((await manageCodexAgent('status', { codexHome })).state, 'modified');
    assert.equal((await manageCodexAgent('remove', { codexHome })).state, 'modified');
    assert.equal(readFileSync(agentPath, 'utf8'), custom);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('remove deletes only the exact bundled template', async () => {
  const codexHome = temporaryCodexHome();
  try {
    await manageCodexAgent('install', { codexHome });
    assert.equal((await manageCodexAgent('remove', { codexHome })).state, 'removed');
    assert.equal((await manageCodexAgent('status', { codexHome })).state, 'not-installed');
    assert.equal((await manageCodexAgent('remove', { codexHome })).state, 'not-installed');
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('the CLI uses an isolated CODEX_HOME and refuses to remove a modified template', () => {
  const codexHome = temporaryCodexHome();
  const env = { ...process.env, CODEX_HOME: codexHome };
  try {
    const install = spawnSync(process.execPath, [SCRIPT, 'install'], { env, encoding: 'utf8' });
    assert.equal(install.status, 0, install.stderr);
    assert.match(install.stdout, /^installed:/u);

    const agentPath = join(codexHome, 'agents', 'dsh-delegate.toml');
    writeFileSync(agentPath, `${readFileSync(agentPath, 'utf8')}# local edit\n`);
    const remove = spawnSync(process.execPath, [SCRIPT, 'remove'], { env, encoding: 'utf8' });
    assert.equal(remove.status, 2);
    assert.equal(readFileSync(agentPath, 'utf8').endsWith('# local edit\n'), true);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});
