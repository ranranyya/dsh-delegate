// Native OpenAI-compatible adapter slice: deterministic, offline verification.
//
// Everything here is local: a Chat Completions SSE fixture on 127.0.0.1 and a
// fake DSH credential service. No relay, no real key, no network egress. The
// fixture is the only authority on what reached "the provider", which is how a
// request body is inspected at all — the adapter under test does no HTTP of its
// own and parses no SSE; pi-ai does both.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listenLoopback } from './helpers/http.js';
import test from 'node:test';

import { createOpenAiAdapter } from '../src/model/openai-adapter.js';

/** Native route id for the primary public provider id, as `src/model/providers.js` derives it. */
const ROUTE = 'dsh-delegate:relay';

/**
 * One deferred value.
 * @returns {{ promise: Promise<void>, resolve: () => void }} the deferred.
 */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * Start a deterministic Chat Completions SSE fixture.
 *
 * Every request is recorded in full (url, headers, parsed body), which is the
 * only way a test can see what reached "the provider": the adapter under test
 * performs no HTTP of its own and parses no SSE — pi-ai does both.
 * @param {object} [options] - `text` content deltas to stream back.
 * @returns {Promise<object>} fixture handle.
 */
async function startFixture(options = {}) {
  const textDeltas = options.text ?? ['hello', ' world'];
  const requests = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const record = { url: req.url, method: req.method, headers: req.headers, body: {} };
      try {
        record.body = JSON.parse(body === '' ? '{}' : body);
      } catch {
        record.body = { __unparsed: body.slice(0, 200) };
      }
      requests.push(record);

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const model = record.body.model ?? 'unknown';
      const frame = (delta, extra = {}) => `data: ${JSON.stringify({
        id: 'chatcmpl-fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason: null }],
        ...extra,
      })}\n\n`;
      res.write(frame({ role: 'assistant', content: '' }));
      for (const delta of textDeltas) res.write(frame({ content: delta }));
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await listenLoopback(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

  return {
    baseUrl,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
}

/**
 * Fake DSH credential service.
 *
 * Records every reference asked for — never the values it hands back, which is
 * what a test needs to prove the adapter resolved through this seam.
 * @param {Record<string, string | undefined>} values - reference -> value, or
 *   `undefined` for "not configured".
 * @returns {{ resolve: (ref: string) => Promise<{ value: string, source: string } | undefined>, asked: string[] }} fake service.
 */
function fakeCredentials(values) {
  const asked = [];
  return {
    asked,
    async resolve(ref) {
      asked.push(ref);
      const value = values[ref];
      if (typeof value !== 'string' || value === '') return undefined;
      return { value, source: 'test-store' };
    },
  };
}

/**
 * One validated settings provider profile, as `src/config/validate.js` produces it.
 * @param {object} [overrides] - fields to replace.
 * @returns {object} provider profile.
 */
function providerProfile(overrides = {}) {
  return {
    id: 'relay',
    name: 'Relay',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:1/v1',
    credentialRef: 'RELAY_API_KEY',
    models: [
      { id: 'deepseek-v4.1-flash', name: 'Flash', efforts: ['off', 'low', 'high'] },
      { id: 'deepseek-v4.1-pro', name: 'Pro', efforts: [] },
    ],
    ...overrides,
  };
}

/**
 * Drain a native chunk stream into an array.
 * @param {AsyncIterable<object>} stream - native `StreamChunk` iterable.
 * @returns {Promise<object[]>} chunks in emission order.
 */
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test('the adapter serves exactly the snapshot routes, model ids and efforts', async () => {
  const fixture = await startFixture();
  const credentials = fakeCredentials({ RELAY_API_KEY: 'sk-fixture-value' });
  const service = createOpenAiAdapter({ credentials });

  try {
    const applied = service.replace({
      providers: [providerProfile({ baseUrl: fixture.baseUrl })],
      routes: new Map([['relay', ROUTE]]),
    });
    assert.deepEqual(applied.providerIds, ['relay']);
    assert.deepEqual([...applied.routes], [['relay', ROUTE]]);

    const adapter = service.getAdapter();
    const listed = await adapter.listModels(ROUTE);
    assert.deepEqual(listed.map((entry) => entry.id), ['deepseek-v4.1-flash', 'deepseek-v4.1-pro']);

    const flash = await adapter.resolveModel(ROUTE, 'deepseek-v4.1-flash');
    // The declared axis is exactly what the operator listed: nothing is added.
    assert.deepEqual(flash.reasoning.efforts.map((entry) => entry.id), ['off', 'low', 'high']);
    const pro = await adapter.resolveModel(ROUTE, 'deepseek-v4.1-pro');
    assert.equal(pro.reasoning, undefined, 'a model declaring no efforts exposes no effort axis');

    await assert.rejects(() => adapter.resolveModel(ROUTE, 'not-listed-model'), (error) => error.code === 'UNKNOWN_MODEL');
    await assert.rejects(() => adapter.listModels('dsh-delegate:absent'), (error) => error.code === 'NO_ADAPTER');
  } finally {
    await fixture.close();
  }
});

test('a selected route, model and effort reach the native adapter request and stream back native chunks', async () => {
  const fixture = await startFixture({ text: ['hello', ' world'] });
  const credentials = fakeCredentials({ RELAY_API_KEY: 'sk-fixture-value' });
  const service = createOpenAiAdapter({ credentials });

  try {
    service.replace({ providers: [providerProfile({ baseUrl: fixture.baseUrl })], routes: new Map([['relay', ROUTE]]) });
    const chunks = await collect(service.getAdapter().stream({
      provider: ROUTE,
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'high',
      maxTokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }));

    assert.equal(fixture.requests.length, 1, 'exactly one provider request');
    const request = fixture.requests[0];
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer sk-fixture-value', 'the reference resolved through the DSH seam');
    assert.equal(request.body.model, 'deepseek-v4.1-flash', 'the exact configured model id is sent');
    assert.equal(request.body.reasoning_effort, 'high', 'the selected effort is sent');
    assert.equal(request.body.stream, true);
    assert.deepEqual(credentials.asked, ['RELAY_API_KEY'], 'one resolution per request, through the DSH seam');

    assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish']);
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'hello world');
    assert.deepEqual(chunks.find((chunk) => chunk.type === 'usage').usage, {
      inputTokens: 7, outputTokens: 3, totalTokens: 10,
    });
    assert.equal(chunks.at(-1).reason.kind, 'stop');
  } finally {
    await fixture.close();
  }
});

test('only declared efforts are selectable, and `off` sends no reasoning parameter', async () => {
  const fixture = await startFixture({ text: ['ok'] });
  const credentials = fakeCredentials({ RELAY_API_KEY: 'sk-fixture-value' });
  const service = createOpenAiAdapter({ credentials });

  try {
    service.replace({ providers: [providerProfile({ baseUrl: fixture.baseUrl })], routes: new Map([['relay', ROUTE]]) });
    const adapter = service.getAdapter();
    const send = (reasoningEffort) => collect(adapter.stream({
      provider: ROUTE,
      model: 'deepseek-v4.1-flash',
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      maxTokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }));

    // Declared and undeclared-to-this-model levels, on a model that declares
    // `off`, `low` and `high` only.
    await send('low');
    assert.equal(fixture.requests.at(-1).body.reasoning_effort, 'low');
    await send('high');
    assert.equal(fixture.requests.at(-1).body.reasoning_effort, 'high');
    // `off` is a declared level meaning "no reasoning": pi-ai expresses it by
    // sending no reasoning parameter at all.
    await send('off');
    assert.equal(fixture.requests.at(-1).body.reasoning_effort, undefined, 'off sends no reasoning_effort');

    // Undeclared levels never reach the network.
    const before = fixture.requests.length;
    for (const effort of ['minimal', 'medium', 'xhigh', 'max']) {
      await assert.rejects(() => send(effort), (error) => error.code === 'UNSUPPORTED_REASONING_EFFORT');
    }
    assert.equal(fixture.requests.length, before, 'an undeclared effort made no request');
  } finally {
    await fixture.close();
  }
});

test('a missing credential fails with MISSING_CREDENTIAL and makes zero HTTP requests', async () => {
  const fixture = await startFixture();
  const credentials = fakeCredentials({});
  const service = createOpenAiAdapter({ credentials });

  try {
    service.replace({ providers: [providerProfile({ baseUrl: fixture.baseUrl })], routes: new Map([['relay', ROUTE]]) });
    await assert.rejects(
      () => collect(service.getAdapter().stream({
        provider: ROUTE,
        model: 'deepseek-v4.1-flash',
        reasoningEffort: 'low',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })),
      (error) => {
        assert.equal(error.code, 'MISSING_CREDENTIAL');
        // The failure must not leak the value it never had, nor invent one.
        assert.equal(JSON.stringify(error.details).includes('sk-'), false);
        return true;
      },
    );
    assert.deepEqual(credentials.asked, ['RELAY_API_KEY']);
    assert.equal(fixture.requests.length, 0, 'the request never reached the network');
  } finally {
    await fixture.close();
  }
});

test('a provider naming no credential reference is refused rather than served keyless', async () => {
  const fixture = await startFixture();
  const credentials = fakeCredentials({ RELAY_API_KEY: 'sk-fixture-value' });
  const service = createOpenAiAdapter({ credentials });

  try {
    service.replace({
      providers: [providerProfile({ baseUrl: fixture.baseUrl, credentialRef: null })],
      routes: new Map([['relay', ROUTE]]),
    });
    await assert.rejects(
      () => collect(service.getAdapter().stream({
        provider: ROUTE,
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      })),
      (error) => error.code === 'MISSING_CREDENTIAL',
    );
    assert.deepEqual(credentials.asked, [], 'no reference was invented');
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
  }
});

test('replacing profiles leaves an already-started request on its old immutable snapshot', async () => {
  const first = await startFixture({ text: ['old'] });
  const second = await startFixture({ text: ['new'] });

  // The credential seam is the last await before pi-ai dispatches. Holding it
  // open parks the request *before* it is sent, which is the real hazard: pi-ai
  // resolves a provider lazily, when the stream is first consumed, so a mutated
  // collection would let this request finish under the next configuration.
  const gate = deferred();
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  const credentials = fakeCredentials({ RELAY_API_KEY: 'sk-fixture-value', NEW_RELAY_API_KEY: 'sk-fixture-new' });
  const service = createOpenAiAdapter({
    credentials: {
      async resolve(ref) {
        resolveStarted();
        await gate.promise;
        return credentials.resolve(ref);
      },
    },
  });

  try {
    service.replace({ providers: [providerProfile({ baseUrl: first.baseUrl })], routes: new Map([['relay', ROUTE]]) });
    const adapter = service.getAdapter();

    const pending = collect(adapter.stream({
      provider: ROUTE,
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }));

    // Wait until the request has captured its snapshot and is parked in the seam,
    // then change configuration while it is provably still in flight.
    await started;
    assert.equal(first.requests.length, 0, 'the request has not been dispatched yet');
    service.replace({
      providers: [providerProfile({
        baseUrl: second.baseUrl,
        credentialRef: 'NEW_RELAY_API_KEY',
        models: [{ id: 'deepseek-v4.1-pro', name: 'Pro', efforts: ['low'] }],
      })],
      routes: new Map([['relay', ROUTE]]),
    });
    assert.equal(first.requests.length, 0, 'replacing profiles dispatched nothing');

    gate.resolve();
    const chunks = await pending;

    // The in-flight request kept its old snapshot: old endpoint, old model, old key.
    assert.equal(first.requests.length, 1);
    assert.equal(first.requests[0].body.model, 'deepseek-v4.1-flash');
    assert.equal(first.requests[0].headers.authorization, 'Bearer sk-fixture-value');
    assert.equal(second.requests.length, 0, 'the in-flight request did not move to the new endpoint');
    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'old');

    // The next request sees the new snapshot only.
    const nextChunks = await collect(adapter.stream({
      provider: ROUTE,
      model: 'deepseek-v4.1-pro',
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }));
    assert.equal(second.requests.length, 1);
    assert.equal(second.requests[0].body.model, 'deepseek-v4.1-pro');
    assert.equal(second.requests[0].headers.authorization, 'Bearer sk-fixture-new');
    assert.equal(nextChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), 'new');

    // The model the new snapshot dropped is gone, not merely demoted.
    await assert.rejects(() => adapter.resolveModel(ROUTE, 'deepseek-v4.1-flash'), (error) => error.code === 'UNKNOWN_MODEL');
  } finally {
    await first.close();
    await second.close();
  }
});

test('a refused snapshot leaves the serving snapshot untouched', async () => {
  const fixture = await startFixture();
  const credentials = fakeCredentials({ RELAY_API_KEY: 'sk-fixture-value' });
  const service = createOpenAiAdapter({ credentials });

  try {
    service.replace({ providers: [providerProfile({ baseUrl: fixture.baseUrl })], routes: new Map([['relay', ROUTE]]) });
    assert.throws(
      () => service.replace({
        providers: [providerProfile({ protocol: 'anthropic-messages', baseUrl: fixture.baseUrl })],
        routes: new Map([['relay', ROUTE]]),
      }),
      (error) => error.code === 'PROTOCOL_UNSUPPORTED',
    );
    assert.throws(
      () => service.replace({ providers: [providerProfile({ baseUrl: fixture.baseUrl })], routes: new Map() }),
      (error) => error.code === 'INVALID_SNAPSHOT',
    );
    assert.throws(
      () => service.replace({
        providers: [providerProfile({ baseUrl: fixture.baseUrl, models: [{ id: 'm', efforts: ['ultra'] }] })],
        routes: new Map([['relay', ROUTE]]),
      }),
      (error) => error.code === 'INVALID_SNAPSHOT',
    );

    const listed = await service.getAdapter().listModels(ROUTE);
    assert.deepEqual(listed.map((entry) => entry.id), ['deepseek-v4.1-flash', 'deepseek-v4.1-pro']);
    assert.deepEqual(service.snapshot().providerIds, ['relay']);
  } finally {
    await fixture.close();
  }
});

test('an unset credential reference resolves from no ambient source, even with the variable in the environment', async () => {
  const fixture = await startFixture();
  // The ambient value a provider library could pick up on its own. It must be
  // unreachable: the adapter injects a strict auth context and never lets pi-ai
  // read the process environment.
  const reference = 'DSH_DELEGATE_TEST_AMBIENT_KEY';
  process.env[reference] = 'sk-ambient-must-not-be-used';
  const credentials = fakeCredentials({});
  const service = createOpenAiAdapter({ credentials });

  try {
    service.replace({
      providers: [providerProfile({ baseUrl: fixture.baseUrl, credentialRef: reference })],
      routes: new Map([['relay', ROUTE]]),
    });
    const error = await collect(service.getAdapter().stream({
      provider: ROUTE,
      model: 'deepseek-v4.1-pro',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })).then(() => null, (failure) => failure);

    assert.equal(error?.code, 'MISSING_CREDENTIAL');
    // The ambient value must not appear anywhere in the failure.
    assert.equal(JSON.stringify(error.details ?? {}).includes('sk-ambient'), false);
    assert.equal(String(error.message).includes('sk-ambient'), false);
    assert.equal(fixture.requests.length, 0, 'no request reached the network on the ambient value');
    assert.deepEqual(credentials.asked, [reference], 'the DSH seam was consulted, and it alone was');
  } finally {
    delete process.env[reference];
    await fixture.close();
  }
});
