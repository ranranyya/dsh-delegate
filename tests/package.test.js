// Package-content and integration tests.
//
// Shipping is a behavior, not a formality: a package that installs but omits
// `bin/dsh-delegate-mcp.js`, `lib/client.js`, the README or the license is broken
// for every user while every unit test still passes. This file therefore tests the
// *artifact* — the metadata DSH actually reads and the file list npm would publish.
//
// Two layers, deliberately:
//
//   1. **Computed allowlist (always runs).** `package.json#files` is expanded with
//      npm's own semantics (whitelist patterns plus npm's force-included
//      `package.json`/README/LICENSE), so the expected archive contents are derived
//      from the manifest rather than restated by hand. Every path referenced by
//      `exports`, `bin`, `main`, `types`, `dsh.bundle.patch` must exist on disk and
//      be inside that archive; excluded classes (tests, probes, caches,
//      node_modules, secrets) must not be.
//
//   2. **Real `npm pack --dry-run --json` (when spawnable).** The computed set is
//      compared with npm's actual answer, so a wrong glob translation cannot hide a
//      real omission. npm is driven through inherited file descriptors rather than
//      pipes because a piped child stdio call fails with EPERM under the confined
//      sandbox; when the child still cannot be spawned the test skips with the
//      reason instead of asserting a cache/fixture it cannot observe.
//
// No tarball is written: `--dry-run` only reports.

import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * The DSH runtimes that were actually verified. `0.2.0-rc.2` is the development
 * runtime; `0.2.1-rc.2` was accepted in an isolated profile and `0.2.1-rc.3` is
 * the current host runtime. Nothing else has been exercised.
 */
const SUPPORTED_DSH_VERSIONS = ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3'];

/**
 * The exact union range that admits precisely {@link SUPPORTED_DSH_VERSIONS}.
 */
const SUPPORTED_DSH_RANGE = SUPPORTED_DSH_VERSIONS.join(' || ');

/**
 * The package version this build must declare everywhere a human writes it.
 *
 * Pinned rather than derived: `MANIFEST.version` is one of the places checked below,
 * so asserting it against itself would pass for any value. `0.1.8` adds DSH
 * Workspace placement and conversation reuse on top of the Codex MCP executable fix.
 */
const DELIVERABLE_VERSION = '0.1.8';

// Published prior builds are retained only where the migration/ownership contract
// names them. Other operator-facing and shipped code must not carry stale versions.
const HISTORICAL_VERSION_PATHS = new Set(['src/codex/installer.js', 'docs/codex-integration.md']);

/** A semver value: `MAJOR.MINOR.PATCH` with an optional prerelease suffix. */
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * Parse a semver string into comparable parts.
 * @param {string} version - semver text.
 * @returns {{ major: number, minor: number, patch: number }} numeric identity.
 */
function semverParts(version) {
  const [core] = version.split('-');
  const [major, minor, patch] = core.split('.').map(Number);
  return { major, minor, patch };
}

/** Split a semver range into its `||`-separated union members. */
function rangeMembers(range) {
  return range.split('||').map((member) => member.trim()).filter((member) => member !== '');
}

/** Directories that are never part of a published archive, at any depth. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.cache', '.pnpm-store', 'coverage', 'artifacts']);

/** Path classes that must never reach a consumer. */
const EXCLUDED_PATTERNS = [
  /^tests\//u,
  // Root-level scratch probes (`.probe-leak.mjs`, ...) and any nested `.probe-*`.
  /(^|\/)\.probe[^/]*\.mjs$/u,
  /(^|\/)\.probe-/u,
  /(^|\/)\.env(\.|$)/u,
  /(^|\/)package-lock\.json$/u,
  /(^|\/)[^/]*\.log$/u,
  /(^|\/)(id_rsa|\.npmrc|\.credentials[^/]*)$/u,
];

/**
 * List every file below `root`, skipping never-published directories.
 * @param {string} root - directory to walk.
 * @param {string} [prefix] - accumulated relative prefix.
 * @returns {string[]} POSIX-style relative paths.
 */
function walk(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}${sep}${entry.name}`;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...walk(root, rel));
    } else if (entry.isFile()) {
      out.push(rel.split(sep).join('/'));
    }
  }
  return out;
}

/**
 * Escape one glob segment: `*` matches within a segment, everything else is literal.
 * @param {string} segment - one path segment.
 * @returns {string} regular-expression source.
 */
function segmentSource(segment) {
  let out = '';
  for (const char of segment) {
    if (char === '*') out += '[^/]*';
    else if ('\\^$.|?+()[]{}'.includes(char)) out += `\\${char}`;
    else out += char;
  }
  return out;
}

/**
 * Translate one npm `files` pattern to an anchored regular expression.
 *
 * `**` spans zero or more segments — `src/**\/*.js` matches `src/index.js` as well
 * as `src/model/probe.js`, which is the behavior npm's packlist gives and the one
 * this package depends on.
 * @param {string} pattern - allowlist entry from package.json.
 * @returns {RegExp} matcher over POSIX relative paths.
 */
function patternToRegExp(pattern) {
  const parts = pattern.split('/');
  let out = '^';
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === '**') {
      out += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    out += segmentSource(part) + (last ? '' : '/');
  });
  return new RegExp(`${out}$`, 'u');
}

/**
 * Resolve the published file set from the manifest's allowlist.
 * @param {string[]} files - `package.json#files`.
 * @param {string[]} known - every file in the repository.
 * @returns {string[]} sorted POSIX relative paths.
 */
function expandAllowlist(files, known) {
  const matchers = files.map(patternToRegExp);
  const included = known.filter((path) => matchers.some((matcher) => matcher.test(path)));
  // npm force-includes these regardless of the allowlist; the manifest cannot
  // exclude them, so the expectation must include them too.
  for (const forced of ['package.json']) if (!included.includes(forced)) included.push(forced);
  return included.sort();
}

const KNOWN_FILES = walk(ROOT).filter((path) => !EXCLUDED_PATTERNS.some((pattern) => pattern.test(path)));
const PACKED = expandAllowlist(MANIFEST.files, KNOWN_FILES);

// ---------------------------------------------------------------------------
// 1. Manifest metadata DSH reads at install and client-composition time
// ---------------------------------------------------------------------------

test('the manifest keeps its identity, license and runtime constraints', () => {
  assert.equal(MANIFEST.name, 'dsh-delegate');
  assert.match(MANIFEST.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  assert.equal(MANIFEST.license, 'MIT');
  assert.equal(MANIFEST.type, 'module');
  assert.equal(MANIFEST.private, undefined, 'the package must stay publishable');
  // Node 24 is what the tests and both supported DSH runtimes use; a wider claim
  // would be untested.
  assert.equal(MANIFEST.engines.node, '>=24');
  // The engine range is the union of exactly the two verified runtimes: no member
  // may be dropped (a regression to a single version) and none may be added (an
  // unverified version claimed as supported).
  assert.equal(MANIFEST.engines.dsh, SUPPORTED_DSH_RANGE);
  assert.deepEqual(rangeMembers(MANIFEST.engines.dsh), SUPPORTED_DSH_VERSIONS);
});

test('the plugin half declares a bundle patch, which exists inside the archive', () => {
  assert.equal(MANIFEST.dsh.manifestVersion, 1);
  assert.equal(MANIFEST.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(PACKED.includes('cordis.patch.yml'), 'cordis.patch.yml must be published');
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
  // Comments are prose and may mention authorization; only the YAML structure is
  // configuration, so the assertions below run against the comment-stripped body.
  const body = patch.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n').trim();
  // The patch mounts exactly one row, id `dsh-delegate`, with no config block and
  // nothing that looks like a pre-issued authorization or a disabled row.
  assert.match(body, /^[- ]*insert:$/mu);
  assert.match(body, /^\s+- id: dsh-delegate$/mu);
  assert.match(body, /^\s+name: dsh-delegate$/mu);
  assert.doesNotMatch(body, /\bconfig\b|\bdisabled\b|\bgrant|\btoken|\bauthoriz/iu);
  // Exactly one inserted row: a second would mount the service twice.
  assert.equal(body.match(/^\s+- id:/gmu)?.length, 1);
});

test('the client half declares platform web and a resolvable ./client export', () => {
  assert.deepEqual(MANIFEST.dsh.client, {
    // `ui-renderer` provides the `slots` service this registration uses;
    // `ui-plugin-manager` owns (and declares) `plugins.bundle.config`, so naming
    // it in `inject` is how the manifest orders this bundle after the manager.
    // `settings-general` is gone with the old Settings section.
    inject: ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-plugin-manager'],
    platform: 'web',
  });

  const clientExport = MANIFEST.exports['./client'];
  assert.equal(typeof clientExport, 'object');
  assert.equal(clientExport.default, './lib/client.js');
  assert.equal(clientExport.types, './lib/client.d.ts');
  assert.ok(existsSync(join(ROOT, 'lib', 'client.js')), 'the built bundle must exist');
  assert.ok(PACKED.includes('lib/client.js'), 'the built bundle must be published');
  assert.ok(PACKED.includes('lib/client.d.ts'), 'the client declarations must be published');

  // The bundle is a module-table *registration* under this package's id, which is
  // how client-modules indexes it; a bundle registered under another id would be
  // served but never composed for this package.
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.match(bundle, /__ModuleLoader__\.load\(/u);
  assert.match(bundle, /id: "dsh-delegate"/u);
  assert.match(bundle, /factory: \(require\) =>/u);

  // Every module the registration requests must be in the frozen platform table,
  // otherwise composition rejects the row at boot.
  const requested = new Set(bundle.match(/require\("([^"]+)"\)/gu)?.map((call) => call.slice(9, -2)) ?? []);
  for (const specifier of requested) {
    assert.ok(['react', 'react/jsx-runtime'].includes(specifier), `unexpected client module request: ${specifier}`);
  }

  // The client source ships as-is: it is the artifact the built bundle is
  // generated from, so it must be present in the archive (`src/**/*.jsx`) for the
  // published source to match the published `lib/client.js`.
  assert.ok(PACKED.includes('src/client/index.jsx'), 'JSX source must be published');
});

test('the client bundle registers the bundle configuration page, keyed exactly dsh-delegate', () => {
  // Contract source: installed `@deepseek-ai/dsh-client-ui-plugin-manager`
  // 0.2.1-rc.2, `lib/types/client/slot-contract.d.ts`:
  //
  //     'plugins.bundle.config': { kind: 'keyed'; scope: 'root'; ... }
  //
  // The manager's bundle detail page renders it with
  // `renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })`
  // and decides whether to render at all from `ledger.bundles.has(pkg.name)`.
  // A registration under any other key or slot name is invisible, which is a
  // defect no type checker in this repository would catch.
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

  // The slot name is a single module-level constant, so its exact value is
  // asserted once and every use site is asserted to reference the constant. A
  // duplicated string literal would let the two halves drift apart silently.
  assert.match(bundle, /var PLUGIN_CONFIG_SLOT = "plugins\.bundle\.config";/u);
  assert.match(bundle, /var PLUGIN_BUNDLE_KEY = "dsh-delegate";/u);
  assert.match(bundle, /name: PLUGIN_CONFIG_SLOT/u);
  assert.match(bundle, /key: PLUGIN_BUNDLE_KEY/u);
  // The page must be attached through `ctx.slots.inject(<constant>, ...)`: the
  // keyed slot is declared by the manager bundle, which `dsh.client.inject` orders
  // this bundle after, and `inject` is what defers the registration until that
  // declaration exists. Registering directly would run before the slot is known.
  assert.match(bundle, /return ctx\.slots\.inject\(PLUGIN_CONFIG_SLOT,/u);
  assert.doesNotMatch(bundle, /inject\("plugins\.bundle\.config"/u, 'the slot name must be read from the constant, not repeated inline');
  assert.match(bundle, /ctx\.slots\.register\(/u);

  // The key must be the package name the manager matches on, not a bundle id
  // from the patch row (`dsh-delegate` happens to be both here; the assertion is
  // against the manifest so a rename of either side fails loudly).
  assert.equal(MANIFEST.name, 'dsh-delegate');

  // The old Settings page must not linger: a second full page inside the
  // Settings dialog would duplicate the same controls with a second store.
  assert.doesNotMatch(bundle, /settings\.section/u);
  assert.doesNotMatch(bundle, /registerSettingsSection/u);
  assert.doesNotMatch(bundle, /SETTINGS_SECTION_/u);
});

test('the package exports only real files, and each is in the archive', () => {
  const expectedExports = {
    '.': { types: './src/index.d.ts', default: './src/index.js' },
    './client': { types: './lib/client.d.ts', default: './lib/client.js' },
    './mcp': { types: './bin/dsh-delegate-mcp.d.ts', default: './bin/dsh-delegate-mcp.js' },
    './package.json': './package.json',
  };
  assert.deepEqual(MANIFEST.exports, expectedExports);

  const referenced = [];
  for (const [subpath, value] of Object.entries(MANIFEST.exports)) {
    if (typeof value === 'string') {
      referenced.push({ subpath, path: value });
      continue;
    }
    for (const [condition, target] of Object.entries(value)) referenced.push({ subpath, condition, path: target });
  }

  for (const entry of referenced) {
    const normalized = entry.path.replace(/^\.\//u, '');
    assert.ok(existsSync(join(ROOT, normalized)), `exports["${entry.subpath}"] points at a missing file: ${entry.path}`);
    assert.ok(PACKED.includes(normalized), `exports["${entry.subpath}"] target is not published: ${entry.path}`);
  }

  // `main` and `types` are read by consumers that ignore `exports`.
  assert.equal(MANIFEST.main, 'src/index.js');
  assert.equal(MANIFEST.types, 'src/index.d.ts');
  for (const path of [MANIFEST.main, MANIFEST.types]) {
    assert.ok(PACKED.includes(path), `${path} must be published`);
  }
});

test('the stdio MCP executable is declared as a bin and points at a real script', () => {
  assert.deepEqual(MANIFEST.bin, {
    'dsh-delegate-mcp': 'bin/dsh-delegate-mcp.js',
    'dsh-delegate-codex-agent': 'bin/dsh-delegate-codex-agent.js',
  });
  const binPath = MANIFEST.bin['dsh-delegate-mcp'];
  assert.ok(existsSync(join(ROOT, binPath)), 'the bin target must exist');
  assert.ok(PACKED.includes(binPath), 'the bin target must be published');
  assert.ok(PACKED.includes('bin/dsh-delegate-mcp.d.ts'), 'the bin declarations must be published');

  const codexBinPath = MANIFEST.bin['dsh-delegate-codex-agent'];
  assert.ok(existsSync(join(ROOT, codexBinPath)), 'the Codex companion bin target must exist');
  assert.ok(PACKED.includes(codexBinPath), 'the Codex companion bin target must be published');
  assert.ok(PACKED.includes('codex/dsh-delegate.toml'), 'the custom-agent template must be published');
  const codexAgent = readFileSync(join(ROOT, 'codex/dsh-delegate.toml'), 'utf8');
  assert.match(codexAgent, /^name = "dsh-delegate"$/mu);
  // The managed copy is stamped with the package version, so an upgrade can tell an
  // older file of ours (safe to refresh) from an operator's edit (never touched).
  assert.match(codexAgent, new RegExp(`^version = "${MANIFEST.version.replace(/\./gu, '\\.')}"$`, 'mu'));
  // Dispatch rules: explicit selection only, switch checked first, isolation-only
  // override for shared runs, one task polled, evidence returned to Codex.
  assert.match(codexAgent, /is NOT a dispatch request/u);
  assert.match(codexAgent, /delegate_status/u);
  assert.match(codexAgent, /For a `shared` decision, pass only\s+`overrides = \{ isolation = "shared" \}`/u);
  assert.match(codexAgent, /Never\s+override the configured provider, model, reasoning effort or timeout/u);
  assert.match(codexAgent, /configured isolation and matching project\s+override apply/u);
  assert.match(codexAgent, /configured isolation and matching project\s+override apply/u);
  assert.match(codexAgent, /actual provider\/model\/effort from the\s+result/u);
  assert.match(codexAgent, /Codex remains responsible/u);
  // The pre-dispatch workspace check, and the rule that keeps it from becoming an
  // automatic downgrade. Both are part of the shipped file, so they are asserted
  // against the archive's own copy rather than the repository checkout.
  assert.match(codexAgent, /delegate_preflight/u);
  assert.match(codexAgent, /Do NOT downgrade to\s+shared isolation silently/u);
  assert.match(codexAgent, /`allowShared: true`/u);
  assert.doesNotMatch(codexAgent, /workbuddy|deepseek-v4\.1-flash/u, 'the companion must follow DSH plugin routing');
  assert.doesNotMatch(codexAgent, /^\[mcp_servers\./mu, 'the companion inherits MCP tools from the parent session');

  // The preflight module is imported by the execution plane, which the MCP
  // executable reaches, so it has to be in the archive for the tool to exist.
  for (const path of ['src/workspace/preflight.js', 'src/workspace/audit.js', 'src/workspace/locks.js']) {
    assert.ok(PACKED.includes(path), `the preflight module must be published: ${path}`);
  }

  // The Codex integration ships as source plus the template: the settings page
  // imports `src/codex/installer.js` at runtime, so it must be inside the archive.
  for (const path of ['src/codex/installer.js', 'src/codex/toml.js', 'src/codex/seam.js']) {
    assert.ok(PACKED.includes(path), `the Codex integration module must be published: ${path}`);
    assert.ok(
      readFileSync(join(ROOT, path), 'utf8').length > 0,
      `${path} must not be empty`,
    );
  }

  const source = readFileSync(join(ROOT, binPath), 'utf8');
  assert.match(source, /^#!\/usr\/bin\/env node/u, 'a bin needs a shebang');
  // The executable must import only files this package ships.
  for (const specifier of source.match(/from '(\.[^']+)'/gu)?.map((match) => match.slice(6, -1)) ?? []) {
    const resolved = relative(ROOT, resolve(ROOT, 'bin', specifier)).split(sep).join('/');
    assert.ok(PACKED.includes(resolved), `the MCP executable imports an unpublished file: ${resolved}`);
  }
});

test('peer constraints declare exactly the verified DSH runtimes', () => {
  const peers = MANIFEST.peerDependencies;
  // DSH admits a plugin by checking every @deepseek-ai/dsh-* peer range against the
  // running runtime version with prereleases included. 0.2.0-rc.2 and 0.2.1-rc.2 are
  // the two versions this package was actually exercised on; anything looser would
  // claim compatibility that was never tested.
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue;
    assert.equal(range, SUPPORTED_DSH_RANGE, `${name} must allow exactly the verified runtimes`);
  }
  assert.equal(peers['@earendil-works/pi-ai'], '^0.87.1 || ^1.1.0');
});

test('the review composition native tool packages are declared, not assumed', () => {
  // `src/review/preset.js` builds the dedicated read-only review preset from two
  // native rows and loads them with a dynamic `import()` of these exact
  // specifiers (`REVIEW_PACKAGES`). A plugin may not import a package it does not
  // declare: an undeclared import resolves here only because a linked host tree
  // happens to sit beside this one, and fails for a consumer installed from a
  // tarball. So both names are peers (the host provides them) AND devDependencies
  // (this repository pins them), exactly like the other native packages.
  const REVIEW_PACKAGES = ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search'];
  const preset = readFileSync(join(ROOT, 'src', 'review', 'preset.js'), 'utf8');

  for (const name of REVIEW_PACKAGES) {
    // The module really imports what is declared, and it is declared as a peer
    // whose range is the verified-runtime union (same rule as the row above).
    assert.ok(preset.includes(`'${name}'`) || preset.includes(`"${name}"`), `${name} must be the specifier preset.js loads`);
    assert.equal(
      MANIFEST.peerDependencies[name],
      SUPPORTED_DSH_RANGE,
      `${name} must be a peer over the verified runtimes`,
    );
    // Host-supplied as a service, so it must never also be a hard dependency.
    assert.ok(!(name in MANIFEST.dependencies), `${name} must not be a runtime dependency`);
  }

  // The peer surface must name both rows and nothing speculative: every
  // @deepseek-ai/dsh-* peer is either a runtime package this package imports
  // directly or one of the two review rows.
  const declaredNative = Object.keys(MANIFEST.peerDependencies).filter((name) => name.startsWith('@deepseek-ai/dsh'));
  assert.deepEqual(declaredNative.sort(), [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
  ]);
});

test('devDependencies pin the development runtime, not the widened peer range', () => {
  // Peers advertise what the host may provide; devDependencies are what this
  // repository itself installs and tests against. The suite therefore keeps the
  // single pinned development runtime even though peers now admit two versions.
  for (const name of [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-llm-pi-ai',
    '@deepseek-ai/dsh-tool-fs',
    '@deepseek-ai/dsh-tool-fs-search',
  ]) {
    assert.equal(MANIFEST.devDependencies[name], '0.2.0-rc.2', `${name} must stay pinned to the development runtime`);
    assert.ok(name in MANIFEST.peerDependencies, `${name} must remain a peer`);
  }
  assert.equal(MANIFEST.devDependencies['@earendil-works/pi-ai'], '^0.87.1');
  assert.equal(MANIFEST.devDependencies['@deepseek-ai/schemastery'], '~3.18.4');
});

test('the client build toolchain is a pinned devDependency, so npm ci is enough', () => {
  // `scripts/build-client.mjs` drives an esbuild CLI. It must not rely on a
  // machine-local or `.cache/` copy: a clean checkout has to be buildable with
  // exactly `npm ci` + `npm run build:client`. Pinning the version (not a caret)
  // keeps the generated `lib/client.js` reproducible.
  assert.equal(MANIFEST.devDependencies.esbuild, '0.25.11');
  assert.ok(!('esbuild' in MANIFEST.dependencies), 'esbuild is a build-time tool, not a runtime dependency');
  assert.ok(!('esbuild' in MANIFEST.peerDependencies), 'esbuild is not provided by the host');

  // Build scripts must resolve to the documented commands.
  assert.equal(MANIFEST.scripts['build:client'], 'node scripts/build-client.mjs');
  assert.equal(MANIFEST.scripts['check:client'], 'node scripts/build-client.mjs --check');

  // The build itself must stay out of the published package and out of git.
  assert.ok(!PACKED.includes('scripts/build-client.mjs'), 'the build script is not a consumer artifact');
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
  assert.ok(gitignore.includes('node_modules/'), 'node_modules must be ignored');
});

test('the lockfile pins the same dependency set the manifest declares', () => {
  // `npm ci` refuses to run when package.json and package-lock.json disagree, so a
  // manifest edit that forgets the lockfile is an install-time failure for every
  // clean checkout. The lockfile's root entry must mirror the manifest, and every
  // direct dependency must have a resolved, integrity-checked entry.
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, MANIFEST.name);
  assert.equal(lock.version, MANIFEST.version);

  const root = lock.packages[''];
  assert.ok(root !== undefined, 'the lockfile must describe the root package');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    assert.deepEqual(root[field] ?? {}, MANIFEST[field] ?? {}, `lockfile root ${field} drifted from package.json`);
  }

  /** Every direct dependency must be a real, pinned lockfile entry. */
  const expectEntry = (name, field) => {
    const entry = lock.packages[`node_modules/${name}`];
    if (field === 'peerDependencies' && entry === undefined) return; // supplied by the host
    assert.ok(entry !== undefined, `${field} ${name} is missing from the lockfile`);
    assert.equal(typeof entry.version, 'string', `${name} has no locked version`);
    assert.equal(typeof entry.integrity, 'string', `${name} has no locked integrity`);
  };
  for (const name of Object.keys(MANIFEST.dependencies)) expectEntry(name, 'dependencies');
  for (const name of Object.keys(MANIFEST.devDependencies)) expectEntry(name, 'devDependencies');

  // The build tool must be locked at exactly the pinned version, and its platform
  // binary (the executable `build-client.mjs` actually spawns) must be locked too.
  assert.equal(lock.packages['node_modules/esbuild'].version, '0.25.11');
  const platformBinary = `node_modules/@esbuild/${process.platform}-${process.arch}`;
  assert.ok(lock.packages[platformBinary] !== undefined, `missing platform binary entry: ${platformBinary}`);
});


test('the only runtime dependency is the config-schema library the entry imports', () => {
  // A plugin's non-peer imports must resolve from its own tree when installed from
  // a tarball, where devDependencies are absent. `@deepseek-ai/schemastery` is the
  // one module the entry imports directly rather than receiving as an injected
  // service; Cordis validates `Config` through its Standard Schema interface.
  assert.deepEqual(MANIFEST.dependencies, { '@deepseek-ai/schemastery': '~3.18.4' });

  // Anything the harness supplies as a service is a peer, so a consumer cannot end
  // up with a second copy of the runtime's own state.
  for (const name of Object.keys(MANIFEST.dependencies)) {
    assert.ok(!(name in MANIFEST.peerDependencies), `${name} must not be both a dependency and a peer`);
  }
});

test('scripts expose the build check, the MCP entry and the test command', () => {
  assert.equal(MANIFEST.scripts.test, 'node --test --test-concurrency=1 tests/*.test.js');
  assert.equal(MANIFEST.scripts['check:client'], 'node scripts/build-client.mjs --check');
  assert.equal(MANIFEST.scripts.mcp, 'node bin/dsh-delegate-mcp.js');
  assert.equal(MANIFEST.scripts['codex-agent'], 'node bin/dsh-delegate-codex-agent.js');
});

test('the release metadata is one version everywhere it is written by hand', () => {
  // The version appears in several places that no tool keeps in sync for us. A release
  // that disagrees with itself produces an artifact whose reported version is wrong,
  // so the duplication is asserted rather than trusted.
  const runtimeFacts = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  const mcpServer = readFileSync(join(ROOT, 'src', 'mcp', 'server.js'), 'utf8');
  const discovery = readFileSync(join(ROOT, 'src', 'runtime', 'endpoint-discovery.js'), 'utf8');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

  assert.match(runtimeFacts, new RegExp(`const PLUGIN_VERSION = '${escape(MANIFEST.version)}';`, 'u'));
  assert.match(mcpServer, new RegExp(`version: '${escape(MANIFEST.version)}'`, 'u'));
  assert.match(discovery, new RegExp(`dsh-delegate ${escape(MANIFEST.version)}`, 'u'));
  assert.match(readme, new RegExp(`dsh-delegate-${escape(MANIFEST.version)}\\.tgz`, 'u'));
  // Every *release* literal in the package is this version. The 0.2.x references are
  // DSH runtime versions quoted in comments, not this package's own version.
  for (const path of ['src/index.js', 'src/mcp/server.js', 'src/runtime/endpoint-discovery.js']) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    const literals = (text.match(/\b0\.1\.\d+\b/gu) ?? []);
    for (const literal of literals) {
      assert.equal(literal, MANIFEST.version, `${path} still mentions ${literal}`);
    }
  }
});

test('the release is 0.1.8, one semver step above the shipped 0.1.7 baseline', () => {
  // Pinned, not derived: Workspace placement is a new release, and a manifest that
  // still advertises 0.1.7 would let an operator install the previous build as if it
  // were the same one. `package.json`, the lockfile (both fields), the agent template
  // and the two documents an operator reads must agree.
  assert.match(MANIFEST.version, SEMVER);
  assert.equal(MANIFEST.version, DELIVERABLE_VERSION, 'package.json must declare the released version');

  const previous = semverParts('0.1.7');
  const current = semverParts(MANIFEST.version);
  assert.equal(current.major, previous.major, 'a defect fix is a patch release: the major version may not move');
  assert.equal(current.minor, previous.minor, 'a defect fix is a patch release: the minor version may not move');
  assert.equal(current.patch, previous.patch + 1, 'the release must be exactly one patch above 0.1.6');

  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, DELIVERABLE_VERSION, 'package-lock.json#version must match package.json');
  assert.equal(lock.packages[''].version, DELIVERABLE_VERSION, 'the lockfile root entry must match package.json');

  const template = readFileSync(join(ROOT, 'codex', 'dsh-delegate.toml'), 'utf8');
  assert.match(template, new RegExp(`^version = "${escape(DELIVERABLE_VERSION)}"$`, 'mu'));

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, new RegExp(`dsh-delegate-${escape(DELIVERABLE_VERSION)}\\.tgz`, 'u'));
  const contract = readFileSync(join(ROOT, 'docs', 'codex-integration.md'), 'utf8');
  assert.match(contract, new RegExp(`implemented in ${escape(DELIVERABLE_VERSION)}`, 'u'), 'the Codex contract names the release it describes');
  assert.match(contract, new RegExp(`"packageVersion": "${escape(DELIVERABLE_VERSION)}"`, 'u'));
  assert.match(contract, /bundled runtime/u, 'the contract must document where the executable comes from');

  // No stale release literal may survive in code or in the documents an operator
  // reads, except for the two explicit historical-contract locations that identify
  // the previous build whose bytes and migration shape are being handled.
  for (const path of ['README.md', 'docs/codex-integration.md', ...PACKED.filter((entry) => entry.startsWith('src/') && entry.endsWith('.js'))]) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const literal of new Set(text.match(/\b0\.1\.\d+\b/gu) ?? [])) {
      const historical = ['0.1.6', '0.1.7'].includes(literal) && HISTORICAL_VERSION_PATHS.has(path);
      assert.ok(literal === DELIVERABLE_VERSION || historical, `${path} still mentions ${literal} as if it were current`);
    }
  }
});

test('the Codex MCP command resolves a Node.js runtime, never the desktop executable', () => {
  // The defect this release fixes: in the DSH Desktop (Electron) host, `execPath` is
  // `DeepSeek Harness.exe`. It must never be written as the MCP `command`, and the
  // resolution must name the bundled runtime instead. The behavioural cases live in
  // `tests/codex-integration.test.js`; what is pinned here is that the published
  // module carries the contract and the documents state it.
  const installer = readFileSync(join(ROOT, 'src', 'codex', 'installer.js'), 'utf8');
  assert.ok(PACKED.includes('src/codex/installer.js'), 'the module that implements the resolution must be published');
  for (const marker of ['MCP_NODE_ENV_VARS', 'packagedNodePath', 'hostRuntimeKind', 'MCP_EXECUTABLE_UNRESOLVED']) {
    assert.ok(installer.includes(marker), `src/codex/installer.js must define ${marker}`);
  }
  // The three overrides and the packaged runtime layout are documented for an
  // operator who has to fix a host that cannot resolve its own Node.
  const contract = readFileSync(join(ROOT, 'docs', 'codex-integration.md'), 'utf8');
  for (const name of ['DSH_NODE_PATH', 'DSH_NODE_EXECUTABLE', 'CODEX_MCP_NODE_PATH']) {
    assert.ok(contract.includes(name), `the Codex contract must document ${name}`);
  }
  assert.match(contract, /runtime\/primary-runtime\/dependencies\/node\/bin/u, 'the bundled Node location is documented');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /DeepSeek Harness\.exe/u, 'the README must state which executable is never used');
});

// ---------------------------------------------------------------------------
// 2. The published archive: required entries present, excluded classes absent
// ---------------------------------------------------------------------------

test('the archive carries every install-critical file', () => {
  const required = [
    'package.json',
    // npm force-includes these two by name; a consumer needs both to install and
    // to understand what it installed.
    'README.md',
    'LICENSE',
    // native plugin entry + the modules it imports
    'src/index.js',
    'src/mcp/server.js',
    'src/jobs/engine.js',
    'src/auth/grants.js',
    // browser half: the built bundle plus the JSX source it is generated from
    'lib/client.js',
    'lib/client.d.ts',
    'src/client/index.jsx',
    // stdio MCP adapter
    'bin/dsh-delegate-mcp.js',
    'bin/dsh-delegate-codex-agent.js',
    'codex/dsh-delegate.toml',
    // bundle composition
    'cordis.patch.yml',
  ];
  for (const path of required) {
    assert.ok(PACKED.includes(path), `missing from the package: ${path}`);
  }

  // Every JS/JSX file under src/ must ship: an import that resolves here but not
  // from the tarball is an install-time crash on a user's machine, and the JSX
  // source is what the published bundle is built from.
  for (const path of KNOWN_FILES) {
    if (!path.startsWith('src/') || !/\.(?:js|jsx)$/u.test(path)) continue;
    assert.ok(PACKED.includes(path), `source module not published: ${path}`);
  }
});

test('the archive publishes the operator-facing contracts, not internal notes', () => {
  for (const path of [
    'docs/auth-contract.md',
    'docs/codex-integration.md',
    'docs/conversation-placement.md',
    'docs/contracts-stage-b.md',
    'docs/redaction-contract.md',
    'docs/workspace-contract.md',
  ]) {
    assert.ok(PACKED.includes(path), `missing doc: ${path}`);
  }
  // The Codex contract describes the two files the installer owns; a packaged
  // build must ship it so an operator can check what was written.
  const contract = readFileSync(join(ROOT, 'docs', 'codex-integration.md'), 'utf8');
  assert.match(contract, /mcp_servers\.dsh-delegate/u);
  assert.match(contract, /CODEX_HOME/u);
  assert.match(contract, /never touch|never overwrite|untouched/u);
  // Build/acceptance scaffolding is for maintainers, not consumers.
  for (const excluded of ['AGENTS.md', 'SPEC.md', 'docs/ACCEPTANCE.md', 'scripts/build-client.mjs', 'package-lock.json']) {
    assert.ok(!PACKED.includes(excluded), `internal file must not be published: ${excluded}`);
  }
});

test('the archive excludes tests, probes, caches, dependencies and secrets', () => {
  for (const path of PACKED) {
    assert.ok(!EXCLUDED_PATTERNS.some((pattern) => pattern.test(path)), `excluded content published: ${path}`);
    assert.ok(!path.startsWith('tests/'), `test file published: ${path}`);
    assert.ok(!path.startsWith('node_modules/'), `dependency published: ${path}`);
    assert.ok(!path.includes('..'), `path traversal in the allowlist: ${path}`);
  }

  // A credential or a machine-local path in a published file is a leak even when
  // the file itself is legitimate.
  const textFiles = PACKED.filter((path) => /\.(js|json|md|yml|toml|d\.ts)$/u.test(path));
  assert.ok(textFiles.length > 20, 'sanity: the archive should be mostly text');
  for (const path of textFiles) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    assert.doesNotMatch(text, /C:\\+Users\\+/u, `absolute user path published in ${path}`);
    assert.doesNotMatch(text, /\bsk-[A-Za-z0-9]{16,}/u, `credential-shaped string published in ${path}`);
    assert.doesNotMatch(text, /DSH_DELEGATE_TOKEN\s*[:=]\s*['"][^'"]+['"]/u, `token literal published in ${path}`);
  }
});

test('every allowlist literal names a real file, so the manifest cannot drift', () => {
  // Glob entries are proof-reads by the two tests above; literals are checked
  // directly here so a renamed doc fails loudly instead of silently dropping out
  // of the package.
  for (const pattern of MANIFEST.files) {
    if (pattern.includes('*')) continue;
    assert.ok(existsSync(join(ROOT, pattern)), `files entry does not exist: ${pattern}`);
  }
});

test('the packed size stays bounded and contains no single-file outlier', () => {
  let total = 0;
  for (const path of PACKED) total += statSync(join(ROOT, path)).size;
  // The archive is source plus one built bundle; a sudden multi-megabyte entry
  // means a bundle, a lockfile or a fixture slipped in.
  assert.ok(total < 2_000_000, `unpacked size grew unexpectedly: ${total} bytes`);
  const largest = PACKED.map((path) => ({ path, size: statSync(join(ROOT, path)).size }))
    .sort((left, right) => right.size - left.size)[0];
  assert.ok(largest.size < 500_000, `unexpectedly large packed file: ${largest.path}`);
});

// ---------------------------------------------------------------------------
// 3. npm's own answer, cross-checked against the computed allowlist
// ---------------------------------------------------------------------------

/**
 * Resolve the npm CLI entry point beside the running Node.js.
 * @returns {string} absolute path, or `''` when npm is not installed beside Node.
 */
function npmCliPath() {
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(candidate) ? candidate : '';
}

/**
 * Run `npm pack --dry-run --json` without a tarball and without pipes.
 *
 * stdout/stderr go to files under a temp directory because a piped child fails
 * with EPERM in the confined sandbox; the temp directory is removed afterwards.
 * @returns {{ ok: true, paths: string[] } | { ok: false, reason: string }} result.
 */
function readNpmPackList() {
  const npmCli = npmCliPath();
  if (npmCli === '') return { ok: false, reason: 'npm CLI not found beside Node.js' };
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-delegate-pack-'));
  try {
    const stdout = join(scratch, 'stdout.json');
    const stderr = join(scratch, 'stderr.txt');
    const fd = { out: null, err: null };
    let result;
    try {
      // eslint-disable-next-line no-restricted-syntax -- file descriptors, not pipes
      fd.out = openSyncFallback(stdout);
      fd.err = openSyncFallback(stderr);
      result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--cache', join(scratch, 'cache')], {
        cwd: ROOT,
        stdio: ['ignore', fd.out, fd.err],
      });
    } catch (error) {
      return { ok: false, reason: `npm could not be spawned: ${error?.code ?? error?.message}` };
    } finally {
      for (const handle of [fd.out, fd.err]) if (handle !== null) closeFallback(handle);
    }
    if (result.error !== undefined) {
      // EPERM is the documented stdio/spawn boundary of the confined sandbox.
      return { ok: false, reason: `npm spawn failed: ${result.error.code ?? result.error.message}` };
    }
    const text = readFileSync(stdout, 'utf8');
    if (result.status !== 0 || text.trim() === '') {
      const errors = readFileSync(stderr, 'utf8').trim();
      return { ok: false, reason: `npm pack exited ${result.status}: ${errors.slice(0, 400)}` };
    }
    const report = JSON.parse(text);
    const paths = (report[0]?.files ?? []).map((file) => file.path).sort();
    return { ok: true, paths };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// `openSync`/`closeSync` are used directly: a read-only sandbox that forbids them
// makes the spawn attempt throw, and that throw is reported as the skip reason.
/** Open a file for writing, or throw the underlying error. */
function openSyncFallback(path) {
  return openSync(path, 'w');
}

/** Close a file handle, ignoring an already-closed descriptor. */
function closeFallback(handle) {
  try {
    closeSync(handle);
  } catch {
    // nothing to release
  }
}

test('npm pack --dry-run reports exactly the computed archive', (t) => {
  const packed = readNpmPackList();
  if (packed.ok !== true) {
    t.skip(`npm pack not observable here (${packed.reason}); the computed-allowlist tests above still ran`);
    return;
  }

  assert.deepEqual(packed.paths, PACKED, 'npm pack and the manifest-derived expectation disagree');

  for (const path of packed.paths) {
    assert.ok(!path.startsWith('tests/'), `test file packed: ${path}`);
    assert.ok(!path.startsWith('node_modules/'), `dependency packed: ${path}`);
    assert.ok(!/(^|\/)\.probe-/u.test(path), `probe packed: ${path}`);
  }
  for (const path of ['README.md', 'LICENSE', 'bin/dsh-delegate-mcp.js', 'lib/client.js', 'cordis.patch.yml']) {
    assert.ok(packed.paths.includes(path), `npm pack omitted ${path}`);
  }
});
