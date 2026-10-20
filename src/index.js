// dsh-delegate — native DSH plugin entry point.
//
// Load order matters and is visible here: services are injected, configuration
// is read, and both HTTP planes are registered on their respective carriers.
// None of that authorizes delegation. After `apply` returns, the plugin holds no
// grant, owns no agent, and will refuse to dispatch work until an operator
// authorizes a connection through the authenticated user plane.

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SCHEMA_VERSION } from './config/defaults.js';
import { SettingsService } from './config/settings.js';
import { AuthorizationRegistry } from './auth/grants.js';
import { bindAllowsExternalConnections } from './auth/fence.js';
import { JobEngine } from './jobs/engine.js';
import { WorkspaceLocks } from './workspace/locks.js';
import { createGitRunner } from './workspace/audit.js';
import { resolveRoute } from './model/routing.js';
import { probeModel } from './model/probe.js';
import { createExecutionHandler, EXECUTION_PREFIX } from './http/execution-plane.js';
import { wrapUserPlaneRoutes } from './http/user-plane.js';
import { diagnostic } from './runtime/agent-runner.js';

/** Stable Cordis plugin name; also the settings/document namespace. */
export const name = 'dsh-delegate';

/**
 * Injected native services. Listing them explicitly means the plugin is not
 * activated until each one exists, so no handler can run against a half-built
 * harness. The credential service is deliberately NOT injected: this plugin must
 * load and report state even when credentials are unavailable, and it only asks
 * for credential facts during an explicit connectivity check.
 */
export const inject = ['agents', 'sessions', 'llm', 'tools', 'webServer', 'connection'];

/** Plugin configuration schema (schemastery-compatible plain shape). */
export const Config = {
  /** Data directory root; the plugin appends `dsh-delegate`. */
  dataDir: { type: 'string', default: '' },
};

/**
 * Mount the delegation service.
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
  await settings.read();

  const auth = new AuthorizationRegistry();
  const locks = new WorkspaceLocks();
  const runGit = createGitRunner();
  const deps = {
    agents: ctx.agents,
    sessions: ctx.sessions,
    llm: ctx.llm,
    tools: ctx.tools,
    settings,
    auth,
    locks,
    runGit,
    logger,
  };
  const engine = new JobEngine(deps);
  deps.engine = engine;
  deps.credentials = ctx.credentials;
  deps.probeModel = (route) => probeModel(deps, route);

  deps.describeRuntime = () => ({
    plugin: name,
    version: '0.1.0',
    schemaVersion: SCHEMA_VERSION,
    // Facts an operator needs to reason about exposure. Never a secret.
    bind: ctx.webServer?.host ?? null,
    port: ctx.webServer?.port ?? null,
    executionPlane: EXECUTION_PREFIX,
    executionPlaneLocalOnly: ctx.webServer?.host === '127.0.0.1',
  });

  // ---- user plane: authenticated, may issue authorization -------------------
  const userRoutes = wrapUserPlaneRoutes(deps);
  for (const route of userRoutes) {
    const dispose = ctx.connection.fetch.register(route);
    ctx.effect(() => dispose);
  }

  // ---- execution plane: bounded, may only exercise authorization -----------
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
    auth.revokeAll();
    locks.releaseAll();
  });

  logger?.info?.(`dsh-delegate: loaded (delegation off; ${auth.isDelegationAuthorized() ? 'authorization present' : 'no authorization'})`);

  // Exposed for tests and for other host-side code; not an HTTP surface.
  ctx.dshDelegate = { settings, auth, engine, locks, deps };
}

/**
 * Resolve the plugin's own data directory.
 *
 * Precedence matches the harness's own home resolution: an explicit plugin
 * config path, then `$DSH_HOME`, then `~/.dsh`. A blank `DSH_HOME` is treated as
 * unset so a whitespace override can never resolve state into the current
 * directory.
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
 * Connectivity check separating transport, authentication and model reachability.
 *
 * The three are reported independently because they fail for different reasons
 * and a caller must not conclude "the model is broken" from "the endpoint is
 * unreachable". The model probe sends a real, short request with a usable token
 * budget and treats a reasoning-only answer as success — reasoning models that
 * spend their budget on thinking are working, not timing out.
 * @param {object} deps - dependency object with `llm`, `settings`.
 * @returns {Promise<object>} layered report.
 */
export async function checkConnectivity(deps) {
  const report = {
    transport: { ok: false, detail: null },
    authentication: { ok: false, detail: null },
    catalog: { ok: false, providers: [], detail: null },
    modelResponse: { ok: false, detail: null, response: null },
  };

  let settings;
  try {
    settings = await deps.settings.read();
  } catch (error) {
    report.transport = { ok: false, detail: { code: error?.code ?? 'SETTINGS_UNREADABLE', message: diagnostic(error?.message) } };
    return report;
  }
  report.transport = { ok: true, detail: { providers: settings.providers.length } };

  if (settings.providers.length === 0) {
    report.transport.detail = { note: 'no provider profile is configured; nothing to test' };
    return report;
  }

  // Credentials are checked through the seam that owns them. Only whether a
  // reference resolves is reported; a value is never read into this process.
  const missing = [];
  for (const provider of settings.providers) {
    if (provider.credentialRef === null) continue;
    let resolved = null;
    try {
      resolved = await deps.credentials?.resolve?.(provider.credentialRef);
    } catch {
      resolved = null;
    }
    if (resolved === null || resolved === undefined) missing.push(provider.id);
  }
  report.authentication = {
    ok: missing.length === 0,
    detail: missing.length === 0 ? { checked: settings.providers.length } : { missingProviders: missing },
  };

  try {
    const catalog = [];
    for (const provider of settings.providers) {
      const listed = await (deps.llm?.listModels?.(provider.id) ?? []);
      catalog.push({
        providerId: provider.id,
        models: Array.isArray(listed)
          ? listed.map((model) => (typeof model === 'string' ? model : model?.id)).filter((id) => typeof id === 'string')
          : [],
      });
    }
    report.catalog = { ok: true, providers: catalog, detail: null };
  } catch (error) {
    report.catalog = {
      ok: false,
      providers: [],
      detail: { code: error?.code ?? 'CATALOG_FAILED', message: diagnostic(error?.message, 300) },
    };
  }

  // A real model call is the only proof that routing works end to end.
  const worker = settings.worker;
  if (worker.providerId === null || worker.model === null) {
    report.modelResponse = { ok: false, detail: { code: 'NO_SELECTION', message: 'no worker model is selected' }, response: null };
    return report;
  }
  try {
    const route = await resolveRoute(deps, worker);
    const result = await deps.probeModel?.(route);
    if (result === undefined || result === null) {
      report.modelResponse = { ok: false, detail: { code: 'PROBE_UNAVAILABLE', message: 'no model probe is installed' }, response: null };
      return report;
    }
    report.modelResponse = {
      ok: result.ok === true,
      detail: result.detail ?? null,
      response: { text: result.text ?? '', reasoningOnly: result.reasoningOnly === true, tokens: result.tokens ?? null },
    };
  } catch (error) {
    report.modelResponse = {
      ok: false,
      detail: { code: error?.code ?? 'ROUTE_REFUSED', message: diagnostic(error?.message, 300) },
      response: null,
    };
  }
  return report;
}
