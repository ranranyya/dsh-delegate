# Runtime compatibility

This document states which DSH runtimes this plugin build (`1.4.0`, package
`dsh-taskbridge-1.4.0.tgz`) may be loaded into, what changed in the newest one, and what
has and has not been verified on it. It is a compatibility note, not an acceptance
report; the package is distributed through npm and the GitHub Release. See the
[1.4.0 release notes](releases/1.4.0.zh.md) for upgrade details and the
[1.3.1 release report](releases/1.3.1.zh.md) for historical distribution verification.

`1.1.0` added silent waiting: the global `monitoring` thresholds (self-check and attention
intervals), bounded activity metadata on every task view, the authenticated monitoring
settings route and its Chinese controls, the task panel's bounded auto-refresh, the Codex
companion's submit → `delegate_wait` rules, and the managed MCP entry's owned
`tool_timeout_sec`.

`1.2.0` is a correction release on top of that behaviour, with no runtime-API change: an
interrupted OBSERVATION is no longer reported as an ended execution, a new independent
local control binary (`dsh-delegate-control status|cancel <taskId>`) talks to the same
loopback plane, and plugin startup now upgrades an ALREADY INSTALLED managed
`mcp_servers.dsh-delegate` entry that is merely stale. The supported runtime range below
and the execution implementation are carried over unchanged from `1.0.0`; the DSH `0.2.2`
compatibility described here was introduced by `0.1.12` and is historical fact for this
build.

**Historical 1.2.0 acceptance boundary, not a live installation inventory:** during
that release's checks, the operator's Desktop profile was on `1.1.0` and `1.2.0` had
not been installed into it. The 1.4.0 checks use isolated package installations and
temporary Codex homes; they do not establish that the operator's production Desktop
profile has been upgraded. The waiting-channel token comparison is measured separately
and does not represent whole-task or billing savings. See the 1.4.0 Release notes and
the [measurement report](releases/1.4.0-token-benchmark.zh.md) for their exact boundaries.
An older production profile must
be upgraded to this build, and the
Codex companion refreshed from the settings page (or by the startup check, which now also
upgrades the installed MCP entry) and Codex reloaded before the new wait rules and the
managed `tool_timeout_sec` take effect. No unit-test count and no mock constitutes an
acceptance run.

## 1. Supported versions

`engines.dsh` and every `@deepseek-ai/dsh-*` peer range are the **same exact union**,
and nothing else is admitted:

```
0.2.0-rc.2 || 0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.2-rc.1
```

| DSH runtime | Status in this build | Evidence |
| --- | --- | --- |
| `0.2.0-rc.2` | Supported; development and automated-test runtime | The repository's own test suite and native development cohort run on it. |
| `0.2.1-rc.2` | Supported; accepted in an **isolated** profile | Prior acceptance run in a temporary `DSH_HOME`; not the operator's production profile. |
| `0.2.1-rc.3` | Supported; previous host runtime | Declared by the previous host build. This build was **not** independently native-boot verified on `0.2.1-rc.3` during this task, so no full-profile check is claimed for it. |
| `0.2.2-rc.1` | Supported; the newest runtime this build adds | Native sources audited (`.cache/compat-022-20261107/reference-022`); native base+web bootstrap verified in isolated fixtures (`.cache/native022-host-*`). |

Additional rules:

- **DSH checks these ranges with prereleases included.** `@deepseek-ai/dsh-*` peer
  ranges are matched with `semver` plus `includePrerelease`, so an exact prerelease
  string is required; a caret or tilde would admit builds that were never exercised.
- **No version was dropped.** Every release admitted before this one is still admitted,
  and the automated tests assert that the manifest, both lockfiles and the table above
  agree with each other.
- **Any other DSH version is unverified.** Do not assume it works; the loader will
  refuse a plugin whose peer range does not match.
- **Older *plugin* builds are refused by the native gate.** The gate is checked against
  the plugin's declared ranges, so an older build (`0.1.11` and anything before it) that
  does not declare `0.2.2-rc.1` is *skipped* by a `0.2.2-rc.1` host
  (`skippedBundles` / a denied row) rather than loaded with unknown behaviour. Getting
  this build's behaviour on `0.2.2-rc.1` requires upgrading the plugin, not relaxing the
  gate.
- **Node.js `>= 24`** is required (`engines.node`), matching the DSH runtimes above.

## 2. What DSH 0.2.2 changes

Two native changes matter to this plugin. Both are described here as *what the runtime
provides*; the runtime-facing implementation lives in `src/runtime/` and is reviewed
separately from this note.

### 2.1 Durable agent model selection

DSH `0.2.2` gives each agent an explicit model-selection surface
(`@deepseek-ai/dsh-agent`, `lib/types/model-selection.js`):

| Member | Behaviour |
| --- | --- |
| `agent.model.select({ provider, model, reasoningEffort? })` | Appends a durable `model/selection` Session event. An unchanged selection is a no-op, so a repeated run does not grow the thread. |
| `agent.model.current()` | Returns the recorded selection (`pending ?? lastUsed` from the `modelSelection` projection, `stateVersion: 3`), falling back to the agent's own `options` until one is recorded, and `undefined` when neither states a route. |

The selection is *recorded state*, not a request argument. The agent loop fixes the
step's route from `agent.model.current()` before step preparation and then rejects an
`agent/request` that proposes a different provider, model or reasoning effort:

```
use agent.model.select() before step preparation
```

Two consequences the plugin has to respect:

- **Selection must be recorded before the prompt drives a step**, and the value that
  ends up in use is the one the runtime *records* — not the one the caller passed. A
  run that cannot read the recorded selection back cannot claim which route executed.
- **`reasoningEffort` is independently optional.** Omitting it means "adapter
  default", which is a distinct value from any concrete effort, so a selection that
  omits it must not be reported as a concrete effort.

### 2.2 Asynchronous native policy initialization

The two services this plugin's worker contract depends on are initialized
asynchronously in `0.2.2`:

- `ctx.sandboxPolicy` registers its `sandbox/mode` Session projection during service
  initialization and only then answers `resolve({ session })`;
- `ctx.approval` registers its `approval/policy` projection and only then answers
  `effectivePolicy(session)` / `decide(request, session)`.

A plugin that reads either service during *activation* therefore observes a service
that exists but is not yet able to answer. The contract is unchanged in kind — the
policy is still written and then read back through the native services — but the
read-back is per run, and a run whose services cannot answer is a fail-closed refusal
rather than a silent pass.

## 3. How the plugin adapts

The plugin supports both runtime generations from one build. It does **not** branch on
a version string; it branches on the **capabilities it can observe on the live agent and
services**, so a feature is used only when it is actually present.

| Capability | Modern (`0.2.2-rc.1`) path | Legacy (`0.2.0`–`0.2.1`) path |
| --- | --- | --- |
| Model selection | `agent.model.select(...)` before the prompt, then `agent.model.current()` read back and compared with the requested provider/model/effort. | `installModelSelection(agentCtx, ref)` applies the selection through the agent context on **every** run, including a resumed agent — it is not a creation option that is captured once at agent creation. That generation has no native model readback, so the plugin reports the route it requested and labels it as requested, not read back. |
| Policy read-back | `ctx.sandboxPolicy.resolve({ session })` and `ctx.approval.effectivePolicy(session)`, read per run after the services finish initializing. | The same two services, read the same way; the projection registration ordering differs, so the read is what proves the fold happened. |
| Per-call permission answerer | `ctx.on('approval/request', …)` on the run's own Agent scope, answered from the bridge; `ApprovalService.decide()` dispatches that waterfall after the session policy check. | The same waterfall and the same name; the legacy service reads the policy from the log instead of a projection, which does not change what the listener receives. |
| Missing capability | Fail closed: the worker run does not start. | Fail closed: identical refusal. |

Rules that hold in **both** paths:

- The policy is written once per run (including `continueFromTaskId` follow-ups) and
  then read back. A missing service, a refused read, or a read-back that disagrees with
  what was written is `RUN_SANDBOX_POLICY_UNAVAILABLE`, raised **before** the prompt.
- A model selection whose read-back cannot be obtained is a strict failure **before the
  prompt**, not a run under an unstated route. The plugin never reports a route it did
  not read back as "verified", and never claims a concrete reasoning effort for a
  selection that omitted one.
- The **modern model-selection adapter applies to the optional reviewer as well**: the
  review agent picks its own provider, model and effort through the same durable
  selection surface. What is worker-only is the **sandbox policy and the per-call
  permission bridge** — the reviewer is read-only, gets no bridge, and the worker's
  `workspace-write` / `never`/`ask` contract is not applied to it.
  "The policy and the bridge do not apply to review" is a statement about permissions,
  not about model selection.
- The approval stance is `ask` **only** for a run whose armed bridge is bound to the
  Agent it drives; every other run keeps `never`. Both stances are read back through
  `ctx.approval.effectivePolicy(session)` on both runtime generations, so an `ask`
  nobody services is never installed.

## 4. What *was* verified on `0.2.2-rc.1`, and what is not claimed

**Verified natively (host-run fixtures, not the production Desktop profile).** The full
`0.2.2-rc.1` base + web + delegate profile loads with no skipped bundles; a real stdio MCP
`initialize` returns that build's version with six tools and discovers the endpoint; `delegate_status`
works and an `OFF` submit is refused with `DELEGATION_DISABLED`; the real native
Workspace/Session controllers, Agent and AgentModel were used; the runner selected and
read back its route and effort before prompt delivery, a follow-up reused the native
session and changed both, and a deliberately wrong readback was refused before the prompt;
the native create/setup runner path also passed; the policy read back `workspace-write` /
`never`, and an escalation inside a valid turn was rejected in under a millisecond. Prompt
delivery was intercepted inside the disposable fixture, so these checks establish the
**contract**, not a delegated execution.

Earlier `SessionSeq` / `surfaceOp` failures recorded in intermediate runs were **test-driver
mistakes**: the synthetic event driver omitted native event sequence and surface metadata.
They were fixed in the driver with no product code change and are **not open product bugs**.

What remains genuinely unverified:

- **No real provider call.** No model turn was executed anywhere in these checks; prompt
  delivery was intercepted at the fixture boundary.
- **No actual sandbox command.** The policy was written and read back through the native
  services, but no worker command was run under it — the temp-directory and
  piped-stdio caveats below are properties of the native layer, not behaviours this task
  exercised end to end.
- **No production DSH Desktop installation of this build.** The operator's formally
  installed Desktop profile is still on `1.1.0`; installing `1.2.0` there and running a
  real delegated turn on that upgraded profile has **not** been done. Nothing in this
  repository establishes it, and no end-to-end acceptance of the upgraded Desktop profile
  is claimed.
- **`0.2.1-rc.3` was not re-validated here.** It stays declared as supported, but this
  task contains no independent native full-profile boot on that version.
- **Windows temporary-directory caveat.** DSH's own Windows sandbox layer admits the
  platform temporary directory (`GetTempPathW`) in some configurations, and its ACL
  helper keeps its locks under that same directory. That is a property of the native
  platform, **not** a write permission this plugin grants, and it is not a statement
  that a worker may write arbitrary temp paths. A temp parent inside the workspace is
  refused by the native layer itself.
- **Piped-stdio child processes are refused in this repository's confined Windows
  sandbox.** A check that spawns a Node child and captures its piped output hits
  `EPERM` there. That is a boundary of that confinement, not a failure of the
  compatibility work, and a skipped harness check is reported as skipped.

## 5. Upgrading from an older plugin build

1. Download `dsh-taskbridge-1.4.0.tgz` from the GitHub Release, or build the package locally (`npm pack`).
2. Install it the way your surface requires: the Desktop **Plugins manager** for a
   Desktop profile (npm/CLI operations on that profile are refused), or
   `dsh plugin --profile <name> add ./dsh-taskbridge-1.4.0.tgz` for a CLI profile you
   start yourself.
3. The settings, the switch value and the task history are preserved
   (`$DSH_HOME/data/dsh-delegate`); nothing is migrated destructively.
4. If the Codex companion was installed, no action is needed: a `0.1.11` — or `0.1.10` —
   agent file whose bytes still match a published template is refreshed automatically on
   startup, or explicitly from the Codex panel. A file you edited is left untouched.
5. To roll back, re-install the older `.tgz`. The data directory is not deleted, but an
   older plugin build will be skipped by a `0.2.2-rc.1` host's native gate (section 1),
   so rolling back the plugin means staying on an older DSH as well.

## 6. Where this is enforced

| Claim | Enforced by |
| --- | --- |
| The exact runtime union in `engines.dsh` and every `@deepseek-ai/dsh-*` peer | `tests/package.test.js` ("the manifest keeps its identity…", "peer constraints declare exactly the verified DSH runtimes") |
| Both lockfiles' root metadata match `package.json` | `tests/package.test.js` ("the lockfile pins the same dependency set…") |
| This table matches the manifest, in both directions | `tests/package.test.js` ("the supported-version table is the one the manifest admits") |
| A published `0.1.11` or `0.1.10` agent is refreshed, an edited one is not | `tests/codex-integration.test.js` |


