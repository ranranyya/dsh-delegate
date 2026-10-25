// dsh-delegate — native DSH plugin entry point.
//
// Load order matters and is visible here: services are injected, configuration is
// read, both HTTP planes are registered on their respective carriers, and the
// native provider/adapter/worktree/history machinery is constructed. The
// persisted local-call switch is restored at startup and defaults to OFF; no
// task is dispatched until an operator enables it in the DSH plugin settings.
//
// Service access is deliberately split in two:
//
//   * `inject` lists the services this plugin cannot work without at all. While
//     any is missing, Cordis does not activate the plugin — which is the correct
//     outcome for a harness that cannot host it.
//   * `ctx.get(name, false)` reads the services that are *optional*: the credential
//     seam (a harness may have none, and the UI must then say so instead of the
//     plugin failing to load) and the agent preset registry. A bare property read
//     would throw `cannot get property "…" without inject`, so the non-strict
//     accessor is the only safe way to express "optional".
//
// The plugin's own face is published with `ctx.provide('dshDelegate', …)` rather
// than by assigning `ctx.dshDelegate`: an unprovided property assignment throws
// `cannot set property "…" without provide` in Cordis, and provide/effect is what
// makes the face disappear again on unload.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import z from '@deepseek-ai/schemastery';

import { SCHEMA_VERSION } from './config/defaults.js';
import { SettingsService } from './config/settings.js';
import { AuthorizationRegistry } from './auth/grants.js';
import { bindAllowsExternalConnections } from './auth/fence.js';
import { JobEngine } from './jobs/engine.js';
import { HistoryStore } from './jobs/history.js';
import { WorkspaceLocks } from './workspace/locks.js';
import { createGitRunner } from './workspace/audit.js';
import { WorktreeManager } from './workspace/worktrees.js';
import { createCredentialGateway } from './credentials/seam.js';
import { createOpenAiAdapter } from './model/openai-adapter.js';
import { createProviderRegistry, nativeProvidersOf, managedProvidersOf } from './model/providers.js';
import { describeCatalog, resolveRoute } from './model/routing.js';
import { checkProviderConnectivity } from './model/connectivity.js';
import { probeModel } from './model/probe.js';
import { createExecutionHandler, EXECUTION_PREFIX } from './http/execution-plane.js';
import { wrapUserPlaneRoutes } from './http/user-plane.js';
import { diagnostic } from './runtime/agent-runner.js';
import { SessionStore } from './runtime/session-placement.js';
import { publishRuntimeEndpoint, resolveDefaultEndpointDiscoveryPath } from './runtime/endpoint-discovery.js';
import { resolveCodexActionSeam } from './codex/seam.js';
import { ReviewPreset } from './review/preset.js';

/** Stable Cordis plugin name; also the settings/document namespace. */
export const name = 'dsh-delegate';

/**
 * Injected native services. Listing them explicitly means the plugin is not
 * activated until each one exists, so no handler can run against a half-built
 * harness. Two services are deliberately NOT injected:
 *
 *   * `credentials` — the plugin must load and report state in a harness with no
 *     credential seam, and it only touches that seam when an operator asks about a
 *     reference or presses save;
 *   * `agentPresets` — a run works without a preset registry (it asks the runtime
 *     for its configured default), so a missing registry must not disable
 *     configuration.
 */
export const inject = ['agents', 'sessions', 'llm', 'tools', 'webServer', 'connection'];

/**
 * Plugin configuration schema.
 *
 * Cordis validates a plugin's config before `apply` runs by calling
 * `runtime.Config['~standard'].validate(config)` (see `resolveConfig` in
 * `@deepseek-ai/cordis`, 0.2.0-rc.2 / 4.0.5). A plain object has no
 * `~standard` member, so it dereferences `undefined.validate` and the plugin
 * fails to activate. Every native DSH plugin declares its schema with
 * `@deepseek-ai/schemastery`, whose schemas carry that interface; this one must
 * too, and `schemastery` is then also a real runtime dependency rather than a
 * host-provided accident.
 */
export const Config = z.object({
  /** Data directory root; the plugin appends `dsh-delegate`. */
  dataDir: z.string().default(''),
});

/**
 * Mount the delegation service.
 *
 * `config` is the operator's settings document and is validated by {@link Config}
 * before this runs. A test may additionally pass a `reviewPresetImporter`, which
 * replaces the solver used to find the native review tool packages; it is not
 * part of the published schema and a real deployment never provides one.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - plugin config.
 * @returns {Promise<void>} resolves after registration.
 */
export async function apply(ctx, config = {}) {
  const logger = ctx.logger;
  const dataDir = await resolveDataDir(ctx, config);

  const settings = new SettingsService(dataDir);
  // Read once at load so an unusable document fails the plugin loudly instead of
  // surfacing as a confusing refusal on the first request.
  const initialSettings = await settings.read();

  // Optional services, read non-strictly so their absence is a fact and not a throw.
  const credentialsService = ctx.get('credentials', false) ?? null;
  const agentPresets = ctx.get('agentPresets', false) ?? null;

  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const runGit = createGitRunner();

  // The credential gateway is what both the native adapter and the user plane use.
  // It reads the seam lazily, so a service that appears (or disappears) after load
  // is observed on the next operation instead of being frozen at startup.
  const credentials = createCredentialGateway(() => ctx.get('credentials', false) ?? credentialsService);

  // Native adapter + route registry. Without these a dispatch must refuse
  // (`JOB_PROVIDER_REGISTRY_REQUIRED`) rather than silently route to a profile id
  // that the harness never registered.
  //
  // `createOpenAiAdapter` returns a *management facade* around one `PiAiAdapter`.
  // The registry is given the facade and unwraps it, because the only object the
  // native core may be handed is the adapter itself: it calls
  // `providerInfo`/`providerRetryPolicy` during registration and `prepareCall`/
  // `stream` on every request. Registering the facade produced exactly the
  // observed failure — the route existed, and every model call on it resolved
  // `ROUTING_MODEL_UNRESOLVED` because no streamable adapter was ever attached.
  const adapter = createOpenAiAdapter({ credentials });
  const providerRegistry = createProviderRegistry({ llm: ctx.llm, adapter });

  const history = new HistoryStore(dataDir);
  const worktrees = new WorktreeManager({ runGit }, { rootDir: join(dataDir, 'worktrees') });
  // The session-identity map: canonical execution path -> DSH Workspace/Session
  // ids, so an opt-in `reuse` run can continue the conversation for the same
  // directory. Stores identities only, never transcript content.
  const sessionStore = new SessionStore(dataDir, { logger });

  // The independent review composes its own read-only agent preset instead of
  // joining the deployment default (which mounts `dsh-tool-subagent`, a tool a
  // scope restriction cannot remove). The composition is registered LAZILY on the
  // first review request — the registry's own diagnostic may wait for the Host
  // Loader tree to settle, and must not run inside this row's activation — and is
  // removed again on unload by the effect below. It never touches the configured
  // default, the installed profile, or a user preset.
  const reviewPreset = new ReviewPreset({
    registry: agentPresets,
    logger,
    ...(typeof config?.reviewPresetImporter === 'function' ? { importer: config.reviewPresetImporter } : {}),
  });
  const readPresets = () => ctx.get('agentPresets', false) ?? null;
  const reviewPresets = {
    /**
     * A live facade so a registry that appears (or is replaced) after load is
     * observed on the next review instead of being frozen at startup.
     */
    get id() { return reviewPreset.createdId; },
    owns(id) { return reviewPreset.owns(id); },
    preparation: (bounds) => {
      reviewPreset.attach(readPresets());
      return reviewPreset.preparation(bounds ?? {});
    },
  };

  const deps = {
    agents: ctx.agents,
    agentPresets,
    reviewPresets,
    sessions: ctx.sessions,
    // The native Workspace and Session controllers. Both are read non-strictly:
    // a harness that does not compose them must load the plugin and then refuse a
    // dispatch with a stated code (`SESSION_*_UNAVAILABLE`), not fail to activate.
    // A run is never created outside a Workspace as a fallback.
    workspaces: optionalService(ctx, 'workspaceController'),
    sessionController: optionalService(ctx, 'sessionController'),
    sessionStore,
    llm: ctx.llm,
    tools: ctx.tools,
    settings,
    auth,
    locks,
    runGit,
    worktrees,
    history,
    providerRegistry,
    credentials,
    logger,
    delegationEnabled: initialSettings.delegationEnabled === true,
    authorizationMode: 'switch',
    // The Codex integration is an explicit operator action reached from the
    // settings page. It is constructed here (never run on load) and its version is
    // this plugin's own, so an upgraded package reports the new agent template as
    // available instead of silently leaving an older file behind.
    codex: resolveCodexActionSeam({ version: PLUGIN_VERSION }),
  };

  /**
   * Bring the native routes and the adapter's served snapshot to the state this
   * settings snapshot describes, and return the mapping both sides agree on.
   *
   * One registration owns the route set. The whole transition below is a single
   * synchronous section — `transaction()` never awaits, and the registry refuses
   * a callback that returns a thenable — because the two sides must move together:
   *
   *   1. `registry.register(providers, adapt)` validates the candidate list, then
   *      checks that no candidate route is owned by another registration;
   *   2. `adapt` publishes the matching snapshot on the adapter
   *      (`prepareRoutes`), which is the state `prepareRoutes()` in the core reads
   *      synchronously when it validates the routes;
   *   3. `adapt` calls the `commit()` the registry handed it, which is where the
   *      core validates and commits — synchronously, still inside `adapt`'s own
   *      stack — so no native observer, and no second ensure, can see the adapter
   *      serving a generation the core has not accepted;
   *   4. a refusal at step 3 rolls the snapshot back to the generation it
   *      displaced before the error leaves this function, so a failed
   *      re-registration leaves both the native route set and the adapter on the
   *      old generation.
   *
   * There is no fallback: a failed registration throws, and every caller
   * (job preflight, `/models`, `/catalog`, connectivity) turns that into an
   * honest refusal instead of routing to an ambient `relay`/`workbuddy` route.
   *
   * The native/custom split is {@link managedProvidersOf}, the same helper
   * `JobEngine.leaseProviders()` uses. That is load bearing, not tidiness: the
   * registry fingerprints whichever list it is given, so the task's long-lived
   * lease and this registration have to describe one set. A native-only
   * configuration therefore leases and registers the same empty custom set
   * instead of leasing `[workbuddy]` and then being refused by its own lease when
   * it registers `[]`.
   * @param {object} snapshot - validated settings snapshot.
   * @returns {Promise<Map<string, string>>} public provider id -> native route id.
   */
  const ensureRoutes = async (snapshot) => {
    const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
    const nativeProviders = nativeProvidersOf(providers);
    const customProviders = managedProvidersOf(providers);
    const registered = await ctx.llm.listProviders();
    const available = new Set((Array.isArray(registered) ? registered : []).map((entry) => entry.id));
    const routes = new Map();
    for (const provider of nativeProviders) {
      if (!available.has(provider.id)) {
        const error = new Error(`native provider ${provider.id} is no longer registered with DSH`);
        error.code = 'NATIVE_PROVIDER_UNAVAILABLE';
        throw error;
      }
      routes.set(provider.id, provider.id);
    }
    if (customProviders.length === 0) {
      await providerRegistry.register([], () => {});
      return routes;
    }
    /**
     * The transaction body. Everything here is synchronous on purpose: the adapter
     * is the only party that may restore the snapshot, and it must have done so
     * before the registry's callback returns and the error propagates.
     *
     * `commit()` is called by the registry at this point in the sequence, from
     * inside this callback's own stack, so the native registration can never land
     * in a microtask after a publication that a second ensure could already have
     * displaced.
     * @param {Map<string, string>} routes - the candidate mapping to register.
     * @param {() => void} commit - perform the native registration.
     * @returns {void}
     */
    const adapt = (routes, commit) => {
      const prepared = adapter.prepareRoutes({ providers: customProviders, routes });
      if (!adapter.describes(prepared, routes)) {
        prepared.rollback();
        throw new Error('dsh-delegate: the adapter and the registry planned different route sets');
      }
      try {
        commit();
      } catch (error) {
        prepared.rollback();
        throw error;
      }
    };
    const ensured = await providerRegistry.register(customProviders, adapt);
    for (const [id, route] of ensured.routes) routes.set(id, route);
    return routes;
  };
  deps.ensureRoutes = ensureRoutes;
  /**
   * The route set, or the reason there is none — for read paths that must answer
   * with a body instead of a thrown refusal.
   * @param {object} snapshot - validated settings snapshot.
   * @param {string} operation - what was being attempted, for the log line.
   * @returns {Promise<{ routes: Map<string, string> | null, error: { code: string, message: string } | null }>} outcome.
   */
  deps.resolveRoutes = async (snapshot, operation) => {
    try {
      return { routes: await ensureRoutes(snapshot), error: null };
    } catch (error) {
      const outcome = {
        code: typeof error?.code === 'string' ? error.code : 'ROUTE_REGISTRATION_REFUSED',
        message: diagnostic(error?.message ?? 'the native provider routes could not be registered', 300),
      };
      logger?.warn?.(`dsh-delegate: provider route registration failed during ${operation}`, outcome.code);
      return { routes: null, error: outcome };
    }
  };
  /** The adapter's own view of what it serves; used only for diagnostics/tests. */
  deps.adapterSnapshot = () => adapter.snapshot();
  deps.probeModel = (route, options) => probeModel(deps, route, options ?? {});

  const engine = new JobEngine(deps);
  deps.engine = engine;
  deps.describeRuntime = () => ({
    plugin: name,
    version: PLUGIN_VERSION,
    schemaVersion: SCHEMA_VERSION,
    // Facts an operator needs to reason about exposure. Never a secret.
    bind: ctx.webServer?.host ?? null,
    port: ctx.webServer?.port ?? null,
    executionPlane: EXECUTION_PREFIX,
    executionPlaneLocalOnly: ctx.webServer?.host === '127.0.0.1',
    credentialSeam: credentialsService === null ? 'unavailable' : 'available',
    presetRegistry: agentPresets === null ? 'unavailable' : 'available',
    // Whether this harness can group a run into a DSH Workspace and create the
    // session inside it. Reported so an operator can tell a configuration problem
    // from a missing native service before dispatching.
    workspaceController: deps.workspaces === null ? 'unavailable' : 'available',
    sessionController: deps.sessionController === null ? 'unavailable' : 'available',
    conversationMode: initialSettings.conversation.mode,
    // Whether the review's own composition was ever registered, i.e. whether a
    // read-only review has been attempted in this activation. Lazy by design.
    reviewPreset: reviewPreset.createdId ?? 'not-registered',
  });

  // ---- user plane: authenticated DSH settings and task controls --------------
  const userRoutes = wrapUserPlaneRoutes(deps);
  for (const route of userRoutes) {
    const dispose = ctx.connection.fetch.register(route);
    ctx.effect(() => dispose);
  }

  // ---- execution plane: loopback MCP; only new submissions need the switch --
  const bindVerdict = bindAllowsExternalConnections(ctx.webServer?.host ?? '127.0.0.1');
  if (bindVerdict.ok === true) {
    const handler = createExecutionHandler({
      ...deps,
      getBindHost: () => ctx.webServer?.host ?? null,
    });
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: EXECUTION_PREFIX,
      handler: (req, res) => handler(req, res),
    });
    ctx.effect(() => dispose);
    try {
      const endpointLease = await publishRuntimeEndpoint({
        filePath: resolveDefaultEndpointDiscoveryPath(),
        host: ctx.webServer?.host,
        port: ctx.webServer?.port,
      });
      ctx.effect(() => () => endpointLease.dispose());
    } catch (error) {
      logger?.warn?.(`dsh-delegate: could not publish MCP endpoint discovery (${diagnostic(error?.message, 200)})`);
    }
  } else {
    // Registering an unauthenticated external surface on a public bind would be
    // worse than not having one. Refuse and record the reason.
    logger?.warn?.(
      `dsh-delegate: the execution plane is not registered because the webserver binds ${ctx.webServer?.host ?? 'unknown'} (${bindVerdict.code}). `
      + 'Delegation requests from external connections will be refused.',
    );
  }

  // ---- stop everything on unload ------------------------------------------
  ctx.effect(() => async () => {
    await engine.dispose();
    // Jobs are gone before the review composition is: a disposed engine holds no
    // runner that could mount a preset this disposer is about to remove.
    await reviewPreset.dispose();
    // History is flushed before the store is closed so a task that finished during
    // teardown is still durable. The session map is flushed on the same terms.
    await history.dispose();
    await sessionStore.dispose();
    providerRegistry.dispose();
    auth.revokeAll();
    locks.releaseAll();
  });

  logger?.info?.(`dsh-delegate: loaded (local MCP switch ${initialSettings.delegationEnabled === true ? 'on' : 'off'}, conversation ${initialSettings.conversation.mode})`);

  // Published as a Cordis service, not assigned: `ctx.provide` is the only legal
  // way to add a property, and its disposer removes the face on unload.
  ctx.provide('dshDelegate', {
    settings,
    auth,
    engine,
    locks,
    history,
    sessionStore,
    worktrees,
    providerRegistry,
    credentials,
    deps,
    reviewPreset,
  });
}

/**
 * Read one optional native service without treating its absence as a failure.
 *
 * `ctx.get(name, false)` is the non-strict accessor: a bare property read throws
 * `cannot get property "…" without inject`, which would turn "this harness does
 * not compose the controller" into "the plugin does not load at all". The seam is
 * a function so a service that appears or is replaced after load is observed on
 * the next run instead of being frozen at activation.
 * @param {object} ctx - plugin context.
 * @param {string} name - native service name (`workspaceController`, `sessionController`).
 * @returns {object | null} the service, or null when it is not composed.
 */
function optionalService(ctx, name) {
  const service = ctx.get(name, false);
  return service === undefined || service === null ? null : service;
}

/** Version reported by the runtime facts block. Mirrors `package.json`. */
const PLUGIN_VERSION = '0.1.8';

/**
 * Resolve the plugin's own data directory.
 *
 * Precedence matches the harness's own home resolution: an explicit plugin config
 * path, then `$DSH_HOME`, then `~/.dsh`. A blank `DSH_HOME` is treated as unset so
 * a whitespace override can never resolve state into the current directory.
 * @param {object} ctx - plugin context (unused for paths; kept for signature symmetry).
 * @param {object} config - plugin config.
 * @returns {Promise<string>} absolute data directory.
 */
async function resolveDataDir(ctx, config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  const base = configured !== '' ? configured : defaultHome();
  const target = join(configured !== '' ? base : join(base, 'data'), 'dsh-delegate');
  await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}

function defaultHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  if (fromEnv !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * Whole-configuration connectivity report.
 *
 * Kept as an exported function because it is the shape an operator-facing
 * diagnostic and a test both want: one call, every configured provider, no HTTP
 * surface involved. The per-provider implementation lives in
 * `src/model/connectivity.js`; this function is the fan-out over the document.
 *
 * The four layers are reported independently because they fail for different
 * reasons and a caller must not conclude "the model is broken" from "the endpoint
 * is unreachable". The model layer sends a real, short request with a usable token
 * budget and treats a reasoning-only answer as success — reasoning models that
 * spend their budget thinking are working, not timing out.
 * @param {object} deps - dependency object with `settings`, `credentials`,
 *   `ensureRoutes`, `llm`, `probeModel`.
 * @returns {Promise<object>} `{ settings: object, providers: object[] }` report.
 */
export async function checkConnectivity(deps) {
  let snapshot;
  try {
    snapshot = await deps.settings.read();
  } catch (error) {
    return {
      ok: false,
      providers: [],
      error: { code: error?.code ?? 'SETTINGS_UNREADABLE', message: diagnostic(error?.message, 300) },
    };
  }
  const providers = [];
  for (const provider of snapshot.providers) {
    try {
      providers.push(await checkProviderConnectivity(deps, { providerId: provider.id }));
    } catch (error) {
      providers.push({
        providerId: provider.id,
        providerName: provider.name,
        error: {
          code: typeof error?.code === 'string' ? error.code : 'CONNECTIVITY_FAILED',
          message: diagnostic(error?.message, 300),
        },
      });
    }
  }
  return {
    ok: providers.length > 0 && providers.every((entry) => entry.error === undefined || entry.error === null),
    providers,
  };
}

export { describeCatalog, resolveRoute };
