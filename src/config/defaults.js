// Plugin-owned configuration constants and defaults.
//
// dsh-delegate owns exactly one namespace and one document. Delegation is
// disabled on a fresh install; the operator controls it with one persisted
// switch in the authenticated DSH settings page.

/** Persisted document format version. Unknown versions are refused, never migrated silently. */
export const SCHEMA_VERSION = 1;

/** Settings document file name inside the plugin data directory. */
export const SETTINGS_FILE = 'settings.json';

/** Bounded job history file name inside the plugin data directory. */
export const HISTORY_FILE = 'jobs.json';

/** Provider wire protocols this stage actually supports. */
export const SUPPORTED_PROTOCOLS = Object.freeze(['openai-chat']);

/**
 * Workspace isolation modes, strongest first.
 *
 * `worktree` is the default: a mutation runs in a disposable git worktree so the
 * operator's checkout is untouched. It requires a committed repository, and this
 * stage refuses it rather than downgrading (see `src/jobs/engine.js`). `shared`
 * therefore has to be *chosen* by the operator — it is never a silent fallback.
 */
export const ISOLATION_MODES = Object.freeze(['worktree', 'shared']);

/** Isolation mode stored when a document does not name one. */
export const DEFAULT_ISOLATION = 'worktree';

/**
 * Conversation modes: what a delegated run does with the DSH session it creates.
 *
 * `new` is the default and the safe one: every task gets its own DSH session in
 * the Workspace for its actual execution directory. `reuse` opts into resuming
 * the most recent recorded session for that same directory, which keeps a
 * conversation going across tasks. Reuse is scoped by the canonical execution
 * path and never crosses directories, so two isolated worktrees remain two
 * conversations even when they were forked from one repository.
 */
export const CONVERSATION_MODES = Object.freeze(['new', 'reuse']);

/** Conversation mode stored when a document does not name one. */
export const DEFAULT_CONVERSATION_MODE = 'new';

/**
 * Session-identity map file name inside the plugin data directory.
 *
 * Holds only `canonical execution path -> DSH session id` plus the native
 * Workspace id, so a later `reuse` run can ask the harness to resume that
 * conversation. No transcript, prompt, credential or model output is stored
 * here: the native session log remains the single owner of conversation content.
 */
export const SESSIONS_FILE = 'sessions.json';

/** Hard bounds. Exceeding any of these is a validation error, not a clamp. */
export const LIMITS = Object.freeze({
  providers: 32,
  manualModelsPerProvider: 128,
  presets: 32,
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

/**
 * The complete set of native reasoning-effort ids this build understands, in
 * canonical order (weakest first).
 *
 * These are *ids the wire protocol accepts*, not a claim that any model supports
 * them. Whether a given model can take one is declared per model in
 * `provider.models[].efforts`, and both validation and routing refuse anything a
 * model has not declared. `off` is a real id meaning "no reasoning", not an
 * absence of a value: a model must declare it explicitly.
 */
export const KNOWN_EFFORTS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Canonical sort index for declared effort ids. */
export const EFFORT_ORDER = Object.freeze(new Map(KNOWN_EFFORTS.map((id, index) => [id, index])));

/**
 * Default settings document. Delegation is off until the operator enables it.
 */
export function defaultSettings() {
  return {
    schemaVersion: SCHEMA_VERSION,
    delegationEnabled: false,
    providers: [],
    worker: {
      providerId: null,
      model: null,
      reasoningEffort: null,
      timeoutSeconds: 1800,
      maxParallelism: 1,
      isolation: DEFAULT_ISOLATION,
    },
    review: {
      enabled: false,
      providerId: null,
      model: null,
      reasoningEffort: null,
    },
    // Kept separate from the legacy in-memory connection/grant compatibility
    // layer. New installations use this one switch for MCP dispatch.
    authorization: {
      taskGrantTtlSeconds: 900,
      sessionGrantTtlSeconds: 4 * 60 * 60,
    },
    projectOverrides: {},
    // Named, non-secret worker/review combinations. Empty by default, and absent
    // in documents written before presets existed — validation fills it in, so
    // schema version 1 stays readable both ways.
    presets: [],
    // What a delegated run does with its DSH conversation. `new` is the default
    // for every stored document, including ones written before this field
    // existed, so an upgrade never silently resumes somebody's old session.
    conversation: {
      mode: DEFAULT_CONVERSATION_MODE,
    },
  };
}
