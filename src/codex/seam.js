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
//   * status only reads and run forwards an explicit operator action. The sole
//     startup write is `refreshKnownAgent`, which refreshes a byte-exact shipped
//     template and never creates a file or edits config.toml.

import { runCodexAction, readCodexStatus, refreshKnownAgentTemplate, resolveCodexHome } from './installer.js';
import { resolveEndpointDiscoveryPath } from '../runtime/endpoint-discovery.js';

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
   * Build the argument set for one installer call.
   *
   * The Codex home is resolved *before* the call so a relative `CODEX_HOME` is
   * refused (`CODEX_HOME_INVALID`) instead of being resolved against the harness's
   * working directory — which would report on, and write to, the wrong tree.
   * @returns {object} installer options.
   */
  const base = () => ({
    codexHome: requestedHome === null ? resolveCodexHome({ env }) : requestedHome,
    env,
    ...(discovery() === undefined ? {} : { discoveryFile: discovery() }),
    ...(version === null ? {} : { version }),
  });

  return {
    /**
     * Migrate a byte-exact, known prior agent template during plugin startup.
     * This never creates the file or edits Codex MCP configuration.
     * @returns {Promise<object>} migration outcome.
     */
    async refreshKnownAgent() {
      return await refreshKnownAgentTemplate(base());
    },
    /**
     * Read the Codex state. Never writes.
     * @returns {Promise<object>} status document.
     */
    async status() {
      return {
        changed: [],
        refused: [],
        status: await readCodexStatus(base()),
      };
    },
    /**
     * Perform one explicit operator action.
     * @param {string} action - `install`, `repair` or `remove`.
     * @returns {Promise<object>} outcome with `changed`, `refused` and `status`.
     */
    async run(action) {
      return await runCodexAction(action, base());
    },
  };
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
