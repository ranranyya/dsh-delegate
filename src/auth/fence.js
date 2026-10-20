// Transport-level trust primitives.
//
// This module holds only pure predicates. It decides whether a request is even
// allowed to reach a handler; it never decides that a caller is authorized to
// dispatch work. Authorization is a separate, server-side grant (see
// src/auth/grants.js) — an Origin string or a client-supplied boolean is not
// evidence of anything and is never consulted for a decision.

import { createHash, timingSafeEqual } from 'node:crypto';

const IPV4_LOOPBACK = /^127(\.\d{1,3}){3}$/;

/**
 * Whether an address literal is this machine's loopback.
 * @param {string | undefined} address - socket remote address.
 * @returns {boolean} true for 127.0.0.0/8 and ::1 (including v4-mapped form).
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false;
  const normalized = address.toLowerCase().split('%', 1)[0];
  if (normalized === '::1') return true;
  if (IPV4_LOOPBACK.test(normalized)) return true;
  if (!normalized.startsWith('::ffff:')) return false;
  return IPV4_LOOPBACK.test(normalized.slice(7));
}

/**
 * Whether a Host/authority name refers to this machine.
 * @param {string} hostname - hostname without port.
 * @returns {boolean} true for localhost and loopback literals.
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string') return false;
  const name = hostname.toLowerCase();
  return name === 'localhost' || name === '::1' || name === '[::1]' || IPV4_LOOPBACK.test(name);
}

/**
 * Canonical `host:port` authority for a raw Host header value.
 * @param {unknown} hostHeader - raw Host header.
 * @returns {string | null} canonical authority, or null when unparsable.
 */
export function requestAuthority(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return null;
  try {
    return new URL(`http://${hostHeader.trim()}`).host;
  } catch {
    return null;
  }
}

/**
 * Peer-side fence for external-connection endpoints.
 *
 * A connection credential is only meaningful when the peer is provably this
 * machine: the socket is loopback, the Host header names this machine, and a
 * browser-marked request is same-origin. Anything else is refused before the
 * credential is even examined.
 * @param {{socket?: {remoteAddress?: string}, headers?: Record<string, unknown>}} request - node request-like object.
 * @returns {{ ok: true } | { ok: false, code: string, status: number }} verdict.
 */
export function fenceExternalConnection(request) {
  const remote = request?.socket?.remoteAddress;
  if (!isLoopbackAddress(remote)) {
    return { ok: false, code: 'CONNECTION_NOT_LOCAL', status: 403 };
  }
  const authority = requestAuthority(request?.headers?.host);
  if (authority === null) return { ok: false, code: 'CONNECTION_HOST_INVALID', status: 403 };
  const hostname = authority.split(':')[0];
  if (!isLoopbackHostname(hostname)) {
    return { ok: false, code: 'CONNECTION_HOST_NOT_LOCAL', status: 403 };
  }
  const fetchSite = String(request?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite !== '' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, code: 'CONNECTION_CROSS_ORIGIN', status: 403 };
  }
  const origin = request?.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return { ok: false, code: 'CONNECTION_ORIGIN_INVALID', status: 403 };
    }
    if (parsed.host.toLowerCase() !== authority.toLowerCase()) {
      return { ok: false, code: 'CONNECTION_CROSS_ORIGIN', status: 403 };
    }
    if (!isLoopbackHostname(parsed.hostname.toLowerCase())) {
      return { ok: false, code: 'CONNECTION_ORIGIN_NOT_LOCAL', status: 403 };
    }
  }
  return { ok: true };
}

/**
 * Whether the listening posture still allows external-connection endpoints.
 * A non-loopback bind destroys the only locality proof these endpoints have, so
 * the plugin refuses to serve them rather than trusting a header assertion.
 * @param {string} bindHost - configured webserver bind host.
 * @returns {{ ok: boolean, code?: string }} verdict.
 */
export function bindAllowsExternalConnections(bindHost) {
  if (bindHost === '127.0.0.1') return { ok: true };
  return {
    ok: false,
    code: 'CONNECTION_BIND_NOT_LOOPBACK',
  };
}

/**
 * User-plane fence for the authenticated native control surface.
 *
 * Two independent facts must hold: the request is a first-party same-origin
 * request (no cross-site form or script can forge it), and the native browser
 * session says the request speaks for the operator. This function performs the
 * first check itself and delegates the second, so a caller cannot satisfy it
 * by sending a header.
 * @param {{method?: string, headers?: Record<string, unknown>, socket?: {remoteAddress?: string}}} request - node request-like object.
 * @param {(request: object) => boolean | Promise<boolean>} isNativeAuthenticated - native authentication verdict.
 * @returns {Promise<{ ok: true } | { ok: false, code: string, status: number }>} verdict.
 */
export async function fenceUserPlane(request, isNativeAuthenticated) {
  const remote = request?.socket?.remoteAddress;
  if (!isLoopbackAddress(remote)) return { ok: false, code: 'USER_PLANE_NOT_LOCAL', status: 403 };
  const authority = requestAuthority(request?.headers?.host);
  if (authority === null) return { ok: false, code: 'USER_PLANE_HOST_INVALID', status: 403 };
  const origin = request?.headers?.origin;
  if (typeof origin !== 'string' || origin === '') {
    // A browser write always carries Origin; a non-browser local tool must not
    // reach this plane at all because it cannot prove a native session.
    return { ok: false, code: 'USER_PLANE_ORIGIN_REQUIRED', status: 403 };
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, code: 'USER_PLANE_ORIGIN_INVALID', status: 403 };
  }
  if (parsed.host.toLowerCase() !== authority.toLowerCase()) {
    return { ok: false, code: 'USER_PLANE_CROSS_ORIGIN', status: 403 };
  }
  if (!isLoopbackHostname(parsed.hostname.toLowerCase())) {
    return { ok: false, code: 'USER_PLANE_ORIGIN_NOT_LOCAL', status: 403 };
  }
  const fetchSite = String(request?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite !== '' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, code: 'USER_PLANE_CROSS_SITE', status: 403 };
  }
  const method = String(request?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const contentType = String(request?.headers?.['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      return { ok: false, code: 'USER_PLANE_CONTENT_TYPE', status: 415 };
    }
  }
  let authenticated = false;
  try {
    authenticated = (await isNativeAuthenticated(request)) === true;
  } catch {
    authenticated = false;
  }
  if (!authenticated) return { ok: false, code: 'USER_PLANE_UNAUTHENTICATED', status: 401 };
  return { ok: true };
}

/**
 * Constant-time comparison of two strings of arbitrary length.
 * @param {string} a - first value.
 * @param {string} b - second value.
 * @returns {boolean} true when equal.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/**
 * SHA-256 of a value as lowercase hex. Only hashes of secrets are retained.
 * @param {string} value - value to digest.
 * @returns {string} hex digest.
 */
export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}
