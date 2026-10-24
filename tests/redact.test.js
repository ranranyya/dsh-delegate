// Redaction tests: usage counters stay readable, credentials never do.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MASK,
  isSecretKey,
  isUsageCounter,
  redactDeep,
  redactText,
} from '../src/config/redact.js';

test('a job record keeps its usage counters and still masks the credential', () => {
  // The reported bug: every counter under `usage` matched the secret pattern
  // because the key contains the substring `token`.
  const redacted = redactDeep({
    usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, reasoningTokens: 2 },
    access_token: 'fixture-value',
  });
  assert.deepEqual(redacted.usage, { inputTokens: 12, outputTokens: 3, totalTokens: 15, reasoningTokens: 2 });
  assert.equal(redacted.access_token, MASK);
});

test('every known counter spelling is published as a number', () => {
  const counters = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    reasoningTokens: 4,
    cacheTokens: 5,
    cacheReadTokens: 6,
    cacheWriteTokens: 7,
    input_tokens: 8,
    output_tokens: 9,
    total_tokens: 10,
    reasoning_tokens: 11,
    cache_tokens: 12,
    cache_read_tokens: 13,
    cache_write_tokens: 14,
  };
  assert.deepEqual(redactDeep(counters), counters);
});

test('a zero counter survives, including nested inside an execution record', () => {
  const redacted = redactDeep({ execution: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } });
  assert.deepEqual(redacted.execution.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
});

test('the exemption is not a general *Tokens suffix rule', () => {
  for (const key of ['refreshTokens', 'myCustomTokens', 'approvalTokens', 'tokens', 'tokenBudget', 'session_tokens']) {
    assert.equal(isUsageCounter(key, 5), false, key);
    assert.equal(redactDeep({ [key]: 5 })[key], MASK, `${key} is a secret key, not a counter`);
  }
});

test('a counter-shaped key holding a non-number is still masked', () => {
  const cases = [
    ['inputTokens', '12'],
    ['totalTokens', 'not-a-count'],
    ['outputTokens', { raw: 12 }],
    ['reasoningTokens', [1, 2]],
    ['cache_tokens', true],
    ['cacheReadTokens', null],
  ];
  for (const [key, value] of cases) {
    assert.equal(isUsageCounter(key, value), false, key);
    // `null` is passed through unchanged by design; every other non-number is masked.
    const expected = value === null ? null : MASK;
    assert.equal(redactDeep({ [key]: value })[key], expected, key);
  }
});

test('a counter-shaped key holding an invalid number is masked', () => {
  for (const value of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(isUsageCounter('inputTokens', value), false, String(value));
    assert.equal(redactDeep({ inputTokens: value }).inputTokens, MASK, String(value));
  }
});

test('an unknown numeric secret under a token name is masked', () => {
  const redacted = redactDeep({
    token: 123456789,
    access_token: 424242,
    api_token: 99,
    secret: 1,
    password: 12345,
    authorization: 7,
  });
  for (const value of Object.values(redacted)) assert.equal(value, MASK);
});

test('a counter-shaped name never hides a credential-shaped string', () => {
  const redacted = redactDeep({
    inputTokens: 'sk-abcdefghijklmnopqrstuvwx',
    usage: { total_tokens: 'Bearer abcdefghijklmnopqrstuvwx' },
  });
  assert.equal(redacted.inputTokens, MASK);
  assert.equal(redacted.usage.total_tokens, MASK);
});

test('free text is still redacted, including inside preserved structures', () => {
  const redacted = redactDeep({
    usage: { inputTokens: 12 },
    note: 'Authorization: Bearer abcdefghijklmnopqrstuvwx',
    env: 'DSH_API_KEY=secret-value',
    key: 'sk-abcdefghijklmnopqrstuvwx',
  });
  assert.deepEqual(redacted.usage, { inputTokens: 12 });
  assert.equal(redacted.note, `Authorization: Bearer ${MASK}`);
  assert.equal(redacted.env, `DSH_API_KEY=${MASK}`);
  assert.equal(redacted.key, MASK);
});

test('counters in arrays and at depth are preserved while siblings are masked', () => {
  const redacted = redactDeep({
    runs: [{ usage: { inputTokens: 4, outputTokens: 5 }, apiKey: 'sk-abcdefghijklmnop' }],
  });
  assert.deepEqual(redacted.runs[0].usage, { inputTokens: 4, outputTokens: 5 });
  assert.equal(redacted.runs[0].apiKey, MASK);
});

test('redaction returns a copy and does not mutate the input', () => {
  const input = { usage: { inputTokens: 12 }, apiKey: 'sk-abcdefghijklmnop' };
  const redacted = redactDeep(input);
  assert.notEqual(redacted, input);
  assert.notEqual(redacted.usage, input.usage);
  assert.equal(input.apiKey, 'sk-abcdefghijklmnop', 'the caller still owns its own value');
  assert.equal(input.usage.inputTokens, 12);
});

test('the secret-key predicate is unchanged for references and counters', () => {
  assert.equal(isSecretKey('access_token'), true);
  assert.equal(isSecretKey('credentialRef'), false, 'a reference is a name, not a value');
  assert.equal(isSecretKey('inputTokens'), true, 'a counter name still looks like a secret until its value is checked');
  assert.equal(redactText('sk-abcdefghijklmnopqrstuvwx'), MASK);
});
