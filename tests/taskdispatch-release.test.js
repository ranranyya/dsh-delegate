import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildMarketSite } from '../scripts/build-plugin-market.mjs';
import { isOwnedEntryScript, KNOWN_AGENT_TEMPLATES } from '../src/codex/installer.js';
import { installationRecordPath } from '../src/codex/seam.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

test('public identity changes while the actual managed data and MCP identifiers remain compatible', async () => {
  assert.equal(manifest.name, 'dsh-taskbridge');
  assert.equal(manifest.version, '1.4.0');
  const home = join(tmpdir(), 'taskdispatch-home-fixture');
  assert.equal(installationRecordPath({ DSH_HOME: home }), join(home, 'data', 'dsh-delegate', 'codex-installation.json'));
  assert.equal(manifest.bin['dsh-delegate-mcp'], 'bin/dsh-delegate-mcp.js');
  assert.equal(manifest.bin['dsh-delegate-control'], 'bin/dsh-delegate-control.js');
  for (const language of ['en', 'zh']) {
    const locale = JSON.parse(await readFile(join(ROOT, 'locale', `${language}.json`), 'utf8'));
    assert.equal(locale.meta.title, 'DSH TaskBridge');
    assert.match(locale.meta.description, /Claude Code/u);
    assert.match(locale.meta.description, /Codex/u);
    await readFile(join(ROOT, locale.meta.detail));
  }
});

for (const version of ['1.2.0', '1.3.0', '1.3.1', '1.3.2']) test(`the real published ${version} fixture remains recognized in exact LF and CRLF forms`, async () => {
  const prior = await readFile(join(ROOT, `tests/fixtures/codex-agent-${version}.toml`), 'utf8');
  const lf = prior.replaceAll('\r\n', '\n');
  for (const text of [lf, lf.replaceAll('\n', '\r\n')]) {
    const sha256 = createHash('sha256').update(text).digest('hex');
    assert.ok(KNOWN_AGENT_TEMPLATES.some(entry => entry.version === version && entry.sha256 === sha256));
  }
});

test('explicit moved-install proof accepts own old/new packages and rejects foreign same-name roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskdispatch-proof-'));
  try {
    await mkdir(join(root, 'bin'));
    const entry = join(root, 'bin/dsh-delegate-mcp.js');
    await writeFile(entry, '// fixture, never executed\n');
    const desired = join(root, 'different-install/bin/dsh-delegate-mcp.js');
    const cases = [
      ['dsh-delegate', 'https://github.com/ranranyya/dsh-delegate.git', true],
      ['dsh-taskdispatch', 'https://github.com/ranranyya/dsh-taskdispatch.git', true],
      ['dsh-taskbridge', 'git+https://github.com/ranranyya/dsh-taskbridge.git', true],
      ['dsh-taskbridge', 'https://github.com/ranranyya/dsh-taskdispatch.git', true],
      ['dsh-taskdispatch', 'https://github.com/someone-else/dsh-taskdispatch.git', false],
      ['dsh-delegate', 'https://github.com/dushaobindoudou/dsh-plugin.git', false],
      ['dsh-taskbridge', 'https://github.com/someone-else/dsh-taskbridge.git', false],
      ['dsh-delegate', undefined, false],
      ['dsh-delegate', 'https://github.com/ranranyya/dsh-delegate.git?claim=own', false],
    ];
    for (const [name, repository, expected] of cases) {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name, repository, bin: { 'dsh-delegate-mcp': 'bin/dsh-delegate-mcp.js' } }));
      assert.equal(await isOwnedEntryScript(entry, desired), expected, `${name}: ${repository}`);
    }
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-taskbridge', repository: manifest.repository, bin: { 'dsh-delegate-mcp': 'bin/wrapper.js' } }));
    assert.equal(await isOwnedEntryScript(entry, desired), false, 'repository identity cannot replace the existing bin proof');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('generated public index pins the real Git source and carries the exact version and Chinese intro', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'taskdispatch-market-'));
  try {
    const commit = '1'.repeat(40);
    const doc = await buildMarketSite({ commit, publishedAt: '2026-11-12T16:00:00Z', outputDir });
    assert.deepEqual(JSON.parse(await readFile(join(outputDir, 'index.json'), 'utf8')), doc);
    assert.equal(doc.format, 1);
    assert.equal(doc.plugins[0].name, manifest.name);
    assert.equal(doc.plugins[0].versions[0].version, manifest.version);
    assert.equal(doc.plugins[0].versions[0].engines.dsh, manifest.engines.dsh);
    assert.deepEqual(doc.plugins[0].versions[0].source, { type: 'git', url: 'https://github.com/ranranyya/dsh-taskbridge', commit });
    assert.match(doc.plugins[0].description.zh, /思考强度/u);
    assert.match(doc.plugins[0].description.zh, /Claude Code/u);
    assert.deepEqual(await readFile(join(outputDir, doc.plugins[0].icon)), await readFile(join(ROOT, 'icon.svg')));
  } finally { await rm(outputDir, { recursive: true, force: true }); }
});

test('generator rejects mutable refs, placeholder commits, unknown timestamps and a root output', async () => {
  for (const commit of ['HEAD', 'main', 'v1.3.0', '0'.repeat(39), 'A'.repeat(40), '']) {
    await assert.rejects(buildMarketSite({ commit, publishedAt: '2026-11-12T16:00:00Z', outputDir: join(tmpdir(), 'unused-taskdispatch') }), /40-hex/u);
  }
  for (const publishedAt of ['now', '', '2026-11-12', 'not-a-time']) {
    await assert.rejects(buildMarketSite({ commit: '1'.repeat(40), publishedAt, outputDir: join(tmpdir(), 'unused-taskdispatch') }), /timestamp/u);
  }
  await assert.rejects(buildMarketSite({ commit: '1'.repeat(40), publishedAt: '2026-11-12T16:00:00Z', outputDir: ROOT }), /repository root/u);
});
