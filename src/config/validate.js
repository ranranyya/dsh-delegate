// Settings validation.
//
// Every accepted document is normalized into a closed shape: unknown keys are
// dropped rather than stored, and every persisted field passed exactly one
// documented check. Validation is the only place that decides whether a
// provider/model/effort combination is legal, so an unsupported combination has
// one refusal point instead of being silently ignored later.

import { posix, win32 } from 'node:path';

import {
  CONVERSATION_MODES,
  DEFAULT_CONVERSATION_MODE,
  DEFAULT_ISOLATION,
  EFFORT_ORDER,
  ISOLATION_MODES,
  KNOWN_EFFORTS,
  LIMITS,
  SCHEMA_VERSION,
  SUPPORTED_PROTOCOLS,
  defaultSettings,
} from './defaults.js';

/** A validation refusal with a stable machine code. */
export class ConfigError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   * @param {object} [details] - bounded, non-secret details.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.details = details;
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Provider-profile keys that may only ever carry a credential *reference*.
 * A profile carrying one of these is refused instead of having it dropped, so an
 * operator who pasted a key learns immediately that it was not stored.
 */
const PROVIDER_SECRET_KEYS = Object.freeze([
  'apiKey',
  'api_key',
  'apikey',
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'bearer',
  'headers',
]);

function requireString(value, code, field, { max = 200, pattern = null, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw new ConfigError(code, `${field} must be a string`, { field });
  const trimmed = value.trim();
  if (!allowEmpty && trimmed === '') throw new ConfigError(code, `${field} must not be empty`, { field });
  if (trimmed.length > max) throw new ConfigError(code, `${field} exceeds ${max} characters`, { field });
  if (pattern !== null && !pattern.test(trimmed)) throw new ConfigError(code, `${field} has an unsupported format`, { field });
  return trimmed;
}

function requireInt(value, code, field, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ConfigError(code, `${field} must be an integer`, { field });
  }
  if (value < min || value > max) {
    throw new ConfigError(code, `${field} must be between ${min} and ${max}`, { field, min, max });
  }
  return value;
}

function requireBool(value, code, field) {
  if (typeof value !== 'boolean') throw new ConfigError(code, `${field} must be a boolean`, { field });
  return value;
}

function optionalString(value, code, field, options) {
  if (value === null || value === undefined) return null;
  return requireString(value, code, field, options);
}

/** Whether a raw path string is a Windows-style absolute path (drive or UNC). */
const WINDOWS_STYLE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function stripTrailingSeparators(candidate, pathImpl) {
  let out = candidate;
  const { root } = pathImpl.parse(candidate);
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/**
 * Canonicalize one absolute project path.
 *
 * One canonical form is used by validation, by every settings mutation and by
 * lookup when a job composes its effective configuration, so `C:/Work/Proj/`,
 * `c:\work\proj` and `C:\Work\Proj` are the same project key instead of three
 * overrides that only one of which ever applies.
 *
 * Rules:
 *  - the input must be absolute (a relative key is refused, never resolved
 *    against the plugin's own cwd, which would silently pick a different project);
 *  - separators are normalized to the path style's native separator and `.`/`..`
 *    are collapsed, with a trailing separator removed except at a filesystem root;
 *  - Windows-style paths (and any path on Windows) are case-folded for the key,
 *    because NTFS compares case-insensitively while a JSON object key does not.
 * @param {string} projectPath - absolute project path.
 * @param {string} [field] - field name for refusals.
 * @returns {{ key: string, display: string }} canonical lookup key and normalized display form.
 */
export function canonicalProjectKey(projectPath, field = 'projectPath') {
  const raw = requireString(projectPath, 'PROJECT_OVERRIDE_INVALID', field, { max: 1024 });
  const windowsStyle = WINDOWS_STYLE.test(raw);
  const pathImpl = windowsStyle ? win32 : posix;
  if (!pathImpl.isAbsolute(raw)) {
    throw new ConfigError('PROJECT_OVERRIDE_INVALID', `${field} must be an absolute path`, { field });
  }
  const display = stripTrailingSeparators(pathImpl.normalize(raw), pathImpl);
  const foldCase = windowsStyle || process.platform === 'win32';
  return { key: foldCase ? display.toLowerCase() : display, display };
}

/**
 * Validate one `http(s)` base URL.
 *
 * A base URL is persisted in the settings document and can be exported, so it is
 * an endpoint *without* anything that could carry a secret: no `user:password@`
 * authority (the classic way a key ends up inside a URL) and no query or fragment
 * at all, including a bare `?` or `#` — those are exactly where an SDK would
 * append an `api_key=…` parameter. Plaintext loopback is allowed because the
 * shipped relay runs there; anything else must be `https`.
 * @param {unknown} value - candidate base URL.
 * @param {string} field - field name for the refusal.
 * @returns {string} normalized base URL without a trailing slash, query or fragment.
 */
export function validateBaseUrl(value, field = 'baseUrl') {
  const raw = requireString(value, 'PROVIDER_BASE_URL_INVALID', field, { max: 2048 });
  if (raw.includes('?') || raw.includes('#')) {
    throw new ConfigError('PROVIDER_BASE_URL_INVALID', `${field} must not contain a query or fragment`, { field });
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError('PROVIDER_BASE_URL_INVALID', `${field} is not a valid URL`, { field });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('PROVIDER_BASE_URL_INVALID', `${field} must use http or https`, { field });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigError('PROVIDER_BASE_URL_INVALID', `${field} must not embed credentials`, { field });
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    // Defence in depth: a URL implementation that keeps a query would persist it.
    throw new ConfigError('PROVIDER_BASE_URL_INVALID', `${field} must not contain a query or fragment`, { field });
  }
  if (parsed.hostname === '') {
    throw new ConfigError('PROVIDER_BASE_URL_INVALID', `${field} must name a host`, { field });
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * Validate a credential reference. A reference is an environment-variable-style
 * name resolved through the native credential seam; a value is never accepted
 * here because this module is not allowed to hold secrets.
 * @param {unknown} value - candidate reference.
 * @returns {string} the reference name.
 */
export function validateCredentialRef(value) {
  return requireString(value, 'PROVIDER_CREDENTIAL_REF_INVALID', 'credentialRef', {
    max: 128,
    pattern: CREDENTIAL_REF_PATTERN,
  });
}

/**
 * Normalize a model's declared reasoning-effort list.
 *
 * The declaration is the *only* authority on what a model supports: an id that
 * this build does not know is refused outright (it would be sent to a provider
 * that may ignore or reject it), and the accepted ids are sorted into the
 * canonical weakest-to-strongest order so a UI renders a stable list.
 * @param {unknown} value - candidate `efforts` array.
 * @param {string} modelId - model id for refusals.
 * @returns {string[]} canonical effort ids.
 */
function normalizeDeclaredEfforts(value, modelId, { native = false } = {}) {
  const raw = value ?? [];
  if (!Array.isArray(raw)) throw new ConfigError('MODEL_EFFORTS_INVALID', 'model.efforts must be a list', { model: modelId });
  if (raw.length > (native ? 64 : KNOWN_EFFORTS.length)) {
    throw new ConfigError('MODEL_EFFORTS_INVALID', 'model.efforts declares more efforts than exist', { model: modelId });
  }
  const efforts = [];
  for (const effort of raw) {
    if (typeof effort !== 'string' || effort.length > 80 || effort.trim() !== effort || effort === ''
      || (!native && !KNOWN_EFFORTS.includes(effort))) {
      throw new ConfigError('MODEL_EFFORTS_INVALID', `unsupported reasoning effort ${JSON.stringify(effort)}`, {
        model: modelId,
        supported: [...KNOWN_EFFORTS],
      });
    }
    if (!efforts.includes(effort)) efforts.push(effort);
  }
  return native
    ? efforts
    : efforts.sort((a, b) => EFFORT_ORDER.get(a) - EFFORT_ORDER.get(b));
}

/**
 * Validate one declared model entry, including its effort capability list.
 * @param {unknown} value - candidate model declaration.
 * @returns {{ id: string, efforts: string[], contextWindow: number | null }} normalized entry.
 */
export function validateModelDeclaration(value, options = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('MODEL_INVALID', 'model declaration must be an object', {});
  }
  const id = requireString(value.id, 'MODEL_INVALID', 'model.id', { max: 160 });
  const efforts = normalizeDeclaredEfforts(value.efforts, id, options);
  const contextWindow = value.contextWindow === undefined || value.contextWindow === null
    ? null
    : requireInt(value.contextWindow, 'MODEL_INVALID', 'model.contextWindow', 1024, 10_000_000);
  return { id, efforts, contextWindow };
}

/**
 * Validate one provider profile.
 * @param {unknown} value - candidate profile.
 * @returns {object} normalized provider profile (never containing a secret value).
 */
export function validateProviderProfile(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('PROVIDER_INVALID', 'provider profile must be an object', {});
  }
  const id = requireString(value.id, 'PROVIDER_ID_INVALID', 'provider.id', { max: 160, pattern: PROVIDER_ID_PATTERN });
  const name = requireString(value.name, 'PROVIDER_NAME_INVALID', 'provider.name', { max: 80 });
  const source = value.source ?? 'custom';
  if (source !== 'native' && source !== 'custom') {
    throw new ConfigError('PROVIDER_SOURCE_UNSUPPORTED', 'provider.source is unsupported', { id });
  }
  for (const key of PROVIDER_SECRET_KEYS) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null || candidate === '') continue;
    // A secret value must enter through the credential seam, never through a
    // settings document that is exported, logged and packaged.
    throw new ConfigError('PROVIDER_SECRET_IN_SETTINGS', `provider ${key} is a secret; use credentialRef`, { id });
  }
  const rawModels = value.models ?? [];
  if (!Array.isArray(rawModels)) throw new ConfigError('MODEL_INVALID', 'provider.models must be a list', { id });
  if (rawModels.length > LIMITS.manualModelsPerProvider) {
    throw new ConfigError('MODEL_INVALID', `provider.models exceeds ${LIMITS.manualModelsPerProvider} entries`, { id });
  }
  const models = rawModels.map((entry) => validateModelDeclaration(entry, { native: source === 'native' }));
  const seen = new Set();
  for (const model of models) {
    if (seen.has(model.id)) throw new ConfigError('MODEL_DUPLICATE', `duplicate model id ${model.id}`, { id });
    seen.add(model.id);
  }
  if (source === 'native') {
    return { id, name, source, protocol: null, baseUrl: null, credentialRef: null, models };
  }
  const protocol = requireString(value.protocol ?? 'openai-chat', 'PROVIDER_PROTOCOL_UNSUPPORTED', 'provider.protocol', { max: 40 });
  if (!SUPPORTED_PROTOCOLS.includes(protocol)) {
    throw new ConfigError('PROVIDER_PROTOCOL_UNSUPPORTED', `protocol ${protocol} is not supported by this stage`, {
      protocol,
      supported: [...SUPPORTED_PROTOCOLS],
    });
  }
  const baseUrl = validateBaseUrl(value.baseUrl, 'provider.baseUrl');
  const credentialRef = value.credentialRef === null || value.credentialRef === undefined
    ? null
    : validateCredentialRef(value.credentialRef);
  return { id, name, source, protocol, baseUrl, credentialRef, models };
}

/**
 * Validate a provider list and enforce unique ids.
 * @param {unknown} value - candidate list.
 * @returns {object[]} normalized providers.
 */
export function validateProviders(value) {
  if (!Array.isArray(value)) throw new ConfigError('PROVIDER_INVALID', 'providers must be a list', {});
  if (value.length > LIMITS.providers) {
    throw new ConfigError('PROVIDER_INVALID', `providers exceeds ${LIMITS.providers} entries`, {});
  }
  const providers = value.map(validateProviderProfile);
  const seen = new Set();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new ConfigError('PROVIDER_DUPLICATE', `duplicate provider id ${provider.id}`, { id: provider.id });
    seen.add(provider.id);
  }
  return providers;
}

/**
 * Validate an execution-selection triple against a provider list.
 *
 * This is the single decision point for "is this provider/model/effort
 * combination real". It never substitutes another model or effort for the one
 * requested: an unknown provider, an undeclared model, an effort id this build
 * does not know, or an effort the model does not declare is a refusal.
 * @param {{ providerId: unknown, model: unknown, reasoningEffort: unknown }} selection - requested triple.
 * @param {object[]} providers - validated provider list.
 * @param {string} field - field prefix for refusals.
 * @returns {{ providerId: string, model: string, reasoningEffort: string | null, provider: object, modelEntry: object }} resolved triple.
 */
export function validateSelection(selection, providers, field = 'selection') {
  const providerId = requireString(selection?.providerId, 'SELECTION_PROVIDER_REQUIRED', `${field}.providerId`, { max: 160, pattern: PROVIDER_ID_PATTERN });
  const provider = providers.find((entry) => entry.id === providerId);
  if (provider === undefined) {
    throw new ConfigError('SELECTION_PROVIDER_UNKNOWN', `provider ${providerId} is not configured`, { providerId });
  }
  const model = requireString(selection?.model, 'SELECTION_MODEL_REQUIRED', `${field}.model`, { max: 160 });
  const modelEntry = provider.models.find((entry) => entry.id === model);
  if (modelEntry === undefined) {
    throw new ConfigError('SELECTION_MODEL_UNKNOWN', `model ${model} is not declared for provider ${providerId}`, { providerId, model });
  }
  const requested = selection?.reasoningEffort ?? null;
  if (requested === null) {
    return { providerId, model, reasoningEffort: null, provider, modelEntry };
  }
  if (typeof requested !== 'string' || requested === '' || requested.length > 80 || requested.trim() !== requested) {
    throw new ConfigError('SELECTION_EFFORT_UNKNOWN', `reasoning effort ${JSON.stringify(requested)} does not exist`, {
      providerId,
      model,
      supported: [...modelEntry.efforts],
    });
  }
  if (!modelEntry.efforts.includes(requested)) {
    throw new ConfigError('SELECTION_EFFORT_UNSUPPORTED', `model ${model} does not support reasoning effort ${requested}`, {
      providerId,
      model,
      requested,
      supported: [...modelEntry.efforts],
    });
  }
  return { providerId, model, reasoningEffort: requested, provider, modelEntry };
}

function validateIsolation(value, code, field) {
  const isolation = requireString(value ?? DEFAULT_ISOLATION, code, field, { max: 16 });
  if (!ISOLATION_MODES.includes(isolation)) {
    throw new ConfigError(code, `isolation ${isolation} is not supported`, { field, isolation, supported: [...ISOLATION_MODES] });
  }
  return isolation;
}

/**
 * Validate the worker execution settings block.
 * @param {unknown} value - candidate worker block.
 * @param {object[]} providers - validated providers.
 * @returns {object} normalized worker block.
 */
export function validateWorkerSettings(value, providers) {
  const source = value ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new ConfigError('WORKER_INVALID', 'worker settings must be an object', {});
  }
  const selection = validateSelection(source, providers, 'worker');
  const timeoutSeconds = requireInt(
    source.timeoutSeconds ?? 1800,
    'WORKER_TIMEOUT_INVALID',
    'worker.timeoutSeconds',
    LIMITS.timeoutSecondsMin,
    LIMITS.timeoutSecondsMax,
  );
  const maxParallelism = requireInt(
    source.maxParallelism ?? 1,
    'WORKER_PARALLELISM_INVALID',
    'worker.maxParallelism',
    LIMITS.maxParallelismMin,
    LIMITS.maxParallelismMax,
  );
  // Isolation is a decision, not a fallback: an absent value is the documented
  // default (worktree) and `shared` must be stated by the operator.
  const isolation = validateIsolation(source.isolation, 'WORKER_ISOLATION_INVALID', 'worker.isolation');
  return {
    providerId: selection.providerId,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
    timeoutSeconds,
    maxParallelism,
    isolation,
  };
}

/**
 * Validate the additional-review block. Review is off unless explicitly enabled
 * and it owns a fully separate provider/model/effort triple.
 * @param {unknown} value - candidate review block.
 * @param {object[]} providers - validated providers.
 * @returns {object} normalized review block.
 */
export function validateReviewSettings(value, providers) {
  const source = value ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new ConfigError('REVIEW_INVALID', 'review settings must be an object', {});
  }
  const enabled = requireBool(source.enabled ?? false, 'REVIEW_INVALID', 'review.enabled');
  if (!enabled) {
    return { enabled: false, providerId: null, model: null, reasoningEffort: null };
  }
  const selection = validateSelection(source, providers, 'review');
  return {
    enabled: true,
    providerId: selection.providerId,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
  };
}

/** Validate legacy grant TTLs kept for backwards-compatible imports. */
export function validateAuthorizationSettings(value) {
  const source = value ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new ConfigError('AUTHORIZATION_INVALID', 'authorization settings must be an object', {});
  }
  return {
    taskGrantTtlSeconds: requireInt(source.taskGrantTtlSeconds ?? 900, 'AUTHORIZATION_INVALID', 'authorization.taskGrantTtlSeconds', LIMITS.taskGrantTtlSecondsMin, LIMITS.taskGrantTtlSecondsMax),
    sessionGrantTtlSeconds: requireInt(source.sessionGrantTtlSeconds ?? 4 * 60 * 60, 'AUTHORIZATION_INVALID', 'authorization.sessionGrantTtlSeconds', LIMITS.sessionGrantTtlSecondsMin, LIMITS.sessionGrantTtlSecondsMax),
  };
}

/**
 * Validate bounded per-job overrides.
 *
 * An override is a *patch*, not a complete selection: naming only
 * `reasoningEffort` is legitimate because the provider and model come from the
 * layer beneath. Each present field is therefore validated on its own, and the
 * composed triple is validated again after merging (in `resolveEffectiveConfig`),
 * which is where an incomplete or inconsistent combination is actually caught.
 * @param {unknown} value - candidate override block.
 * @param {object[]} providers - validated providers.
 * @returns {object} normalized override block (only present keys).
 */
export function validateJobOverrides(value, providers) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('OVERRIDE_INVALID', 'job overrides must be an object', {});
  }
  const allowed = new Set(['providerId', 'model', 'reasoningEffort', 'timeoutSeconds', 'isolation']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConfigError('OVERRIDE_INVALID', `job override ${key} is not allowed`, { field: key });
    }
  }
  const out = {};
  if (value.providerId !== undefined) {
    const providerId = requireString(value.providerId, 'SELECTION_PROVIDER_REQUIRED', 'override.providerId', {
      max: 160,
      pattern: PROVIDER_ID_PATTERN,
    });
    if (!providers.some((entry) => entry.id === providerId)) {
      throw new ConfigError('SELECTION_PROVIDER_UNKNOWN', `provider ${providerId} is not configured`, { providerId });
    }
    out.providerId = providerId;
  }
  if (value.model !== undefined) {
    out.model = requireString(value.model, 'SELECTION_MODEL_REQUIRED', 'override.model', { max: 160 });
  }
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null) {
    const effort = value.reasoningEffort;
    if (typeof effort !== 'string' || effort === '' || effort.length > 80 || effort.trim() !== effort) {
      throw new ConfigError('SELECTION_EFFORT_UNKNOWN', `reasoning effort ${JSON.stringify(effort)} does not exist`, {
        supported: [...KNOWN_EFFORTS],
      });
    }
    out.reasoningEffort = effort;
  } else if (value.reasoningEffort === null) {
    // An explicit null clears an inherited effort; it is not the same as omitting
    // the key, which leaves the lower layer's effort in place.
    out.reasoningEffort = null;
  }
  if (value.timeoutSeconds !== undefined) {
    out.timeoutSeconds = requireInt(
      value.timeoutSeconds,
      'WORKER_TIMEOUT_INVALID',
      'override.timeoutSeconds',
      LIMITS.timeoutSecondsMin,
      LIMITS.timeoutSecondsMax,
    );
  }
  if (value.isolation !== undefined) {
    out.isolation = validateIsolation(value.isolation, 'WORKER_ISOLATION_INVALID', 'override.isolation');
  }
  return out;
}

/**
 * Validate one project override entry keyed by an absolute project path.
 * @param {unknown} value - candidate project block.
 * @param {object[]} providers - validated providers.
 * @returns {object} normalized project block.
 */
export function validateProjectOverride(value, providers) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('PROJECT_OVERRIDE_INVALID', 'project override must be an object', {});
  }
  const out = {};
  if (value.worker !== undefined) out.worker = validateWorkerSettings(value.worker, providers);
  if (value.review !== undefined) out.review = validateReviewSettings(value.review, providers);
  return out;
}

/**
 * Validate the conversation block.
 *
 * The mode is a closed vocabulary with one documented default. An absent block
 * (every document written before this field existed) resolves to `new`; an
 * unrecognized value is refused rather than mapped onto a default, because
 * "resume the previous conversation" is exactly the kind of behaviour an
 * operator must not get by accident.
 * @param {unknown} value - candidate conversation block.
 * @returns {{ mode: string }} normalized block.
 */
export function validateConversationSettings(value) {
  const source = value ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new ConfigError('CONVERSATION_INVALID', 'conversation settings must be an object', {});
  }
  const mode = requireString(
    source.mode ?? DEFAULT_CONVERSATION_MODE,
    'CONVERSATION_MODE_UNSUPPORTED',
    'conversation.mode',
    { max: 16 },
  );
  if (!CONVERSATION_MODES.includes(mode)) {
    throw new ConfigError('CONVERSATION_MODE_UNSUPPORTED', `conversation mode ${mode} is not supported`, {
      field: 'conversation.mode',
      mode,
      supported: [...CONVERSATION_MODES],
    });
  }
  return { mode };
}

/**
 * Validate the project-override map, canonicalizing every key.
 *
 * Two spellings of one project (`C:/work/p` and `c:\WORK\p`) would otherwise be
 * two independent overrides of which only the lookup spelling ever applies, so a
 * duplicate canonical key is refused rather than silently merged.
 * @param {unknown} value - candidate `projectOverrides` map.
 * @param {object[]} providers - validated providers.
 * @returns {Record<string, object>} map keyed by canonical display path.
 */
export function validateProjectOverrides(value, providers) {
  const raw = value ?? {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('PROJECT_OVERRIDE_INVALID', 'projectOverrides must be an object', {});
  }
  const out = {};
  const seen = new Map();
  for (const [projectPath, block] of Object.entries(raw)) {
    const { key, display } = canonicalProjectKey(projectPath, 'projectOverrides key');
    const existing = seen.get(key);
    if (existing !== undefined) {
      throw new ConfigError('PROJECT_OVERRIDE_DUPLICATE', 'two project overrides name the same project', {
        key,
        paths: [existing, display],
      });
    }
    seen.set(key, display);
    out[display] = validateProjectOverride(block, providers);
  }
  return out;
}

/**
 * Validate one named preset: a reusable, entirely non-secret worker/review
 * combination. Both blocks are validated against the same provider list as live
 * settings, so a preset can never store a combination that settings would refuse.
 * @param {unknown} value - candidate preset.
 * @param {object[]} providers - validated providers.
 * @returns {{ id: string, name: string, worker: object | null, review: object | null }} normalized preset.
 */
export function validatePreset(value, providers) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('PRESET_INVALID', 'preset must be an object', {});
  }
  const id = requireString(value.id, 'PRESET_INVALID', 'preset.id', { max: 40, pattern: ID_PATTERN });
  const name = requireString(value.name ?? id, 'PRESET_INVALID', 'preset.name', { max: 80 });
  if (value.worker === undefined && value.review === undefined) {
    throw new ConfigError('PRESET_INVALID', 'preset must contain worker or review settings', { id });
  }
  return {
    id,
    name,
    worker: value.worker === undefined ? null : validateWorkerSettings(value.worker, providers),
    review: value.review === undefined ? null : validateReviewSettings(value.review, providers),
  };
}

/**
 * Validate the preset list (backward compatible: a document without presets has
 * none). A preset only refers to providers by id, so it holds no endpoint,
 * credential reference or secret.
 * @param {unknown} value - candidate `presets` array.
 * @param {object[]} providers - validated providers.
 * @returns {object[]} normalized presets.
 */
export function validatePresets(value, providers) {
  const raw = value ?? [];
  if (!Array.isArray(raw)) throw new ConfigError('PRESET_INVALID', 'presets must be a list', {});
  if (raw.length > LIMITS.presets) {
    throw new ConfigError('PRESET_INVALID', `presets exceeds ${LIMITS.presets} entries`, {});
  }
  const presets = raw.map((entry) => validatePreset(entry, providers));
  const seen = new Set();
  for (const preset of presets) {
    if (seen.has(preset.id)) throw new ConfigError('PRESET_DUPLICATE', `duplicate preset id ${preset.id}`, { id: preset.id });
    seen.add(preset.id);
  }
  return presets;
}

/**
 * Whether a settings block simply has no provider chosen yet.
 * @param {unknown} value - candidate block.
 * @returns {boolean} true when the block stores "not configured".
 */
function isUnconfiguredSelection(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const enabled = value.enabled;
  if (enabled === true) return false;
  return (value.providerId ?? null) === null;
}

/**
 * Validate and normalize a complete settings document.
 * @param {unknown} value - parsed document.
 * @param {object} [options] - `options.requireProviders` refuses an empty list.
 * @returns {object} normalized settings.
 */
export function validateSettings(value, options = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('SETTINGS_INVALID', 'settings document must be an object', {});
  }
  const schemaVersion = value.schemaVersion ?? SCHEMA_VERSION;
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new ConfigError('SETTINGS_SCHEMA_UNSUPPORTED', `unsupported settings schemaVersion ${String(schemaVersion)}`, {
      expected: SCHEMA_VERSION,
      found: schemaVersion,
    });
  }
  const providers = validateProviders(value.providers ?? []);

  // An unconfigured selection (no provider chosen yet) is legal to STORE, so a
  // fresh install can add its first provider before choosing a worker. It is
  // never legal to RUN: resolveEffectiveConfig refuses it, which keeps the
  // refusal at the job boundary instead of at every settings edit.
  const worker = isUnconfiguredSelection(value.worker)
    ? defaultSettings().worker
    : validateWorkerSettings(value.worker ?? {}, providers);
  const review = isUnconfiguredSelection(value.review)
    ? defaultSettings().review
    : validateReviewSettings(value.review ?? {}, providers);

  if (options.requireProviders === true && providers.length === 0) {
    throw new ConfigError('SETTINGS_NO_PROVIDERS', 'no provider profile is configured', {});
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    delegationEnabled: requireBool(value.delegationEnabled ?? false, 'SETTINGS_INVALID', 'delegationEnabled'),
    providers,
    worker,
    review,
    authorization: validateAuthorizationSettings(value.authorization),
    projectOverrides: validateProjectOverrides(value.projectOverrides, providers),
    presets: validatePresets(value.presets, providers),
    conversation: validateConversationSettings(value.conversation),
  };
}
