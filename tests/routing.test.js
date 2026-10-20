// Routing tests: explicit provider/model/effort with refusal, never fallback.
//
// The property under test is negative and easy to lose later: when the requested
// combination is not exactly routable, nothing happens. No substitute model, no
// downgraded effort, no harness default.

import test from 'node:test';
import assert from 'node:assert/strict';

import { declaredEfforts, describeCatalog, resolveRoute, ROUTING_CODES } from '../src/model/routing.js';
import { fakeLlm, llmTable } from './helpers/fakes.js';

const SELECTION = {
  providerId: 'relay',
  providerRoute: 'relay',
  model: 'deepseek-chat',
  reasoningEffort: 'medium',
};

test('a configured provider/model/effort triple resolves exactly', async () => {
  const llm = fakeLlm({ providers: llmTable() });
  const route = await resolveRoute({ llm }, SELECTION);
  assert.equal(route.providerRoute, 'relay');
  assert.equal(route.model, 'deepseek-chat');
  assert.equal(route.reasoningEffort, 'medium');
  assert.deepEqual(route.declaredEfforts, ['low', 'medium', 'high']);
});

test('an unregistered provider route is refused', async () => {
  const llm = fakeLlm({ providers: llmTable() });
  await assert.rejects(
    () => resolveRoute({ llm }, { ...SELECTION, providerRoute: 'ghost' }),
    (error) => error.code === ROUTING_CODES.providerNotRegistered,
  );
});

test('an unresolvable model is refused', async () => {
  const llm = fakeLlm({ providers: llmTable() });
  await assert.rejects(
    () => resolveRoute({ llm }, { ...SELECTION, model: 'not-a-model' }),
    (error) => error.code === ROUTING_CODES.modelUnresolved,
  );
});

test('an unsupported effort is refused instead of downgraded', async () => {
  const llm = fakeLlm({ providers: llmTable() });
  await assert.rejects(
    () => resolveRoute({ llm }, { ...SELECTION, model: 'deepseek-reasoner', reasoningEffort: 'low' }),
    (error) => {
      assert.equal(error.code, ROUTING_CODES.effortUnsupported);
      // The refusal names what would have worked, so the operator can fix it.
      assert.deepEqual(error.details.supported, ['medium', 'high']);
      return true;
    },
  );
});

test('an effort on a model with no effort axis is refused', async () => {
  const llm = fakeLlm({ providers: { relay: { plain: [] } } });
  await assert.rejects(
    () => resolveRoute({ llm }, { ...SELECTION, model: 'plain', reasoningEffort: 'medium' }),
    (error) => error.code === ROUTING_CODES.effortUnsupported,
  );
});

test('a model with no effort axis and no effort requested is routable', async () => {
  const llm = fakeLlm({ providers: { relay: { plain: [] } } });
  const route = await resolveRoute({ llm }, { ...SELECTION, model: 'plain', reasoningEffort: null });
  assert.equal(route.reasoningEffort, null);
  assert.equal(route.hasEffortAxis, false);
});

test('requireEffort refuses an ambiguous omission rather than inventing a default', async () => {
  const llm = fakeLlm({ providers: { relay: { 'no-default': ['high'] } } });
  await assert.rejects(
    () => resolveRoute({ llm }, { ...SELECTION, model: 'no-default', reasoningEffort: null }, { requireEffort: true }),
    (error) => error.code === ROUTING_CODES.effortUnsupported,
  );
});

test('a missing llm service is a refusal, not an assumed success', async () => {
  await assert.rejects(
    () => resolveRoute({}, SELECTION),
    (error) => error.code === ROUTING_CODES.serviceUnavailable,
  );
});

test('a failing provider list is reported as such', async () => {
  const llm = {
    listProviders() { throw new Error('registry unavailable'); },
    resolveModelInfo: async () => ({ provider: 'relay', id: 'deepseek-chat', name: 'x' }),
  };
  await assert.rejects(
    () => resolveRoute({ llm }, SELECTION),
    (error) => error.code === ROUTING_CODES.providerListFailed,
  );
});

test('declared efforts are flattened from the native shape', () => {
  assert.deepEqual(
    declaredEfforts({ reasoning: { efforts: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], defaultEffort: 'b' } }),
    { efforts: ['a', 'b'], defaultEffort: 'b' },
  );
  assert.deepEqual(declaredEfforts({}), { efforts: [], defaultEffort: null });
  assert.deepEqual(declaredEfforts(null), { efforts: [], defaultEffort: null });
});

test('the catalog reports models and efforts per provider without hiding failures', async () => {
  const llm = fakeLlm({ providers: llmTable() });
  const catalog = await describeCatalog({ llm }, [{
    id: 'relay',
    models: [{ id: 'deepseek-chat' }, { id: 'missing-model' }],
  }]);
  assert.equal(catalog.length, 1);
  const entry = catalog[0];
  assert.equal(entry.providerId, 'relay');
  assert.deepEqual(entry.models.map((model) => model.id), ['deepseek-chat']);
  assert.equal(entry.error.code, ROUTING_CODES.modelUnresolved);
});

test('the catalog falls back to the native model list when none are declared', async () => {
  const llm = fakeLlm({ providers: llmTable() });
  const catalog = await describeCatalog({ llm }, [{ id: 'relay', models: [] }]);
  assert.deepEqual(
    catalog[0].models.map((model) => model.id).sort(),
    ['deepseek-chat', 'deepseek-reasoner'],
  );
});
