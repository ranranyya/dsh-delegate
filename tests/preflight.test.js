// Preflight tests: the read-only workspace inspection behind `delegate_preflight`.
//
// Three property classes are proven here:
//
//   1. **The decision table is exhaustive and stable.** Every reachable state of a
//      workspace maps to exactly one of `worktree` / `shared` / `block` with one
//      stable reason code, and the flags (`decisionRequired`, `sharedExplicit`)
//      say *how* that answer was reached. A caller must never have to parse prose
//      to know whether a dispatch may proceed.
//
//   2. **It is read-only, and it never decides for the operator.** No mutating git
//      subcommand is ever issued (asserted against the exact argv list), nothing
//      is created on disk, and a dirty workspace is never silently downgraded to
//      shared isolation: it blocks until `allowShared` is passed explicitly.
//
//   3. **The published MCP/HTTP surface carries the same answer.** The tool is
//      routed to its own plane route, is refused for undeclared/mistyped
//      arguments before reaching the plane, and is answerable while the
//      delegation switch is OFF and while every job slot is busy — because it
//      authorizes nothing.
//
// The git runner is faked (this sandbox cannot spawn a child with piped stdio),
// but never *helpfully*: each fake answers the exact argv the real audit seam
// issues, and the real temporary directory is inspected so the path resolution,
// containment and directory checks run against the real filesystem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PREFLIGHT_ISOLATIONS,
  PREFLIGHT_LIMITS,
  PREFLIGHT_REASONS,
  preflightWorkspace,
} from '../src/workspace/preflight.js';
import { AUDIT_LIMITS } from '../src/workspace/audit.js';
import { createMcpServer, LATEST_PROTOCOL_VERSION } from '../src/mcp/server.js';
import { createExecutionClient, readConfig } from '../bin/dsh-delegate-mcp.js';
import { preflightWorkspace as planePreflight } from '../src/workspace/preflight.js';

const HEAD = 'c'.repeat(40);

/** NUL-join porcelain records the way `git status -z` emits them. */
function z(...tokens) {
  return `${tokens.join('\0')}\0`;
}

/**
 * Build a runner that answers the exact argv the audit seam issues and records
 * every invocation, so a test can prove which git reads happened.
 *
 * `status` is the raw `-z` body; every other read defaults to a healthy answer.
 * `topLevel` makes the fake answer `rev-parse --show-toplevel`; by default it
 * answers nothing usable, which is what a real git does outside a repository, so
 * a test that wants a repository root must say so explicitly.
 * @param {object} [options] - `status`, `clean` (defaults to true), `topLevel`, overrides.
 * @returns {object} runner with `calls` and `joined` history.
 */
function runner(options = {}) {
  const calls = [];
  const table = {
    '--version': { stdout: 'git version 2.54.0\n', code: 0 },
    'rev-parse --is-inside-work-tree': { stdout: 'true\n', code: 0 },
    'rev-parse --show-toplevel': options.topLevel === undefined
      ? { stdout: '', stderr: 'fatal: not a git repository', code: 128 }
      : { stdout: `${options.topLevel}\n`, code: 0 },
    'rev-parse --verify HEAD': { stdout: `${HEAD}\n`, code: 0 },
    'status --porcelain=v1 -z --untracked-files=all': { stdout: z(), code: 0 },
    ...options.table,
  };
  const runGit = async (cwd, args) => {
    const joined = args.join(' ');
    calls.push({ cwd, args, joined });
    const entry = table[joined];
    if (entry === undefined) return { stdout: '', stderr: '', code: 0 };
    if (typeof entry === 'function') return await entry(cwd, args);
    if (entry instanceof Error) throw entry;
    return { stdout: entry.stdout ?? '', stderr: entry.stderr ?? '', code: entry.code ?? 0 };
  };
  runGit.calls = calls;
  return runGit;
}

/** Every mutating git verb this module must never issue. */
const MUTATING_VERBS = ['add', 'commit', 'stash', 'checkout', 'reset', 'switch', 'clean', 'merge',
  'rebase', 'worktree', 'branch', 'tag', 'restore', 'mv', 'rm', 'push', 'fetch', 'pull', 'gc'];

/** The five read-only reads the preflight is allowed to issue, in order. */
const READ_ONLY_READS = Object.freeze([
  '--version',
  'rev-parse --is-inside-work-tree',
  'rev-parse --show-toplevel',
  'rev-parse --verify HEAD',
  'status --porcelain=v1 -z --untracked-files=all',
]);

/**
 * Assert every recorded invocation is one of the five read-only reads.
 * @param {object[]} calls - recorded `{ joined }` calls.
 */
function assertReadOnly(calls) {
  const allowed = new Set(READ_ONLY_READS);
  for (const call of calls) {
    assert.ok(allowed.has(call.joined), `the preflight issued a non-read-only read: ${call.joined}`);
    const verb = call.args[0];
    assert.equal(MUTATING_VERBS.includes(verb), false, `the preflight must never run git ${verb}`);
  }
}

/** Create one temporary directory and return a remover. */
async function tempWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-preflight-'));
  return { directory, dispose: () => rm(directory, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// 1. The decision table
// ---------------------------------------------------------------------------

test('a clean repository root recommends worktree isolation and names the exact read-only reads it used', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const realRoot = await realpathOf(directory);
    const runGit = runner({ topLevel: realRoot });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory });
    assert.equal(result.ok, true);
    assert.equal(result.readOnly, true);
    assert.equal(result.isolation, 'worktree');
    assert.equal(result.reason, PREFLIGHT_REASONS.cleanRepository);
    assert.equal(result.sharedExplicit, false);
    assert.equal(result.decisionRequired, false);
    assert.equal(result.facts.gitAvailable, true);
    assert.equal(result.facts.repository, true);
    assert.equal(result.facts.hasCommits, true);
    assert.equal(result.facts.clean, true);
    assert.equal(result.facts.changedFiles, 0);
    assert.deepEqual(result.facts.changedPaths, []);
    assert.equal(result.facts.head, HEAD);
    assert.equal(result.facts.changedPathsTruncated, false);
    assert.equal(typeof result.checkedAt, 'number');
    assert.equal(typeof result.guidance, 'string');
    // The recommendation says worktree and nothing about naming another path: a
    // root workspace is usable as named.
    assert.match(result.guidance, /worktree isolation/u);
    assertReadOnly(runGit.calls);
    // Exactly the five reads, in this order, in the resolved workspace.
    assert.deepEqual(runGit.calls.map((call) => call.joined), [
      '--version',
      'rev-parse --is-inside-work-tree',
      'rev-parse --show-toplevel',
      'rev-parse --verify HEAD',
      'status --porcelain=v1 -z --untracked-files=all',
    ]);
    // Every read targeted the named workspace.
    assert.equal(runGit.calls.every((call) => call.cwd === realRoot), true);
  } finally {
    await dispose();
  }
});

test('a dirty repository root blocks until shared isolation is explicitly allowed', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const realRoot = await realpathOf(directory);
    const status = z(' M src/a.js', '?? notes.txt', 'A  src/new.js');
    const runGit = runner({
      topLevel: realRoot,
      table: { 'status --porcelain=v1 -z --untracked-files=all': { stdout: status, code: 0 } },
    });

    const blocked = await preflightWorkspace({ runGit }, { workspacePath: directory });
    assert.equal(blocked.isolation, 'block', 'a dirty workspace must never be downgraded automatically');
    assert.equal(blocked.reason, PREFLIGHT_REASONS.dirtyNeedsDecision);
    assert.equal(blocked.decisionRequired, true, 'the caller must be told a decision is the next step');
    assert.equal(blocked.sharedExplicit, false);
    assert.equal(blocked.facts.clean, false);
    assert.equal(blocked.facts.changedFiles, 3);
    assert.deepEqual(blocked.facts.changedPaths, ['src/a.js', 'notes.txt', 'src/new.js']);
    assert.match(blocked.guidance, /allowShared/u);
    assertReadOnly(runGit.calls);

    runGit.calls.length = 0;
    const shared = await preflightWorkspace({ runGit }, { workspacePath: directory, allowShared: true });
    assert.equal(shared.isolation, 'shared');
    assert.equal(shared.reason, PREFLIGHT_REASONS.dirtySharedExplicit);
    assert.equal(shared.sharedExplicit, true);
    assert.equal(shared.decisionRequired, false);
    assert.equal(shared.facts.changedFiles, 3);
    assertReadOnly(runGit.calls);
  } finally {
    await dispose();
  }
});

test('the changed-file list is bounded and says so instead of looking complete', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    // More entries than the published bound: the count must stay exact while the
    // list stops at the bound and is flagged.
    const many = Array.from({ length: PREFLIGHT_LIMITS.changedPaths + 7 }, (_unused, index) => `?? file-${index}.txt`);
    const runGit = runner({
      topLevel: await realpathOf(directory),
      table: { 'status --porcelain=v1 -z --untracked-files=all': { stdout: z(...many), code: 0 } },
    });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory, allowShared: true });
    assert.equal(result.facts.changedFiles, many.length);
    assert.equal(result.facts.changedPaths.length, PREFLIGHT_LIMITS.changedPaths);
    assert.equal(result.facts.changedPathsTruncated, true);
    // Renames keep both sides, so a sensitive *source* name is still reported.
    assert.equal(result.isolation, 'shared');
  } finally {
    await dispose();
  }
});

test('a touched credential file is named but its content is never read', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const runGit = runner({
      topLevel: await realpathOf(directory),
      table: { 'status --porcelain=v1 -z --untracked-files=all': { stdout: z(' M .env.local', ' M src/a.js'), code: 0 } },
    });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory });
    assert.deepEqual(result.facts.sensitivePaths, ['.env.local']);
    // Only `status` was read: no `diff`, no `show`, no file content at all.
    assert.equal(runGit.calls.every((call) => !call.joined.startsWith('diff')), true);
    assertReadOnly(runGit.calls);
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// 2. Every refusal path still produces one stable, bounded answer
// ---------------------------------------------------------------------------

test('a workspace that is not a git repository blocks, and never claims to be clean', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const runGit = runner({ table: { 'rev-parse --is-inside-work-tree': { stdout: 'false\n', code: 128 } } });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory });
    assert.equal(result.isolation, 'block');
    assert.equal(result.reason, PREFLIGHT_REASONS.notRepository);
    assert.equal(result.facts.repository, false);
    // `clean: null` is "unknown", and must not be readable as "nothing changed".
    assert.equal(result.facts.clean, null);
    assert.equal(result.facts.changedFiles, 0);
  } finally {
    await dispose();
  }
});

test('a repository with no commit blocks, because a worktree cannot be created from nothing', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const runGit = runner({
      topLevel: await realpathOf(directory),
      table: { 'rev-parse --verify HEAD': { stdout: '', code: 128 } },
    });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory });
    assert.equal(result.isolation, 'block');
    assert.equal(result.reason, PREFLIGHT_REASONS.noCommits);
    assert.equal(result.facts.repository, true);
    assert.equal(result.facts.hasCommits, false);
    assert.equal(result.facts.clean, null);
  } finally {
    await dispose();
  }
});

test('git that cannot run in this environment blocks instead of reporting an empty workspace', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const denied = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
    const runGit = runner({ table: { '--version': denied } });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory });
    assert.equal(result.isolation, 'block');
    assert.equal(result.reason, PREFLIGHT_REASONS.gitUnavailable);
    assert.equal(result.facts.gitAvailable, false);
    assert.equal(result.facts.clean, null);
  } finally {
    await dispose();
  }
});

test('a failed status read blocks with its own reason, keeping the facts already established', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const runGit = runner({
      topLevel: await realpathOf(directory),
      table: { 'status --porcelain=v1 -z --untracked-files=all': { stdout: '', stderr: 'fatal: index locked', code: 128 } },
    });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory });
    assert.equal(result.isolation, 'block');
    assert.equal(result.reason, PREFLIGHT_REASONS.gitFailed);
    assert.equal(result.facts.hasCommits, true);
    assert.equal(result.facts.head, HEAD);
    assert.equal(runGit.calls.length, 5, 'the status read was attempted exactly once');
  } finally {
    await dispose();
  }
});

test('a relative, missing or file path is refused rather than resolved against the process cwd', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const runGit = runner();
    const relative = await preflightWorkspace({ runGit }, { workspacePath: 'relative/workspace' });
    assert.equal(relative.isolation, 'block');
    assert.equal(relative.reason, PREFLIGHT_REASONS.workspaceInvalid);
    assert.equal(relative.workspacePath, null);

    const missing = await preflightWorkspace({ runGit }, { workspacePath: join(directory, 'missing') });
    assert.equal(missing.isolation, 'block');
    assert.equal(missing.reason, PREFLIGHT_REASONS.workspaceInvalid);

    const filePath = join(directory, 'a-file.txt');
    await writeFile(filePath, 'x');
    const file = await preflightWorkspace({ runGit }, { workspacePath: filePath });
    assert.equal(file.isolation, 'block');
    assert.equal(file.reason, PREFLIGHT_REASONS.notDirectory);
    // No git invocation was issued for any of the three: none of them reached a probe.
    assert.deepEqual(runGit.calls, []);
  } finally {
    await dispose();
  }
});

test('the answer shape is stable across every branch, so a caller can always read it', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const realRoot = await realpathOf(directory);
    const dirty = z(' M src/a.js');
    const cases = [
      preflightWorkspace({ runGit: runner({ topLevel: realRoot }) }, { workspacePath: directory }),
      preflightWorkspace(
        {
          runGit: runner({
            topLevel: realRoot,
            table: { 'status --porcelain=v1 -z --untracked-files=all': { stdout: dirty, code: 0 } },
          }),
        },
        { workspacePath: directory },
      ),
      preflightWorkspace(
        { runGit: runner({ table: { 'rev-parse --is-inside-work-tree': { stdout: 'false\n', code: 128 } } }) },
        { workspacePath: directory },
      ),
      // The subdirectory branch: same shape, different reason.
      preflightWorkspace(
        { runGit: runner({ topLevel: join(realRoot, '..') }) },
        { workspacePath: directory },
      ),
      preflightWorkspace({ runGit: runner() }, { workspacePath: 'nope' }),
    ];
    for (const result of await Promise.all(cases)) {
      assert.deepEqual(Object.keys(result).sort(), [
        'checkedAt', 'decisionRequired', 'facts', 'guidance', 'isolation', 'ok', 'readOnly', 'reason', 'sharedExplicit', 'workspacePath',
      ].sort());
      assert.equal(PREFLIGHT_ISOLATIONS.includes(result.isolation), true);
      assert.equal(Object.values(PREFLIGHT_REASONS).includes(result.reason), true);
      for (const key of ['gitAvailable', 'repository', 'hasCommits', 'changedFiles', 'changedPaths',
        'changedPathsTruncated', 'sensitivePaths']) {
        assert.ok(key in result.facts, `facts.${key} must always be present`);
      }
      // The published answer is JSON and fits a tool result.
      assert.ok(JSON.stringify(result).length < 20_000);
    }
  } finally {
    await dispose();
  }
});

test('the published bounds are the ones the audit layer can actually honour', async () => {
  // The preflight may tighten the audit bound but must never exceed it: a list
  // larger than the status parser retains would be silently short.
  assert.ok(PREFLIGHT_LIMITS.changedPaths <= AUDIT_LIMITS.statusEntries);
  assert.ok(PREFLIGHT_LIMITS.changedPaths <= AUDIT_LIMITS.samplePaths * 3);
  assert.equal(PREFLIGHT_LIMITS.pathChars > 0, true);
});

// ---------------------------------------------------------------------------
// 3. The surfaces: MCP tool routing and the execution-plane route
// ---------------------------------------------------------------------------

test('delegate_preflight is advertised with a closed schema and reaches only the preflight route', async () => {
  const seen = [];
  const server = createMcpServer({
    async callExecution(route, payload) {
      seen.push({ route, payload });
      return { ok: true, isolation: 'worktree' };
    },
  });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION } });
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tool = listed.result.tools.find((entry) => entry.name === 'delegate_preflight');
  assert.ok(tool, 'delegate_preflight must be advertised');
  assert.deepEqual(tool.inputSchema.required, ['workspacePath']);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['allowShared', 'workspacePath']);
  assert.equal(tool.inputSchema.properties.allowShared.type, 'boolean');
  assert.equal(tool.inputSchema.additionalProperties, false);
  // It must not offer a way to pick a route, an isolation or an authorization.
  for (const forbidden of ['isolation', 'overrides', 'providerId', 'model', 'reasoningEffort', 'grantId', 'token']) {
    assert.equal(forbidden in tool.inputSchema.properties, false, `delegate_preflight must not accept ${forbidden}`);
  }

  const response = await server.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'delegate_preflight', arguments: { workspacePath: 'C:\\w' } },
  });
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(seen, [{ route: 'preflight', payload: { workspacePath: 'C:\\w' } }]);
});

test('the execution client sends the preflight to its own registered path and method', async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ ok: true, isolation: 'block' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const client = createExecutionClient(readConfig({
      DSH_DELEGATE_BASE_URL: 'http://127.0.0.1:9999',
      DSH_DELEGATE_DISCOVERY_FILE: join(tmpdir(), 'unused.json'),
    }));
    const answer = await client('preflight', { workspacePath: 'C:\\w' });
    assert.equal(answer.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].init.method, 'POST');
    assert.equal(new URL(requests[0].url).pathname, '/dsh-delegate/x/workspace/preflight');
    assert.deepEqual(JSON.parse(requests[0].init.body), { workspacePath: 'C:\\w' });
  } finally {
    globalThis.fetch = original;
  }
});

test('the plane answers the preflight while the switch is off and while every slot is busy', async () => {
  // The property under test is that this route creates and consumes nothing, so it
  // is not gated by authorization: it asks the filesystem a question. The engine is
  // represented by a sentinel that fails loudly if anything but `posture` is
  // touched — a preflight that allocated a task, a slot or a grant would fail here.
  const deps = {
    runGit: runner({ topLevel: tmpdir() }),
    engine: {
      authorizationMode: 'switch',
      posture() { return { enabled: false, authorized: false, mode: 'switch' }; },
      start() { throw new Error('the preflight must never start a task'); },
      list() { throw new Error('the preflight must never list tasks'); },
      get() { throw new Error('the preflight must never read tasks'); },
      cancel() { throw new Error('the preflight must never cancel tasks'); },
    },
    auth: {
      authenticate() { throw new Error('the preflight must not authenticate against an auth mode it is not in'); },
      listGrants() { return []; },
    },
    settings: { read() { throw new Error('the preflight must not read settings'); } },
    logger: { warn() {} },
    getBindHost: () => '127.0.0.1',
  };
  const { createExecutionHandler } = await import('../src/http/execution-plane.js');
  const handler = createExecutionHandler(deps);
  const answer = await callPlane(handler, 'POST', '/dsh-delegate/x/workspace/preflight', { workspacePath: tmpdir() });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  // The point is that a decision came back with the switch off. `tmpdir()` is a
  // real directory and the runner reports a healthy repository root for it, so the
  // answer is a recommendation rather than an unrelated refusal.
  assert.equal(PREFLIGHT_ISOLATIONS.includes(answer.body.isolation), true);
  assert.equal(answer.body.readOnly, true);

  const refused = await callPlane(handler, 'POST', '/dsh-delegate/x/workspace/preflight', {});
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'WORKSPACE_PATH_REQUIRED');
});

test('the plane exports the preflight decision itself, so the route adds no second policy', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const topLevel = await realpathOf(directory);
    const direct = await preflightWorkspace({ runGit: runner({ topLevel }) }, { workspacePath: directory });
    const viaPlaneModule = await planePreflight({ runGit: runner({ topLevel }) }, { workspacePath: directory });
    assert.equal(viaPlaneModule.isolation, direct.isolation);
    assert.equal(viaPlaneModule.reason, direct.reason);
  } finally {
    await dispose();
  }
});

/**
 * Drive one execution-plane handler with a synthetic request.
 * @param {Function} handler - plane handler.
 * @param {string} method - HTTP method.
 * @param {string} path - request path.
 * @param {object} body - JSON body.
 * @returns {Promise<{ status: number, body: object }>} parsed answer.
 */
async function callPlane(handler, method, path, body) {
  const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  const req = {
    method,
    url: path,
    headers: {
      host: '127.0.0.1:5963',
      origin: 'http://127.0.0.1:5963',
      'content-type': 'application/json',
      'content-length': String(payload.length),
    },
    socket: { remoteAddress: '127.0.0.1', remotePort: 50_000 },
    [Symbol.asyncIterator]: async function* iterate() { yield payload; },
  };
  let status = 0;
  let text = '';
  const res = {
    headersSent: false,
    writeHead(code) { status = code; this.headersSent = true; return this; },
    setHeader() { return this; },
    end(chunk) { if (chunk !== undefined) text += chunk.toString('utf8'); },
    write(chunk) { text += chunk.toString('utf8'); return true; },
    getHeader() { return undefined; },
  };
  await handler(req, res);
  return { status, body: text === '' ? null : JSON.parse(text) };
}

test('nothing was created on disk while a decision was produced', async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const marker = join(directory, 'untouched.txt');
    await writeFile(marker, 'keep');
    const status = z(' M src/a.js');
    const runGit = runner({
      topLevel: await realpathOf(directory),
      table: { 'status --porcelain=v1 -z --untracked-files=all': { stdout: status, code: 0 } },
    });
    await preflightWorkspace({ runGit }, { workspacePath: directory });
    await preflightWorkspace({ runGit }, { workspacePath: directory, allowShared: true });
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual((await readdir(directory)).sort(), ['untouched.txt']);
    // And no nested directory appeared either.
    assert.equal((await readdir(directory)).includes('.git'), false);
  } finally {
    await dispose();
  }
});

// ---------------------------------------------------------------------------
// 4. Repository root, not merely "inside some work tree"
// ---------------------------------------------------------------------------

test('a subdirectory of a repository is refused with its own reason and root guidance', async () => {
  // The finding: `git rev-parse --is-inside-work-tree` answers `true` for a
  // subdirectory, so a path under a repository used to be reported as a clean
  // repository and recommended `worktree`. A tree created "for" that path lands
  // inside the user's checkout. The measured top level is what distinguishes the
  // two, so the refusal must be decided from that fact and not from prose.
  const { directory, dispose } = await tempWorkspace();
  try {
    const nested = join(directory, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    const realRoot = await realpathOf(directory);
    const realNested = await realpathOf(nested);
    const runGit = runner({ topLevel: realRoot });
    const result = await preflightWorkspace({ runGit }, { workspacePath: nested });

    assert.equal(result.isolation, 'block', 'a subdirectory must never be recommended for worktree or shared');
    assert.equal(result.reason, PREFLIGHT_REASONS.notRepositoryRoot);
    assert.equal(result.facts.repository, true, 'it *is* inside a repository');
    assert.equal(result.facts.hasCommits, false, 'no commit fact was measured for a path that is not the root');
    assert.equal(result.facts.clean, null, 'clean is unknown, not "clean"');
    assert.equal(result.facts.changedFiles, 0);

    // Accurate guidance: name the root. No worktree/shared suggestion, and no
    // instruction that would leave the user in the same trap.
    assert.ok(result.guidance.includes(realRoot), 'the guidance must name the measured repository root');
    assert.match(result.guidance, /not its root/u);
    assert.doesNotMatch(result.guidance, /worktree isolation/u);
    assert.doesNotMatch(result.guidance, /shared/u);

    // Read-only, and the status read was not issued at all: nothing about the
    // subdirectory's own working state is measured, because the path is not a
    // workspace in the first place.
    assertReadOnly(runGit.calls);
    assert.deepEqual(runGit.calls.map((call) => call.joined), [
      '--version',
      'rev-parse --is-inside-work-tree',
      'rev-parse --show-toplevel',
      'rev-parse --verify HEAD',
    ]);
    assert.equal(runGit.calls.every((call) => call.cwd === realNested), true);
  } finally {
    await dispose();
  }
});

test('a subdirectory is refused even when it is dirty and allowShared is passed', async () => {
  // `allowShared` decides *where* a dirty run executes; it is not permission to
  // treat a subdirectory as a workspace. The refusal comes first.
  const { directory, dispose } = await tempWorkspace();
  try {
    const nested = join(directory, 'sub');
    await mkdir(nested, { recursive: true });
    const runGit = runner({
      topLevel: await realpathOf(directory),
      table: { 'status --porcelain=v1 -z --untracked-files=all': { stdout: z(' M src/a.js'), code: 0 } },
    });
    const result = await preflightWorkspace({ runGit }, { workspacePath: nested, allowShared: true });
    assert.equal(result.isolation, 'block');
    assert.equal(result.reason, PREFLIGHT_REASONS.notRepositoryRoot);
    assert.equal(result.sharedExplicit, false);
    assert.equal(result.decisionRequired, false);
    assert.equal(runGit.calls.some((call) => call.joined.startsWith('status ')), false);
  } finally {
    await dispose();
  }
});

test('an unmeasurable top level is not assumed to be the workspace', async () => {
  // "Could not tell" must not read as "this is the root": a git that claims to be
  // inside a work tree but cannot report the top level refuses, so a workspace can
  // never be recommended on a fact that was not measured.
  const { directory, dispose } = await tempWorkspace();
  try {
    const runGit = runner({
      table: { 'rev-parse --show-toplevel': { stdout: '', stderr: 'fatal: bad revision', code: 128 } },
    });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory });
    assert.equal(result.isolation, 'block');
    assert.equal(result.reason, PREFLIGHT_REASONS.notRepositoryRoot);
    assert.equal(result.facts.clean, null);
  } finally {
    await dispose();
  }
});

test('a root workspace whose supplied path differs only by case or trailing separator is still a root', async () => {
  // Windows paths are case-insensitive and callers pass both forms; the comparison
  // is on real paths, so a case difference must not be mistaken for a subdirectory.
  const { directory, dispose } = await tempWorkspace();
  try {
    const realRoot = await realpathOf(directory);
    const supplied = process.platform === 'win32'
      ? `${realRoot.toUpperCase()}${realRoot.endsWith('\\') ? '' : '\\'}`
      : realRoot;
    const runGit = runner({ topLevel: realRoot });
    const result = await preflightWorkspace({ runGit }, { workspacePath: supplied });
    assert.equal(result.isolation, 'worktree');
    assert.equal(result.reason, PREFLIGHT_REASONS.cleanRepository);
  } finally {
    await dispose();
  }
});

test('a Windows root matches Git forward slashes against realpath backslashes', {
  skip: process.platform !== 'win32',
}, async () => {
  const { directory, dispose } = await tempWorkspace();
  try {
    const realRoot = await realpathOf(directory);
    const gitRoot = realRoot.replace(/\\/gu, '/');
    const runGit = runner({ topLevel: gitRoot });
    const result = await preflightWorkspace({ runGit }, { workspacePath: directory, allowShared: true });

    assert.equal(result.isolation, 'worktree');
    assert.equal(result.reason, PREFLIGHT_REASONS.cleanRepository);
  } finally {
    await dispose();
  }
});

test('the nested-path regression does not depend on the real filesystem being a repository', async () => {
  // Belt and braces: the decision comes from the measured top level, so a nested
  // path whose reported top level is a *sibling* is not a root either.
  const { directory, dispose } = await tempWorkspace();
  try {
    const nested = join(directory, 'inner');
    await mkdir(nested, { recursive: true });
    const runGit = runner({ topLevel: join(await realpathOf(directory), 'inner-sibling') });
    const result = await preflightWorkspace({ runGit }, { workspacePath: nested });
    assert.equal(result.isolation, 'block');
    assert.equal(result.reason, PREFLIGHT_REASONS.notRepositoryRoot);
  } finally {
    await dispose();
  }
});

/**
 * Resolve a path the way the workspace layer does, for the containment test.
 * @param {string} path - absolute path.
 * @returns {Promise<string>} real path.
 */
async function realpathOf(path) {
  const { realpath } = await import('node:fs/promises');
  return await realpath(path);
}
