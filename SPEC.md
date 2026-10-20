# DSH Delegate v0.1 requirements

## Product and scope

Deliver an installable **DeepSeek Harness plugin**, not a Codex native plugin.
The human talks with Codex; Codex plans and reviews. This plugin is the DSH-side
configuration, authorization and execution service. A small MCP adapter exposes
bounded dispatch/status/result/cancel tools to Codex and other MCP hosts.

The user explicitly authorized DeepSeek execution of this implementation.
Codex owns architecture, inspection, acceptance and final integration; the
executor for this project is relay / deepseek-v4.1-flash only.

Develop in this isolated repository, not the installed Crew release. Existing
Crew and DSH sources may be inspected as API references. Preserve licenses for
any reused code. Do not edit C:/Users/24615/.dsh, existing installed releases,
credentials, registry, startup entries or live host registrations.

## Required behavior

1. Default: delegation is OFF, including after restart. Merely installing the
   plugin or mentioning DeepSeek must not dispatch work. Codex normally executes
   its own tasks. Enabling DSH capability does not imply a user request to delegate.
2. DSH UI is the user control surface. A visible authorization control grants
   a selected external connection one task (default) or the current connection
   session. It displays pending connection identity, scope and state, and allows
   revoke. The server enforces the grant, not just UI or agent instructions.
3. MCP tools must NOT expose grant/enable/config-write/credential-write APIs.
   Authorization belongs to a separate authenticated DSH user control path.
   A caller-supplied Origin or a boolean such as user_approved is NOT proof of
   authorization. Bind grants to server-issued connection identities and enforce
   scope, atomic consumption, cancellation, expiry and restart revocation.
   Browser CSRF/cross-origin writes must be rejected. State threat limits honestly:
   an agent with the same OS account and unrestricted filesystem is not an
   adversarial security boundary.
4. API settings: manage multiple provider profiles with name, base URL, protocol,
   credential reference or masked secret input, model list retrieval and manual
   model IDs. Never return secrets in public config, MCP, job history or logs.
   Reuse supported DSH credential/provider services where feasible. At minimum
   support OpenAI-compatible Chat Completions endpoints including the existing
   relay; other protocols may use existing DSH adapters if actually supported.
5. Worker settings: independently choose provider, model, supported reasoning
   effort, timeout, maximum parallelism and workspace isolation. Per-model effort
   capabilities are explicit; reject unsupported combinations rather than silently
   ignoring them. Store validated settings with schema version and safe writes.
   Support global settings plus project overrides and bounded per-job overrides,
   with the effective snapshot visible in job details. No automatic fallback by
   default, and no hidden use of Harness Default.
6. Optional additional model review: OFF by default, separate from authorization.
   It has its own provider, model and effort. When ON, an independent read-only
   review examines the delivered diff/evidence. It cannot approve on behalf of
   Codex, execute mutating tools or trigger an infinite repair loop. Return the
   review findings to the host; the host decides any follow-up task.
7. Real execution through native DSH agents/tools: create a bounded native agent,
   set its explicit provider/model/reasoning, execute in the requested approved
   workspace, collect output/tool events/result, and dispose on completion,
   failure, timeout or cancel. Implement or clearly refuse unsupported isolation;
   do not label shared execution as isolated or read-only. Default worktree
   isolation requires a committed git repository. Do not let two jobs mutate the
   same workspace concurrently.
8. Task history: pending/running/awaiting-host-review/failed/cancelled and separate
   extra-review outcome. Show actual provider/model/effort, changed file summary,
   diff and validation evidence, time and available usage. Execution completion
   must NOT mean host acceptance; host acceptance is a distinct explicit action
   or is left to Codex and labeled honestly. Cancel and explicit retry supported;
   a retry must have valid authorization, never silently reuse a consumed grant.
9. Connectivity checks: separate HTTP/auth/catalog success from an actual model
   response. Allow a practical token budget, recognize reasoning-only responses,
   return bounded redacted diagnostics; do not repeat the maxTokens=1 false timeout.
10. DSH settings UI: authorization control above four areas: API management,
    execution settings, additional review, task records. Plain Chinese labels,
    usable form controls, masked secrets, explicit save/errors/loading and actual
    effective values. Do not expose implementation details in ordinary user flows.
11. Shipping: installable npm .tgz with DSH bundle patch, native backend entry,
    DSH settings client entry, MCP executable, README with installation/use,
    supported runtime versions, configuration/secret handling, upgrade/export
    behavior, uninstall/rollback and limits. No credentials, node_modules or
    local-only absolute paths in the package. Include meaningful automated tests
    for auth enforcement, routing/effort, read-only review, lifecycle/cancellation,
    redaction, isolation, MCP/control-plane separation and package contents.
12. Configuration presets/export: export nonsecret settings; allow saving reusable
    execution/review combinations. Credentials remain separate. Existing jobs use
    their immutable effective configuration snapshot.

## Development constraints and available reference installation

- Windows PowerShell and Node 24 are available. Run git with native PowerShell
  tools; spawning git from Node inside the Crew sandbox may fail EPERM.
- Existing Crew source (read-only):
  C:/Users/24615/.config/dsh-crew/app/releases/20261019T153530Z-2240-1-2.2.19
- DSH native APIs, README and types (read-only):
  C:/Users/24615/.config/dsh-crew/harness/runtime/node_modules/.pnpm/node_modules/@deepseek-ai
- The installed private DSH runtime is 0.2.0-rc.2. Global DSH is 0.2.1-rc.2.
  Determine supported APIs from actual sources. Record the API evidence.
- Prefer a small standalone companion implementation reusing native DSH services;
  avoid a wholesale reimplementation or copy of Crew. If a required native API
  cannot support the design, document the concrete blocker and alternatives.
- Install project dependencies only within this repository. Never print API keys.
- You are not alone in the workspace. Do not revert other people's edits.
- Do not spawn subagents, change scope or commit/push. Return actual evidence.
- Expected worker report: ## Diff, ## Tests, ## Risks. Tests must include lines
  such as PASS | actual command | observed result. Do not self-approve final work.

## Delivery stages

A. Native integration audit, backend config/auth/job engine, focused meaningful
   tests, and documented UI/MCP contracts. Codex reviews before broad UI work.
B. DSH native settings UI, MCP adapter, installer/package/docs and remaining tests.
C. Address Codex findings, run the independent acceptance checks, package the
   release, and verify in an isolated DSH profile. No automatic installation into
   the user's official profile and no external publication.
