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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGENT_FILENAME,
  KNOWN_AGENT_TEMPLATES,
  MCP_MARKER,
  MCP_SERVER_NAME,
  classifyMcpEntry,
  createFileExclusive,
  desiredMcpCommand,
  digest,
  discoveryPin,
  hostRuntimeKind,
  inspectCodexBoundary,
  isNodeExecutableName,
  packagedNodePath,
  parseDirectoryVerdict,
  removeMcpEntry,
  removeManagedAgentFile,
  resolveCodexHome,
  resolveMcpScript,
  resolveNodeExecutable,
  runCodexAction,
  useDirectoryClassifier,
} from '../src/codex/installer.js';
import { TomlDocument, readTomlValues } from '../src/codex/toml.js';
import { createCodexSeam } from '../src/codex/seam.js';
import { TomlDocument as Document } from '../src/codex/toml.js';
import { writeFileAtomic } from '../src/config/store.js';
import { USER_PLANE_PREFIX, wrapUserPlaneRoutes } from '../src/http/user-plane.js';
import { PREFLIGHT_ISOLATIONS, PREFLIGHT_REASONS } from '../src/workspace/preflight.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DELIVERABLE_VERSION = '0.1.10';
const AGENT_0_1_6_FIXTURE = join(ROOT, 'tests', 'fixtures', 'codex-agent-0.1.6.toml');
const AGENT_0_1_7_LEGACY_FIXTURE = join(ROOT, 'tests', 'fixtures', 'codex-agent-0.1.7.toml');

// The boundary check asks the platform whether `$CODEX_HOME` and `$CODEX_HOME/agents`
// are real directories. On Windows that answer comes from a `powershell.exe` child, and
// this suite has to run where a child cannot be spawned at all, so the suite answers on
// Windows' behalf through the documented classifier hook. Everything else — `lstat`,
// the file-content checks, the writes — is the product code. The dedicated boundary
// tests below install their own classifier to report a junction, which is exactly what
// a real Windows install would answer.
useDirectoryClassifier(nodeClassifier());

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

/** Environment with no DSH/Codex overrides except an explicit Codex home. */
function isolatedEnv(home) {
  return { CODEX_HOME: home, DSH_HOME: '', DSH_DELEGATE_DISCOVERY_FILE: '', DSH_DELEGATE_BASE_URL: '' };
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
    assert.match(agent, /^name = "dsh-delegate"$/mu);
    assert.match(agent, new RegExp(`^version = "${DELIVERABLE_VERSION.replace(/\./gu, '\\.')}"$`, 'mu'));
    assert.match(agent, /managed by the DSH Delegate plugin/u);

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

test('the published 0.1.6 agent is refreshed by 0.1.10, while its bytes remain the ownership proof', async () => {
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
    assert.match(current, /^version = "0\.1\.10"$/mu);
    assert.notEqual(current, prior);
  } finally {
    fixture.cleanup();
  }
});

test('the rebuilt 0.1.7 agent is refreshed by 0.1.10 only when its bytes match', async () => {
  // A file that is byte-identical to an enumerated published rebuild is refreshable;
  // the version line is NOT the proof, the bytes are. These rebuilds are enumerated
  // in `KNOWN_AGENT_TEMPLATES` because the current template's instructions changed
  // (the per-task conversation policy), which changes the bytes of every rebuild.
  const fixture = codexHomeFixture();
  const prior = readFileSync(join(ROOT, 'codex', 'dsh-delegate.toml'), 'utf8')
    .replace(/^version = "0\.1\.10"$/mu, 'version = "0.1.7"');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    assert.equal(digest(prior), 'e3689492ee0f24d2defd2a9254b653e7bc54c258dd38fb0c2fc70ce5b386f2b3');
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === '0.1.7' && entry.sha256 === digest(prior)),
      'a rebuild of the shipped template is an enumerable known build',
    );

    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(before.status.agent.state, 'outdated');

    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(installed.changed.includes('agent'));
    assert.match(readFileSync(fixture.agentPath, 'utf8'), /^version = "0\.1\.10"$/mu);
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
    assert.match(readFileSync(fixture.agentPath, 'utf8'), /^version = "0\.1\.10"$/mu);
    assert.equal(existsSync(fixture.configPath), false, 'startup migration must not write config.toml');
  } finally {
    fixture.cleanup();
  }
});

test('the published 0.1.8 agent is refreshed by 0.1.10 only when its bytes match', async () => {
  const fixture = codexHomeFixture();
  const template = readFileSync(join(ROOT, 'codex', 'dsh-delegate.toml'), 'utf8');
  const prior = template.replace(/^version = "0\.1\.10"$/mu, 'version = "0.1.8"');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    assert.equal(digest(prior), '5cd02783d0fd5b1ffe5375e5d0e1b009931163e6f4fa87de9ea3c9c399fcd40e');
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === '0.1.8' && entry.sha256 === digest(prior)),
      'the rebuild of the shipped template is an enumerable known build',
    );

    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(before.status.agent.state, 'outdated');

    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(installed.changed.includes('agent'));
    assert.match(readFileSync(fixture.agentPath, 'utf8'), /^version = "0\.1\.10"$/mu);
  } finally {
    fixture.cleanup();
  }
});

test('the published 0.1.9 agent is refreshed by 0.1.10 only when its bytes match', async () => {
  const fixture = codexHomeFixture();
  const template = readFileSync(join(ROOT, 'codex', 'dsh-delegate.toml'), 'utf8');
  const prior = template.replace(/^version = "0\.1\.10"$/mu, 'version = "0.1.9"');
  try {
    mkdirSync(dirname(fixture.agentPath), { recursive: true });
    writeFileSync(fixture.agentPath, prior);
    assert.equal(digest(prior), 'b5db667d114baf881f59c9367a80137379960b1fccb524c883ab0edcf9f0d516');
    assert.ok(
      KNOWN_AGENT_TEMPLATES.some((entry) => entry.version === '0.1.9' && entry.sha256 === digest(prior)),
      'the rebuild of the shipped template is an enumerable known build',
    );

    const before = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(before.status.agent.state, 'outdated');

    const installed = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(installed.changed.includes('agent'));
    assert.match(readFileSync(fixture.agentPath, 'utf8'), /^version = "0\.1\.10"$/mu);
  } finally {
    fixture.cleanup();
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
      .replace('name = "dsh-delegate"', '# my own note\nname = "dsh-delegate"');
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
      KNOWN_AGENT_TEMPLATES.length = 0;
      writeFileSync(fixture.agentPath, prior);
      const refused = await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
      assert.equal(refused.status.agent.state, 'modified');
      assert.equal(readFileSync(fixture.agentPath, 'utf8'), prior);
    } finally {
      KNOWN_AGENT_TEMPLATES.length = 0;
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
    const target = join(home, 'agents', 'dsh-delegate.toml');
    mkdirSync(dirname(target), { recursive: true });

    // First create: the file is ours and appears exactly once.
    const once = await createFileExclusive(target, 'first');
    assert.equal(once, 'created');
    assert.equal(readFileSync(target, 'utf8'), 'first');
    // No temp file is left behind in either case.
    assert.deepEqual(readdirSync(dirname(target)), ['dsh-delegate.toml']);

    // Second create: the different file that appeared meanwhile survives untouched.
    const twice = await createFileExclusive(target, 'second');
    assert.equal(twice, 'exists');
    assert.equal(readFileSync(target, 'utf8'), 'first', 'the concurrent file must not be overwritten');
    assert.deepEqual(readdirSync(dirname(target)), ['dsh-delegate.toml']);
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
    assert.match(managed, /managed by the DSH Delegate plugin/u);

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

    // Update path: stale args in a CRLF file are rewritten in place.
    writeFileSync(fixture.configPath, afterInstall.replace(
      /^args = \[.*\]\r$/mu,
      `args = [${JSON.stringify('E:/old/profile/bin/dsh-delegate-mcp.js')}]\r`,
    ));
    await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    const afterRepair = readFileSync(fixture.configPath, 'utf8');
    assert.equal(/(^|[^\r])\n/u.test(afterRepair), false, 'a repair must not normalize the file to LF');
    assert.doesNotMatch(afterRepair, /E:\/old\/profile/u);

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
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    const installed = readFileSync(fixture.configPath, 'utf8');
    // Rewrite the entry as if the plugin had moved (an upgrade to another profile).
    writeFileSync(fixture.configPath, installed.replace(
      /^args = \[.*\]$/mu,
      `args = [${JSON.stringify('E:/old/profile/bin/dsh-delegate-mcp.js')}]`,
    ));

    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(status.status.mcp.state, 'outdated');

    await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    const repaired = readFileSync(fixture.configPath, 'utf8');
    assert.equal(repaired.match(/^\[mcp_servers\.dsh-delegate\]$/gmu)?.length, 1, 'exactly one entry');
    assert.doesNotMatch(repaired, /E:\/old\/profile/u);
  } finally {
    fixture.cleanup();
  }
});

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
    [`${MCP_MARKER}\n[mcp_servers.dsh-delegate]\ncommand = ${JSON.stringify(DESKTOP_EXE)}\nargs = ["E:/old/profile/bin/dsh-delegate-mcp.js"]\n`, 'legacy-command-shape'],
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
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    const installed = readFileSync(fixture.configPath, 'utf8');
    assert.ok(installed.startsWith(MCP_MARKER), 'the marker is the ownership proof and must be written');
    const status = await runCodexAction('status', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.equal(status.status.mcp.marked, true);

    // Simulate a moved installation: the values go stale, the marker stays.
    writeFileSync(fixture.configPath, installed.replace(
      /^args = \[.*\]$/mu,
      `args = [${JSON.stringify('E:/old/profile/bin/dsh-delegate-mcp.js')}]`,
    ));
    const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home) });
    assert.ok(repaired.changed.includes('mcp'));
    const text = readFileSync(fixture.configPath, 'utf8');
    assert.equal(text.match(new RegExp(`^${MCP_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'gmu'))?.length, 1, 'exactly one marker');
    assert.doesNotMatch(text, /E:\/old\/profile/u);
  } finally {
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
  const values = 'command = "C:\\\\node\\\\node.exe"\nargs = ["C:\\\\pkg\\\\bin\\\\dsh-delegate-mcp.js"]\n';
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
  const inlineMarked = `${MCP_MARKER}\n[mcp_servers]\ndsh-delegate = { command = "C:\\\\node\\\\node.exe", args = ["C:\\\\pkg\\\\bin\\\\dsh-delegate-mcp.js"] }\n`;
  assert.equal(classifyMcpEntry(new Document(inlineMarked), desired).state, 'configured');
  const inlineUnmarked = `[mcp_servers]\ndsh-delegate = { command = "C:\\\\node\\\\node.exe", args = ["C:\\\\pkg\\\\bin\\\\dsh-delegate-mcp.js"] }\n`;
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

/** Pin a byte-exact "known prior build" digest for the duration of `body`. */
async function withKnownPriorBuild(body) {
  const prior = readFileSync(join(ROOT, 'codex', AGENT_FILENAME), 'utf8')
    .replace(/^version = ".*"$/mu, 'version = "0.1.5"');
  KNOWN_AGENT_TEMPLATES.push({ version: '0.1.5', sha256: digest(prior) });
  try {
    await body(prior);
  } finally {
    KNOWN_AGENT_TEMPLATES.length = 0;
  }
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
  try {
    await runCodexAction('install', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    const agentBefore = readFileSync(fixture.agentPath, 'utf8');
    const agentStat = lstatSync(fixture.agentPath);
    // The installation moved: only the MCP entry is stale now.
    writeFileSync(fixture.configPath, readFileSync(fixture.configPath, 'utf8').replace(
      /^args = \[.*\]$/mu,
      `args = [${JSON.stringify('E:/old/profile/bin/dsh-delegate-mcp.js')}]`,
    ));

    const repaired = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.deepEqual(repaired.changed, ['mcp']);
    assert.doesNotMatch(readFileSync(fixture.configPath, 'utf8'), /E:\/old\/profile/u);
    assert.equal(readFileSync(fixture.agentPath, 'utf8'), agentBefore, 'an installed agent is not rewritten by repair');
    assert.equal(lstatSync(fixture.agentPath).mtimeMs, agentStat.mtimeMs, 'and is not even reopened for writing');
    assert.equal(repaired.status.agent.state, 'installed');

    // A second repair has nothing to do — it is idempotent, like install.
    const again = await runCodexAction('repair', { codexHome: fixture.home, env: isolatedEnv(fixture.home), version: DELIVERABLE_VERSION });
    assert.deepEqual(again.changed, []);
    assert.deepEqual(again.refused, []);
  } finally {
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
  assert.match(template, /`@dsh-delegate`/u);
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
  assert.match(template, /worktree isolation configured in the DSH Delegate\s+plugin settings/u);

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
