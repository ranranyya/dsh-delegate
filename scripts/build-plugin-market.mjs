import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Generate a Git-pinned DSH format-1 index, never an unverified npm listing. */
export async function buildMarketSite({ commit, publishedAt, outputDir }) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('commit must be an exact lowercase 40-hex Git SHA');
  }
  if (typeof publishedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(publishedAt)) {
    throw new Error('publishedAt must be a real ISO timestamp with a timezone');
  }
  const timestamp = Math.floor(Date.parse(publishedAt) / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp >= 100_000_000_000) {
    throw new Error('publishedAt is outside the DSH timestamp range');
  }
  if (typeof outputDir !== 'string' || outputDir.trim() === '') throw new Error('outputDir is required');
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  if (manifest.name !== 'dsh-taskdispatch' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
    throw new Error('unexpected package identity/version');
  }
  const en = JSON.parse(await readFile(join(ROOT, 'locale/en.json'), 'utf8')).meta;
  const zh = JSON.parse(await readFile(join(ROOT, 'locale/zh.json'), 'utf8')).meta;
  const repository = 'https://github.com/ranranyya/dsh-taskdispatch';
  const document = {
    format: 1,
    title: { en: 'DSH TaskDispatch plugins', zh: 'DSH TaskDispatch 插件索引' },
    description: { en: 'Public releases maintained by ranranyya.', zh: '本项目维护的正式发布源；添加后可在 DSH 中搜索和安装。' },
    plugins: [{
      name: manifest.name,
      title: { en: en.title, zh: zh.title },
      description: { en: en.description, zh: zh.description },
      author: 'ranranyya',
      icon: 'icon.svg',
      homepage: `${repository}#readme`,
      repository: { url: repository },
      metadata: { keywords: [...manifest.keywords, 'Claude Code', '派工', '模型配置', '思考强度'] },
      versions: [{
        version: manifest.version,
        publishTimestamp: timestamp,
        source: { type: 'git', url: repository, commit },
        engines: { dsh: manifest.engines.dsh },
      }],
    }],
  };
  const output = resolve(outputDir);
  if (output === ROOT) throw new Error('outputDir must not be the repository root');
  await mkdir(output, { recursive: true });
  await copyFile(join(ROOT, 'icon.svg'), join(output, 'icon.svg'));
  await writeFile(join(output, 'index.json'), JSON.stringify(document, null, 2) + '\n', 'utf8');
  await writeFile(join(output, '.nojekyll'), '', 'utf8');
  return document;
}

async function main() {
  const args = process.argv.slice(2);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--commit', '--published-at', '--output'].includes(key) || !args[i + 1] || key in values) {
      throw new Error('Usage: --commit <40-hex> --published-at <ISO timestamp> --output <directory>');
    }
    values[key] = args[i + 1];
  }
  const result = await buildMarketSite({ commit: values['--commit'], publishedAt: values['--published-at'], outputDir: values['--output'] });
  process.stdout.write(JSON.stringify({ ok: true, name: result.plugins[0].name, version: result.plugins[0].versions[0].version }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
