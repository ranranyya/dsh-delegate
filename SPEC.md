# DSH Delegate v0.1 requirements

## Product and scope

Deliver an installable **DeepSeek Harness plugin**, not a Codex native plugin.
The human talks with Codex; Codex plans and reviews. This plugin is the DSH-side
configuration, authorization and execution service. A small MCP adapter exposes
bounded dispatch/status/result/cancel tools to Codex and other MCP hosts.

The user explicitly authorized DeepSeek execution of this implementation.
Codex owns architecture, inspection, acceptance and final integration; for
implementation tasks in this repository, the latest specified DSH route was
`workbuddy/deepseek-v4.1-flash` at reasoning effort `high` or `max`. This
development-task preference is not a product default: the Codex companion must
use the effective route selected in the DSH plugin.

Develop in this isolated repository, not the installed Crew release. Existing
Crew and DSH sources may be inspected as API references. Preserve licenses for
any reused code. Do not edit C:/Users/24615/.dsh, existing installed releases,
credentials, registry, startup entries or live host registrations.

## Required behavior

1. A fresh install starts with delegation OFF. The persisted switch is restored
   on restart; installing the plugin or mentioning DeepSeek never enables it.
   Codex normally executes its own tasks unless the user explicitly requests
   delegation.
2. DSH UI exposes one local-call switch. ON allows local MCP task submissions;
   OFF rejects new submissions and requests cancellation of live tasks. Status,
   result reads and cancellation remain available while OFF.
3. MCP tools do not expose configuration, credential, grant or switch writes and
   require no issued connection token. The execution plane is loopback-only.
   While enabled, another process running as the same local user may still call
   it; the switch is an operator control, not per-process authentication or a
   same-user security boundary. Browser control writes remain protected by the
   native DSH session and origin fence.

   **Narrow, explicit exception — per-call permission decisions.** The rule above
   forbids the external surface from widening a grant. One tool is authorized to
   answer a permission question, and only this way: while a delegated worker is
   actively followed, a native DSH approval request pauses *that exact tool call*;
   the request is exposed through the existing `delegate_result` view; and the
   bounded tool `delegate_permission_decide` answers it `allow-once` or `reject`.
   That tool:

   - consumes an **already pending** per-call request only — it cannot create a
     request, and with nothing pending it refuses;
   - applies to **one** native tool call, identified by task, Session, tool name,
     a non-reusable request id, the native `callId`, and an exact fingerprint of
     the real tool arguments read from the Session log (never from the worker's
     prose);
   - is **single-use**: the decision settles the request, a duplicate or late
     decision is refused, and the next escalation asks again;
   - **cannot** create or widen an account/workspace/session grant, change
     settings, credentials, the local-call switch, the provider/model, the
     reasoning effort or the isolation, and cannot approve any future operation;
   - is **not** an automatic allow-all rule, an LLM/API reviewer, or a
     human-click workflow. The current commander decides; there is no second
     model in the loop and no required click;
   - leaves the worker's standing sandbox mode at `workspace-write` for the whole
     run and never writes `danger-full-access` into a Session;
   - is **not part of the native worker's preset tool surface**, so the worker's model is
     never handed it. That is a *tool-surface restriction*, **not** a hard boundary
     against arbitrary code running as the same OS user: switch mode deliberately uses
     one shared `local-mcp` identity with no user-managed token, and this exception
     does not turn that into a per-process boundary. Nothing here relies on a
     caller-supplied role label.

   A run with **no** armed bridge keeps the deterministic `never` approval
   stance: its escalation is rejected without waiting, exactly as before. What
   this exception does *not* claim is process authentication against arbitrary
   code running as the same local user — switch mode deliberately uses one shared
   `local-mcp` connection identity, and this tool does not turn that into a
   per-process boundary.
4. Provider selection comes from DSH's registered provider list. Model and
   reasoning-effort choices come from exact DSH model metadata; the plugin does
   not ask users to copy API endpoints or credentials. It never returns DSH
   secrets in public config, MCP, job history or logs.
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
   a retry requires the local switch to be ON and never silently resubmits work.

   A task waiting for a per-call permission decision is **still `running`**, with
   phase `awaiting-permission` and a `permission.pending` block in its view. It is
   neither failed nor execution-complete, it keeps its workspace lock and
   concurrency slot until the native executor actually settles, and the approval
   wait is charged to a separate, bounded request deadline (fixed default 10
   minutes) instead of the worker's execution timeout. Cancellation, switch-off,
   revocation, agent disposal, plugin teardown and that deadline all settle the
   outstanding wait with a refusal and restore the timers; a restart begins with
   no bridge and no request, so an interrupted request is history only and is
   never replayed as an allow.
9. Connectivity checks: separate HTTP/auth/catalog success from an actual model
   response. Allow a practical token budget, recognize reasoning-only responses,
   return bounded redacted diagnostics; do not repeat the maxTokens=1 false timeout.
10. DSH settings UI: one local-call switch above four areas: DSH API selection,
    execution settings, additional review and task records. Plain Chinese labels,
    usable form controls, explicit save/errors/loading and actual effective
    values. Do not ask users to re-enter DSH provider credentials.
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
13. Optional Codex custom-agent companion: install only through an explicit command,
    writing `CODEX_HOME/agents/dsh-delegate.toml` (or `~/.codex/agents` when unset).
    Do not edit `config.toml` or register MCP implicitly. Refuse to overwrite a
    different same-name agent; remove only the unchanged bundled template. The
    agent dispatches only on explicit user intent, checks the DSH switch first,
    omits per-task route overrides so DSH applies its selected worker settings
    and matching project overrides, and never falls back to Crew or another
    route. Report the actual route from the result. Do not claim direct
    `@dsh-delegate` invocation unless the active Codex surface officially
    supports it.

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
