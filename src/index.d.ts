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
export declare const name: 'dsh-delegate';

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
