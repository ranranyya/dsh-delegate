# DSH TaskBridge

Version 1.4.1 adds review after restart, confirmed persistence, 8000-code-point review notes and compact waiting with on-demand full-note reads. Install `dsh-taskbridge@1.4.1` or use its release tarball. See the [release notes](releases/1.4.1.zh.md).

Let Claude Code or Codex direct DSH tasks. Choose the execution API, model and supported reasoning effort in the DSH plugin settings.

The host plans, dispatches and reviews; DSH executes using the effective configuration. Follow-up corrections explicitly continue the same task conversation and execution checkout. Providers come from DSH's existing API connections, without copying their credentials into the plugin.

The settings include the local delegation switch, worker model/effort, task timeout, concurrency, workspace isolation, project overrides and optional additional read-only model review. A newly installed plugin starts with delegation disabled. Runtime/model capability checks remain authoritative.

The quiet wait observes execution inside the program and returns at actionable boundaries. Pending wider-permission calls are presented to the commander for a single-call decision. Completion is evidence for host review, never automatic host acceptance.

Version 1.4.0 clarifies long outer waits and continuation of the same running call, adds a configurable repeated-tool-failure reminder (3 by default; 0 disables it), and lets the host explicitly record an accepted or changes-requested decision with `delegate_review`. Task records display that decision instead of remaining indefinitely awaiting review.

Codex has a managed agent/MCP installation button. Version 1.3.2 names the companion `dsh-taskbridge` and migrates unchanged published legacy companions. New DSH Workspaces use the task's work-content title; explicit follow-ups keep the original Workspace and conversation. Claude Code connects using standard stdio MCP; see [the manual guide](claude-code.md). A Claude one-click installer and native client mention selection are not promised.

Version 1.3.1 adopts DSH TaskBridge and the package identity `dsh-taskbridge`, replacing `dsh-delegate` and the GitHub-only `dsh-taskdispatch` 1.3.0. Read the [upgrade guide](taskbridge-upgrade.md) before replacing an old installation. Historical data, MCP tools, environment variables and the Codex `dsh-delegate` technical identifier remain compatible. Do not run old and new bundles together.

In DSH's Add plugin dialog, use `dsh-taskbridge@1.4.1`; use the official npm registry if a regional mirror has not synchronized yet. Distribution also uses GitHub releases and a [DSH custom plugin index](plugin-market.md) pinned to exact Git commits. This is not universal official marketplace inclusion. A single same-model, approximately 45-second waiting comparison reduced recorded waiting-response tokens by 66.58% (3 model responses to 1); this is not a full-task or billing reduction. See the [measurement report](releases/1.4.0-token-benchmark.zh.md). Client time limits and full Desktop upgrade behavior require environment-specific verification.
