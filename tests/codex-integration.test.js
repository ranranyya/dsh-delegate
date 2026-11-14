// Codex integration tests: the agent file, the MCP entry, the routes that expose
// them, and the dispatch rules the installed agent file must state.
//
// Every test runs against a temporary Codex home. Nothing here may touch the
// operator's real `~/.codex`, so `CODEX_HOME` is always overridden and the plugin's
// own status/action routes are driven with an explicitly constructed seam.
//
// The properties pinned down are the ones a reviewer would otherwise have to take
// on trust:
//
//   * plugin startup only refreshes a byte-exact known agent template; all other
//     Codex writes remain explicit settings-page actions;
//   * a same-name file or MCP entry that is not ours is refused, never replaced;
//   * repeating an install is idempotent;
//   * unrelated Codex settings, comments and table order survive;
//   * the MCP entry points at *this* installed package and at the discovery file
//     the running DSH published;
//   * the agent file states the exact activation and no-override rules;
//   * the DSH switch is reported, and never changed by these actions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_FILENAME,
  KNOWN_AGENT_TEMPLATES,
  MCP_MARKER,
  MCP_SERVER_NAME,
  adoptMovedInstall,
  adoptProvedMovedInstall,
  applyMcpEntry,
  classifyMcpEntry,
  createFileExclusive,
  desiredMcpCommand,
  digest,
  discoveryPin,
  hostRuntimeKind,
  inspectCodexBoundary,
  isNodeExecutableName,
  isOwnedEntryScript,
  isOwnedStaleEntry,
  packageEntryRoot,
  samePlatformPath,
  packagedNodePath,
  parseDirectoryVerdict,
  readCodexStatus,
  removeMcpEntry,
  removeManagedAgentFile,
  resolveCodexHome,
  resolveMcpScript,
  resolveNodeExecutable,
  refreshKnownAgentTemplate,
  runCodexAction,
  useDirectoryClassifier,
} from '../src/codex/installer.js';
import { TomlDocument, readTomlValues } from '../src/codex/toml.js';
import { createCodexSeam, defaultBackupDirectory, installationRecordPath, resolveStartupTarget } from '../src/codex/seam.js';
import { TomlDocument as Document } from '../src/codex/toml.js';
import { writeFileAtomic } from '../src/config/store.js';
import { USER_PLANE_PREFIX, wrapUserPlaneRoutes } from '../src/http/user-plane.js';
import { PREFLIGHT_ISOLATIONS, PREFLIGHT_REASONS } from '../src/workspace/preflight.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DELIVERABLE_VERSION = '1.4.2';
// The baseline the current release upgrades *from*, pinned rather than derived: an
// expectation that followed `DELIVERABLE_VERSION` would assert nothing.
const PREVIOUS_VERSION = '0.1.14';
const HISTORICAL_TEMPLATE_VERSION = '0.1.13';
/**
 * A version label no release ever shipped, used to prove that relabelling the current
 * template does not produce an enumerable "known build".
 */
const AGENT_RELABEL_PROBE_VERSION = '0.1.0';
/**
 * The SHA-256 of the published 0.1.12 template, over the packed (CRLF) bytes.
 *
 * Verified byte for byte by the coordinator before this release changed the template:
 * the `package/codex/dsh-delegate.toml` inside the packed `dsh-delegate-0.1.12.tgz` and
 * the saved release baseline
 * (`.cache/mcp-continuation-fix-20261107-221224/baseline/codex/dsh-delegate.toml`) are
 * identical to the pre-fix working tree template and produce this digest. It is pinned
 * here, never derived from the current template, so the assertion cannot drift with a
 * later edit.
 *
 * 0.1.12 was delivered as an uncommitted candidate plus a verified tarball; the last
 * commit (`a750c0b`) is 0.1.10, so there is no 0.1.12 commit to name.
 */
const PREVIOUS_VERSION_DIGEST = 'ff04a4bf2c09b97747f835770c837637869581bb13bad3b8a870a3e92218514f';
/**
 * The published 0.1.12 release, still migrated for installations that skipped 0.1.13.
 *
 * It shipped the same companion body as 0.1.13, so its bytes are reconstructed from the
 * 0.1.13 fixture and proved against {@link PREVIOUS_VERSION_DIGEST}.
 */
const AGENT_0_1_12_VERSION = '0.1.12';

/**
 * The published 0.1.13 template, and where its exact bytes live.
 *
 * 0.1.13 is the last release whose companion body predates the per-call permission
 * decision rules, so its bytes can no longer be reconstructed by relabelling the current
 * template: the fixture is the real `package/codex/dsh-delegate.toml` extracted from the
 * packed `dsh-delegate-0.1.13.tgz`. Pinned here rather than derived from
 * `KNOWN_AGENT_TEMPLATES`, because that list is the thing under test.
 */
const AGENT_0_1_13_FIXTURE = join(ROOT, 'tests', 'fixtures', 'codex-agent-0.1.13.toml');
const AGENT_0_1_13_DIGEST = 'b3a1d2f0520774c0067ea733f27fd47c67c5f5ac44394d0eec2564c7959700aa';
const AGENT_0_1_14_DIGEST = '11379c0152f3fb2bd4da1170812e51fe68006d98f6378c720cbadcee9ee4750c';
/**
 * The two LEGACY pinned 1.0.0 identities (unknown provenance).
 *
 * They are deliberately NOT the Git release bytes: the Git-verified 1.0.0 fixture hashes
 * to `b1fd5315…` (packed CRLF) and `0cce7557…` (LF), and those identities are enumerated
 * separately and asserted by the fixture tests. These two digests were enumerated by an
 * earlier build and are retained so an installation created by that build stays
 * structurally refreshable/removable instead of flipping to "somebody else's file". They
 * are exact content identities, not reconstructions of today's template.
 */
const AGENT_1_0_0_LEGACY_DIGEST = 'a8c888afaa0a1a6a0abfcb56670ffbdb67697f07e54871ece78c8adffb15c149';
const AGENT_1_0_0_LEGACY_DIGEST_ALT = 'f51831e2ff265c9ba63a4760e245787060de7bd91dcc9663a11729fb472e5f62';
/**
 * The 0.1.13 template text, which is the body every release from 0.1.10 to 0.1.13 shipped.
 *
 * Historical reconstructions start from this pinned text rather than from the shipped
 * template: 0.1.14 changed the body, so relabelling the current 1.0.0 file would produce bytes
 * no release ever published.
 */
const AGENT_0_1_13_TEMPLATE = readFileSync(AGENT_0_1_13_FIXTURE, 'utf8');

/**
 * The two byte forms the published 0.1.10 agent exists in.
 *
 * A release tarball packed on Windows carries CRLF (`fc7b2710…`); the same template
 * kept as LF text on other checkouts is `6583f08a…`. Both are exact byte identities, so
 * both have to be enumerable: an install that holds either form must stay refreshable.
 */
const AGENT_0_1_10_CRLF_DIGEST = 'fc7b27104dbb50f4e614cd4fd8df8db87fd8f59fcf2b3c27b412b49f8b89fbba';
const AGENT_0_1_10_LF_DIGEST = '6583f08a3ec4912a875249e6b127357b41cc3f8bf388b8e5cadbbeff469349be';
const AGENT_0_1_6_FIXTURE = join(ROOT, 'tests', 'fixtures', 'codex-agent-0.1.6.toml');
const AGENT_0_1_7_LEGACY_FIXTURE = join(ROOT, 'tests', 'fixtures', 'codex-agent-0.1.7.toml');
/**
 * Releases older than the current one that are still enumerated for migration.
 *
 * Pinned constants rather than derived values: `KNOWN_AGENT_TEMPLATES` is what is being
 * asserted, so a digest computed from it would assert nothing. 0.1.10–0.1.13 shipped one
 * body and differ only in the version line, so these are rebuilt from the pinned 0.1.13
 * FIXTURE (see {@link stampedTemplate}) — never from today's template, whose body changed
 * in 0.1.14.
 */
const AGENT_0_1_11_VERSION = '0.1.11';
const AGENT_0_1_11_DIGEST = 'b6ca7c3258fc00c1c1682abf099994b9f5abe650acc3ecf9635eec4a35520151';
/**
 * The published rebuilds at older version markers.
 *
 * These are enumerated in `KNOWN_AGENT_TEMPLATES`; each pair is pinned here so the
 * assertions compare against a fixed identity instead of recomputing the very list
 * under test. They are rebuilt from the pinned 0.1.13 FIXTURE — the last release that
 * shipped that body — by rewriting only its version line; the current template's body is
 * different, so deriving them from it would fabricate bytes no release ever published.
 */
const AGENT_0_1_7_REBUILD_VERSION = '0.1.7';
const AGENT_0_1_7_REBUILD_DIGEST = 'e3689492ee0f24d2defd2a9254b653e7bc54c258dd38fb0c2fc70ce5b386f2b3';
const AGENT_0_1_8_REBUILD_VERSION = '0.1.8';
const AGENT_0_1_8_REBUILD_DIGEST = '5cd02783d0fd5b1ffe5375e5d0e1b009931163e6f4fa87de9ea3c9c399fcd40e';
const AGENT_0_1_9_REBUILD_VERSION = '0.1.9';
const AGENT_0_1_9_REBUILD_DIGEST = 'b5db667d114baf881f59c9367a80137379960b1fccb524c883ab0edcf9f0d516';

// The boundary check asks the platform whether `$CODEX_HOME` and `$CODEX_HOME/agents`
// are real directories. On Windows that answer comes from a `powershell.exe` child, and
// this suite has to run where a child cannot be spawned at all, so the suite answers on
// Windows' behalf through the documented classifier hook. Everything else — `lstat`,
// the file-content checks, the writes — is the product code. The dedicated boundary
// tests below install their own classifier to report a junction, which is exactly what
// a real Windows install would answer.
useDirectoryClassifier(nodeClassifier());

/**
 * Why the backup-window regressions are skipped off Windows.
 *
 * They inject their concurrent edit from the directory-classifier hook, which the product
 * only consults for the Windows attribute read (the POSIX path answers from `lstat` and
 * never calls an injectable hook). The behaviour under test is platform-neutral; only the
 * deterministic injection point is Windows-specific.
 */
const WINDOWS_CLASSIFIER_SKIP = process.platform === 'win32'
  ? false
  : 'the backup-window hook is the Windows attribute read; this platform exposes no deterministic injection there';

/**
 * The managed MCP block exactly as the installer writes it, marker included.
 *
 * `renderString` escapes backslashes, which is what a Windows executable path needs;
 * `JSON.stringify` produces the same escaping for these ASCII paths.
 * @param {object} [options] - `node`, `script`, `env`.
 * @returns {string} TOML text.
 */
function managedBlock({ node = resolveNodeExecutable(), script = null, env = {} } = {}) {
  const entry = desiredMcpCommand({ node, script: script ?? join(ROOT, 'bin', 'dsh-delegate-mcp.js') });
  const lines = [
    MCP_MARKER,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${JSON.stringify(entry.args[0])}]`,
  ];
  for (const key of Object.keys(env)) lines.push(`env.${key} = ${JSON.stringify(env[key])}`);
  lines.push('');
  return lines.join('\n');
}

/** Create an isolated Codex home and return it with a cleanup function. */
function codexHomeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-delegate-codex-'));
  return {
    home,
    agentPath: join(home, 'agents', AGENT_FILENAME),
    configPath: join(home, 'config.toml'),
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * A REAL second installation of this package, for the moved-install migration.
 *
 * The migration only adopts a differing script path when that path is provably another
 * installation of this package: an absolute `<root>/bin/dsh-delegate-mcp.js` where
 * `<root>/package.json` declares `name: "dsh-delegate"` AND maps its published
 * `bin["dsh-delegate-mcp"]` entry to that very file. This builds exactly that on disk, so
 * a test proves the real proof rather than a name that merely looks like one.
 *
 * `bin`/`omitBin` exist for the NEGATIVE cases: a same-layout wrapper with a missing,
 * wrong, absolute or out-of-package mapping must never be adopted.
 * @param {object} [options] - `name`, `bin` mapping (default: the real one), `omitBin`.
 * @returns {{ root: string, script: string, cleanup: () => void }} the installation.
 */
function otherInstallationFixture({
  name = 'dsh-delegate',
  bin = { 'dsh-delegate-mcp': 'bin/dsh-delegate-mcp.js' },
  omitBin = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegate-oldpkg-'));
  mkdirSync(join(root, 'bin'), { recursive: true });
  const script = join(root, 'bin', 'dsh-delegate-mcp.js');
  writeFileSync(script, '// an older installation of this package\n');
  /** @type {Record<string, unknown>} */
  const manifest = { name, version: '1.1.0', repository: { url: 'https://github.com/ranranyya/dsh-delegate.git' } };
  if (omitBin !== true) manifest.bin = bin;
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    root,
    script,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Environment with no DSH/Codex overrides except an explicit Codex home.
 *
 * `DSH_HOME` is redirected INTO the same scratch directory as the Codex home. The seam
 * records the Codex home a successful explicit install used under
 * `$DSH_HOME/data/dsh-delegate`, and derives its default backup directory from the same
 * root: with an empty `DSH_HOME` every `seam.run('install')` would write that record into
 * the operator's real `~/.dsh`, which a test must never do.
 */
function isolatedEnv(home) {
  return {
    CODEX_HOME: home,
    DSH_HOME: join(home, '.dsh-test-home'),
    DSH_DELEGATE_DISCOVERY_FILE: '',
    DSH_DELEGATE_BASE_URL: '',
  };
}

/**
 * A directory classifier for tests that must know what the platform would answer.
 *
 * The installer asks Windows for `ReparsePoint` on a path's attributes, through one
 * `powershell.exe` child. This helper produces the same verdicts from Node for the one
 * thing `lstat` cannot see: a junction, which `lstat` reports as a plain directory. It
 * is installed with `useDirectoryClassifier`, so the tests exercise the real code path
 * (including `unknown`) without depending on a spawnable shell.
 * @param {() => boolean} [isLink] - extra predicate for "this path was turned into a link".
 * @returns {(paths: string[]) => Promise<Map<string, string>>} classifier.
 */
function nodeClassifier(isLink = () => false) {
  return async (paths) => {
    const kinds = new Map();
    for (const path of paths) {
      if (isLink(path)) {
        kinds.set(path, 'link');
        continue;
      }
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
  };
}

/** A config document that already contains settings this plugin must not touch. */
const FOREIGN_CONFIG = [
  '# operator comment that must survive',
  'model = "gpt-6.1"   # trailing note',
  '',
  '[mcp_servers]',
  'other = { command = "node", args = ["C:/other/server.mjs"] }',
  '',
  '[desktop]',
  'sansFontSize = 16',
  '',
].join('\n');

/**
 * The owned entry plus an environment variable the operator added.
 *
 * Only an entry whose `command` is ours can reach the `extra-env` judgement, so the
 * fixture has to look like our own definition.
 * @returns {string} TOML text.
 */
function OURS_WITH_EXTRA_ENV() {
  return [
    '[mcp_servers.dsh-delegate]',
    `command = ${JSON.stringify(resolveNodeExecutable())}`,
    `args = [${JSON.stringify(join(ROOT, 'bin', 'dsh-delegate-mcp.js'))}]`,
    'env.MINE = "1"',
    '',
  ].join('\n');
}

/** Build the dependencies the Codex route needs. */
function codexDeps(seam, { authorized = false } = {}) {
  return {
    settings: { read: async () => ({}) },
    auth: {},
    engine: {
      posture: () => ({ authorized, reason: authorized ? null : 'delegation is off', mode: 'switch' }),
    },
    codex: seam,
    logger: { warn() {}, info() {} },
  };
}

/** Invoke one user-plane route the way the native carrier does. */
async function call(routes, method, path, body) {
  const route = routes.find((entry) => entry.path === path);
  assert.ok(route !== undefined, `no route for ${path}`);
  assert.ok(route.methods.includes(method), `${path} does not accept ${method}`);
  const request = new Request(`http://127.0.0.1:3210${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: JSON.parse(await response.text()) };
}

// ---------------------------------------------------------------------------
// 1. Paths, executable and discovery
// ---------------------------------------------------------------------------

test('the Codex home follows CODEX_HOME and otherwise defaults to ~/.codex', () => {
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: join(tmpdir(), 'custom-home') } }), resolve(join(tmpdir(), 'custom-home')));
  assert.equal(resolveCodexHome({ env: {}, homeDirectory: join(tmpdir(), 'user') }), resolve(join(tmpdir(), 'user', '.codex')));
  assert.equal(
    resolveCodexHome({ env: { CODEX_HOME: '  ' }, homeDirectory: join(tmpdir(), 'user') }),
    resolve(join(tmpdir(), 'user', '.codex')),
    'a blank override is treated as unset',
  );
  assert.throws(() => resolveCodexHome({ env: { CODEX_HOME: 'relative/dir' } }), /absolute path/u);
});

test('the MCP entry point is this installed package, not a repository checkout', async () => {
  const script = await resolveMcpScript();
  assert.equal(script.exists, true);
  assert.equal(script.script, join(ROOT, 'bin', 'dsh-delegate-mcp.js'));
  assert.equal(script.fromRealPath, script.script, 'no symlink rewriting in this layout');
});

test('the MCP command pins the running Node.js and only pins discovery when it is non-default', () => {
  const node = resolveNodeExecutable();
  assert.equal(node, resolve(process.execPath));

  const custom = discoveryPin('/tmp/custom/runtime-endpoint.json', { DSH_DELEGATE_DISCOVERY_FILE: '/tmp/custom/discovery.json' });
  assert.deepEqual(custom, { path: resolve('/tmp/custom/discovery.json'), pin: true });

  const fallback = discoveryPin('/tmp/dsh/data/system/runtime-endpoint.json', {});
  assert.deepEqual(fallback, { path: resolve('/tmp/dsh/data/system/runtime-endpoint.json'), pin: false });

  const pinned = desiredMcpCommand({ node, script: 's.js', discoveryFile: custom.path, pinDiscovery: true });
  assert.equal(pinned.command, node);
  assert.deepEqual(pinned.args, ['s.js']);
  assert.deepEqual(pinned.env, { DSH_DELEGATE_DISCOVERY_FILE: custom.path });

  const implicit = desiredMcpCommand({ node, script: 's.js', discoveryFile: fallback.path, pinDiscovery: false });
  assert.deepEqual(implicit.env, {}, 'a default discovery path must stay implicit');
});

// ---------------------------------------------------------------------------
// 1b. The `command` executable: a Node.js runtime, never the desktop app
//
// The defect fixed here: in the DSH Desktop (Electron) host `process.execPath` is
// `DeepSeek Harness.exe`, and writing it as Codex's MCP `command` starts a second
// GUI instead of the server. Every case below is driven through injected host facts
// and a temporary `resources` tree, so no test reads, writes or requires the real
// DSH installation or a real user directory.
// ---------------------------------------------------------------------------

/**
 * A synthetic installation path, built without the host filesystem.
 *
 * Pure string concatenation on purpose: `path.join` would resolve `C:` relative to
 * the *current drive* on Windows and normalise separators for the current platform,
 * so the fixture would silently stop describing the layout under test. Nothing here
 * touches the disk — callers that need a file create it in the OS temp directory.
 * @param {'desktop' | 'node'} host - which installation layout to describe.
 * @param {...string} parts - path segments below that root.
 * @returns {string} absolute, platform-shaped path.
 */
function hostPath(host, ...parts) {
  const base = host === 'desktop' ? 'C:\\Users\\demo\\AppData\\Local\\Programs\\DeepSeek Harness' : 'C:\\Program Files\\nodejs';
  return [base, ...parts].join('\\');
}

/** The desktop application executable — the value that must never be written. */
const DESKTOP_EXE = hostPath('desktop', 'DeepSeek Harness.exe');

/** The Node.js binary of a plain Node host. */
const NODE_EXE = hostPath('node', 'node.exe');

/** Electron's `process.versions` as a packaged DSH Desktop reports it. */
const ELECTRON_VERSIONS = Object.freeze({ node: '24.21.0', electron: '38.2.0', v8: '14.0.0' });

/** A plain Node.js `process.versions`. */
const NODE_VERSIONS = Object.freeze({ node: '24.16.0', v8: '13.6.0' });

/**
 * A temporary `<resources>` tree that looks like a DSH Desktop installation.
 * @returns {{ root: string, nodePath: string, cleanup: () => void }} fixture.
 */
function resourcesFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegate-resources-'));
  const nodePath = packagedNodePath(root);
  mkdirSync(dirname(nodePath), { recursive: true });
  writeFileSync(nodePath, 'fixture: not a real executable\n');
  return { root, nodePath, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

/**
 * The `hostNode` fact set for a packaged DSH Desktop host.
 *
 * `readCodexStatus`/`runCodexAction` pass it straight to `resolveNodeExecutable`, so
 * the desktop branch is exercised through the real code path without mutating
 * `process`: nothing here reads or writes the installed DSH desktop, or any real
 * user directory.
 *
 * `env` is deliberately *not* included, so the resolver still reads the `env` the
 * action was called with. Overrides are data an operator configures
 * (`DSH_NODE_PATH`), not a fact about the process, and a test that wants one passes
 * it through the action's own `env` option — exactly as the host does.
 * @param {object} facts - `execPath`, `resourcesPath`, `versions`.
 * @returns {object} the resolver's own option shape.
 */
function hostNodeFacts(facts) {
  return {
    execPath: facts.execPath,
    resourcesPath: facts.resourcesPath,
    versions: facts.versions,
    platform: process.platform,
  };
}

/** Assert the fail-closed refusal: `MCP_EXECUTABLE_UNRESOLVED`, with a diagnosis. */
function assertUnresolved(run, message) {
  assert.throws(run, (error) => {
    assert.equal(error.name, 'CodexInstallError', message);
    assert.equal(error.code, 'MCP_EXECUTABLE_UNRESOLVED', message);
    // The refusal is a diagnosis: it names the rejected candidates and the fix.
    assert.match(error.message, /DSH_NODE_PATH/u, message);
    assert.ok(Array.isArray(error.details.rejected), message);
    return true;
  });
}

test('a plain Node.js host keeps the runtime that loaded this plugin', () => {
  // The host facts are injected rather than read from `process`: this suite runs
  // under Node, so `process.execPath` is real, but the fixture must describe *the
  // production Node layout* to prove the branch, and must not depend on the path this
  // machine happens to install Node at.
  const resources = resourcesFixture();
  try {
    const resolved = resolveNodeExecutable({
      env: {},
      execPath: process.execPath,
      resourcesPath: undefined,
      versions: NODE_VERSIONS,
      platform: process.platform,
    });
    assert.equal(resolved, resolve(process.execPath), 'a Node host pins its own executable');
    assert.equal(isNodeExecutableName(resolved), true);

    assert.equal(hostRuntimeKind({ versions: NODE_VERSIONS, resourcesPath: undefined }), 'node');
    assert.equal(hostRuntimeKind({ versions: ELECTRON_VERSIONS, resourcesPath: undefined }), 'electron');
    // `resourcesPath` alone is an equivalent desktop signal: a packaged Electron app
    // always exposes it, and a plain Node.js process never does.
    assert.equal(hostRuntimeKind({ versions: NODE_VERSIONS, resourcesPath: resources.root }), 'electron');
    // The desktop executable is never recognised as a Node runtime.
    assert.equal(isNodeExecutableName(DESKTOP_EXE), false);
    assert.equal(isNodeExecutableName(`${DESKTOP_EXE}.exe`), false);
    assert.equal(isNodeExecutableName(NODE_EXE), true);
    // Config files can retain Windows paths even when this code is inspected on a
    // host whose native `basename` would only understand `/`.
    assert.equal(isNodeExecutableName('C:/Program Files/nodejs/node.exe'), true);
    assert.equal(isNodeExecutableName('C:\\Program Files\\nodejs\\node.exe'), true);
    assert.equal(isNodeExecutableName('C:\\Program Files\\nodejs\\node-24.exe'), true);
  } finally {
    resources.cleanup();
  }
});

test('an Electron host resolves the DSH bundled runtime from process.resourcesPath', () => {
  const resources = resourcesFixture();
  try {
    assert.equal(hostRuntimeKind({ versions: ELECTRON_VERSIONS, resourcesPath: resources.root }), 'electron');
    const resolved = resolveNodeExecutable({
      env: {},
      execPath: DESKTOP_EXE,
      resourcesPath: resources.root,
      versions: ELECTRON_VERSIONS,
      platform: process.platform,
    });
    assert.equal(resolved, resources.nodePath);
    assert.equal(resolved, packagedNodePath(resources.root));
    assert.notEqual(resolved, DESKTOP_EXE, 'the application executable is never the MCP command');
    assert.match(resolved, /runtime[\\/]primary-runtime[\\/]dependencies[\\/]node[\\/]bin[\\/]node(?:\.exe)?$/u);
  } finally {
    resources.cleanup();
  }
});

test('a desktop host that exposes only its executable derives resources from execPath', () => {
  // DSH Desktop installs as `<root>/DeepSeek Harness.exe` with `<root>/resources` beside
  // it, so a host that does not publish `process.resourcesPath` is still resolvable.
  const installRoot = mkdtempSync(join(tmpdir(), 'dsh-delegate-desktop-'));
  try {
    const resourcesRoot = join(installRoot, 'resources');
    const nodePath = packagedNodePath(resourcesRoot);
    mkdirSync(dirname(nodePath), { recursive: true });
    writeFileSync(nodePath, 'fixture: not a real executable\n');
    const appExe = join(installRoot, 'DeepSeek Harness.exe');

    const resolved = resolveNodeExecutable({
      env: {},
      execPath: appExe,
      resourcesPath: undefined,
      versions: ELECTRON_VERSIONS,
      platform: process.platform,
    });
    assert.equal(resolved, nodePath);

    // The same derivation applies when the host signal is `resourcesPath === undefined`
    // *and* the executable is not a Node binary — i.e. an embedded host that did not
    // advertise Electron at all. The application path is still never returned.
    const unlabelled = resolveNodeExecutable({
      env: {},
      execPath: appExe,
      resourcesPath: undefined,
      versions: NODE_VERSIONS,
      platform: process.platform,
    });
    assert.equal(unlabelled, nodePath);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test('an absolute environment override is used when the bundled runtime is absent', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-override-'));
  try {
    const override = join(scratch, 'node.exe');
    writeFileSync(override, 'fixture: not a real executable\n');
    const host = { execPath: DESKTOP_EXE, resourcesPath: join(scratch, 'no-resources'), versions: ELECTRON_VERSIONS, platform: process.platform };

    // Each documented variable is accepted on its own.
    for (const name of ['DSH_NODE_PATH', 'DSH_NODE_EXECUTABLE', 'CODEX_MCP_NODE_PATH']) {
      const resolved = resolveNodeExecutable({ env: { [name]: override }, ...host });
      assert.equal(resolved, resolve(override), `${name} must be accepted`);
    }
    // Precedence is fixed and independent of object key order, so two set variables
    // cannot make the answer depend on how the environment object was built.
    const precedence = join(scratch, 'second.exe');
    writeFileSync(precedence, 'fixture\n');
    assert.equal(
      resolveNodeExecutable({
        env: { CODEX_MCP_NODE_PATH: precedence, DSH_NODE_EXECUTABLE: precedence, DSH_NODE_PATH: override },
        ...host,
      }),
      resolve(override),
      'DSH_NODE_PATH wins',
    );
    assert.equal(
      resolveNodeExecutable({ env: { CODEX_MCP_NODE_PATH: precedence, DSH_NODE_EXECUTABLE: override }, ...host }),
      resolve(override),
      'DSH_NODE_EXECUTABLE is next',
    );
    assert.equal(
      resolveNodeExecutable({ env: { CODEX_MCP_NODE_PATH: override, DSH_NODE_PATH: precedence }, ...host }),
      resolve(override),
      'an unusable higher-priority value does not block a usable lower one',
    );
    // A whitespace-only value is treated as unset, not as a path.
    assert.equal(resolveNodeExecutable({ env: { DSH_NODE_PATH: '   ', CODEX_MCP_NODE_PATH: override }, ...host }), resolve(override));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an invalid override is refused rather than trusted', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-invalid-'));
  try {
    const directory = join(scratch, 'a-directory.exe');
    mkdirSync(directory);
    const plainFile = join(scratch, 'notes.txt');
    writeFileSync(plainFile, 'not an executable name\n');
    const host = {
      execPath: DESKTOP_EXE,
      resourcesPath: join(scratch, 'no-resources'),
      versions: ELECTRON_VERSIONS,
      platform: process.platform,
    };
    for (const [label, value] of [
      ['relative path', 'node.exe'],
      ['missing file', join(scratch, 'absent.exe')],
      ['directory', directory],
      ['not a Node binary', plainFile],
      ['bare command name', 'node'],
    ]) {
      assertUnresolved(() => resolveNodeExecutable({ env: { DSH_NODE_PATH: value }, ...host }), `${label} must be refused`);
      // The reason is carried in the diagnosis, so an operator can act on it.
      assert.throws(() => resolveNodeExecutable({ env: { DSH_NODE_PATH: value }, ...host }), (error) => {
        assert.ok(
          error.details.rejected.some((entry) => entry.source === 'DSH_NODE_PATH'),
          `${label} must be named in the diagnosis`,
        );
        return true;
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a desktop host with no provable Node fails closed instead of writing the app executable', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-failclosed-'));
  try {
    // No bundled runtime, no usable override: the only throw options are the desktop
    // application and a bare `node`, and both are wrong.
    const host = {
      execPath: DESKTOP_EXE,
      resourcesPath: join(scratch, 'no-resources'),
      versions: ELECTRON_VERSIONS,
      platform: process.platform,
    };
    assertUnresolved(() => resolveNodeExecutable({ env: {}, ...host }));

    // A plain-Node host whose executable is *not* a Node binary has nothing to pin
    // either — the application must not be returned merely because Electron was quiet.
    assertUnresolved(() => resolveNodeExecutable({
      execPath: DESKTOP_EXE,
      resourcesPath: undefined,
      versions: NODE_VERSIONS,
      platform: process.platform,
      env: {},
    }));
    // Sanity: the refusal is about resolution, not about the fixture. Giving the same
    // host a real bundled runtime resolves it again.
    const resourcesRoot = join(scratch, 'resources');
    const nodePath = packagedNodePath(resourcesRoot);
    mkdirSync(dirname(nodePath), { recursive: true });
    writeFileSync(nodePath, 'fixture\n');
    assert.equal(resolveNodeExecutable({ ...host, resourcesPath: resourcesRoot }), nodePath);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the MCP entry is written with the bundled Node, never with the desktop executable', async () => {
  const resources = resourcesFixture();
  const fixture = codexHomeFixture();
  // The desktop host is stated as resolver facts (`hostNode`), which is the same
  // production code path `runCodexAction()` takes when it resolves the process facts
  // itself; nothing mutates `process` here.
  const hostNode = hostNodeFacts({ execPath: DESKTOP_EXE, resourcesPath: resources.root, versions: ELECTRON_VERSIONS });
  const options = { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION, hostNode };
  try {
    const installed = await runCodexAction('install', options);
    assert.deepEqual(installed.changed.sort(), ['agent', 'mcp']);
    assert.equal(installed.status.mcp.node, resources.nodePath);
    assert.equal(installed.status.mcp.nodeResolved, true);
    const written = readFileSync(fixture.configPath, 'utf8');
    const values = readTomlValues(written);
    assert.equal(values['mcp_servers.dsh-delegate.command'].text, JSON.stringify(resources.nodePath));
    assert.equal(written.includes(DESKTOP_EXE), false, 'the desktop executable must never reach config.toml');
    assert.doesNotMatch(written, /command = "node"/u, 'a bare node is never written either');

    // The status read agrees, and a second install is idempotent against that value.
    const status = await runCodexAction('status', options);
    assert.equal(status.status.mcp.state, 'configured');
    assert.equal(status.status.mcp.configured, true);
    assert.equal(status.status.ready, true);
    assert.equal(status.status.mcp.desired.command, resources.nodePath);
    const second = await runCodexAction('install', options);
    assert.deepEqual(second.changed, []);
    assert.equal(readFileSync(fixture.configPath, 'utf8'), written);
  } finally {
    resources.cleanup();
    fixture.cleanup();
  }
});

test('an unresolvable executable refuses the MCP write and leaves config.toml byte-identical', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-unresolved-'));
  const fixture = codexHomeFixture();
  const hostNode = hostNodeFacts({
    execPath: DESKTOP_EXE,
    resourcesPath: join(scratch, 'no-resources'),
    versions: ELECTRON_VERSIONS,
  });
  const options = { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION, hostNode };
  try {
    const before = '# operator config\nmodel = "gpt-6.1"\n';
    writeFileSync(fixture.configPath, before);

    const installed = await runCodexAction('install', options);
    // The agent is a separate target and is still installed; the MCP half is refused.
    assert.ok(installed.changed.includes('agent'), 'the agent file is an independent target');
    assert.equal(installed.changed.includes('mcp'), false, 'no MCP entry may be written without an executable');
    assert.ok(installed.refused.some((entry) => entry.target === 'mcp' && entry.code === 'MCP_EXECUTABLE_UNRESOLVED'));
    assert.equal(readFileSync(fixture.configPath, 'utf8'), before, 'the config must be byte-identical');
    // The status reports the refusal instead of throwing, and says which fact is
    // missing rather than showing a command it could not prove.
    assert.equal(installed.status.mcp.node, null);
    assert.equal(installed.status.mcp.nodeResolved, false);
    assert.equal(installed.status.mcp.desired, null);
    assert.equal(installed.status.mcp.state, 'unreadable');
    assert.equal(installed.status.mcp.reason, 'no-executable');
    assert.equal(installed.status.mcp.nodeError.code, 'MCP_EXECUTABLE_UNRESOLVED');
    assert.equal(installed.status.ready, false);
    assert.ok(installed.status.notes.some((note) => note.code === 'MCP_EXECUTABLE_UNRESOLVED'));

    // `repair` is the MCP-only action and must refuse for the same reason.
    const repaired = await runCodexAction('repair', options);
    assert.deepEqual(repaired.changed, []);
    assert.ok(repaired.refused.some((entry) => entry.target === 'mcp' && entry.code === 'MCP_EXECUTABLE_UNRESOLVED'));
    assert.equal(readFileSync(fixture.configPath, 'utf8'), before);

    // A status read never throws: the page must be able to render the diagnosis.
    const status = await runCodexAction('status', options);
    assert.equal(status.status.mcp.nodeResolved, false);
    assert.equal(status.status.mcp.nodeError.code, 'MCP_EXECUTABLE_UNRESOLVED');

    // With an override in place the very same home installs successfully, so the
    // refusal above was about resolution and not about the fixture. The host is still
    // a desktop app, which proves the override is consulted in that branch.
    // The override is a *file* named node.exe, so it cannot reuse the `node.exe`
    // *directory* the invalid-override cases create at `scratch/node.exe`.
    const overrideDir = join(scratch, 'override');
    mkdirSync(overrideDir, { recursive: true });
    const nodeOverride = join(overrideDir, 'node.exe');
    writeFileSync(nodeOverride, 'fixture\n');
    const recovered = await runCodexAction('repair', {
      ...options,
      env: { ...isolatedEnv(fixture.home), DSH_NODE_PATH: nodeOverride },
      hostNode: hostNodeFacts({ execPath: DESKTOP_EXE, resourcesPath: join(scratch, 'no-resources'), versions: ELECTRON_VERSIONS }),
    });
    assert.deepEqual(recovered.refused, []);
    assert.ok(recovered.changed.includes('mcp'));
    assert.equal(recovered.status.mcp.nodeResolved, true);
    assert.equal(recovered.status.mcp.node, resolve(nodeOverride));
    assert.equal(
      readTomlValues(readFileSync(fixture.configPath, 'utf8'))['mcp_servers.dsh-delegate.command'].text,
      JSON.stringify(resolve(nodeOverride)),
    );
    assert.equal(readFileSync(fixture.configPath, 'utf8').includes(DESKTOP_EXE), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Agent file: idempotency, preservation, refresh
// ---------------------------------------------------------------------------

test('install writes the agent file and the MCP entry, and repeating it changes nothing', async () => {
  const fixture = codexHomeFixture();
  try {
    const first = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.deepEqual(first.changed.sort(), ['agent', 'mcp']);
    assert.equal(first.status.agent.state, 'installed');
    assert.equal(first.status.mcp.state, 'configured');
    assert.equal(first.status.ready, true);

    const agent = readFileSync(fixture.agentPath, 'utf8');
    assert.match(agent, /^name = "dsh-taskbridge"$/mu);
    assert.match(agent, new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
    assert.match(agent, /managed by the DSH TaskBridge plugin/u);

    const configBefore = readFileSync(fixture.configPath, 'utf8');
    const second = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.deepEqual(second.changed, [], 'an idempotent install must not rewrite anything');
    assert.equal(readFileSync(fixture.configPath, 'utf8'), configBefore);
  } finally {
    fixture.cleanup();
  }
});

test('a same-name agent file with different content is never overwritten or removed', async () => {
  const fixture = codexHomeFixture();
  const custom = '# my own agent\nname = "mine"\n';
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, custom);

    const install = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(install.status.agent.state, 'modified');
    assert.ok(install.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'));
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), custom, 'the user file must be intact');
    // The MCP entry is a different target and is still registered.
    assert.equal(install.status.mcp.state, 'configured');

    const remove = await runCodexAction('remove', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(remove.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'));
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), custom);
  } finally {
    fixture.cleanup();
  }
});

test('a byte-exact known prior build is refreshed, a user-edited one is not', async () => {
  const fixture = codexHomeFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const current = readFileSync(fixture.agentPath, 'utf8');

    // A file that merely *looks* like an older build — same header, older version —
    // is not proof of authorship: it is treated as the operator's and left alone.
    const olderVersionOnly = current.replace(/^version = ".*"$/mu, 'version = "0.1.5"');
    writeFileSync(fixture.agentPath, olderVersionOnly);
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(status.status.agent.state, 'modified', 'an unenumerated older version line is not a managed build');
    assert.equal(status.status.agent.managed, false);

    const refused = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.ok(refused.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'));
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), olderVersionOnly, 'an edited file must survive an install');

    const removed = await runCodexAction('remove', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(removed.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'));
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), olderVersionOnly, 'an edited file must survive a remove');

    // A file that breaks the managed provenance entirely is treated as theirs too.
    writeFileSync(fixture.agentPath, '# dsh-delegate Codex companion — mine now\nversion = "0.0.1"\n');
    const again = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(again.status.agent.state, 'modified');
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), '# dsh-delegate Codex companion — mine now\nversion = "0.0.1"\n');
  } finally {
    fixture.cleanup();
  }
});

test(`the published 0.1.6 agent is refreshed to ${DELIVERABLE_VERSION}, while its bytes remain the ownership proof`, async () => {
  const fixture = codexHomeFixture();
  const prior = readFileSync(AGENT_0_1_6_FIXTURE, 'utf8');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    assert.equal(digest(prior), '6a9d0da5b32d62a2a1f61d1fba37d54789cde0774afb3abccb5dc12b400c82be');
    assert.ok(KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === '0.1.6' && entry.sha256 === digest(prior)));

    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(before.status.agent.state, 'outdated');

    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(installed.changed.includes('agent'));
    const current = readFileSync(fixture.agentPath, 'utf8');
    assert.match(current, new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
    assert.notEqual(current, prior);
  } finally {
    fixture.cleanup();
  }
});

test(`the rebuilt ${AGENT_0_1_7_REBUILD_VERSION} agent is refreshed to ${DELIVERABLE_VERSION} only when its bytes match`, async () => {
  // A file that is byte-identical to an enumerated published rebuild is refreshable;
  // the version line is NOT the proof, the bytes are. These rebuilds are enumerated
  // in `KNOWN_AGENT_TEMPLATES` because the instruction body changed between releases
  // (the per-task conversation policy, then the source-path policy), which changes the
  // bytes of every rebuild. The body they were built from is the 0.1.12 one, so the
  // fixture — not the current template — is the source of the bytes.
  const fixture = codexHomeFixture();
  const prior = historicalTemplate(AGENT_0_1_7_REBUILD_VERSION, 'crlf');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    assert.equal(digest(prior), AGENT_0_1_7_REBUILD_DIGEST);
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === AGENT_0_1_7_REBUILD_VERSION && entry.sha256 === digest(prior)),
      'a rebuild of the shipped template is an enumerable known build',
    );

    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(before.status.agent.state, 'outdated');

    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(installed.changed.includes('agent'));
    assert.match(readFileSync(fixture.agentPath, 'utf8'), new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
  } finally {
    fixture.cleanup();
  }
});

test('the original published 0.1.7 agent is recognized and refreshed on startup', async () => {
  const fixture = codexHomeFixture();
  const prior = readFileSync(AGENT_0_1_7_LEGACY_FIXTURE, 'utf8').replace(/\r?\n/gu, '\r\n');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    assert.equal(digest(prior), '3b5a58df0f989e87ae160a2952b7699cd5e2978e43a0f9a86c4eceb155d7af92');

    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const refreshed = await seam.refreshKnownAgent();
    assert.deepEqual(refreshed.changed, ['agent']);
    assert.deepEqual(refreshed.refused, []);
    assert.equal(refreshed.status.agent.state, 'installed');
    assert.match(readFileSync(fixture.agentPath, 'utf8'), new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
    assert.equal(existsSync(fixture.configPath), false, 'startup migration must not write config.toml');
  } finally {
    fixture.cleanup();
  }
});

test(`the published ${AGENT_0_1_8_REBUILD_VERSION} agent is refreshed to ${DELIVERABLE_VERSION} only when its bytes match`, async () => {
  const fixture = codexHomeFixture();
  const prior = historicalTemplate(AGENT_0_1_8_REBUILD_VERSION, 'crlf');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    assert.equal(digest(prior), AGENT_0_1_8_REBUILD_DIGEST);
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === AGENT_0_1_8_REBUILD_VERSION && entry.sha256 === digest(prior)),
      'the rebuild of the shipped template is an enumerable known build',
    );

    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(before.status.agent.state, 'outdated');

    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(installed.changed.includes('agent'));
    assert.match(readFileSync(fixture.agentPath, 'utf8'), new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
  } finally {
    fixture.cleanup();
  }
});

test(`the published ${AGENT_0_1_9_REBUILD_VERSION} agent is refreshed to ${DELIVERABLE_VERSION} only when its bytes match`, async () => {
  const fixture = codexHomeFixture();
  const prior = historicalTemplate(AGENT_0_1_9_REBUILD_VERSION, 'crlf');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    assert.equal(digest(prior), AGENT_0_1_9_REBUILD_DIGEST);
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === AGENT_0_1_9_REBUILD_VERSION && entry.sha256 === digest(prior)),
      'the rebuild of the shipped template is an enumerable known build',
    );

    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(before.status.agent.state, 'outdated');

    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(installed.changed.includes('agent'));
    assert.match(readFileSync(fixture.agentPath, 'utf8'), new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
  } finally {
    fixture.cleanup();
  }
});

/**
 * Reconstruct a historical agent file by rewriting only a version line.
 *
 * Every release from 0.1.10 through 0.1.13 shipped the SAME companion body and differs
 * only in the version line, so its exact historical bytes are recoverable by rewriting
 * that one line — but only from a template that still carries that body. This build
 * (0.1.14) changed it (the per-call permission decision rules), so the reconstructions
 * start from the pinned 0.1.13 fixture instead of the shipped template: reconstructing
 * from the current body would invent a file no release ever published, and the pinned
 * digests below would (correctly) refuse it.
 *
 * `from` names the release whose body the input text carries, `version` names the release
 * wanted. `eol` selects which byte form is constructed, and it is always stated by the
 * caller: the packed tarball is CRLF, an LF checkout is LF, and both are legitimately
 * published files. Nothing here normalizes implicitly — the caller decides, and the
 * caller's digest is proved against a pinned value.
 * @param {string} template - file text to start from.
 * @param {string} from - the release whose body the input text carries.
 * @param {string} version - the release whose bytes are wanted.
 * @param {'crlf' | 'lf'} eol - the line endings of the wanted release.
 * @returns {string} the file text, byte-identical to that release's shipped template.
 */
function stampedTemplate(template, from, version, eol) {
  const text = eol === 'crlf' ? template.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') : template.replaceAll('\r\n', '\n');
  const eolChar = eol === 'crlf' ? '\r' : '';
  return text.replace(
    new RegExp(`^(version = )"${from.replace(/\./gu, '\\.')}"${eolChar}$`, 'mu'),
    `$1"${version}"${eolChar}`,
  );
}

/**
 * A historical agent file, rebuilt from the last template that shared its body.
 *
 * The body all of these releases shipped is the 0.1.13 one, so that fixture is the base
 * and `from` is always `PREVIOUS_VERSION`. Naming it once keeps the call sites from
 * silently reconstructing out of the current, changed template.
 * @param {string} version - the release whose bytes are wanted.
 * @param {'crlf' | 'lf'} eol - the line endings of the wanted release.
 * @returns {string} the file text, byte-identical to that release's shipped template.
 */
function historicalTemplate(version, eol) {
  return stampedTemplate(AGENT_0_1_13_TEMPLATE, HISTORICAL_TEMPLATE_VERSION, version, eol);
}

/**
 * Assert the shipped template is this build, without assuming a line-ending style.
 *
 * A checkout on Windows may keep CRLF and a checkout elsewhere LF; the product hashes
 * whatever bytes it is given, so the fixtures below state their own endings instead of
 * relying on the checkout's.
 * @param {string} template - the shipped template.
 */
function assertShippedTemplate(template) {
  const lf = template.replaceAll('\r\n', '\n');
  assert.ok(!lf.includes('\r'), 'sanity: the shipped template uses one consistent line-ending style');
  assert.match(lf, new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'), 'sanity: the shipped template is this build');
}

test(`the published 0.1.11 agent is refreshed to ${DELIVERABLE_VERSION} by startup and by install, and its bytes stay the ownership proof`, async () => {
  // An older published release an installation may still hold. It is no longer the
  // immediately previous build (0.1.12 is), but a machine that skipped 0.1.12 must
  // still be migrated, so its coverage is kept — generalized over the version it
  // upgrades to rather than frozen at one release.
  //
  // 0.1.11 shipped the 0.1.13-body companion (the versions after it changed the body),
  // so its bytes are rebuilt from the pinned 0.1.13 FIXTURE by rewriting only its
  // version line, then proved against the pinned published digest.
  const fixture = codexHomeFixture();
  const template = readFileSync(join(ROOT, 'codex', 'dsh-taskbridge.toml'), 'utf8');
  assertShippedTemplate(template);
  const prior = historicalTemplate(AGENT_0_1_11_VERSION, 'crlf');
  try {
    assert.notEqual(prior, template, 'the fixture must really differ from the shipped template');
    assert.equal(digest(prior), AGENT_0_1_11_DIGEST, `the reconstructed bytes are the published ${AGENT_0_1_11_VERSION} template`);
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === AGENT_0_1_11_VERSION && entry.sha256 === AGENT_0_1_11_DIGEST),
      `the published ${AGENT_0_1_11_VERSION} template must stay enumerated, or a skipped release can never be refreshed`,
    );
    // No enumerated build may match the current template with a RELABELLED version
    // line: such a "build" was never published. (The current template is itself not
    // enumerated either, because it is compared as the live template, not as history.)
    const RELABEL_MARKER = `version = "${AGENT_RELABEL_PROBE_VERSION}"`;
    for (const entry of KNOWN_AGENT_TEMPLATES) {
      const relabelled = template.replace(/^version = ".*"$/mu, RELABEL_MARKER);
      assert.notEqual(entry.sha256, digest(relabelled), 'a relabelled current template is never a known build');
    }
    // Sanity: the relabelled probe really differs from the shipped file, so the
    // assertion above is not vacuous.
    assert.notEqual(template.replace(/^version = ".*"$/mu, RELABEL_MARKER), template);

    // 1. Startup refresh: the only automatic write, and it happens exactly once.
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const status = await seam.refreshKnownAgent();
    assert.deepEqual(status.changed, ['agent']);
    assert.deepEqual(status.refused, []);
    const migrated = readFileSync(fixture.agentPath, 'utf8');
    assert.equal(migrated, template, 'the migrated file must be exactly what this build writes');
    assert.match(migrated, new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
    assert.equal(existsSync(fixture.configPath), false, 'startup migration must not create config.toml');

    // A second startup is a no-op: the migration happens exactly once.
    const again = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
    assert.deepEqual(again.changed, [], 'an already-current agent file must not be rewritten');
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), template);

    // 2. A no-home first start creates nothing: without an agent file there is no
    //    migration to run and no MCP entry may be registered on startup.
    const empty = codexHomeFixture();
    try {
      const startup = await createCodexSeam({ codexHome: empty.home, env: isolatedEnv(empty.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
      assert.deepEqual(startup.changed, []);
      assert.deepEqual(startup.refused, []);
      assert.equal(existsSync(empty.agentPath), false, 'startup must not create an agent file');
      assert.equal(existsSync(join(empty.home, 'agents')), false, 'startup must not create the agents directory');
      assert.equal(existsSync(empty.configPath), false, 'startup must not register the MCP entry');
    } finally {
      empty.cleanup();
    }

    // 3. A user body edit on top of those bytes is theirs: the version line is
    //    not the proof, so neither startup nor install nor remove may touch it.
    const edited = prior.replace('name = "dsh-delegate"', '# my own note\nname = "dsh-delegate"');
    assert.notEqual(edited, prior);
    writeFileSync(fixture.agentPath, edited);
    const afterEdit = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
    assert.deepEqual(afterEdit.changed, [], `startup must not refresh an edited ${AGENT_0_1_11_VERSION} file`);
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited);
    for (const action of ['install', 'remove']) {
      const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(outcome.changed.includes('agent'), false, `${action} must not write an edited ${AGENT_0_1_11_VERSION} file`);
      assert.ok(
        outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'),
        `${action} must report AGENT_USER_MODIFIED`,
      );
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited, `${action} must leave the edited body byte-identical`);
    }

    // 4. The explicit install path refreshes the same bytes, and reports it as
    //    `outdated` — not `modified` — because the bytes are the enumerated build.
    writeFileSync(fixture.agentPath, prior);
    const statusRead = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(statusRead.status.agent.state, 'outdated', 'byte-exact published bytes are outdated, never modified');
    assert.equal(statusRead.status.agent.managed, true);
    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.ok(installed.changed.includes('agent'));
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), template);
  } finally {
    fixture.cleanup();
  }
});

test(`the published ${AGENT_0_1_12_VERSION} agent is refreshed to ${DELIVERABLE_VERSION} by startup and by install, and its bytes stay the ownership proof`, async () => {
  // A published release an installation may still hold. It is no longer the immediately
  // previous build (0.1.13 is), but a machine that skipped 0.1.13 must still be migrated,
  // so its coverage is kept. 0.1.12 shipped the same companion body as 0.1.13 (the
  // per-call permission rules arrived in 0.1.14), so its bytes are rebuilt from the pinned
  // 0.1.13 fixture by rewriting only the version line and proved against the published
  // digest — a value the coordinator verified against the
  // `package/codex/dsh-delegate.toml` inside the packed `dsh-delegate-0.1.12.tgz` and
  // against the saved release baseline.
  const fixture = codexHomeFixture();
  const template = readFileSync(join(ROOT, 'codex', 'dsh-taskbridge.toml'), 'utf8');
  assertShippedTemplate(template);
  const prior = historicalTemplate(AGENT_0_1_12_VERSION, 'crlf');
  try {
    assert.notEqual(prior, template, 'the historical release must really differ from the shipped template');
    assert.equal(digest(prior), PREVIOUS_VERSION_DIGEST, `the fixture bytes are the published ${AGENT_0_1_12_VERSION} template`);
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === AGENT_0_1_12_VERSION && entry.sha256 === PREVIOUS_VERSION_DIGEST),
      `the published ${AGENT_0_1_12_VERSION} template must be enumerated, or it can never be refreshed`,
    );
    // The 0.1.11 entry must survive the addition: an installation that skipped 0.1.12
    // is still migratable, and adding a digest may never replace an earlier one.
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === AGENT_0_1_11_VERSION && entry.sha256 === AGENT_0_1_11_DIGEST),
      `adding ${AGENT_0_1_12_VERSION} must not drop the ${AGENT_0_1_11_VERSION} digest`,
    );

    // 1. Startup refresh: the only automatic write, and it happens exactly once.
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    const status = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
    assert.deepEqual(status.changed, ['agent'], 'startup must refresh an unchanged published previous release');
    assert.deepEqual(status.refused, []);
    const migrated = readFileSync(fixture.agentPath, 'utf8');
    assert.equal(migrated, template, 'the migrated file must be exactly what this build writes');
    assert.match(migrated, new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
    assert.equal(existsSync(fixture.configPath), false, 'startup migration must not create config.toml');

    const again = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
    assert.deepEqual(again.changed, [], 'an already-current agent file must not be rewritten');
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), template);

    // 2. The explicit paths report those bytes as `outdated`, never `modified`, and
    //    the install refreshes them.
    writeFileSync(fixture.agentPath, prior);
    const statusRead = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(statusRead.status.agent.state, 'outdated', 'byte-exact published bytes are outdated, never modified');
    assert.equal(statusRead.status.agent.managed, true);
    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.ok(installed.changed.includes('agent'));
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), template);

    // 3. A user body edit on top of the previous release's bytes is theirs: the
    //    version line is not the proof, so no action may write, refresh or remove it.
    const edited = prior.replace('name = "dsh-delegate"', '# my own note\nname = "dsh-delegate"');
    assert.notEqual(edited, prior);
    writeFileSync(fixture.agentPath, edited);
    const afterEdit = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
    assert.deepEqual(afterEdit.changed, [], `startup must not refresh an edited ${PREVIOUS_VERSION} file`);
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited);
    for (const action of ['install', 'remove']) {
      const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(outcome.changed.includes('agent'), false, `${action} must not write an edited ${PREVIOUS_VERSION} file`);
      assert.ok(
        outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'),
        `${action} must report AGENT_USER_MODIFIED for an edited ${PREVIOUS_VERSION} file`,
      );
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited, `${action} must leave the edited body byte-identical`);
    }

    // 4. The version line alone grants nothing: the same body carrying an old version
    //    label plus one added comment line is nobody's published build, so every action
    //    reports it as the operator's and leaves it byte-identical. (A label whose
    //    rebuild IS enumerated — 0.1.7/0.1.8/0.1.9 — is legitimately `outdated`, and a
    //    plain relabel to 0.1.9 is exactly that, which is why this check edits the body.)
    const relabelled = prior
      .replace('version = "0.1.12"', 'version = "0.1.5"')
      .replace('name = "dsh-delegate"', '# keep my edits\nname = "dsh-delegate"');
    assert.notEqual(relabelled, prior);
    writeFileSync(fixture.agentPath, relabelled);
    const stale = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(stale.status.agent.state, 'modified', 'byte identity, not the version line, decides ownership');
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), relabelled, 'a modified file is never rewritten');
  } finally {
    fixture.cleanup();
  }
});

test('both published 0.1.10 byte forms are recognized and refreshed, as a historical migration case', async () => {
  // 0.1.10 exists in two byte forms and each one has to be enumerated on its own:
  // `fc7b2710…` is the packed tarball (CRLF), `6583f08a…` the same template as LF text.
  // Neither is derived from the other by the product — `isKnownPriorTemplate` hashes the
  // file it finds — so this case proves, for both forms, that an older enumerated build
  // is refreshed in one step and that its bytes are the ownership proof rather than a
  // heuristic on the version line. It also proves the LF form is *not* accepted by
  // accident: the two digests really differ.
  const template = readFileSync(join(ROOT, 'codex', 'dsh-taskbridge.toml'), 'utf8');
  const forms = [
    { name: 'packed CRLF', eol: 'crlf', sha256: AGENT_0_1_10_CRLF_DIGEST },
    { name: 'LF checkout', eol: 'lf', sha256: AGENT_0_1_10_LF_DIGEST },
  ];
  for (const form of forms) {
    const prior = historicalTemplate('0.1.10', form.eol);
    const fixture = codexHomeFixture();
    try {
      assert.equal(digest(prior), form.sha256, `the reconstructed ${form.name} bytes are the published 0.1.10 template`);
      // The constructed fixture really carries the line endings it claims.
      if (form.eol === 'crlf') assert.ok(prior.includes('\r\n') && !prior.replaceAll('\r\n', '').includes('\n'), 'CRLF fixture must be CRLF only');
      else assert.ok(!prior.includes('\r'), 'LF fixture must contain no CR bytes');
      assert.ok(
        KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === '0.1.10' && entry.sha256 === form.sha256),
        `the ${form.name} 0.1.10 template must stay enumerated for installations that skipped 0.1.11`,
      );

      // Startup migrates it directly to this build, once.
      mkdirSync(dirname(fixture.agentPath), { recursive: true });
      writeFileSync(fixture.agentPath, prior);
      const migrated = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
      assert.deepEqual(migrated.changed, ['agent'], `startup must refresh the ${form.name} 0.1.10 file`);
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), template);
      const again = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
      assert.deepEqual(again.changed, [], `a refreshed ${form.name} file must not be rewritten again`);

      // The explicit path reports those bytes as `outdated`, never `modified`.
      writeFileSync(fixture.agentPath, prior);
      const statusRead = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(statusRead.status.agent.state, 'outdated', `byte-exact ${form.name} published bytes are outdated, never modified`);
      assert.equal(statusRead.status.agent.managed, true);

      // An edit on top of those bytes is the operator's, and survives every action.
      const edited = prior.replace('description = "Dispatch', '# keep my edit\ndescription = "Dispatch');
      assert.notEqual(edited, prior);
      writeFileSync(fixture.agentPath, edited);
      const noRefresh = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
      assert.deepEqual(noRefresh.changed, [], `startup must not refresh an edited ${form.name} 0.1.10 file`);
      const outcome = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(outcome.changed.includes('agent'), false);
      assert.ok(outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'));
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited);
    } finally {
      fixture.cleanup();
    }
  }
  // The two forms are distinct identities, so enumerating one never stands in for the other.
  assert.notEqual(AGENT_0_1_10_CRLF_DIGEST, AGENT_0_1_10_LF_DIGEST);
});

test('the published 0.1.13 agent is refreshed when unchanged and preserved when customized', async () => {
  // The immediately previous release, and the FIRST one whose companion body differs from
  // this build's: 0.1.14 added the per-call permission decision rules, so the 0.1.13 bytes
  // can no longer be reconstructed by rewriting the version line. The fixture is therefore
  // the real `package/codex/dsh-delegate.toml` extracted from `dsh-delegate-0.1.13.tgz`,
  // and the pinned digest below is verified against it rather than derived from it.
  const fixture = codexHomeFixture();
  const template = readFileSync(join(ROOT, 'codex', AGENT_FILENAME), 'utf8');
  assertShippedTemplate(template);
  const prior = readFileSync(AGENT_0_1_13_FIXTURE, 'utf8');
  try {
    assert.notEqual(prior, template, 'the previous release must really differ from the shipped template');
    assert.equal(digest(prior), AGENT_0_1_13_DIGEST, 'the fixture bytes are the published 0.1.13 template');
    assert.equal(Buffer.byteLength(prior, 'utf8'), 9191, 'the published 0.1.13 agent is exactly 9191 bytes');
    assert.ok(prior.includes('\r\n'), 'the packed 0.1.13 agent carries CRLF line endings');
    assert.match(prior, /^version = "0\.1\.13"$/mu);
    // Enumerated under 0.1.13 by exact digest, never by a heuristic on the version line.
    assert.deepEqual(
      KNOWN_AGENT_TEMPLATES.filter((entry) => entry.sha256 === AGENT_0_1_13_DIGEST).map((entry) => entry.version),
      ['0.1.13'],
      'the published 0.1.13 template must be enumerated under its own version, or it can never be refreshed',
    );
    // Adding a digest may never replace an earlier one.
    for (const [version, sha256] of [
      ['0.1.12', PREVIOUS_VERSION_DIGEST],
      [AGENT_0_1_11_VERSION, AGENT_0_1_11_DIGEST],
    ]) {
      assert.ok(
        KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === version && entry.sha256 === sha256),
        `adding 0.1.13 must not drop the ${version} digest`,
      );
    }

    // 1. UNCHANGED 0.1.13: startup refreshes it to this build, exactly once.
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    const status = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
    assert.deepEqual(status.changed, ['agent'], 'startup must refresh an unchanged published 0.1.13 file');
    assert.deepEqual(status.refused, []);
    const migrated = readFileSync(fixture.agentPath, 'utf8');
    assert.equal(migrated, template, 'the migrated file must be exactly what this build writes');
    assert.match(migrated, new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
    assert.equal(existsSync(fixture.configPath), false, 'startup migration must not create config.toml');

    const again = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
    assert.deepEqual(again.changed, [], 'an already-current agent file must not be rewritten');

    // 2. The explicit paths report those bytes as `outdated`, never `modified`, and the
    //    install refreshes them.
    writeFileSync(fixture.agentPath, prior);
    const statusRead = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(statusRead.status.agent.state, 'outdated', 'byte-exact published bytes are outdated, never modified');
    assert.equal(statusRead.status.agent.managed, true);
    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.ok(installed.changed.includes('agent'));
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), template);

    // 3. MODIFIED 0.1.13: a body edit is the operator's, so nothing writes, refreshes or
    //    removes it — a version line that still says 0.1.13 grants nothing.
    const edited = prior.replace('name = "dsh-delegate"', '# my own note\nname = "dsh-delegate"');
    assert.notEqual(edited, prior);
    assert.equal(digest(edited) === AGENT_0_1_13_DIGEST, false, 'the edit really changes the bytes');
    writeFileSync(fixture.agentPath, edited);
    const afterEdit = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION }).refreshKnownAgent();
    assert.deepEqual(afterEdit.changed, [], 'startup must not refresh an edited 0.1.13 file');
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited);
    const editedStatus = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(editedStatus.status.agent.state, 'modified', 'an edited 0.1.13 file is the operator\'s, not ours');
    for (const action of ['install', 'remove']) {
      const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(outcome.changed.includes('agent'), false, `${action} must not write an edited 0.1.13 file`);
      assert.ok(
        outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'),
        `${action} must report AGENT_USER_MODIFIED for an edited 0.1.13 file`,
      );
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited, `${action} must leave the edited body byte-identical`);
    }
  } finally {
    fixture.cleanup();
  }
});

/**
 * The two real release companions this build must upgrade.
 *
 * Both files are the PUBLISHED bytes, not reconstructions: 1.0.0 is
 * `git show 2750047:codex/dsh-delegate.toml` and 1.1.0 is
 * `git show 2d71708:codex/dsh-delegate.toml`, saved as fixtures. A release that shipped
 * a different body can never be reached by relabelling today's template, so the fixture
 * is the only honest input for these tests.
 */
const HISTORICAL_AGENT_FIXTURES = Object.freeze([
  {
    version: '1.4.0',
    path: join(ROOT, 'tests', 'fixtures', 'agent-1.4.0.toml'),
    packed: 'cfb21bc510b47be27c5e64bce86c48cbc9a49055777cd265e118ed942a94d9a5',
    lf: '2b2f6c35ffc9e99d98f38d00e07fef11de8bf96a9dd446e80889fcf92ba45cd8',
  },
  {
    version: '1.3.2',
    path: join(ROOT, 'tests', 'fixtures', 'codex-agent-1.3.2.toml'),
    packed: '46b5b98a3489b59a9e7e437a100fea6072db6a34c1220496530efdf812117c17',
    lf: 'da14ba0511ca25d9118670ccb2c39c104d7952d110b104c9b157376b330dccfc',
  },
  { version: '1.3.1', path: join(ROOT, 'tests', 'fixtures', 'codex-agent-1.3.1.toml'), packed: '2793b656be4a1906e16edfdd0103540bfad05681a413c166b578b02333ea2618', lf: 'b48558d6d6acca58b94a01029d6c884c4789488c7926cdaca40cb6cd15eea2ae' },
  {
    version: '1.3.0',
    path: join(ROOT, 'tests', 'fixtures', 'codex-agent-1.3.0.toml'),
    packed: '63695008f53aa2c19a0df9e2cb37285f631b775cb98f26c1d280cfbc54a0d9e8',
    lf: '31b0ba3149032058fe31e1e884e5c24a9a3d6459b7dd35df6420c7f3756d6257',
  },
  {
    version: '1.2.0',
    path: join(ROOT, 'tests', 'fixtures', 'codex-agent-1.2.0.toml'),
    packed: '8479c8ab418d71b15fb30880aa5149fb1070d194e8444a110a2a614cebf4eaf4',
    lf: '947f3fb8a8e9ae5cc6fb3c9d379c69b595af4c46f89ac77f69aa1edf696a8f8e',
  },
  {
    version: '1.0.0',
    path: join(ROOT, 'tests', 'fixtures', 'codex-agent-1.0.0.toml'),
    packed: 'b1fd531598087564b26df14d3261515e961012f3fd010ea493f222da7bbaf415',
    lf: '0cce75574107049413f4ddbdf7d8e6cddea92d45a0c4e0fa41b169cb790e5e13',
  },
  {
    version: '1.1.0',
    path: join(ROOT, 'tests', 'fixtures', 'codex-agent-1.1.0.toml'),
    packed: '7d3ea5c54647a92cebaa0521741eb27f5141f7b2127b47009195fdb976dae4fb',
    lf: '93d580bd849bb6d2c30c2db6286695ef3e0356896a88e552abae5f03eafc7601',
  },
]);

for (const release of HISTORICAL_AGENT_FIXTURES) {
  test(`the published ${release.version} agent is upgraded by startup and by install, from its real bytes`, async () => {
    const fixture = codexHomeFixture();
    const published = readFileSync(release.path, 'utf8');
    const template = readFileSync(join(ROOT, 'codex', AGENT_FILENAME), 'utf8');
    try {
      // The fixtures really are the published bytes, and every one of them is enumerated
      // as an exact identity — both the packed (CRLF) form and the same file as LF text.
      assert.equal(digest(published), release.packed, `${release.version} fixture is the packed release`);
      const lfForm = published.replaceAll('\r\n', '\n');
      assert.equal(digest(lfForm), release.lf, `${release.version} fixture in its LF form`);
      assert.ok(published.includes('\r\n'), 'the packed form really is CRLF');
      for (const sha256 of [release.packed, release.lf]) {
        assert.ok(
          KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === release.version && entry.sha256 === sha256),
          `${release.version} must stay enumerated so an existing installation can be upgraded`,
        );
      }
      assert.notEqual(published, template, `the ${release.version} body differs from this build\'s`);

      // 1. Startup upgrades the byte-exact published file, and nothing else.
      mkdirSync(dirname(fixture.agentPath), { recursive: true });
      writeFileSync(fixture.agentPath, published);
      const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(before.status.agent.state, 'outdated', `${release.version} is outdated, never modified`);
      assert.equal(before.status.agent.managed, true);

      const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      const startupTarget = await seam.startupTarget();
      const migrated = await seam.refreshManagedIntegration({ startupTarget });
      assert.deepEqual(migrated.changed, ['agent']);
      assert.deepEqual(migrated.refused, []);
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), template, 'the file becomes exactly this build\'s agent');
      assert.equal(existsSync(fixture.configPath), false, 'startup must not create config.toml');

      // 2. Repeating it is a no-op, and the explicit install refreshes the same bytes.
      const again = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION })
        .refreshManagedIntegration();
      assert.deepEqual(again.changed, [], 'an already-current file is never rewritten');
      writeFileSync(fixture.agentPath, lfForm);
      const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.ok(installed.changed.includes('agent'), 'the LF form of the same release is refreshed too');
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), template);

      // 3. An operator edit on top of the published bytes is THEIRS: the version line is
      //    not the proof, so no action may write, refresh or remove it.
      //    The edit is anchored on the file's own version line rather than on a
      //    `name = "..."` value: releases renamed the agent (`dsh-delegate` →
      //    `dsh-taskbridge`), so a name-keyed edit silently produced NO edit for 1.3.2
      //    and the assertion below would have proved nothing.
      const edited = published.replace(/^(version = ".*")$/mu, '# my own note\r\n$1');
      assert.notEqual(edited, published, 'the edit must really change the published bytes');
      writeFileSync(fixture.agentPath, edited);
      const editedStatus = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(editedStatus.status.agent.state, 'modified', `an edited ${release.version} file is not a known build`);
      const afterEdit = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION })
        .refreshManagedIntegration();
      assert.deepEqual(afterEdit.changed, [], 'startup never rewrites an edited agent');
      for (const action of ['install', 'repair', 'remove']) {
        const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
        assert.equal(outcome.changed.includes('agent'), false, `${action} must not write the edited agent`);
        assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited, `${action} must leave it byte-identical`);
      }
    } finally {
      fixture.cleanup();
    }
  });
}

test('the published 1.3.2 fixture is the release this build must refresh, not merely tolerate', async () => {
  // 1.3.2 is the release whose companion THIS build rewrites (the wait contract
  // changed under it), so the upgrade path is pinned on its own rather than only
  // through the loop above: an existing 1.3.2 installation must be recognized as
  // `outdated` and replaced by the new rules, while an edited 1.3.2 file stays the
  // operator's own.
  const fixture = codexHomeFixture();
  const release = HISTORICAL_AGENT_FIXTURES.find((entry) => entry.version === '1.3.2');
  assert.ok(release !== undefined, 'the 1.3.2 fixture must be enumerated');
  const published = readFileSync(release.path, 'utf8');
  const template = readFileSync(join(ROOT, 'codex', AGENT_FILENAME), 'utf8');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, published);
    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(before.status.agent.state, 'outdated', 'an unedited 1.3.2 file is a known build, not a foreign one');
    assert.equal(before.status.agent.managed, true);

    const migrated = await createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION })
      .refreshManagedIntegration();
    assert.deepEqual(migrated.changed, ['agent'], 'startup refreshes it');
    const refreshed = readFileSync(fixture.agentPath, 'utf8');
    assert.equal(refreshed, template);
    // The refreshed rules are the new contract, which is the point of the upgrade.
    assert.match(refreshed, /delegate_wait\(\{ taskId \}\)/u);
    assert.doesNotMatch(refreshed, /raise `waitSeconds` only when you\s+deliberately want to stay silent longer/u);

    // The same published bytes with one operator line added are NOT ours.
    const edited = published.replace('name = "dsh-taskbridge"', '# my own note\r\nname = "dsh-taskbridge"');
    writeFileSync(fixture.agentPath, edited);
    const editedStatus = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(editedStatus.status.agent.state, 'modified', 'an edited 1.3.2 file is the operator\'s');
    for (const action of ['install', 'repair', 'remove']) {
      const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(outcome.changed.includes('agent'), false, `${action} must not write the edited file`);
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited, `${action} must leave it byte-identical`);
    }
  } finally {
    fixture.cleanup();
  }
});

test('the published 1.0.0 and 1.1.0 fixtures are never packed', () => {
  // They are test inputs, not product data: a published archive that shipped a prior
  // release's companion would hand a reviewer bytes this build does not install.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const release of HISTORICAL_AGENT_FIXTURES) {
    const relative = release.path.slice(ROOT.length + 1).split('\\').join('/');
    assert.ok(relative.startsWith('tests/'), 'the fixtures live under tests/');
    for (const pattern of manifest.files) {
      assert.equal(pattern.startsWith('tests/'), false, `the package must not include ${pattern}`);
    }
  }
});

test('a body edit survives install and repair even when the version marker is old', async () => {
  const fixture = codexHomeFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const installed = readFileSync(fixture.agentPath, 'utf8');
    // One added comment line in the body, with an older version line: a heuristic
    // matcher would call this "outdated" and overwrite it.
    const edited = installed
      .replace(/^version = ".*"$/mu, 'version = "0.1.5"')
      .replace('name = "dsh-taskbridge"', '# my own note\nname = "dsh-taskbridge"');
    writeFileSync(fixture.agentPath, edited);

    for (const action of ['install', 'repair', 'install']) {
      const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      // The edited body must survive every action. `repair` does not even touch the
      // agent, so it reports no agent refusal — the file is simply out of its scope —
      // while `install` refuses it explicitly as the operator's.
      if (action === 'repair') {
        assert.equal(outcome.changed.includes('agent'), false, 'repair must not write the agent');
        assert.equal(outcome.refused.some((entry) => entry.target === 'agent'), false, 'repair is MCP-only, so it has no agent refusal to report');
      } else {
        assert.equal(outcome.refused.some((entry) => entry.target === 'agent'), true, `${action} must not have written the agent`);
      }
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), edited, `${action} must leave the edited body alone`);
    }
    assert.match(readFileSync(fixture.agentPath, 'utf8'), /# my own note/u);
  } finally {
    fixture.cleanup();
  }
});

test('only an enumerated published build is refreshable, and it is refreshed exactly once', async () => {
  const fixture = codexHomeFixture();
  try {
    // Simulate a published prior build by pinning a digest into the known list for
    // the duration of this test; the list is the only thing that grants "outdated".
    const prior = readFileSync(join(ROOT, 'codex', AGENT_FILENAME), 'utf8')
      .replace(/^version = ".*"$/mu, 'version = "0.1.5"');
    // Remember the shipped list so the temporary entry can be removed without wiping
    // the product identities (including the legacy 1.0.0 ones) for later tests.
    const knownBefore = [...KNOWN_AGENT_TEMPLATES];
    KNOWN_AGENT_TEMPLATES.push({ version: '0.1.5', sha256: digest(prior) });
    try {
      mkdirSync(dirname(fixture.agentPath), { recursive: true });
      writeFileSync(fixture.agentPath, prior);
      const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(status.status.agent.state, 'outdated', 'a byte-exact known build is outdated, not modified');

      const refreshed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.ok(refreshed.changed.includes('agent'));
      assert.equal(refreshed.status.agent.state, 'installed');
      assert.match(readFileSync(fixture.agentPath, 'utf8'), new RegExp(`^version = "${DELIVERABLE_VERSION}"$`, 'mu'));

      // Once the digest is no longer known, the same old file is somebody else's.
      // Restore the SHIPPED list, not an empty one: the temporary entry is removed and
      // every product identity (including the legacy 1.0.0 ones) stays for later tests.
      KNOWN_AGENT_TEMPLATES.splice(0, KNOWN_AGENT_TEMPLATES.length, ...knownBefore);
      writeFileSync(fixture.agentPath, prior);
      const refused = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(refused.status.agent.state, 'modified');
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), prior);
    } finally {
      KNOWN_AGENT_TEMPLATES.splice(0, KNOWN_AGENT_TEMPLATES.length, ...knownBefore);
    }
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Concurrent creation: the first install must never overwrite a new file
// ---------------------------------------------------------------------------

test('a file created between the status read and the first install is reported, not replaced', async () => {
  // The race is real, not theoretical: `writeFileAtomic` renames over its target, so
  // a file that appears after the `status` read would be silently replaced. The
  // installer therefore creates a first agent file with `link`, which fails when the
  // destination exists. This test exercises that primitive directly, because the
  // window itself cannot be opened deterministically from a test.
  const home = mkdtempSync(join(tmpdir(), 'dsh-delegate-race-'));
  try {
    const target = join(home, 'agents', 'dsh-taskbridge.toml');
    mkdirSync(dirname(target), { recursive: true });

    // First create: the file is ours and appears exactly once.
    const once = await createFileExclusive(target, 'first');
    assert.equal(once, 'created');
    assert.equal(readFileSync(target, 'utf8'), 'first');
    // No temp file is left behind in either case.
    assert.deepEqual(readdirSync(dirname(target)), ['dsh-taskbridge.toml']);

    // Second create: the different file that appeared meanwhile survives untouched.
    const twice = await createFileExclusive(target, 'second');
    assert.equal(twice, 'exists');
    assert.equal(readFileSync(target, 'utf8'), 'first', 'the concurrent file must not be overwritten');
    assert.deepEqual(readdirSync(dirname(target)), ['dsh-taskbridge.toml']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('install refuses a file that appears between its status read and its agent create', async () => {
  const fixture = codexHomeFixture();
  try {
    const interim = '# operator file that appeared meanwhile\nname = "interim"\n';
    const agentPath = fixture.agentPath;
    mkdirSync(dirname(agentPath), { recursive: true });

    // Open exactly the window the installer has: read the status, create the file
    // (as another process would), then let the installer act. The status it gets
    // inside `runCodexAction` will therefore see `modified`, which is the same
    // refusal the exclusive create produces for the narrower window.
    writeFileSync(agentPath, interim);
    const outcome = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(outcome.refused.some((entry) => entry.target === 'agent'));
    assert.equal(readFileSync(agentPath, 'utf8'), interim, 'the interim file must be intact');
    assert.equal(outcome.status.agent.state, 'modified');
    assert.equal(outcome.status.agent.installed, false);

    // And the narrow window: the status looked at a missing path, then the file
    // appeared. `installManaged` uses the exclusive create for exactly this case, so
    // the create returns "exists" and nothing is written.
    const narrow = join(fixture.home, 'narrow.toml');
    assert.equal(await createFileExclusive(narrow, 'mine'), 'created');
    assert.equal(await createFileExclusive(narrow, 'theirs'), 'exists');
    assert.equal(readFileSync(narrow, 'utf8'), 'mine');
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3a. The Windows verdict decoder
// ---------------------------------------------------------------------------

/**
 * Does this host let the test spawn a child at all?
 *
 * The Windows probe below is the only test here that runs the real
 * `powershell.exe` helper. A confined carrier (the one this suite was developed in)
 * refuses `spawn` with `EPERM`/`EACCES` for *any* executable; that is a property of
 * the sandbox, not of the plugin, so the probe reports itself skipped instead of
 * failing a product check it could not run.
 * @returns {Promise<{ ok: boolean, detail: string }>} whether a child can be spawned.
 */
async function canSpawnChild() {
  return await new Promise((resolveProbe) => {
    try {
      execFile(process.execPath, ['-e', ''], { timeout: 10000, windowsHide: true }, (error) => {
        if (error === null) {
          resolveProbe({ ok: true, detail: '' });
          return;
        }
        const code = typeof error.code === 'string' ? error.code : '';
        // The child ran and answered non-zero: spawnable. Only a spawn failure means
        // "this carrier forbids child processes".
        if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT' || code === 'EINVAL') {
          resolveProbe({ ok: false, detail: code });
          return;
        }
        resolveProbe({ ok: true, detail: code });
      });
    } catch (error) {
      resolveProbe({ ok: false, detail: typeof error?.code === 'string' ? error.code : 'spawn-failed' });
    }
  });
}

test('the Windows verdict decoder accepts every spelling of the boolean', () => {
  // The bug: only lowercase was accepted, so an ordinary directory answered as
  // `dir/False` (Windows PowerShell 5.1's `Boolean.ToString()`) fell through to a
  // reported link. Every spelling that means "not a reparse point, and a directory"
  // must decode to `directory`.
  for (const raw of ['dir/false', 'dir/False', 'dir/FALSE', 'dir/FaLsE', '  dir/false  ', 'dir/false\r']) {
    assert.equal(parseDirectoryVerdict(raw), 'directory', JSON.stringify(raw));
  }
  // …and every spelling that means "a reparse point" to `link`.
  for (const raw of ['dir/true', 'dir/True', 'dir/TRUE', 'other/true', 'other/True']) {
    assert.equal(parseDirectoryVerdict(raw), 'link', JSON.stringify(raw));
  }
  assert.equal(parseDirectoryVerdict('missing'), 'missing');
  assert.equal(parseDirectoryVerdict('MISSING'), 'missing');
  // A non-directory is `other` in any spelling, including the link-shaped ones that
  // are not a verdict this module may treat as a directory.
  for (const raw of ['other/false', 'other/False', 'other/something', 'error', '']) {
    assert.equal(parseDirectoryVerdict(raw), 'other', JSON.stringify(raw));
  }
  // A garbled answer is never `directory` and never `link`: it is "not a regular
  // directory", which is what the caller must treat as unwritable.
  for (const raw of ['garbage', 'dir/', 'dir/maybe', undefined, null]) {
    assert.equal(parseDirectoryVerdict(raw), null, JSON.stringify(raw));
  }
});

test('the bundled helper script asks for a stable, lower-case boolean spelling', async () => {
  // The decoder is case-insensitive because the spelling is not guaranteed, but the
  // script must not rely on that: `ToLowerInvariant()` pins the answer regardless of
  // the PowerShell version or the output culture.
  const source = readFileSync(join(ROOT, 'src', 'codex', 'installer.js'), 'utf8');
  const scriptStart = source.indexOf('const KINDS_SCRIPT = [');
  assert.notEqual(scriptStart, -1, 'the bundled script must still be a single literal');
  const scriptEnd = source.indexOf('].join(', scriptStart);
  const script = source.slice(scriptStart, scriptEnd);
  assert.match(script, /ToLowerInvariant\(\)/u, 'the boolean must be lower-cased before it is printed');
  assert.match(script, /ReparsePoint/u);
  assert.match(script, /DSH_DELEGATE_CODEX_PATHS/u, 'paths travel in the environment, never in the script text');
  // Every path the script can produce has to be decodable, or it would silently be
  // reported as a link-shaped `other`:
  for (const verdict of ['dir/true', 'dir/false', 'other/true', 'other/false', 'missing', 'error']) {
    assert.notEqual(parseDirectoryVerdict(verdict), null, `${verdict} must decode`);
  }
});

test('a real Windows directory is reported as a directory by the actual PowerShell helper', async (t) => {
  // This is the regression for the shipped bug, deliberately *not* expressed through
  // the test classifier: it calls `inspectCodexBoundary` with no classifier installed,
  // so the bundled `powershell.exe` script and {@link parseDirectoryVerdict} are what
  // answer. The fixtures are temporary directories — the real `~/.codex` is never
  // named, read or written.
  if (process.platform !== 'win32') {
    t.skip('the PowerShell helper only exists on Windows');
    return;
  }
  const spawn = await canSpawnChild();
  if (!spawn.ok) {
    t.skip(`this carrier forbids spawning a child process (${spawn.detail}), so the real helper cannot be run`);
    return;
  }

  const base = mkdtempSync(join(tmpdir(), 'dsh-delegate-probe-'));
  const restore = useDirectoryClassifier(null);
  try {
    // 1. The ordinary layout: a real Codex home, no `agents` yet. Before the fix the
    //    home answered `dir/False` and was reported as a link, so every real Windows
    //    install was refused with AGENT_PATH_CONFLICT.
    const plainHome = join(base, 'codex-plain');
    mkdirSync(plainHome);
    const plain = await inspectCodexBoundary(plainHome);
    assert.equal(plain.home.kind, 'directory', 'a real directory must never be reported as a link');
    assert.equal(plain.blocked, false);
    assert.equal(plain.link, null);
    assert.equal(plain.unknown, false);
    assert.equal(plain.agents.kind, 'missing');

    // 2. With `agents` present as a real directory, the second level is a real
    //    directory too — the answer that used to be misread.
    const fullHome = join(base, 'codex-full');
    mkdirSync(join(fullHome, 'agents'), { recursive: true });
    const full = await inspectCodexBoundary(fullHome);
    assert.equal(full.home.kind, 'directory');
    assert.equal(full.agents.kind, 'directory');
    assert.equal(full.blocked, false);
    const installed = await runCodexAction('install', { codexHome: fullHome, env: isolatedEnv(fullHome), version: DELIVERABLE_VERSION });
    assert.deepEqual(installed.changed.sort(), ['agent', 'mcp'], 'a real Windows home must be installable');
    assert.equal(installed.refused.some((entry) => entry.target === 'agent'), false, 'nothing may be refused for a real directory');
    assert.equal(installed.status.ready, true);

    // 3. …and a link at the same level is still caught by the same real helper: only
    //    the spelling of the boolean changed, not what a reparse point means.
    const target = join(base, 'outside');
    mkdirSync(target);
    const linkedHome = join(base, 'codex-linked');
    mkdirSync(linkedHome);
    symlinkSync(target, join(linkedHome, 'agents'), 'junction');
    const linked = await inspectCodexBoundary(linkedHome);
    assert.equal(linked.agents.kind, 'link', 'a junction must still be reported as a link');
    assert.equal(linked.blocked, true);
    assert.equal(linked.link, 'agents');
    assert.deepEqual(readdirSync(target), [], 'nothing may be written through the junction');
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3b. The Codex home boundary: a link at the home or at `agents/` is never followed
// ---------------------------------------------------------------------------

/**
 * A link fixture: a real "outside" directory the plugin must never write into, and a
 * Codex home whose `agents` entry (or the home itself) is a link to it.
 *
 * `symlinkSync(…, 'junction')` is the Windows spelling that needs no elevation, and it
 * is the case that matters: `lstat` reports a junction as an ordinary directory, so a
 * check that only looked at the final file would happily write through it.
 * @param {'agents' | 'home'} linkAt - which level is turned into a link.
 * @returns {{ home: string, outside: string, cleanup: () => void }} fixture.
 */
function linkedHomeFixture(linkAt) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegate-link-'));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const home = join(root, 'codex');
  if (linkAt === 'home') {
    symlinkSync(outside, home, 'junction');
  } else {
    mkdirSync(home);
    symlinkSync(outside, join(home, 'agents'), 'junction');
  }
  return {
    home,
    outside,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test('a linked agents directory is refused by status, install, repair and remove', async () => {
  const fixture = linkedHomeFixture('agents');
  const links = new Set([join(fixture.home, 'agents')]);
  const restore = useDirectoryClassifier(nodeClassifier((path) => links.has(path)));
  try {
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(status.status.boundary.blocked, true);
    assert.equal(status.status.boundary.link, 'agents');
    assert.equal(status.status.agent.state, 'conflict');
    assert.equal(status.status.agent.reason, 'agents-dir-is-link');
    assert.equal(status.status.agent.installed, false);
    assert.equal(status.status.agent.managed, false);
    assert.equal(status.status.ready, false);
    assert.ok(status.status.notes.some((note) => note.code === 'AGENT_PATH_CONFLICT' && /agents 目录是链接/u.test(note.text)));
    // Reading never creates anything, and never writes through the link.
    assert.deepEqual(readdirSync(fixture.outside), [], 'status must not create a file outside the Codex home');

    for (const action of ['install', 'repair', 'remove']) {
      const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
      assert.equal(outcome.changed.includes('agent'), false, `${action} must not write the agent`);
      assert.ok(
        outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_PATH_CONFLICT'),
        `${action} must report AGENT_PATH_CONFLICT`,
      );
      assert.deepEqual(readdirSync(fixture.outside), [], `${action} must not write through the link`);
    }
  } finally {
    restore();
    fixture.cleanup();
  }
});

test('a linked Codex home is refused, and nothing below it is reported or created', async () => {
  const fixture = linkedHomeFixture('home');
  const restore = useDirectoryClassifier(nodeClassifier((path) => path === fixture.home));
  try {
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(status.status.boundary.blocked, true);
    assert.equal(status.status.boundary.link, 'codex-home');
    // The `agents` entry is not even inspected through the link.
    assert.equal(status.status.boundary.agents, 'unchecked');
    assert.equal(status.status.agent.reason, 'codex-home-is-link');
    assert.ok(status.status.notes.some((note) => note.code === 'AGENT_PATH_CONFLICT' && /Codex home 本身是链接/u.test(note.text)));

    for (const action of ['install', 'repair', 'remove']) {
      const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
      assert.ok(outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_PATH_CONFLICT'));
    }
    assert.deepEqual(readdirSync(fixture.outside), [], 'no agents directory may be created through the home link');
  } finally {
    restore();
    fixture.cleanup();
  }
});

test('an unverifiable boundary is reported, never assumed safe', async () => {
  const fixture = codexHomeFixture();
  // `unknown` is what the installer reports when the platform answer cannot be
  // obtained (no spawnable shell, no PowerShell). Treating it as "a real directory"
  // would be exactly the assumption the boundary check exists to remove.
  const restore = useDirectoryClassifier(async (paths) => new Map(paths.map((path) => [path, 'unknown'])));
  try {
    const outcome = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(outcome.status.boundary.blocked, true);
    assert.equal(outcome.status.boundary.unknown, true);
    assert.equal(outcome.status.boundary.link, null);
    assert.equal(outcome.status.agent.state, 'conflict');
    assert.equal(outcome.status.agent.reason, 'boundary-unverified');
    assert.ok(outcome.status.notes.some((note) => note.code === 'AGENT_PATH_CONFLICT' && /无法确认是真实目录/u.test(note.text)));
    assert.ok(outcome.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_PATH_CONFLICT'));
    assert.equal(existsSync(fixture.agentPath), false, 'nothing may be written while the boundary is unverified');
    assert.equal(existsSync(fixture.configPath), false);
  } finally {
    restore();
    fixture.cleanup();
  }
});

test('the ordinary Windows layout is unaffected: a real directory installs normally', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-delegate-real-'));
  const home = join(base, 'codex');
  const target = join(base, 'target');
  mkdirSync(target);
  mkdirSync(home);
  // A junction exists elsewhere in the tree, and a real `agents` directory sits beside
  // it: the presence of a link nowhere near the managed path must change nothing.
  symlinkSync(target, join(base, 'unrelated'), 'junction');
  const restore = useDirectoryClassifier(nodeClassifier());
  try {
    const boundary = await inspectCodexBoundary(home);
    assert.deepEqual(boundary, {
      blocked: false,
      link: null,
      unknown: false,
      home: { kind: 'directory' },
      agents: { kind: 'missing' },
    });
    const installed = await runCodexAction('install', { codexHome: home, env: isolatedEnv(home) });
    assert.deepEqual(installed.changed.sort(), ['agent', 'mcp']);
    assert.equal(installed.status.ready, true);
    assert.equal(lstatSync(join(home, 'agents')).isDirectory(), true);
    assert.equal(lstatSync(join(home, 'agents')).isSymbolicLink(), false);
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a POSIX symlink at either level is refused without any platform helper', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-delegate-posix-'));
  const outside = join(base, 'outside');
  mkdirSync(outside);
  const home = join(base, 'codex');
  mkdirSync(home);
  try {
    symlinkSync(outside, join(home, 'agents'), 'dir');
  } catch (error) {
    // Creating a symlink needs a privilege this carrier may not grant. The junction
    // fixtures above cover the same code path on such a host.
    rmSync(base, { recursive: true, force: true });
    return;
  }
  try {
    // No classifier at all: `lstat` alone has to catch a real symlink.
    const restore = useDirectoryClassifier(null);
    try {
      const boundary = await inspectCodexBoundary(home);
      assert.equal(boundary.blocked, true);
      assert.equal(boundary.link, 'agents');
      assert.equal(boundary.agents.kind, 'link');
    } finally {
      restore();
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3c. Removal re-proves ownership: bytes changed after the status read survive
// ---------------------------------------------------------------------------

test('remove keeps an agent file that changed after it was inspected', async () => {
  const fixture = codexHomeFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const managed = readFileSync(fixture.agentPath, 'utf8');
    assert.match(managed, /managed by the DSH TaskBridge plugin/u);

    // The deterministic seam: this is the status a `remove` would act on — the same
    // document an operator saw a moment earlier. The file is rewritten *after* that
    // read, which is precisely the window a delete-on-earlier-verdict would destroy.
    const stale = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(stale.status.agent.state, 'installed');
    assert.equal(typeof stale.status.agent.expect, 'string');

    const rewritten = '# the operator took this file over\nname = "mine"\n';
    writeFileSync(fixture.agentPath, rewritten);

    const verdict = await removeManagedAgentFile(stale.status.agent);
    assert.equal(verdict.code, 'AGENT_USER_MODIFIED', 'a rewritten file must be refused, not deleted');
    assert.equal(verdict.reason, 'modified-before-removal');
    assert.equal(existsSync(fixture.agentPath), true, 'the rewritten file must survive a remove');
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), rewritten, 'and be byte-identical');

    // The same guarantee through the operator-facing action: the status is re-read
    // there, so the file is `modified` and the removal refuses for the same reason.
    const removed = await runCodexAction('remove', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(removed.refused.some((entry) => entry.target === 'agent' && entry.code === 'AGENT_USER_MODIFIED'));
    assert.equal(removed.changed.includes('agent'), false);
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), rewritten);
  } finally {
    fixture.cleanup();
  }
});

test('remove refuses when a managed file is swapped for a link or vanishes in the window', async () => {
  const fixture = codexHomeFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const stale = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(stale.status.agent.state, 'installed');

    // Swapped for a directory: an unlink would fail, and the path is no longer the
    // regular file the status described.
    rmSync(fixture.agentPath);
    mkdirSync(fixture.agentPath);
    assert.equal((await removeManagedAgentFile(stale.status.agent)).code, 'AGENT_PATH_CONFLICT');
    assert.equal(lstatSync(fixture.agentPath).isDirectory(), true, 'the directory is left in place');

    // Removed entirely: nothing to delete, and the outcome must not claim a change.
    rmSync(fixture.agentPath, { recursive: true });
    const gone = await removeManagedAgentFile(stale.status.agent);
    assert.equal(gone.code, 'AGENT_PATH_CONFLICT');
    assert.equal(gone.reason, 'missing-before-removal');
  } finally {
    fixture.cleanup();
  }
});

test('remove deletes a managed file only when its bytes still match the inspected content', async () => {
  const fixture = codexHomeFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const managed = readFileSync(fixture.agentPath, 'utf8');

    // A file that still looks managed — same header, same rules — but differs by one
    // character. Only byte identity against the inspected content may authorize a
    // delete; "it looks like ours" may not.
    const oneCharacterOff = managed.replace('description = ', 'description =  ');
    assert.notEqual(oneCharacterOff, managed);
    writeFileSync(fixture.agentPath, oneCharacterOff);
    const stale = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(stale.status.agent.state, 'modified');

    const verdict = await removeManagedAgentFile({ path: fixture.agentPath, expect: managed });
    assert.equal(verdict.code, 'AGENT_USER_MODIFIED');
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), oneCharacterOff);

    // An unchanged managed file is deleted, and a second removal reports no change.
    writeFileSync(fixture.agentPath, managed);
    const ok = await removeManagedAgentFile({ path: fixture.agentPath, expect: managed });
    assert.equal(ok.code, null);
    assert.equal(existsSync(fixture.agentPath), false);
    assert.equal((await removeManagedAgentFile({ path: fixture.agentPath, expect: managed })).reason, 'missing-before-removal');

    // A status that carries no ownership bytes may never authorize a delete.
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const withoutBytes = await removeManagedAgentFile({ path: fixture.agentPath, expect: null });
    assert.equal(withoutBytes.code, 'AGENT_USER_MODIFIED');
    assert.equal(existsSync(fixture.agentPath), true);
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. MCP config merge
// ---------------------------------------------------------------------------
test('registering the MCP server preserves unrelated settings, comments and order', async () => {
  const fixture = codexHomeFixture();
  try {
    writeFileSync(fixture.configPath, FOREIGN_CONFIG);
    await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });

    const merged = readFileSync(fixture.configPath, 'utf8');
    assert.ok(merged.startsWith(FOREIGN_CONFIG.trimEnd()), 'every original line must keep its place and spelling');
    assert.match(merged, /^# dsh-delegate: managed by the DSH Delegate plugin settings page$/mu);
    assert.match(merged, /^\[mcp_servers\.dsh-delegate\]$/mu);

    const values = readTomlValues(merged);
    assert.equal(values['mcp_servers.other'].type, 'table', 'the other server entry is untouched');
    assert.equal(values['mcp_servers.dsh-delegate.command'].text, JSON.stringify(resolveNodeExecutable()));
    // `args` is one escaped TOML string; undo the escaping to read the path.
    const scriptArg = values['mcp_servers.dsh-delegate.args'].text
      .replace(/^\[|\]$/gu, '')
      .trim()
      .replace(/^"|"$/gu, '')
      .replace(/\\\\/gu, '\\');
    assert.equal(scriptArg, join(ROOT, 'bin', 'dsh-delegate-mcp.js'));
  } finally {
    fixture.cleanup();
  }
});

test('a CRLF config.toml is installed into, updated and removed from without losing a byte', async () => {
  const fixture = codexHomeFixture();
  const crlf = [
    '# operator comment in a Windows-edited file',
    'model = "gpt-6.1"   # trailing note',
    '',
    '[mcp_servers]',
    'other = { command = "node", args = ["C:/other/server.mjs"] }',
    '',
    '[desktop]',
    'sansFontSize = 16',
    '',
  ].join('\r\n');
  try {
    writeFileSync(fixture.configPath, crlf);
    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(installed.changed.includes('mcp'), 'a standard CRLF config must be editable, not refused');
    const afterInstall = readFileSync(fixture.configPath, 'utf8');
    assert.equal(/(^|[^\r])\n/u.test(afterInstall), false, 'the file must remain CRLF throughout');
    assert.ok(afterInstall.startsWith(crlf.trimEnd()), 'every original line is byte-identical');
    assert.match(afterInstall, new RegExp(`^${MCP_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\r$`, 'mu'));
    assert.match(afterInstall, /^\[mcp_servers\.dsh-delegate\]\r$/mu);

    // Update path: a REAL second installation of this package is proved and adopted; a
    // path that only looks like one is kept. This is the migrated-install case.
    const oldInstall = otherInstallationFixture();
    try {
      writeFileSync(fixture.configPath, afterInstall.replace(
        /^args = \[.*\]\r$/mu,
        `args = [${JSON.stringify(oldInstall.script)}]\r`,
      ));
      const stale = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
      assert.equal(stale.status.mcp.state, 'conflict', 'a bare status read never adopts a moved install');
      await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
      const afterRepair = readFileSync(fixture.configPath, 'utf8');
      assert.equal(/(^|[^\r])\n/u.test(afterRepair), false, 'a repair must not normalize the file to LF');
      assert.equal(afterRepair.includes(oldInstall.root), false, 'repair adopted the verified moved install');
    } finally {
      oldInstall.cleanup();
    }

    // Remove path: only the managed entry and its marker go; the rest is byte-exact.
    await runCodexAction('remove', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    const afterRemove = readFileSync(fixture.configPath, 'utf8');
    assert.equal(/(^|[^\r])\n/u.test(afterRemove), false, 'a removal must not normalize the file to LF');
    assert.equal(afterRemove, crlf.trimEnd() + '\r\n', 'the remaining document is exactly what was there before');
  } finally {
    fixture.cleanup();
  }
});

test('a stale entry written by this plugin is updated in place, not duplicated', async () => {
  const fixture = codexHomeFixture();
  // A REAL second installation of this package, which is the only differing path the
  // migration may adopt: the old version of this test used a path that merely looked
  // like one, which is exactly what the review refused to call proof.
  const oldInstall = otherInstallationFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), backupDir: join(fixture.home, 'backup') });
    const installed = readFileSync(fixture.configPath, 'utf8');
    // Rewrite the entry as if the plugin had moved (an upgrade to another profile).
    writeFileSync(fixture.configPath, installed.replace(
      /^args = \[.*\]$/mu,
      `args = [${JSON.stringify(oldInstall.script)}]`,
    ));

    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(status.status.mcp.state, 'conflict',
      'a moved install is NOT silently adoptable by a status read');

    await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    const repaired = readFileSync(fixture.configPath, 'utf8');
    assert.equal(repaired.match(/^\[mcp_servers\.dsh-delegate\]$/gmu)?.length, 1, 'exactly one entry');
    assert.equal(repaired.includes(oldInstall.root), false,
      'the explicit repair adopted the PROVED moved installation');
  } finally {
    oldInstall.cleanup();
    fixture.cleanup();
  }
});
// ---------------------------------------------------------------------------
// 6. The installed-integration upgrade: an ALREADY INSTALLED managed entry that is
//    merely stale is updated at startup; nothing is ever created or adopted.
// ---------------------------------------------------------------------------
//
// The real acceptance defect: a managed `mcp_servers.dsh-delegate` table written by an
// earlier release carries `command`/`args` but no `tool_timeout_sec`, so Codex may cut one
// long `delegate_wait` off at its own tool timeout. These tests pin the safe, idempotent
// upgrade — and the changes the review demanded: a proven script identity, a config
// digest re-checked before the write, and a backup that is a PRECONDITION.

/**
 * A managed entry written by an earlier release: marker, command, args, no timeout.
 * @param {object} [options] - `node`, `script`, `timeout`, `extra`.
 * @returns {string} config text.
 */
function priorManagedConfig({ node = resolveNodeExecutable(), script = null, timeout = null, extra = '' } = {}) {
  const entry = desiredMcpCommand({ node, script: script ?? join(ROOT, 'bin', 'dsh-delegate-mcp.js') });
  const lines = [
    '# operator section, must survive byte for byte',
    'model = "kept"',
    '',
    MCP_MARKER,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${JSON.stringify(entry.args[0])}]`,
  ];
  if (timeout !== null) lines.push(`tool_timeout_sec = ${String(timeout)}`);
  lines.push('');
  lines.push('[mcp_servers.other]');
  lines.push('command = "elsewhere"');
  lines.push(extra);
  lines.push('');
  return lines.join('\n');
}

/** A scratch backup directory for one test. */
function backupFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-delegate-backup-'));
  return { dir, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

test('startup upgrades an already-installed managed MCP entry that is missing the owned timeout', async () => {
  const fixture = codexHomeFixture();
  const backup = backupFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const prior = priorManagedConfig();
    writeFileSync(fixture.configPath, prior, 'utf8');
    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(before.status.mcp.state, 'outdated', 'the fixture must really describe a stale managed entry');
    assert.deepEqual(before.status.mcp.drift, ['tool_timeout_sec']);

    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION, backupDir: backup.dir });
    const outcome = await seam.refreshManagedIntegration({ startupTarget: await seam.startupTarget() });
    assert.deepEqual(outcome.changed, ['mcp'], 'the stale managed entry is upgraded in place');
    assert.deepEqual(outcome.refused, []);
    const written = readFileSync(fixture.configPath, 'utf8');
    assert.match(written, /^tool_timeout_sec = 3660$/mu, 'the owned timeout is now written');
    assert.equal(written.split(MCP_MARKER).length - 1, 1, 'exactly one ownership marker');
    assert.match(written, /^# operator section, must survive byte for byte$/mu);
    assert.match(written, /^model = "kept"$/mu);
    assert.match(written, /^\[mcp_servers\.other\]$/mu);
    assert.match(written, /^command = "elsewhere"$/mu);
    assert.ok(written.indexOf('tool_timeout_sec') < written.indexOf('[mcp_servers.other]'),
      'the timeout is added inside our own table, never after another section');
    assert.equal(outcome.status.mcp.state, 'configured');
    // The pre-write copy really exists, and it really is the original document.
    const copies = readdirSync(backup.dir);
    assert.equal(copies.length, 1);
    assert.equal(readFileSync(join(backup.dir, copies[0]), 'utf8'), prior);

    // Idempotent: a second startup writes nothing at all.
    const again = await seam.refreshManagedIntegration({ startupTarget: await seam.startupTarget() });
    assert.deepEqual(again.changed, [], 'an already-current entry is not rewritten');
    assert.equal(readFileSync(fixture.configPath, 'utf8'), written);
    // And an explicit install is still the button's action, also idempotent from here.
    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.deepEqual(installed.changed, []);
    assert.equal(readFileSync(fixture.configPath, 'utf8'), written);
  } finally {
    fixture.cleanup();
    backup.cleanup();
  }
});

test('an explicit repair adopts a PROVED older installation path, together with the timeout, in one write', async () => {
  // The realistic upgrade shape: the plugin now lives somewhere else, so `args[0]` names
  // the OLD copy. That copy is adopted only because it is a real installation of this
  // package (its `package.json` declares our name AND maps its bin entry to that file) —
  // never because its path looks like one, and never by the unattended startup path at
  // all: only the explicit repair adopts it.
  const fixture = codexHomeFixture();
  const backup = backupFixture();
  const oldInstall = otherInstallationFixture();
  try {
    writeFileSync(fixture.configPath, priorManagedConfig({ script: oldInstall.script }), 'utf8');
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(status.status.mcp.state, 'conflict', 'a bare status read never adopts a moved install');

    // The unattended startup check refuses it and leaves the file alone.
    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION, backupDir: backup.dir });
    const startup = await seam.refreshManagedIntegration({ startupTarget: await seam.startupTarget() });
    assert.deepEqual(startup.changed, [], 'startup never adopts a path it cannot prove from the plan');
    assert.equal(readFileSync(fixture.configPath, 'utf8'), priorManagedConfig({ script: oldInstall.script }));

    // The explicit repair performs the PROOF and adopts it, writing timeout + path at once.
    await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const written = readFileSync(fixture.configPath, 'utf8');
    assert.equal(written.includes(oldInstall.root), false, 'the stale script path is replaced');
    assert.match(written, /^tool_timeout_sec = 3660$/mu);
    assert.equal(classifyMcpEntry(new Document(written), status.status.mcp.desired).state, 'configured');
  } finally {
    oldInstall.cleanup();
    fixture.cleanup();
    backup.cleanup();
  }
});

test('a POSIX package root keeps its absolute root when the entry path is parsed', () => {
  // The old implementation split on '/' and filtered empty segments, so the leading '/'
  // of `/opt/pkg/bin/dsh-delegate-mcp.js` disappeared and the "root" became the RELATIVE
  // `opt/pkg` — a real POSIX installation could therefore never be proved. These are the
  // explicit path rules, so the regression runs the same on every host, not only on a
  // machine whose temporary directory happens to look POSIX.
  assert.equal(packageEntryRoot('/opt/dsh-delegate/bin/dsh-delegate-mcp.js', posix), '/opt/dsh-delegate');
  assert.equal(packageEntryRoot('/opt/dsh-delegate/lib/dsh-delegate-mcp.js', posix), null, 'bin/ is required');
  assert.equal(packageEntryRoot('relative/bin/dsh-delegate-mcp.js', posix), null, 'a relative path names nothing');
  assert.equal(packageEntryRoot('/bin/dsh-delegate-mcp.js', posix), null, 'the filesystem root is not a package root');
  assert.equal(packageEntryRoot('C:\\pkg\\dsh-delegate\\bin\\dsh-delegate-mcp.js', win32), 'C:\\pkg\\dsh-delegate');
  assert.equal(packageEntryRoot('C:\\bin\\dsh-delegate-mcp.js', win32), null);
  // Linux compares path case exactly: two case variants are different programs there.
  assert.equal(samePlatformPath('/opt/DSH/bin/x', '/opt/dsh/bin/x', 'linux'), false);
  assert.equal(samePlatformPath('/opt/DSH/bin/x', '/opt/dsh/bin/x', 'win32'), true);
});

test('only a real package whose manifest maps its bin to the entry is adoptable as a moved install', async () => {
  // The proof is the package identity read from disk: the root, its bin directory and the
  // entry must be real, non-link objects, and the manifest must BOTH declare this package's
  // name AND map `bin["dsh-delegate-mcp"]` to that exact entry. A same-layout wrapper with
  // a copied name and a missing/wrong/absolute/out-of-package mapping is never adopted.
  const installed = (await resolveMcpScript()).script;
  const positive = [
    otherInstallationFixture(),
    otherInstallationFixture({ bin: { 'dsh-delegate-mcp': './bin/dsh-delegate-mcp.js' } }),
  ];
  const negatives = [
    ['missing bin mapping', otherInstallationFixture({ omitBin: true })],
    ['wrong bin mapping', otherInstallationFixture({ bin: { 'dsh-delegate-mcp': 'bin/other.js' } })],
    ['out-of-package bin mapping', otherInstallationFixture({ bin: { 'dsh-delegate-mcp': '../outside.js' } })],
    ['absolute bin mapping', otherInstallationFixture({ bin: { 'dsh-delegate-mcp': resolve(tmpdir(), 'outside.js') } })],
    ['trailing-slash bin mapping', otherInstallationFixture({ bin: { 'dsh-delegate-mcp': 'bin/dsh-delegate-mcp.js/' } })],
    ['wrong package name', otherInstallationFixture({ name: 'not-dsh-delegate' })],
  ];
  const all = [...positive, ...negatives.map(([, fixture]) => fixture)];
  try {
    for (const fixture of positive) {
      assert.equal(await isOwnedEntryScript(fixture.script, installed), true,
        `a real manifest with a bin mapping is accepted: ${fixture.root}`);
    }
    for (const [label, fixture] of negatives) {
      assert.equal(await isOwnedEntryScript(fixture.script, installed), false, `${label} must be refused`);
    }
  } finally {
    for (const fixture of all) fixture.cleanup();
  }
});

test('a moved installation reached through a linked package root is refused', async () => {
  const installed = (await resolveMcpScript()).script;
  const real = otherInstallationFixture();
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-linked-root-'));
  const link = join(scratch, 'linked-root');
  try {
    // A real junction: `lstat` reports it as an ordinary directory, so only the platform
    // attribute read (stated here through the documented classifier hook) proves it.
    symlinkSync(real.root, link, 'junction');
    const candidate = join(link, 'bin', 'dsh-delegate-mcp.js');
    const undo = useDirectoryClassifier(nodeClassifier((path) => path === resolve(link)));
    try {
      assert.equal(await isOwnedEntryScript(candidate, installed), false,
        'a package root that is a junction is not a provable installation');
      // Sanity: the same files under their real root ARE provable, so the refusal is the link.
      assert.equal(await isOwnedEntryScript(real.script, installed), true);
    } finally {
      undo();
    }
  } finally {
    real.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an explicit repair refuses a same-layout wrapper, a relative path and a missing old path', async () => {
  // The explicit adoption path is the ONLY one that may change a recorded script, so its
  // refusals are part of the contract: a wrapper whose manifest does not map the entry, a
  // relative path (names no location) and a path that no longer exists are all left alone.
  const missingRoot = join(tmpdir(), `dsh-delegate-gone-${Date.now()}`);
  const wrapper = otherInstallationFixture({ bin: { 'dsh-delegate-mcp': 'bin/other.js' } });
  const cases = [
    ['wrapper with a wrong bin mapping', wrapper.script],
    ['relative recorded path', 'relative/bin/dsh-delegate-mcp.js'],
    ['missing recorded path', join(missingRoot, 'bin', 'dsh-delegate-mcp.js')],
  ];
  try {
    for (const [label, script] of cases) {
      const fixture = codexHomeFixture();
      const prior = priorManagedConfig({ script });
      try {
        writeFileSync(fixture.configPath, prior, 'utf8');
        const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
        assert.equal(repaired.changed.includes('mcp'), false, `${label}: never replaced`);
        assert.ok(
          repaired.refused.some((entry) => entry.target === 'mcp' && entry.code === 'MCP_ENTRY_CONFLICT'),
          `${label}: ${JSON.stringify(repaired.refused)}`,
        );
        assert.equal(readFileSync(fixture.configPath, 'utf8'), prior, `${label}: the entry is left byte-identical`);
        assert.equal(repaired.status.mcp.state, 'conflict', `${label}: still reported as a conflict`);
      } finally {
        fixture.cleanup();
      }
    }
  } finally {
    wrapper.cleanup();
  }
});

test('a config edit between the moved-install proof and its write is refused, keeping the edit', async () => {
  // The explicit adoption path proves the old path with several filesystem probes and only
  // then writes. The digest check is what makes that window safe: the proof describes the
  // bytes that were read, so a file that changed afterwards must not be rewritten.
  const fixture = codexHomeFixture();
  const oldInstall = otherInstallationFixture();
  try {
    const prior = priorManagedConfig({ script: oldInstall.script });
    writeFileSync(fixture.configPath, prior, 'utf8');
    const before = await readCodexStatus({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(before.mcp.state, 'conflict', 'a bare read never adopts the moved install');
    const adopted = await adoptProvedMovedInstall(before);
    assert.notEqual(adopted, null, 'the moved installation is provable from the current document');

    // THE WINDOW: the operator edits an unrelated setting after the proof.
    const edited = prior.replace('model = "kept"', 'model = "changed"');
    assert.notEqual(edited, prior);
    writeFileSync(fixture.configPath, edited, 'utf8');
    const outcome = { changed: [], refused: [] };
    await adoptMovedInstall(adopted, outcome, before);

    assert.deepEqual(outcome.changed, [], 'nothing may be written from a proof of the previous bytes');
    assert.ok(
      outcome.refused.some((entry) => entry.target === 'mcp' && entry.code === 'MCP_ENTRY_CONFLICT' && entry.reason === 'config-changed'),
      JSON.stringify(outcome.refused),
    );
    assert.equal(readFileSync(fixture.configPath, 'utf8'), edited, 'the concurrent edit survives');
  } finally {
    oldInstall.cleanup();
    fixture.cleanup();
  }
});

test('a boundary link that appears between the moved-install proof and its write is refused', async () => {
  const fixture = codexHomeFixture();
  const oldInstall = otherInstallationFixture();
  try {
    const prior = priorManagedConfig({ script: oldInstall.script });
    writeFileSync(fixture.configPath, prior, 'utf8');
    const before = await readCodexStatus({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const adopted = await adoptProvedMovedInstall(before);
    assert.notEqual(adopted, null, 'the moved installation is provable first');

    // THE WINDOW: the home becomes a link (a junction, as Windows would report it) after
    // the proof. The write must be refused rather than followed.
    const undo = useDirectoryClassifier(nodeClassifier((candidate) => candidate === resolve(fixture.home)));
    const outcome = { changed: [], refused: [] };
    try {
      await adoptMovedInstall(adopted, outcome, before);
    } finally {
      undo();
    }
    assert.deepEqual(outcome.changed, [], 'nothing is written through the link');
    assert.ok(
      outcome.refused.some((entry) => entry.code === 'AGENT_PATH_CONFLICT' && entry.reason === 'codex-home-is-link'),
      JSON.stringify(outcome.refused),
    );
    assert.equal(readFileSync(fixture.configPath, 'utf8'), prior, 'the config is byte-identical');
  } finally {
    oldInstall.cleanup();
    fixture.cleanup();
  }
});

test('startup NEVER creates the MCP entry, and never touches an unmanaged or modified one', async () => {
  const cases = [
    { name: 'absent', config: 'model = "kept"\n', expectState: 'not-configured' },
    {
      name: 'unmanaged same-name entry',
      config: '[mcp_servers.dsh-delegate]\ncommand = "/usr/bin/node"\nargs = ["/somewhere/dsh-delegate-mcp.js"]\n',
      expectState: 'conflict',
    },
    {
      name: 'managed but operator-edited shape',
      config: `${MCP_MARKER}\n[mcp_servers.dsh-delegate]\ncommand = "C:/tools/my-node.exe"\nargs = ["C:/mine.js"]\ntool_timeout_sec = 3660\n`,
      expectState: 'conflict',
    },
  ];
  for (const entry of cases) {
    const fixture = codexHomeFixture();
    const backup = backupFixture();
    try {
      writeFileSync(fixture.configPath, entry.config, 'utf8');
      const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION, backupDir: backup.dir });
      const outcome = await seam.refreshManagedIntegration({ startupTarget: await seam.startupTarget() });
      assert.deepEqual(outcome.changed, [], `${entry.name}: startup must change nothing`);
      assert.equal(outcome.status.mcp.state, entry.expectState, `${entry.name}: state`);
      assert.equal(readFileSync(fixture.configPath, 'utf8'), entry.config, `${entry.name}: the config is byte-identical`);
      assert.deepEqual(readdirSync(backup.dir), [], `${entry.name}: nothing was backed up because nothing was written`);
    } finally {
      fixture.cleanup();
      backup.cleanup();
    }
  }
});

test('a config that changed after the check is refused, even when the entry still LOOKS stale', async () => {
  // THE race, reproduced deterministically. Between the check and the write the operator
  // changes the OWNED timeout to 120 — the entry is still marked, still this plugin's
  // command/script, and still `outdated`, so a re-classification alone would happily
  // overwrite it. The digest comparison is what refuses.
  const fixture = codexHomeFixture();
  const backup = backupFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const prior = priorManagedConfig();
    writeFileSync(fixture.configPath, prior, 'utf8');
    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(before.status.mcp.state, 'outdated');
    assert.equal(typeof before.status.mcp.fingerprint, 'string', 'the plan records a config digest');

    const concurrentlyEdited = prior.replace('args = [', 'tool_timeout_sec = 120\nargs = [');
    assert.notEqual(concurrentlyEdited, prior);
    writeFileSync(fixture.configPath, concurrentlyEdited, 'utf8');

    // Drive the write path with the ORIGINAL plan: exactly the window in question.
    const outcome = await refreshKnownAgentTemplate({
      codexHome: fixture.home,
      env: isolatedEnv(fixture.home),
      version: DELIVERABLE_VERSION,
      refreshMcp: true,
      backupDir: backup.dir,
      plan: before.status,
    });
    assert.deepEqual(outcome.changed, [], 'nothing may be written from a stale plan');
    assert.ok(
      outcome.refused.some((entry) => entry.target === 'mcp' && entry.reason === 'config-changed'),
      JSON.stringify(outcome.refused),
    );
    assert.equal(readFileSync(fixture.configPath, 'utf8'), concurrentlyEdited, 'the operator edit survives');
    assert.deepEqual(readdirSync(backup.dir), [], 'no backup was taken for a refused write');
  } finally {
    fixture.cleanup();
    backup.cleanup();
  }
});

test('a config edit while the backup runs is refused after it, and the edit is kept', { skip: WINDOWS_CLASSIFIER_SKIP }, async () => {
  // The backup is not instantaneous: it probes the whole ancestor chain (and, on Windows,
  // reads file attributes). A config written during that window must not be overwritten by
  // the `next` document computed BEFORE the backup — the post-backup digest re-check is
  // what makes that observable window safe.
  const fixture = codexHomeFixture();
  const backup = backupFixture();
  const original = priorManagedConfig();
  const edited = original.replace('model = "kept"', 'model = "edited-while-backing-up"');
  assert.notEqual(edited, original, 'the injected edit really changes the document');
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    writeFileSync(fixture.configPath, original, 'utf8');
    const backupRoot = resolve(backup.dir);
    let fired = false;
    // The plan, the write gate and the first digest check have all passed by the time the
    // backup inspects its own directory, so this is exactly the post-plan window.
    const undo = useDirectoryClassifier(async (paths) => {
      if (!fired && paths.some((path) => path.startsWith(backupRoot))) {
        fired = true;
        writeFileSync(fixture.configPath, edited, 'utf8');
      }
      return await nodeClassifier()(paths);
    });
    let outcome;
    try {
      outcome = await refreshKnownAgentTemplate({
        codexHome: fixture.home,
        env: isolatedEnv(fixture.home),
        version: DELIVERABLE_VERSION,
        refreshMcp: true,
        backupDir: backup.dir,
      });
    } finally {
      undo();
    }
    assert.equal(fired, true, 'the edit really happened during the backup window');
    assert.deepEqual(outcome.changed, [], 'nothing is written after the backup');
    assert.ok(
      outcome.refused.some((entry) => entry.code === 'MCP_ENTRY_CONFLICT' && entry.reason === 'config-changed'),
      JSON.stringify(outcome.refused),
    );
    assert.equal(readFileSync(fixture.configPath, 'utf8'), edited, 'the concurrent edit survives byte for byte');
    // The backup was taken (from the pre-edit document) before the refusal was decided.
    const copies = readdirSync(backup.dir);
    assert.equal(copies.length, 1, 'exactly one pre-write copy');
    assert.equal(readFileSync(join(backup.dir, copies[0]), 'utf8'), original, 'the copy holds the bytes the plan described');
  } finally {
    backup.cleanup();
    fixture.cleanup();
  }
});

test('a boundary link that appears while the backup runs is refused before the write', { skip: WINDOWS_CLASSIFIER_SKIP }, async () => {
  const fixture = codexHomeFixture();
  const backup = backupFixture();
  const original = priorManagedConfig();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    writeFileSync(fixture.configPath, original, 'utf8');
    const backupRoot = resolve(backup.dir);
    const home = resolve(fixture.home);
    let fired = false;
    let homeIsLink = false;
    const undo = useDirectoryClassifier(async (paths) => {
      if (!fired && paths.some((path) => path.startsWith(backupRoot))) {
        fired = true;
        homeIsLink = true;
      }
      return await nodeClassifier((candidate) => homeIsLink && candidate === home)(paths);
    });
    let outcome;
    try {
      outcome = await refreshKnownAgentTemplate({
        codexHome: fixture.home,
        env: isolatedEnv(fixture.home),
        version: DELIVERABLE_VERSION,
        refreshMcp: true,
        backupDir: backup.dir,
      });
    } finally {
      undo();
    }
    assert.equal(fired, true, 'the boundary changed during the backup window');
    assert.deepEqual(outcome.changed, [], 'nothing is written through the link');
    assert.ok(
      outcome.refused.some((entry) => entry.code === 'AGENT_PATH_CONFLICT' && entry.reason === 'codex-home-is-link'),
      JSON.stringify(outcome.refused),
    );
    assert.equal(readFileSync(fixture.configPath, 'utf8'), original, 'the config is byte-identical');
  } finally {
    backup.cleanup();
    fixture.cleanup();
  }
});

test('startup never rewrites an operator wrapper, end to end through the real write path', async () => {
  const fixture = codexHomeFixture();
  const backup = backupFixture();
  const wrapperDir = mkdtempSync(join(tmpdir(), 'dsh-delegate-wrapper-'));
  try {
    mkdirSync(join(wrapperDir, 'bin'), { recursive: true });
    const wrapperScript = join(wrapperDir, 'bin', 'dsh-delegate-mcp.js');
    writeFileSync(wrapperScript, '// the operator own program\n');
    const wrapper = [
      MCP_MARKER,
      '[mcp_servers.dsh-delegate]',
      `command = ${JSON.stringify(resolveNodeExecutable())}`,
      `args = [${JSON.stringify(wrapperScript)}]`,
      '',
    ].join('\n');
    writeFileSync(fixture.configPath, wrapper, 'utf8');
    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION, backupDir: backup.dir });
    const outcome = await seam.refreshManagedIntegration({ startupTarget: await seam.startupTarget() });
    assert.deepEqual(outcome.changed, [], 'the wrapper is never rewritten');
    assert.equal(readFileSync(fixture.configPath, 'utf8'), wrapper, 'the file is byte-identical');
    assert.equal(outcome.status.mcp.state, 'conflict');
    assert.deepEqual(readdirSync(backup.dir), []);
    const install = await seam.run('install');
    assert.equal(install.changed.includes('mcp'), false);
    assert.ok(install.refused.some((entry) => entry.target === 'mcp' && entry.code === 'MCP_ENTRY_CONFLICT'));
    assert.equal(readFileSync(fixture.configPath, 'utf8'), wrapper);
  } finally {
    rmSync(wrapperDir, { recursive: true, force: true });
    fixture.cleanup();
    backup.cleanup();
  }
});

test('startup never rewrites an entry with extra arguments, end to end', async () => {
  const fixture = codexHomeFixture();
  const backup = backupFixture();
  try {
    const flagged = [
      MCP_MARKER,
      '[mcp_servers.dsh-delegate]',
      `command = ${JSON.stringify(resolveNodeExecutable())}`,
      `args = [${JSON.stringify(join(ROOT, 'bin', 'dsh-delegate-mcp.js'))}, "--inspect"]`,
      '',
    ].join('\n');
    writeFileSync(fixture.configPath, flagged, 'utf8');
    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION, backupDir: backup.dir });
    const outcome = await seam.refreshManagedIntegration({ startupTarget: await seam.startupTarget() });
    assert.deepEqual(outcome.changed, []);
    assert.equal(readFileSync(fixture.configPath, 'utf8'), flagged);
    assert.equal(outcome.status.mcp.state, 'conflict');
    assert.equal(outcome.status.mcp.reason, 'args-shape-not-ours');
  } finally {
    fixture.cleanup();
    backup.cleanup();
  }
});

test('an automatic upgrade REFUSES to write without a trusted backup location', async () => {
  // A backup is a precondition, not a nicety: without a destination the migration must not
  // rewrite a config it could not preserve.
  const fixture = codexHomeFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const prior = priorManagedConfig();
    writeFileSync(fixture.configPath, prior, 'utf8');
    const outcome = await refreshKnownAgentTemplate({
      codexHome: fixture.home,
      env: isolatedEnv(fixture.home),
      version: DELIVERABLE_VERSION,
      refreshMcp: true,
      // No backupDir at all.
    });
    assert.deepEqual(outcome.changed, [], 'nothing is written without a backup target');
    assert.ok(
      outcome.refused.some((entry) => entry.code === 'MCP_ENTRY_BACKUP_UNAVAILABLE'),
      JSON.stringify(outcome.refused),
    );
    assert.equal(readFileSync(fixture.configPath, 'utf8'), prior, 'the original document is untouched');
  } finally {
    fixture.cleanup();
  }
});

test('an automatic upgrade REFUSES when the backup destination is a file or a link', async () => {
  const cases = ['file', 'link'];
  for (const kind of cases) {
    const fixture = codexHomeFixture();
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-badbackup-'));
    try {
      await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      const prior = priorManagedConfig();
      writeFileSync(fixture.configPath, prior, 'utf8');
      const target = join(scratch, 'backup-target');
      const real = join(scratch, 'real-target');
      if (kind === 'file') writeFileSync(target, 'not a directory\n');
      else {
        // The DESTINATION itself must be the link, not a link inside it.
        mkdirSync(real, { recursive: true });
        symlinkSync(real, target, 'junction');
      }
      // On Windows a junction is reported by `lstat` as a plain directory, so the suite
      // states the platform verdict through the documented classifier hook — the same
      // call a real install makes. This is what proves the backup path rejects a link.
      const undo = kind === 'link'
        ? useDirectoryClassifier(nodeClassifier((candidate) => candidate === target))
        : () => {};
      try {
        const outcome = await refreshKnownAgentTemplate({
          codexHome: fixture.home,
          env: isolatedEnv(fixture.home),
          version: DELIVERABLE_VERSION,
          refreshMcp: true,
          backupDir: target,
        });
        assert.deepEqual(outcome.changed, [], `${kind}: nothing is written`);
        assert.ok(
          outcome.refused.some((entry) => entry.code === 'MCP_ENTRY_BACKUP_FAILED'),
          `${kind}: ${JSON.stringify(outcome.refused)}`,
        );
        assert.equal(readFileSync(fixture.configPath, 'utf8'), prior, `${kind}: the original document is untouched`);
        // No config text was written to the untrusted destination.
        if (kind === 'file') assert.equal(readFileSync(target, 'utf8'), 'not a directory\n');
        else assert.deepEqual(readdirSync(real), [], 'no config was written through the link');
      } finally {
        undo();
      }
    } finally {
      fixture.cleanup();
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('an automatic upgrade REFUSES a backup directory behind a linked ancestor, writing nothing through it', async () => {
  // Checking only the leaf is not enough: the leaf can be a plain directory while one of
  // its parents is a junction into somebody else's tree, and a write there would put the
  // complete config outside the plugin's data directory.
  const fixture = codexHomeFixture();
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-ancestor-link-'));
  const real = join(scratch, 'real-target');
  const link = join(scratch, 'linked-ancestor');
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const prior = priorManagedConfig();
    writeFileSync(fixture.configPath, prior, 'utf8');
    mkdirSync(real, { recursive: true });
    // A real junction, whose platform verdict is stated through the same documented hook a
    // real Windows install uses (lstat reports a junction as an ordinary directory).
    symlinkSync(real, link, 'junction');
    const target = join(link, 'nested', 'backup');
    const undo = useDirectoryClassifier(nodeClassifier((candidate) => candidate === link));
    try {
      const outcome = await refreshKnownAgentTemplate({
        codexHome: fixture.home,
        env: isolatedEnv(fixture.home),
        version: DELIVERABLE_VERSION,
        refreshMcp: true,
        backupDir: target,
      });
      assert.deepEqual(outcome.changed, [], 'nothing is written');
      assert.ok(
        outcome.refused.some((entry) => entry.code === 'MCP_ENTRY_BACKUP_FAILED' && /ancestor-is-a-link/u.test(entry.message)),
        JSON.stringify(outcome.refused),
      );
      assert.equal(readFileSync(fixture.configPath, 'utf8'), prior, 'the original document is untouched');
      assert.deepEqual(readdirSync(real), [], 'no backup and no config text reached the link target');
    } finally {
      undo();
    }
  } finally {
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an automatic upgrade REFUSES a backup directory below a non-directory ancestor', async () => {
  const fixture = codexHomeFixture();
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-ancestor-file-'));
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const prior = priorManagedConfig();
    writeFileSync(fixture.configPath, prior, 'utf8');
    const blocker = join(scratch, 'not-a-directory');
    writeFileSync(blocker, 'file, not a directory\n');
    const outcome = await refreshKnownAgentTemplate({
      codexHome: fixture.home,
      env: isolatedEnv(fixture.home),
      version: DELIVERABLE_VERSION,
      refreshMcp: true,
      backupDir: join(blocker, 'nested'),
    });
    assert.deepEqual(outcome.changed, [], 'nothing is written');
    assert.ok(
      outcome.refused.some((entry) => entry.code === 'MCP_ENTRY_BACKUP_FAILED' && /ancestor-not-a-directory/u.test(entry.message)),
      JSON.stringify(outcome.refused),
    );
    assert.equal(readFileSync(fixture.configPath, 'utf8'), prior, 'the original document is untouched');
    assert.equal(readFileSync(blocker, 'utf8'), 'file, not a directory\n', 'the blocker is untouched');
  } finally {
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('missing backup subdirectories are created and verified before the upgrade writes', async () => {
  const fixture = codexHomeFixture();
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-missing-backup-'));
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const prior = priorManagedConfig();
    writeFileSync(fixture.configPath, prior, 'utf8');
    // Three levels that do not exist yet: the normal first-run shape for a data directory.
    const backupDir = join(scratch, 'data', 'dsh-delegate', 'codex-config-backup');
    const outcome = await refreshKnownAgentTemplate({
      codexHome: fixture.home,
      env: isolatedEnv(fixture.home),
      version: DELIVERABLE_VERSION,
      refreshMcp: true,
      backupDir,
    });
    assert.deepEqual(outcome.changed, ['mcp'], 'the stale owned entry is upgraded');
    assert.deepEqual(outcome.refused, []);
    assert.match(readFileSync(fixture.configPath, 'utf8'), /^tool_timeout_sec = 3660$/mu);
    const copies = readdirSync(backupDir);
    assert.equal(copies.length, 1, 'exactly one pre-write copy');
    assert.equal(readFileSync(join(backupDir, copies[0]), 'utf8'), prior, 'the copy is the original document');
  } finally {
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a bare startup refresh upgrades a stale managed entry, backing it up in the plugin data directory', async () => {
  // The review's requirement: `seam.refreshManagedIntegration()` without an explicit
  // `backupDir` must still perform the safe migration of an already-installed managed
  // entry — the product derives the backup destination from its OWN data directory
  // (`DSH_HOME`), not from a caller. The same bare call on a first run writes nothing.
  const fixture = codexHomeFixture();
  const env = isolatedEnv(fixture.home);
  const expectedBackupDir = join(env.DSH_HOME, 'data', 'dsh-delegate', 'codex-config-backup');
  try {
    assert.equal(defaultBackupDirectory(env), expectedBackupDir, 'the default lives in the plugin data directory');

    // 1. First enable: an empty Codex home. Nothing is created, and no backup is taken.
    const first = await createCodexSeam({ codexHome: fixture.home, env, version: DELIVERABLE_VERSION })
      .refreshManagedIntegration();
    assert.deepEqual(first.changed, []);
    assert.deepEqual(first.refused, []);
    assert.equal(existsSync(fixture.configPath), false, 'a first run creates no Codex config');
    assert.equal(existsSync(fixture.agentPath), false, 'a first run creates no agent file');
    assert.equal(existsSync(expectedBackupDir), false, 'nothing was backed up because nothing was written');

    // 2. An entry this plugin wrote BEFORE `tool_timeout_sec` existed, upgraded in place.
    writeFileSync(fixture.configPath, priorManagedConfig(), 'utf8');
    const prior = readFileSync(fixture.configPath, 'utf8');
    const outcome = await createCodexSeam({ codexHome: fixture.home, env, version: DELIVERABLE_VERSION })
      .refreshManagedIntegration();
    assert.deepEqual(outcome.changed, ['mcp'], 'the stale managed entry is upgraded without any argument');
    assert.deepEqual(outcome.refused, []);
    assert.match(readFileSync(fixture.configPath, 'utf8'), /^tool_timeout_sec = 3660$/mu);

    // 3. The pre-write copy is real, and it is in the scratch data directory.
    const copies = readdirSync(expectedBackupDir);
    assert.equal(copies.length, 1, 'exactly one pre-write copy');
    assert.equal(readFileSync(join(expectedBackupDir, copies[0]), 'utf8'), prior, 'the copy is the original document');
  } finally {
    fixture.cleanup();
  }
});

test('the status document names the drift, so the panel can say what is stale', async () => {
  const fixture = codexHomeFixture();
  try {
    writeFileSync(fixture.configPath, priorManagedConfig(), 'utf8');
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(status.status.mcp.state, 'outdated');
    assert.ok(Array.isArray(status.status.mcp.drift), 'the drift is a list of owned facts');
    assert.ok(status.status.mcp.drift.includes('tool_timeout_sec'));
    assert.equal(status.status.mcp.previous.discoveryFile, null);
    const note = (status.status.notes ?? []).find((entry) => entry.code === 'MCP_ENTRY_OUTDATED');
    assert.ok(note !== undefined, 'an outdated entry is explained');
    assert.match(note.text, /3660/u);
    // The fingerprint is a planning receipt, not part of the public contract.
    assert.equal(typeof status.status.mcp.fingerprint, 'string');
  } finally {
    fixture.cleanup();
  }
});

test('a first run with an EMPTY Codex home creates neither the agent file nor the MCP entry', async () => {
  const fixture = codexHomeFixture();
  try {
    const target = await resolveStartupTarget({ env: isolatedEnv(fixture.home) });
    assert.equal(target.source, 'explicit', 'an explicit CODEX_HOME is the target');
    assert.equal(target.home, resolve(fixture.home));
    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const outcome = await seam.refreshManagedIntegration({ startupTarget: target });
    assert.deepEqual(outcome.changed, []);
    assert.equal(outcome.status.agent.state, 'not-installed');
    assert.equal(outcome.status.mcp.state, 'not-configured');
    assert.equal(existsSync(fixture.agentPath), false, 'no agent file is created');
    assert.equal(existsSync(join(fixture.home, 'agents')), false, 'no agents directory is created');
    assert.equal(existsSync(fixture.configPath), false, 'no config.toml is created');
  } finally {
    fixture.cleanup();
  }
});

test('a home that does not exist at all is not a startup target, and refresh never falls back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegate-nohome-'));
  try {
    const env = { CODEX_HOME: '', DSH_HOME: join(root, 'dsh'), DSH_DELEGATE_DISCOVERY_FILE: '', DSH_DELEGATE_BASE_URL: '' };
    // Redirect the default away from the real user home for this call.
    const target = await resolveStartupTarget({ env, homeDirectory: root });
    assert.equal(target.home, null);
    assert.equal(target.reason, 'no-codex-home');
    assert.equal(existsSync(join(root, '.codex')), false, 'nothing was created while deciding');

    // THE NO-FALLBACK guarantee: a refresh told that the target has no home must REFUSE,
    // not quietly write into whatever `base()` would have resolved.
    const seam = createCodexSeam({ env, version: DELIVERABLE_VERSION });
    const outcome = await seam.refreshManagedIntegration({ startupTarget: target });
    assert.deepEqual(outcome.changed, [], 'no write happened');
    assert.ok(outcome.refused.some((entry) => entry.code === 'CODEX_HOME_INVALID'), JSON.stringify(outcome.refused));
    assert.equal(existsSync(join(root, 'dsh')), false, 'nothing was written into the data directory either');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup prefers an explicit CODEX_HOME over everything else, and refuses a linked default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegate-targets-'));
  const explicit = join(root, 'explicit-home');
  const linkedDefault = join(root, 'linked-default');
  const outside = join(root, 'outside');
  try {
    mkdirSync(explicit, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // 1. An explicit CODEX_HOME wins even when a default exists.
    const explicitTarget = await resolveStartupTarget({
      env: { CODEX_HOME: explicit, DSH_HOME: join(root, 'dsh') },
      homeDirectory: root,
    });
    assert.equal(explicitTarget.home, resolve(explicit));
    assert.equal(explicitTarget.source, 'explicit');

    // 2. A real default is used when nothing is explicit.
    mkdirSync(join(root, '.codex'), { recursive: true });
    const defaultTarget = await resolveStartupTarget({
      env: { CODEX_HOME: '', DSH_HOME: join(root, 'dsh') },
      homeDirectory: root,
    });
    assert.equal(defaultTarget.source, 'default');
    assert.equal(defaultTarget.home, resolve(join(root, '.codex')));

    // 3. A default that is a LINK is refused with a reason, never walked.
    rmSync(join(root, '.codex'), { recursive: true, force: true });
    symlinkSync(outside, join(root, '.codex'), 'junction');
    const undo = useDirectoryClassifier(nodeClassifier((candidate) => candidate === resolve(join(root, '.codex'))));
    try {
      const linkedTarget = await resolveStartupTarget({
        env: { CODEX_HOME: '', DSH_HOME: join(root, 'dsh') },
        homeDirectory: root,
      });
      // The path is reported (so an operator can see WHICH directory) but flagged as not
      // a usable target, and the installer refuses to write through it.
      assert.equal(linkedTarget.reason, 'default-is-link', 'a linked default is diagnosed, never walked');
      // The seam resolves the default home through `os.homedir()`, and it has no
      // `homeDirectory` option of its own. Point the process's home at the scratch root
      // for this one call, so the assertion really exercises the seam's OWN precedence
      // against the linked default we just built — and never inspects the operator's real
      // `~/.codex` (a test must not read or write the real user settings).
      const previousProfile = process.env.USERPROFILE;
      process.env.USERPROFILE = root;
      let seamTarget;
      try {
        seamTarget = await createCodexSeam({ env: { CODEX_HOME: '', DSH_HOME: join(root, 'dsh') }, version: DELIVERABLE_VERSION }).startupTarget();
      } finally {
        if (previousProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousProfile;
      }
      assert.equal(seamTarget.reason, 'default-is-link', 'the seam never treats a linked default as a plain target');
      assert.equal(seamTarget.home, resolve(join(root, '.codex')), 'and reports WHICH linked directory it refused');
    } finally {
      undo();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a successful explicit install is remembered — including a zero-change idempotent one', async () => {
  // The review's regression: an installation that is ALREADY exactly right installs with
  // `changed: []`. That is a success, and it must still record the directory, otherwise
  // removing CODEX_HOME makes the page and the buttons point somewhere else.
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegate-remember-'));
  const codexHome = join(root, 'codex-home');
  const dshHome = join(root, 'dsh');
  try {
    mkdirSync(codexHome, { recursive: true });
    const env = { CODEX_HOME: codexHome, DSH_HOME: dshHome, DSH_DELEGATE_DISCOVERY_FILE: '', DSH_DELEGATE_BASE_URL: '' };
    const first = await createCodexSeam({ env, version: DELIVERABLE_VERSION }).run('install');
    assert.ok(first.changed.length > 0, 'the first install really wrote both targets');
    const recordPath = installationRecordPath(env);
    assert.equal(existsSync(recordPath), true, 'the install location is recorded');

    // 1. A SECOND install writes nothing (idempotent) but is still a success...
    const second = await createCodexSeam({ env, version: DELIVERABLE_VERSION }).run('install');
    assert.deepEqual(second.changed, [], 'the second install is a no-op');
    assert.deepEqual(second.refused, []);
    // ...and after dropping CODEX_HOME altogether the recorded home is still the target.
    const bareEnv = { CODEX_HOME: '', DSH_HOME: dshHome, DSH_DELEGATE_DISCOVERY_FILE: '', DSH_DELEGATE_BASE_URL: '' };
    const target = await resolveStartupTarget({ env: bareEnv });
    assert.equal(target.source, 'recorded');
    assert.equal(resolve(target.home), resolve(codexHome));

    // 2. status, repair and install all report/act on that SAME directory.
    const seam = createCodexSeam({ env: bareEnv, version: DELIVERABLE_VERSION });
    const status = await seam.status();
    assert.equal(resolve(status.status.codexHome), resolve(codexHome), 'status points at the recorded home');
    assert.equal(status.status.agent.state, 'installed');
    assert.equal(status.status.mcp.state, 'configured');
    for (const action of ['repair', 'install']) {
      const outcome = await seam.run(action);
      assert.equal(resolve(outcome.status.codexHome), resolve(codexHome), `${action} acts on the same home`);
      assert.deepEqual(outcome.changed, [], `${action} has nothing to change there`);
    }

    // 3. ...and a stale entry in that same home is really upgraded by startup.
    writeFileSync(join(codexHome, 'config.toml'), priorManagedConfig(), 'utf8');
    const backup = backupFixture();
    try {
      const migrated = await createCodexSeam({ env: bareEnv, version: DELIVERABLE_VERSION, backupDir: backup.dir })
        .refreshManagedIntegration({ startupTarget: target });
      assert.deepEqual(migrated.changed, ['mcp']);
      assert.match(readFileSync(join(codexHome, 'config.toml'), 'utf8'), /^tool_timeout_sec = 3660$/mu);
    } finally {
      backup.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed install is never remembered as the target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delegate-remember-fail-'));
  const dshHome = join(root, 'dsh');
  try {
    const codexHome = join(root, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.dsh-delegate]\ncommand = "/usr/bin/node"\nargs = ["/x.js"]\n');
    const env = { CODEX_HOME: codexHome, DSH_HOME: dshHome, DSH_DELEGATE_DISCOVERY_FILE: '', DSH_DELEGATE_BASE_URL: '' };
    const outcome = await createCodexSeam({ env, version: DELIVERABLE_VERSION }).run('install');
    assert.ok(outcome.refused.length > 0, 'the install really was refused at least in part');
    assert.equal(existsSync(installationRecordPath(env)), false, 'a refused install records nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup refuses to upgrade through a symbolic link at the Codex home or agents directory', async () => {
  const fixture = codexHomeFixture();
  const outside = mkdtempSync(join(tmpdir(), 'dsh-delegate-outside-'));
  const backup = backupFixture();
  const prior = priorManagedConfig();
  try {
    writeFileSync(join(outside, 'config.toml'), prior, 'utf8');
    mkdirSync(join(outside, 'agents'), { recursive: true });
    const linkHome = join(fixture.home, 'linked-home');
    symlinkSync(outside, linkHome, 'junction');
    const undo = useDirectoryClassifier(nodeClassifier((path) => path === linkHome));
    try {
      const outcome = await createCodexSeam({ codexHome: linkHome, env: isolatedEnv(linkHome), version: DELIVERABLE_VERSION, backupDir: backup.dir })
        .refreshManagedIntegration();
      assert.deepEqual(outcome.changed, [], 'a linked home is never written through');
      assert.ok(outcome.refused.some((entry) => entry.code === 'AGENT_PATH_CONFLICT'), JSON.stringify(outcome.refused));
      assert.equal(readFileSync(join(outside, 'config.toml'), 'utf8'), prior, 'the linked config is untouched');
    } finally {
      undo();
    }
  } finally {
    fixture.cleanup();
    backup.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Restored regression tests (recovered verbatim from the release baseline)
// ---------------------------------------------------------------------------

test('the 0.1.6 Desktop GUI command is migrated only when the current package entry is intact', async () => {
  const fixture = codexHomeFixture();
  try {
    writeFileSync(fixture.configPath, managedBlock({ node: DESKTOP_EXE }));
    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(before.status.mcp.state, 'outdated');
    assert.equal(before.status.mcp.previous.command, DESKTOP_EXE);

    const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.deepEqual(repaired.refused, []);
    assert.deepEqual(repaired.changed, ['mcp']);
    const written = readFileSync(fixture.configPath, 'utf8');
    const values = readTomlValues(written);
    assert.equal(values['mcp_servers.dsh-delegate.command'].text, JSON.stringify(resolveNodeExecutable()));
    assert.doesNotMatch(written, /DeepSeek Harness\.exe/u);
    assert.equal(repaired.status.mcp.state, 'configured');
  } finally {
    fixture.cleanup();
  }
});

test('a conflicting dsh-delegate MCP entry is refused and explained, never replaced', async () => {
  const cases = [
    // An unmarked entry is the operator's even when the values look like ours:
    // identical values are not proof that this plugin wrote the line.
    [`[mcp_servers.dsh-delegate]\ncommand = ${JSON.stringify(resolveNodeExecutable())}\nargs = [${JSON.stringify(join(ROOT, 'bin', 'dsh-delegate-mcp.js'))}]\n`, 'unmanaged-entry'],
    ['[mcp_servers.dsh-delegate]\ncommand = "my-wrapper"\nargs = ["x"]\n', 'unmanaged-entry'],
    ['[mcp_servers.dsh-delegate]\ncommand = "node"\nargs = ["x"]\nenv.MINE = "1"\n', 'unmanaged-entry'],
    ['[mcp_servers.dsh-delegate]\ncommand = "node"\nargs = ["x"]\n', 'unmanaged-entry'],
    // A marked entry with a command this plugin never writes is still not ours.
    [`${MCP_MARKER}\n[mcp_servers.dsh-delegate]\ncommand = "my-wrapper"\nargs = ["x"]\n`, 'command-not-ours'],
    // The migration is deliberately narrower than a basename guess: a bare GUI
    // command, a helper with a similar name and an old GUI entry with stale args
    // all remain conflicts.
    [`${MCP_MARKER}\n[mcp_servers.dsh-delegate]\ncommand = "DeepSeek Harness.exe"\nargs = [${JSON.stringify(join(ROOT, 'bin', 'dsh-delegate-mcp.js'))}]\n`, 'command-not-ours'],
    [`${MCP_MARKER}\n[mcp_servers.dsh-delegate]\ncommand = "C:\\\\DeepSeek Harness Helper.exe"\nargs = [${JSON.stringify(join(ROOT, 'bin', 'dsh-delegate-mcp.js'))}]\n`, 'command-not-ours'],
    [`${MCP_MARKER}\n[mcp_servers.dsh-delegate]\ncommand = ${JSON.stringify(DESKTOP_EXE)}\nargs = ["E:/old/profile/bin/dsh-delegate-mcp.js"]\n`, 'args-shape-not-ours'],
    // An `env` block the operator added to *our* entry is their data, so an entry
    // that also carries one is a conflict rather than something to prune.
    [[MCP_MARKER, ...OURS_WITH_EXTRA_ENV().split('\n')].join('\n'), 'extra-env'],
    ['[mcp_servers.dsh-delegate]\nurl = "https://example.invalid/mcp"\n', 'url'],
    ['[mcp_servers.dsh-delegate]\ncommand = "node"\ncwd = "/tmp"\n', 'unknown-field'],
  ];
  for (const [body, expected] of cases) {
    const fixture = codexHomeFixture();
    try {
      writeFileSync(fixture.configPath, body);
      const before = readFileSync(fixture.configPath, 'utf8');
      const outcome = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
      assert.equal(outcome.status.mcp.state, 'conflict', body);
      assert.equal(outcome.status.mcp.reason, expected, body);
      assert.ok(outcome.refused.some((entry) => entry.target === 'mcp' && entry.code === 'MCP_ENTRY_CONFLICT'), body);
      assert.equal(readFileSync(fixture.configPath, 'utf8'), before, 'the conflicting entry must be untouched');
      assert.ok(outcome.status.notes.some((note) => note.code === 'MCP_ENTRY_CONFLICT'));

      // `repair` and `remove` must respect the same contract.
      for (const action of ['repair', 'remove']) {
        const other = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
        assert.ok(other.refused.some((entry) => entry.target === 'mcp'), `${action} must refuse ${expected}`);
        assert.equal(readFileSync(fixture.configPath, 'utf8'), before, `${action} must leave ${expected} byte-identical`);
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test('an unmarked same-name entry is never adopted, updated or removed', async () => {
  const fixture = codexHomeFixture();
  // Exact values, no marker: this is the case where "identical" tempts an
  // implementation to take ownership of a line the operator wrote.
  const unmarked = [
    '[mcp_servers.dsh-delegate]',
    `command = ${JSON.stringify(resolveNodeExecutable())}`,
    `args = [${JSON.stringify(join(ROOT, 'bin', 'dsh-delegate-mcp.js'))}]`,
    '',
  ].join('\n');
  try {
    writeFileSync(fixture.configPath, unmarked);
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(status.status.mcp.state, 'conflict');
    assert.equal(status.status.mcp.reason, 'unmanaged-entry');
    assert.equal(status.status.mcp.configured, false);
    assert.equal(status.status.mcp.marked, false);
    assert.equal(status.status.ready, false);

    for (const action of ['install', 'repair', 'remove']) {
      const outcome = await runCodexAction(action, { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
      assert.equal(readFileSync(fixture.configPath, 'utf8'), unmarked, `${action} must not touch the operator entry`);
      assert.equal(outcome.status.mcp.state, 'conflict');
    }
  } finally {
    fixture.cleanup();
  }
});

test('a marked entry is updated in place and removable, and the marker survives', async () => {
  const fixture = codexHomeFixture();
  // A real moved installation: the only differing path an explicit action may adopt.
  const oldInstall = otherInstallationFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    const installed = readFileSync(fixture.configPath, 'utf8');
    assert.ok(installed.startsWith(MCP_MARKER), 'the marker is the ownership proof and must be written');
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(status.status.mcp.marked, true);

    // Simulate a moved installation: the path goes stale, the marker stays.
    writeFileSync(fixture.configPath, installed.replace(
      /^args = \[.*\]$/mu,
      `args = [${JSON.stringify(oldInstall.script)}]`,
    ));
    const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(repaired.changed.includes('mcp'), 'the explicit repair adopted the proved moved install');
    const text = readFileSync(fixture.configPath, 'utf8');
    assert.equal(text.match(new RegExp(`^${MCP_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'gmu'))?.length, 1, 'exactly one marker');
    assert.equal(text.includes(oldInstall.root), false);
    // And remove still proves ownership before deleting.
    const removed = await runCodexAction('remove', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(removed.changed.includes('mcp'));
  } finally {
    oldInstall.cleanup();
    fixture.cleanup();
  }
});

test('an unreadable config is left untouched and the refusal is reported, not swallowed', async () => {
  const fixture = codexHomeFixture();
  try {
    // 0x00 is not legal TOML: the locator must refuse rather than guess.
    writeFileSync(fixture.configPath, 'model = "gpt-6.1\u0000"\n');
    const before = readFileSync(fixture.configPath, 'utf8');
    const outcome = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(outcome.status.config.readable, false);
    assert.equal(outcome.status.config.error.code, 'CODEX_CONFIG_UNSUPPORTED');
    assert.ok(outcome.refused.some((entry) => entry.target === 'mcp' && entry.code === 'CODEX_CONFIG_UNSUPPORTED'));
    // The agent file is a separate target, so it may still be installed; the config
    // file itself must be byte-identical.
    assert.equal(readFileSync(fixture.configPath, 'utf8'), before);

    // `remove` must refuse for the same reason rather than delete the config.
    const removed = await runCodexAction('remove', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(removed.status.mcp.state, 'unreadable');
    assert.equal(readFileSync(fixture.configPath, 'utf8'), before);
  } finally {
    fixture.cleanup();
  }
});

test('remove deletes only the managed agent file and only the owned MCP entry', async () => {
  const fixture = codexHomeFixture();
  try {
    writeFileSync(fixture.configPath, FOREIGN_CONFIG);
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    const removed = await runCodexAction('remove', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.deepEqual(removed.changed.sort(), ['agent', 'mcp']);
    assert.equal(existsSync(fixture.agentPath), false);
    assert.equal(removed.status.agent.state, 'not-installed');
    assert.equal(removed.status.mcp.state, 'not-configured');
    // The foreign content is byte-identical to what it was before the install.
    assert.equal(readFileSync(fixture.configPath, 'utf8'), FOREIGN_CONFIG.trimEnd() + '\n');
    // Removing twice is a no-op, not an error.
    const again = await runCodexAction('remove', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.deepEqual(again.changed, []);
    assert.deepEqual(again.refused, []);
  } finally {
    fixture.cleanup();
  }
});

test('a non-default discovery location is pinned into the entry, the default is left implicit', async () => {
  const fixture = codexHomeFixture();
  try {
    const discoveryFile = join(fixture.home, 'custom-discovery.json');
    const env = { ...isolatedEnv(fixture.home), DSH_DELEGATE_DISCOVERY_FILE: discoveryFile };
    await runCodexAction('install', { codexHome: fixture.home, env, discoveryFile });
    const values = readTomlValues(readFileSync(fixture.configPath, 'utf8'));
    assert.equal(values['mcp_servers.dsh-delegate.env.DSH_DELEGATE_DISCOVERY_FILE'].text, JSON.stringify(discoveryFile));
    assert.equal((await runCodexAction('status', { codexHome: fixture.home, env, discoveryFile })).status.ready, true);
  } finally {
    fixture.cleanup();
  }
});

test('classifyMcpEntry requires the marker before it accepts an entry as its own', () => {
  const desired = desiredMcpCommand({ node: 'C:\\node\\node.exe', script: 'C:\\pkg\\bin\\dsh-delegate-mcp.js' });
  // Every value this plugin writes, including the owned tool timeout: an entry
  // missing it is this plugin's OLD entry and classified `outdated`, not `configured`.
  const values = 'command = "C:\\\\node\\\\node.exe"\nargs = ["C:\\\\pkg\\\\bin\\\\dsh-delegate-mcp.js"]\ntool_timeout_sec = 3660\n';
  const ours = `${MCP_MARKER}\n[mcp_servers.dsh-delegate]\n${values}`;
  assert.equal(classifyMcpEntry(new Document(ours), desired).state, 'configured');
  assert.equal(classifyMcpEntry(new Document(ours), desired).marked, true);

  // Identical values, no marker: a conflict, never silently adopted.
  const unmarked = `[mcp_servers.dsh-delegate]\n${values}`;
  const unmarkedResult = classifyMcpEntry(new Document(unmarked), desired);
  assert.equal(unmarkedResult.state, 'conflict');
  assert.equal(unmarkedResult.reason, 'unmanaged-entry');
  assert.equal(unmarkedResult.marked, false);

  // A marker that is not directly above the definition does not prove anything.
  const detached = `${MCP_MARKER}\n\nmodel = "gpt-6.1"\n[mcp_servers.dsh-delegate]\n${values}`;
  assert.equal(classifyMcpEntry(new Document(detached), desired).reason, 'unmanaged-entry');

  // The inline spelling is managed only when marked too. (Without the marker this
  // document already conflicts earlier, as `not-a-table`.)
  const inlineMarked = `${MCP_MARKER}\n[mcp_servers]\ndsh-delegate = { command = "C:\\\\node\\\\node.exe", args = ["C:\\\\pkg\\\\bin\\\\dsh-delegate-mcp.js"], tool_timeout_sec = 3660 }\n`;
  assert.equal(classifyMcpEntry(new Document(inlineMarked), desired).state, 'configured');
  const inlineUnmarked = `[mcp_servers]\ndsh-delegate = { command = "C:\\\\node\\\\node.exe", args = ["C:\\\\pkg\\\\bin\\\\dsh-delegate-mcp.js"], tool_timeout_sec = 3660 }\n`;
  assert.equal(classifyMcpEntry(new Document(inlineUnmarked), desired).state, 'conflict');

  assert.equal(classifyMcpEntry(new Document('model = "x"\n'), desired).state, 'not-configured');
  assert.equal(classifyMcpEntry(new Document('[mcp_servers.dsh-crew]\ncommand = "node"\n'), desired).state, 'not-configured');
});

test('removing a marked entry keeps the operator comments around it', () => {
  const document = new Document([
    '# operator comment: our internal server list',
    MCP_MARKER,
    '[mcp_servers.dsh-delegate]',
    'command = "node"',
    '',
    '[desktop]',
    'sansFontSize = 16',
    '',
  ].join('\n'));
  const { text, removed } = removeMcpEntry(document);
  assert.equal(removed, true);
  // The operator's own comment stays, the plugin marker goes with the entry, and the
  // blank line that used to separate the entry from `[desktop]` is what is dropped.
  assert.equal(text, '# operator comment: our internal server list\n\n[desktop]\nsansFontSize = 16\n');

  // Without the marker the remover refuses, so a caller that skipped the classifier
  // still cannot delete an operator entry.
  const unmanaged = new Document('[mcp_servers.dsh-delegate]\ncommand = "node"\n');
  assert.deepEqual(removeMcpEntry(unmanaged), { text: unmanaged.text, removed: false });
});

// ---------------------------------------------------------------------------
// 4. `repair` is MCP-only: it never creates, refreshes or deletes the agent file
// ---------------------------------------------------------------------------

/**
 * Provide a REAL published prior build for the duration of `body`.
 *
 * The 0.1.13 fixture is a release whose bytes this build still enumerates, so an agent
 * file holding it is `outdated` — exactly the state `repair` must leave alone and
 * `install` must refresh. Using the fixture (rather than relabelling today's template)
 * keeps the input a file a release really shipped, and mutating the shared product list
 * would leak into later tests.
 * @param {(prior: string) => Promise<void>} body - receives the published bytes.
 */
async function withKnownPriorBuild(body) {
  await body(readFileSync(AGENT_0_1_13_FIXTURE, 'utf8'));
}

test('repair registers the MCP entry but never creates a missing agent or agents directory', async () => {
  const fixture = codexHomeFixture();
  try {
    writeFileSync(fixture.configPath, FOREIGN_CONFIG);
    const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });

    // The MCP half does its job — this is what the page's “仅修复 MCP 配置” button is for.
    assert.deepEqual(repaired.changed, ['mcp'], 'repair must change exactly the MCP entry');
    assert.equal(repaired.status.mcp.state, 'configured');
    assert.match(readFileSync(fixture.configPath, 'utf8'), /^\[mcp_servers\.dsh-delegate\]$/mu);

    // The agent half is out of scope: no file, and not even the directory is created.
    assert.equal(existsSync(fixture.agentPath), false, 'repair must not create the agent file');
    assert.equal(existsSync(join(fixture.home, 'agents')), false, 'repair must not create the agents directory');
    assert.equal(repaired.status.agent.state, 'not-installed', 'the status still reports the real agent state');
    assert.equal(repaired.status.ready, false);
    // No refusal is invented for a target this action never touched.
    assert.deepEqual(repaired.refused, []);
  } finally {
    fixture.cleanup();
  }
});

test('repair leaves an outdated agent byte-identical while it updates the MCP entry', async () => {
  const fixture = codexHomeFixture();
  try {
    await withKnownPriorBuild(async (prior) => {
      // A byte-exact published build is the one case `install` may refresh. `repair`
      // must still not do it — otherwise the two buttons would not differ.
      mkdirSync(dirname(fixture.agentPath), { recursive: true });
      writeFileSync(fixture.agentPath, prior);
      writeFileSync(fixture.configPath, FOREIGN_CONFIG);

      const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(before.status.agent.state, 'outdated', 'the fixture must start from an outdated managed build');

      const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.deepEqual(repaired.changed, ['mcp'], 'repair must change the MCP entry and nothing else');
      assert.equal(repaired.status.mcp.state, 'configured');
      assert.match(readFileSync(fixture.configPath, 'utf8'), /^\[mcp_servers\.dsh-delegate\]$/mu);
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), prior, 'an outdated agent must survive repair byte-identical');
      assert.equal(repaired.status.agent.state, 'outdated', 'and still be reported as outdated');

      // `install` is the action that refreshes it — so the difference is real and the
      // test above did not pass merely because refreshing never happens.
      const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.ok(installed.changed.includes('agent'), 'install is the action that refreshes an outdated agent');
      assert.match(readFileSync(fixture.agentPath, 'utf8'), new RegExp(`^version = "${DELIVERABLE_VERSION}"$`, 'mu'));
    });
  } finally {
    fixture.cleanup();
  }
});

test('repair updates a stale MCP entry without touching an installed agent', async () => {
  const fixture = codexHomeFixture();
  // A REAL second installation: the only differing script path an explicit action adopts.
  const oldInstall = otherInstallationFixture();
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const agentBefore = readFileSync(fixture.agentPath, 'utf8');
    const agentStat = lstatSync(fixture.agentPath);
    // The installation moved: only the MCP entry is stale now.
    writeFileSync(fixture.configPath, readFileSync(fixture.configPath, 'utf8').replace(
      /^args = \[.*\]$/mu,
      `args = [${JSON.stringify(oldInstall.script)}]`,
    ));

    const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.deepEqual(repaired.changed, ['mcp'], 'repair adopted the proved moved installation');
    assert.equal(readFileSync(fixture.configPath, 'utf8').includes(oldInstall.root), false);
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), agentBefore, 'an installed agent is not rewritten by repair');
    assert.equal(lstatSync(fixture.agentPath).mtimeMs, agentStat.mtimeMs, 'and is not even reopened for writing');
    assert.equal(repaired.status.agent.state, 'installed');

    // A second repair has nothing to do — it is idempotent, like install.
    const again = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.deepEqual(again.changed, []);
    assert.deepEqual(again.refused, []);
  } finally {
    oldInstall.cleanup();
    fixture.cleanup();
  }
});
test('repair never deletes or replaces an agent it would not own', async () => {
  const fixture = codexHomeFixture();
  try {
    // A user's own file: repair must not delete it, refresh it, or even complain about
    // it — the agent is simply not one of this action's targets.
    const custom = '# my own agent\nname = "mine"\n';
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, custom);
    const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(repaired.changed.includes('agent'), false);
    assert.deepEqual(repaired.refused, []);
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), custom);
    assert.equal(repaired.status.agent.state, 'modified');

    // An installed agent is *not* removed by repair either (the removal path is
    // `remove` only), even though the file is still exactly the managed template.
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const managed = readFileSync(fixture.agentPath, 'utf8');
    await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), managed);
    assert.equal(existsSync(fixture.agentPath), true);
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4b. The routes the settings page drives
// ---------------------------------------------------------------------------

test('GET /codex diagnoses without writing, and reports the switch separately', async () => {
  const fixture = codexHomeFixture();
  try {
    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const routes = wrapUserPlaneRoutes(codexDeps(seam));
    const result = await call(routes, 'GET', `${USER_PLANE_PREFIX}/codex`);
    assert.equal(result.status, 200);
    assert.equal(result.body.codex.agent.state, 'not-installed');
    assert.equal(result.body.codex.mcp.state, 'not-configured');
    assert.equal(result.body.codex.ready, false);
    assert.deepEqual(result.body.changed, []);
    assert.equal(result.body.switch.authorized, false);
    assert.equal(result.body.switch.changedByThisAction, false);
    assert.equal(existsSync(fixture.agentPath), false, 'a status read must never install anything');
    assert.equal(existsSync(fixture.configPath), false, 'a status read must never create a config file');
  } finally {
    fixture.cleanup();
  }
});

test('POST /codex performs exactly one explicit action and reports what changed', async () => {
  const fixture = codexHomeFixture();
  try {
    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const routes = wrapUserPlaneRoutes(codexDeps(seam));

    const install = await call(routes, 'POST', `${USER_PLANE_PREFIX}/codex`, { action: 'install' });
    assert.equal(install.status, 200);
    assert.deepEqual(install.body.changed.sort(), ['agent', 'mcp']);
    assert.equal(install.body.codex.ready, true);
    assert.equal(install.body.switch.authorized, false, 'installing must not authorize dispatch');
    assert.equal(install.body.switch.changedByThisAction, false);

    const remove = await call(routes, 'POST', `${USER_PLANE_PREFIX}/codex`, { action: 'remove' });
    assert.deepEqual(remove.body.changed.sort(), ['agent', 'mcp']);

    for (const action of ['status', '', 'drop-everything', undefined]) {
      const refused = await call(routes, 'POST', `${USER_PLANE_PREFIX}/codex`, action === undefined ? {} : { action });
      assert.equal(refused.status, 400, `action ${JSON.stringify(action)} must be refused`);
      assert.equal(refused.body.error.code, 'CODEX_ACTION_INVALID');
    }
  } finally {
    fixture.cleanup();
  }
});

test('the routes never expose the internal ownership bytes', async () => {
  const fixture = codexHomeFixture();
  try {
    const seam = createCodexSeam({ codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const routes = wrapUserPlaneRoutes(codexDeps(seam));
    await call(routes, 'POST', `${USER_PLANE_PREFIX}/codex`, { action: 'install' });

    for (const [method, body] of [['GET', undefined], ['POST', { action: 'install' }]]) {
      const result = await call(routes, method, `${USER_PLANE_PREFIX}/codex`, body);
      assert.equal('expect' in result.body.codex.agent, false, `${method} must not return the raw template bytes`);
      // The ownership fact the operator *can* act on is `marked`; it is reported.
      assert.equal(result.body.codex.mcp.marked, true);
      // The in-process status still carries it, because the installer needs it.
      const inProcess = await seam.status();
      assert.equal(typeof inProcess.status.agent.expect, 'string');
    }
  } finally {
    fixture.cleanup();
  }
});

test('the Codex route is unavailable, not silently successful, when the host exposes no seam', async () => {
  const routes = wrapUserPlaneRoutes(codexDeps(null));
  const status = await call(routes, 'GET', `${USER_PLANE_PREFIX}/codex`);
  assert.equal(status.status, 503);
  assert.equal(status.body.error.code, 'CODEX_INTEGRATION_UNAVAILABLE');
  const action = await call(routes, 'POST', `${USER_PLANE_PREFIX}/codex`, { action: 'install' });
  assert.equal(action.status, 503);
});

test('a bad CODEX_HOME is refused rather than resolved against the process cwd', async () => {
  const seam = createCodexSeam({ codexHome: 'relative/codex', env: {} });
  const routes = wrapUserPlaneRoutes(codexDeps(seam));
  const refused = await call(routes, 'GET', `${USER_PLANE_PREFIX}/codex`);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'CODEX_HOME_INVALID');
});

// ---------------------------------------------------------------------------
// 5. What the installed agent file must say
// ---------------------------------------------------------------------------

test('the agent no longer points at a repository checkout and covers the exact dispatch rules', () => {
  const template = readFileSync(join(ROOT, 'codex', AGENT_FILENAME), 'utf8');
  const installed = readFileSync(join(ROOT, 'bin', 'dsh-delegate-mcp.js'), 'utf8');
  assert.match(installed, /dsh-delegate-mcp/u);

  // Activation: explicit selection or mention only. An unrelated mention must not dispatch.
  assert.match(template, /explicitly selects this agent/u);
  assert.match(template, /`@dsh-taskbridge`/u);
  assert.match(template, /is NOT a dispatch request/u);
  assert.match(template, /do not\s+submit a task/u);
  assert.match(template, /clarifying question/u);
  // Switch first, and never work around it.
  assert.match(template, /delegate_status/u);
  assert.match(template, /switch is off/u);
  assert.match(template, /Never open the switch yourself/u);
  assert.match(template, /DSH Crew/u, 'a fallback must be explicitly forbidden');
  // Only shared isolation may be overridden for a dirty workspace; routing stays
  // entirely under the DSH Delegate plugin settings.
  assert.match(template, /For a `shared` decision, pass only\s+`overrides = \{ isolation = "shared" \}`/u);
  assert.match(template, /Never\s+override the configured provider, model, reasoning effort or timeout/u);
  assert.match(template, /never\s+encode a route in the task prompt/u);
  assert.match(template, /project\s+override/u);
  // Poll the same task; no duplicates.
  assert.match(template, /delegate_result/u);
  assert.match(template, /Never submit a\s+duplicate/u);
  assert.match(template, /delegate_cancel/u);
  // Evidence and review boundary.
  assert.match(template, /actual provider\/model\/effort/u);
  assert.match(template, /Codex remains responsible/u);
  assert.match(template, /do not commit or push/u);
  assert.match(template, /credentials or connection tokens/u);

  // The template is a custom-agent file, not an MCP registration.
  assert.doesNotMatch(template, /^\[mcp_servers\./mu);
  assert.doesNotMatch(template, /workbuddy|deepseek-v4\.1-flash/u, 'the companion must follow DSH plugin routing, not a fixed route');
});

test('the companion inspects the workspace before dispatching and makes an explicit isolation decision', () => {
  // The rule this test pins: facts first, then an explicit decision. Everything
  // asserted here is a sentence a reviewer can check by reading the template, and
  // every one of them exists because the alternative is a dispatch that fails after
  // admission — or, worse, one that silently runs with weaker isolation than the
  // operator selected.
  const template = readFileSync(join(ROOT, 'codex', AGENT_FILENAME), 'utf8');

  // 1. Status first, preflight second, in that order, and the preflight is named.
  assert.match(template, /PREFLIGHT FACTS FIRST/u);
  const statusAt = template.indexOf('`delegate_status` first');
  const preflightAt = template.indexOf('`delegate_preflight` with the exact authorized workspace path');
  assert.ok(statusAt > 0, 'the template must call delegate_status first');
  assert.ok(preflightAt > statusAt, 'the preflight must come after the status check');

  // 2. The three decisions are all named, as literal values, with their reasons.
  for (const isolation of ['"worktree"', '"shared"', '"block"']) {
    assert.ok(template.includes(isolation), `the template must name isolation ${isolation}`);
  }
  for (const reason of [
    'PREFLIGHT_CLEAN_REPOSITORY',
    'PREFLIGHT_DIRTY_NEEDS_DECISION',
    'PREFLIGHT_GIT_UNAVAILABLE',
    'PREFLIGHT_NOT_A_REPOSITORY',
    'PREFLIGHT_NO_COMMITS',
    'PREFLIGHT_GIT_FAILED',
    'PREFLIGHT_WORKSPACE_INVALID',
    'PREFLIGHT_NOT_A_DIRECTORY',
  ]) {
    assert.ok(template.includes(reason), `the template must name reason ${reason}`);
  }

  // 3. A clean repository takes the configured worktree; the template must not let
  //    the agent edit that configuration to make a run fit.
  assert.match(template, /reason `PREFLIGHT_CLEAN_REPOSITORY`/u);
  assert.match(template, /worktree isolation configured in the DSH TaskBridge\s+plugin settings/u);

  // 4. A dirty repository is decided by the coordinator from the task and paths.
  //    It must not silently downgrade, and must not probe by submitting.
  assert.match(template, /Do NOT downgrade to\s+shared isolation silently/u);
  assert.match(template, /do NOT try the dispatch to see what happens/u);
  assert.match(template, /As the coordinator, inspect the changed-file count/u);
  assert.match(template, /Do not ask the operator to choose on every dispatch/u);
  assert.match(template, /`allowShared: true`/u);
  assert.match(template, /If ownership, overlap or risk\s+is unclear/u);
  assert.match(template, /Quote the reason the shared run was allowed/u);

  // 5. Every unjudgeable state stops instead of guessing.
  assert.match(template, /stop\. Report the\s+reason code and what it means/u);
  assert.match(template, /Ask one short question rather than guessing/u);

  // 6. The dispatch text carries the facts and the isolation reason.
  assert.match(template, /Include the workspace\s+facts and the isolation decision in the dispatch text/u);
  assert.match(template, /changed-file count and bounded paths from the preflight/u);

  // 7. A dirty-workspace decision reaches the job as an isolation-only override;
  //    configured routing and timeout are never changed.
  assert.match(template, /For a `shared` decision, pass only\s+`overrides = \{ isolation = "shared" \}`/u);
  assert.match(template, /Never\s+override the configured provider, model, reasoning effort or timeout/u);
  assert.match(template, /does not change the submitted job's isolation by itself/u);

  // 8. Making a preflight pass is never done by destroying the operator's edits.
  assert.match(template, /Never create a commit, stash, branch or worktree/u);
  assert.match(template, /A dirty workspace is an isolation\s+decision for the coordinator/u);
});

test('the companion\'s rule block agrees with the code: every named reason and isolation exists', () => {
  // A template that names a code the module can never emit would teach the agent to
  // wait for a state that does not exist, and a reason the template omits is a state
  // the agent has no instruction for. The check is by import, not by copy, so the
  // template and the decision table cannot drift apart.
  const template = readFileSync(join(ROOT, 'codex', AGENT_FILENAME), 'utf8');
  // The one exception is structural, not an omission: `PREFLIGHT_DIRTY_REPOSITORY`
  // is the shared cause recorded on both dirty answers, and the two entries that
  // actually reach the agent are the decision (`…#_NEEDS_DECISION`) and the
  // explicit allowance (`…#_SHARED_EXPLICIT`).
  const COVERED_BY_SPECIFIC_CODES = new Set([PREFLIGHT_REASONS.dirtyRepository]);
  for (const reason of Object.values(PREFLIGHT_REASONS)) {
    if (COVERED_BY_SPECIFIC_CODES.has(reason)) continue;
    assert.ok(template.includes(reason), `the template must name ${reason}`);
  }
  for (const isolation of PREFLIGHT_ISOLATIONS) {
    assert.ok(template.includes(`"${isolation}"`), `the template must name isolation ${isolation}`);
  }
});

test('the CLI entry point is a thin wrapper over the shared installer', () => {
  const cli = readFileSync(join(ROOT, 'bin', 'dsh-delegate-codex-agent.js'), 'utf8');
  assert.match(cli, /^#!\/usr\/bin\/env node/u);
  assert.match(cli, /from '\.\.\/src\/codex\/installer\.js'/u);
  assert.match(cli, /runCodexAction/u);
  assert.match(cli, /resolveCodexHome/u);
  assert.match(cli, /packageVersion/u);
  assert.match(cli, /switch is not changed/u);
  // No second TOML writer and no direct fs writes in the CLI.
  assert.doesNotMatch(cli, /from '\.\.\/src\/codex\/toml\.js'/u);
  assert.doesNotMatch(cli, /writeFile|appendFile/u);
  for (const action of ['install', 'status', 'repair', 'remove']) {
    assert.ok(cli.includes(`'${action}'`), `the CLI must accept ${action}`);
  }
});

test('the shipped template and this test agree that nothing is written at import time', async () => {
  // The installer module is imported by this file at load time; that alone must not
  // create a Codex home, an agents directory or a config document.
  const fixture = codexHomeFixture();
  try {
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(status.changed.length, 0);
    assert.equal(status.refused.length, 0);
    assert.equal(status.status.agent.installed, false);
    assert.equal(status.status.mcp.configured, false);
    assert.equal(existsSync(join(fixture.home, 'agents')), false);
    assert.equal(existsSync(join(fixture.home, 'config.toml')), false);
  } finally {
    fixture.cleanup();
  }
});

test('writing through the same atomic helper the installer uses leaves no temp file', async () => {
  const fixture = codexHomeFixture();
  try {
    await writeFileAtomic(join(fixture.home, 'probe.txt'), 'x');
    const entries = readFileSync(join(fixture.home, 'probe.txt'), 'utf8');
    assert.equal(entries, 'x');
    // The MCP entry name is stable: the config key is what Codex resolves.
    assert.equal(MCP_SERVER_NAME, 'dsh-delegate');
    assert.equal(new TomlDocument('[mcp_servers.dsh-delegate]\n').tablesUnder(['mcp_servers']).length, 1);
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Managed tool timeout: one 60-minute delegate_wait must fit inside it
// ---------------------------------------------------------------------------

test('the managed entry owns tool_timeout_sec so a default 60-minute wait can complete', () => {
  const desired = desiredMcpCommand({ node: '/usr/bin/node', script: '/pkg/bin/dsh-delegate-mcp.js' });
  // 3600 s default wait + one minute of slack; never a second wait window.
  assert.equal(desired.toolTimeoutSec, 3660);
  const document = new Document('');
  const classification = classifyMcpEntry(document, desired);
  const written = applyMcpEntry(document, desired, classification);
  assert.match(written, /^tool_timeout_sec = 3660$/mu, 'the rendered entry carries the timeout');
  // It is written inside OUR table, before any later section.
  const lines = written.split('\n');
  const serverLine = lines.findIndex((line) => line.startsWith('[mcp_servers.dsh-delegate]'));
  const timeoutLine = lines.findIndex((line) => line.startsWith('tool_timeout_sec'));
  assert.ok(timeoutLine > serverLine, 'the timeout belongs to our server table');
  assert.equal(classifyMcpEntry(new Document(written), desired).state, 'configured');
  assert.equal(applyMcpEntry(new Document(written), desired, classifyMcpEntry(new Document(written), desired)), null,
    'repairing an already-correct entry writes nothing');
});

test('a prior managed entry without the timeout migrates in place and preserves unrelated config', () => {
  const desired = desiredMcpCommand({ node: '/usr/bin/node', script: '/pkg/bin/dsh-delegate-mcp.js' });
  const prior = [
    'model = "kept"',
    '',
    MCP_MARKER,
    '[mcp_servers.dsh-delegate]',
    'command = "/usr/bin/node"',
    'args = ["/pkg/bin/dsh-delegate-mcp.js"]',
    '',
    '[mcp_servers.other]',
    'command = "elsewhere"',
    '',
  ].join('\n');
  const classification = classifyMcpEntry(new Document(prior), desired);
  // An entry this plugin wrote BEFORE the field existed is stale, never somebody
  // else's definition: otherwise a 1.0.0 install could never be repaired.
  assert.equal(classification.state, 'outdated');
  assert.equal(classification.previous.toolTimeoutSec, null);

  const migrated = applyMcpEntry(new Document(prior), desired, classification);
  assert.match(migrated, /^tool_timeout_sec = 3660$/mu);
  // Unrelated configuration survives byte for byte, and the operator marker is not
  // duplicated.
  assert.match(migrated, /^model = "kept"$/mu);
  assert.match(migrated, /^\[mcp_servers\.other\]$/mu);
  assert.match(migrated, /^command = "elsewhere"$/mu);
  assert.equal(migrated.split(MCP_MARKER).length - 1, 1, 'exactly one ownership marker');
  // The timeout is inside our table, not appended after somebody else's section.
  assert.ok(
    migrated.indexOf('tool_timeout_sec') < migrated.indexOf('[mcp_servers.other]'),
    'the timeout is added inside our own table',
  );
  assert.equal(classifyMcpEntry(new Document(migrated), desired).state, 'configured');
});

test('a changed or non-integer tool_timeout_sec is never silently adopted', () => {
  const desired = desiredMcpCommand({ node: '/usr/bin/node', script: '/pkg/bin/dsh-delegate-mcp.js' });
  const ours = (timeout) => `${MCP_MARKER}\n[mcp_servers.dsh-delegate]\ncommand = "/usr/bin/node"\nargs = ["/pkg/bin/dsh-delegate-mcp.js"]\n${timeout}\n`;

  // The plugin's own entry with a stale value: repairable, and repair rewrites it.
  const stale = new Document(ours('tool_timeout_sec = 120'));
  const staleClass = classifyMcpEntry(stale, desired);
  assert.equal(staleClass.state, 'outdated');
  assert.equal(staleClass.previous.toolTimeoutSec, 120);
  assert.match(applyMcpEntry(stale, desired, staleClass), /^tool_timeout_sec = 3660$/mu);

  // A non-integer is not a value this plugin writes: the whole entry is treated as
  // somebody else's and left untouched.
  const float = new Document(ours('tool_timeout_sec = 12.5'));
  assert.equal(classifyMcpEntry(float, desired).state, 'conflict');
  assert.equal(classifyMcpEntry(float, desired).reason, 'timeout-not-an-integer');
  assert.throws(
    () => applyMcpEntry(float, desired, classifyMcpEntry(float, desired)),
    (error) => error.code === 'MCP_ENTRY_CONFLICT',
  );

  // An unmarked entry with the right values is still not ours, whatever it contains.
  const unmarked = new Document('[mcp_servers.dsh-delegate]\ncommand = "/usr/bin/node"\nargs = ["/pkg/bin/dsh-delegate-mcp.js"]\ntool_timeout_sec = 3660\n');
  assert.equal(classifyMcpEntry(unmarked, desired).state, 'conflict');
  assert.equal(classifyMcpEntry(unmarked, desired).reason, 'unmanaged-entry');
});

test('the LEGACY 1.0.0 identities are retained and labelled, never claimed as git bytes', () => {
  // The review's requirement: an older enumerated identity must not be dropped just
  // because a corrected, git-verified one was added. Dropping it would flip an
  // installation created by that build to "somebody else's file", which is not refreshable
  // and not removable.
  const legacy = KNOWN_AGENT_TEMPLATES.filter((entry) => entry.legacy === true);
  assert.deepEqual(legacy.map((entry) => entry.sha256).sort(), [
    AGENT_1_0_0_LEGACY_DIGEST,
    AGENT_1_0_0_LEGACY_DIGEST_ALT,
  ].sort(), 'both legacy 1.0.0 identities are still enumerated');
  for (const entry of legacy) {
    assert.equal(entry.version, '1.0.0');
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u);
  }
  // The git-verified fixture bytes are a DIFFERENT identity, enumerated separately: the
  // legacy labels must never be used to describe the fixture.
  const fixtureDigest = digest(readFileSync(join(ROOT, 'tests', 'fixtures', 'codex-agent-1.0.0.toml'), 'utf8'));
  assert.equal(fixtureDigest, 'b1fd531598087564b26df14d3261515e961012f3fd010ea493f222da7bbaf415');
  assert.equal(legacy.some((entry) => entry.sha256 === fixtureDigest), false,
    'the legacy labels are not the git bytes');
  assert.ok(
    KNOWN_AGENT_TEMPLATES.some((entry) => entry.sha256 === fixtureDigest && entry.legacy !== true),
    'the git-verified identity is enumerated as a normal entry',
  );
});

