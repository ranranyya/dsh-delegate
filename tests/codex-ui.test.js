// Settings-page flow for the Codex integration.
//
// Two layers, because the interesting properties live in different places:
//
//   1. **Store** (`src/client/api.js`) — `init()` must only *read* Codex state and
//      `runCodexAction()` must be the single writer, reachable through one explicit
//      action. These run against a fake transport, so every request the page can
//      make is visible.
//   2. **Bundle** (`lib/client.js`) — the built page must actually contain the
//      Codex panel, one button per action, and the wording that states the
//      reload requirement and the `@`-selection limitation. The bundle is not a
//      module, so it is inspected as text; that is the same technique
//      `tests/client.test.js` already uses for registration facts.
//
// The React component itself is not rendered: no renderer is installed here, and the
// page's behaviour is driven through the store, which is what the component calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODEX_ACTIONS,
  ROUTES,
  codexTargetView,
  createStore,
  describeCodexOutcome,
  defaultDraft,
} from '../src/client/api.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
const PAGE_SOURCE = readFileSync(join(ROOT, 'src', 'client', 'index.jsx'), 'utf8');

/** A served Codex status document, shaped like the host's. */
function codexDocument(overrides = {}) {
  return {
    codexHome: 'C:\\Users\\demo\\.codex',
    packageVersion: '0.1.6',
    agent: { path: 'C:\\Users\\demo\\.codex\\agents\\dsh-delegate.toml', state: 'not-installed', installed: false, managed: true },
    mcp: {
      path: 'C:\\Users\\demo\\.codex\\config.toml',
      state: 'not-configured',
      configured: false,
      serverName: 'dsh-delegate',
      script: 'C:\\pkg\\bin\\dsh-delegate-mcp.js',
      scriptExists: true,
    },
    config: { readable: true, error: null },
    ready: false,
    notes: [],
    ...overrides,
  };
}

/**
 * Build a store over a recording transport.
 * @param {object} [options] - `status`, `action` responders.
 * @returns {{ store: object, calls: string[] }} store and recorded requests.
 */
function storeFixture(options = {}) {
  const calls = [];
  const codex = options.codex ?? codexDocument();
  const api = {
    async getStatus() {
      calls.push('GET status');
      return { ok: true, delegation: { authorized: false, mode: 'switch', reason: 'delegation is off' }, runtime: {} };
    },
    async getSettings() {
      calls.push('GET settings');
      return { ok: true, settings: defaultDraft() };
    },
    async getNativeProviders() {
      calls.push('GET native-providers');
      return { ok: true, providers: [] };
    },
    async listTasks() {
      calls.push('GET tasks');
      return { ok: true, tasks: [] };
    },
    async getCatalog() {
      calls.push('POST catalog');
      return { ok: true, catalog: [], effective: null };
    },
    async getCodexStatus() {
      calls.push('GET codex');
      return { ok: true, codex, switch: { authorized: false } };
    },
    async runCodexAction(action) {
      calls.push(`POST codex ${action}`);
      const installed = action !== 'remove';
      return {
        ok: true,
        action,
        changed: installed ? ['agent', 'mcp'] : ['agent', 'mcp'],
        refused: [],
        codex: codexDocument({
          agent: { ...codex.agent, state: installed ? 'installed' : 'not-installed', installed },
          mcp: { ...codex.mcp, state: installed ? 'configured' : 'not-configured', configured: installed },
          ready: installed,
        }),
        switch: { authorized: false, changedByThisAction: false },
      };
    },
  };
  return { store: createStore({ api }), calls };
}

// ---------------------------------------------------------------------------
// 1. The store never writes unless an operator asks
// ---------------------------------------------------------------------------

test('init() only reads the Codex state: opening the page cannot install anything', async () => {
  const { store, calls } = storeFixture();
  await store.init();
  // `init` fires the diagnostic read without awaiting it.
  await new Promise((resolve) => { setTimeout(resolve, 5); });

  assert.deepEqual(calls.filter((call) => call.startsWith('POST codex')), [], 'init must not perform an action');
  assert.ok(calls.includes('GET codex'), 'init must read the status so the panel can render');
  assert.equal(store.getSnapshot().codex.agent.state, 'not-installed');
});

test('saving settings, loading tasks or the catalog never touches Codex', async () => {
  const { store, calls } = storeFixture();
  await store.refreshStatus();
  await store.loadSettings();
  await store.loadTasks();
  await store.loadCatalog();
  assert.deepEqual(calls.filter((call) => call.includes('codex')), []);
});

test('each explicit action issues exactly one POST and records its outcome', async () => {
  const { store, calls } = storeFixture();
  await store.refreshCodexStatus();
  for (const action of CODEX_ACTIONS) {
    const result = await store.runCodexAction(action);
    assert.equal(result.ok, true, action);
    assert.equal(calls.filter((call) => call === `POST codex ${action}`).length, 1, action);
  }
  assert.deepEqual(
    calls.filter((call) => call.startsWith('POST codex')),
    CODEX_ACTIONS.map((action) => `POST codex ${action}`),
  );
  assert.deepEqual(store.getSnapshot().codexOutcome.changed, ['agent', 'mcp']);
  assert.equal(store.getSnapshot().codex.ready, false, 'remove leaves nothing installed');
});

test('the client refuses an action the host does not offer, without a request', async () => {
  const { store, calls } = storeFixture();
  for (const action of ['status', 'delete-everything', undefined]) {
    const result = await store.runCodexAction(action);
    assert.equal(result.ok, false);
  }
  assert.deepEqual(calls.filter((call) => call.startsWith('POST codex')), []);
  assert.equal(ROUTES.codex, '/api/dsh-delegate/codex');
});

// ---------------------------------------------------------------------------
// 2. Separating the three facts
// ---------------------------------------------------------------------------

test('agent installed, MCP configured and the DSH switch are three independent reports', () => {
  const codex = codexDocument({
    agent: { state: 'installed', installed: true, path: 'A' },
    mcp: { state: 'not-configured', configured: false, path: 'M', script: 'S' },
    ready: false,
  });
  assert.equal(codexTargetView(codex, null, 'agent').tone, 'on');
  assert.equal(codexTargetView(codex, null, 'agent').detail, '已安装');
  assert.equal(codexTargetView(codex, null, 'mcp').tone, 'off');
  assert.equal(codexTargetView(codex, null, 'mcp').detail, '未配置');
  assert.equal(codexTargetView(codex, { authorized: false }, 'switch').detail.includes('不会'), true);
  assert.equal(codexTargetView(codex, { authorized: true }, 'switch').tone, 'on');
  const unrecognizedAgent = codexDocument({
    agent: { path: 'agent.toml', state: 'modified', installed: false, managed: false },
  });
  assert.match(codexTargetView(unrecognizedAgent, null, 'agent').detail, /不属于已知版本/u);
  // A conflict is warn-toned, not "on", even though the state string differs.
  const conflict = codexDocument({ mcp: { state: 'conflict', configured: false, path: 'M', script: 'S' } });
  assert.equal(codexTargetView(conflict, null, 'mcp').tone, 'warn');
  assert.match(codexTargetView(conflict, null, 'mcp').detail, /冲突/u);
  // A missing block (an older host) is reported, not thrown.
  assert.equal(codexTargetView(null, null, 'agent').state, 'unknown');
});

test('an outcome is rendered from what changed and what was refused, not from optimism', () => {
  assert.match(describeCodexOutcome({ action: 'install', changed: ['agent', 'mcp'], refused: [] }), /已写入：子智能体文件、MCP 条目/u);
  assert.match(
    describeCodexOutcome({ action: 'install', changed: ['mcp'], refused: [{ target: 'agent', code: 'AGENT_USER_MODIFIED' }] }),
    /未改动：子智能体文件/u,
  );
  assert.match(describeCodexOutcome({ action: 'remove', changed: [], refused: [] }), /没有需要移除/u);
  assert.match(describeCodexOutcome({ action: 'install', changed: [], refused: [] }), /已是最新/u);
  assert.equal(describeCodexOutcome(null), '');
});

// ---------------------------------------------------------------------------
// 3. The built page
// ---------------------------------------------------------------------------

test('the built page carries the Codex panel, one explicit button per action', () => {
  assert.match(BUNDLE, /Codex 集成（子智能体 \+ MCP）/u);
  assert.match(BUNDLE, /安装 \/ 更新 TaskBridge 智能体/u);
  assert.match(BUNDLE, /仅修复 MCP 配置/u);
  assert.match(BUNDLE, /移除插件托管项/u);
  assert.match(BUNDLE, /刷新状态/u);
  // The panel is a tab, and the tab key routes to it.
  assert.match(BUNDLE, /key: "codex"/u);
  assert.match(BUNDLE, /CodexPanel/u);
  // Each write button is a click handler over the one store action.
  const install = BUNDLE.match(/runCodexAction\("install"\)/gu) ?? [];
  const repair = BUNDLE.match(/runCodexAction\("repair"\)/gu) ?? [];
  const remove = BUNDLE.match(/runCodexAction\("remove"\)/gu) ?? [];
  assert.equal(install.length, 1);
  assert.equal(repair.length, 1);
  assert.equal(remove.length, 1);
});

test('the page states the reload requirement, the limits, and that it never enables the switch', () => {
  assert.match(PAGE_SOURCE, /新开会话或重启 Codex/u);
  // The `@` claim is stated as *not* made: the page must say the Codex surface
  // decides whether a mention selects the agent, and must not promise it.
  assert.match(PAGE_SOURCE, /不宣称当前 Codex 桌面版\/CLI 能在输入框用 @dsh-taskbridge 直接选中/u);
  assert.match(PAGE_SOURCE, /取决于 Codex 版本自身是否提供提及选择/u);
  assert.doesNotMatch(PAGE_SOURCE, /支持在输入框直接输入 @dsh-taskbridge/u, 'the old claim must be gone');
  assert.match(PAGE_SOURCE, /不会替你打开该开关/u);
  // The page states the truth about writes: the FIRST installation is only ever a click,
  // and an already-installed managed entry is upgraded in place at the next startup. The
  // old sentence ("only a click writes / installing the plugin never changes Codex")
  // contradicted the startup upgrade and must be gone.
  assert.match(PAGE_SOURCE, /首次安装只会由你点击触发/u);
  assert.match(PAGE_SOURCE, /不会自动创建子智能体文件或 MCP 条目/u);
  assert.match(PAGE_SOURCE, /插件下次启动会把本插件自己写入的过期托管条目就地更新/u);
  assert.match(PAGE_SOURCE, /不会改写非托管、被你改过的条目/u);
  assert.doesNotMatch(PAGE_SOURCE, /只有你点击才会写文件/u, 'the unconditional claim must be gone');
  assert.doesNotMatch(PAGE_SOURCE, /打开本页或安装插件都不会改动 Codex/u, 'the contradicting claim must be gone');
  assert.match(PAGE_SOURCE, /没有本插件托管标记注释的同名 MCP 条目也视为你自己写的/u);
  // No button may flip the delegation switch from this panel.
  const panel = PAGE_SOURCE.slice(PAGE_SOURCE.indexOf('function CodexPanel'), PAGE_SOURCE.indexOf('// Root page'));
  assert.doesNotMatch(panel, /setDelegationEnabled/u);
  assert.doesNotMatch(panel, /saveSettings/u);
});
