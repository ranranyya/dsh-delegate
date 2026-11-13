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
import {
  CONVERSATION_POLICY,
  exportSettings,
  projectKey,
  publicSettings,
  resolveEffectiveConfig,
  SettingsService,
  SETTINGS_CODES,
} from '../src/config/settings.js';
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

test('project keys use the canonical form from validate.js', () => {
  const { key, display } = projectKey('C:\\Work\\Project\\');
  // A Windows-style path is case-folded for its key on every platform, because
  // the stored map is a JSON object and NTFS compares case-insensitively.
  assert.equal(key, 'c:\\work\\project');
  assert.equal(display, 'C:\\Work\\Project');
  // Slash style and case do not create a second key.
  assert.equal(projectKey('c:/work/project').key, key);
  assert.equal(projectKey('C:\\Work\\Project\\.\\').key, key);
});

test('a relative project path is refused instead of resolved against the cwd', () => {
  assert.throws(() => projectKey('work/project'), (error) => error.code === 'PROJECT_OVERRIDE_INVALID');
});

test('a project override is reachable through any spelling of the same path', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings());
    await service.setProjectOverride('C:/Work/Project/', {
      worker: { providerId: 'relay', model: 'deepseek-chat', reasoningEffort: 'low', timeoutSeconds: 900, maxParallelism: 1, isolation: 'shared' },
    });
    const stored = await service.read();
    assert.deepEqual(Object.keys(stored.projectOverrides), ['C:\\Work\\Project'], 'the stored key is the canonical display form');

    const effective = resolveEffectiveConfig(stored, { projectPath: 'c:\\work\\PROJECT' });
    assert.equal(effective.worker.reasoningEffort, 'low', 'lookup is canonical, so a different spelling still applies');
    assert.deepEqual(effective.provenance.applied, ['project:worker']);
    assert.equal(effective.provenance.projectKey, 'c:\\work\\project');

    // Clearing through a third spelling removes the one stored entry.
    await service.setProjectOverride('C:\\Work\\Project', null);
    assert.deepEqual(Object.keys((await service.read()).projectOverrides), []);
  } finally {
    await cleanup(dir);
  }
});

test('concurrent edits to different settings blocks both survive', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings());
    await Promise.all([
      service.setWorker({ providerId: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'high', timeoutSeconds: 1200, maxParallelism: 2, isolation: 'shared' }),
      service.setAuthorization({ taskGrantTtlSeconds: 120, sessionGrantTtlSeconds: 600 }),
      service.upsertProvider({
        id: 'backup',
        name: 'Backup relay',
        protocol: 'openai-chat',
        baseUrl: 'https://relay.example.test/v1',
        credentialRef: 'BACKUP_KEY',
        models: [{ id: 'm1', efforts: [] }],
      }),
    ]);
    const stored = await service.read();
    assert.equal(stored.worker.model, 'deepseek-reasoner', 'the worker edit was not overwritten by a sibling read');
    assert.equal(stored.worker.timeoutSeconds, 1200);
    assert.equal(stored.authorization.taskGrantTtlSeconds, 120);
    assert.deepEqual(stored.providers.map((provider) => provider.id), ['relay', 'backup']);
    assert.deepEqual(stored.presets, [], 'a provider edit alone must not resurrect dropped presets');

    const reloaded = new SettingsService(dir);
    assert.equal((await reloaded.read()).worker.model, 'deepseek-reasoner', 'the last committed snapshot reached the file');
  } finally {
    await cleanup(dir);
  }
});

test('ordinary configuration replacement preserves the separately managed delegation switch', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace({ ...validSettings(), delegationEnabled: true });
    const next = await service.replaceConfiguration({
      ...validSettings({ worker: { model: 'deepseek-reasoner', reasoningEffort: 'high' } }),
      delegationEnabled: false,
    });
    assert.equal(next.delegationEnabled, true, 'a settings form cannot change the independent switch');
    assert.equal(next.worker.model, 'deepseek-reasoner');

    await service.setDelegationEnabled(false);
    assert.equal((await service.read()).delegationEnabled, false, 'the switch endpoint remains its sole writer');
  } finally {
    await cleanup(dir);
  }
});

test('a refused edit does not poison the queue for the next one', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings());
    const results = await Promise.allSettled([
      service.setWorker({ providerId: 'relay', model: 'ghost-model', reasoningEffort: null }),
      service.setAuthorization({ taskGrantTtlSeconds: 240, sessionGrantTtlSeconds: 600 }),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[0].reason.code, 'SELECTION_MODEL_UNKNOWN');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal((await service.read()).authorization.taskGrantTtlSeconds, 240);
    assert.equal((await service.read()).worker.model, 'deepseek-chat', 'the refused edit changed nothing');
  } finally {
    await cleanup(dir);
  }
});

test('hooks run in order and a failing beforeCommit leaves the document untouched', async () => {
  const dir = await makeTempDir();
  try {
    const order = [];
    const service = new SettingsService(dir, {
      beforeCommit: async (next, previous) => {
        order.push(['before', previous.worker.model, next.worker.model]);
        assert.ok(Object.isFrozen(next), 'beforeCommit receives an immutable snapshot');
        assert.ok(Object.isFrozen(previous), 'the previous snapshot is immutable too');
        if (next.worker.model === 'deepseek-reasoner') throw new Error('registry refused the provider');
      },
      onChanged: async (next, previous) => {
        order.push(['after', previous.worker.model, next.worker.model]);
        assert.ok(Object.isFrozen(next));
      },
    });
    // Seed the document. A fresh install has no selection yet, so the first
    // write is not the case under test.
    await service.replace(validSettings());
    order.length = 0;
    await service.setAuthorization({ taskGrantTtlSeconds: 300, sessionGrantTtlSeconds: 600 });
    assert.deepEqual(order, [['before', 'deepseek-chat', 'deepseek-chat'], ['after', 'deepseek-chat', 'deepseek-chat']]);

    order.length = 0;
    await assert.rejects(
      () => service.setWorker({ providerId: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
      /registry refused the provider/,
    );
    assert.deepEqual(order, [['before', 'deepseek-chat', 'deepseek-reasoner']], 'onChanged must not run after a refused pre-commit');
    assert.equal((await service.read()).worker.model, 'deepseek-chat', 'the cached snapshot still holds the previous document');
    const reloaded = new SettingsService(dir);
    assert.equal((await reloaded.read()).worker.model, 'deepseek-chat', 'nor did the refusal reach the store');
  } finally {
    await cleanup(dir);
  }
});

test('a failing onChanged reports that the document was already persisted', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir, {
      onChanged: async () => { throw new Error('subscriber crashed'); },
    });
    await assert.rejects(
      () => service.replace(validSettings()),
      (error) => error.code === SETTINGS_CODES.changedHookFailed && error.details.persisted === true,
    );
    assert.equal((await new SettingsService(dir).read()).worker.model, 'deepseek-chat', 'the write stands and is readable');
    assert.equal((await service.read()).worker.model, 'deepseek-chat', 'the cache was not rolled back either');
  } finally {
    await cleanup(dir);
  }
});

test('callers cannot mutate internal state through a returned snapshot', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    const document = {
      ...validSettings(),
      presets: [{ id: 'fast', name: 'Fast', worker: { providerId: 'relay', model: 'deepseek-chat', reasoningEffort: 'low' } }],
    };
    await service.replace(document);
    const first = await service.read();
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.providers[0].models[0].efforts));
    assert.throws(() => { first.worker.model = 'hijacked'; }, TypeError);
    assert.throws(() => { first.providers[0].models[0].efforts.push('max'); }, TypeError);
    assert.throws(() => { first.projectOverrides['C:\\x'] = {}; }, TypeError);

    const projection = publicSettings(first);
    assert.throws(() => { projection.presets[0].worker.model = 'hijacked'; }, TypeError);
    assert.equal((await service.read()).worker.model, 'deepseek-chat');
    assert.notEqual(publicSettings(first), projection, 'each projection is a fresh object, not the stored one');
  } finally {
    await cleanup(dir);
  }
});

test('the executable snapshot is immutable and names its provider route explicitly', () => {
  const settings = validateSettings(validSettings());
  const effective = resolveEffectiveConfig(settings, { projectPath: null, overrides: {} });
  assert.ok(Object.isFrozen(effective) && Object.isFrozen(effective.worker) && Object.isFrozen(effective.provenance));
  assert.equal(effective.worker.providerId, 'relay', 'omitted job overrides retain the provider selected in DSH');
  assert.equal(effective.worker.model, 'deepseek-chat', 'omitted job overrides retain the model selected in DSH');
  assert.equal(effective.worker.reasoningEffort, 'medium', 'omitted job overrides retain the effort selected in DSH');
  assert.equal(effective.worker.providerRoute, 'relay', 'the route handed to the native agent is an explicit field');
  assert.equal(effective.review.providerRoute, null);
  assert.throws(() => { effective.worker.model = 'deepseek-reasoner'; }, TypeError);
});

test('public settings and export include nonsecret presets and no credential value', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace({
      ...validSettings(),
      presets: [{
        id: 'thorough',
        name: 'Thorough',
        worker: { providerId: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'high' },
        review: { enabled: true, providerId: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'medium' },
      }],
    });
    const stored = await service.read();
    assert.equal(stored.presets.length, 1);

    for (const projection of [publicSettings(stored), exportSettings(stored)]) {
      assert.deepEqual(projection.presets, [{
        id: 'thorough',
        name: 'Thorough',
        worker: { ...projection.presets[0].worker },
        review: {
          enabled: true,
          providerId: 'relay',
          model: 'deepseek-reasoner',
          reasoningEffort: 'medium',
        },
      }]);
      assert.equal(JSON.stringify(projection).includes('sk-'), false);
      assert.equal(JSON.stringify(projection).includes('DSH_DELEGATE_RELAY_KEY_VALUE'), false);
      assert.equal(projection.providers[0].credentialRef, 'DSH_DELEGATE_RELAY_KEY', 'a reference is a name, not a value');
    }
  } finally {
    await cleanup(dir);
  }
});

test('a stored document whose project key is not canonical is still found', async () => {
  const dir = await makeTempDir();
  try {
    // Written by a build that keyed overrides by the caller's spelling.
    const legacy = validSettings({
      projectOverrides: {
        'c:/work/project/': {
          worker: { providerId: 'relay', model: 'deepseek-chat', reasoningEffort: 'low', timeoutSeconds: 900, maxParallelism: 1, isolation: 'shared' },
        },
      },
    });
    await writeFileAtomic(`${dir}/settings.json`, JSON.stringify(legacy));
    const service = new SettingsService(dir);
    const stored = await service.read();
    assert.deepEqual(Object.keys(stored.projectOverrides), ['c:\\work\\project'], 'validation canonicalizes the key on load');
    const effective = resolveEffectiveConfig(stored, { projectPath: 'C:\\Work\\Project' });
    assert.equal(effective.worker.reasoningEffort, 'low');
  } finally {
    await cleanup(dir);
  }
});



// --- The retired conversation mode ------------------------------------------
//
// What a run does with its DSH conversation used to be a stored, directory-level
// setting. It is not one any more: a new submission always starts a new DSH
// conversation, and only `continueFromTaskId` continues one. The stored block is
// kept as accepted input so an upgraded document still loads, and it is INERT —
// the assertions below are what "inert" means in code.

test('an absent conversation block resolves to the default, never to the retired reuse', () => {
  const document = validSettings();
  delete document.conversation;
  assert.deepEqual(validateSettings(document).conversation, { mode: 'new' });
  assert.deepEqual(validateSettings(validSettings()).conversation, { mode: 'new' });
});

test('a legacy reuse value is still storable, so an existing document keeps loading', () => {
  const validated = validateSettings(validSettings({ conversation: { mode: 'reuse' } }));
  assert.deepEqual(validated.conversation, { mode: 'reuse' }, 'the stored value is preserved verbatim, not rewritten');
});

test('an unsupported conversation mode is refused rather than defaulted', () => {
  for (const mode of ['resume', 'continue', 'NEW', '', 42]) {
    assert.throws(
      () => validateSettings(validSettings({ conversation: { mode } })),
      (error) => error instanceof ConfigError && error.code === 'CONVERSATION_MODE_UNSUPPORTED'
        && error.details.field === 'conversation.mode',
      `mode ${JSON.stringify(mode)} must be refused`,
    );
  }
  // The refusal states that the field is retired, so a caller is pointed at the
  // replacement rather than at a typo.
  assert.throws(
    () => validateSettings(validSettings({ conversation: { mode: 'reuse-all' } })),
    (error) => error.code === 'CONVERSATION_MODE_UNSUPPORTED'
      && error.details.deprecated === true
      && /continueFromTaskId/.test(error.details.reason),
  );
  assert.throws(
    () => validateSettings(validSettings({ conversation: 'reuse' })),
    (error) => error instanceof ConfigError && error.code === 'CONVERSATION_INVALID',
  );
});

test('the public projection and export still carry the stored value verbatim', () => {
  // Compatibility, not a capability: a client that renders the block sees what the
  // document says, and a round-trip never rewrites it.
  for (const mode of ['new', 'reuse']) {
    const validated = validateSettings(validSettings({ conversation: { mode } }));
    assert.deepEqual(publicSettings(validated).conversation, { mode });
    assert.deepEqual(exportSettings(validated).conversation, { mode });
  }
});

test('the effective snapshot carries the conversation RULE, not the retired stored mode', () => {
  // This is the property that makes a legacy `reuse` incapable of an implicit
  // reuse: a run reads the snapshot, and the snapshot no longer has a mode to read.
  const validated = validateSettings(validSettings({ conversation: { mode: 'reuse' } }));
  const effective = resolveEffectiveConfig(validated, { projectPath: null });
  assert.deepEqual(effective.conversation, { policy: CONVERSATION_POLICY });
  assert.equal('mode' in effective.conversation, false, 'no mode reaches a run');
  assert.deepEqual(effective.provenance.applied, []);
});

test('a project override cannot change what a run does with its conversation', () => {
  const project = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
  const document = validSettings({
    projectOverrides: { [project]: { conversation: { mode: 'reuse' } } },
  });
  const validated = validateSettings(document);
  assert.deepEqual(
    validated.projectOverrides[project].conversation,
    undefined,
    'a project block cannot even store a conversation decision',
  );
  const effective = resolveEffectiveConfig(validated, { projectPath: project });
  assert.deepEqual(effective.conversation, { policy: CONVERSATION_POLICY });
});

test('a legacy reuse value persists across a service restart, and still means nothing', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings({ conversation: { mode: 'reuse' } }));
    assert.deepEqual((await service.read()).conversation, { mode: 'reuse' });

    const reopened = new SettingsService(dir);
    const stored = await reopened.read();
    assert.deepEqual(stored.conversation, { mode: 'reuse' }, 'the stored document survives a restart unchanged');
    assert.deepEqual(
      resolveEffectiveConfig(stored, { projectPath: null }).conversation,
      { policy: CONVERSATION_POLICY },
      'and a run started after the restart still follows the per-task rule',
    );
  } finally {
    await cleanup(dir);
  }
});

test('setConversation refuses: there is no mode control left to write', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings({ conversation: { mode: 'reuse' } }));
    await assert.rejects(
      () => service.setConversation({ mode: 'reuse' }),
      (error) => error instanceof ConfigError
        && error.code === 'CONVERSATION_MODE_REMOVED'
        && error.details.replacement === 'continueFromTaskId',
    );
    assert.deepEqual((await service.read()).conversation, { mode: 'reuse' }, 'a refused write changes nothing');
  } finally {
    await cleanup(dir);
  }
});

test('replacing the configuration keeps a stored legacy block instead of dropping it', () => {
  // The page sends a full document on save. An absent block must not resurrect a
  // capability, so an absent one states the default while a present one is kept as
  // it was; neither influences a run.
  return (async () => {
    const dir = await makeTempDir();
    try {
      const service = new SettingsService(dir);
      await service.replace(validSettings({ conversation: { mode: 'reuse' } }));

      const withoutMode = validSettings();
      delete withoutMode.conversation;
      const committed = await service.replaceConfiguration(withoutMode);
      assert.deepEqual(committed.conversation, { mode: 'new' }, 'an absent block on a full replace states the default');

      const withMode = validSettings({ conversation: { mode: 'reuse' } });
      const again = await service.replaceConfiguration(withMode);
      assert.deepEqual(again.conversation, { mode: 'reuse' }, 'a present block round-trips verbatim');
      assert.deepEqual(
        resolveEffectiveConfig(again, { projectPath: null }).conversation,
        { policy: CONVERSATION_POLICY },
        'and neither value changes what a run does',
      );
    } finally {
      await cleanup(dir);
    }
  })();
});

// ---------------------------------------------------------------------------
// Monitoring thresholds: defaults, validation, precedence and persistence
// ---------------------------------------------------------------------------

test('a document without a monitoring block loads with the documented defaults', () => {
  const without = validSettings();
  assert.equal(Object.hasOwn(without, 'monitoring'), false, 'the fixture models a pre-feature document');
  const settings = validateSettings(without);
  assert.deepEqual(settings.monitoring, { selfCheckSeconds: 300, attentionSeconds: 600, repeatFailureThreshold: 3 });
});

test('monitoring accepts whole seconds inside the documented bounds', () => {
  assert.deepEqual(
    validateSettings({ ...validSettings(), monitoring: { selfCheckSeconds: 30, attentionSeconds: 31 } }).monitoring,
    { selfCheckSeconds: 30, attentionSeconds: 31, repeatFailureThreshold: 3 },
  );
  assert.deepEqual(
    validateSettings({ ...validSettings(), monitoring: { selfCheckSeconds: 3600, attentionSeconds: 7200 } }).monitoring,
    { selfCheckSeconds: 3600, attentionSeconds: 7200, repeatFailureThreshold: 3 },
  );
  // A partial block takes the default for the missing key.
  assert.deepEqual(
    validateSettings({ ...validSettings(), monitoring: { selfCheckSeconds: 120 } }).monitoring,
    { selfCheckSeconds: 120, attentionSeconds: 600, repeatFailureThreshold: 3 },
  );
});

test('the repeated-failure reminder is a count: 0 disables it, and older documents keep the default', () => {
  const withCount = (repeatFailureThreshold) => validateSettings({
    ...validSettings(),
    monitoring: { selfCheckSeconds: 300, attentionSeconds: 600, repeatFailureThreshold },
  }).monitoring.repeatFailureThreshold;
  assert.equal(withCount(0), 0, '0 is the documented "off" value, not an error');
  assert.equal(withCount(1), 1);
  assert.equal(withCount(20), 20);
  // A document written before this setting existed keeps the default rather than failing.
  assert.equal(withCount(undefined), 3);
  for (const bad of [-1, 21, 2.5, '3', null, Number.NaN]) {
    assert.throws(
      () => withCount(bad),
      (error) => error.code === 'MONITORING_INVALID',
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('monitoring refuses out-of-range, non-integer and wrongly typed values', () => {
  const cases = [
    [{ selfCheckSeconds: 29 }, 'MONITORING_INVALID'],
    [{ selfCheckSeconds: 3601 }, 'MONITORING_INVALID'],
    [{ selfCheckSeconds: 300.5 }, 'MONITORING_INVALID'],
    [{ selfCheckSeconds: '300' }, 'MONITORING_INVALID'],
    [{ attentionSeconds: 30 }, 'MONITORING_INVALID'],
    [{ attentionSeconds: 7201 }, 'MONITORING_INVALID'],
    [{ attentionSeconds: null }, 'MONITORING_INVALID'],
    [{ attentionSeconds: Number.NaN }, 'MONITORING_INVALID'],
    [{ selfCheckSeconds: 300, attentionSeconds: 300 }, 'MONITORING_TIMING_INVALID'],
    [{ selfCheckSeconds: 600, attentionSeconds: 300 }, 'MONITORING_TIMING_INVALID'],
  ];
  for (const [monitoring, code] of cases) {
    assert.throws(
      () => validateSettings({ ...validSettings(), monitoring }),
      (error) => error instanceof ConfigError && error.code === code,
      `monitoring ${JSON.stringify(monitoring)} must be refused with ${code}`,
    );
  }
  // A non-object block is refused rather than coerced.
  for (const monitoring of ['300', 300, [300, 600], true]) {
    assert.throws(
      () => validateSettings({ ...validSettings(), monitoring }),
      (error) => error.code === 'MONITORING_INVALID',
    );
  }
});

test('monitoring refuses an unknown key instead of ignoring it', () => {
  // A typo would otherwise silently keep the default while the operator believes
  // they configured something, which is the one outcome a settings document must
  // never produce.
  assert.throws(
    () => validateSettings({ ...validSettings(), monitoring: { atentionSeconds: 900 } }),
    (error) => error.code === 'MONITORING_INVALID' && error.details.field === 'monitoring.atentionSeconds',
  );
});

test('public settings, export and effective snapshots all carry monitoring', () => {
  const settings = validateSettings({
    ...validSettings(),
    monitoring: { selfCheckSeconds: 120, attentionSeconds: 240, repeatFailureThreshold: 4 },
  });
  const block = { selfCheckSeconds: 120, attentionSeconds: 240, repeatFailureThreshold: 4 };
  assert.deepEqual(publicSettings(settings).monitoring, block);
  assert.deepEqual(exportSettings(settings).monitoring, block);
  const effective = resolveEffectiveConfig(settings, { projectPath: null });
  assert.deepEqual(effective.monitoring, block);
  // Frozen like every other part of the snapshot.
  assert.equal(Object.isFrozen(effective), true);
  assert.equal(Object.isFrozen(effective.monitoring), true);
});

test('monitoring is global-only: no project override or per-job override can retime it', () => {
  const settings = validateSettings({
    ...validSettings(),
    monitoring: { selfCheckSeconds: 300, attentionSeconds: 600 },
    // A project override is a complete worker triple, and it deliberately has no
    // monitoring field to give: the thresholds are deployment-wide.
    projectOverrides: {
      'C:\\fixtures\\repo': {
        worker: { providerId: 'relay', model: 'deepseek-chat', reasoningEffort: 'low', timeoutSeconds: 900 },
      },
    },
  });
  const effective = resolveEffectiveConfig(settings, { projectPath: 'C:\\fixtures\\repo' });
  assert.equal(effective.worker.timeoutSeconds, 900, 'the project override applied to its own block');
  assert.equal(effective.worker.reasoningEffort, 'low');
  assert.deepEqual(effective.monitoring,
    { selfCheckSeconds: 300, attentionSeconds: 600, repeatFailureThreshold: 3 },
    'and did not touch the monitoring thresholds');
  assert.throws(
    () => resolveEffectiveConfig(settings, { projectPath: null, overrides: { monitoring: { selfCheckSeconds: 60 } } }),
    (error) => error.code === 'OVERRIDE_INVALID',
  );
});

test('an export/import round trip preserves monitoring', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings());
    await service.setMonitoring({ selfCheckSeconds: 90, attentionSeconds: 300 });
    const exported = exportSettings(await service.read());
    // The count was not named, so the documented default is what is persisted and
    // exported; an older document must not gain a value nobody chose.
    assert.deepEqual(exported.monitoring, { selfCheckSeconds: 90, attentionSeconds: 300, repeatFailureThreshold: 3 });

    const other = new SettingsService(await makeTempDir());
    try {
      await other.replaceValidated(exported);
      assert.deepEqual((await other.read()).monitoring,
        { selfCheckSeconds: 90, attentionSeconds: 300, repeatFailureThreshold: 3 });
    } finally {
      await cleanup(other.document.path.replace(/[\\/][^\\/]+$/, ''));
    }
  } finally {
    await cleanup(dir);
  }
});

test('setMonitoring validates before writing and persists through the serialized queue', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings());

    // A refused value writes nothing.
    const before = await service.read();
    await assert.rejects(
      () => service.setMonitoring({ selfCheckSeconds: 600, attentionSeconds: 300 }),
      (error) => error.code === 'MONITORING_TIMING_INVALID',
    );
    assert.deepEqual((await service.read()).monitoring, before.monitoring);

    const committed = await service.setMonitoring({ selfCheckSeconds: 60, attentionSeconds: 120 });
    assert.deepEqual(committed.monitoring,
      { selfCheckSeconds: 60, attentionSeconds: 120, repeatFailureThreshold: 3 });

    // Reads, and a fresh service over the same directory, see it.
    const reopened = new SettingsService(dir);
    assert.deepEqual((await reopened.read()).monitoring,
      { selfCheckSeconds: 60, attentionSeconds: 120, repeatFailureThreshold: 3 });
  } finally {
    await cleanup(dir);
  }
});

test('setMonitoring cannot lose a concurrent settings edit', async () => {
  const dir = await makeTempDir();
  try {
    const service = new SettingsService(dir);
    await service.replace(validSettings());
    await Promise.all([
      service.setMonitoring({ selfCheckSeconds: 60, attentionSeconds: 120 }),
      service.setWorker({ providerId: 'relay', model: 'deepseek-reasoner', reasoningEffort: 'high', timeoutSeconds: 900 }),
    ]);
    const settings = await service.read();
    assert.deepEqual(settings.monitoring,
      { selfCheckSeconds: 60, attentionSeconds: 120, repeatFailureThreshold: 3 });
    assert.equal(settings.worker.model, 'deepseek-reasoner', 'the concurrent worker edit survived');
    assert.equal(settings.monitoring.check === undefined, true);
  } finally {
    await cleanup(dir);
  }
});
