// Settings service: the one authority on validated configuration and on the
// effective snapshot a job runs under.
//
// Three layers compose here - global, project, per-job - and they compose in a
// fixed order with no implicit source beneath them. A missing provider is a
// refusal, never a substitution of a harness default, so an operator can always
// tell which model spent their tokens.
//
// Concurrency contract of SettingsService:
//
//   * Every read-modify-validate-save cycle runs entirely inside one serial
//     queue, so two concurrent edits to different blocks both survive. Reading
//     a field before entering the queue and replacing a whole snapshot
//     afterwards is exactly the lost-update bug this queue removes.
//   * The queue is recuperative: a rejected operation settles the tail to a
//     resolved promise, so the next operation still runs.
//   * Reads do not queue. They serve the cached immutable snapshot, which is
//     only replaced after a durable write, so a reader sees the old or the new
//     document, never a partial one. Concurrent first reads share one load.
//   * A queued operation must never call another queued mutator (that would
//     wait behind itself and never settle). Operations inside the queue use
//     `snapshot()` and `persistWithinQueue()`.
//   * Every snapshot handed out (read, resolution of a mutator, hook argument)
//     is deep-frozen, so an external caller cannot mutate service state.

import { SETTINGS_FILE, SCHEMA_VERSION, defaultSettings } from './defaults.js';
import { JsonDocument, deepFreeze } from './store.js';
import {
  ConfigError,
  canonicalProjectKey,
  validateConversationSettings,
  validateJobOverrides,
  validateMonitoringSettings,
  validateProjectOverride,
  validateProviderProfile,
  validateReviewSettings,
  validateSelection,
  validateSettings,
  validateWorkerSettings,
} from './validate.js';

/**
 * The conversation policy every run follows, frozen into each task snapshot.
 *
 * One sentence, in the task record, so a finished task can explain itself without
 * the reader consulting a setting: a new submission is a new conversation, and a
 * follow-up continues the thread named by `continueFromTaskId`.
 */
export const CONVERSATION_POLICY = 'per-task';

/**
 * Canonical key for one project path.
 *
 * The single source of truth is `canonicalProjectKey` in `validate.js`: the key
 * persisted with a project override and the key used to look one up must be the
 * same value produced by the same function, otherwise `C:/Work/Proj/`,
 * `c:\work\proj` and `C:\Work\Proj` become three keys of which only one applies.
 * @param {string} projectPath - absolute project path.
 * @returns {{ key: string, display: string }} canonical lookup key and normalized display form.
 */
export function projectKey(projectPath) {
  return canonicalProjectKey(projectPath);
}

/**
 * Index of canonical project key -> override block for one `projectOverrides`
 * map.
 *
 * Validated documents already store canonical display keys, but a document
 * written by an older build may hold a non-canonical spelling, so every key is
 * canonicalized on the way into the index. Validation refuses two spellings of
 * one project, so at most one block can land on a key. The cache is keyed by the
 * (frozen) map itself, so it cannot go stale.
 */
const PROJECT_INDEX = new WeakMap();

function projectOverrideIndex(projectOverrides) {
  if (projectOverrides === null || typeof projectOverrides !== 'object') return new Map();
  const cached = PROJECT_INDEX.get(projectOverrides);
  if (cached !== undefined) return cached;
  const index = new Map();
  for (const [projectPath, block] of Object.entries(projectOverrides)) {
    let key = projectPath;
    try {
      key = canonicalProjectKey(projectPath, 'projectOverrides key').key;
    } catch {
      // Unreachable for a validated document; keeping the raw key means a
      // lookup still works instead of throwing from a read path.
    }
    index.set(key, block);
  }
  PROJECT_INDEX.set(projectOverrides, index);
  return index;
}

/**
 * Compose the effective execution snapshot for one job.
 *
 * Precedence, highest first: per-job override, project override, global
 * settings. Every field in the result is either explicitly configured or a
 * documented constant default; nothing reads an ambient harness default. The
 * returned object is deep-frozen and is the value a job records as its immutable
 * effective configuration.
 * @param {object} settings - validated settings.
 * @param {object} options - `projectPath` and `overrides`.
 * @returns {object} frozen effective snapshot with its provenance.
 */
export function resolveEffectiveConfig(settings, { projectPath = null, overrides = {} } = {}) {
  const applied = [];
  let worker = { ...settings.worker };
  let review = { ...settings.review };
  const canonical = projectPath === null || projectPath === undefined ? null : projectKey(projectPath);

  if (canonical !== null) {
    const projectBlock = projectOverrideIndex(settings.projectOverrides ?? {}).get(canonical.key);
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

  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    worker: {
      providerId: selection.providerId,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      timeoutSeconds: worker.timeoutSeconds,
      maxParallelism: worker.maxParallelism,
      isolation: worker.isolation,
      // Explicit placeholder for the native provider route. In this stage the
      // route id is the profile id; the wire protocol and endpoint stay
      // server-side facts resolved at call time. The later routing step freezes
      // its decision against this field rather than re-deriving it.
      providerRoute: selection.providerId,
    },
    review: {
      enabled: effectiveReview.enabled === true,
      providerId: effectiveReview.providerId ?? null,
      model: effectiveReview.model ?? null,
      reasoningEffort: effectiveReview.reasoningEffort ?? null,
      providerRoute: effectiveReview.providerId ?? null,
    },
    // What this task does with its DSH conversation is NOT a settings fact any
    // more: it is decided per submission by `continueFromTaskId`. The frozen
    // snapshot therefore carries the rule rather than a stored mode, so a task
    // record states what the plugin will do instead of echoing a retired setting.
    conversation: { policy: CONVERSATION_POLICY },
    // The silence thresholds this task runs under, FROZEN at admission. They are
    // global-only (no project or per-job layer): an operator edits them rarely, and
    // a per-job override would let one submission ask to be watched on a different
    // clock than the alert thresholds the operator actually set. Freezing them here
    // is what makes an edit during a live run apply to the NEXT task instead of
    // silently retiming one already in flight.
    monitoring: {
      selfCheckSeconds: settings.monitoring.selfCheckSeconds,
      attentionSeconds: settings.monitoring.attentionSeconds,
    },
    provenance: {
      // Canonical, not the caller's spelling: a recorded snapshot must compare
      // equal to the key its override is stored under.
      projectPath: canonical === null ? null : canonical.display,
      projectKey: canonical === null ? null : canonical.key,
      applied,
    },
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
 * Project one preset without any field that could carry a secret.
 * @param {object} preset - validated preset.
 * @returns {object} projection.
 */
function publicPreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    worker: preset.worker === null ? null : { ...preset.worker },
    review: preset.review === null ? null : { ...preset.review },
  };
}

/**
 * Public, secret-free projection of settings for a settings surface or export.
 *
 * This is also the export shape: a preset holds only provider ids and
 * worker/review blocks, so exporting presets exports no endpoint and no
 * credential. A credential *reference* is included because it is a name, not a
 * value; the value never enters this document.
 * @param {object} settings - validated settings.
 * @returns {object} deep-frozen projection containing no credential value at all.
 */
export function publicSettings(settings) {
  const presets = Array.isArray(settings.presets) ? settings.presets : [];
  return deepFreeze({
    schemaVersion: settings.schemaVersion,
    delegationEnabled: settings.delegationEnabled === true,
    providers: settings.providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: provider.source ?? 'native',
      ...(provider.source === 'native' ? {} : {
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        credentialRef: provider.credentialRef,
      }),
      models: provider.models.map((model) => ({ ...model, efforts: [...model.efforts] })),
    })),
    worker: { ...settings.worker },
    review: { ...settings.review },
    authorization: { ...settings.authorization },
    // Included so a settings surface (and an export/import round-trip) sees the
    // actual thresholds a new task will freeze. They are plain bounded integers,
    // never a secret.
    monitoring: { ...validateMonitoringSettings(settings.monitoring) },
    projectOverrides: structuredClone(settings.projectOverrides ?? {}),
    presets: presets.map(publicPreset),
    // Kept in the export for compatibility with documents and clients that read
    // it, but no longer a choice: the value is the retired directory-level mode and
    // is inert. A restored configuration therefore cannot reintroduce implicit
    // conversation reuse.
    conversation: { ...validateConversationSettings(settings.conversation) },
  });
}

/**
 * Export envelope for settings.
 *
 * Deliberately identical to {@link publicSettings}: one projection, one place
 * where a field could leak, one test surface. Nonsecret presets are included.
 * @param {object} settings - validated settings.
 * @returns {object} deep-frozen export document.
 */
export function exportSettings(settings) {
  return publicSettings(settings);
}

/** Refusal codes surfaced by the settings service. */
export const SETTINGS_CODES = Object.freeze({
  invalid: 'SETTINGS_INVALID',
  noProviders: 'SETTINGS_NO_PROVIDERS',
  // The document was persisted but the post-commit notification hook failed.
  // The write stands; see `details.persisted`.
  changedHookFailed: 'SETTINGS_CHANGED_HOOK_FAILED',
});

/**
 * Settings service owning the validated document and its persistence.
 */
export class SettingsService {
  /**
   * @param {string} dataDir - plugin data directory.
   * @param {object} [options] - lifecycle hooks.
   * @param {(next: object, previous: object) => Promise<void> | void} [options.beforeCommit] -
   *   awaited after validation and before the durable write; throwing aborts the
   *   write, so the store and the cached snapshot keep the previous document.
   * @param {(next: object, previous: object) => Promise<void> | void} [options.onChanged] -
   *   awaited after a successful durable write; the write stands even when it
   *   throws (see docs/config-contract.md).
   */
  constructor(dataDir, { beforeCommit, onChanged } = {}) {
    for (const [name, hook] of [['beforeCommit', beforeCommit], ['onChanged', onChanged]]) {
      if (hook !== undefined && hook !== null && typeof hook !== 'function') {
        throw new TypeError(`SettingsService: ${name} must be a function when provided`);
      }
    }
    this.document = new JsonDocument(dataDir, SETTINGS_FILE, {
      schemaVersion: SCHEMA_VERSION,
      initial: defaultSettings,
    });
    this.beforeCommit = beforeCommit ?? null;
    this.onChanged = onChanged ?? null;
    /** @type {object | null} last known validated, deep-frozen snapshot. */
    this.cached = null;
    /** @type {Promise<object> | null} in-flight first read, shared by concurrent readers. */
    this.loading = null;
    /** @type {Promise<void>} tail of the serial mutation queue. */
    this.queue = Promise.resolve();
  }

  /**
   * Read validated settings, refusing an unusable stored document loudly.
   * A fresh install (absent file) yields the documented empty defaults whose
   * selection fields are null; selection is validated only when a job is opened.
   * Concurrent callers share one physical read and one validation pass.
   * @returns {Promise<object>} validated settings, deep-frozen.
   */
  async read() {
    if (this.cached !== null) return this.cached;
    if (this.loading === null) {
      this.loading = this.snapshot().finally(() => { this.loading = null; });
    }
    return await this.loading;
  }

  /**
   * Load and validate the document without queuing.
   *
   * Safe to call from inside a queued operation: it never waits on the queue
   * tail, so it cannot self-lock.
   * @returns {Promise<object>} validated snapshot, deep-frozen.
   */
  async snapshot() {
    if (this.cached !== null) return this.cached;
    const raw = await this.document.load();
    this.cached = deepFreeze(validateSettings(raw));
    return this.cached;
  }

  /**
   * Replace the stored document after full validation.
   * @param {unknown} candidate - candidate settings document.
   * @returns {Promise<object>} committed settings.
   */
  async replace(candidate) {
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      return await this.persistWithinQueue(candidate, previous);
    });
  }

  /**
   * Replace ordinary configuration while preserving the separately controlled
   * delegation switch. The read and write share the same queue as switch edits,
   * so a slow settings save cannot undo a concurrent disable.
   * @param {unknown} candidate - settings-shaped object.
   * @returns {Promise<object>} committed settings.
   */
  async replaceConfiguration(candidate) {
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      const next = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
        ? { ...candidate, delegationEnabled: previous.delegationEnabled }
        : candidate;
      return await this.persistWithinQueue(next, previous);
    });
  }

  /**
   * Add or replace one provider profile.
   * @param {unknown} candidate - candidate provider.
   * @returns {Promise<object>} committed settings.
   */
  async upsertProvider(candidate) {
    // Shape validation is pure, so it happens before the turn is queued; the
    // read that depends on current state happens inside it.
    const profile = validateProviderProfile(candidate);
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      const providers = previous.providers.filter((entry) => entry.id !== profile.id);
      providers.push(profile);
      return await this.persistWithinQueue({ ...previous, providers }, previous);
    });
  }

  /**
   * Remove one provider profile. A provider still referenced by worker or
   * review settings is refused: silently dropping the reference would leave
   * delegation pointing at nothing.
   * @param {string} providerId - provider to remove.
   * @returns {Promise<object>} committed settings.
   */
  async removeProvider(providerId) {
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      const providers = previous.providers.filter((entry) => entry.id !== providerId);
      if (previous.worker.providerId === providerId) {
        throw new ConfigError('PROVIDER_IN_USE', 'the worker settings select this provider', { providerId, role: 'worker' });
      }
      if (previous.review.enabled && previous.review.providerId === providerId) {
        throw new ConfigError('PROVIDER_IN_USE', 'the additional review selects this provider', { providerId, role: 'review' });
      }
      for (const [projectPath, block] of Object.entries(previous.projectOverrides)) {
        if (block?.worker?.providerId === providerId || block?.review?.providerId === providerId) {
          throw new ConfigError('PROVIDER_IN_USE', 'a project override selects this provider', { providerId, projectPath });
        }
      }
      if (providers.length === 0) {
        // No provider is left: keeping a selection or a project override would
        // leave a document that cannot run. Presets are combinations of a
        // provider triple, so they go with it.
        return await this.persistWithinQueue({
          ...previous,
          providers,
          worker: defaultSettings().worker,
          review: defaultSettings().review,
          projectOverrides: {},
          presets: [],
        }, previous);
      }
      return await this.persistWithinQueue({ ...previous, providers }, previous);
    });
  }

  /**
   * Replace the worker execution settings block.
   * @param {unknown} candidate - candidate worker block.
   * @returns {Promise<object>} committed settings.
   */
  async setWorker(candidate) {
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      const worker = validateWorkerSettings(candidate, previous.providers);
      return await this.persistWithinQueue({ ...previous, worker }, previous);
    });
  }

  /**
   * Refuse to write a conversation block from a settings edit.
   *
   * The directory-level conversation mode has been removed, so there is no longer
   * an operator control for it and no legitimate caller for this mutator. It is
   * kept as a stated refusal rather than deleted so an older client that still
   * posts the block gets an explanation instead of a silent no-op — the failure
   * mode where a page believes it saved a mode that governs runs.
   * @param {unknown} _candidate - ignored.
   * @returns {Promise<never>} never resolves.
   * @throws {ConfigError} always, with `code: CONVERSATION_MODE_REMOVED`.
   */
  async setConversation(_candidate) {
    throw new ConfigError(
      'CONVERSATION_MODE_REMOVED',
      'the directory-level conversation mode has been removed; new submissions always start a new DSH conversation, '
      + 'and a follow-up continues the thread named by continueFromTaskId',
      { field: 'conversation.mode', replacement: 'continueFromTaskId' },
    );
  }

  /**
   * Replace the additional-review block. Enabling review requires a complete,
   * independently valid provider/model/effort triple.
   * @param {unknown} candidate - candidate review block.
   * @returns {Promise<object>} committed settings.
   */
  async setReview(candidate) {
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      const review = validateReviewSettings(candidate, previous.providers);
      return await this.persistWithinQueue({ ...previous, review }, previous);
    });
  }

  /**
   * Replace or clear one project override.
   *
   * The path is canonicalized before use, and every stored key that canonicalizes
   * to the same project is replaced or removed, so an override written under an
   * older spelling is still reachable - and clearable - through any spelling.
   * @param {string} projectPath - absolute project path.
   * @param {unknown} block - project block, or null to clear.
   * @returns {Promise<object>} committed settings.
   */
  async setProjectOverride(projectPath, block) {
    const { key, display } = projectKey(projectPath);
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      const projectOverrides = {};
      for (const [storedPath, storedBlock] of Object.entries(previous.projectOverrides)) {
        let storedKey = storedPath;
        try {
          storedKey = projectKey(storedPath).key;
        } catch {
          // Unreachable for a validated document; keep the entry visible instead
          // of failing an unrelated edit.
        }
        if (storedKey !== key) projectOverrides[storedPath] = storedBlock;
      }
      if (block !== null && block !== undefined) {
        projectOverrides[display] = validateProjectOverride(block, previous.providers);
      }
      return await this.persistWithinQueue({ ...previous, projectOverrides }, previous);
    });
  }

  /**
   * Set the single delegation switch through the same serialized write path as
   * every other setting mutation.
   * @param {boolean} enabled - whether the local MCP surface may submit work.
   * @returns {Promise<object>} committed settings.
   */
  async setDelegationEnabled(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new ConfigError('SETTINGS_INVALID', 'delegationEnabled must be a boolean', { field: 'delegationEnabled' });
    }
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      return await this.persistWithinQueue({ ...previous, delegationEnabled: enabled }, previous);
    });
  }

  /** Replace legacy grant TTL values when reading an older client document. */
  async setAuthorization(candidate) {
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      return await this.persistWithinQueue({ ...previous, authorization: candidate }, previous);
    });
  }

  /**
   * Replace the activity-monitoring block.
   *
   * This is the mutator a later authenticated UI endpoint calls; it is the only
   * write path for these two thresholds, so the bounds and the ordering rule live
   * in exactly one place ({@link validateMonitoringSettings}) and no caller can
   * persist a pair the monitor would refuse to run.
   *
   * The write goes through the same serialized queue as every other settings
   * mutation, so it cannot lose a concurrent edit and a fresh task admitted after
   * it freezes the new values. A task already running keeps the snapshot it froze.
   * @param {unknown} candidate - `{ selfCheckSeconds, attentionSeconds }`.
   * @returns {Promise<object>} committed settings.
   */
  async setMonitoring(candidate) {
    // Shape validation is pure, so it happens before the turn is queued.
    const monitoring = validateMonitoringSettings(candidate);
    return await this.serialize(async () => {
      const previous = await this.snapshot();
      return await this.persistWithinQueue({ ...previous, monitoring }, previous);
    });
  }

  /**
   * Validate and commit a whole settings-shaped document.
   *
   * Unlike the block mutators this accepts an entire document, which is the path
   * an import or an export round-trip uses. It queues like every other write; it
   * exists as a named entry point rather than as a second write path.
   * @param {object} candidate - settings-shaped object.
   * @returns {Promise<object>} committed settings.
   */
  async replaceValidated(candidate) {
    return await this.replace(candidate);
  }

  /**
   * Run one operation after every operation queued before it.
   *
   * The tail is settled in both outcomes: a rejected operation does not poison
   * the queue for the rest of the process. The caller awaits the operation's own
   * promise, so a failure stays with the caller who caused it.
   * @param {() => Promise<object>} operation - queued operation.
   * @returns {Promise<object>} the operation's result.
   */
  serialize(operation) {
    const run = this.queue.then(() => operation());
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Validate, notify, persist and notify again - only ever called from inside
   * {@link SettingsService#serialize}.
   *
   * Order and failure semantics:
   *  1. `beforeCommit(next, previous)` is awaited. A throw aborts here: nothing
   *     is written and `cached` still holds `previous`.
   *  2. the durable write happens. A throw leaves the store and `cached` on the
   *     previous document.
   *  3. `cached` becomes the persisted snapshot.
   *  4. `onChanged(next, previous)` is awaited. A throw does not roll back the
   *     write; it surfaces as SETTINGS_CHANGED_HOOK_FAILED with
   *     `details.persisted = true` so a caller can tell the two cases apart.
   * @param {unknown} candidate - unvalidated next document.
   * @param {object} previous - validated previous snapshot.
   * @returns {Promise<object>} committed settings.
   */
  async persistWithinQueue(candidate, previous) {
    const next = deepFreeze(validateSettings(candidate));

    if (this.beforeCommit !== null) {
      // A throw here is a refusal: no write, no cache change. The hook is what
      // pre-registers a provider with the native registry, and a provider that
      // could not be registered must not be persisted.
      await this.beforeCommit(next, previous);
    }

    const persisted = await this.document.commit(() => structuredClone(next));
    this.cached = persisted;

    if (this.onChanged !== null) {
      try {
        await this.onChanged(persisted, previous);
      } catch (error) {
        throw new ConfigError(
          SETTINGS_CODES.changedHookFailed,
          'the settings document was persisted but the change notification failed',
          {
            persisted: true,
            cause: typeof error?.code === 'string' ? error.code : null,
            detail: typeof error?.message === 'string' ? error.message.slice(0, 300) : null,
          },
        );
      }
    }
    return persisted;
  }
}
