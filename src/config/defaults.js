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
 * The retired directory-level conversation mode, kept only as accepted input.
 *
 * A stored settings document may still say `conversation.mode: "reuse"` from an
 * earlier build that let an operator make every run in a directory continue the
 * previous one. That setting is GONE: a new submission always starts a new DSH
 * conversation, and a follow-up continues only the task thread named by
 * `continueFromTaskId`. The value is still tolerated on read so an existing
 * document keeps loading, and it is incapable of causing a reuse because no code
 * path consults it. {@link LEGACY_CONVERSATION_MODES} is the complete set of
 * values a document may still carry.
 */
export const LEGACY_CONVERSATION_MODE = 'reuse';

/** Every conversation-mode value a stored document may still carry. */
export const LEGACY_CONVERSATION_MODES = Object.freeze(['new', LEGACY_CONVERSATION_MODE]);

/**
 * Session/task-thread identity map file name inside the plugin data directory.
 *
 * Holds only `task id -> { source/execution path, DSH Workspace id, DSH Session id,
 * isolation, worktree ownership facts }`, so an explicit `continueFromTaskId`
 * follow-up can ask the harness to resume THAT task's conversation in the same
 * execution path it ran in. No transcript, prompt, output, credential or usage
 * figure is stored here: the native session log remains the single owner of
 * conversation content.
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
  // Monitoring. The two thresholds are bounded, and the second one must stay
  // strictly greater than the first: two identical thresholds would deliver a
  // self-check and an attention alert for the same instant, which is exactly the
  // noisy behaviour the whole feature exists to remove.
  selfCheckSecondsMin: 30,
  selfCheckSecondsMax: 60 * 60,
  attentionSecondsMin: 31,
  attentionSecondsMax: 2 * 60 * 60,
  // Repeated-failure reminder. `0` disables it, so the minimum is a switch rather
  // than an error; the ceiling keeps a silly value from being indistinguishable from
  // "off" in practice. This is a COUNT, not a duration.
  repeatFailureThresholdMin: 0,
  repeatFailureThresholdMax: 20,
  promptChars: 200_000,
  reviewPromptChars: 400_000,
});

/**
 * Default activity-monitoring thresholds, in seconds of *inactivity*.
 *
 * A run that keeps producing events never reaches either threshold, so these are
 * not poll intervals: nothing is scheduled until the executor has actually been
 * silent for the first one.
 */
export const MONITORING_DEFAULTS = Object.freeze({
  /** Idle span after which one read-only local self-check is performed. */
  selfCheckSeconds: 300,
  /** Idle span after which the wait reports `attention` instead of `heartbeat`. */
  attentionSeconds: 600,
  /**
   * How many CONSECUTIVE identical tool failures are reported once, or `0` to disable.
   *
   * Independent of the two silence thresholds: a run can be busy and still be failing
   * the same way, which is the case this exists for.
   */
  repeatFailureThreshold: 3,
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
    // Silence thresholds for a running task. Absent in documents written before
    // this block existed; validation fills in the defaults, so schema version 1
    // stays readable both ways and an upgraded document needs no migration step.
    monitoring: {
      selfCheckSeconds: MONITORING_DEFAULTS.selfCheckSeconds,
      attentionSeconds: MONITORING_DEFAULTS.attentionSeconds,
    },
    projectOverrides: {},
    // Named, non-secret worker/review combinations. Empty by default, and absent
    // in documents written before presets existed — validation fills it in, so
    // schema version 1 stays readable both ways.
    presets: [],
    // Deprecated and inert. A document that carries `conversation.mode: "reuse"`
    // from an earlier build still loads, but the value is never consulted: a new
    // submission starts a new DSH conversation and a follow-up continues the task
    // thread named by `continueFromTaskId`. It is written as `new` so an upgraded
    // document stops advertising a capability the plugin no longer has.
    conversation: {
      mode: LEGACY_CONVERSATION_MODES[0],
    },
  };
}
