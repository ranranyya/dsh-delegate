// Transport-fence tests.
//
// The fence is the filter in front of the execution plane. It must reject a
// non-loopback peer, a non-loopback Host, a cross-origin browser request, and a
// cross-site fetch — and it must never be the *only* thing standing between a
// caller and delegation (the token and grant are tested elsewhere).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bindAllowsExternalConnections,
  fenceExternalConnection,
  fenceUserPlane,
  isLoopbackAddress,
  isLoopbackHostname,
  requestAuthority,
  safeEqual,
  sha256,
} from '../src/auth/fence.js';

function request(overrides = {}) {
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:3210',
      origin: 'http://127.0.0.1:3210',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    ...overrides,
  };
}

test('loopback addresses are recognized in every spelled form', () => {
  for (const address of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1', '::1%lo0']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['10.0.0.1', '192.168.1.5', '0.0.0.0', '::ffff:10.0.0.1', '', undefined, 'localhost']) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test('loopback hostnames are recognized', () => {
  assert.equal(isLoopbackHostname('localhost'), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  assert.equal(isLoopbackHostname('example.com'), false);
  assert.equal(isLoopbackHostname('localhost.evil.test'), false);
});

test('a canonical authority is derived from the Host header', () => {
  assert.equal(requestAuthority('127.0.0.1:3210'), '127.0.0.1:3210');
  assert.equal(requestAuthority('localhost'), 'localhost');
  assert.equal(requestAuthority(''), null);
  assert.equal(requestAuthority(undefined), null);
});

test('a fully local same-origin request passes the fence', () => {
  assert.deepEqual(fenceExternalConnection(request()), { ok: true });
});

test('a non-loopback peer is refused', () => {
  const verdict = fenceExternalConnection(request({ socket: { remoteAddress: '10.1.2.3' } }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CONNECTION_NOT_LOCAL');
});

test('a non-loopback Host header is refused even from a loopback socket', () => {
  const verdict = fenceExternalConnection(request({
    headers: { host: 'example.com', origin: 'http://example.com' },
  }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CONNECTION_HOST_NOT_LOCAL');
});

test('a cross-site browser fetch is refused', () => {
  const verdict = fenceExternalConnection(request({
    headers: { host: '127.0.0.1:3210', 'sec-fetch-site': 'cross-site' },
  }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CONNECTION_CROSS_ORIGIN');
});

test('a mismatched Origin is refused', () => {
  const verdict = fenceExternalConnection(request({
    headers: { host: '127.0.0.1:3210', origin: 'http://localhost:9999' },
  }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CONNECTION_CROSS_ORIGIN');
});

test('an unparsable Origin is refused, not ignored', () => {
  const verdict = fenceExternalConnection(request({
    headers: { host: '127.0.0.1:3210', origin: 'not a url' },
  }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CONNECTION_ORIGIN_INVALID');
});

test('a missing Host header is refused', () => {
  const verdict = fenceExternalConnection(request({ headers: {} }));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'CONNECTION_HOST_INVALID');
});

test('the execution fence is only allowed on a loopback bind', () => {
  assert.deepEqual(bindAllowsExternalConnections('127.0.0.1'), { ok: true });
  const publicBind = bindAllowsExternalConnections('0.0.0.0');
  assert.equal(publicBind.ok, false);
  assert.equal(publicBind.code, 'CONNECTION_BIND_NOT_LOOPBACK');
});

test('the user plane requires a native authentication verdict, not a header', async () => {
  const deniedByAuth = await fenceUserPlane(request(), () => false);
  assert.equal(deniedByAuth.ok, false);
  assert.equal(deniedByAuth.status, 401);
  assert.equal(deniedByAuth.code, 'USER_PLANE_UNAUTHENTICATED');

  const allowed = await fenceUserPlane(request(), () => true);
  assert.deepEqual(allowed, { ok: true });
});

test('the user plane refuses a request with no Origin', async () => {
  const verdict = await fenceUserPlane(request({ headers: { host: '127.0.0.1:3210' } }), () => true);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 'USER_PLANE_ORIGIN_REQUIRED');
});

test('the user plane refuses cross-origin and cross-site requests before authentication', async () => {
  let authAskCount = 0;
  const countAuth = () => { authAskCount += 1; return true; };

  const crossOrigin = await fenceUserPlane(request({
    headers: { host: '127.0.0.1:3210', origin: 'http://evil.test' },
  }), countAuth);
  assert.equal(crossOrigin.code, 'USER_PLANE_CROSS_ORIGIN');

  const crossSite = await fenceUserPlane(request({
    headers: { host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3210', 'sec-fetch-site': 'cross-site' },
  }), countAuth);
  assert.equal(crossSite.code, 'USER_PLANE_CROSS_SITE');

  assert.equal(authAskCount, 0, 'the native authenticator must not be consulted for a refused origin');
});

test('the user plane requires JSON for a write', async () => {
  const verdict = await fenceUserPlane(request({
    method: 'POST',
    headers: {
      host: '127.0.0.1:3210',
      origin: 'http://127.0.0.1:3210',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/x-www-form-urlencoded',
    },
  }), () => true);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 415);
});

test('an authenticator that throws is treated as unauthenticated', async () => {
  const verdict = await fenceUserPlane(request(), () => { throw new Error('boom'); });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 401);
});

test('constant-time comparison is length-safe and exact', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, 'a'), false);
});

test('sha256 is stable hex', () => {
  assert.equal(sha256('token'), sha256('token'));
  assert.match(sha256('token'), /^[0-9a-f]{64}$/);
  assert.notEqual(sha256('token'), sha256('token2'));
});
