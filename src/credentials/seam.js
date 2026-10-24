// Credential seam gateway.
//
// The plugin never stores a secret and never reads one back into a projection.
// It talks to the native DSH credential seam (`ctx.credentials`) for exactly four
// operations and nothing else:
//
//   * `describe(ref)` — presence/source/writability, safe for a settings UI;
//   * `resolve(ref)`  — the value, for the native adapter inside a stream call;
//   * `set(ref, value)` — write one value the operator pasted;
//   * `unset(ref)`    — remove it.
//
// The seam is reached through a *lazy* accessor rather than a captured reference.
// Two reasons, both about load order:
//
//   1. this plugin deliberately does not inject the credential service, so it
//      loads and reports state in a harness that has none (the UI then says
//      "host provides no credential interface" instead of the plugin refusing to
//      start); and
//   2. the seam documents a per-operation resolve so a rotated credential reaches
//      the next operation without a restart — capturing the service object once
//      would still be fine, but capturing the *value* would not, and the lazy
//      read makes that mistake impossible to write here.
//
// A failed seam call is reported with its own code and a bounded `cause` code.
// The provider's message is never forwarded: a credential backend is free to echo
// what it was given, and this is the one place in the plugin where that would be
// a disclosure.

/** Stable refusal codes for every credential operation. */
export const CREDENTIAL_CODES = Object.freeze({
  seamUnavailable: 'CREDENTIAL_SEAM_UNAVAILABLE',
  operationFailed: 'CREDENTIAL_OPERATION_FAILED',
  readOnly: 'CREDENTIAL_READ_ONLY',
  valueRequired: 'CREDENTIAL_VALUE_REQUIRED',
  valueTooLarge: 'CREDENTIAL_VALUE_TOO_LARGE',
  refInvalid: 'CREDENTIAL_REF_INVALID',
});

/** Bound on a pasted secret. A provider key is far shorter than this. */
export const MAX_CREDENTIAL_VALUE_CHARS = 8192;

/** A credential refusal with a stable machine code. */
export class CredentialSeamError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded, non-secret details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CredentialSeamError';
    this.code = code;
    this.details = details;
  }
}

/** Methods the seam must expose for this plugin to act at all. */
const REQUIRED_METHODS = Object.freeze({
  resolve: 'resolve',
  describe: 'describe',
  set: 'set',
  unset: 'unset',
});

/**
 * Create the credential gateway over one native service accessor.
 * @param {() => unknown} getService - returns the current `ctx.credentials`, or a
 *   nullish value while the service is absent.
 * @returns {{ available: () => boolean, describe: Function, resolve: Function, set: Function, unset: Function }} gateway.
 */
export function createCredentialGateway(getService) {
  if (typeof getService !== 'function') {
    throw new TypeError('createCredentialGateway needs a service accessor');
  }

  /**
   * Read the seam, refusing rather than returning null so a caller can never
   * mistake "no service" for "no credential".
   * @param {string} operation - seam method being attempted, for the refusal.
   * @returns {object} the native service.
   */
  function requireSeam(operation) {
    let service;
    try {
      service = getService();
    } catch (error) {
      // A host whose accessor throws is a refusal, not a crash inside a route.
      throw new CredentialSeamError(CREDENTIAL_CODES.seamUnavailable,
        'the DSH credential service could not be read in this harness',
        { operation, cause: typeof error?.code === 'string' ? error.code : null });
    }
    if (service === null || typeof service !== 'object') {
      throw new CredentialSeamError(CREDENTIAL_CODES.seamUnavailable,
        'this harness exposes no credential service; a pasted secret cannot be stored',
        { operation });
    }
    const method = REQUIRED_METHODS[operation];
    if (typeof service[method] !== 'function') {
      throw new CredentialSeamError(CREDENTIAL_CODES.seamUnavailable,
        `the credential service does not implement ${method}()`,
        { operation });
    }
    return service;
  }

  /**
   * Run one seam call, translating a provider failure into a bounded refusal.
   * @param {string} operation - seam method name.
   * @param {string} ref - credential reference, echoed as a name only.
   * @param {(service: object) => Promise<unknown>} work - the call.
   * @returns {Promise<unknown>} the seam result.
   */
  async function attempt(operation, ref, work) {
    const service = requireSeam(operation);
    try {
      return await work(service);
    } catch (error) {
      if (error instanceof CredentialSeamError) throw error;
      // Only the code survives: the message may quote the value or a path.
      throw new CredentialSeamError(CREDENTIAL_CODES.operationFailed,
        `the credential service refused ${operation}() for ${ref}`,
        { operation, reference: ref, cause: typeof error?.code === 'string' ? error.code : null });
    }
  }

  return {
    /**
     * Whether the seam is present at all, for status reporting.
     * @returns {boolean} true when `resolve` is callable.
     */
    available() {
      try {
        requireSeam('resolve');
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Presence/source/writability for one reference. The returned view has no
     * slot a value could ride in, and this function does not add one.
     * @param {string} ref - credential reference name.
     * @returns {Promise<{ configured: boolean, source?: string, writable: boolean }>} seam view.
     */
    async describe(ref) {
      const info = await attempt('describe', ref, (service) => service.describe(ref));
      if (info === null || typeof info !== 'object') {
        throw new CredentialSeamError(CREDENTIAL_CODES.operationFailed,
          `the credential service returned no usable description for ${ref}`,
          { operation: 'describe', reference: ref });
      }
      return {
        configured: info.configured === true,
        ...(typeof info.source === 'string' && info.source !== '' ? { source: info.source } : {}),
        writable: info.writable === true,
      };
    },

    /**
     * Resolve one reference to its current value. Called only by the native
     * adapter inside a stream operation; the value is returned to pi-ai and to
     * nothing else.
     * @param {string} ref - credential reference name.
     * @returns {Promise<{ value: string, source: string } | undefined>} value, or undefined.
     */
    async resolve(ref) {
      return await attempt('resolve', ref, (service) => service.resolve(ref));
    },

    /**
     * Store one pasted value. Refuses an empty value (that is `unset`) and a
     * value no provider key could be.
     * @param {string} ref - credential reference name.
     * @param {string} value - the literal secret.
     * @returns {Promise<void>} resolves after the seam committed the write.
     */
    async set(ref, value) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new CredentialSeamError(CREDENTIAL_CODES.valueRequired,
          'a credential value is required; use clear to remove one', { reference: ref });
      }
      if (value.length > MAX_CREDENTIAL_VALUE_CHARS) {
        throw new CredentialSeamError(CREDENTIAL_CODES.valueTooLarge,
          'the credential value exceeds the accepted bound',
          { reference: ref, limit: MAX_CREDENTIAL_VALUE_CHARS });
      }
      // The literal is not trimmed: a trailing space would be a different secret,
      // and silently altering what the operator pasted would be a hidden failure.
      await attempt('set', ref, (service) => service.set(ref, value));
    },

    /**
     * Remove one stored value. Removing an absent value is a no-op in the seam.
     * @param {string} ref - credential reference name.
     * @returns {Promise<void>} resolves after the seam committed the removal.
     */
    async unset(ref) {
      await attempt('unset', ref, (service) => service.unset(ref));
    },
  };
}
