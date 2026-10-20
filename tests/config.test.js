// Configuration tests: validation, layering, persistence and secret hygiene.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateProviderProfile,
  validateSettings,
  validateSelection,
  validateWorkerSettings,
  ConfigError,
} from '../src/config/validate.js';
import { projectKey, publicSettings, resolveEffectiveConfig, SettingsService } from '../src/config/settings.js';
import { isSensitivePath, isSecretKey, maskSecret, redactDeep, redactText } from '../src/config/redact.js';
import { JsonDocument, StoreError, writeFileAtomic } from '../src/config/store.js';
import { cleanup, makeTempDir, validSettings } from './helpers/fakes.js';

const PROVIDERS = [{
  id: 'relay',
  name: 'Relay',
  protocol: 'openai-chat',
  baseUrl: 'http://127.0.0.1:8443/v1',
  credentialRef: 'RELAY_KEY',
  models: [
    { id: 'deepseek-chat', efforts: ['low', 'medium', 'high'] },
    { id: 'plain', efforts: [] },
  ],
}];

test('a valid settings document round-trips through validation', () => {
  const settings = validateSettings(validSettings());
  assert.equal(settings.providers[0].id, 'relay');
  assert.equal(settings.worker.reasoningEffort, 'medium');
  assert.equal(settings.review.enabled, false);
});

test('a provider cannot carry a secret value in settings', () => {
  assert.throws(
    () => validateProviderProfile({ ...PROVIDERS[0], apiKey: 'sk-live-value' }),
    (error) => error instanceof ConfigError && error.code === 'PROVIDER_SECRET_IN_SETTINGS',
  );
});

test('a base URL with embedded credentials is refused', () => {
  assert.throws(
    () => validateProviderProfile({ ...PROVIDERS[0], baseUrl: 'http://user:pass@127.0.0.1:8443/v1' }),
    (error) => error.code === 'PROVIDER_BASE_URL_INVALID',
  );
});

test('an unsupported protocol is refused', () => {
  assert.throws(
    () => validateProviderProfile({ ...PROVIDERS[0], protocol: 'anthropic' }),
    (error) => error.code === 'PROVIDER_PROTOCOL_UNSUPPORTED',
  );
});

test('an unknown settings schema version is refused rather than migrated', () => {
  assert.throws(
    () => validateSettings({ ...validSettings(), schemaVersion: 99 }),
    (error) => error.code === 'SETTINGS_SCHEMA_UNSUPPORTED',
  );
});

test('a fresh install may store settings with no provider selected yet', () => {
  const settings = validateSettings({
    schemaVersion: 1,
    providers: [],
    worker: { providerId: null, model: null, reasoningEffort: null },
    review: { enabled: false },
  });
  assert.deepEqual(settings.providers, []);
  assert.equal(settings.worker.providerId, null);
});

test('selecting an undeclared model is refused', () => {
  assert.throws(
    () => validateSelection({ providerId: 'relay', model: 'nope', reasoningEffort: null }, PROVIDERS),
    (error) => error.code === 'SELECTION_MODEL_UNKNOWN',
  );
});

test('selecting an undeclared effort for a model is refused', () => {
  assert.throws(
    () => validateSelection({ providerId: 'relay', model: 'plain', reasoningEffort: 'high' }, PROVIDERS),
    (error) => error.code === 'SELECTION_EFFORT_UNSUPPORTED',
  );
});

test('enabling review without a selection is refused', () => {
  assert.throws(
    () => validateSettings(validSettings({ review: { enabled: true } })),
    (error) => error.code === 'SELECTION_PROVIDER_REQUIRED',
  );
});

test('enabling review with an independently valid selection is accepted', () => {
  const settings = validateSettings(validSettings({
    review: { enabled: true, providerId: 'relay', model: 'deepseek-chat', reasoningEffort: 'high' },
  }));
  assert.equal(settings.review.enabled, true);
  assert.equal(settings.review.model, 'deepseek-chat');
  assert.equal(settings.review.reasoningEffort, 'high');
});

test('worker bounds are enforced, not clamped', () => {
  assert.throws(
    () => validateWorkerSettings({ ...validSettings().worker, timeoutSeconds: 1 }, PROVIDERS),
    (error) => error.code === 'WORKER_TIMEOUT_INVALID',
  );
  assert.throws(
    () => validateWorkerSettings({ ...validSettings().worker, maxParallelism: 99 }, PROVIDERS),
    (error) => error.code === 'WORKER_PARALLELISM_INVALID',
  );
  assert.throws(
    () => validateWorkerSettings({ ...validSettings().worker, isolation: 'sandbox' }, PROVIDERS),
    (error) => error.code === 'WORKER_ISOLATION_INVALID',
  );
});

test('layering composes project then job overrides over global settings', () => {
  const settings = validateSettings(validSettings({
    projectOverrides: {
      'C:\\work\\project': {
        worker: { providerId: 'relay', model: 'deepseek-chat', reasoningEffort: 'low', timeoutSeconds: 900, maxParallelism: 1, isolation: 'shared' },
      },
    },
  }));
  const effective = resolveEffectiveConfig(settings, {
    projectPath: 'C:\\work\\project',
    overrides: { reasoningEffort: 'high' },
  });
  assert.equal(effective.worker.reasoningEffort, 'high', 'job override wins over project');
  assert.equal(effective.worker.timeoutSeconds, 900, 'project value survives when the job does not override it');
  assert.deepEqual(effective.provenance.applied, ['project:worker', 'job:worker']);
});

test('an unconfigured selection is refused at job time even when storable', () => {
  const settings = validateSettings({ schemaVersion: 1, providers: [] });
  assert.throws(
    () => resolveEffectiveConfig(settings, {}),
    (error) => error.code === 'SELECTION_PROVIDER_REQUIRED',
  );
});

test('a job override cannot name a model the provider does not declare', () => {
  const settings = validateSettings(validSettings());
  assert.throws(
    () => resolveEffectiveConfig(settings, { overrides: { model: 'ghost-model' } }),
    (error) => error.code === 'SELECTION_MODEL_UNKNOWN',
  );
});

test('a job override with an unknown key is refused', () => {
  const settings = validateSettings(validSettings());
  assert.throws(
    () => resolveEffectiveConfig(settings, { overrides: { temperature: 2 } }),
    (error) => error.code === 'OVERRIDE_INVALID',
  );
});

test('the public settings projection contains no secret value', () => {
  const settings = validateSettings(validSettings());
  const projection = publicSettings(settings);
  const text = JSON.stringify(projection);
  assert.equal(text.includes('sk-'), false);
  // A credential *reference* is expected and safe; a value is not.
  assert.equal(projection.providers[0].credentialRef, 'DSH_DELEGATE_RELAY_KEY');
});

test('redaction masks secret-named keys and credential-shaped text', () => {
  assert.equal(isSecretKey('apiKey'), true);
  assert.equal(isSecretKey('credentialRef'), false, 'a reference is not a secret');
  assert.equal(maskSecret('sk-abcdef0123456789'), '••••••••');

  const redacted = redactDeep({
    provider: 'relay',
    apiKey: 'sk-abcdefghijklmnop',
    nested: { token: 'abc123', endpoint: 'http://127.0.0.1:8443/v1' },
  });
  assert.equal(redacted.apiKey, '••••••••');
  assert.equal(redacted.nested.token, '••••••••');
  assert.equal(redacted.nested.endpoint, 'http://127.0.0.1:8443/v1');

  assert.equal(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwx'), 'Authorization: Bearer ••••••••');
  assert.equal(redactText('sk-abcdefghijklmnopqrstuvwx'), '••••••••');
  assert.equal(redactText('DSH_API_KEY=secret-value'), 'DSH_API_KEY=••••••••');
});

test('sensitive workspace paths are recognized', () => {
  for (const path of ['.env', '.env.local', 'config/credentials.json', 'keys/server.pem', 'certs/tls.key', 'secret-store.json']) {
    assert.equal(isSensitivePath(path), true, path);
  }
  for (const path of ['src/index.js', 'README.md', 'docs/.envrc.md'.replace('.envrc', 'envrc')]) {
    assert.equal(isSensitivePath(path), false, path);
  }
});

test('settings persist across a service restart', async () => {
  const dir = await makeTempDir();
  try {
    const first = new SettingsService(dir);
    await first.replace(validSettings());
    assert.equal((await first.read()).providers.length, 1);

    const second = new SettingsService(dir);
    const reloaded = await second.read();
    assert.equal(reloaded.providers[0].id, 'relay');
    assert.equal(reloaded.worker.model, 'deepseek-chat');
  } finally {
    await cleanup(dir);
  }
});

test('removing a provider in use is refused', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings());
    await assert.rejects(
      () => service.removeProvider('relay'),
      (error) => error.code === 'PROVIDER_IN_USE',
    );
  } finally {
    await cleanup(dir);
  }
});

test('a stored document from an unknown schema is refused at load', async () => {
  const dir = await makeTempDir();
  try {
    await writeFileAtomic(`${dir}/settings.json`, JSON.stringify({ schemaVersion: 7, providers: [] }));
    const service = new SettingsService(dir);
    await assert.rejects(() => service.read(), (error) => error instanceof StoreError && error.code === 'STORE_SCHEMA_UNSUPPORTED');
  } finally {
    await cleanup(dir);
  }
});

test('a malformed stored document is refused at load', async () => {
  const dir = await makeTempDir();
  try {
    await writeFileAtomic(`${dir}/settings.json`, '{ not json');
    const service = new SettingsService(dir);
    await assert.rejects(() => service.read(), (error) => error.code === 'STORE_MALFORMED');
  } finally {
    await cleanup(dir);
  }
});

test('concurrent document commits do not lose an update', async () => {
  const dir = await makeTempDir();
  try {
    const doc = new JsonDocument(dir, 'counter.json', {
      schemaVersion: 1,
      initial: () => ({ schemaVersion: 1, value: 0 }),
    });
    await doc.load();
    await Promise.all(Array.from({ length: 10 }, () => doc.commit((draft) => { draft.value += 1; })));
    assert.equal((await doc.load()).value, 10);
  } finally {
    await cleanup(dir);
  }
});

test('project keys are case-folded on Windows only', () => {
  const { key } = projectKey('C:\\Work\\Project\\');
  if (process.platform === 'win32') {
    assert.equal(key, 'c:\\work\\project');
  } else {
    assert.equal(key, 'C:\\Work\\Project');
  }
});
