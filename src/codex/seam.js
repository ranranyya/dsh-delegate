// The seam the user plane uses to reach the Codex integration.
//
// Why a seam and not a direct call: the user plane is exercised by HTTP tests that
// must not touch a real Codex home, and a deployment may legitimately have no
// Codex installed. The seam is the one place that decides *which* Codex home and
// *which* discovery file the plugin reports on, and it keeps that decision out of
// the route handler.
//
// Three properties are load bearing:
//
//   * the Codex home is resolved per call, so an operator who changes `CODEX_HOME`
//     and reloads DSH is reported the new directory without reinstalling;
//   * the discovery path is the one *this* activation published (or would publish),
//     so the MCP entry points Codex at the same DSH the plugin is running in —
//     never at a repository checkout, never at a hard-coded default;
//   * status only reads and run forwards an explicit operator action. The startup
//     write is `refreshManagedIntegration`, which (a) refreshes a byte-exact shipped
//     agent template and (b) upgrades an ALREADY INSTALLED managed
//     `mcp_servers.dsh-delegate` entry that this build can prove is its own and that
//     is merely stale — for example an entry written before `tool_timeout_sec`
//     existed. It never creates a file or an entry, never adopts a same-name entry
//     the plugin cannot prove it wrote, and never touches any other Codex setting.
//
// Which home the STARTUP check targets is a separate decision, made by
// {@link resolveStartupTarget}: an explicit `CODEX_HOME` wins, otherwise the target this
// plugin last installed into successfully (recorded in its own data directory), and only
// then the default. A default that is a link is refused with an explanation rather than
// guessed at, because walking it would write into a directory nobody named.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  inspectDirectory,
  readCodexStatus,
  refreshKnownAgentTemplate,
  requireCodexHome,
  resolveCodexHome,
  runCodexAction,
} from './installer.js';
import { resolveEndpointDiscoveryPath } from '../runtime/endpoint-discovery.js';
import { writeFileAtomic } from '../config/store.js';

/**
 * Where the plugin remembers the Codex home it installed into.
 *
 * It lives in the plugin's own data directory (which is the operator's `DSH_HOME`), is
 * written only after a SUCCESSFUL explicit install, and holds one path. The automatic
 * startup upgrade uses it so that a real, non-default Codex directory that was
 * explicitly installed once keeps being upgraded — without the plugin ever guessing a
 * location or walking a link to find one.
 * @param {Record<string, string | undefined>} env - environment.
 * @returns {string} absolute path of the installation record.
 */
export function installationRecordPath(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const dshHome = configured === '' ? join(defaultHomeDirectory(), '.dsh') : configured;
  return join(dshHome, 'data', 'dsh-delegate', 'codex-installation.json');
}

/** The home directory, resolved the same way the installer resolves it. */
function defaultHomeDirectory() {
  return homedir();
}

/**
 * The directory an unattended upgrade keeps its pre-write `config.toml` copy in.
 *
 * It is derived from the plugin's OWN data directory — the same root that holds the
 * installation record — so the product never depends on a caller remembering to pass a
 * destination, and never writes outside its data tree. The name matches the directory the
 * activation path already uses (`<dataDir>/codex-config-backup`), so both callers share
 * one convention. `DSH_HOME` decides that root; without one the documented `~/.dsh`
 * fallback applies, exactly as for the record.
 *
 * The installer still treats a backup as a PRECONDITION: when this directory cannot be
 * created or verified it refuses the upgrade instead of rewriting a config it could not
 * preserve. Tests redirect `DSH_HOME` into their scratch tree, so no test ever reads or
 * writes the operator's real data directory.
 * @param {Record<string, string | undefined>} env - environment.
 * @returns {string} absolute path of the default backup directory.
 */
export function defaultBackupDirectory(env = process.env) {
  return join(dirname(installationRecordPath(env)), 'codex-config-backup');
}

/**
 * Persist the Codex home an explicit install succeeded into.
 *
 * Only the installer's own action calls this, and only when that action reported no
 * refusal and a non-null `changed` list; a failed install therefore never becomes the
 * remembered target. A relative path is ignored (it would name nothing stable).
 * @param {string} codexHome - absolute Codex home.
 * @param {Record<string, string | undefined>} env - environment (for `DSH_HOME`).
 * @returns {Promise<boolean>} whether the record was written.
 */
export async function rememberInstalledCodexHome(codexHome, env = process.env) {
  if (typeof codexHome !== 'string' || codexHome.trim() === '') return false;
  try {
    const record = { schemaVersion: 1, codexHome, recordedAt: new Date().toISOString() };
    await writeFileAtomic(installationRecordPath(env), `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Codex home this plugin last installed into successfully, or null.
 *
 * Reading the record is deliberately defensive: a missing, unreadable, malformed or
 * relative record is "no trusted target", never a guess.
 * @param {Record<string, string | undefined>} env - environment.
 * @returns {string | null} absolute path, or null.
 */
export function readInstalledCodexHome(env = process.env) {
  try {
    const text = readFileSync(installationRecordPath(env), 'utf8');
    const record = JSON.parse(text);
    if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.schemaVersion !== 1) return null;
    if (typeof record.codexHome !== 'string' || record.codexHome.trim() === '') return null;
    return requireCodexHome(record.codexHome);
  } catch {
    return null;
  }
}

/**
 * Decide which Codex home the AUTOMATIC startup check may target.
 *
 * Precedence, and nothing else:
 *
 *   1. an explicit `CODEX_HOME` (or an explicit `codexHome` option) — the operator said
 *      which directory, so that directory is used;
 *   2. the home this plugin recorded from a successful explicit install, when it still
 *      exists as a real directory;
 *   3. the default home, but only when it exists and is NOT a link.
 *
 * A default that is a link (or whose kind cannot be verified) is not walked: the result
 * says so, and the caller reports it instead of upgrading an unproven tree. This is the
 * difference between "the operator configured a Codex home" and "a junction happens to
 * point somewhere" — only the first is a target this plugin may write to on its own.
 * @param {object} [options] - `env`, `codexHome` (explicit), `homeDirectory`.
 * @returns {Promise<{ home: string | null, source: string, reason: string | null }>} target.
 */
export async function resolveStartupTarget(options = {}) {
  const resolved = await resolveHomePreference({
    env: options.env ?? process.env,
    explicitHome: typeof options.codexHome === 'string' && options.codexHome.trim() !== '' ? options.codexHome : '',
    homeDirectory: options.homeDirectory,
  });
  return {
    home: resolved.home,
    source: resolved.source,
    reason: resolved.home === null ? 'no-codex-home'
      : (resolved.blocked === true ? (resolved.source === 'default' ? 'default-is-link' : 'default-unverified') : null),
  };
}

/**
 * The ONE precedence this module implements, shared by the seam and this helper.
 *
 * Having a single implementation is the point: a second copy is how the page came to
 * show one directory while the startup check upgraded another.
 * @param {object} input - `env`, `explicitHome` (may be '').
 * @returns {Promise<{ home: string | null, blocked: boolean, source: string }>} resolution.
 */
async function resolveHomePreference({ env, explicitHome = '', homeDirectory = undefined }) {
  if (explicitHome !== '') return { home: requireCodexHome(explicitHome), blocked: false, source: 'explicit' };
  const configured = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (configured !== '') return { home: requireCodexHome(configured), blocked: false, source: 'explicit' };

  const remembered = readInstalledCodexHome(env);
  if (remembered !== null) {
    const kind = await inspectDirectory(remembered);
    // The recorded directory is gone or is now a link: it is not a target any more, and
    // the default below decides on its own evidence.
    if (kind.kind === 'directory') return { home: remembered, blocked: false, source: 'recorded' };
  }

  const fallback = resolveCodexHome({ env, ...(homeDirectory === undefined ? {} : { homeDirectory }) });
  const kind = await inspectDirectory(fallback);
  // A default that does not exist is "no Codex installed here", not a target the plugin
  // may create: the automatic check has nothing to upgrade.
  if (kind.kind === 'missing') return { home: null, blocked: false, source: 'none' };
  if (kind.kind === 'directory') return { home: fallback, blocked: false, source: 'default' };
  // A link (or an unverifiable entry) at the default is reported, never walked.
  return { home: fallback, blocked: true, source: 'default' };
}

/**
 * Build the Codex seam for one plugin activation.
 *
 * @param {object} [options] - overrides; every one exists for a test or a host that
 *   resolves these differently, and none is part of the published plugin config.
 * @param {Record<string, string | undefined>} [options.env] - environment to read
 *   (`CODEX_HOME`, `DSH_HOME`, `DSH_DELEGATE_DISCOVERY_FILE`).
 * @param {string} [options.codexHome] - explicit Codex home, bypassing the env.
 * @param {string} [options.discoveryFile] - explicit discovery file path.
 * @param {string} [options.version] - version stamped into the managed agent file.
 * @param {string} [options.backupDir] - destination for a pre-write copy during an
 *   unattended upgrade; defaults to {@link defaultBackupDirectory}.
 * @returns {{ status: () => Promise<object>, run: (action: string) => Promise<object> }} seam.
 */
export function createCodexSeam(options = {}) {
  const env = options.env ?? process.env;
  const requestedHome = typeof options.codexHome === 'string' && options.codexHome.trim() !== ''
    ? options.codexHome
    : null;
  const requestedDiscovery = typeof options.discoveryFile === 'string' && options.discoveryFile.trim() !== ''
    ? options.discoveryFile
    : null;
  const version = typeof options.version === 'string' ? options.version : null;

  /**
   * Resolve the discovery file the MCP server will read.
   *
   * A relative `DSH_DELEGATE_DISCOVERY_FILE` is a deployment mistake; the installer
   * refuses it, and so does this resolver — falling back to the default would write
   * a Codex entry that silently points somewhere else.
   * @returns {string | undefined} absolute path, or undefined to let the installer resolve the default.
   */
  const discovery = () => {
    if (requestedDiscovery !== null) return requestedDiscovery;
    return resolveEndpointDiscoveryPath(env);
  };

  /**
   * Build the argument set for one installer call from a resolved home.
   *
   * The home arrives already resolved (see {@link resolveHome}) so a relative
   * `CODEX_HOME` is refused (`CODEX_HOME_INVALID`) instead of being resolved against the
   * harness's working directory — which would report on, and write to, the wrong tree.
   * @param {{ home: string | null }} resolution - resolved home.
   * @returns {object} installer options.
   */
  const baseFor = (resolution) => ({
    codexHome: resolution.home,
    env,
    ...(discovery() === undefined ? {} : { discoveryFile: discovery() }),
    ...(version === null ? {} : { version }),
  });

  /**
   * The ONE resolution every seam method uses.
   *
   * Before this existed, the automatic check consulted the recorded directory while
   * `status()` and the buttons consulted only `CODEX_HOME`/default — so removing
   * `CODEX_HOME` made the page report (and the buttons write) a DIFFERENT tree than the
   * one startup had just upgraded. Both now come from {@link resolveHomePreference}.
   * @returns {Promise<{ home: string | null, blocked: boolean, source: string }>} resolution.
   */
  const resolveHome = async () => await resolveHomePreference({ env, explicitHome: requestedHome ?? '' });

  return {
    /**
     * The Codex home this seam reports on, as ONE resolution shared by status, the
     * explicit actions and the automatic check (see `resolveHome`).
     *
     * `home` is `null` when no supported directory applies — the caller then refuses
     * instead of falling back to the default, so the page and the buttons can never point
     * at different trees.
     * @returns {Promise<{ home: string | null, blocked: boolean, source: string }>} resolution.
     */
    async resolveTarget() {
      return await resolveHome();
    },
    /**
     * Which home the AUTOMATIC startup check may target, and why.
     *
     * A thin view of {@link resolveTarget}: same precedence, plus a stable reason a
     * caller can log or display.
     * @returns {Promise<{ home: string | null, source: string, reason: string | null }>} target.
     */
    async startupTarget() {
      const resolved = await resolveHome();
      const reason = resolved.home === null ? 'no-codex-home'
        : (resolved.blocked === true ? (resolved.source === 'default' ? 'default-is-link' : 'default-unverified') : null);
      return { home: resolved.home, source: resolved.source, reason };
    },
    /**
     * Migrate a byte-exact, known prior agent template during plugin startup, and
     * upgrade an already-installed managed MCP entry that is merely stale.
     *
     * This never creates the agent file, never CREATES the MCP entry, never adopts a
     * same-name entry it cannot prove it wrote, and never edits another Codex setting.
     * @param {object} [callOptions] - `startupTarget`: the target `startupTarget()`
     *   returned, so startup does not silently fall back to a different home.
     * @returns {Promise<object>} migration outcome (`changed`, `refused`, `status`).
     */
    async refreshKnownAgent(callOptions = {}) {
      const resolved = await resolveTargetOptions(callOptions, baseFor, resolveHome);
      if (resolved.refused !== undefined) return { changed: [], refused: [resolved.refused], status: null };
      return await refreshKnownAgentTemplate(resolved.options);
    },
    /**
     * The startup integration check: both halves, one call.
     *
     * It never runs without a resolved home: when there is none, or the caller passed a
     * target with `home: null`, the answer is a stated refusal and NOTHING is read or
     * written — never a silent fall back to the default directory.
     * @param {object} [callOptions] - `startupTarget`, `backupDir`.
     * @returns {Promise<object>} migration outcome with `changed` including `mcp` when
     *   a stale managed entry was upgraded in place.
     */
    async refreshManagedIntegration(callOptions = {}) {
      const resolved = await resolveTargetOptions(callOptions, baseFor, resolveHome);
      if (resolved.refused !== undefined) return { changed: [], refused: [resolved.refused], status: null };
      // Precedence: the call's explicit scratch destination, then the seam's configured
      // one, then the plugin's own data directory. The last one is what makes a bare
      // `refreshManagedIntegration()` safe: an unattended upgrade still has somewhere to
      // put its pre-write copy, so the installer's backup precondition is met without
      // the caller having to know about it.
      const backupDir = typeof callOptions.backupDir === 'string' && callOptions.backupDir !== ''
        ? callOptions.backupDir
        : (typeof options.backupDir === 'string' && options.backupDir !== ''
          ? options.backupDir
          : defaultBackupDirectory(env));
      return await refreshKnownAgentTemplate({
        ...resolved.options,
        refreshMcp: true,
        backupDir,
      });
    },
    /**
     * Read the Codex state. Never writes.
     * @returns {Promise<object>} status document.
     */
    async status() {
      const resolved = await resolveTargetOptions({}, baseFor, resolveHome);
      if (resolved.refused !== undefined) {
        // No supported directory: report the refusal rather than the status of some
        // other tree. The user plane turns a thrown installer error into a 4xx/5xx.
        throw Object.assign(new Error(resolved.refused.message), { code: resolved.refused.code });
      }
      return {
        changed: [],
        refused: [],
        status: await readCodexStatus(resolved.options),
      };
    },
    /**
     * Perform one explicit operator action.
     *
     * A successful `install` is also the moment the plugin learns which directory is
     * really its target — including when it wrote nothing because the installation was
     * already exactly right (`changed: []` is a SUCCESS, not "nothing happened"). That
     * home is recorded so later startup checks and the page use the same tree, and a
     * non-default directory keeps working without the plugin ever scanning for one.
     * @param {string} action - `install`, `repair` or `remove`.
     * @returns {Promise<object>} outcome with `changed`, `refused` and `status`.
     */
    async run(action) {
      const resolved = await resolveTargetOptions({}, baseFor, resolveHome);
      if (resolved.refused !== undefined) {
        throw Object.assign(new Error(resolved.refused.message), { code: resolved.refused.code });
      }
      const outcome = await runCodexAction(action, resolved.options);
      const home = outcome.status?.codexHome ?? resolved.options.codexHome;
      // An install that was REFUSED records nothing; one that succeeded — changed or
      // already correct and idempotent — records the directory it was performed on.
      const installedCleanly = action === 'install' && outcome.refused.length === 0;
      if (installedCleanly && typeof home === 'string' && home !== '') {
        await rememberInstalledCodexHome(home, env);
      }
      return outcome;
    },
  };
}

/**
 * Resolve the installer options for one seam call.
 *
 * A caller-supplied `startupTarget` is honoured EXACTLY: with `home: null` the call is
 * refused, because the caller just told us that directory is not usable and substituting
 * the default would write to a tree nobody named. Without one, the seam's own unified
 * resolution applies.
 * @param {object} callOptions - `startupTarget`.
 * @param {Function} baseFor - the seam's installer-option builder.
 * @param {Function} resolveHome - the seam's unified home resolver.
 * @returns {Promise<{ options: object, refused?: object }>} installer options, or a
 *   refusal-shaped record the caller returns verbatim.
 */
async function resolveTargetOptions(callOptions, baseFor, resolveHome) {
  const supplied = callOptions?.startupTarget;
  if (supplied !== undefined && supplied !== null) {
    if (typeof supplied.home !== 'string' || supplied.home === '') {
      return {
        options: {},
        refused: {
          target: 'agent',
          code: 'CODEX_HOME_INVALID',
          message: 'the Codex startup target has no usable home, so the integration check was skipped instead of using the default',
          reason: supplied.reason ?? 'no-codex-home',
        },
      };
    }
    const resolved = await resolveHome();
    return { options: baseFor({ ...resolved, home: supplied.home, blocked: false }) };
  }
  const resolved = await resolveHome();
  if (resolved.home === null) {
    return {
      options: {},
      refused: {
        target: 'agent',
        code: 'CODEX_HOME_INVALID',
        message: 'no usable Codex home was found, so the integration check was skipped instead of writing to the default',
        reason: 'no-codex-home',
      },
    };
  }
  return { options: baseFor(resolved) };
}

/**
 * Resolve the seam a running plugin should expose.
 *
 * Returning `null` is a supported outcome: the user plane then answers with a 503
 * rather than pretending the integration exists.
 * @param {object} [options] - forwarded to {@link createCodexSeam}.
 * @returns {{ status: Function, run: Function } | null} seam, or null when disabled.
 */
export function resolveCodexActionSeam(options = {}) {
  if (options.disabled === true) return null;
  return createCodexSeam(options);
}
