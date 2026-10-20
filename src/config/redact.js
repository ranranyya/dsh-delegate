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
 * Whether a settings key names a secret that must be masked on the way out.
 * @param {string} key - object key.
 * @returns {boolean} true when the value behind this key is a secret.
 */
export function isSecretKey(key) {
  return typeof key === 'string' && SECRET_KEY_PATTERN.test(key);
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
