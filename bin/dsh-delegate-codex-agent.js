#!/usr/bin/env node
// Explicitly install or remove the Codex companion from a terminal.
//
// This is the same implementation the DSH settings page drives
// (`src/codex/installer.js`); the binary exists for scripted installs, CI and
// operators who prefer a shell. Three rules follow from that:
//
//   * it is never run implicitly — not on plugin load, not on package install;
//   * `install` writes the agent file and registers the MCP server, `status` only
//     reads, and `remove` deletes only files this plugin still owns;
//   * a refusal is reported in full and exits non-zero, so a script cannot mistake
//     "left your file alone" for success.
//
// Exit codes: 0 done, 2 nothing changed because of a refusal/conflict, 1 failure.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCodexAction, readCodexStatus, resolveCodexHome, packageVersion } from '../src/codex/installer.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ACTIONS = new Set(['install', 'status', 'repair', 'remove']);

/** Re-exported so callers that imported it from this bin before 0.1.6 keep working. */
export { resolveCodexHome };

/**
 * Compatibility adapter for the pre-0.1.6 programmatic entry point.
 *
 * The 0.1.6 release moved the logic to `src/codex/installer.js` and made the action
 * cover the MCP entry as well. This wrapper keeps the old call shape
 * (`manageCodexAgent(action, { codexHome })`) and its agent-only state names, so an
 * existing script or test does not silently start writing a Codex config it did not
 * ask for. `install` still registers the MCP server — that is what the settings
 * page's button does — but the *agent* state remains the returned contract.
 * @param {'install'|'status'|'remove'|'repair'} action - action to perform.
 * @param {object} [options] - `codexHome`, `env`.
 * @returns {Promise<{ path: string, mcpPath: string, state: string, mcpState: string }>} agent state.
 */
export async function manageCodexAgent(action, { codexHome = resolveCodexHome(), env = process.env } = {}) {
  if (!ACTIONS.has(action)) throw new TypeError('action must be install, status, repair, or remove');
  if (action === 'status') {
    const status = await readCodexStatus({ codexHome, env, version: await packageVersion() });
    return {
      path: status.agent.path,
      mcpPath: status.mcp.path,
      state: status.agent.state,
      mcpState: status.mcp.state,
    };
  }
  const outcome = await runCodexAction(action, { codexHome, env, version: await packageVersion() });
  return {
    path: outcome.status.agent.path,
    mcpPath: outcome.status.mcp.path,
    state: outcome.status.agent.state,
    mcpState: outcome.status.mcp.state,
    changed: outcome.changed,
    refused: outcome.refused,
  };
}

/**
 * Human-readable rendering of one outcome.
 * @param {object} outcome - `{ action, changed, refused, status }`.
 * @returns {string[]} lines.
 */
function render(outcome) {
  const { status } = outcome;
  const lines = [
    `agent ${status.agent.state}: ${status.agent.path}`,
    `mcp   ${status.mcp.state}: ${status.mcp.path}`,
    `entry ${status.mcp.desired.command} ${status.mcp.desired.args.join(' ')}`,
    `ready ${status.ready === true ? 'yes' : 'no'} (the DSH switch is not changed by this command)`,
  ];
  for (const entry of outcome.changed) lines.push(`changed: ${entry}`);
  for (const entry of outcome.refused) lines.push(`refused: ${entry.target} ${entry.code}: ${entry.message}`);
  for (const note of status.notes ?? []) lines.push(`note: ${note.code}: ${note.text}`);
  return lines;
}

function printHelp() {
  process.stdout.write([
    'Usage: dsh-delegate-codex-agent <install|status|repair|remove>',
    'Uses CODEX_HOME when set; otherwise uses ~/.codex.',
    'install/repair write agents/dsh-delegate.toml and register mcp_servers.dsh-delegate in config.toml.',
    'remove deletes only files this plugin still owns; a modified file is left untouched.',
    'Never enables the DSH local-call switch and never edits unrelated Codex settings.',
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
    // `CODEX_HOME` (or the user's `~/.codex`) decides the target; the action itself
    // lives in the shared installer so the CLI and the settings page cannot drift.
    const outcome = await runCodexAction(action, { codexHome: resolveCodexHome(), version: await packageVersion() });
    process.stdout.write(`${render(outcome).join('\n')}\n`);
    if (outcome.refused.length > 0) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`dsh-delegate-codex-agent: ${error?.message ?? 'operation failed'}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) await main();
