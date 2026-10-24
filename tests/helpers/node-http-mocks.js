// Minimal node-style request/response doubles.
//
// The execution plane is a plain node handler (`(req, res) => Promise<void>`),
// so exercising it needs an `IncomingMessage`-shaped readable and a
// `ServerResponse`-shaped writable. Only the members that plane actually touches
// are implemented, and each one behaves like the real thing where that matters:
//
//   * the request is async-iterable over its body bytes, which is what
//     `readJsonBody` consumes;
//   * `writeHead` records the status and headers, and `end` records the body, so a
//     caller can assert on them after the handler settles.

/**
 * Build a request-like object.
 * @param {object} options - `method`, `url`, `headers`, `body` (string), `remoteAddress`.
 * @returns {object} request double.
 */
export function mockRequest({ method = 'GET', url = '/', headers = {}, body = '', remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    url,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * Build a response-like object.
 * @param {object} [options] - `throwOnSend` to model a dead socket.
 * @returns {object} response double with `status`, `headers`, `body`, `parsed()`.
 */
export function mockResponse(options = {}) {
  const response = {
    status: null,
    headers: {},
    chunks: [],
    headersSent: false,
    writeHead(status, headers = {}) {
      if (options.throwOnSend === true) throw new Error('the connection was destroyed');
      response.status = status;
      response.headers = { ...headers };
      response.headersSent = true;
    },
    end(chunk) {
      if (options.throwOnSend === true) throw new Error('the connection was destroyed');
      if (chunk !== undefined && chunk !== null) response.chunks.push(Buffer.from(chunk));
    },
    /** @returns {string} the body as text. */
    text() {
      return Buffer.concat(response.chunks).toString('utf8');
    },
    /** @returns {object} the body parsed as JSON. */
    parsed() {
      const text = response.text();
      return text === '' ? {} : JSON.parse(text);
    },
  };
  return response;
}
