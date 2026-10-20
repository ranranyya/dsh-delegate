// Shared HTTP plumbing for both delegation planes.
//
// The helpers here are deliberately dumb: they parse a bounded JSON body, emit
// a JSON response, and translate refusals into status codes. Every decision
// about *whether* a request may proceed lives in the plane that owns the route.

/** Bound on a request body. A control request is small by nature. */
export const MAX_BODY_BYTES = 512 * 1024;

/**
 * Read a bounded JSON body from a node request stream.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} [limit] - byte bound.
 * @returns {Promise<object>} parsed body, or an empty object when absent.
 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(413, 'BODY_TOO_LARGE', `request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'BODY_NOT_OBJECT', 'request body must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'BODY_INVALID_JSON', 'request body is not valid JSON');
  }
}

/**
 * Read a bounded JSON body from a WHATWG Request.
 * @param {Request} request - fetch-style request.
 * @param {number} [limit] - byte bound.
 * @returns {Promise<object>} parsed body, or an empty object when absent.
 */
export async function readJsonRequest(request, limit = MAX_BODY_BYTES) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > limit) {
    throw new HttpError(413, 'BODY_TOO_LARGE', `request body exceeds ${limit} bytes`);
  }
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'BODY_NOT_OBJECT', 'request body must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'BODY_INVALID_JSON', 'request body is not valid JSON');
  }
}

/** An HTTP-level refusal with a stable code. */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - stable machine code.
   * @param {string} message - explanation.
   * @param {object} [details] - bounded details.
   */
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Emit a JSON response on a node response object.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - status code.
 * @param {unknown} payload - JSON payload.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {void}
 */
export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    // These responses carry authorization state; they must never be cached or
    // sniffed into another context.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

/**
 * Build a WHATWG JSON response for a fetch-style route.
 * @param {number} status - status code.
 * @param {unknown} payload - JSON payload.
 * @param {Record<string, string>} [headers] - extra headers.
 * @returns {Response} response.
 */
export function jsonResponse(status, payload, headers = {}) {
  return new Response(`${JSON.stringify(payload)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

/**
 * Map a thrown value onto a status/code pair without leaking internals.
 *
 * Known refusals keep their own code so a caller can act on it; anything
 * unrecognized becomes a generic 500 with no message from the original error.
 * @param {unknown} error - thrown value.
 * @returns {{ status: number, code: string, message: string, details: object }} mapping.
 */
export function classifyError(error) {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message, details: error.details ?? {} };
  }
  const code = typeof error?.code === 'string' ? error.code : null;
  const details = error?.details !== null && typeof error?.details === 'object' ? error.details : {};
  const message = typeof error?.message === 'string' ? error.message : 'the request could not be completed';
  if (code === null) {
    return { status: 500, code: 'INTERNAL_ERROR', message: 'the request could not be completed', details: {} };
  }
  return { status: statusForCode(code), code, message, details };
}

function statusForCode(code) {
  if (code === AUTH_UNAUTHENTICATED) return 401;
  if (code.startsWith('USER_PLANE_') || code.startsWith('CONNECTION_')) return 403;
  if (code.endsWith('_NOT_FOUND') || code === 'GRANT_UNKNOWN' || code === 'CONNECTION_UNKNOWN') return 404;
  if (code.startsWith('SETTINGS_') || code.startsWith('PROVIDER_') || code.startsWith('MODEL_')) return 400;
  if (code.startsWith('SELECTION_')) return 409;
  if (code.startsWith('GRANT_')) return 409;
  if (code === 'WORKSPACE_BUSY') return 409;
  if (code.startsWith('ROUTING_')) return 409;
  if (code.startsWith('AUDIT_')) return 409;
  if (code.startsWith('JOB_')) return 409;
  if (code === 'BODY_TOO_LARGE') return 413;
  if (code === 'BODY_INVALID_JSON' || code === 'BODY_NOT_OBJECT') return 400;
  return 400;
}

const AUTH_UNAUTHENTICATED = 'USER_PLANE_UNAUTHENTICATED';
