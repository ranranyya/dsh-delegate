# Changelog

## 1.1.0 — silent waiting and concentrated host review

Candidate feature release. Ships the monitoring foundation, the browser settings and task
panels, the Codex companion's wait-based dispatch rules and the managed Codex config
migration. It is **not** published and **not** installed by this change.

The transport that actually returns `delegate_wait` results (HTTP execution-plane and MCP
tool) lands in the same release but a separate change; until both are present, the
companion's new rules describe the contract the tool will honour, and the legacy
`delegate_result` polling path still works.

### Waiting no longer means polling

- New global setting `monitoring = { selfCheckSeconds: 300, attentionSeconds: 600 }`,
  stored as whole seconds, validated (self-check 30–3600, attention greater than the
  self-check and at most 7200). Missing blocks use the defaults, so an existing
  document keeps loading unchanged.
- A running task now reports bounded activity metadata: last activity time, how long it
  has been idle, the current tool call and how long it has run, event counters, and the
  last self-check verdict. It carries **no** transcript, reasoning, tool arguments or
  diff, so a task view can show progress without becoming a second transcript.
- At the self-check interval the engine performs one read-only local inspection of the
  executor it already holds (alive, phase, pending permission, current tool). No model
  call, no workspace read, no state change, no deadline change.
- At the attention interval it reports `attention` instead of staying silent. Idle time
  is the only trigger: a single long tool call is not proof of progress, and nothing is
  failed, cancelled or restarted for duration alone.
- Real progress resets the silence and stays internal, so a healthy run never wakes the
  dispatcher. Connection heartbeats, result polling and page refreshes never reset it.
- Attention reports are delivered once per silence and then cooled down; concurrent
  observers cannot both deliver the same one.

### Settings page

- New advanced monitoring controls in the existing execution panel: 5 and 10 minutes by
  default, shown in minutes, stored as integer seconds, with local validation and a
  narrow "save monitoring only" action. A general settings save persists them too.
- The page states the behaviour it relies on: the checks are local, no LLM is called,
  no-progress is not failure, and changes apply to newly submitted tasks only.
- New authenticated route `POST /api/dsh-delegate/monitoring`. It is a browser-plane
  operator action; the MCP surface still has no settings write.

### Task records

- Task rows and the detail view show the phase, the last activity, the current tool and
  its elapsed time, and the no-progress diagnostic in plain Chinese. A record written
  before this feature says "no progress information was collected" instead of inventing
  an idle time.
- The task tab refreshes itself every 5 seconds **only** while it is visible and at least
  one task is still pending or running. It skips a hidden document, never overlaps a
  request, cleans up its timer on tab change and unmount, and never reads or writes
  settings. Terminal tasks stop the refresh.
- No completion percentage is estimated or displayed.

### Codex companion

- Dispatch is now submit → `delegate_wait` on the same task id, repeated until a reason
  is actionable. `heartbeat` is internal and never reaches the model.
- Each reason has a stated policy: `attention` is a question and the default answer is to
  keep waiting; `permission` is a decision on one call followed by waiting the same task;
  `ready`/`failed`/`cancelled` read `delegate_result` once for full evidence;
  `interrupted` and `wait-limit` immediately re-wait the same task.
- Corrections are consolidated into a follow-up `continueFromTaskId` submission using the
  same authorized source path.
- Explicitly forbids the parent commander and the dispatch companion from implementing
  locally while a delegated worker runs, except for an explicit user-authorized takeover.

### Managed Codex config

- The managed `[mcp_servers.dsh-delegate]` entry now carries `tool_timeout_sec = 3660`,
  so a default 60-minute wait can complete. The value is written on this entry only.
- A managed entry from an earlier release without the field is repaired in place, and
  unrelated configuration is preserved byte for byte. An unmarked or differently shaped
  same-name entry is still treated as operator-owned and never overwritten.
- The published 1.0.0 companion is enumerated by exact SHA-256 (CRLF and LF byte forms),
  so an existing 1.0.0 installation updates through the settings page instead of being
  reported as somebody else's file.

### Known limits

- This release does not promise zero model tokens or a measured token saving. It changes
  what a dispatcher is told and when.
- Wait-return counts and timing metrics come from the transport change, not from this one.

## 1.0.0 — first formal release

The first public major release of `dsh-delegate`. It is distributed from the GitHub
Release as `dsh-delegate-1.0.0.tgz`.

- Adds the commander-mediated, per-call permission decision tool while keeping the
  local switch as the single enable/disable control.
- Publishes the Codex companion migration for existing managed `0.1.14` installations.
- Includes workspace isolation, continuation placement, model/provider selection,
  optional read-only review, Codex integration, and the documented fail-closed runtime
  checks.
- Production Desktop provider execution, sandbox commands, and permission-resume flows
  remain explicitly marked as unverified where the compatibility documents say so.

## 0.1.14 — local build (candidate package, not a public release)

Per-call, commander-mediated approval for delegated worker runs, plus the release
packaging that was deferred from the core batch. The package is built and packed locally
as `dsh-delegate-0.1.14.tgz` for review; it is **not** published to npm and it is **not**
installed on the production Desktop profile.

### Status: what is and is not proven

- **Proven by tests in this repository:** the bridge, its refusals, its redaction, its
  deadlines, the durable evidence and the MCP projection all pass their own suites, and
  the archived manifest contains the updated native module, the sixth MCP tool, the current
  client bundle, the managed Codex companion and the docs.
- **NOT yet proven: production acceptance.** The `0.1.13` build currently installed on the
  production Desktop profile must be upgraded through the Desktop plugin manager, and the
  MCP server must be reconnected (or a new session started) before the sixth tool
  `delegate_permission_decide` is visible to a host. Until a real end-to-end
  provider → commander → resume run has been observed on that profile, the production
  feature is **unverified**. A passing unit-test count, and any mock or scripted stand-in,
  is **not** that test and must not be reported as one.

### The worker can now ask for wider access for ONE call, and only the commander answers

Every delegated worker run previously installed `approval/policy: "never"`, because the
plugin had no way to answer a native approval prompt: an escalation was refused
deterministically. That is still the default. What is added is one narrow, armed path:

- A new module `src/runtime/permissions.js` holds the bridge. While the commander follows
  a task, a native DSH approval request (`ctx.on('approval/request', …)` on that Agent's
  own scope) **pauses exactly that tool call**, and the request is exposed through the
  existing `delegate_result` view as `permission.pending`.
- The real operation is read from the **native Session log**: the committed `tool/call`
  event is matched by `callId` and its model-produced `arguments` JSON is parsed. The
  asker's own `reason` prose is carried beside it labelled `reasonSource: "asker-claim"`
  and is never treated as the operation.
- A new bounded MCP tool `delegate_permission_decide` (route
  `POST /dsh-delegate/x/tasks/permission`) answers `allow-once` or `reject`. It refuses an
  unknown task, another connection's task, an unknown or already-settled request, a
  request past its deadline, and a fingerprint that does not match the pending operation.
- The approval stance is `ask` **only** when the run carries an armed bridge bound to the
  Agent it drives; otherwise it stays `never`. Both are written and **read back** through
  `ctx.approval.effectivePolicy(session)`, so an `ask` nobody services is never installed.
  A bridge that cannot be armed refuses the run before the prompt with
  `RUN_PERMISSION_BRIDGE_UNAVAILABLE`.
- The standing sandbox mode stays `workspace-write` for the whole run; no decision writes
  `danger-full-access` into a Session, and a grant is `appliesTo: this-call-only`,
  `reusable: false`.

### State, lifetimes and evidence

- Task state semantics are unchanged: a waiting task is still `running`, with phase
  `awaiting-permission` and a `permission` block. It is neither failed nor
  execution-complete, and it keeps its workspace lock, concurrency slot and provider
  lease until the native executor actually settles.
- The approval wait has its **own** fixed, bounded deadline (default 10 minutes, capped at
  30) and is NOT charged to `worker.timeoutSeconds`; `permission.pausedExecutionMs`
  reports the time actually spent waiting.
- Cancellation, switch-off, revocation, agent disposal, plugin teardown and that deadline
  all settle the outstanding waiter and release the request's timer and abort listener.
  A restart begins with no tasks, no bridge and no request, so an interrupted request can
  never be replayed as an allow.
- The settled trail is bounded (last 8) and every published string is redacted and
  truncated; the exact private fingerprint still binds the decision.

### UI, docs and contracts

- The task panel shows, in plain Chinese, that a task is waiting on one call, the
  redacted arguments, the worker's claimed reason (labelled as a claim), the deadline and
  the decision trail. It offers **no** manual approve button: the decision belongs to the
  commander over MCP.
- `SPEC.md` states the narrow exception to the "MCP cannot widen a grant" rule, including
  what the tool cannot do. `docs/worker-permissions.md`, `docs/auth-contract.md`,
  `docs/runtime-compatibility.md` and `README.md` are updated to match, and the
  same-local-user threat-model limitation is stated rather than glossed over.
- `tests/permissions.test.js` covers the bridge against the installed native
  `ApprovalService`: locating the real call, the `ask`/`never` stance split, allow-once
  resuming one call exactly once and the next escalation asking again, reject, expiry,
  fingerprint substitution, redaction, cancellation, disposal, foreign requests, the
  engine's phase/slot behaviour, cross-owner and post-terminal refusals, restart, and the
  plane route's validation and switch gate.

### Repair round: independent review R1–R9

The provisional review found that several claims were not backed by behaviour. Each is now
a checked fact with a regression test:

- **R1 (live re-verification).** A decision no longer trusts the copy captured at ask time.
  An `allow-once` re-reads the `tool/call` at its recorded Session offset and requires
  byte-identical arguments, the same `callId`, the same tool name, and a turn that is still
  OPEN. A mutated record, a missing record and a closed turn are all
  `PERMISSION_REQUEST_CHANGED`. (The turn check had to scan from the END of the log — a scan
  starting at the call would stop at the `turn/start` behind it and never see a later close.)
- **R2 (key-aware redaction).** A key whose NAME holds a credential has its whole value
  masked, so `{"apiKey":"…"}` can no longer be published verbatim; the module's default
  redaction now also mirrors the production `NAME=value` / bearer patterns so a bridge built
  without injection is not weaker. Applied to the pending view, the decision reason and the
  stored trail.
- **R3 (completeness gates an allow).** Every bound that fires is counted, and the request
  publishes `completeness` / `argumentsComplete` / `boundsApplied` / `omitted` /
  `allowBlocked`. An `allow-once` on a shortened operation (a `bash.command` whose tail was
  cut) is refused with `PERMISSION_EVIDENCE_INCOMPLETE`; `reject` stays available because
  refusing is always safe.
- **R4 (exact Agent identity).** `owns()` now requires the exact bound live Agent object and
  rejects a request with no Agent at all — the previous `agent ?? null` check made a missing
  agent match every bridge.
- **R5 (honest wording).** "The worker cannot self-approve" is restated as a **tool-surface
  restriction**, explicitly NOT a hard boundary against arbitrary same-OS-user code; the
  shared `local-mcp` identity and the absence of a user-managed token are stated, and no
  claim rests on a caller-supplied role label.
- **R6 (the execution deadline really pauses).** The single `setTimeout` is replaced by
  `ExecutionDeadline`: a wait clears the timer and charges the elapsed span, resume re-arms
  only what is left, and repeated waits accumulate. A regression drives a REAL native
  approval wait of 220 ms inside a run whose budget is 40 ms and proves the run is not
  reported `timed_out`.
- **R7 (durable evidence).** `HistoryStore.projectView` now stores a bounded, re-redacted
  `permission` block. A restart rewrites a stored pending request as
  `unavailable` / `decidedBy: "restart"` history; the private fingerprint and exact argument
  text are never stored, so a record cannot be replayed into an allow.
- **R8 (waterfall ordering).** The bridge registers its `approval/request` listener with
  `prepend: true`, because the native seam is a cordis waterfall and an appended listener
  never runs once a pre-existing UI answerer claims the question. Proven against a real
  `ApprovalService` with a pre-existing answerer: the delegated request reaches the
  commander, the UI answerer is never consulted, and an ordinary session still falls through
  to its own answerer.
- **R9 (proto-safe hashing).** The fingerprint is computed over a hand-written canonical
  serializer instead of a `JSON.stringify` replacer, so a key named `__proto__` is no longer
  swallowed by the prototype setter and two different JSON objects cannot collide.
- **Fingerprint is mandatory for `allow-once`** (optional for `reject`), and decisions are
  validated before any request lookup or mutation.
- Also proven behaviourally, not by constants: switching delegation OFF settles the wait as
  `cancelled`, a plugin dispose settles it as `unavailable`, and a task whose native executor
  has not settled keeps its workspace lock and concurrency slot (`JOB_NATIVE_NOT_STOPPED`).

`tests/permissions.test.js` grew from 25 to 51 tests covering all of the above.

### Release packaging in this build

- Version `0.1.14` is set consistently in `package.json`, both `package-lock.json` root
  fields, the native `PLUGIN_VERSION`, the MCP `SERVER_INFO`, the managed Codex companion's
  `version` marker and the release-test constants.
- The managed Codex companion now carries the commander's **per-call decision rules**:
  a task in phase `awaiting-permission` is still running (never duplicate, fail or cancel it
  for waiting), the coordinating Codex is the decider (no second approval model, no operator
  prompt for routine within-task calls, no delegation of the decision to the worker), the
  worker's `reason` is a claim rather than authority, and an allow requires
  `argumentsComplete: true`, `completeness: complete`, no `allowBlocked`, no transport
  truncation, a still-pending request and its exact fingerprint. Its existing activation,
  explicit-continuation, route-from-DSH and source-path rules are unchanged.
- The published `0.1.13` companion template is now enumerated in `KNOWN_AGENT_TEMPLATES`
  by its exact SHA-256 (`b3a1d2f0…`, 9191 bytes, CRLF, verified against the packed
  `dsh-delegate-0.1.13.tgz`). An unchanged `0.1.13` file is refreshed; a file the operator
  edited still hashes differently and is preserved and reported `modified`. There is no
  implicit new installation and no startup edit of `config.toml` or the MCP entry.
- Two small corrections: a fully restored pending operation no longer reports a phantom
  `truncation.fields` entry at the skeleton projection stage (only real final cuts are
  reported, and a genuinely cut operation still cannot be allowed), the zero-keep stage
  really drops the settled evidence it declares dropped, and a successful task checkpoint is
  no longer discarded by a *different* task's newer checkpoint.

### Known unfinished work (not claimed as solved in this build)

- **No process authentication against arbitrary same-user code.** Switch mode
  deliberately uses one shared `local-mcp` identity; the decision is scoped to that
  connection's OWN tasks, but this is not a per-process boundary and the docs say so.
  `delegate_permission_decide` is absent from the native worker's declared tool catalog,
  which is a **tool-surface restriction** on what the worker's model is handed — it is not
  a claim that a shell process running as the same OS user could not call the shared local
  MCP endpoint directly.
- **Not published and not installed.** This is a candidate package: no npm publication, no
  Desktop profile upgrade, no switch change, no production acceptance run. See the status
  section above for the exact steps still required.
- 12 test failures in `tests/continuation-auth.test.js` (11) and
  `tests/controller-lifecycle.test.js` (1) are **pre-existing** in the source baseline
  (`ff`-identical failure sets before and after this batch) and are unrelated to it.

## 0.1.13 — local build (not a public release)

A source-path contract fix. It is packed locally for review; it is not published to npm
and is not a distribution release. Nothing about the execution engine changed.

### The MCP description no longer invites the wrong `workspacePath` on a follow-up

Observed on a real Desktop `0.2.2` / Delegate `0.1.12` session: a caller read the tool
description, passed the **previous task's execution worktree** as `workspacePath`, and
was refused with `JOB_CONTINUATION_REFUSED` (`another source repository`). The engine was
already correct — an authorization and a continuation are both bound to the source
repository, and a continuation reuses the parent's worktree internally — so the defect
was purely in what the tool surface told the caller. Passing the original source
repository instead continued the same session successfully on the same machine.

- `delegate_submit`'s description, the `workspacePath` and `continueFromTaskId` parameter
  descriptions, and the `initialize` instructions now state one rule: `workspacePath` is
  the operator-authorized **source repository or checkout**, and a follow-up keeps
  passing the parent's **original** source path while the plugin reuses the parent's
  execution worktree or session internally.
- The rule is scoped to `delegate_submit` and continuation. It does not claim every tool
  is bound to the authorization (`delegate_preflight` is a read-only inspection), and it
  does **not** exclude legitimate sources: a source root may itself be a Git checkout or
  an operator-authorized Git worktree. Only substituting an internal
  `execution.workspacePath` for the parent's original source path is refused.
- The wording is a clarification only. No parameter, tool or behaviour was added; the
  five-tool closed set, the closed input schemas and every path / ownership / isolation
  check in the engine are unchanged, and no validation was relaxed.
- `tests/mcp.test.js` gains a public-contract regression that reads the real `initialize`
  and `tools/list` responses off a real server — not a private constant — and asserts the
  source-path rule for both parameters plus the handshake, the automatic internal reuse,
  the fail-closed refusal (never a silent new conversation), the unchanged tool set and
  the closed schema. It asserts properties rather than exact sentences.

### Codex agent-template migration

- The published `0.1.12` template is now enumerated in `KNOWN_AGENT_TEMPLATES`
  (`ff04a4bf…`). The digest was verified byte for byte, before this release's template
  edit, against `package/codex/dsh-delegate.toml` inside the packed
  `dsh-delegate-0.1.12.tgz` and against the saved release baseline; both were identical
  to the pre-fix working tree. An unchanged `0.1.12` file is refreshed to `0.1.13` on
  plugin startup and by an explicit install.
- **No earlier digest was removed or replaced.** The `0.1.6`, both `0.1.7` builds,
  `0.1.8`, `0.1.9`, both `0.1.10` byte forms and `0.1.11` remain enumerated, so a machine
  that skipped `0.1.12` is migrated directly to this build.
- Ownership is still byte identity, never the version line: a user-edited agent file is
  reported `modified` and is never written, refreshed or removed, by startup migration or
  by an explicit install. The `0.1.11` migration coverage is retained and generalized, and
  the `0.1.12` → `0.1.13` step is covered for startup refresh, explicit status/install,
  and edit preservation.
- Because the companion body did not change in this release, the older release bytes are
  rebuilt for the tests from the current template by rewriting only the version line, and
  against an explicitly stated CRLF byte form; each reconstruction is proved against a
  fixed published digest. The tests depend on no saved cache, fixture or machine-specific
  path.

### Packaging and metadata

- Version bumped to `0.1.13` in `package.json`, both `package-lock.json` root fields,
  `PLUGIN_VERSION`, the MCP `SERVER_INFO` and the shipped Codex agent template
  (`codex/dsh-delegate.toml`). `README.md` and `docs/codex-integration.md` name the
  current package and release; historical release facts are unchanged.
- No dependency was installed or upgraded, no locked `resolved` version moved, the
  production dependency graph and `pnpm-lock.yaml` are unchanged, and no agent body rule
  was edited.

### Known unfinished work (not claimed as solved)

- **Not verified:** `0.1.13` has not been installed or accepted on a Desktop profile. The
  successful three-round real-machine continuation evidence belongs to **`0.1.12`**, the
  previous build, and is the reason this fix exists — it is not an acceptance of this
  build.
- The delegation switch being `OFF` and cancellation of an in-flight task were **not**
  exercised against this build; their coverage here remains the earlier automated tests.
- Real attached review (a review agent reading a live run) was not exercised in this
  build.
- The wording is regression-tested as a property of the advertised strings, not against a
  live model's interpretation; only a real host session can show how a caller reads it.

## 0.1.12 — local build (not a public release)

A runtime-compatibility build for DSH `0.2.2-rc.1`. It is packed locally for review;
it is not published to npm and is not a distribution release.

### DSH 0.2.2-rc.1 is now an admitted runtime

- `engines.dsh` and every `@deepseek-ai/dsh-*` peer range now read
  `0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.2-rc.1`.
- **Nothing was dropped.** Every previously declared exact version is still admitted;
  the development cohort (`devDependencies`, all `0.2.0-rc.2`) is unchanged, the
  production dependency graph is unchanged, and no locked `resolved` version moved.
  No `pnpm install` was run.
- A plugin build that does not declare `0.2.2-rc.1` (`0.1.11` and earlier) is skipped by
  that host's native gate (`skippedBundles` / denied row) rather than loaded with
  unknown behaviour.

### What 0.2.2 changed, and how the plugin adapts

Detailed in the new `docs/runtime-compatibility.md`; the runtime implementation is
reviewed separately from this release-metadata work.

- **Durable model selection.** `0.2.2` gives each agent
  `agent.model.select({ provider, model, reasoningEffort? })`, which appends a durable
  `model/selection` event, and `agent.model.current()`, which returns the recorded
  selection (falling back to the agent's own options). The agent loop fixes a step's
  route from that record and rejects a request that proposes a different one, so the
  route that executes is the one the runtime *records*.
- **Asynchronous native policy initialization.** `ctx.sandboxPolicy` and
  `ctx.approval` register their Session projections during service initialization. The
  worker contract is unchanged — write, then read back through the native services —
  but the read-back now happens per run, after those services can answer, and a service
  that cannot answer remains the fail-closed `RUN_SANDBOX_POLICY_UNAVAILABLE` raised
  before the prompt.
- The plugin branches on **observed capabilities**, not on a version string: a modern
  path where the selection API and the initialized services exist, a legacy path
  otherwise. A selection read-back that cannot be obtained is a strict failure before
  the prompt on every path — never a run under an unstated route, and never a claimed
  concrete reasoning effort for a selection that omitted one.

### Codex agent-template migration

- The published `0.1.11` agent template is now enumerated in
  `KNOWN_AGENT_TEMPLATES` (`b6ca7c32…`, the digest of the packed
  `dsh-delegate-0.1.11.tgz`). An unchanged `0.1.11` file is refreshed to `0.1.12` on
  plugin startup and by an explicit install; a user-edited file is still reported
  `modified` and is never written, refreshed or removed.
- **`0.1.10` now carries two exact digests instead of one.** The packed
  `dsh-delegate-0.1.10.tgz` contains a CRLF `package/codex/dsh-delegate.toml`
  (`fc7b2710…`); the same template kept as LF text is `6583f08a…`. Either form can be an
  installed file, so both are enumerated and neither replaces the other. The product
  compares exact bytes: it never normalizes line endings and never rewrites a file to
  change them, and no earlier hash was removed.
- `0.1.11` was delivered as an uncommitted candidate plus a verified tarball (the last
  commit, `a750c0b`, is `0.1.10`), so its digest `b6ca7c32…` is cited from the tarball and
  the saved baseline, not from a `0.1.11` commit.
- Ownership protection is unchanged and is not weakened: content identity, not the
  version line, remains the proof, and every earlier digest is still enumerated.

### Packaging and metadata

- Version bumped to `0.1.12` in `package.json`, both `package-lock.json` root fields,
  `PLUGIN_VERSION`, the MCP `SERVER_INFO`, and the shipped Codex agent template
  (`codex/dsh-delegate.toml`).
- `docs/runtime-compatibility.md` is added to the published `files` allowlist. Unlike
  the internal notes, it is an operator-facing document: it is the supported-version
  table and the upgrade guidance a consumer needs.

### Documentation

- New `docs/runtime-compatibility.md`: the supported-version table, what `0.2.2`
  introduces, the capability-based modern/legacy split, the upgrade path, and an
  explicit list of what is *not* claimed.
- `README.md`: the supported-version row, the version-gate note, the `0.2.2` behaviour
  summary and the honest limits section.
- `docs/codex-integration.md`: the digest table for `0.1.10` (both byte forms) and
  `0.1.11`, and the statement that the product does not normalize line endings.
- `docs/worker-permissions.md`: the `0.2.2` asynchronous initialization note, and the
  corrected scope of the review exclusion (only the sandbox policy is worker-only; the
  reviewer uses the same model-selection adapter).

### Known unfinished work (not released as solved)

- **Not verified:** a real provider call, an actual sandbox command under the installed
  policy, and an end-to-end run on the production DSH Desktop profile. The native checks
  below intercepted prompt delivery inside a disposable fixture.
- `0.2.1-rc.3` was **not** independently native-boot validated for this release. It stays
  declared as supported on the strength of the previous host build.
- The OS temporary area remains a native platform exception; on Windows the native
  sandbox admits `GetTempPathW` in some configurations, which is not a permission this
  plugin grants.
- Node child-process checks that capture piped stdio hit `EPERM` in this repository's
  confined Windows sandbox; that is a boundary of that confinement.
- A verification run outside the Desktop process is not evidence about the Desktop
  process's own sandbox.

### Native verification on 0.2.2-rc.1 (contract checks, not an acceptance run)

- The full base + web + delegate profile loads with no skipped bundles; a real stdio MCP
  `initialize` returns `0.1.12` with five tools and discovers the endpoint;
  `delegate_status` works and an `OFF` submit is refused with `DELEGATION_DISABLED`.
- Real native Workspace/Session controllers, Agent and AgentModel were used. The runner
  selected and read back its route and effort before prompt delivery, a follow-up reused
  the native session and changed both, and a deliberately wrong readback was refused
  before the prompt. The native create/setup runner path also passed.
- The policy read back `workspace-write` / `never`, and an escalation inside a valid turn
  was rejected in under 1 ms.
- The `SessionSeq` / `surfaceOp` failures seen in intermediate runs were **coordinator
  test-driver mistakes** — the synthetic event driver omitted native event sequence and
  surface metadata. They were fixed in the driver with no product code change and are not
  open product bugs.

## 0.1.11 — local build (not a public release)

A permission and continuity build. It is packed locally for review; it is not
published to npm and is not a distribution release.

### Delegated worker sessions are confined and verified

- A worker run now installs `sandbox/mode: workspace-write` and
  `approval/policy: never` on its own DSH session **before** the prompt is
  delivered, and then **reads the policy back** through the native
  `ctx.sandboxPolicy.resolve({ session })` and
  `ctx.approval.effectivePolicy(session)` services.
- The policy is applied on every run, including a `continueFromTaskId` follow-up, so
  a resumed thread converges on the current contract.
- A missing service, a refused read, or a read-back that disagrees with what was
  written is a fail-closed refusal (`RUN_SANDBOX_POLICY_UNAVAILABLE`) raised before
  the prompt: the worker does not start, and no permissive default is substituted.
- `never` is deterministic rejection of an escalation, not automatic approval.
- The read-only review agent is unchanged: its own composition and tool surface are
  not affected by worker permissions.

### Path identity

- The sandbox module compares a session's workspace root with its own directory
  through the shared `sameSessionPath` identity instead of a private copy, so
  Windows separators, trailing slashes, root paths and letter case are judged in one
  place. The fail-closed checks and the policy read-back are unchanged.

### Worktrees stay in the plugin data directory

- Plugin-managed worktrees continue to live under
  `<dataDir>/worktrees`, inside the plugin's persistent data directory, so a review
  still finds the evidence and a follow-up still finds its parent tree. No real
  directory or ACL was changed by this release.

### Packaging and metadata

- Version bumped to `0.1.11` in `package.json`, both `package-lock.json` root fields,
  `PLUGIN_VERSION`, the MCP `SERVER_INFO`, and the shipped Codex agent template
  (`codex/dsh-delegate.toml`).
- The endpoint-discovery error no longer hard-codes a release version in its text.
- The native packages the tests load directly are now declared as devDependencies:
  `@deepseek-ai/dsh-sandbox-policy`, `@deepseek-ai/dsh-user-approval`,
  `@deepseek-ai/dsh-session-projection`, `@deepseek-ai/dsh-session` (all
  `0.2.0-rc.2`, matching the existing development cohort) and
  `@deepseek-ai/cordis` (`4.0.5`, as already locked). Both lockfiles were updated in
  place from entries that already existed; no dependency was upgraded.
- The Codex agent-template migration table still lists every earlier published hash
  and still refuses to touch a user-modified file.

### Continuations belong to one verified connection

- A `continueFromTaskId` follow-up may join a thread only when the **same verified
  `connectionId`** submits it. The caller's identity is the authenticated connection
  record, never a field the request states about itself.
- In the same process the live parent record states the owner and the outcome, and the
  two ids are compared exactly.
- After a restart the persisted task→session map only says where a thread lives, so a
  second authority is consulted: the durable job history (`HistoryStore`) must state
  the same owner, a terminal state a thread can be continued from, and the same
  source repository and execution directory.
- A missing, damaged, pruned or otherwise unprovable record is refused. So is another
  connection's task: it is reported as `JOB_TASK_NOT_FOUND`, indistinguishable from an
  unknown id, so the response cannot be used to probe other connections' task ids.
  There is no cross-connection take-over, no permission hand-off, and no matching by
  connection label.
- `local-mcp` (the local-switch path) is a fixed identity compared exactly like any
  other; it is not `null` and it does not stand for every remote connection.
- This capability is implemented in the current candidate build. Its acceptance is
  reported separately by Codex; this changelog does not claim a passing real install
  on DSH Desktop, nor a reproduced real attack.

### Documentation

- `README.md`: current package filename, a short summary of the worker permission
  contract, the continuation identity rule, and the stale test count removed.
- `docs/worker-permissions.md`: the full contract, the continuation ownership rule,
  what was verified, and what is still open.

### Known unfinished work (not released as solved)

- Real-install acceptance on DSH Desktop.
- The OS temporary area remains a native platform exception.
- Node child-process checks that capture piped stdio currently hit `EPERM` in this
  repository's confined Windows sandbox; that is a boundary of that confinement, not
  a failure of the approval fix.
- A verification run outside the Desktop process is not evidence about the Desktop
  process's own sandbox.
