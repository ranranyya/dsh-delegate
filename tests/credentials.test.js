// Credential seam + credential-facing user-plane routes.
//
// The rules under test all come from one sentence in SPEC.md: never return secrets
// in public config, MCP, job history or logs. So the assertions here are mostly
// *negative* — no value in a response body, no value in a refusal detail, no value
// in a log line — and the positive assertions are about which seam method got
// called with which reference.
//
// The seam double below deliberately answers `describe` with a `CredentialInfo`
// that has no value slot, exactly like the installed
// `@deepseek-ai/dsh-credentials` type, so a handler cannot accidentally be written
// against a richer shape than the real service provides.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
  CREDENTIAL_CODES,
  MAX_CREDENTIAL_VALUE_CHARS,
  createCredentialGateway,
} from '../src/credentials/seam.js';
import { USER_PLANE_PREFIX, wrapUserPlaneRoutes } from '../src/http/user-plane.js';
import { AuthorizationRegistry } from '../src/auth/grants.js';
import { SettingsService } from '../src/config/settings.js';
import { cleanup, makeTempDir, validSettings } from './helpers/fakes.js';

/** A literal that no response may ever contain. */
const SECRET = 'sk-test-value-never-returned-0123456789';

/**
 * Build a seam double recording every call.
 * @param {object} [options] - `info`, `fail`: error to throw from the named op.
 * @returns {object} service with `calls` history.
 */
function fakeSeam(options = {}) {
  const calls = [];
  const info = options.info ?? { configured: false, writable: true };
  const fail = options.fail ?? {};
  const record = (operation, ...args) => calls.push([operation, ...args]);
  return {
    calls,
    async describe(ref) {
      record('describe', ref);
      if (fail.describe !== undefined) throw fail.describe;
      return { ...info };
    },
    async resolve(ref) {
      record('resolve', ref);
      return undefined;
    },
    async set(ref, value) {
      record('set', ref, value);
      if (fail.set !== undefined) throw fail.set;
    },
    async unset(ref) {
      record('unset', ref);
      if (fail.unset !== undefined) throw fail.unset;
    },
  };
}

/**
 * Build the route harness.
 * @param {object} [options] - `seam` (null for absent), `settings`.
 * @returns {Promise<object>} harness.
 */
async function harness(options = {}) {
  const dir = await makeTempDir();
  const settings = new SettingsService(join(dir, 'data'));
  await settings.replace(options.settings ?? validSettings());
  const auth = new AuthorizationRegistry();
  const deps = {
    settings,
    auth,
    engine: { posture: () => ({ authorized: false, reason: 'off' }) },
    logger: { warn() {} },
    describeRuntime: () => ({ plugin: 'dsh-delegate' }),
    ...(options.seam === null ? {} : { credentials: options.seam ?? fakeSeam() }),
  };
  return { dir, deps, settings, seam: deps.credentials };
}

/**
 * Drive one route the way the carrier does: a `Request` in, a `Response` out.
 * @param {object[]} routes - route set.
 * @param {string} method - HTTP method.
 * @param {string} path - exact path.
 * @param {object} [body] - JSON body.
 * @returns {Promise<{ status: number, body: object }>} parsed answer.
 */
async function call(routes, method, path, body) {
  const route = routes.find((candidate) => candidate.path === path);
  assert.ok(route !== undefined, `no route registered for ${path}`);
  assert.ok(route.methods.includes(method), `${path} does not accept ${method}`);
  const response = await route.fetch(new Request(`http://127.0.0.1:3210${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  }));
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

// ---------------------------------------------------------------------------
// 1. The gateway itself
// ---------------------------------------------------------------------------

test('the gateway refuses every operation when the harness exposes no credential service', async () => {
  const gateway = createCredentialGateway(() => undefined);
  assert.equal(gateway.available(), false);
  for (const operation of ['describe', 'resolve', 'set', 'unset']) {
    await assert.rejects(
      () => (operation === 'set' ? gateway.set('REF', 'value') : gateway[operation]('REF')),
      (error) => {
        assert.equal(error.code, CREDENTIAL_CODES.seamUnavailable, `${operation} must report the seam as unavailable`);
        // The refusal names the operation and never a value.
        assert.equal(JSON.stringify(error.details).includes('value'), false);
        return true;
      },
    );
  }
});

test('the gateway reads the service lazily, so a seam that appears later is observed', () => {
  let service = null;
  const gateway = createCredentialGateway(() => service);
  assert.equal(gateway.available(), false);
  service = fakeSeam();
  assert.equal(gateway.available(), true, 'the gateway must not cache the absence of the service');
});

test('the gateway refuses a service that does not implement the operation it needs', async () => {
  const gateway = createCredentialGateway(() => ({ describe: async () => ({ configured: true, writable: true }) }));
  await assert.rejects(() => gateway.set('REF', 'v'), (error) => {
    assert.equal(error.code, CREDENTIAL_CODES.seamUnavailable);
    assert.match(error.message, /set\(\)/u);
    return true;
  });
});

test('a provider failure is reduced to its code, because its message may quote the value', async () => {
  const leaky = Object.assign(new Error(`rejected value ${SECRET}`), { code: 'EACCES' });
  const seam = fakeSeam({ fail: { set: leaky } });
  const gateway = createCredentialGateway(() => seam);
  await assert.rejects(() => gateway.set('REF', SECRET), (error) => {
    assert.equal(error.code, CREDENTIAL_CODES.operationFailed);
    assert.equal(error.details.cause, 'EACCES');
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(JSON.stringify(error.details).includes(SECRET), false);
    return true;
  });
});

test('set refuses an empty value and an oversized one, and never trims a real one', async () => {
  const seam = fakeSeam();
  const gateway = createCredentialGateway(() => seam);
  await assert.rejects(() => gateway.set('REF', '   '), (error) => {
    assert.equal(error.code, CREDENTIAL_CODES.valueRequired);
    return true;
  });
  await assert.rejects(() => gateway.set('REF', 'x'.repeat(MAX_CREDENTIAL_VALUE_CHARS + 1)), (error) => {
    assert.equal(error.code, CREDENTIAL_CODES.valueTooLarge);
    return true;
  });
  assert.deepEqual(seam.calls, [], 'a refused value must never reach the seam');

  await gateway.set('REF', ' padded-value ');
  assert.deepEqual(seam.calls.at(-1), ['set', 'REF', ' padded-value '], 'the literal must be stored verbatim');
});

test('describe projects presence and writability only, dropping anything else the seam returned', async () => {
  const seam = fakeSeam({ info: { configured: true, source: 'store', writable: true, value: SECRET } });
  const gateway = createCredentialGateway(() => seam);
  const info = await gateway.describe('REF');
  assert.deepEqual(info, { configured: true, source: 'store', writable: true });
  assert.equal(JSON.stringify(info).includes(SECRET), false);
});

// ---------------------------------------------------------------------------
// 2. Credential user-plane routes
// ---------------------------------------------------------------------------

test('POST /credentials/status reports presence without a value', async () => {
  const seam = fakeSeam({ info: { configured: true, source: 'store', writable: true } });
  const { dir, deps } = await harness({ seam });
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/credentials/status`, { providerId: 'relay' });
    assert.equal(result.status, 200);
    assert.equal(result.body.credential.configured, true);
    assert.equal(result.body.reference, 'DSH_DELEGATE_RELAY_KEY');
    assert.deepEqual(result.body.secrets, { values_returned: false });
    assert.equal(JSON.stringify(result.body).includes(SECRET), false);
    assert.deepEqual(seam.calls, [['describe', 'DSH_DELEGATE_RELAY_KEY']]);
  } finally {
    await cleanup(dir);
  }
});

test('POST /credentials/set forwards the literal once and returns only presence', async () => {
  const seam = fakeSeam({ info: { configured: true, writable: true } });
  const { dir, deps } = await harness({ seam });
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/credentials/set`, {
      providerId: 'relay',
      value: SECRET,
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(JSON.stringify(result.body).includes(SECRET), false, 'the response must never echo the value');
    assert.deepEqual(seam.calls, [
      ['set', 'DSH_DELEGATE_RELAY_KEY', SECRET],
      ['describe', 'DSH_DELEGATE_RELAY_KEY'],
    ]);
  } finally {
    await cleanup(dir);
  }
});

test('an empty value on /credentials/set is refused with a code the page can explain', async () => {
  const seam = fakeSeam();
  const { dir, deps } = await harness({ seam });
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/credentials/set`, {
      providerId: 'relay',
      value: '',
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, CREDENTIAL_CODES.valueRequired);
    assert.deepEqual(seam.calls, []);
  } finally {
    await cleanup(dir);
  }
});

test('POST /credentials/unset removes the value and reports the new state', async () => {
  const seam = fakeSeam({ info: { configured: false, writable: true } });
  const { dir, deps } = await harness({ seam });
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/credentials/unset`, { providerId: 'relay' });
    assert.equal(result.status, 200);
    assert.equal(result.body.credential.configured, false);
    assert.deepEqual(seam.calls, [
      ['unset', 'DSH_DELEGATE_RELAY_KEY'],
      ['describe', 'DSH_DELEGATE_RELAY_KEY'],
    ]);
  } finally {
    await cleanup(dir);
  }
});

test('a credential route on a harness without a seam answers 503, not a fabricated status', async () => {
  const { dir, deps } = await harness({ seam: null });
  try {
    const routes = wrapUserPlaneRoutes(deps);
    for (const path of ['credentials/status', 'credentials/set', 'credentials/unset']) {
      const result = await call(routes, 'POST', `${USER_PLANE_PREFIX}/${path}`, { providerId: 'relay', value: SECRET });
      assert.equal(result.status, 503, `${path} must report the capability gap`);
      assert.equal(result.body.error.code, CREDENTIAL_CODES.seamUnavailable);
      assert.equal(JSON.stringify(result.body).includes(SECRET), false);
    }
  } finally {
    await cleanup(dir);
  }
});

test('a credential route refuses an unknown provider and a provider with no reference', async () => {
  const settings = validSettings();
  settings.providers.push({
    id: 'bare',
    name: 'Bare',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:9000/v1',
    credentialRef: null,
    models: [{ id: 'm', efforts: [] }],
  });
  const seam = fakeSeam();
  const { dir, deps } = await harness({ seam, settings });
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const missingId = await call(routes, 'POST', `${USER_PLANE_PREFIX}/credentials/status`, {});
    assert.equal(missingId.status, 400);
    assert.equal(missingId.body.error.code, 'PROVIDER_ID_REQUIRED');

    const unknown = await call(routes, 'POST', `${USER_PLANE_PREFIX}/credentials/status`, { providerId: 'ghost' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PROVIDER_UNKNOWN');

    const noRef = await call(routes, 'POST', `${USER_PLANE_PREFIX}/credentials/set`, { providerId: 'bare', value: SECRET });
    assert.equal(noRef.status, 400);
    assert.equal(noRef.body.error.code, 'PROVIDER_CREDENTIAL_REF_MISSING');
    assert.deepEqual(seam.calls, [], 'a profile with no reference must never reach the seam');
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 3. Model listing and the connectivity route
// ---------------------------------------------------------------------------

test('POST /catalog reports the native route and per-model declared efforts', async () => {
  const { dir, deps } = await harness();
  // The fake native service answers in the shape `LlmRuntime` produces; the route
  // is the one the registry mapped, not the profile id. A native route/model
  // catalog read is `/catalog`; `/models` is remote discovery only.
  deps.llm = {
    async listProviders() {
      return [{ id: 'relay-native' }];
    },
    async resolveModelInfo(provider, model) {
      assert.equal(provider, 'relay-native');
      const efforts = model === 'deepseek-chat' ? ['low', 'medium', 'high'] : ['medium', 'high'];
      return { provider, id: model, name: model, reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } };
    },
  };
  deps.ensureRoutes = async () => new Map([['relay', 'relay-native']]);
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/catalog`, {});
    assert.equal(result.status, 200);
    assert.equal(result.body.registration, null);
    assert.deepEqual(result.body.catalog.map((entry) => entry.providerId), ['relay']);
    const [entry] = result.body.catalog;
    assert.equal(entry.route, 'relay-native');
    assert.deepEqual(entry.models.map((model) => model.id), ['deepseek-chat', 'deepseek-reasoner']);
    assert.deepEqual(entry.models[0].efforts, ['low', 'medium', 'high']);
    assert.equal(entry.error, null);
    assert.deepEqual(result.body.secrets, { values_returned: false });
  } finally {
    await cleanup(dir);
  }
});

test('POST /catalog keeps a provider error explicit instead of returning a bare empty list', async () => {
  const { dir, deps } = await harness();
  deps.llm = {
    async listProviders() {
      return [{ id: 'relay-native' }];
    },
    async resolveModelInfo() {
      throw Object.assign(new Error('not registered'), { code: 'UNKNOWN_PROVIDER' });
    },
  };
  deps.ensureRoutes = async () => new Map([['relay', 'relay-native']]);
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/catalog`, {});
    assert.equal(result.status, 200);
    const [entry] = result.body.catalog;
    assert.deepEqual(entry.models, []);
    assert.equal(entry.route, 'relay-native');
    assert.equal(entry.error.code, 'ROUTING_MODEL_UNRESOLVED');
  } finally {
    await cleanup(dir);
  }
});

test('a failing route registration does not turn a model list into a 409', async () => {
  const { dir, deps } = await harness();
  const resolved = [];
  deps.llm = {
    async listProviders() {
      return [];
    },
    async resolveModelInfo(provider) {
      resolved.push(provider);
      throw new Error('unreachable');
    },
  };
  deps.ensureRoutes = async () => {
    throw Object.assign(new Error('register refused'), { code: 'provider_registry' });
  };
  try {
    const result = await call(wrapUserPlaneRoutes(deps), 'POST', `${USER_PLANE_PREFIX}/catalog`, {});
    assert.equal(result.status, 200, 'the catalog reports per-provider failure; the request itself did not fail');
    // The registration failure is what is reported. It is NOT converted into a
    // model-resolution failure against the profile id: that would describe a
    // route (`relay`) this plugin never registered.
    assert.equal(result.body.registration.code, 'provider_registry');
    const [entry] = result.body.catalog;
    assert.equal(entry.route, null);
    assert.equal(entry.error.code, 'ROUTING_PROVIDER_NOT_REGISTERED');
    assert.deepEqual(entry.models, []);
    assert.deepEqual(resolved, [], 'no model may be resolved on a route that was never registered');
  } finally {
    await cleanup(dir);
  }
});

test('POST /connectivity returns the four layers and refuses an unknown provider with 404', async () => {
  const { dir, deps } = await harness();
  // The transport layer is driven through an injected fetch so no socket is opened.
  deps.fetchImpl = async () => new Response('', { status: 401 });
  deps.llm = {
    async listProviders() {
      return [{ id: 'relay-native' }];
    },
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'medium', name: 'medium' }] } };
    },
    // The model probe streams through this; a reasoning-only answer is the point.
    async *stream() {
      yield { type: 'reasoning-delta', index: 0, text: 'thinking about it' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  deps.ensureRoutes = async () => new Map([['relay', 'relay-native']]);
  deps.probeModel = (route, options) => import('../src/model/probe.js')
    .then((module) => module.probeModel(deps, route, options ?? {}));
  try {
    const routes = wrapUserPlaneRoutes(deps);
    const result = await call(routes, 'POST', `${USER_PLANE_PREFIX}/connectivity`, { providerId: 'relay' });
    assert.equal(result.status, 200);
    for (const layer of ['transport', 'authentication', 'catalog', 'modelResponse']) {
      assert.ok(layer in result.body.report, `layer ${layer} must be reported`);
    }
    assert.equal(result.body.report.transport.ok, true, 'a 401 proves the endpoint exists');
    assert.equal(result.body.report.authentication.ok, false, 'the seam reports this reference as unconfigured');
    assert.equal(result.body.report.catalog.ok, true);
    assert.equal(result.body.report.modelResponse.ok, true, 'a reasoning-only answer is a working model');
    assert.equal(result.body.report.modelResponse.response.reasoningOnly, true);

    const unknown = await call(routes, 'POST', `${USER_PLANE_PREFIX}/connectivity`, { providerId: 'ghost' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PROVIDER_UNKNOWN');

    const missing = await call(routes, 'POST', `${USER_PLANE_PREFIX}/connectivity`, {});
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'PROVIDER_ID_REQUIRED');
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// 4. Route shape
// ---------------------------------------------------------------------------

test('every credential-facing route is POST-only, so no value can ride in a URL', async () => {
  const { dir, deps } = await harness();
  try {
    const routes = wrapUserPlaneRoutes(deps);
    for (const name of ['models', 'credentials/status', 'credentials/set', 'credentials/unset', 'connectivity']) {
      const route = routes.find((candidate) => candidate.path === `${USER_PLANE_PREFIX}/${name}`);
      assert.ok(route !== undefined, `${name} must be registered`);
      assert.deepEqual(route.methods, ['POST'], `${name} must not accept a GET`);
      assert.equal(route.requestBody, 'buffered');
    }
  } finally {
    await cleanup(dir);
  }
});
