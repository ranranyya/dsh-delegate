// Type declarations for the dsh-delegate native plugin entry (`src/index.js`).
//
// These describe only the package's own public surface — the Cordis plugin object
// DSH imports, the optional-config shape, and the two exported helpers. They are
// hand-written against the runtime module because this package ships plain ESM
// JavaScript; there is no build step that emits declarations.
//
// Every declared member below exists on the runtime module today. Adding a member
// to `src/index.js` without adding it here leaves the package usable but
// under-declared; removing one here before removing it from the runtime would make
// the declaration lie.

/** Stable Cordis plugin name; also the settings/document namespace. */
export declare const name: 'dsh-taskbridge';

/**
 * Injected native services. While any of these is absent Cordis does not activate
 * the plugin, so no handler can run against a half-built harness.
 */
export declare const inject: readonly ['agents', 'sessions', 'llm', 'tools', 'webServer', 'connection'];

/**
 * Plugin configuration schema.
 *
 * This is a `@deepseek-ai/schemastery` schema object, not a plain structural
 * shape: Cordis validates it through the Standard Schema interface
 * (`Config['~standard'].validate`), which a plain object does not implement.
 * The schema's value type is `{ dataDir: string }`.
 */
export declare const Config: import('@deepseek-ai/schemastery').default.Schema<{ dataDir: string }>;

/** One operator-facing provider profile after validation. Never carries a secret. */
export interface DelegateProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  /** Reference into the harness credential seam, or `null` when unset. */
  credentialRef: string | null;
  models: Array<{ id: string; name?: string; efforts?: string[] }>;
  [field: string]: unknown;
}

/** Bounded diagnostic shape shared by the connectivity fan-out and the HTTP planes. */
export interface DelegateError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Per-provider connectivity report: HTTP, auth and catalog layers reported separately from the model probe. */
export interface DelegateProviderConnectivity {
  providerId: string;
  providerName?: string;
  error?: DelegateError | null;
  [layer: string]: unknown;
}

/** Whole-configuration connectivity report produced by {@link checkConnectivity}. */
export interface DelegateConnectivityReport {
  ok: boolean;
  providers: DelegateProviderConnectivity[];
  error?: DelegateError;
}

/**
 * Dependency object the exported helpers accept. Only the fields they read are
 * required; the plugin's own engine passes a much wider object.
 */
export interface DelegateRuntimeDeps {
  llm?: unknown;
  settings?: { read?: () => Promise<unknown> } | unknown;
  [key: string]: unknown;
}

/** One routable provider/model/effort selection that has already been validated. */
export interface DelegateSelection {
  providerId: string;
  providerRoute?: string;
  model: string;
  reasoningEffort?: string | null;
  [field: string]: unknown;
}

/** Routable descriptor returned by {@link resolveRoute}. */
export interface DelegateResolvedRoute {
  providerRoute: string;
  model: string;
  reasoningEffort?: string | null;
  [field: string]: unknown;
}

/** One provider's catalog row returned by {@link describeCatalog}. */
export interface DelegateCatalogEntry {
  providerId: string;
  route: string;
  models: Array<{ id: string; name?: string; efforts?: string[] }>;
  error: DelegateError | null;
}

/** Options accepted by {@link resolveRoute} and {@link describeCatalog}. */
export interface DelegateRouteOptions {
  signal?: AbortSignal;
  routes?: Map<string, string> | null;
  requireEffort?: boolean;
}

/**
 * One pending per-call permission request, as the task view publishes it.
 *
 * Every field is redacted at construction time: `arguments` is a bounded JSON
 * rendering whose string values have passed through the plugin's own redaction,
 * and `reason` is the WORKER's own claim about why it asks — never the operation
 * being decided.
 */
export interface DelegatePendingPermission {
  /** Non-reusable identity of this request. */
  requestId: string;
  taskId: string;
  sessionId: string | null;
  /** The tool whose call is paused. */
  toolName: string;
  /** The exact native tool-call id the decision is bound to. */
  callId: string;
  turn: number | null;
  step: number | null;
  tool: { name: string; callId: string };
  /** `pending` while the call waits; a settled request leaves the pending slot. */
  state: 'pending' | 'decided' | 'expired' | 'cancelled' | 'unavailable';
  /** The worker's own one-line justification. Evidence, not the operation. */
  reason: string | null;
  reasonSource: 'asker-claim';
  /** The access the REAL arguments ask for. */
  requestedAccess: { kind: string; mode: string | null };
  argumentKeys: string[];
  /** Redacted, bounded JSON of the real tool arguments. */
  arguments: string | null;
  argumentsRedacted: true;
  /**
   * Whether the published operation is the WHOLE operation. An `allow-once`
   * decision is refused when this is not `complete`, because an allow must not grant
   * a call whose executable material (a command tail, a write body) was cut by a
   * bound. `reject` is unaffected.
   */
  completeness: 'complete' | 'truncated' | 'unbounded';
  argumentsComplete: boolean;
  /** Which bounds fired, e.g. `value`, `key`, `depth`, `item`. */
  boundsApplied: string[];
  omitted: { valueChars: number; keys: number; depth: number; items: number };
  /** Why an `allow-once` would be refused, or `null` when an allow is decidable. */
  allowBlocked: string | null;
  /** Exact fingerprint of the real arguments; REQUIRED by `allow-once`. */
  fingerprint: string;
  createdAt: number;
  /** Fixed bound: the wait never outlives this (default 10 minutes). */
  deadlineAt: number;
  decision: 'allow-once' | 'reject' | null;
  decidedAt: number | null;
  decidedBy: 'commander' | 'deadline' | 'asker' | 'stop' | 'binding' | 'restart' | null;
  decisionReason: string | null;
  /** Closed native outcome: `allowed-once` is the only grant. */
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | null;
  /** Present only for an `allowed-once`: which checks the grant actually passed. */
  verified?: {
    fingerprintQuoted: boolean;
    argumentsComplete: boolean;
    callReread: boolean;
    turnOpen: boolean;
    boundsApplied: string[];
  } | null;
  /** Present only for an `allowed-once`; states that it covers one call. */
  grant: { kind: 'allowed-once'; appliesTo: 'this-call-only'; callId: string; reusable: false } | null;
  /** Always true: a decision never changes the Session's standing mode. */
  standingModeUnchanged: true;
}

/** The per-call permission block every task view carries. */
export interface DelegateTaskPermission {
  /** Whether this run was offered a bridge at all. */
  bridged: boolean;
  /** Whether a request is outstanding right now. */
  waiting: boolean;
  pending: DelegatePendingPermission | null;
  /** Bounded settled trail, oldest first. */
  evidence: DelegatePendingPermission[];
  /** Time the run spent waiting, which was NOT charged to the execution budget. */
  pausedExecutionMs: number;
  /** The standing sandbox mode, which no decision changes. */
  standingSandboxMode: 'workspace-write';
  /** Stated so no reader can mistake a decision for a standing grant. */
  grantScope: 'single-call';
  /**
   * Present in a STORED record only: the process stopped while this request was
   * pending, so it was rewritten as history and can never be decided or replayed.
   */
  interrupted?: true;
}

/**
 * Bounded activity metadata for one task.
 *
 * Every field is a count, a timestamp or an identifier. Model text, reasoning,
 * tool arguments and tool results have no field here: the monitor that produces
 * this summary never retains them, so no projection of it can leak them.
 */
export interface DelegateTaskActivity {
  /** Clock time of the last genuine progress, or `null` before any. */
  lastActivityAt: number | null;
  /**
   * The true silence span. It is never substituted with a tool's elapsed time: an
   * open tool call that emits nothing is still silence, which is why a hung tool
   * reaches the attention threshold like any other silent executor.
   */
  idleForMs: number | null;
  /** Whether the run is silent between model turns or executing a tool. */
  waitingOn: 'idle' | 'tool' | null;
  /** The native tool call in flight, bounded to its identifiers. */
  currentTool: { name: string | null; callId: string | null; startedAt: number; elapsedMs: number } | null;
  /** The most recent tool call and how long it took. */
  lastTool: { name: string | null; durationMs: number | null } | null;
  /** Total events observed, and how many of them were genuine progress. */
  events: number;
  activityEvents: number;
  toolCallsStarted: number;
  toolCallsFinished: number;
  /** The thresholds this task froze at admission. */
  selfCheckSeconds: number;
  attentionSeconds: number;
  /**
   * The repeated-failure reminder: how many consecutive identical tool failures are
   * reported once (`0` = off), and the bounded trail of episodes already reported.
   *
   * Optional and nullable: a record stored by an older build has no such field, and
   * `repeatFailureOf` projects one as `null`, so a stored history row may omit it.
   */
  repeatFailure?: {
    threshold: number;
    reported: DelegateRepeatedFailure[];
  } | null;
  /**
   * `null` while the run is live. Once the task ended it holds the recorded end, and
   * every elapsed value above is measured against it — a stored or queried record
   * therefore does not keep growing.
   */
  finalizedAt: number | null;
  /** The last self-check verdict, which explains a silent run. */
  selfCheck: { episode: number | null; checkedAt: number | null; verdict: string | null } | null;
  /** Counts per event kind, bounded. */
  kinds: Record<string, number>;
  /** Present only in a STORED record: the run did not survive a restart. */
  interrupted?: true;
  /** Present only in a STORED record: the tool that was cut off by the restart. */
  interruptedTool?: { name: string | null; callId: string | null; startedAt: number | null; elapsedMs: number | null } | null;
}

/**
 * One reported repeated-failure episode.
 *
 * Only identifiers, a digest and counts: the native tool arguments, the result content,
 * the error's free text and any model output are never retained, so nothing here can
 * carry them.
 */
export interface DelegateRepeatedFailure {
  /** Fixed discriminator, so a client can tell this apart from a silence report. */
  kind: 'repeated-tool-failure';
  /** The native tool name. */
  toolName: string;
  /**
   * A recognized common tool failure code (for example `ENOENT`, `EACCES`, `TIMEOUT`), or
   * `TOOL_ERROR` for anything this build does not positively recognize. An arbitrary
   * `error.code`/`error.name` is never echoed: it is free text that can carry a path or a
   * token.
   */
  failureCode: string;
  /** 16-hex digest of the operation, never the operation itself. */
  operationDigest: string;
  /** How many identical failures were counted when the reminder fired. */
  consecutive: number;
  /** The threshold in force for this task. */
  threshold: number;
  /**
   * When the FIRST failure of this episode happened, not when the threshold was reached:
   * the episode is older than the reminder.
   */
  firstSeenAt: number;
  /** When the failure that completed the threshold happened. */
  lastSeenAt: number;
}

/** Why one observation of a running task returned. */
export type DelegateObserveReason =
  | 'heartbeat'
  | 'attention'
  | 'permission'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** The compact task summary one observation returns. */
export interface DelegateObservationSummary {
  taskId: string;
  state: 'pending' | 'running' | 'awaiting-host-review' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  createdAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number;
  lastActivityAt: number | null;
  currentTool: DelegateTaskActivity['currentTool'];
  idleForMs: number | null;
  waitingOn: DelegateTaskActivity['waitingOn'];
  activity: DelegateTaskActivity | null;
  selfCheck: { episode: number | null; checkedAt: number | null; verdict: string | null } | null;
  /** The route this task froze at admission, never a re-resolved one. */
  route: {
    providerId: string | null;
    providerRoute: string | null;
    model: string | null;
    reasoningEffort: string | null;
    isolation: string | null;
    monitoring: {
      selfCheckSeconds: number | null;
      attentionSeconds: number | null;
      repeatFailureThreshold: number | null;
    };
  } | null;
  connectionId: string | null;
  /** Always false: execution completion is not host acceptance. */
  selfApproved: false;
  /** The commander's recorded delivery review, or null while none exists. */
  hostAcceptance: DelegateCompactHostAcceptance | null;
  reviewPersistence: DelegateReviewPersistence;
}

/**
 * A replayed (idempotent) review request and its answer.
 *
 * `decision` is the closed vocabulary the review verb accepts; a note is required and
 * bounded. Repeating the same decision with the same note is a no-op; a different
 * conclusion is refused.
 */
export interface DelegateReviewRequest {
  taskId: string;
  decision: 'accepted' | 'changes-requested';
  /** Required after trimming; at most 8000 Unicode code points; stored redacted. */
  note: string;
}

/** Answer of one recorded delivery review. */
export interface DelegateReviewResult {
  /**
   * The public task view after the decision. Its `state` stays `awaiting-host-review`
   * (that is the compatible underlying state); the conclusion is `hostAcceptance`.
   */
  task: {
    taskId: string;
    state: string;
    phase: string;
    hostAcceptance: DelegateHostAcceptance | null;
    reviewPersistence: DelegateReviewPersistence;
  };
  /** Null until persistence is confirmed; a timed-out write may still finish. */
  hostAcceptance: DelegateHostAcceptance | null;
  reviewPersistence: DelegateReviewPersistence;
}

/** Persistence state is separate from execution and from a proposed conclusion. */
export interface DelegateReviewPersistence {
  state: 'none' | 'saving' | 'timed-out' | 'saved' | 'failed';
  decision: 'accepted' | 'changes-requested' | null;
  accepted: boolean;
  durable: boolean;
  pending: boolean;
  startedAt: number | null;
  confirmedAt: number | null;
  retryable: boolean;
  error: { code: string; message: string } | null;
}

/** A wait carries status and length, never repeats the note body. */
export interface DelegateCompactHostAcceptance extends Omit<DelegateHostAcceptance, 'note'> {
  noteChars: number;
  noteOmitted: true;
}

/** Optional paged note read on delegate_result; omit offset for the old result shape. */
export interface DelegateReviewNotePageRequest {
  taskId: string;
  /** Nonnegative Unicode code-point offset. */
  reviewNoteOffset: number;
  /** Integer from 1 to 2000, default 2000. Requires reviewNoteOffset. */
  reviewNoteLimit?: number;
}

export interface DelegateReviewNotePageResult {
  ok: true;
  taskId: string;
  state: string | null;
  reviewNote: {
    offset: number;
    limit: number;
    text: string;
    noteChars: number;
    nextOffset: number | null;
    complete: boolean;
    present: boolean;
  };
  hostAcceptance: DelegateCompactHostAcceptance | null;
  reviewPersistence: DelegateReviewPersistence | null;
}

/**
 * The commander's recorded delivery review of one finished task.
 *
 * This is the ONLY record that turns "execution finished" into a host conclusion. It is
 * written by the review verb, never derived from a task's state, and the first decision is
 * final for that task.
 */
export interface DelegateHostAcceptance {
  /** True only when the recorded decision was `accepted`. */
  accepted: boolean;
  /** The recorded conclusion. */
  state: 'accepted' | 'changes-requested';
  /** When the decision was recorded, in epoch milliseconds. */
  acceptedAt: number;
  /** Fixed marker for who recorded it; never a caller-supplied name. */
  by: string;
  /** The redacted, bounded conclusion. */
  note: string;
}

/** Result of one bounded observation of a delegated task. */
export interface DelegateObservation {
  task: DelegateObservationSummary;
  reason: DelegateObserveReason;
  /**
   * The FULL redacted pending request, present only for `reason: 'permission'`.
   * Carries the exact fingerprint and completeness facts a decision needs; it is
   * never shortened into an undecidable summary.
   */
  permission: DelegatePendingPermission | null;
  /**
   * Present only when `reason` is `attention` AND the reminder is about repeated
   * failures rather than silence. `null`/absent for an ordinary silence report, which
   * keeps the two distinguishable without a new reason value.
   */
  failure?: DelegateRepeatedFailure | null;
  activity: DelegateTaskActivity | null;
  selfCheck: { episode: number | null; checkedAt: number | null; verdict: string | null } | null;
  /**
   * The wait that produced this result. `activitySinceWait` reports that the run
   * moved during the wait; it is NOT a reason to wake the host, so such an
   * observation still ends as `heartbeat` unless a threshold or an outcome says
   * otherwise.
   */
  wait: { waitMs: number; waitedMs: number; activitySinceWait: boolean };
}

/**
 * Mount the delegation service.
 *
 * After this resolves the plugin holds no grant, owns no agent, and refuses to
 * dispatch work until an operator authorizes a connection through the
 * authenticated user plane.
 * @param ctx - Cordis plugin context.
 * @param config - plugin config.
 */
export declare function apply(ctx: unknown, config?: { dataDir?: string }): Promise<void>;

/** Whole-configuration connectivity report; one entry per configured provider. */
export declare function checkConnectivity(deps: DelegateRuntimeDeps): Promise<DelegateConnectivityReport>;

/** Resolve and validate one explicit selection against the native LLM service. */
export declare function resolveRoute(
  deps: DelegateRuntimeDeps,
  selection: DelegateSelection,
  options?: DelegateRouteOptions,
): Promise<DelegateResolvedRoute>;

/** Describe each provider's available models, with per-provider status. */
export declare function describeCatalog(
  deps: DelegateRuntimeDeps,
  providers: DelegateProviderProfile[],
  options?: DelegateRouteOptions,
): Promise<DelegateCatalogEntry[]>;
