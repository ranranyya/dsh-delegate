// Secret masking and structural redaction.
//
// One rule governs every public surface: a stored secret value never leaves the
// module that read it. Configuration surfaces, job history, MCP results and
// logs carry a masked marker at most.

/** Masked placeholder returned wherever a credential would otherwise appear. */
export const MASK = '••••••••';

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|secret|token|password|passwd|credential[_-]?value|authorization)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const KEYLIKE_PATTERN = /\b(sk|pk|ak)-[A-Za-z0-9_-]{16,}\b/g;
const ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi;

/**
 * Exact names of model usage counters. These keys contain the substring `token`,
 * so the secret-key pattern alone would mask every prompt/completion count and
 * publish nothing about what a run actually consumed.
 *
 * The exemption is deliberately an allow-list of exact names, not a `*Tokens`
 * suffix rule: a suffix rule would exempt `refreshTokens` and every future
 * credential field that happens to end in the same letters. The listed keys are
 * also only exempt for a finite non-negative number (see {@link isUsageCounter});
 * a string, object or array behind one of these names is still masked.
 */
const USAGE_COUNTER_KEYS = new Set([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'reasoningTokens',
  'cacheTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'reasoning_tokens',
  'cache_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
]);

/**
 * Whether a settings key names a secret that must be masked on the way out.
 * @param {string} key - object key.
 * @returns {boolean} true when the value behind this key is a secret.
 */
export function isSecretKey(key) {
  return typeof key === 'string' && SECRET_KEY_PATTERN.test(key);
}

/**
 * Whether a key/value pair is a usage counter that may be published as a number.
 * Requires both an exact counter name and a finite, non-negative number, so a
 * credential stored under a counter-shaped name is still masked.
 * @param {string} key - object key.
 * @param {unknown} value - value behind that key.
 * @returns {boolean} true when the value is a plain usage count.
 */
export function isUsageCounter(key, value) {
  if (typeof key !== 'string' || !USAGE_COUNTER_KEYS.has(key)) return false;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Mask a secret for display. Short values are fully masked so a mask never
 * leaks length or a prefix of a real credential.
 * @param {string} value - secret value.
 * @returns {string} masked marker.
 */
export function maskSecret(value) {
  if (typeof value !== 'string' || value === '') return '';
  return MASK;
}

/**
 * Replace credential-looking text inside free-form output (diff, model text,
 * diagnostics). This is a safety net for values we never intended to see, not a
 * substitute for not reading them.
 * @param {string} text - untrusted text.
 * @returns {string} text with credential-shaped substrings replaced.
 */
export function redactText(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(BEARER_PATTERN, `Bearer ${MASK}`)
    .replace(KEYLIKE_PATTERN, MASK)
    .replace(ASSIGNMENT_PATTERN, (_match, name) => `${name}=${MASK}`);
}

/**
 * Deep-redact a JSON-compatible value: secret-named keys become the mask and
 * every string is passed through {@link redactText}.
 *
 * The one exemption is a genuine model usage counter (exact known name plus a
 * finite non-negative number), so a job record can report what it consumed
 * instead of a wall of masks.
 * @param {unknown} value - value to project.
 * @param {number} [depth] - remaining recursion depth.
 * @returns {unknown} redacted copy.
 */
export function redactDeep(value, depth = 0) {
  if (depth > 12) return '[depth-limit]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (isUsageCounter(key, item)) {
        out[key] = item;
        continue;
      }
      if (isSecretKey(key) && item !== null && item !== undefined && item !== '') {
        out[key] = typeof item === 'string' ? maskSecret(item) : MASK;
        continue;
      }
      out[key] = redactDeep(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Truncate and redact a diagnostic string for durable storage.
 *
 * This lives here, beside {@link redactText}, rather than in the agent runner
 * that first needed it: it is a pure string transform with no harness
 * dependency, and the stdio MCP executable imports it too. Leaving it in
 * `runtime/agent-runner.js` forced that standalone process to statically import
 * `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-agent` — packages only the DSH
 * runtime provides — so the executable died with `ERR_MODULE_NOT_FOUND` before
 * it could even report a missing token.
 * @param {unknown} value - raw error text.
 * @param {number} [max] - character bound.
 * @returns {string | null} redacted text, or null.
 */
export function diagnostic(value, max = 800) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : String(value);
  if (text === '') return null;
  return redactText(text.slice(0, max));
}

const SENSITIVE_SUFFIXES = ['.pem', '.key', '.pfx', '.p12'];
const SENSITIVE_PREFIXES = ['credentials', 'secret', 'id_rsa', 'id_ed25519'];
const ENV_BASENAME = '.env';

/**
 * Whether a workspace path names credential material whose content must never
 * be captured into a diff or evidence bundle. The path itself stays visible as
 * a changed file; only its content is withheld.
 * @param {string} relPath - workspace-relative path.
 * @returns {boolean} true when content must be withheld.
 */
export function isSensitivePath(relPath) {
  const segments = String(relPath ?? '').replace(/\\/g, '/').split('/');
  return segments.some((raw) => {
    const seg = raw.toLowerCase();
    if (seg === ENV_BASENAME || seg.startsWith(`${ENV_BASENAME}.`)) return true;
    if (SENSITIVE_PREFIXES.some((prefix) => seg.startsWith(prefix))) return true;
    return SENSITIVE_SUFFIXES.some((suffix) => seg.endsWith(suffix));
  });
}
