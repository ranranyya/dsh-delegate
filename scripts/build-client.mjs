#!/usr/bin/env node
// Build the browser half of dsh-delegate: `src/client/index.jsx` (+ friends)
// -> `lib/client.js`, in exactly the registration format the DSH web client's
// module system accepts.
//
// Why a hand-written wrapper instead of a bundler preset: a native client
// bundle is a *registration*, not a module. Every shipped
// `@deepseek-ai/dsh-client-*` package ships `lib/client.js` shaped like
//
//     window.__ModuleLoader__.load({
//       id: "@deepseek-ai/dsh-client-ui-settings-web-search",
//       factory: (require) => { /* lazy body */ return module.exports; }
//     });
//
// `@deepseek-ai/dsh-client-modules` stores `id` -> `factory` and runs the
// factory at materialization time, resolving each `require("<spec>")` against
// either the frozen platform module table (`react`, `react/jsx-runtime`,
// `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
// `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
// `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit`)
// or a dependency the package declared under `dsh.client.external` in its
// package.json. Nothing else resolves, so the externals list below is the
// complete allowed surface: a new import in the client source must stay inside
// it, or the coordinator has to declare it in package.json.
//
// esbuild is an ordinary pinned devDependency of this package (`esbuild@0.25.11`),
// so the supported way to build is the plain dependency path:
//
//     npm ci               # install exactly what package-lock.json pins
//     npm run build:client # writes lib/client.js
//
// The script never installs anything itself. It only *locates* an esbuild that
// an ordinary `npm ci` (or `npm install`) has already put in place, searched in
// this order:
//
//   1. `$DSH_DELEGATE_ESBUILD` — an explicit esbuild package directory.
//   2. `<repo>/node_modules/esbuild` — the pinned devDependency (the normal case).
//   3. every ancestor `node_modules/esbuild` (workspace / harness layouts).
//   4. `<repo>/.cache/tools/node_modules/esbuild` — a local scratch install kept
//      as an optional convenience fallback (`.cache/` is gitignored). It exists so
//      the build still works in an environment where dependencies could not be
//      installed; it is not a guarantee and not needed for `npm ci`.
//
// When none is found the script fails loudly with exit code 2 instead of leaving
// a silently stale `lib/client.js`.
//
// It drives the esbuild *CLI binary*, not the JavaScript API: the JS API starts
// a long-lived service child process and talks to it over piped stdio, which
// fails with EPERM under a stdio-confined sandbox. The CLI writes straight to a
// file we then read, so the build works with no pipes at all.
//
// Usage:
//   node scripts/build-client.mjs            # write lib/client.js
//   node scripts/build-client.mjs --check    # rebuild in a temp dir and diff
//
// Exit codes: 0 success/no drift, 1 build failure or drift, 2 esbuild missing.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENTRY = join(ROOT, 'src', 'client', 'index.jsx');
const OUTPUT = join(ROOT, 'lib', 'client.js');
/**
 * Parent for scratch build output. `os.tmpdir()` is not reliably writable
 * (a sandboxed Windows temp dir rejects esbuild's writes with EACCES), while
 * `.cache/` is inside the repo and gitignored.
 */
const SCRATCH_ROOT = join(ROOT, '.cache');

/** Registration id: the package name, which is how the loader indexes bundles. */
const CLIENT_ID = 'dsh-taskdispatch';

/**
 * Specifiers this bundle may request at runtime.
 *
 * All of these are platform modules already present in the loader's table, so
 * the package does not need a `dsh.client.external` entry for them.
 */
const PLATFORM_EXTERNALS = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

/**
 * Locate an installed esbuild package.
 *
 * Nothing is installed here: the first four candidates are the ones an ordinary
 * `npm ci` produces, and the last is the optional `.cache/` convenience fallback
 * described in the header.
 * @param {string} root - repository root.
 * @returns {string | null} absolute path to an esbuild package directory.
 */
function findEsbuildPackage(root) {
  const candidates = [];
  const explicit = process.env.DSH_DELEGATE_ESBUILD;
  if (typeof explicit === 'string' && explicit !== '') candidates.push(resolve(explicit));
  candidates.push(join(root, 'node_modules', 'esbuild'));
  let cursor = root;
  for (;;) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    candidates.push(join(parent, 'node_modules', 'esbuild'));
    cursor = parent;
  }
  // Optional convenience fallback only: `.cache/` is gitignored scratch space, so
  // a build that depends on it would not be reproducible. `npm ci` is the path
  // that matters, and candidate 2 above is where it lands.
  candidates.push(join(root, '.cache', 'tools', 'node_modules', 'esbuild'));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

/**
 * Resolve the executable to run for a located esbuild package.
 *
 * Prefers the platform package's raw binary (`@esbuild/<platform>/esbuild.exe`
 * on Windows) over the `bin/esbuild` launcher script, because a raw binary
 * needs no shell and no interpreter.
 * @param {string} packageDir - esbuild package directory.
 * @returns {string} absolute path to an executable.
 */
function findEsbuildBinary(packageDir) {
  const platform = `${process.platform}-${process.arch}`;
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  const candidates = [
    join(dirname(packageDir), '@esbuild', platform, exe),
    join(packageDir, 'bin', exe),
    join(packageDir, 'bin', 'esbuild'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run one esbuild CLI invocation.
 *
 * stdio is inherited rather than captured: a sandboxed process cannot open the
 * pipes `spawnSync` would need for `pipe` mode.
 * @param {string} binary - esbuild executable.
 * @param {string[]} args - CLI arguments.
 * @returns {{ status: number | null }} the child's exit status.
 */
function runEsbuild(binary, args) {
  const result = spawnSync(binary, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.error !== undefined) throw result.error;
  return { status: result.status };
}

/**
 * Compile the bundle body to a scratch file and wrap it in the loader
 * registration.
 * @param {string} binary - esbuild executable.
 * @returns {string} complete `lib/client.js` text.
 */
function buildBundleText(binary) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const scratch = mkdtempSync(join(SCRATCH_ROOT, 'build-'));
  const raw = join(scratch, 'client.body.cjs');
  try {
    const args = [
      ENTRY,
      '--bundle',
      '--format=cjs',
      '--platform=browser',
      '--target=es2022',
      // Automatic runtime: JSX compiles to `react/jsx-runtime`, a platform
      // module, so the bundle needs no JSX pragma import of its own.
      '--jsx=automatic',
      '--charset=utf8',
      '--legal-comments=none',
      '--log-level=warning',
      // Not minified on purpose: this is a settings page an operator or a
      // reviewer may need to audit in the shipped package.
      '--minify=false',
      ...PLATFORM_EXTERNALS.map((spec) => `--external:${spec}`),
      `--outfile=${raw}`,
    ];
    const { status } = runEsbuild(binary, args);
    if (status !== 0) throw new Error(`esbuild exited with status ${String(status)}`);
    if (!existsSync(raw)) throw new Error('esbuild produced no output file');

    const body = readFileSync(raw, 'utf8').replace(/\s+$/, '');
    // One indent level so the factory body reads as a block in the shipped file.
    const indented = body
      .split('\n')
      .map((line) => (line === '' ? '' : `\t\t${line}`))
      .join('\n');
    return [
      '// Generated by scripts/build-client.mjs — do not edit.',
      '// Source: src/client/index.jsx, src/client/api.js, src/client/styles.js.',
      'window.__ModuleLoader__.load({',
      `\tid: ${JSON.stringify(CLIENT_ID)},`,
      '\tfactory: (require) => {',
      // The factory body is CommonJS syntax but the loader hands it only
      // `require`; the native bundles declare these two locals for the same
      // reason, and esbuild's CJS output assigns through `module.exports`.
      '\t\tvar module = { exports: {} };',
      '\t\tvar exports = module.exports;',
      indented,
      '\t\treturn module.exports;',
      '\t}',
      '});',
      '',
    ].join('\n');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** CLI entry point. */
function main() {
  const check = process.argv.includes('--check');
  const packageDir = findEsbuildPackage(ROOT);
  const binary = packageDir === null ? null : findEsbuildBinary(packageDir);
  if (binary === null) {
    process.stderr.write([
      'build-client: 未找到可用的 esbuild，无法构建 lib/client.js。',
      '',
      'esbuild 是本包固定的开发依赖（esbuild@0.25.11），正常安装即可：',
      '  1. npm ci            （按 package-lock.json 安装，推荐；clean 源码可直接用）',
      '  2. npm run build:client',
      '',
      '如果确实无法安装依赖，也可以任选其一：',
      '  - 设置环境变量 DSH_DELEGATE_ESBUILD 指向一个已安装的 esbuild 包目录；',
      '  - 把 esbuild 放到 <repo>/.cache/tools/node_modules/esbuild（.cache 已被忽略）。',
      '',
      '已搜索：env DSH_DELEGATE_ESBUILD、node_modules/esbuild、各级祖先目录、.cache/tools。',
      '',
    ].join('\n'));
    process.exitCode = 2;
    return;
  }

  const text = buildBundleText(binary);

  if (check) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== text) {
      process.stderr.write('build-client: lib/client.js 与源码不一致，请重新运行 node scripts/build-client.mjs\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write('build-client: lib/client.js 已是最新。\n');
    return;
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, text, 'utf8');
  const kib = (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1);
  process.stdout.write(`build-client: 已写入 lib/client.js（${kib} KiB，${binary}）。\n`);
}

main();
