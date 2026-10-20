// Settings service: the one authority on validated configuration and on the
// effective snapshot a job runs under.
//
// Three layers compose here â€?global, project, per-job â€?and they compose in a
// fixed order with no implicit source beneath them. A missing provider is a
// refusal, never a substitution of a harness default, so an operator can always
// tell which model spent their tokens.

import { SETTINGS_FILE, SCHEMA_VERSION, defaultSettings } from './defaults.js';
import { JsonDocument } from './store.js';
import {
  ConfigError,
  validateJobOverrides,
  validateProjectOverride,
  validateProviderProfile,
  validateProviders,
  validateReviewSettings,
  validateSelection,
  validateSettings,
  validateWorkerSettings,
} from './validate.js';

/**
 * Normalize a project path to the key shape persisted in settings. Windows
 * paths are compared case-insensitively through a lowercased canonical form;
 * the returned display form preserves the caller's spelling.
 * @param {string} projectPath - absolute project path.
 * @returns {{ key: string, display: string }} canonical key and display form.
 */
export function projectKey(projectPath) {
  const display = String(projectPath ?? '').replace(/[\\/]+$/, '');
  const key = process.platform === 'win32' ? display.toLowerCase() : display;
  return { key, display };
}

/**
 * Compose the effective execution snapshot for one job.
 *
 * Precedence, highest first: per-job override, project override, global
 * settings. Every field in the result is either explicitly configured or a
 * documented constant default; nothing reads an ambient harness default.
 * @param {object} settings - validated settings.
 * @param {object} options - `projectPath` and `overrides`.
 * @returns {object} frozen effective snapshot with its provenance.
 */
export function resolveEffectiveConfig(settings, { projectPath = null, overrides = {} } = {}) {
  const applied = [];
  let worker = { ...settings.worker };
  let review = { ...settings.review };

  if (projectPath !== null && projectPath !== undefined) {
    const { display } = projectKey(projectPath);
    const projectBlock = settings.projectOverrides[display];
    if (projectBlock !== undefined) {
      if (projectBlock.worker !== undefined) {
        worker = mergeWorker(worker, projectBlock.worker);
        applied.push('project:worker');
      }
      if (projectBlock.review !== undefined) {
        review = { ...projectBlock.review };
        applied.push('project:review');
      }
    }
  }

  const normalizedOverrides = validateJobOverrides(overrides, settings.providers);
  if (Object.keys(normalizedOverrides).length > 0) {
    worker = mergeWorker(worker, normalizedOverrides);
    applied.push('job:worker');
  }

  // The three-layer merge is complete; re-validate the composed triple so a
  // project block cannot leave a provider/model pair that global settings once
  // made legal and a later edit invalidated.
  const selection = validateSelection(worker, settings.providers, 'effective.worker');
  const effectiveReview = review.enabled
    ? { ...review, ...pluckSelection(validateSelection(review, settings.providers, 'effective.review')) }
    : { enabled: false, providerId: null, model: null, reasoningEffort: null };

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    worker: Object.freeze({
      providerId: selection.providerId,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      timeoutSeconds: worker.timeoutSeconds,
      maxParallelism: worker.maxParallelism,
      isolation: worker.isolation,
      // The provider route id handed to the native agent is the profile id; the
      // wire protocol and endpoint stay server-side facts resolved at call time.
      providerRoute: selection.providerId,
    }),
    review: Object.freeze({
      enabled: effectiveReview.enabled === true,
      providerId: effectiveReview.providerId ?? null,
      model: effectiveReview.model ?? null,
      reasoningEffort: effectiveReview.reasoningEffort ?? null,
      providerRoute: effectiveReview.providerId ?? null,
    }),
    provenance: Object.freeze({ projectPath: projectPath ?? null, applied: Object.freeze(applied) }),
  });
}

function mergeWorker(base, patch) {
  const next = { ...base };
  for (const key of ['providerId', 'model', 'reasoningEffort', 'timeoutSeconds', 'isolation', 'maxParallelism']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  return next;
}

function pluckSelection(selection) {
  return { providerId: selection.providerId, model: selection.model, reasoningEffort: selection.reasoningEffort };
}

/**
 * Public, secret-free projection of settings for a settings surface or export.
 * @param {object} settings - validated settings.
 * @returns {object} projection containing no credential value at all.
 */
export function publicSettings(settings) {
  return {
    schemaVersion: settings.schemaVersion,
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      credentialRef: provider.credentialRef,
      models: provider.models.map((model) => ({ ...model, efforts: [...model.efforts] })),
    })),
    worker: { ...settings.worker },
    review: { ...settings.review },
    authorization: { ...settings.authorization },
    projectOverrides: structuredClone(settings.projectOverrides),
  };
}

/** Refusal codes surfaced by the settings service. */
export const SETTINGS_CODES = Object.freeze({
  invalid: 'SETTINGS_INVALID',
  noProviders: 'SETTINGS_NO_PROVIDERS',
});

/**
 * Settings service owning the validated document and its persistence.
 */
export class SettingsService {
  /**
   * @param {string} dataDir - plugin data directory.
   */
  constructor(dataDir) {
    this.document = new JsonDocument(dataDir, SETTINGS_FILE, {
      schemaVersion: SCHEMA_VERSION,
      initial: defaultSettings,
    });
    this.cached = null;
  }

  /**
   * Read validated settings, refusing an unusable stored document loudly.
   * A fresh install (absent file) yields the documented empty defaults whose
   * selection fields are null; selection is validated only when a job is opened.
   * @returns {Promise<object>} validated settings.
   */
  async read() {
    if (this.cached !== null) return this.cached;
    const raw = await this.document.load();
    this.cached = validateSettings(raw);
    return this.cached;
  }

  /**
   * Replace the stored document after full validation.
   * @param {unknown} candidate - candidate settings document.
   * @returns {Promise<object>} committed settings.
   */
  async replace(candidate) {
    const normalized = validateSettings(candidate);
    const committed = await this.document.commit(() => normalized);
    this.cached = committed;
    return committed;
  }

  /**
   * Add or replace one provider profile.
   * @param {unknown} candidate - candidate provider.
   * @returns {Promise<object>} committed settings.
   */
  async upsertProvider(candidate) {
    const profile = validateProviderProfile(candidate);
    const current = await this.read();
    const providers = current.providers.filter((entry) => entry.id !== profile.id);
    providers.push(profile);
    return this.replaceValidated({ ...current, providers });
  }

  /**
   * Remove one provider profile. A provider still referenced by worker or
   * review settings is refused: silently dropping the reference would leave
   * delegation pointing at nothing.
   * @param {string} providerId - provider to remove.
   * @returns {Promise<object>} committed settings.
   */
  async removeProvider(providerId) {
    const current = await this.read();
    const providers = current.providers.filter((entry) => entry.id !== providerId);
    if (current.worker.providerId === providerId) {
      throw new ConfigError('PROVIDER_IN_USE', 'the worker settings select this provider', { providerId, role: 'worker' });
    }
    if (current.review.enabled && current.review.providerId === providerId) {
      throw new ConfigError('PROVIDER_IN_USE', 'the additional review selects this provider', { providerId, role: 'review' });
    }
    for (const [projectPath, block] of Object.entries(current.projectOverrides)) {
      if (block?.worker?.providerId === providerId || block?.review?.providerId === providerId) {
        throw new ConfigError('PROVIDER_IN_USE', 'a project override selects this provider', { providerId, projectPath });
      }
    }
    const next = { ...current, providers };
    if (providers.length === 0) {
      return this.replaceValidated({
        ...next,
        worker: defaultSettings().worker,
        review: defaultSettings().review,
        projectOverrides: {},
      });
    }
    return this.replaceValidated(next);
  }

  /**
   * Replace the worker execution settings block.
   * @param {unknown} candidate - candidate worker block.
   * @returns {Promise<object>} committed settings.
   */
  async setWorker(candidate) {
    const current = await this.read();
    const worker = validateWorkerSettings(candidate, current.providers);
    return this.replaceValidated({ ...current, worker });
  }

  /**
   * Replace the additional-review block. Enabling review requires a complete,
   * independently valid provider/model/effort triple.
   * @param {unknown} candidate - candidate review block.
   * @returns {Promise<object>} committed settings.
   */
  async setReview(candidate) {
    const current = await this.read();
    const review = validateReviewSettings(candidate, current.providers);
    return this.replaceValidated({ ...current, review });
  }

  /**
   * Replace or clear one project override.
   * @param {string} projectPath - absolute project path.
   * @param {unknown} block - project block, or null to clear.
   * @returns {Promise<object>} committed settings.
   */
  async setProjectOverride(projectPath, block) {
    const current = await this.read();
    const { display } = projectKey(projectPath);
    const projectOverrides = { ...current.projectOverrides };
    if (block === null || block === undefined) {
      delete projectOverrides[display];
    } else {
      projectOverrides[display] = validateProjectOverride(block, current.providers);
    }
    return this.replaceValidated({ ...current, projectOverrides });
  }

  /**
   * Replace the authorization TTL block.
   * @param {unknown} candidate - candidate authorization block.
   * @returns {Promise<object>} committed settings.
   */
  async setAuthorization(candidate) {
    const current = await this.read();
    return this.replaceValidated({ ...current, authorization: candidate });
  }

  /**
   * Validate a candidate document against the current provider list before commit.
   * @param {object} candidate - settings-shaped object.
   * @returns {Promise<object>} committed settings.
   */
  async replaceValidated(candidate) {
    const providers = validateProviders(candidate.providers ?? []);
    const normalized = validateSettings({ ...candidate, providers });
    const committed = await this.document.commit(() => normalized);
    this.cached = committed;
    return committed;
  }
}
