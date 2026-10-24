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

/**
 * The {@link llmTable} model set, keyed by native route.
 *
 * `fakeLlm` resolves only the provider keys it was given, which is the accurate
 * shape: an adapter answers for the route it was registered under, never for the
 * operator's profile id.
 * @returns {object} provider table keyed by `dsh-delegate:` route ids.
 */
function nativeTable() {
  return { 'dsh-delegate:relay': llmTable().relay };
}

test('the catalog reports models and efforts per provider without hiding failures', async () => {
  const llm = fakeLlm({ providers: nativeTable() });
  const catalog = await describeCatalog({ llm }, [{
    id: 'relay',
    models: [{ id: 'deepseek-chat' }, { id: 'missing-model' }],
  }], { routes: new Map([['relay', 'dsh-delegate:relay']]) });
  assert.equal(catalog.length, 1);
  const entry = catalog[0];
  assert.equal(entry.providerId, 'relay');
  // The row names the native route the plugin registered, not the profile id.
  assert.equal(entry.route, 'dsh-delegate:relay');
  assert.deepEqual(entry.models.map((model) => model.id), ['deepseek-chat']);
  assert.equal(entry.error.code, ROUTING_CODES.modelUnresolved);
});

test('the catalog falls back to the native model list when none are declared', async () => {
  const llm = fakeLlm({ providers: nativeTable() });
  const catalog = await describeCatalog({ llm }, [{ id: 'relay', models: [] }], {
    routes: new Map([['relay', 'dsh-delegate:relay']]),
  });
  assert.deepEqual(
    catalog[0].models.map((model) => model.id).sort(),
    ['deepseek-chat', 'deepseek-reasoner'],
  );
});

test('a catalog without a route mapping reports no route instead of the profile id', async () => {
  const llm = fakeLlm({ providers: llmTable() });

  // No mapping supplied at all: the profile id must not be reported as a route.
  const [absent] = await describeCatalog({ llm }, [{ id: 'relay', models: [{ id: 'deepseek-chat' }] }]);
  assert.equal(absent.route, null);
  assert.equal(absent.error.code, ROUTING_CODES.providerNotRegistered);
  assert.deepEqual(absent.models, []);

  // `null` explicitly — what a swallowed registration failure used to produce.
  const [nulled] = await describeCatalog({ llm }, [{ id: 'relay', models: [] }], { routes: null });
  assert.equal(nulled.route, null);
  assert.equal(nulled.error.code, ROUTING_CODES.providerNotRegistered);

  // A map that simply lacks this provider is the same refusal, for the same reason.
  const [unmapped] = await describeCatalog({ llm }, [{ id: 'relay', models: [] }], { routes: new Map() });
  assert.equal(unmapped.route, null);
  assert.equal(unmapped.error.code, ROUTING_CODES.providerNotRegistered);

  // And nothing was resolved against a route that does not exist.
  assert.equal(llm.calls.resolveModelInfo, 0);
});
