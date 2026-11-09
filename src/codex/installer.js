// Codex integration: install the companion custom agent and register this
// package's stdio MCP server in Codex.
//
// Scope, stated once and enforced below
// -------------------------------------
// This module owns exactly two things in a Codex home:
//
//   1. `$CODEX_HOME/agents/dsh-delegate.toml` — a *managed copy* of the shipped
//      template `codex/dsh-delegate.toml`. Ownership is proved by content, never by
//      the file name or a version line alone:
//        * a file that is byte-identical to the template this build would write is
//          `installed` (and removable);
//        * a file that matches one of the *known prior shipped templates* in
//          {@link KNOWN_AGENT_TEMPLATES} byte for byte is `outdated` (refreshable and
//          removable) — a conservative, enumerated list, not a heuristic;
//        * anything else is `modified`/`conflict`: never overwritten, never removed.
//      A first install is *exclusive* (`wx`), so a file that appears between the
//      status read and the write is reported as a conflict instead of replaced.
//   2. the `mcp_servers.dsh-delegate` table in `$CODEX_HOME/config.toml`, and only
//      when it carries the plugin's marker comment AND the single stdio command
//      this plugin writes (`command = "<node>"`,
//      `args = ["<installed>/bin/dsh-delegate-mcp.js"]`). An unmarked same-name
//      entry is the operator's — even when its values happen to be identical — and
//      is reported as a conflict and left byte-identical. Any other difference
//      (another command, an added `env` key, a `url`, extra arguments) is a
//      conflict too, except for the narrow migration of the old Desktop GUI
//      command documented by `isLegacyDesktopCommand` below.
//
// Every other byte of `config.toml` is preserved verbatim, including comments,
// table order and CRLF line endings (see `src/codex/toml.js`). Nothing here writes on
// package install: install/repair/remove are operator actions reached through the
// settings page, and `status` only reads. The one write that can happen without a
// click is {@link refreshKnownAgentTemplate}, which plugin startup calls to migrate a
// file whose complete bytes still match a published template; it never creates a
// missing agent and never touches `config.toml`.
//
// The write sets do not overlap by accident: `install` writes both targets, `repair`
// writes the MCP entry and nothing else (never creating, refreshing or deleting the
// agent file), and `remove` deletes only what it can still prove is its own.
//
// Where those paths may physically lead
// -------------------------------------
// The Codex home itself, and the `agents` directory below it, are boundaries and not
// just path strings: `lstat` on the final file would happily report "missing" while
// `mkdir`/`open` walked through a directory junction to a directory somewhere else.
// Both are therefore inspected without following the link (`lstat`, and a native
// reparse-point check for the Windows junction `lstat` reports as an ordinary
// directory), and a link at either one is a stable `conflict` diagnosis that
// install, repair and remove all refuse. A node_modules-style real directory — the
// normal case — is unaffected.
//
// Removal re-proves ownership at the last moment: the file is read again immediately
// before it is unlinked and has to be a regular file whose bytes are still exactly
// the managed content the status read reported, so a file rewritten in between is
// kept and reported instead of deleted.
//
// What it deliberately does NOT do
// --------------------------------
// It does not enable the DSH local-call switch, does not edit unrelated Codex
// settings, and claims no `@`-selection capability for any Codex surface: the agent
// file's instructions describe the exact dispatch conditions, and the status notes
// say what the file can and cannot guarantee.

import { lstatSync } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readlink, realpath, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeFileAtomic } from '../config/store.js';
import {
  TomlDocument,
  TomlSyntaxError,
  renderKey,
  renderString,
  renderStringArray,
  samePath,
  tomlValueType,
} from './toml.js';

/** Agent file name inside `$CODEX_HOME/agents`. */
export const AGENT_FILENAME = 'dsh-delegate.toml';

/** MCP server entry name inside Codex's `mcp_servers` table. */
export const MCP_SERVER_NAME = 'dsh-delegate';

/** Marker line written above the MCP entry so an operator can find it later. */
export const MCP_MARKER = '# dsh-delegate: managed by the DSH Delegate plugin settings page';

/** Actions the status/action route accepts. */
export const CODEX_ACTIONS = Object.freeze(['status', 'install', 'repair', 'remove']);

/**
 * The exact agent files shipped by earlier releases, as SHA-256 digests of the file
 * *as written* (template with the version marker stamped).
 *
 * This list, not a heuristic, is what makes `outdated` mean "a build this plugin
 * really published". A file that is not byte-identical to one of these is somebody
 * else's file, even if it still carries the managed header and an old version line.
 * Regenerating a digest is a deliberate act: add the entry for a release only after
 * that release has been packed and its agent file verified.
 *
 * The 0.1.6, both 0.1.7 builds, the 0.1.8 and 0.1.9 builds, the published 0.1.10
 * template (in both its packed CRLF and its LF byte form), the published 0.1.11
 * template and the published 0.1.12 template are enumerated here because they are
 * published Codex agent builds. A file that is not byte-identical to one of these
 * releases or the current template is reported as `modified`, rather than guessed as
 * ours.
 * The array is intentionally mutable (not frozen) so a test can pin a temporary
 * entry and prove the "known build is refreshable" path without shipping a fake
 * historical release in the product data.
 * @type {Array<{ version: string, sha256: string }>}
 */
export const KNOWN_AGENT_TEMPLATES = [
  {
    version: '0.1.6',
    sha256: '6a9d0da5b32d62a2a1f61d1fba37d54789cde0774afb3abccb5dc12b400c82be',
  },
  {
    version: '0.1.7',
    sha256: '3b5a58df0f989e87ae160a2952b7699cd5e2978e43a0f9a86c4eceb155d7af92',
  },
  {
    version: '0.1.7',
    sha256: '75ec5f97452754ba22747680598583b8ab457f64a0a3d487b96d73b3a3cc35c7',
  },
  {
    version: '0.1.8',
    sha256: '56f1cb8ac6460c590e27e3bf44144174dadb09dfd3f904aa9b5ee2a805ae1c4e',
  },
  {
    version: '0.1.9',
    sha256: '3aa3a2e3a621584ebe002d6a7469ce56c85a899f12d63c26d782f02a47d4d4ca',
  },
  // Rebuilds of the 0.1.10 template at the older version markers. A shipped
  // template changes bytes whenever its instructions change (the per-task
  // conversation policy is one such change), so the rebuilds of the current
  // template are enumerable here as well: without them, a file this plugin
  // published is reported `modified` — "somebody else's file" — and is never
  // refreshed.
  {
    version: '0.1.7',
    sha256: 'e3689492ee0f24d2defd2a9254b653e7bc54c258dd38fb0c2fc70ce5b386f2b3',
  },
  {
    version: '0.1.8',
    sha256: '5cd02783d0fd5b1ffe5375e5d0e1b009931163e6f4fa87de9ea3c9c399fcd40e',
  },
  {
    version: '0.1.9',
    sha256: 'b5db667d114baf881f59c9367a80137379960b1fccb524c883ab0edcf9f0d516',
  },
  // The published 0.1.10 template. Its body differs from this build's only in the
  // version line, but that line is part of the bytes an operator's file is proved
  // against, so the digest is distinct and has to be enumerated on its own: without
  // it, a 0.1.10 install is reported `modified` and is never refreshed by startup
  // migration.
  //
  // Both digests below are enumerated for 0.1.10, because the release exists in two
  // byte forms and either one can be sitting on an operator's disk:
  //
  // * `fc7b2710…` — the packed `dsh-delegate-0.1.10.tgz`, whose
  //   `package/codex/dsh-delegate.toml` carries CRLF line endings (the form a Windows
  //   install writes).
  // * `6583f08a…` — the same template with LF line endings. It is an exact byte
  //   identity like the other, not a normalized comparison: the product hashes the
  //   file it finds and never rewrites its line endings, so an LF checkout of that
  //   release stays a recognized build.
  //
  // Neither digest is derived from the other: normalization is a defect, not a
  // convenience, because it would also make an edited file hash to a known value.
  {
    version: '0.1.10',
    sha256: 'fc7b27104dbb50f4e614cd4fd8df8db87fd8f59fcf2b3c27b412b49f8b89fbba',
  },
  {
    version: '0.1.10',
    sha256: '6583f08a3ec4912a875249e6b127357b41cc3f8bf388b8e5cadbbeff469349be',
  },
  // The published 0.1.11 template: the bytes of the immediately previous release,
  // which is what an existing installation holds when this build starts. Its body is
  // the same as the 0.1.10 body (0.1.11 changed `package.json`, the permissions
  // contract and the runtime facts, not the companion instructions), so the only
  // difference from the 0.1.10 entry is the stamped version line — and a version
  // line is part of the bytes an operator's file is proved against, so this digest
  // is distinct and has to be enumerated on its own. Without it a 0.1.11
  // installation is reported `modified` ("somebody else's file") and neither startup
  // migration nor an explicit install would ever refresh it.
  {
    version: '0.1.11',
    sha256: 'b6ca7c3258fc00c1c1682abf099994b9f5abe650acc3ecf9635eec4a35520151',
  },
  // The published 0.1.12 template: the file the immediately previous release packed,
  // which is what an existing installation holds when this build starts. It was
  // verified byte for byte against the packed `dsh-delegate-0.1.12.tgz`
  // (`package/codex/dsh-delegate.toml`) and against the saved release baseline, so
  // the digest is an exact identity rather than a reconstruction. Without this entry
  // a 0.1.12 installation is reported `modified` — "somebody else's file" — and
  // neither startup migration nor an explicit install would ever refresh it.
  {
    version: '0.1.12',
    sha256: 'ff04a4bf2c09b97747f835770c837637869581bb13bad3b8a870a3e92218514f',
  },
  // The published 0.1.13 template: the file the immediately previous release packed,
  // which is what an existing installation holds when this build starts. Verified byte
  // for byte against the packed `dsh-delegate-0.1.13.tgz`
  // (`package/codex/dsh-delegate.toml`): 9191 bytes, CRLF, this exact digest. It is an
  // exact content identity like every other entry here, never a heuristic match on the
  // version line — an operator-edited file whose version line still says 0.1.13 hashes
  // differently and stays `modified` (preserved, never refreshed). Without this entry a
  // 0.1.13 installation is reported `modified` — "somebody else's file" — and neither
  // startup migration nor an explicit install would ever refresh it.
  {
    version: '0.1.13',
    sha256: 'b3a1d2f0520774c0067ea733f27fd47c67c5f5ac44394d0eec2564c7959700aa',
  },
  // The published 0.1.14 template. Version 1.0.0 keeps the same companion body
  // while changing the release marker, so an unchanged 0.1.14 installation must
  // remain a byte-proven managed file and migrate automatically.
  {
    version: '0.1.14',
    sha256: '11379c0152f3fb2bd4da1170812e51fe68006d98f6378c720cbadcee9ee4750c',
  },
  // The published 1.0.0 companion — the body an existing 1.0.0 installation holds
  // when 1.1.0 starts. 1.1.0 replaced the repeat-result polling rules with
  // `delegate_wait` and added the explicit "do not implement locally" boundary, so
  // the instruction bytes changed and this is a DISTINCT published build that has to
  // be enumerated: without it, every 1.0.0 installation would be reported `modified`
  // ("somebody else's file") and the settings-page update button would refuse to
  // refresh a file this plugin really published.
  //
  // The digest is the exact 1.0.0 stamped bytes as packed (CRLF, 11519 bytes),
  // computed by hashing that shipped file rather than by normalizing anything: a
  // version line is part of the bytes an operator's file is proved against.
  {
    version: '1.0.0',
    sha256: 'a8c888afaa0a1a6a0abfcb56670ffbdb67697f07e54871ece78c8adffb15c149',
  },
  // The same 1.0.0 body with LF line endings. It is an exact identity, not a
  // normalized comparison: an operator who installed from an LF checkout holds these
  // bytes, and the installer never rewrites line endings. Normalizing would also make
  // an edited file hash to a known value, which is the defect these digests exist to
  // prevent.
  {
    version: '1.0.0',
    sha256: 'f51831e2ff265c9ba63a4760e245787060de7bd91dcc9663a11729fb472e5f62',
  },
];

/** The `version = "…"` line of an agent file, at column 0. */
const VERSION_LINE = /^version[ \t]*=[ \t]*"([^"]*)"\r?$/mu;

/** Stable states reported for the agent file. */
export const AGENT_STATES = Object.freeze({
  missing: 'not-installed',
  installed: 'installed',
  outdated: 'outdated',
  modified: 'modified',
  conflict: 'conflict',
});

/** Stable states reported for the MCP entry. */
export const MCP_STATES = Object.freeze({
  missing: 'not-configured',
  configured: 'configured',
  outdated: 'outdated',
  conflict: 'conflict',
  unreadable: 'unreadable',
});

/** How this package is executed (mirrors `bin` in package.json). */
export const MCP_ENTRY_RELATIVE = join('bin', 'dsh-delegate-mcp.js');

/**
 * States in which an MCP definition may be written: absent, already ours, or a stale
 * copy of ours. Anything else — including an unmarked same-name entry — is refused.
 */
const MANAGEABLE_MCP_STATES = new Set([MCP_STATES.missing, MCP_STATES.configured, MCP_STATES.outdated]);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE_PATH = join(PACKAGE_ROOT, 'codex', AGENT_FILENAME);
const PACKAGE_MANIFEST_PATH = join(PACKAGE_ROOT, 'package.json');

/** Bound on a Codex config document this module is willing to edit. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Refusal raised by the installer. Carries a stable code so the settings page can
 * explain *why* rather than only *that* something failed.
 */
export class CodexInstallError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - explanation, already free of secrets.
   * @param {object} [details] - bounded details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CodexInstallError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolve the Codex home.
 *
 * `CODEX_HOME` wins when set (Codex's own precedence), otherwise `~/.codex`. A
 * relative override is refused rather than resolved against the DSH working
 * directory, which would write a Codex file into the harness's cwd.
 * @param {object} [options] - `env`, `homeDirectory`.
 * @returns {string} absolute Codex home directory.
 * @throws {CodexInstallError} `CODEX_HOME_INVALID` for a relative override.
 */
export function resolveCodexHome({ env = process.env, homeDirectory = homedir() } = {}) {
  const configured = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (configured === '') return resolve(join(homeDirectory, '.codex'));
  if (!isAbsolute(configured)) {
    throw new CodexInstallError('CODEX_HOME_INVALID', 'CODEX_HOME must be an absolute path');
  }
  return resolve(configured);
}

/**
 * Normalize an explicit Codex home, refusing a relative one.
 *
 * An explicit path may come from a caller rather than the environment (the seam
 * resolves `CODEX_HOME` for the settings page), and resolving a relative path
 * against the harness's working directory would report on, or write to, a
 * directory the operator never named.
 * @param {string} codexHome - caller-supplied absolute path.
 * @returns {string} absolute path.
 * @throws {CodexInstallError} `CODEX_HOME_INVALID`.
 */
export function requireCodexHome(codexHome) {
  if (typeof codexHome !== 'string' || codexHome.trim() === '' || !isAbsolute(codexHome)) {
    throw new CodexInstallError('CODEX_HOME_INVALID', 'the Codex home must be an absolute path');
  }
  return resolve(codexHome);
}

/**
 * Read the shipped agent template.
 * @returns {Promise<string>} template text exactly as published.
 */
export async function readAgentTemplate() {
  return await readFile(TEMPLATE_PATH, 'utf8');
}

/**
 * Read this package's version from its own manifest.
 * @returns {Promise<string>} version string, or `''` when the manifest is unreadable.
 */
async function readPackageVersion() {
  try {
    const manifest = JSON.parse(await readFile(PACKAGE_MANIFEST_PATH, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '';
  } catch {
    return '';
  }
}

/**
 * Read this package's version, requiring that it is reachable.
 * @returns {Promise<string>} version string.
 */
export async function packageVersion() {
  return await readPackageVersion();
}

/** Environment overrides that may name the Node.js used for the MCP server. */
export const MCP_NODE_ENV_VARS = Object.freeze(['DSH_NODE_PATH', 'DSH_NODE_EXECUTABLE', 'CODEX_MCP_NODE_PATH']);

/**
 * The Node.js runtime bundled inside a DSH Desktop installation, per platform.
 *
 * DSH Desktop ships its own Node below `<resources>/runtime/primary-runtime/
 * dependencies/node`; the executable is that directory's `bin/node` (`bin/node.exe`
 * on Windows). This is the one runtime a Codex-spawned MCP server may rely on, so
 * it is named in exactly one place.
 * @param {string} resourcesRoot - the Electron `resources` directory.
 * @returns {string} absolute path of the bundled `node`/`node.exe` (existence unchecked).
 */
export function packagedNodePath(resourcesRoot) {
  return join(
    resolve(resourcesRoot),
    'runtime',
    'primary-runtime',
    'dependencies',
    'node',
    'bin',
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
}

/**
 * Is this the Node.js binary itself, rather than the application that embeds it?
 *
 * A packaged Electron application sets `process.execPath` to *its own* executable
 * (`DeepSeek Harness.exe` on Windows, `DeepSeek Harness` on macOS), not to a Node
 * binary. Writing that path into Codex's `config.toml` produces an MCP server that
 * starts the GUI instead of the server, which is the defect this check exists to
 * prevent: the basename test is the last line of defence for hosts that expose no
 * usable Electron signal.
 * @param {string} value - executable path.
 * @returns {boolean} true for `node`, `node.exe` and versioned Node binaries.
 */
export function isNodeExecutableName(value) {
  // `path.basename` follows the host platform. Config files can contain Windows
  // paths even when the installer is tested or inspected on another platform, so
  // strip both separator spellings before checking the executable name.
  const name = String(value ?? '').replace(/^.*[\\/]/u, '').toLowerCase();
  return name === 'node' || name === 'node.exe' || /^node(?:-[0-9][^/\\]*)?\.exe$/u.test(name);
}

/**
 * How this plugin is hosted: a plain Node.js process, or an application that embeds
 * Electron and therefore has a different executable than its Node runtime.
 *
 * `process.versions.electron` is the authoritative Electron signal. The other two
 * are equivalent, weaker host signals that a desktop wrapper may expose instead:
 * `process.resourcesPath` is installed by Electron's main process, and `electron`
 * in `process.versions` is never present in a plain Node.js process.
 * @param {object} [host] - `versions` and `resourcesPath` of the running host.
 * @returns {'electron' | 'node'} host kind.
 */
export function hostRuntimeKind({ versions = process.versions, resourcesPath = process.resourcesPath } = {}) {
  const electron = typeof versions?.electron === 'string' ? versions.electron.trim() : '';
  if (electron !== '') return 'electron';
  // A plain Node.js process never sets `resourcesPath`; a packaged Electron app
  // always does. Treating it as a host signal is what makes the resolution work in a
  // desktop build whose `process.versions` was trimmed.
  if (typeof resourcesPath === 'string' && resourcesPath.trim() !== '') return 'electron';
  return 'node';
}

/**
 * The executable used to run the MCP server — never the GUI, never a bare `node`.
 *
 * The value is pinned (an absolute path) because Codex is often launched from a GUI
 * whose `PATH` is much narrower than the shell that started DSH, where a bare `node`
 * fails at spawn time. What is pinned depends on the host:
 *
 *   * **A plain Node.js process** keeps `process.execPath`: that *is* the Node that
 *     loaded this package, and it is the exact runtime this plugin runs on.
 *   * **An Electron/desktop host** (`process.versions.electron`, or an equivalent
 *     signal such as `process.resourcesPath`) must *not* use `process.execPath`:
 *     there it is the application (`DeepSeek Harness.exe`), and Codex would start a
 *     second GUI instead of an MCP server. The DSH packaged runtime
 *     `<resources>/runtime/primary-runtime/dependencies/node/bin/node[.exe]` is
 *     selected instead — from `process.resourcesPath` when the host exposes it, and
 *     otherwise derived from the application executable's directory.
 *
 * A `DSH_NODE_PATH`, `DSH_NODE_EXECUTABLE` or `CODEX_MCP_NODE_PATH` override is
 * accepted only as an **absolute** path to an existing **regular file**; a relative
 * value, a directory, a link or a missing file is ignored (the packaged runtime keeps
 * precedence, and the ordered list below chooses). When nothing qualifies the
 * function fails closed with `MCP_EXECUTABLE_UNRESOLVED`: an entry that names
 * something unlaunchable must never be written, and no diagnosis may substitute a
 * path that merely looks plausible.
 * @param {object} [options] - `env`, `execPath`, `resourcesPath`, `versions`, `platform`.
 * @returns {string} absolute path of a Node.js executable that exists.
 * @throws {CodexInstallError} `MCP_EXECUTABLE_UNRESOLVED` when none can be proved.
 */
export function resolveNodeExecutable({
  env = process.env,
  execPath = process.execPath,
  resourcesPath = process.resourcesPath,
  versions = process.versions,
  platform = process.platform,
} = {}) {
  const isWindows = platform === 'win32';
  const executablePath = typeof execPath === 'string' && execPath.trim() !== '' && isAbsolute(execPath)
    ? resolve(execPath)
    : '';

  /**
   * Inspect a candidate without following a link.
   *
   * `lstat` is used deliberately: a link is reported as a link (and therefore
   * rejected) rather than as the file it points at, so the written command names a
   * file this process can prove still is one.
   * @param {string} value - candidate path.
   * @returns {{ path: string } | { reason: string }} usable file, or why not.
   */
  const inspect = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return { reason: 'unset' };
    if (!isAbsolute(value)) return { reason: 'not-absolute' };
    const candidate = resolve(value);
    if (isNodeExecutableName(candidate) === false) return { reason: 'not-a-node-binary' };
    try {
      const info = lstatSync(candidate);
      if (info.isSymbolicLink()) return { reason: 'link' };
      if (!info.isFile()) return { reason: 'not-a-regular-file' };
    } catch {
      return { reason: 'missing' };
    }
    return { path: candidate };
  };

  const kind = hostRuntimeKind({ versions, resourcesPath });

  // A plain Node.js host: the runtime that loaded this package is the answer.
  if (kind === 'node' && executablePath !== '' && isNodeExecutableName(executablePath)) {
    const direct = inspect(executablePath);
    if ('path' in direct) return direct.path;
  }

  // Everything below is the desktop/Electron path (or a plain-Node process whose
  // `execPath` is not a Node binary — an embedded host that forgot to say so).
  const resourceRoots = [];
  const addRoot = (value) => {
    if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value)) return;
    const root = resolve(value);
    if (!resourceRoots.includes(root)) resourceRoots.push(root);
  };
  addRoot(resourcesPath);
  // The derived root handles a desktop host that exposes only its own executable:
  // `<install>/resources` sits beside `<install>/DeepSeek Harness.exe`.
  if (executablePath !== '') addRoot(join(dirname(executablePath), 'resources'));

  /** Every rejected candidate, kept for a diagnosis that names real reasons. */
  const rejected = [];
  for (const root of resourceRoots) {
    const candidate = packagedNodePath(root);
    const verdict = inspect(candidate);
    if ('path' in verdict) return verdict.path;
    rejected.push({ source: 'packaged-runtime', path: candidate, reason: verdict.reason });
  }

  // Explicit operator/host overrides, in a fixed precedence so two set variables
  // cannot make the answer depend on object key order.
  for (const key of MCP_NODE_ENV_VARS) {
    const candidate = env?.[key];
    const verdict = inspect(candidate);
    if ('path' in verdict) return verdict.path;
    if (verdict.reason === 'unset') continue;
    rejected.push({
      source: key,
      // The rejected value is echoed only as the configured (possibly secret-free)
      // path string; it is a filesystem path, never a credential.
      path: typeof candidate === 'string' && isAbsolute(candidate) ? resolve(candidate) : null,
      reason: verdict.reason,
    });
  }

  // Fail closed. The message states what is wrong and what would fix it; the details
  // carry only path/reason pairs, so the settings page can explain the refusal
  // without re-deriving it.
  const tried = rejected.map((entry) => {
    const value = entry.path === null ? '' : ` (${entry.path})`;
    return `${entry.source}${value}: ${entry.reason}`;
  });
  throw new CodexInstallError(
    'MCP_EXECUTABLE_UNRESOLVED',
    `no Node.js executable could be proved for the Codex MCP command; the desktop application executable is never used. `
      + `Set ${MCP_NODE_ENV_VARS[0]} to the absolute path of a node executable. `
      + (tried.length === 0 ? 'No candidate was available to check.' : `Rejected: ${tried.join('; ')}.`),
    {
      host: kind,
      execPath: executablePath === '' ? null : executablePath,
      resourceRoots,
      rejected,
      envVars: [...MCP_NODE_ENV_VARS],
    },
  );
}

/**
 * Classify one file we may need to write.
 *
 * A symlink is a conflict rather than a target: following one would write outside
 * the Codex home this module was asked to manage.
 * @param {string} path - file path.
 * @returns {Promise<{ kind: 'missing' | 'file' | 'other', contents?: string }>} state.
 */
async function inspectFile(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (info.isSymbolicLink()) return { kind: 'other' };
  if (!info.isFile()) return { kind: 'other' };
  if (info.size > MAX_CONFIG_BYTES) return { kind: 'other' };
  return { kind: 'file', contents: await readFile(path, 'utf8') };
}

/**
 * Inspect a directory without following it.
 *
 * `lstat` catches a POSIX symlink, but not a Windows junction: that reparse point is
 * reported as an ordinary directory, and `mkdir`/`open` below it would silently write
 * outside the Codex home. On Windows the file attributes are therefore asked for as
 * well (see {@link windowsDirectoryKinds}).
 * @param {string} path - directory path.
 * @returns {Promise<{ kind: 'missing' | 'directory' | 'link' | 'other' | 'unknown', target?: string }>} state.
 *   `target` is the link target when the platform reports one, for the diagnosis only;
 *   `unknown` means the platform could not say whether the directory is a link.
 */
export async function inspectDirectory(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    if (error?.code === 'ENOTDIR') return { kind: 'other' };
    throw error;
  }
  if (info.isSymbolicLink()) return { kind: 'link', target: await readLinkTarget(path) };
  if (!info.isDirectory()) return { kind: 'other' };
  const kinds = await windowsDirectoryKinds([path]);
  const kind = kinds.get(path);
  // A junction is reported by Node as a plain directory; only the attribute proves it.
  // `unknown` (the platform could not answer) is reported as itself: callers must
  // refuse, and must not describe it as a link they never saw.
  if (kind === 'missing') return { kind: 'missing' };
  if (kind === 'unknown') return { kind: 'unknown' };
  if (kind !== 'directory') return { kind: 'link', target: await readLinkTarget(path) };
  return { kind: 'directory' };
}

/**
 * Ask Windows what a set of paths are, as seen through their own directory entries.
 *
 * `lstat` cannot answer for a junction, so the file attributes are read in one
 * `powershell.exe` child (`-NoProfile`, `-NonInteractive`, hidden, 15 s bound) and
 * reported back as one line of comma-separated verdicts, one per input path:
 *
 *   * `dir/true`  — a directory whose attributes include `ReparsePoint`: a junction,
 *     a directory symlink or a directory mount point;
 *   * `dir/false` — a real directory, the normal case;
 *   * `missing`   — nothing exists at that path;
 *   * `other/…`   — something that is not a directory.
 *
 * The boolean is PowerShell's `Boolean.ToString()` output, whose spelling is not
 * guaranteed (`True` on Windows PowerShell 5.1, `true` elsewhere); it is therefore
 * decoded case-insensitively by {@link parseDirectoryVerdict}. Treating `dir/False`
 * as "not the recognised real-directory answer" would report every ordinary Windows
 * directory as a link, which is the bug this decoding exists to prevent.
 *
 * Paths travel in an environment variable, never interpolated into the script text, so
 * a quote or a space in a Codex home cannot break the command. Off Windows the answer
 * is always `directory` (POSIX links are already caught by `lstat`), and a platform
 * where the helper cannot run answers `unknown`, which callers must treat as "not
 * safely inspectable" rather than as "fine".
 * @param {string[]} paths - absolute paths to inspect.
 * @returns {Promise<Map<string, 'directory' | 'link' | 'missing' | 'other' | 'unknown'>>} verdict per path.
 */
async function windowsDirectoryKinds(paths) {
  const kinds = new Map();
  for (const path of paths) kinds.set(path, 'directory');
  if (process.platform !== 'win32' || paths.length === 0) return kinds;
  // The declared answer wins when the carrier states it: a host that already knows how
  // to read a file attribute must not be forced to spawn a shell for it.
  if (platformInference !== null) return await platformInference(paths);
  const answers = await runPowershell(KINDS_SCRIPT, { DSH_DELEGATE_CODEX_PATHS: paths.join('\n') });
  if (answers === null) {
    for (const path of paths) kinds.set(path, 'unknown');
    return kinds;
  }
  const verdicts = answers.trimEnd().split(',');
  paths.forEach((path, index) => {
    // Never `unknown` for a verdict that was actually produced: the caller treats
    // `unknown` as "not safely inspectable" and refuses, so an unrecognised answer is
    // reported as the conservative `other` it is (a path that is not a real
    // directory this module may write under), not as a missing platform answer.
    const verdict = parseDirectoryVerdict(verdicts[index]);
    if (verdict !== null) kinds.set(path, verdict);
    else kinds.set(path, 'other');
  });
  return kinds;
}

/**
 * Decode one `dir/<bool>` / `other/<bool>` / `missing` verdict from the helper script.
 *
 * The boolean is whatever PowerShell's `Boolean.ToString()` produced, and that
 * spelling is **not** stable: Windows PowerShell 5.1 prints `True`/`False` while a
 * .NET/PowerShell 7 spelling, or an output redirected through a different culture,
 * can be `true`/`false` or even `TRUE`. Comparing against a lowercase literal (the
 * original implementation) therefore misread an ordinary real directory as
 * `dir/False` → "not `dir/false`" → `other` → a reported **link**. The comparison is
 * case-insensitive for that reason. Only `dir/true` and `other/true` are a link, and
 * only `dir/false` is a directory; every other answer is `other` (never a directory
 * this module would write under), and `null` is reserved for input that is not a
 * verdict at all.
 * @param {string | undefined} raw - one comma-separated verdict, as printed.
 * @returns {'directory' | 'link' | 'missing' | 'other' | null} verdict, or null when unrecognised.
 */
export function parseDirectoryVerdict(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (text === 'missing') return 'missing';
  if (text === 'dir/true' || text === 'other/true') return 'link';
  if (text === 'dir/false') return 'directory';
  // `other/false` is a regular non-directory; `other/…` is a link-shaped entry this
  // module will not write under. Both are `other`, and so are the script's own
  // `error` (a path whose attributes could not be read) and an empty verdict (the
  // script fell silent): definite "not a directory I may write under" answers, not a
  // failed platform answer — `unknown` is reserved for "the helper could not run".
  if (text === 'error' || text === '' || text.startsWith('other/')) return 'other';
  return null;
}

/**
 * An answer for {@link windowsDirectoryKinds} supplied by the embedding carrier.
 *
 * This is a *capability* declaration, not a knob an operator turns: it exists so a
 * host that can read a file's attributes natively (or a test that must run without a
 * child process) can state the platform answer, and it is `null` everywhere else — the
 * bundled script is then the only source. Nothing this module does may set it.
 * @type {((paths: string[]) => Promise<Map<string, string>>) | null}
 */
let platformInference = null;

/**
 * Use a caller-supplied directory classifier instead of the bundled script.
 *
 * Only a host integration may call this; the returned function restores the previous
 * value, so a test can install one for its own duration.
 * @param {((paths: string[]) => Promise<Map<string, string>>) | null} classify - classifier, or null to reset.
 * @returns {() => void} undo.
 */
export function useDirectoryClassifier(classify) {
  const previous = platformInference;
  platformInference = typeof classify === 'function' ? classify : null;
  return () => { platformInference = previous; };
}

/** One verdict per path in `$env:DSH_DELEGATE_CODEX_PATHS`, comma-separated. */
const KINDS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'if ($env:DSH_DELEGATE_CODEX_PATHS -eq $null) { throw "no paths" }',
  "$targets = $env:DSH_DELEGATE_CODEX_PATHS -split \"`n\"",
  '$verdicts = foreach ($target in $targets) {',
  '  if ($target -eq "") { "error" }',
  '  elseif (-not (Test-Path -LiteralPath $target)) { "missing" }',
  '  else {',
  '    try {',
  '      $attributes = [System.IO.File]::GetAttributes($target)',
  '      $isDirectory = (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0)',
  '      $isLink = (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)',
  '      if (-not $isDirectory) { "other/" + $isLink.ToString().ToLowerInvariant() } else { "dir/" + $isLink.ToString().ToLowerInvariant() }',
  '    } catch { "error" }',
  '  }',
  '}',
  '$verdicts -join ","',
].join("\n");

/**
 * Run one PowerShell script and return its trimmed standard output.
 *
 * `stdio` is kept quiet (`windowsHide`); the exit status decides success, and any
 * failure — a missing executable, a non-zero exit, a timeout — resolves to `null`
 * rather than throwing, because a check that cannot run must not take an unrelated
 * action down with it. A platform that forbids spawning a child at all (`EPERM`,
 * thrown synchronously by `execFile`) is one such failure.
 * @param {string} script - script text.
 * @param {Record<string, string>} env - extra environment entries for the child only.
 * @returns {Promise<string | null>} output, or null when the script did not succeed.
 */
async function runPowershell(script, env) {
  return await new Promise((resolveAnswer) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: 15000, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          resolveAnswer(error === null ? String(stdout) : null);
        },
      );
    } catch {
      // No child process may be started here (a restricted carrier, a sandbox): the
      // caller reports an unverifiable boundary instead of assuming it is clean.
      resolveAnswer(null);
    }
  });
}

/**
 * Read a link's target for the diagnosis, never to follow it.
 * @param {string} path - link path.
 * @returns {Promise<string | undefined>} target text when the platform reports one.
 */
async function readLinkTarget(path) {
  try {
    return await readlink(path);
  } catch {
    return undefined;
  }
}

/**
 * Compare the installed agent file with the template this build would write.
 *
 * The order matters. Content equality is checked first, so a byte-identical file is
 * `installed` no matter what its version line says. Only then is the exact
 * known-template list consulted, and only a byte-exact match to a published build is
 * `outdated`. Everything else is `modified`: a body edit, a stray byte, a tampered
 * or invented version line, or a file that merely looks like ours.
 * @param {string} path - agent file path.
 * @param {string} template - template text this build would write.
 * @returns {Promise<{ state: string, present: boolean, reason: string | null, contents: string | null }>} agent state and the exact bytes it was derived from.
 */
async function readAgentState(path, template) {
  const existing = await inspectFile(path);
  if (existing.kind === 'missing') return { state: AGENT_STATES.missing, present: false, reason: null, contents: null };
  if (existing.kind === 'other') return { state: AGENT_STATES.conflict, present: true, reason: 'not-a-regular-file', contents: null };
  const contents = existing.contents;
  if (contents === template) return { state: AGENT_STATES.installed, present: true, reason: null, contents };
  if (isKnownPriorTemplate(contents)) return { state: AGENT_STATES.outdated, present: true, reason: null, contents };
  return {
    state: AGENT_STATES.modified,
    present: true,
    reason: isKnownPriorTemplate(contents, { ignoreVersion: true }) ? 'edited' : 'unknown-content',
    contents,
  };
}

/**
 * Inspect the two directories that bound what this module may write.
 *
 * `$CODEX_HOME` and `$CODEX_HOME/agents` are the only places the managed files may
 * live. A link at either (a POSIX symlink, or a Windows junction/reparse point that
 * `lstat` reports as a plain directory) means the final path string no longer names
 * a location inside the Codex home, so it is refused before anything is created or
 * removed — `mkdir(recursive)` would otherwise walk through the link.
 *
 * A directory whose identity cannot be established (`unknown`) is refused too: the
 * alternative is to assume it is safe, and an assumption is what this check exists to
 * remove. Both paths are inspected in one batch, so a normal Windows home costs one
 * child process, not two.
 * @param {string} home - resolved Codex home.
 * @returns {Promise<{
 *   blocked: boolean,
 *   link: 'codex-home' | 'agents' | null,
 *   unknown: boolean,
 *   home: { kind: string, target?: string },
 *   agents: { kind: string, target?: string },
 * }>} boundary state.
 */
export async function inspectCodexBoundary(home) {
  const agentsPath = join(home, 'agents');
  const homeInfo = await inspectDirectory(home);
  if (homeInfo.kind === 'link') {
    // The agents path is resolved through the link; do not inspect it further, and
    // do not report whether anything below it exists.
    return { blocked: true, link: 'codex-home', unknown: false, home: homeInfo, agents: { kind: 'unchecked' } };
  }
  const agentsInfo = homeInfo.kind === 'directory'
    ? await inspectDirectory(agentsPath)
    : { kind: 'unchecked' };
  if (agentsInfo.kind === 'link') {
    return { blocked: true, link: 'agents', unknown: false, home: homeInfo, agents: agentsInfo };
  }
  // A home that exists but could not be classified, or an `agents` entry that could
  // not be, is reported and refused for the same reason.
  if (homeInfo.kind === 'unknown' || agentsInfo.kind === 'unknown') {
    return { blocked: true, link: null, unknown: true, home: homeInfo, agents: agentsInfo };
  }
  return { blocked: false, link: null, unknown: false, home: homeInfo, agents: agentsInfo };
}

/**
 * Does a link stand between the Codex home and the managed files?
 *
 * The status document carries the answer (`boundary.blocked`) because it is read with
 * exactly the same inspect call; this turns that fact into a refusal in the shape
 * every action reports. Re-reading the status is what makes the check current: it is
 * re-done at the start of every writing action.
 * @param {object} status - a status document from {@link readCodexStatus}.
 * @returns {{ target: string, code: string, message: string, path: string, reason: string }} refusal.
 */
function linkedBoundaryRefusal(status) {
  if (status.boundary?.unknown === true) {
    return {
      target: 'agent',
      code: 'AGENT_PATH_CONFLICT',
      message: 'the Codex home or agents directory could not be verified as a real directory and was not written',
      path: join(status.codexHome, 'agents'),
      reason: 'boundary-unverified',
    };
  }
  const isHome = status.boundary?.link === 'codex-home';
  return {
    target: 'agent',
    code: 'AGENT_PATH_CONFLICT',
    message: isHome
      ? 'the Codex home is a link or reparse point, so nothing below it is written or removed'
      : 'the agents directory is a link or reparse point, so nothing inside it is written or removed',
    path: isHome ? status.codexHome : join(status.codexHome, 'agents'),
    reason: isHome ? 'codex-home-is-link' : 'agents-dir-is-link',
  };
}

/**
 * Is this file one of the exact agent files an earlier release shipped?
 *
 * The only case where install may replace an existing file. The test is content
 * identity against the enumerated digest list, which cannot be satisfied by an
 * operator edit: a single changed byte changes the digest. The version line is
 * deliberately *not* used as proof — an operator can edit a body while leaving (or
 * lowering) that line, and a heuristic on it is exactly how a customised agent
 * gets overwritten.
 * @param {string} contents - installed file text.
 * @param {object} [options] - `ignoreVersion`: compare with the version line masked,
 *   used only to explain *why* a file is `modified` in the status note.
 * @returns {boolean} true when the file is a known published build of this template.
 */
export function isKnownPriorTemplate(contents, { ignoreVersion = false } = {}) {
  if (typeof contents !== 'string') return false;
  const digestValue = digest(contents);
  if (KNOWN_AGENT_TEMPLATES.some((entry) => entry.sha256 === digestValue)) return true;
  if (!ignoreVersion) return false;
  // Explanation-only path: the same body with the version line stripped still has to
  // match a known build, which distinguishes "operator edited a managed file" from
  // "this file was never ours".
  const stripped = contents.replace(VERSION_LINE, 'version = "\u0000"');
  return KNOWN_AGENT_TEMPLATES.some((entry) => entry.sha256 === digest(stripped));
}

/**
 * Write a file that must not exist yet, atomically and exclusively.
 *
 * `writeFileAtomic` renames a temp file over the target, which silently replaces a
 * file that appeared between the status read and the write (a TOCTOU window). This
 * helper writes the temp file and then *links* it into place: `link` fails with
 * `EEXIST` when the target exists, so a concurrently created file is never
 * overwritten. On the (rare) filesystem without hard links it falls back to an
 * exclusive open, which has the same "fail if it exists" contract.
 * @param {string} path - destination path (must not exist).
 * @param {string} contents - file contents.
 * @returns {Promise<'created' | 'exists'>} outcome; `exists` means nothing was written.
 */
export async function createFileExclusive(path, contents) {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await link(temp, path);
    return 'created';
  } catch (error) {
    if (error?.code === 'EEXIST') return 'exists';
    if (error?.code !== 'EPERM' && error?.code !== 'ENOSYS' && error?.code !== 'EXDEV' && error?.code !== 'EACCES') throw error;
    // No hard links on this volume: an exclusive create is the remaining option.
    const exclusive = await open(path, 'wx', 0o600);
    try {
      await exclusive.writeFile(contents, 'utf8');
    } finally {
      await exclusive.close();
    }
    return 'created';
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/**
 * Locate the installed MCP entry point of *this* package.
 *
 * `import.meta.url` is the running file, so a package installed into a DSH profile
 * resolves to that profile's own copy — not to a repository checkout, and not to a
 * path that happened to exist when the tarball was built.
 * @returns {Promise<{ script: string, exists: boolean, fromRealPath: string }>} resolved path and whether it exists.
 */
export async function resolveMcpScript() {
  const script = resolve(PACKAGE_ROOT, MCP_ENTRY_RELATIVE);
  let exists = false;
  try {
    const info = await stat(script);
    exists = info.isFile();
  } catch {
    exists = false;
  }
  let realPath = script;
  try {
    realPath = await realpath(script);
  } catch {
    realPath = script;
  }
  return { script, exists, fromRealPath: realPath };
}

/**
 * Environment a Codex-spawned MCP server needs in order to find the same DSH.
 *
 * The discovery file is how the MCP process learns which loopback port DSH is
 * listening on. When DSH runs with a non-default `DSH_HOME`, Codex's spawned child
 * inherits Codex's environment instead, so the resolved path is pinned into the
 * entry. When the path is the default one it is left implicit: writing an absolute
 * default would silently override a later `DSH_HOME` change.
 * @param {object} options - `discoveryFile` (absolute) and `env`.
 * @returns {{ path: string, pin: boolean }} discovery location and whether to write it.
 */
export function discoveryPin(discoveryFile, env = process.env) {
  const configured = typeof env.DSH_DELEGATE_DISCOVERY_FILE === 'string' ? env.DSH_DELEGATE_DISCOVERY_FILE.trim() : '';
  if (configured !== '') return { path: resolve(configured), pin: true };
  return { path: resolve(discoveryFile), pin: false };
}

/**
 * How long Codex must let ONE `delegate_wait` call run, in seconds.
 *
 * The default wait is 3600 s (60 minutes) and the tool caps it there, so a managed
 * entry that left Codex's default tool timeout in place would cut a legitimate wait
 * off at its default (60 s) and make the companion look broken on a healthy long
 * task. 3660 s is that 3600 s plus a minute of slack for one internal observation
 * slice, JSON overhead and clock skew — never a second wait window.
 *
 * This is written on THIS server's entry only. It is not a Codex-wide setting and it
 * is never written anywhere else in the operator's config.
 */
export const DELEGATE_TOOL_TIMEOUT_SEC = 3660;

/**
 * The exact stdio command and timeout this plugin owns in Codex.
 * @param {object} options - `node`, `script`, `discoveryFile`, `pinDiscovery`.
 * @returns {{ command: string, args: string[], env: Record<string, string>, toolTimeoutSec: number }} command description.
 */
export function desiredMcpCommand({ node, script, discoveryFile = null, pinDiscovery = false }) {
  return {
    command: node,
    args: [script],
    env: pinDiscovery && discoveryFile !== null ? { DSH_DELEGATE_DISCOVERY_FILE: discoveryFile } : {},
    toolTimeoutSec: DELEGATE_TOOL_TIMEOUT_SEC,
  };
}

/**
 * Where the managed `mcp_servers.dsh-delegate` definitions sit in a document.
 *
 * A definition is owned only when the plugin's marker comment proves it was written
 * by this plugin. The marker must be the comment line directly above the definition
 * (or above a child table of it), so a marker cannot "bless" a table somewhere else.
 * @param {TomlDocument} document - parsed config.
 * @returns {{ inline: object | undefined, headerIndex: number, marker: string | null }} locations.
 */
export function locateMcpDefinition(document) {
  const serverPath = ['mcp_servers', MCP_SERVER_NAME];
  const inline = document.assignmentAt(serverPath);
  const headerIndex = document.entries.findIndex((entry) => entry.kind !== 'assignment' && samePath(entry.path, serverPath));
  /** The header/assignment line the marker has to sit directly above. */
  const anchored = inline !== undefined ? inline : (headerIndex === -1 ? null : document.entries[headerIndex]);
  if (anchored === null) return { inline, headerIndex, marker: null };
  // A definition may be written as `dsh-delegate = { … }` under `[mcp_servers]`, in
  // which case the marker can sit above either the assignment or its parent header —
  // both are the plugin's own line, and the operator cannot have written the
  // assignment without writing (or choosing to keep) the header above it.
  const candidates = [anchored.startLine - 1];
  const parent = document.entries.findIndex(
    (entry) => entry.kind !== 'assignment' && entry.path.length === serverPath.length - 1
      && entry.startLine < anchored.startLine
      && entry.path.every((segment, index) => serverPath[index] === segment),
  );
  if (parent !== -1) candidates.push(document.entries[parent].startLine - 1);
  for (const line of candidates) {
    if (document.isMarkerLine(line, MCP_MARKER)) return { inline, headerIndex, marker: MCP_MARKER };
  }
  return { inline, headerIndex, marker: null };
}

/**
 * Classify the existing `mcp_servers.dsh-delegate` definition.
 *
 * Two independent conditions must hold before the entry is treated as managed:
 * it carries the plugin's marker comment (proof of authorship), and its values are
 * the exact stdio command this plugin writes. An unmarked entry is the operator's
 * even when the values coincide, because "identical values" is not "this plugin
 * wrote it": removing it later would delete a line the operator owns.
 * @param {TomlDocument} document - parsed config.
 * @param {object} desired - value from {@link desiredMcpCommand}.
 * @returns {{ state: string, previous: object | null, reason: string | null, ownedValues: object, marked: boolean }} classification.
 */
export function classifyMcpEntry(document, desired) {
  const serverPath = ['mcp_servers', MCP_SERVER_NAME];
  const { inline, headerIndex, marker } = locateMcpDefinition(document);
  const childAssignments = document.assignmentsUnder(serverPath);

  if (inline === undefined && headerIndex === -1 && childAssignments.length === 0) {
    return { state: MCP_STATES.missing, previous: null, reason: null, ownedValues: {}, marked: false };
  }
  if (document.tablesUnder(serverPath).some((entry) => entry.kind === 'array-table')) {
    return { state: MCP_STATES.conflict, previous: null, reason: 'array-table', ownedValues: {}, marked: marker !== null };
  }

  /** Gather the definition regardless of the two legal spellings. */
  const values = {};
  if (inline !== undefined) {
    if (tomlValueType(inline.raw) !== 'table') {
      return { state: MCP_STATES.conflict, previous: null, reason: 'not-a-table', ownedValues: {}, marked: marker !== null };
    }
    Object.assign(values, parseInlineTable(inline.raw));
  }
  for (const entry of childAssignments) {
    if (samePath(entry.path, serverPath)) continue;
    values[entry.path.slice(serverPath.length).join('.')] = { type: tomlValueType(entry.raw), text: entry.raw };
  }
  const shape = describeEntryShape(values);
  if (shape !== 'stdio') {
    // A URL entry, a mixed entry or an entry with fields this plugin never writes
    // is somebody else's definition of the same name.
    return { state: MCP_STATES.conflict, previous: null, reason: shape, ownedValues: {}, marked: marker !== null };
  }
  const command = readStringValue(values.command?.text);
  const args = readArrayValue(values.args?.text);
  const envKeys = Object.keys(values).filter((key) => key.startsWith('env.')).map((key) => key.slice(4));
  /** @type {'missing' | 'different' | null} */
  let timeoutMismatch = null;
  const previous = { command, args, envKeys, toolTimeoutSec: null };
  if (marker === null) {
    // Values that happen to match are still not proof the plugin wrote them; the
    // marker is the only authorship proof this format carries.
    return { state: MCP_STATES.conflict, previous, reason: 'unmanaged-entry', ownedValues: {}, marked: false };
  }
  // A different *command* is a different program: even if the arguments look like
  // ours, running (or replacing) someone else's wrapper is not this plugin's call.
  // The one narrow migration exception is the 0.1.6 Desktop defect, which wrote
  // the host GUI (`DeepSeek Harness.exe`) instead of Node. It is accepted only when
  // the marker, current package entry point and owned env shape all prove that this
  // is the old entry this plugin wrote. Any stale args or extra env remains a
  // conflict, so a similarly named user wrapper is never adopted.
  const legacyDesktopCommand = isLegacyDesktopCommand(command);
  if (command !== desired.command && !legacyDesktopCommand) {
    return { state: MCP_STATES.conflict, previous, reason: 'command-not-ours', ownedValues: {}, marked: true };
  }
  const mismatched = !sameStrings(args, desired.args);
  const expectedEnvKeys = Object.keys(desired.env);
  const envMismatch = expectedEnvKeys.some((key) => {
    const value = readStringValue(values[`env.${key}`]?.text);
    return value !== desired.env[key];
  });
  const extraEnv = envKeys.filter((key) => !expectedEnvKeys.includes(key));
  const missingEnv = expectedEnvKeys.filter((key) => !envKeys.includes(key));
  if (extraEnv.length > 0) {
    return { state: MCP_STATES.conflict, previous, reason: 'extra-env', ownedValues: { extraEnv }, marked: true };
  }
  // The tool timeout is an OWNED fact. A managed entry written by an earlier release
  // has no `tool_timeout_sec` at all, and one an operator (or a future build) changed
  // has a different integer: both are this plugin's entry with a stale value, so they
  // migrate in place instead of being reported as somebody else's definition. A
  // non-integer was already refused by `describeEntryShape`.
  const recordedTimeout = readIntegerValue(values.tool_timeout_sec?.text);
  previous.toolTimeoutSec = recordedTimeout;
  if (recordedTimeout === null) timeoutMismatch = 'missing';
  else if (recordedTimeout !== desired.toolTimeoutSec) timeoutMismatch = 'different';
  if (legacyDesktopCommand && (mismatched || envMismatch || missingEnv.length > 0)) {
    return {
      state: MCP_STATES.conflict,
      previous,
      reason: 'legacy-command-shape',
      ownedValues: {},
      marked: true,
    };
  }
  if (mismatched || envMismatch || missingEnv.length > 0 || timeoutMismatch !== null) {
    return { state: MCP_STATES.outdated, previous, reason: null, ownedValues: {}, marked: true };
  }
  return {
    state: legacyDesktopCommand ? MCP_STATES.outdated : MCP_STATES.configured,
    previous,
    reason: null,
    ownedValues: {},
    marked: true,
  };
}

/**
 * Recognize only the DSH Desktop executable name used by the 0.1.6 defect.
 *
 * The comparison is intentionally basename-only and case-insensitive so a Windows
 * path remains recognizable when the config is inspected on a different host. A
 * bare command or any other wrapper is not a migration candidate.
 * @param {string | null} command - parsed MCP command.
 * @returns {boolean} whether the command is the old DSH Desktop GUI executable.
 */
function isLegacyDesktopCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return false;
  const value = command.trim();
  if (!/[/\\]/u.test(value)) return false;
  const name = value.replace(/^.*[/\\]/u, '').toLowerCase();
  return name === 'deepseek harness.exe';
}

/**
 * Summarize which shape an entry has.
 * @param {Record<string, { type: string }>} values - assignment values keyed by relative path.
 * @returns {'stdio' | 'url' | 'missing-command' | 'unknown-field'} shape name.
 */
function describeEntryShape(values) {
  const keys = Object.keys(values);
  if (keys.some((key) => key === 'url' || key === 'http_url' || key === 'bearer_token_env_var')) return 'url';
  if (values.command === undefined) return 'missing-command';
  if (values.command.type !== 'string') return 'command-not-a-string';
  if (values.args !== undefined && values.args.type !== 'array') return 'args-not-an-array';
  // `tool_timeout_sec` is an owned scalar: this plugin writes it so one
  // `delegate_wait` call can span the default 60-minute wait. A non-integer value is
  // not something this plugin writes, so the entry is somebody else's.
  if (values.tool_timeout_sec !== undefined && values.tool_timeout_sec.type !== 'integer') return 'timeout-not-an-integer';
  // `env` may be a table header (`env.KEY = …`) or an inline table; both unpack to
  // `env.*` keys, so both are accepted. Anything else is a field this plugin does
  // not own and must not silently drop.
  const allowed = new Set(['command', 'args', 'tool_timeout_sec']);
  for (const key of keys) {
    if (allowed.has(key)) continue;
    if (key.startsWith('env.')) continue;
    return 'unknown-field';
  }
  return 'stdio';
}

/**
 * Split an inline table `{ … }` into raw value texts.
 *
 * Only used for classification. The editor never round-trips an inline table: it
 * rewrites the whole owned definition as a `[mcp_servers.dsh-delegate]` block.
 * @param {string} raw - inline table text.
 * @returns {Record<string, { type: string, text: string }>} values keyed by key path.
 */
function parseInlineTable(raw) {
  const text = raw.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return {};
  const body = text.slice(1, -1);
  const values = {};
  let cursor = 0;
  while (cursor < body.length) {
    while (cursor < body.length && /[\s,]/u.test(body[cursor])) cursor += 1;
    if (cursor >= body.length) break;
    let keyText = '';
    if (body[cursor] === '"' || body[cursor] === "'") {
      const quote = body[cursor];
      const end = body.indexOf(quote, cursor + 1);
      if (end === -1) break;
      keyText = body.slice(cursor + 1, end);
      cursor = end + 1;
    } else {
      const start = cursor;
      while (cursor < body.length && /[A-Za-z0-9_.-]/u.test(body[cursor])) cursor += 1;
      keyText = body.slice(start, cursor);
    }
    while (cursor < body.length && (body[cursor] === ' ' || body[cursor] === '\t')) cursor += 1;
    if (body[cursor] !== '=') break;
    cursor += 1;
    while (cursor < body.length && (body[cursor] === ' ' || body[cursor] === '\t')) cursor += 1;
    const valueStart = cursor;
    let depth = 0;
    let quote = null;
    for (; cursor < body.length; cursor += 1) {
      const char = body[cursor];
      if (quote !== null) {
        if (quote === '"' && char === '\\') {
          cursor += 1;
          continue;
        }
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        // An inline table may hold a nested table, but never a multi-line string.
        if (body.startsWith(char.repeat(3), cursor)) return values;
        quote = char;
        continue;
      }
      if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') depth -= 1;
      else if (char === ',' && depth === 0) break;
    }
    const rawValue = body.slice(valueStart, cursor).trim();
    values[keyText] = { type: tomlValueType(rawValue), text: rawValue };
  }
  return values;
}

/**
 * Decode a TOML integer.
 *
 * Only the plain decimal form this plugin writes is accepted: a hex/octal literal, a
 * float, a quoted value or an expression is `null`, which the classifier treats as
 * "not a value this plugin wrote" rather than as a number it can compare.
 * @param {string | undefined} raw - raw value text.
 * @returns {number | null} the integer, or null.
 */
function readIntegerValue(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^[+-]?\d+$/u.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/**
 * Decode a TOML basic or literal string.
 * @param {string | undefined} raw - raw value text.
 * @returns {string | null} decoded string, or null when it is not a string.
 */
function readStringValue(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length < 2) return null;
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) return null;
  if (text.startsWith(quote.repeat(3))) return null;
  const inner = text.slice(1, -1);
  if (quote === "'") return inner;
  let out = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = inner[index + 1];
    index += 1;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === undefined) out += '\\';
    else out += next;
  }
  return out;
}

/**
 * Decode a single-line TOML array of strings.
 * @param {string | undefined} raw - raw value text.
 * @returns {string[]} decoded strings; non-string elements are returned as `''`.
 */
function readArrayValue(raw) {
  if (typeof raw !== 'string') return [];
  const inner = raw.trim().replace(/^\[/u, '').replace(/\]$/u, '');
  const out = [];
  let cursor = 0;
  while (cursor < inner.length) {
    while (cursor < inner.length && /[\s,]/u.test(inner[cursor])) cursor += 1;
    if (cursor >= inner.length) break;
    if (inner[cursor] === '"' || inner[cursor] === "'") {
      const quote = inner[cursor];
      let end = cursor + 1;
      let escaped = false;
      while (end < inner.length) {
        const char = inner[end];
        if (escaped) {
          escaped = false;
          end += 1;
          continue;
        }
        if (quote === '"' && char === '\\') {
          escaped = true;
          end += 1;
          continue;
        }
        if (char === quote) break;
        end += 1;
      }
      out.push(readStringValue(inner.slice(cursor, end + 1)) ?? '');
      cursor = end + 1;
      continue;
    }
    const start = cursor;
    while (cursor < inner.length && inner[cursor] !== ',') cursor += 1;
    out.push(inner.slice(start, cursor).trim());
  }
  return out;
}

/**
 * Compare two string arrays element by element.
 * @param {string[]} left - first array.
 * @param {string[]} right - second array.
 * @returns {boolean} true when equal.
 */
function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Render the managed `[mcp_servers.dsh-delegate]` block.
 * @param {object} desired - value from {@link desiredMcpCommand}.
 * @returns {string[]} lines.
 */
function renderMcpBlock(desired) {
  const lines = [
    MCP_MARKER,
    `[${renderKey(['mcp_servers', MCP_SERVER_NAME])}]`,
    `command = ${renderString(desired.command)}`,
    `args = ${renderStringArray(desired.args)}`,
    // One `delegate_wait` call may legitimately hold for the 60-minute default, so
    // Codex must allow this entry to run that long. Written on THIS server only.
    `tool_timeout_sec = ${String(desired.toolTimeoutSec)}`,
  ];
  const envKeys = Object.keys(desired.env).sort();
  for (const key of envKeys) {
    lines.push(`env.${renderKey([key])} = ${renderString(desired.env[key])}`);
  }
  return lines;
}

/**
 * Apply the managed MCP entry to a config document, preserving everything else.
 *
 * Two edits are possible and both are minimal:
 *   * the entry is absent — a marked block is appended at the end;
 *   * the entry exists and is *ours* but stale — the `command`/`args`/managed `env`
 *     values are replaced in place, so a user's surrounding layout survives.
 * @param {TomlDocument} document - parsed config.
 * @param {object} desired - desired command.
 * @param {{ state: string }} classification - current state.
 * @returns {string | null} the next document text, or null when the document already
 *   matches what this build would write (so the caller writes nothing).
 */
export function applyMcpEntry(document, desired, classification) {
  const serverPath = ['mcp_servers', MCP_SERVER_NAME];
  const before = document.text;
  if (classification.state === MCP_STATES.missing) {
    document.appendBlock(renderMcpBlock(desired));
    return document.text === before ? null : document.text;
  }
  if (classification.state !== MCP_STATES.configured && classification.state !== MCP_STATES.outdated) {
    // Only a definition proved to be ours is ever rewritten; the caller reports the
    // conflict instead of asking for an edit.
    throw new CodexInstallError(
      'MCP_ENTRY_CONFLICT',
      'the mcp_servers.dsh-delegate entry is not one this plugin manages and was left untouched',
      { reason: classification.reason ?? classification.state },
    );
  }
  // Existing and ours (possibly stale): rewrite the owned values in place, and add
  // anything this build now needs that is absent. A configured entry needs nothing.
  if (classification.state === MCP_STATES.configured) return null;
  const inline = document.assignmentAt(serverPath);
  if (inline !== undefined) {
    // The inline spelling cannot absorb an `env` table header, so the owned
    // definition is rewritten in block form. The marker above it is replaced with a
    // single copy of itself, so the proof of ownership survives exactly once.
    const markerLine = document.isMarkerLine(inline.startLine - 1, MCP_MARKER) ? inline.startLine - 1 : inline.startLine;
    document.replaceLines(markerLine, inline.endLine, renderMcpBlock(desired));
    return document.text;
  }
  const block = renderMcpBlock(desired);
  const blockValue = (key) => {
    const line = block.find((candidate) => candidate.startsWith(`${key} =`));
    return line === undefined ? null : line.slice(line.indexOf('=') + 1).trim();
  };
  for (const key of ['command', 'args', 'tool_timeout_sec']) {
    const value = blockValue(key);
    const entry = document.assignmentAt([...serverPath, key]);
    if (entry !== undefined && value !== null && entry.raw !== value) document.replaceValue(entry, value);
  }
  // An entry written before this field existed has no `tool_timeout_sec` at all, so
  // it is added inside the owned table, directly after the args line when that line
  // is present and otherwise after the header. Never appended at the end of the
  // document, where it could land under a different table.
  if (document.assignmentAt([...serverPath, 'tool_timeout_sec']) === undefined) {
    const line = `tool_timeout_sec = ${String(desired.toolTimeoutSec)}`;
    const argsEntry = document.assignmentAt([...serverPath, 'args']);
    if (argsEntry !== undefined) {
      document.replaceLines(argsEntry.endLine + 1, argsEntry.endLine, [line]);
    } else {
      const headerIndex = document.entries.findIndex(
        (candidate) => candidate.kind !== 'assignment' && samePath(candidate.path, serverPath),
      );
      const insertAt = headerIndex === -1 ? document.lines.length : document.entries[headerIndex].endLine + 1;
      document.replaceLines(insertAt, insertAt - 1, [line]);
    }
  }
  for (const [key, value] of Object.entries(desired.env)) {
    const entry = document.assignmentAt([...serverPath, 'env', key]);
    if (entry === undefined) {
      // Append inside the owned table, directly after its header, so the new line
      // cannot land inside a different table.
      const headerIndex = document.entries.findIndex(
        (candidate) => candidate.kind !== 'assignment' && samePath(candidate.path, serverPath),
      );
      const insertAt = headerIndex === -1 ? document.lines.length : document.entries[headerIndex].endLine + 1;
      document.replaceLines(insertAt, insertAt - 1, [`env.${renderKey([key])} = ${renderString(value)}`]);
    } else {
      document.replaceValue(entry, renderString(value));
    }
  }
  return document.text === before ? null : document.text;
}

/**
 * Remove the managed `mcp_servers.dsh-delegate` definition from a document.
 *
 * Only reachable for a definition the classifier proved is ours. The removed range
 * is the table header, its assignments and its child tables, plus the plugin marker
 * line and nothing else: a comment block the operator wrote above the marker stays,
 * because it may describe their own settings. A blank line left behind by the
 * removal is collapsed by {@link TomlDocument#removeLines}, and the document keeps
 * its original line endings.
 * @param {TomlDocument} document - parsed config.
 * @returns {{ text: string, removed: boolean }} next text and whether anything was removed.
 */
export function removeMcpEntry(document) {
  const { inline, headerIndex, marker } = locateMcpDefinition(document);
  if (marker === null) {
    // Nothing proved as ours: refuse rather than guess by name.
    return { text: document.text, removed: false };
  }
  if (inline !== undefined) {
    const startLine = document.isMarkerLine(inline.startLine - 1, MCP_MARKER) ? inline.startLine - 1 : inline.startLine;
    document.removeLines(startLine, inline.endLine);
    return { text: document.text, removed: true };
  }
  if (headerIndex === -1) return { text: document.text, removed: false };
  const range = document.markedTableRange(headerIndex, MCP_MARKER);
  document.removeLines(range.startLine, range.endLine);
  return { text: document.text, removed: true };
}

/**
 * Render the agent file from the shipped template plus this package's version.
 * @param {string} template - shipped template.
 * @param {string} version - package version.
 * @returns {string} file contents.
 */
export function renderAgentFile(template, version) {
  const marker = `version = ${renderString(version)}`;
  if (/^version = ".*"$/mu.test(template)) return template.replace(/^version = ".*"$/mu, marker);
  // Keep the provenance header first, then the version marker, then the rest.
  const lines = template.split('\n');
  const insertAt = lines.findIndex((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  const resolved = insertAt === -1 ? lines.length : insertAt;
  lines.splice(resolved, 0, marker);
  return lines.join('\n');
}

/**
 * Read and parse the Codex config, or return an empty document.
 * @param {string} configPath - config file path.
 * @returns {Promise<{ document: TomlDocument, exists: boolean, unreadable: boolean }>} parsed config.
 * @throws {CodexInstallError} `CODEX_CONFIG_UNREADABLE`, `CODEX_CONFIG_UNSUPPORTED`, `CODEX_CONFIG_TOO_LARGE`.
 */
async function loadConfig(configPath) {
  const existing = await inspectFile(configPath);
  if (existing.kind === 'missing') return { document: new TomlDocument(''), exists: false, unreadable: false };
  if (existing.kind === 'other') {
    return { document: new TomlDocument(''), exists: true, unreadable: true };
  }
  try {
    return { document: new TomlDocument(existing.contents), exists: true, unreadable: false };
  } catch (error) {
    if (error instanceof TomlSyntaxError) {
      throw new CodexInstallError(
        'CODEX_CONFIG_UNSUPPORTED',
        `Codex config.toml could not be read reliably (${error.message}); nothing was changed`,
        { line: error.line },
      );
    }
    throw error;
  }
}

/**
 * Read the Codex state without writing anything.
 * @param {object} options - `codexHome`, `env`, `discoveryFile`, `version`, `hostNode`.
 *   `hostNode` is an optional object of *host facts* (`execPath`, `resourcesPath`,
 *   `versions`, `platform`) for a host being described rather than the running
 *   process; the action's `env` still supplies `DSH_NODE_PATH` and the other
 *   overrides. It exists so a host integration — and a test proving the desktop
 *   behaviour — can state the process facts instead of mutating them.
 * @returns {Promise<object>} a status report.
 */
export async function readCodexStatus({
  codexHome = null,
  env = process.env,
  discoveryFile,
  version = null,
  hostNode = null,
} = {}) {
  const home = codexHome === null ? resolveCodexHome({ env }) : requireCodexHome(codexHome);
  const agentPath = join(home, 'agents', AGENT_FILENAME);
  const configPath = join(home, 'config.toml');
  const packageVersionValue = version ?? await readPackageVersion();
  const template = renderAgentFile(await readAgentTemplate(), packageVersionValue);
  // The boundary first: a link at the Codex home or at `agents` means the agent path
  // does not name a file this plugin may touch, whatever `lstat` would say about it.
  const boundary = await inspectCodexBoundary(home);
  const agent = boundary.blocked
    ? {
      state: AGENT_STATES.conflict,
      present: false,
      reason: boundary.unknown === true
        ? 'boundary-unverified'
        : boundary.link === 'codex-home' ? 'codex-home-is-link' : 'agents-dir-is-link',
      contents: null,
    }
    : await readAgentState(agentPath, template);
  const script = await resolveMcpScript();
  // A host with no provable Node.js runtime is a *reported* state, not a thrown
  // failure: the status still describes the agent file and the operator needs the
  // diagnosis, while every action refuses the MCP write (`MCP_EXECUTABLE_UNRESOLVED`)
  // instead of writing a command it could not prove.
  let node = null;
  let nodeError = null;
  try {
    // `hostNode` states the *host facts* (`execPath`, `resourcesPath`, `versions`,
    // `platform`) of a host this call is asking about; the environment is never
    // overridden by it, because `DSH_NODE_PATH` and friends are operator data that
    // travel in `env`, exactly like `CODEX_HOME` does.
    node = hostNode === null
      ? resolveNodeExecutable()
      : resolveNodeExecutable({ ...hostNode, env: hostNode.env ?? env });
  } catch (error) {
    if (!(error instanceof CodexInstallError)) throw error;
    nodeError = { code: error.code, message: error.message, details: error.details ?? {} };
  }
  const discovery = discoveryPin(discoveryFile ?? defaultDiscoveryPath(env), env);
  // With no executable there is nothing to register: `desired` is `null`, every
  // classification that needs it is short-circuited below, and install/repair refuse.
  const desired = node === null
    ? null
    : desiredMcpCommand({ node, script: script.script, discoveryFile: discovery.path, pinDiscovery: discovery.pin });

  let mcp = { state: MCP_STATES.unreadable, previous: null, reason: null, ownedValues: {}, marked: false };
  let configError = null;
  let configPathInfo = { exists: false };
  try {
    const loaded = await loadConfig(configPath);
    configPathInfo = { exists: loaded.exists };
    if (loaded.unreadable) {
      configError = { code: 'CODEX_CONFIG_UNREADABLE', message: 'config.toml is not a regular file this plugin may edit' };
    } else if (desired === null) {
      // The executable is the subject of this read's refusal, so the entry is not
      // classified against a command that does not exist.
      mcp = { state: MCP_STATES.unreadable, previous: null, reason: 'no-executable', ownedValues: {}, marked: false };
    } else {
      mcp = classifyMcpEntry(loaded.document, desired);
    }
  } catch (error) {
    configError = {
      code: typeof error?.code === 'string' ? error.code : 'CODEX_CONFIG_UNREADABLE',
      message: error?.message ?? 'the Codex config could not be read',
    };
  }

  return buildStatus({
    codexHome: home,
    agentPath,
    configPath,
    packageVersionValue,
    agent,
    mcp,
    desired,
    script,
    node,
    nodeError,
    discovery,
    configPathInfo,
    configError,
    boundary,
  });
}

/**
 * The default discovery file, resolved the same way the MCP process resolves it.
 * @param {Record<string, string | undefined>} env - environment.
 * @returns {string} absolute path.
 */
function defaultDiscoveryPath(env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const dshHome = configured === '' ? join(homedir(), '.dsh') : configured;
  return join(resolve(dshHome), 'data', 'dsh-delegate', 'runtime-endpoint.json');
}

/**
 * Compose the status payload the settings page renders.
 * @param {object} parts - collected facts.
 * @returns {object} plain JSON status document.
 */
function buildStatus({
  codexHome,
  agentPath,
  configPath,
  packageVersionValue,
  agent,
  mcp,
  desired,
  script,
  node,
  nodeError = null,
  discovery,
  configPathInfo,
  configError,
  boundary = null,
}) {
  const agentOk = agent.state === AGENT_STATES.installed;
  const mcpOk = mcp.state === MCP_STATES.configured;
  return {
    codexHome,
    packageVersion: packageVersionValue,
    // Whether the two directories that bound every write are real directories. A link
    // at either one is a stable diagnosis, not an installation state: install, repair
    // and remove all refuse while `blocked` is true.
    boundary: boundary === null
      ? { blocked: false, link: null, unknown: false, home: 'unknown', agents: 'unknown' }
      : {
        blocked: boundary.blocked === true,
        link: boundary.blocked === true ? boundary.link : null,
        unknown: boundary.unknown === true,
        home: boundary.home.kind,
        agents: boundary.agents.kind,
      },
    agent: {
      path: agentPath,
      state: agent.state,
      // Stated once here so no caller has to infer it from a state name.
      installed: agentOk,
      managed: agent.state !== AGENT_STATES.conflict && agent.state !== AGENT_STATES.modified,
      reason: agent.reason ?? null,
      // The exact bytes a refresh is allowed to replace. Internal: `installManaged`
      // re-reads the file and compares against this immediately before its rename, so
      // a file edited between the status read and the write is never replaced.
      expect: agent.contents ?? null,
    },
    mcp: {
      path: configPath,
      exists: configPathInfo.exists === true,
      serverName: MCP_SERVER_NAME,
      state: mcp.state,
      configured: mcpOk,
      previous: mcp.previous,
      reason: mcp.reason,
      // True only when the entry carries the plugin marker, i.e. when a later
      // `remove` may delete it. Values alone never establish ownership.
      marked: mcp.marked === true,
      // `null` when no Node.js executable could be proved; `resolved: false` says so
      // explicitly so a consumer never has to test for `null` alone.
      desired,
      node,
      nodeResolved: node !== null,
      // Why the executable could not be resolved (`MCP_EXECUTABLE_UNRESOLVED`), or
      // null. The app executable is never substituted for it.
      nodeError,
      script: script.script,
      scriptExists: script.exists,
      // Only written to the file when DSH uses a non-default location.
      discoveryFile: discovery.path,
      discoveryPinned: discovery.pin,
    },
    config: configError === null
      ? { readable: true, error: null }
      : { readable: false, error: configError },
    ready: agentOk && mcpOk && configError === null && node !== null,
    // What this action cannot do, stated where the operator sees the result.
    notes: buildNotes({ agent, mcp, script, configError, nodeError }),
  };
}

/**
 * Operator-facing limitations of the current state.
 * @param {object} parts - collected facts.
 * @returns {object[]} `[{ code, text }]`.
 */
function buildNotes({ agent, mcp, script, configError, nodeError = null }) {
  const notes = [];
  if (agent.state === AGENT_STATES.modified) {
    notes.push({
      code: 'AGENT_USER_MODIFIED',
      text: '已存在内容不同的 agents/dsh-delegate.toml，本插件不会覆盖或删除它；如需插件版本请先自行移动该文件。',
    });
  }
  if (agent.state === AGENT_STATES.conflict) {
    // `AGENT_PATH_CONFLICT` covers two different physical situations, and the
    // operator needs to know which one: a link on the way to the file (home or
    // `agents/`), or a final path that is not a regular file (a link, a directory).
    const text = agent.reason === 'codex-home-is-link'
      ? 'Codex home 本身是链接（符号链接或 Windows reparse point/junction），本插件不会穿过它写入或删除 agents/dsh-delegate.toml。'
      : agent.reason === 'agents-dir-is-link'
        ? 'agents 目录是链接（符号链接或 Windows reparse point/junction），本插件不会穿过它写入或删除 dsh-delegate.toml。'
        : agent.reason === 'boundary-unverified'
          ? 'Codex home 或 agents 目录无法确认是真实目录（可能缺少 Windows PowerShell），本插件不会写入或删除任何文件。'
          : 'agents/dsh-delegate.toml 不是普通文件（可能是链接或目录），本插件不会改动它。';
    notes.push({ code: 'AGENT_PATH_CONFLICT', text });
  }
  if (agent.state === AGENT_STATES.outdated) {
    notes.push({ code: 'AGENT_OUTDATED', text: '已安装的 agent 是旧版本（与某个已发布版本逐字节相同）。插件下次启动时会自动刷新为当前版本；也可以点「安装 / 更新 Codex 集成」立即更新。' });
  }
  if (mcp.state === MCP_STATES.conflict) {
    notes.push({
      code: 'MCP_ENTRY_CONFLICT',
      text: mcp.reason === 'unmanaged-entry'
        ? `config.toml 中已有同名的 mcp_servers.${MCP_SERVER_NAME} 条目，但没有本插件的托管标记注释，视为你自己写的：本插件不会更新或删除它；请自行删除或改名后再点安装。`
        : `config.toml 中已有同名的 mcp_servers.${MCP_SERVER_NAME} 条目，但内容不是本插件写入的形态（${mcp.reason ?? 'unknown'}）。本插件不会替换它；请自行删除或改名后再点安装。`,
    });
  }
  if (mcp.state === MCP_STATES.outdated) {
    notes.push({ code: 'MCP_ENTRY_OUTDATED', text: 'MCP 条目指向的可执行文件已变化（例如插件已升级），重新安装可更新。' });
  }
  if (configError !== null) {
    notes.push({ code: configError.code, text: `无法安全读取 config.toml：${configError.message}` });
  }
  if (nodeError !== null) {
    // The exact defect this release fixes: the desktop application executable must
    // never become the MCP command, so "no Node runtime" is a stated refusal.
    notes.push({
      code: 'MCP_EXECUTABLE_UNRESOLVED',
      text: '无法确定可用的 Node.js 可执行文件（桌面应用自身的 exe 不会被写入 Codex 配置，裸 node 也不会）。'
        + `请把 ${MCP_NODE_ENV_VARS[0]} 设为 node 可执行文件的绝对路径后重启 DSH；在此之前 MCP 条目不会被写入。`,
    });
  }
  if (!script.exists) {
    notes.push({ code: 'MCP_SCRIPT_MISSING', text: '包内未找到 bin/dsh-delegate-mcp.js，无法注册成可用的 MCP 入口。' });
  }
  return notes;
}

/**
 * Perform one explicit operator action.
 *
 * The four actions have deliberately different write sets, and `repair` is the one an
 * operator reaches for when only the MCP registration looks wrong:
 *
 *   * `status`  — reads only;
 *   * `install` — writes the agent file (when it is absent, or a byte-exact known
 *     prior build of it) **and** the owned MCP entry;
 *   * `repair`  — the MCP entry only. It never creates, refreshes or deletes the
 *     agent file, so a missing or outdated agent is reported by the returned status
 *     and left exactly as it was. This is the contract the settings page's
 *     “仅修复 MCP 配置” button and `docs/codex-integration.md` state;
 *   * `remove`  — deletes only an unchanged managed agent file and only an MCP entry
 *     this plugin still owns.
 *
 * Every action ends by returning a fresh status report, so the page never has to
 * guess what happened.
 * @param {string} action - one of {@link CODEX_ACTIONS}.
 * @param {object} options - `codexHome`, `env`, `discoveryFile`, `version`, `hostNode`.
 * @returns {Promise<{ action: string, changed: string[], refused: object[], status: object }>} outcome.
 * @throws {CodexInstallError} on invalid arguments.
 */
export async function runCodexAction(action, {
  codexHome = null,
  env = process.env,
  discoveryFile,
  version = null,
  hostNode = null,
} = {}) {
  if (!CODEX_ACTIONS.includes(action)) {
    throw new CodexInstallError('CODEX_ACTION_INVALID', `unknown Codex action ${JSON.stringify(action)}`);
  }
  // An explicit home must be absolute; otherwise the environment decides, and a
  // relative `CODEX_HOME` is refused there rather than resolved against the cwd.
  if (codexHome !== null && (typeof codexHome !== 'string' || codexHome.trim() === '' || !isAbsolute(codexHome))) {
    throw new CodexInstallError('CODEX_HOME_INVALID', 'the Codex home must be an absolute path');
  }
  const home = codexHome === null ? resolveCodexHome({ env }) : requireCodexHome(codexHome);
  if (action === 'status') {
    const status = await readCodexStatus({ codexHome: home, env, discoveryFile, version, hostNode });
    return { action, changed: [], refused: [], status };
  }

  const before = await readCodexStatus({ codexHome: home, env, discoveryFile, version, hostNode });
  /** @type {string[]} */
  const changed = [];
  /** @type {object[]} */
  const refused = [];

  // Re-prove the boundary immediately before writing. The status document was read a
  // moment ago and a link can have replaced the home or `agents/` since; that link is
  // refused here instead of being followed by `mkdir` or the exclusive create below.
  const linked = before.boundary?.blocked === true
    ? linkedBoundaryRefusal(before)
    : null;
  if (linked !== null) {
    refused.push(linked);
    return { action, changed, refused, status: before };
  }

  if (action === 'remove') {
    await removeManaged(before, { changed, refused });
  } else if (action === 'repair') {
    // MCP only: the agent file is not touched at all — not created, not refreshed,
    // not deleted. The returned status still reports its real (possibly `not-installed`
    // or `outdated`) state, so the page can tell the operator to run `install`.
    await installMcpEntry(before, { changed, refused });
  } else {
    await installManaged(before, { changed, refused });
  }

  const status = await readCodexStatus({ codexHome: home, env, discoveryFile, version, hostNode });
  return { action, changed, refused, status };
}

/**
 * Install the managed files: the agent file, then the MCP entry.
 *
 * Only `install` reaches this. `repair` calls {@link installMcpEntry} directly so it
 * cannot create or refresh an agent as a side effect.
 * @param {object} before - status read before the change.
 * @param {{ changed: string[], refused: object[] }} outcome - mutable outcome.
 * @returns {Promise<void>} resolves after both targets were attempted.
 */
async function installManaged(before, outcome) {
  await installManagedAgent(before, outcome);
  await installMcpEntry(before, outcome);
}

/**
 * Refresh only an agent file whose complete bytes match a known shipped template.
 *
 * This is called during plugin activation so a plugin upgrade can migrate a
 * previously shipped agent automatically. It never creates a missing file and
 * never touches config.toml; all replacement writes still re-prove the exact
 * bytes immediately before the atomic rename.
 * @param {object} options - same Codex home and version options as the status reader.
 * @returns {Promise<{ changed: string[], refused: object[], status: object }>} migration result.
 */
export async function refreshKnownAgentTemplate(options = {}) {
  const { codexHome = null, env = process.env, discoveryFile, version = null, hostNode = null } = options;
  if (codexHome !== null && (typeof codexHome !== 'string' || codexHome.trim() === '' || !isAbsolute(codexHome))) {
    throw new CodexInstallError('CODEX_HOME_INVALID', 'the Codex home must be an absolute path');
  }
  const home = codexHome === null ? resolveCodexHome({ env }) : requireCodexHome(codexHome);
  const before = await readCodexStatus({ codexHome: home, env, discoveryFile, version, hostNode });
  const changed = [];
  const refused = [];

  if (before.agent.state === AGENT_STATES.outdated) {
    const boundary = await inspectCodexBoundary(home);
    if (boundary.blocked === true) {
      refused.push(linkedBoundaryRefusal({ ...before, boundary }));
    } else {
      await installManagedAgent(before, { changed, refused });
    }
  }

  const status = await readCodexStatus({ codexHome: home, env, discoveryFile, version, hostNode });
  return { changed, refused, status };
}

/** Install or refresh the managed agent file without touching the MCP entry. */
async function installManagedAgent(before, outcome) {
  const { agent } = before;
  if (agent.state === AGENT_STATES.missing || agent.state === AGENT_STATES.outdated) {
    const template = renderAgentFile(await readAgentTemplate(), before.packageVersion);
    await mkdir(dirname(agent.path), { recursive: true, mode: 0o700 });
    if (agent.state === AGENT_STATES.missing) {
      // First installation: exclusive. A file that appeared between the status read
      // and this write belongs to whoever created it, and is reported, not replaced.
      const created = await createFileExclusive(agent.path, template);
      if (created === 'exists') {
        outcome.refused.push({
          target: 'agent',
          code: 'AGENT_PATH_CONFLICT',
          message: 'an agent file appeared while installing and was left untouched',
          path: agent.path,
          reason: 'created-concurrently',
        });
        return;
      }
      outcome.changed.push('agent');
    } else {
      // A refresh replaces a byte-exact known build of our own file. Re-check right
      // before writing: if the file changed in the meantime it is no longer that
      // known build, and the rename must not overwrite it.
      const current = await inspectFile(agent.path);
      if (current.kind !== 'file' || current.contents !== before.agent.expect) {
        outcome.refused.push({
          target: 'agent',
          code: 'AGENT_USER_MODIFIED',
          message: 'the agent file changed while updating and was left untouched',
          path: agent.path,
        });
        return;
      }
      await writeFileAtomic(agent.path, template);
      outcome.changed.push('agent');
    }
  } else if (agent.state === AGENT_STATES.modified || agent.state === AGENT_STATES.conflict) {
    outcome.refused.push({
      target: 'agent',
      code: agent.state === AGENT_STATES.modified ? 'AGENT_USER_MODIFIED' : 'AGENT_PATH_CONFLICT',
      message: 'an agent file with different contents already exists and was left untouched',
      path: agent.path,
    });
  }
}

/**
 * Register the owned MCP entry, refusing anything this plugin cannot prove is its own.
 *
 * This is the whole of `repair`, and the second half of `install`. It reads and writes
 * `config.toml` only: the agent file is never inspected for writing here, so a
 * `repair` cannot create the `agents/` directory, refresh a stale agent or remove one.
 * @param {object} before - status read before the change.
 * @param {{ changed: string[], refused: object[] }} outcome - mutable outcome.
 * @returns {Promise<void>} resolves after the target was attempted.
 */
async function installMcpEntry(before, outcome) {
  const { mcp } = before;
  if (mcp.scriptExists !== true) {
    outcome.refused.push({
      target: 'mcp',
      code: 'MCP_SCRIPT_MISSING',
      message: 'the package MCP entry point is missing, so the Codex entry would not start',
      path: mcp.script,
    });
    return;
  }
  if (mcp.nodeResolved !== true || mcp.desired === null) {
    // Fail closed: an entry whose `command` could not be proved to be a Node.js
    // executable is never written. Writing the desktop application's own path (the
    // pre-0.1.7 behaviour) would make Codex launch a second GUI.
    outcome.refused.push({
      target: 'mcp',
      code: 'MCP_EXECUTABLE_UNRESOLVED',
      message: mcp.nodeError?.message
        ?? 'no Node.js executable could be proved for the Codex MCP command, so no entry was written',
      path: mcp.path,
      details: mcp.nodeError?.details ?? {},
    });
    return;
  }
  if (before.config.readable !== true) {
    outcome.refused.push({
      target: 'mcp',
      code: before.config.error?.code ?? 'CODEX_CONFIG_UNREADABLE',
      message: before.config.error?.message ?? 'the Codex config could not be read',
      path: mcp.path,
    });
    return;
  }
  if (mcp.state === MCP_STATES.conflict) {
    outcome.refused.push({
      target: 'mcp',
      code: 'MCP_ENTRY_CONFLICT',
      message: mcp.reason === 'unmanaged-entry'
        ? 'a same-name mcp_servers.dsh-delegate entry without the plugin marker already exists and was left untouched'
        : 'a different mcp_servers.dsh-delegate entry already exists and was left untouched',
      path: mcp.path,
      reason: mcp.reason,
    });
    return;
  }
  if (mcp.state === MCP_STATES.configured) return;

  const loaded = await loadConfig(mcp.path);
  const desired = mcp.desired;
  const classification = classifyMcpEntry(loaded.document, desired);
  if (!MANAGEABLE_MCP_STATES.has(classification.state)) {
    // The file changed between the read and the write; never overwrite a definition
    // that stopped being ours.
    outcome.refused.push({
      target: 'mcp',
      code: 'MCP_ENTRY_CONFLICT',
      message: 'the mcp_servers.dsh-delegate entry changed concurrently and was left untouched',
      path: mcp.path,
      reason: classification.reason ?? classification.state,
    });
    return;
  }
  const next = applyMcpEntry(loaded.document, desired, classification);
  if (next === null) return;
  await mkdir(dirname(mcp.path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(mcp.path, next);
  outcome.changed.push('mcp');
}

/**
 * Delete the managed agent file — but only after re-proving it is still that file.
 *
 * The status read is already stale by the time a removal runs: the operator, an editor
 * or another tool may have rewritten the file after it. Deleting on the strength of the
 * earlier verdict would destroy that file, so ownership is re-proved here, at the last
 * moment, from the file itself: it must still be a *regular* file (not a link, not a
 * directory) whose bytes are exactly the managed content the status derived its verdict
 * from. `agent.expect` is that content, so the comparison is content identity, not a
 * timestamp or a size that a rewrite could accidentally preserve.
 *
 * Exported because it is the smallest unit that implements the guarantee: a test can
 * call it with a status captured earlier and prove that a file rewritten in between
 * survives. Every caller must pass the `agent` block of a status document.
 * @param {{ path: string, expect: string | null }} agent - the agent target of a status read.
 * @returns {Promise<{ code: string | null, target?: string, message?: string, path?: string, reason?: string }>}
 *   `{ code: null }` when the file was deleted; otherwise the refusal to report.
 */
export async function removeManagedAgentFile(agent) {
  const current = await inspectFile(agent.path);
  if (current.kind === 'missing') {
    // Nothing to delete: the file this read classified is already gone. Reported as a
    // refusal rather than a change, so the outcome never overstates what happened.
    return {
      target: 'agent',
      code: 'AGENT_PATH_CONFLICT',
      message: 'the agent file disappeared before it could be removed and nothing was deleted',
      path: agent.path,
      reason: 'missing-before-removal',
    };
  }
  if (current.kind !== 'file') {
    return {
      target: 'agent',
      code: 'AGENT_PATH_CONFLICT',
      message: 'the agent path stopped being a regular file before removal and was left untouched',
      path: agent.path,
      reason: 'not-a-regular-file',
    };
  }
  if (typeof agent.expect !== 'string' || current.contents !== agent.expect) {
    return {
      target: 'agent',
      code: 'AGENT_USER_MODIFIED',
      message: 'the agent file changed after it was inspected and was left untouched',
      path: agent.path,
      reason: 'modified-before-removal',
    };
  }
  try {
    await unlink(agent.path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // Raced away between the read and the unlink; still not a change of ours.
      return {
        target: 'agent',
        code: 'AGENT_PATH_CONFLICT',
        message: 'the agent file disappeared before it could be removed and nothing was deleted',
        path: agent.path,
        reason: 'missing-before-removal',
      };
    }
    if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'EBUSY') {
      return {
        target: 'agent',
        code: 'AGENT_PATH_CONFLICT',
        message: 'the agent file could not be removed and was left in place',
        path: agent.path,
        reason: 'unlink-refused',
      };
    }
    throw error;
  }
  return { code: null };
}

/**
 * Remove only what this plugin still owns.
 * @param {object} before - status read before the change.
 * @param {{ changed: string[], refused: object[] }} outcome - mutable outcome.
 * @returns {Promise<void>} resolves after both targets were attempted.
 */
async function removeManaged(before, outcome) {
  const { agent, mcp } = before;
  if (agent.state === AGENT_STATES.installed || agent.state === AGENT_STATES.outdated) {
    const verdict = await removeManagedAgentFile(agent);
    if (verdict.code === null) outcome.changed.push('agent');
    else outcome.refused.push(verdict);
  } else if (agent.state === AGENT_STATES.modified) {
    outcome.refused.push({
      target: 'agent',
      code: 'AGENT_USER_MODIFIED',
      message: 'the agent file differs from the managed template and was left untouched',
      path: agent.path,
    });
  } else if (agent.state === AGENT_STATES.conflict) {
    outcome.refused.push({
      target: 'agent',
      code: 'AGENT_PATH_CONFLICT',
      message: 'the agent path is not a regular file managed by this plugin and was left untouched',
      path: agent.path,
    });
  }

  if (before.config.readable !== true) {
    outcome.refused.push({
      target: 'mcp',
      code: before.config.error?.code ?? 'CODEX_CONFIG_UNREADABLE',
      message: before.config.error?.message ?? 'the Codex config could not be read',
      path: mcp.path,
    });
    return;
  }
  if (mcp.state !== MCP_STATES.configured && mcp.state !== MCP_STATES.outdated) {
    if (mcp.state === MCP_STATES.conflict) {
      outcome.refused.push({
        target: 'mcp',
        code: 'MCP_ENTRY_CONFLICT',
        message: 'the mcp_servers.dsh-delegate entry was not written by this plugin and was left untouched',
        path: mcp.path,
        reason: mcp.reason,
      });
    }
    return;
  }

  const loaded = await loadConfig(mcp.path);
  const classification = classifyMcpEntry(loaded.document, mcp.desired);
  if (classification.state !== MCP_STATES.configured && classification.state !== MCP_STATES.outdated) {
    outcome.refused.push({
      target: 'mcp',
      code: 'MCP_ENTRY_CONFLICT',
      message: 'the mcp_servers.dsh-delegate entry stopped being one this plugin manages and was left untouched',
      path: mcp.path,
      reason: classification.reason ?? classification.state,
    });
    return;
  }
  const { removed } = removeMcpEntry(loaded.document);
  if (!removed) return;
  await writeFileAtomic(mcp.path, loaded.document.text);
  outcome.changed.push('mcp');
}

/**
 * The status document without the internal ownership bytes.
 *
 * `agent.expect` carries the exact file a refresh may replace. It is what the
 * installer compares against right before its rename, so it must travel with the
 * status `installManaged` receives — but it is not part of the operator-facing
 * contract and would only bloat every HTTP response, so transports strip it.
 * @param {object} status - a document from {@link readCodexStatus}.
 * @returns {object} a shallow copy with the internal field removed.
 */
export function publicCodexStatus(status) {
  if (status === null || typeof status !== 'object') return status;
  const { expect: _ignored, ...agent } = status.agent ?? {};
  return { ...status, agent };
}

/**
 * Load the shipped agent template without the version marker, for diagnostics.
 *
 * Exported so a test can assert the shipped dispatch rules independently of the
 * installed copy.
 * @returns {Promise<{ text: string, instructions: string }>} template text and its developer instructions.
 */
export async function readAgentInstructions() {
  const text = await readAgentTemplate();
  const match = /developer_instructions = """([\s\S]*?)"""/u.exec(text);
  return { text, instructions: match === null ? '' : match[1] };
}

/**
 * Stable digest of the shipped template, so an installed file can be identified
 * without shipping the whole text in a response.
 * @param {string} text - file contents.
 * @returns {string} lowercase hex sha256.
 */
export function digest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Re-exported for callers that need to render a path list consistently. */
export { delimiter };
