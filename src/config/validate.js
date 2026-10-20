// Settings validation.
//
// Every accepted document is normalized into a closed shape: unknown keys are
// dropped rather than stored, and every persisted field passed exactly one
// documented check. Validation is the only place that decides whether a
// provider/model/effort combination is legal, so an unsupported combination has
// one refusal point instead of being silently ignored later.

import {
  ISOLATION_MODES,
  LIMITS,
  KNOWN_EFFORTS,
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
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/**
 * Validate one `http(s)` base URL. Loopback plaintext is allowed because the
 * shipped relay runs there; anything else must not silently downgrade.
 * @param {unknown} value - candidate base URL.
 * @param {string} field - field name for the refusal.
 * @returns {string} normalized base URL without a trailing slash.
 */
export function validateBaseUrl(value, field = 'baseUrl') {
  const raw = requireString(value, 'PROVIDER_BASE_URL_INVALID', field, { max: 2048 });
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
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
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
 * Validate one declared model entry, including its effort capability list.
 * @param {unknown} value - candidate model declaration.
 * @returns {{ id: string, efforts: string[], contextWindow: number | null }} normalized entry.
 */
export function validateModelDeclaration(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('MODEL_INVALID', 'model declaration must be an object', {});
  }
  const id = requireString(value.id, 'MODEL_INVALID', 'model.id', { max: 160 });
  const rawEfforts = value.efforts ?? [];
  if (!Array.isArray(rawEfforts)) throw new ConfigError('MODEL_EFFORTS_INVALID', 'model.efforts must be a list', { model: id });
  if (rawEfforts.length > KNOWN_EFFORTS.length) {
    throw new ConfigError('MODEL_EFFORTS_INVALID', 'model.efforts declares more efforts than exist', { model: id });
  }
  const efforts = [];
  for (const effort of rawEfforts) {
    if (typeof effort !== 'string' || !KNOWN_EFFORTS.includes(effort)) {
      throw new ConfigError('MODEL_EFFORTS_INVALID', `unsupported reasoning effort ${JSON.stringify(effort)}`, { model: id });
    }
    if (!efforts.includes(effort)) efforts.push(effort);
  }
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
  const id = requireString(value.id, 'PROVIDER_ID_INVALID', 'provider.id', { max: 40, pattern: ID_PATTERN });
  const name = requireString(value.name, 'PROVIDER_NAME_INVALID', 'provider.name', { max: 80 });
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
  if (value.apiKey !== undefined && value.apiKey !== null && value.apiKey !== '') {
    // A secret value must enter through the credential seam, never through a
    // settings document that is exported, logged and packaged.
    throw new ConfigError('PROVIDER_SECRET_IN_SETTINGS', 'provider secrets are stored through the credential seam, not in settings', { id });
  }
  const rawModels = value.models ?? [];
  if (!Array.isArray(rawModels)) throw new ConfigError('MODEL_INVALID', 'provider.models must be a list', { id });
  if (rawModels.length > LIMITS.manualModelsPerProvider) {
    throw new ConfigError('MODEL_INVALID', `provider.models exceeds ${LIMITS.manualModelsPerProvider} entries`, { id });
  }
  const models = rawModels.map(validateModelDeclaration);
  const seen = new Set();
  for (const model of models) {
    if (seen.has(model.id)) throw new ConfigError('MODEL_DUPLICATE', `duplicate model id ${model.id}`, { id });
    seen.add(model.id);
  }
  return { id, name, protocol, baseUrl, credentialRef, models };
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
 * requested: an unknown provider, an undeclared model, or an effort the model
 * does not declare is a refusal.
 * @param {{ providerId: unknown, model: unknown, reasoningEffort: unknown }} selection - requested triple.
 * @param {object[]} providers - validated provider list.
 * @param {string} field - field prefix for refusals.
 * @returns {{ providerId: string, model: string, reasoningEffort: string | null, provider: object, modelEntry: object }} resolved triple.
 */
export function validateSelection(selection, providers, field = 'selection') {
  const providerId = requireString(selection?.providerId, 'SELECTION_PROVIDER_REQUIRED', `${field}.providerId`, { max: 40, pattern: ID_PATTERN });
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
  if (typeof requested !== 'string' || !KNOWN_EFFORTS.includes(requested)) {
    throw new ConfigError('SELECTION_EFFORT_UNKNOWN', `reasoning effort ${JSON.stringify(requested)} does not exist`, { providerId, model });
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
  const isolation = requireString(source.isolation ?? 'shared', 'WORKER_ISOLATION_INVALID', 'worker.isolation', { max: 16 });
  if (!ISOLATION_MODES.includes(isolation)) {
    throw new ConfigError('WORKER_ISOLATION_INVALID', `isolation ${isolation} is not supported`, { isolation, supported: [...ISOLATION_MODES] });
  }
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

/**
 * Validate the authorization TTL block.
 * @param {unknown} value - candidate authorization block.
 * @returns {object} normalized authorization block.
 */
export function validateAuthorizationSettings(value) {
  const source = value ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new ConfigError('AUTHORIZATION_INVALID', 'authorization settings must be an object', {});
  }
  return {
    taskGrantTtlSeconds: requireInt(
      source.taskGrantTtlSeconds ?? 900,
      'AUTHORIZATION_INVALID',
      'authorization.taskGrantTtlSeconds',
      LIMITS.taskGrantTtlSecondsMin,
      LIMITS.taskGrantTtlSecondsMax,
    ),
    sessionGrantTtlSeconds: requireInt(
      source.sessionGrantTtlSeconds ?? 4 * 60 * 60,
      'AUTHORIZATION_INVALID',
      'authorization.sessionGrantTtlSeconds',
      LIMITS.sessionGrantTtlSecondsMin,
      LIMITS.sessionGrantTtlSecondsMax,
    ),
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
      max: 40,
      pattern: ID_PATTERN,
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
    if (typeof effort !== 'string' || !KNOWN_EFFORTS.includes(effort)) {
      throw new ConfigError('SELECTION_EFFORT_UNKNOWN', `reasoning effort ${JSON.stringify(effort)} does not exist`, {});
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
    const isolation = requireString(value.isolation, 'WORKER_ISOLATION_INVALID', 'override.isolation', { max: 16 });
    if (!ISOLATION_MODES.includes(isolation)) {
      throw new ConfigError('WORKER_ISOLATION_INVALID', `isolation ${isolation} is not supported`, { isolation });
    }
    out.isolation = isolation;
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

  const rawProjects = value.projectOverrides ?? {};
  if (rawProjects === null || typeof rawProjects !== 'object' || Array.isArray(rawProjects)) {
    throw new ConfigError('PROJECT_OVERRIDE_INVALID', 'projectOverrides must be an object', {});
  }
  const projectOverrides = {};
  for (const [projectPath, block] of Object.entries(rawProjects)) {
    if (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath)) {
      throw new ConfigError('PROJECT_OVERRIDE_INVALID', 'project override keys must be absolute paths', { path: projectPath });
    }
    projectOverrides[projectPath] = validateProjectOverride(block, providers);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    providers,
    worker,
    review,
    authorization: validateAuthorizationSettings(value.authorization),
    projectOverrides,
  };
}
