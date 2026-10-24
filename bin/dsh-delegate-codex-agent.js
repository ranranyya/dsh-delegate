#!/usr/bin/env node
// Explicitly install or remove the optional Codex custom-agent companion.

import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TEMPLATE_PATH = new URL('../codex/dsh-delegate.toml', import.meta.url);
const AGENT_FILENAME = 'dsh-delegate.toml';
const ACTIONS = new Set(['install', 'status', 'remove']);

/** Resolve the Codex home, honoring CODEX_HOME without mutating Codex settings. */
export function resolveCodexHome({ env = process.env, homeDirectory = homedir() } = {}) {
  const configured = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  const candidate = configured === '' ? join(homeDirectory, '.codex') : configured;
  return resolve(candidate);
}

/** Read a regular managed file; symlinks and directories are treated as conflicts. */
async function readManagedFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { kind: 'conflict' };
    return { kind: 'file', contents: await readFile(path, 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
}

/**
 * Manage the optional user-level Codex agent file.
 *
 * Install is exclusive and idempotent. Remove only deletes a regular file that
 * still exactly matches the shipped template, so user edits are preserved.
 */
export async function manageCodexAgent(action, { codexHome = resolveCodexHome() } = {}) {
  if (!ACTIONS.has(action)) throw new TypeError('action must be install, status, or remove');
  if (typeof codexHome !== 'string' || codexHome.trim() === '' || !isAbsolute(codexHome)) {
    throw new TypeError('CODEX_HOME must resolve to an absolute path');
  }

  const agentPath = join(resolve(codexHome), 'agents', AGENT_FILENAME);
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  const existing = await readManagedFile(agentPath);
  const isExactTemplate = existing.kind === 'file' && existing.contents === template;

  if (action === 'status') {
    return { path: agentPath, state: existing.kind === 'missing' ? 'not-installed' : isExactTemplate ? 'installed' : 'modified' };
  }

  if (action === 'install') {
    if (isExactTemplate) return { path: agentPath, state: 'installed' };
    if (existing.kind !== 'missing') return { path: agentPath, state: 'conflict' };
    await mkdir(dirname(agentPath), { recursive: true });
    try {
      await writeFile(agentPath, template, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { path: agentPath, state: 'installed' };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const raced = await readManagedFile(agentPath);
      return {
        path: agentPath,
        state: raced.kind === 'file' && raced.contents === template ? 'installed' : 'conflict',
      };
    }
  }

  if (existing.kind === 'missing') return { path: agentPath, state: 'not-installed' };
  if (!isExactTemplate) return { path: agentPath, state: 'modified' };
  await unlink(agentPath);
  return { path: agentPath, state: 'removed' };
}

function printHelp() {
  process.stdout.write([
    'Usage: dsh-delegate-codex-agent <install|status|remove>',
    'Uses CODEX_HOME when set; otherwise uses ~/.codex.',
    'Only manages agents/dsh-delegate.toml. It does not edit config.toml or register MCP.',
  ].join('\n') + '\n');
}

async function main() {
  const action = process.argv[2];
  if (action === '--help' || action === '-h' || action === undefined) {
    printHelp();
    return;
  }
  if (!ACTIONS.has(action) || process.argv.length > 3) {
    printHelp();
    process.exitCode = 2;
    return;
  }

  try {
    const result = await manageCodexAgent(action);
    process.stdout.write(`${result.state}: ${result.path}\n`);
    if (result.state === 'conflict' || result.state === 'modified') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`dsh-delegate-codex-agent: ${error?.message ?? 'operation failed'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) await main();
