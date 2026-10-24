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
