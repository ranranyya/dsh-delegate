import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDraft, documentFromDraft, draftFromSettings, precheckDraft } from '../src/client/api.js';

function configuredDraft(provider) {
  const draft = defaultDraft();
  draft.providers = [provider];
  draft.worker = {
    ...draft.worker,
    providerId: provider.id,
    model: provider.models[0].id,
    reasoningEffort: provider.models[0].efforts[0] ?? null,
  };
  return draft;
}

test('native provider source survives settings round trips without custom endpoint fields', () => {
  const settings = {
    schemaVersion: 1,
    providers: [{
      id: 'workbuddy',
      name: 'Workbuddy',
      source: 'native',
      models: [{ id: 'deepseek-v4.1-flash', efforts: ['high'] }],
    }],
  };

  const draft = draftFromSettings(settings);
  const [provider] = documentFromDraft(draft).providers;

  assert.equal(draft.providers[0].source, 'native');
  assert.equal(provider.source, 'native');
  assert.equal(Object.hasOwn(provider, 'baseUrl'), false);
  assert.equal(Object.hasOwn(provider, 'protocol'), false);
  assert.equal(Object.hasOwn(provider, 'credentialRef'), false);
});

test('native provider without a base URL passes client precheck', () => {
  const draft = configuredDraft({
    id: 'workbuddy',
    name: 'Workbuddy',
    source: 'native',
    models: [{ id: 'deepseek-v4.1-flash', efforts: ['high'] }],
  });

  assert.deepEqual(precheckDraft(draft), []);
});

test('custom provider still requires a base URL', () => {
  const draft = configuredDraft({
    id: 'relay',
    name: 'Relay',
    source: 'custom',
    protocol: 'openai-chat',
    baseUrl: '',
    models: [{ id: 'model-a', efforts: ['high'] }],
  });

  assert.ok(precheckDraft(draft).includes('提供方「relay」缺少接口地址'));
});
