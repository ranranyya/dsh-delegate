// Plugin-owned configuration constants and defaults.
//
// dsh-delegate owns exactly one namespace and one document. Nothing here turns
// delegation on: the module exposes no persisted "enabled" switch at all, so a
// restart cannot resurrect an authorization that a previous process held.

/** Persisted document format version. Unknown versions are refused, never migrated silently. */
export const SCHEMA_VERSION = 1;

/** Settings document file name inside the plugin data directory. */
export const SETTINGS_FILE = 'settings.json';

/** Bounded job history file name inside the plugin data directory. */
export const HISTORY_FILE = 'jobs.json';

/** Provider wire protocols this stage actually supports. */
export const SUPPORTED_PROTOCOLS = Object.freeze(['openai-chat']);

/** Workspace isolation modes. `worktree` requires a committed git repository. */
export const ISOLATION_MODES = Object.freeze(['shared', 'worktree']);

/** Hard bounds. Exceeding any of these is a validation error, not a clamp. */
export const LIMITS = Object.freeze({
  providers: 32,
  manualModelsPerProvider: 128,
  timeoutSecondsMin: 30,
  timeoutSecondsMax: 2 * 60 * 60,
  maxParallelismMin: 1,
  maxParallelismMax: 8,
  taskGrantTtlSecondsMin: 30,
  taskGrantTtlSecondsMax: 60 * 60,
  sessionGrantTtlSecondsMin: 60,
  sessionGrantTtlSecondsMax: 12 * 60 * 60,
  promptChars: 200_000,
  reviewPromptChars: 400_000,
});

/** Reasoning efforts are opaque adapter-owned ids; only declared ones are accepted. */
export const KNOWN_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'maximum']);

/**
 * Default settings document. Delegation is off because there is no stored
 * enablement field; authorization lives only in the in-process grant store.
 */
export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    providers: [],
    worker: {
      providerId: null,
      model: null,
      reasoningEffort: null,
      timeoutSeconds: 1800,
      maxParallelism: 1,
      isolation: 'shared',
    },
    review: {
      enabled: false,
      providerId: null,
      model: null,
      reasoningEffort: null,
    },
    authorization: {
      taskGrantTtlSeconds: 900,
      sessionGrantTtlSeconds: 4 * 60 * 60,
    },
    projectOverrides: {},
  };
}
