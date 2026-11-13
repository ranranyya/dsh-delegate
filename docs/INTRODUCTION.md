# DSH TaskBridge

Let Claude Code or Codex direct DSH tasks. Choose the execution API, model and supported reasoning effort in the DSH plugin settings.

The host plans, dispatches and reviews; DSH executes using the effective configuration. Follow-up corrections explicitly continue the same task conversation and execution checkout. Providers come from DSH's existing API connections, without copying their credentials into the plugin.

The settings include the local delegation switch, worker model/effort, task timeout, concurrency, workspace isolation, project overrides and optional additional read-only model review. A newly installed plugin starts with delegation disabled. Runtime/model capability checks remain authoritative.

The quiet wait observes execution inside the program and returns at actionable boundaries. Pending wider-permission calls are presented to the commander for a single-call decision. Completion is evidence for host review, never automatic host acceptance.

Codex has an existing managed agent/MCP installation button. Claude Code connects using standard stdio MCP; see [the manual guide](claude-code.md). A Claude one-click installer and native client mention selection are not promised.

Version 1.3.1 adopts DSH TaskBridge and the package identity `dsh-taskbridge`, replacing `dsh-delegate` and the GitHub-only `dsh-taskdispatch` 1.3.0. Read the [upgrade guide](taskbridge-upgrade.md) before replacing an old installation. Historical data, MCP tools, environment variables and the Codex `dsh-delegate` technical identifier remain compatible. Do not run old and new bundles together.

In DSH's Add plugin dialog, use `dsh-taskbridge@1.3.1`; use the official npm registry if a regional mirror has not synchronized yet. Distribution also uses GitHub releases and a [DSH custom plugin index](plugin-market.md) pinned to exact Git commits. This is not universal official marketplace inclusion. Actual token savings and a full real Desktop update/restart have not been measured.
