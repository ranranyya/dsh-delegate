# Coordinator acceptance plan

The coordinator will review diffs and rerun meaningful checks independently.
Worker self-tests and Crew completion are delivery evidence, not acceptance.

## Required checks

- Fresh process and restart: delegation off; an MCP dispatch creates no native
  agent and no network model request. Neither a job boolean nor Origin can grant.
- Per-task grant: exactly one concurrent dispatch consumes it; the second fails.
  Grants do not survive restart, disconnect, revoke or expiry. New connections
  cannot reuse an older connection's grant. Retry consumes a new grant.
- Control and execution APIs: external MCP exposes only the agreed execution/read
  tools and cannot call user-only mutation paths. Invalid UI auth/CSRF rejected.
- Routing: explicit selected provider/model/effort reaches the native agent.
  Missing provider, unsupported effort or unavailable model refuses, with no
  fallthrough to official defaults. Running tasks retain their config snapshot.
- Lifecycle: normal completion, model error, timeout, pending agent creation,
  cancellation and simultaneous jobs all release handles and workspace locks.
- Review: when disabled, no reviewer agent/request. When enabled, separate
  provider/model/effort and actually read-only tools/workspace; findings returned
  without self-acceptance or automatic repair. Review errors stay distinct.
- Changes: real changed file/diff and actual check evidence visible. A job reports
  awaiting host review after successful execution, never host-approved by itself.
- Secrets: masked config and exports, no secrets in MCP/history/errors or package.
- UI: settings section actually mounts in a DSH web profile, all four areas and
  authorization operate, draft/error/loading feedback works. Verify new providers
  and manual model IDs, effort capabilities, review toggle and task details.
- Package: install .tgz in an isolated DSH_HOME using supported CLI, launch on an
  unused port, confirm native plugin/client registration and fresh off state,
  connect the MCP adapter, exercise authorization and cancel, uninstall cleanly.
- No writes to the official user profile or existing release. Existing Crew is
  used only to execute development work and is returned to dispatch-off afterward.

## Integration fixture expectation

Prefer a local deterministic OpenAI-compatible fixture with sufficient token
budget and optional tool calls to test actual DSH integration without exporting
real API keys. Unit mocks alone do not establish native runtime compatibility.
Use a temporary git repository for mutating/worktree checks. Any unsupported
runtime/isolation mode must be explicit and safe rather than simulated success.

## Release evidence

Record supported runtime version, commands/results, install smoke, archive
contents, SHA256, known limits and worker workflow IDs. Copy final source archive,
npm package and concise Chinese installation guide into the Codex outputs folder.
