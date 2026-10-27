import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_ACTIONS, ROUTES, defaultDraft, documentFromDraft, draftFromSettings, precheckDraft } from '../src/client/api.js';
import {
  CONVERSATION_LABELS,
  CONVERSATION_MODES,
  CONVERSATION_POLICY_LABEL,
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


// --- The retired conversation control ----------------------------------------
//
// There is no mode control on the page any more. What remains is a compatibility
// concern with one property: a save must not rewrite an operator's stored document
// into a state they did not choose, and the value must never influence a run.

test('the page has no conversation-mode choice left to offer', () => {
  assert.deepEqual([...CONVERSATION_MODES], ['new', 'reuse'], 'the ids still exist so a stored document renders');
  assert.match(CONVERSATION_LABELS.reuse, /已移除/, 'the label states that the capability is gone');
  assert.equal(typeof CONVERSATION_POLICY_LABEL, 'string');
  assert.match(CONVERSATION_POLICY_LABEL, /continueFromTaskId/);
});

test('a stored legacy reuse value is preserved verbatim, not silently rewritten', () => {
  const draft = draftFromSettings({ schemaVersion: 1, conversation: { mode: 'reuse' } });
  assert.deepEqual(draft.conversation, { mode: 'reuse' }, 'the page must reopen on what the document says');
  assert.deepEqual(documentFromDraft(draft).conversation, { mode: 'reuse' }, 'and it must be saved back unchanged');
});

test('a document with no conversation block opens as the default, and saving states it', () => {
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

test('conversationOf resolves an absent or malformed block without inventing a mode', () => {
  assert.deepEqual(conversationOf(undefined), { mode: 'new' });
  assert.deepEqual(conversationOf(null), { mode: 'new' });
  assert.deepEqual(conversationOf({}), { mode: 'new' });
  assert.deepEqual(conversationOf({ conversation: { mode: 'reuse' } }), { mode: 'reuse' });
  assert.deepEqual(conversationOf({ conversation: true }), { mode: 'new' });
});


test('the built page no longer offers a conversation-mode control, and states the rule', async () => {
  // A control that is hidden in the source but present in the built bundle would
  // still reach an operator, so the assertion is on `lib/client.js`.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const built = readFileSync(join(process.cwd(), 'lib', 'client.js'), 'utf8');
  assert.equal(/dshdg-conversation-mode/u.test(built), false, 'the retired mode select must be gone from the bundle');
  assert.match(built, /dshdg-conversation-policy/u, 'the panel must state the per-task rule instead');
  assert.match(built, /continueFromTaskId/u, 'and name the only way to continue a thread');
  assert.match(built, /已移除/u, 'and say that the reuse setting was removed');
});
