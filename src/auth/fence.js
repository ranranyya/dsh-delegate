// Transport-level trust primitives.
//
// This module holds only pure predicates. It decides whether a request is even
// allowed to reach a handler; it never decides that a caller is authorized to
// dispatch work. Authorization is a separate, server-side grant (see
// src/auth/grants.js) — an Origin string or a client-supplied boolean is not
// evidence of anything and is never consulted for a decision.

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

/**
 * One dotted-quad IPv4 loopback literal. Each octet is range-checked, so
 * `127.300.0.1` and `127.0.0.256` are not accepted as loopback merely because
 * they start with `127`.
 */
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_LOOPBACK = new RegExp(`^127(?:\\.${IPV4_OCTET}){3}$`);

/**
 * One strict dotted-quad IPv4 literal: exactly four decimal octets, no leading
 * zeroes, each 0-255. `127.1`, `2130706433`, `0177.0.0.1` and `0x7f.0.0.1` all
 * fail this, so none of them can be smuggled in and silently normalised by the
 * URL parser into `127.0.0.1`.
 */
const IPV4_STRICT = new RegExp(`^(?:${IPV4_OCTET})(?:\\.(?:${IPV4_OCTET})){3}$`);

/** One DNS-style label: alphanumeric ends, hyphens inside. */
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** A label the URL parser would read as a hexadecimal IPv4 component. */
const HEX_LABEL = /^0x[0-9a-f]*$/i;

/** A non-empty decimal port token within the valid range. */
const PORT_TOKEN = /^[1-9]\d{0,4}$/;

/**
 * Split a raw Host authority into its literal hostname and optional port.
 *
 * This is a syntactic split only — it decides nothing about locality. It exists
 * because the URL parser is deliberately lenient: it accepts `127.1`,
 * `2130706433` and `0x7f.0.0.1` as `127.0.0.1`, which would let a Host header
 * that is not a dotted-quad IPv4 be treated as loopback. Validating the raw text
 * first means a non-canonical spelling is refused instead of normalised.
 * @param {string} raw - already-whitespace-free authority.
 * @returns {{ hostname: string, port: string } | null} split authority, or null.
 */
function splitRawAuthority(raw) {
  if (raw.startsWith('[')) {
    // Bracketed IPv6, optionally followed by exactly one port.
    const match = /^(\[[^[\]]*\])(?::([^:]*))?$/.exec(raw);
    if (match === null) return null;
    const hostname = match[1];
    // `[::1]:` names an empty port; the parser would silently drop it.
    if (match[2] === '') return null;
    const port = match[2] ?? '';
    if (!isIPv6(hostname.slice(1, -1))) return null;
    return { hostname, port };
  }
  const firstColon = raw.indexOf(':');
  if (firstColon === -1) return { hostname: raw, port: '' };
  const hostname = raw.slice(0, firstColon);
  const port = raw.slice(firstColon + 1);
  // A second colon means an unbracketed IPv6 literal, which is not an authority.
  if (port.includes(':')) return null;
  // `127.0.0.1:` names an empty port; refuse rather than let the parser drop it.
  if (port === '') return null;
  return { hostname, port };
}

/**
 * Whether a raw hostname token is a spelling this module accepts.
 *
 * Accepts only three spellings: a strict dotted-quad IPv4, a bracketed IPv6
 * literal, or a DNS-style name. Anything numeric-looking that is not a strict
 * quad is a shortcut the URL parser would expand, so it is refused here.
 * @param {string} hostname - raw host token (brackets kept for IPv6).
 * @returns {boolean} true when the spelling is exactly what it appears to be.
 */
function isAcceptableRawHostname(hostname) {
  if (hostname === '') return false;
  if (hostname.startsWith('[') || hostname.endsWith(']')) return true;
  const labels = hostname.split('.');
  if (labels.every((label) => /^\d+$/.test(label))) {
    // Every label is decimal, so this is meant as an IPv4 literal: it must be a
    // strict quad. `127.1`, `2130706433` and `127.0.0.256` all fail here.
    return IPV4_STRICT.test(hostname) && isIPv4(hostname);
  }
  for (const label of labels) {
    if (!HOST_LABEL.test(label)) return false;
    if (HEX_LABEL.test(label)) return false;
  }
  return true;
}

/**
 * Characters that must never appear in a Host header.
 *
 * A raw Host value is not a URL. Letting the URL parser interpret it means
 * accepting things a Host header can never legally be: `user@host` (userinfo),
 * `host/path`, `host?query`, `host#fragment`, embedded whitespace or a
 * backslash. Any of those is an attempt to have one component read as another,
 * so each is refused before parsing rather than after.
 */
const FORBIDDEN_AUTHORITY = /[\s\\/?#@%\u0000-\u001f\u007f]/;

/** Hostnames accepted as "this machine" when resolved as names rather than literals. */
const LOOPBACK_NAMES = new Set(['localhost']);

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
 *
 * Accepts a bracketed IPv6 literal because `URL.hostname` keeps the brackets;
 * accepts the unbracketed form because a caller may pass a socket-level name.
 * @param {string} hostname - hostname without port.
 * @returns {boolean} true for localhost and loopback literals.
 */
export function isLoopbackHostname(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const name = hostname.toLowerCase();
  if (name === '::1' || name === '[::1]') return true;
  if (LOOPBACK_NAMES.has(name)) return true;
  if (name.startsWith('[') || name.endsWith(']')) return false;
  return IPV4_LOOPBACK.test(name);
}

/**
 * Canonical `host:port` authority for a raw Host header value.
 *
 * The header is validated as a bare authority first — no userinfo, path, query,
 * fragment, whitespace or backslash — and only then handed to the URL parser for
 * canonicalisation (case folding, default-port removal, IDNA). A value that
 * fails validation is `null`, which every caller treats as a refusal.
 * @param {unknown} hostHeader - raw Host header.
 * @returns {{ authority: string, hostname: string, port: string } | null} parsed authority, or null.
 */
export function parseRequestAuthority(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  // No trimming: a Host header that carries leading or trailing whitespace is
  // not the authority it appears to be, and accepting it would let the parser
  // ignore bytes the client actually sent.
  if (hostHeader === '') return null;
  if (hostHeader !== hostHeader.trim()) return null;
  const raw = hostHeader;
  // A Host header is exactly one authority. Anything else is a smuggling attempt.
  if (FORBIDDEN_AUTHORITY.test(raw)) return null;
  if (raw.includes(',')) return null;
  // Validate the spelling before the URL parser can canonicalise a shortcut form.
  const split = splitRawAuthority(raw);
  if (split === null) return null;
  if (!isAcceptableRawHostname(split.hostname)) return null;
  if (split.port !== '') {
    if (!PORT_TOKEN.test(split.port)) return null;
    if (Number(split.port) > 65_535) return null;
  }
  let parsed;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    return null;
  }
  // Refuse anything the parser invented around our input.
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.hostname === '') return null;
  return {
    authority: parsed.host.toLowerCase(),
    // `URL.hostname` strips the port and keeps IPv6 brackets, unlike a naive
    // `authority.split(':')[0]`, which would truncate `[::1]:3210` to `[`.
    hostname: parsed.hostname.toLowerCase(),
    port: parsed.port,
  };
}

/**
 * Canonical `host:port` authority for a raw Host header value.
 * @param {unknown} hostHeader - raw Host header.
 * @returns {string | null} canonical authority, or null when unparsable.
 */
export function requestAuthority(hostHeader) {
  return parseRequestAuthority(hostHeader)?.authority ?? null;
}

/**
 * Whether a parsed browser Origin is this server's own origin.
 * @param {string} origin - raw Origin header.
 * @param {{ authority: string }} host - parsed Host header facts.
 * @returns {{ ok: true } | { ok: false, code: string }} verdict.
 */
function originMatchesHost(origin, host, prefix) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, code: `${prefix}_ORIGIN_INVALID` };
  }
  // `Origin` is a scheme plus authority, never a path: a value carrying userinfo,
  // a path, a query or a fragment is not a browser Origin at all.
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, code: `${prefix}_ORIGIN_INVALID` };
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return { ok: false, code: `${prefix}_ORIGIN_INVALID` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: `${prefix}_ORIGIN_INVALID` };
  }
  if (parsed.host.toLowerCase() !== host.authority) return { ok: false, code: `${prefix}_CROSS_ORIGIN` };
  if (!isLoopbackHostname(parsed.hostname.toLowerCase())) {
    return { ok: false, code: `${prefix}_ORIGIN_NOT_LOCAL` };
  }
  return { ok: true };
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
  const host = parseRequestAuthority(request?.headers?.host);
  if (host === null) return { ok: false, code: 'CONNECTION_HOST_INVALID', status: 403 };
  if (!isLoopbackHostname(host.hostname)) {
    return { ok: false, code: 'CONNECTION_HOST_NOT_LOCAL', status: 403 };
  }
  const fetchSite = String(request?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite !== '' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, code: 'CONNECTION_CROSS_ORIGIN', status: 403 };
  }
  const origin = request?.headers?.origin;
  if (typeof origin === 'string' && origin !== '') {
    const verdict = originMatchesHost(origin, host, 'CONNECTION');
    if (verdict.ok !== true) return { ok: false, code: verdict.code, status: 403 };
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
 * first check itself and delegates the second, so a caller cannot satisfy it by
 * sending a header.
 *
 * The Origin rule is asymmetric on purpose:
 *
 *  * a **write** (`POST` and anything else that is not `GET`/`HEAD`) must carry
 *    a same-origin `Origin` and a JSON content type. Browsers always send
 *    `Origin` on those requests, so a missing one is a non-browser caller trying
 *    to look like one, and a non-JSON type is a cross-site form post;
 *  * an authenticated **read** (`GET`/`HEAD`) may omit `Origin`, because
 *    same-origin `GET` navigations legitimately do not send it. It still has to
 *    pass the native authentication check, and a supplied `Origin` is still
 *    required to match this server.
 *
 * This helper is not wired to the live user plane: that plane is registered on
 * the native `connection.fetch` carrier, which applies the harness's own fence
 * and browser-session authentication before any handler runs. This function
 * exists for a future plain-node user plane and for tests of the rule itself.
 * @param {{method?: string, headers?: Record<string, unknown>, socket?: {remoteAddress?: string}}} request - node request-like object.
 * @param {(request: object) => boolean | Promise<boolean>} isNativeAuthenticated - native authentication verdict.
 * @returns {Promise<{ ok: true } | { ok: false, code: string, status: number }>} verdict.
 */
export async function fenceUserPlane(request, isNativeAuthenticated) {
  const remote = request?.socket?.remoteAddress;
  if (!isLoopbackAddress(remote)) return { ok: false, code: 'USER_PLANE_NOT_LOCAL', status: 403 };
  const host = parseRequestAuthority(request?.headers?.host);
  if (host === null) return { ok: false, code: 'USER_PLANE_HOST_INVALID', status: 403 };
  const method = String(request?.method ?? 'GET').toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  const origin = request?.headers?.origin;
  if (typeof origin !== 'string' || origin === '') {
    if (!isRead) {
      // A browser write always carries Origin; a non-browser local tool must not
      // reach this plane at all because it cannot prove a native session.
      return { ok: false, code: 'USER_PLANE_ORIGIN_REQUIRED', status: 403 };
    }
  } else {
    const verdict = originMatchesHost(origin, host, 'USER_PLANE');
    if (verdict.ok !== true) return { ok: false, code: verdict.code, status: 403 };
  }
  const fetchSite = String(request?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite !== '' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return { ok: false, code: 'USER_PLANE_CROSS_SITE', status: 403 };
  }
  if (!isRead) {
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
