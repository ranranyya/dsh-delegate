import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_ACTIONS, ROUTES, defaultDraft, documentFromDraft, draftFromSettings, precheckDraft } from '../src/client/api.js';
import {
  CONVERSATION_LABELS,
  CONVERSATION_MODES,
  conversationModeLabel,
  conversationOf,
} from '../src/client/api.js';

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

test('the Codex integration uses one route and offers no "status" action to the page', () => {
  // One path, two methods: `GET` diagnoses, `POST` performs one explicit action.
  assert.equal(ROUTES.codex, '/api/dsh-delegate/codex');
  assert.deepEqual([...CODEX_ACTIONS], ['install', 'repair', 'remove']);
  // `status` would be a write-less POST that looks like an action; the page reads
  // through `GET` instead, so it is absent from the action vocabulary.
  assert.equal(CODEX_ACTIONS.includes('status'), false);
  // The Codex settings are not part of the delegation document.
  assert.equal(JSON.stringify(defaultDraft()).includes('codex'), false);
});

// --- Conversation mode in the settings surface ------------------------------
//
// The control only works if the value survives the whole page round trip: draft
// -> save -> reload -> public projection. A mode that is displayed but dropped on
// save would silently revert to the default, which is exactly the bug this
// grouping feature cannot have.

test('the default draft carries the new-conversation default', () => {
  assert.deepEqual(defaultDraft().conversation, { mode: 'new' });
  assert.equal(CONVERSATION_MODES[0], 'new', 'new is the default the UI opens on');
});

test('a stored reuse mode opens as reuse and is written back on save', () => {
  const draft = draftFromSettings({ schemaVersion: 1, conversation: { mode: 'reuse' } });
  assert.deepEqual(draft.conversation, { mode: 'reuse' }, 'the page must reopen on the stored mode');
  assert.deepEqual(documentFromDraft(draft).conversation, { mode: 'reuse' }, 'and it must be saved back');
});

test('a document with no conversation block opens as the default, and saving states it', () => {
  // Every document written before this field existed, and every fresh install.
  const draft = draftFromSettings({ schemaVersion: 1 });
  assert.deepEqual(draft.conversation, { mode: 'new' });
  assert.deepEqual(documentFromDraft(draft).conversation, { mode: 'new' });
});

test('an unknown stored mode falls back to the default instead of being echoed', () => {
  // The host refuses an unknown mode; the page must not send one back.
  const draft = draftFromSettings({ schemaVersion: 1, conversation: { mode: 'resume' } });
  assert.deepEqual(draft.conversation, { mode: 'new' });
  assert.deepEqual(documentFromDraft(draft).conversation, { mode: 'new' });
});

test('the conversation mode label is Chinese and covers both modes', () => {
  for (const mode of CONVERSATION_MODES) {
    assert.equal(typeof CONVERSATION_LABELS[mode], 'string');
    assert.ok(CONVERSATION_LABELS[mode].length > 0);
    assert.equal(conversationModeLabel(mode), CONVERSATION_LABELS[mode]);
  }
  assert.equal(conversationModeLabel('bogus'), 'bogus');
});

test('conversationOf resolves an absent or malformed block without inventing a mode', () => {
  assert.deepEqual(conversationOf(undefined), { mode: 'new' });
  assert.deepEqual(conversationOf(null), { mode: 'new' });
  assert.deepEqual(conversationOf({}), { mode: 'new' });
  assert.deepEqual(conversationOf({ conversation: { mode: 'reuse' } }), { mode: 'reuse' });
  assert.deepEqual(conversationOf({ conversation: true }), { mode: 'new' });
});
