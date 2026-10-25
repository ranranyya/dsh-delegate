# Codex integration contract

Status: implemented in 0.1.8. Scope: Codex only. Claude Code and other hosts are
out of scope and no surface for them is provided.

This document is the contract between the plugin's settings page (browser half),
the host-side installer (`src/codex/installer.js`) and the two files it manages.
It is written so a reviewer can check the code against it without reading the
README.

---

## 1. What is owned, and what is not

| Path | Owner | The plugin may | The plugin may never |
| --- | --- | --- | --- |
| `$CODEX_HOME/agents/dsh-delegate.toml` | managed copy of `codex/dsh-delegate.toml` | create it **exclusively** when absent; refresh it when it is **byte-identical to a known shipped build** (enumerated digests, `KNOWN_AGENT_TEMPLATES`); delete it on `remove` only after re-reading it and finding the same bytes it classified | overwrite or delete a file that is not that exact build — including a file with an old version line whose body was edited, and including a file that changed in the window between the status read and the removal |
| `$CODEX_HOME/config.toml`, table `mcp_servers.dsh-delegate` | operator, with one managed entry | add the entry when absent; update `command`/`args`/its own `env.DSH_DELEGATE_DISCOVERY_FILE` when the entry carries **the plugin marker** *and* is the exact shape this plugin writes | touch any other key, table, comment or ordering; adopt, update or delete an unmarked same-name entry, even one whose values coincide |
| `$CODEX_HOME` and `$CODEX_HOME/agents` | Codex | read them (lstat **and** the Windows file attributes); create `agents` (`0700`) when both are real directories | create them relative to the process working directory; **follow a link at either level** (POSIX symlink, Windows junction/reparse point) for any read-through, write or delete |
| DSH local-call switch | operator | report it | change it |

`$CODEX_HOME` resolution: `CODEX_HOME` when set and absolute; otherwise
`~/.codex`. A relative override is refused (`CODEX_HOME_INVALID`), because
resolving it against the harness's cwd would report on, and write to, a directory
nobody named.

### 1.1 Link boundaries

`lstat` on the final file is not enough: if `$CODEX_HOME/agents` is a junction,
`mkdir -p` and the file create walk *through* it and write
`agents/dsh-delegate.toml` outside the Codex home entirely. Both directories are
therefore inspected as *boundaries*:

| `$CODEX_HOME` | `$CODEX_HOME/agents` | result |
| --- | --- | --- |
| real directory | missing | normal: install creates `agents` (`0700`) |
| real directory | real directory | normal |
| real directory | link (symlink or junction) | `agent.state = conflict`, `reason = agents-dir-is-link`; install/repair/remove all refuse with `AGENT_PATH_CONFLICT` |
| link | not inspected (nothing below a link is examined) | `agent.state = conflict`, `reason = codex-home-is-link`; same refusal |
| could not be verified | — | `agent.state = conflict`, `reason = boundary-unverified`; same refusal |

A **junction** is the case `lstat` cannot see: Windows reports it as an ordinary
directory. On Windows the `ReparsePoint` file attribute is read through one
`powershell.exe` child (`-NoProfile -NonInteractive`, hidden, 15 s bound), with the
paths passed in an environment variable rather than interpolated into script text.
The child answers one comma-separated verdict per path — `dir/<bool>`, `other/<bool>`
or `missing` — and the boolean is PowerShell's `Boolean.ToString()` output, whose
spelling is **not** stable (`True`/`False` on Windows PowerShell 5.1, `true`/`false`
under other hosts/cultures). The verdict is therefore parsed case-insensitively
(`parseDirectoryVerdict`), the script emits lower case via `ToLowerInvariant()`, and
anything that is not a recognised `dir/`/`other/`/`missing` answer is treated as
`other` (a path this plugin will not write under), never as a missing answer.
A regular directory — `dir/false` in any spelling — is `directory`, so the ordinary
Windows layout is unaffected; only `dir/true` / `other/true` are reported as a link.
This is pinned by a real-directory probe test that runs the actual PowerShell child on
a temporary directory on Windows (and skips elsewhere), not only through the test
classifier hook.

The status document reports this as `boundary: { blocked, link, unknown, home,
agents }`. A **failed** verification is a refusal, not a pass: if the platform
answer cannot be obtained (no spawnable shell, no PowerShell), the boundary is
`unknown` and every action refuses, because "could not check" must never be read
as "safe". The check is re-done at the start of every writing action from the
freshly read status, so a link that replaced either directory after the operator
last looked is still refused.


---

## 2. The MCP entry

The owned shape, written as a marked block:

```toml
# dsh-delegate: managed by the DSH Delegate plugin settings page
[mcp_servers.dsh-delegate]
command = "<a Node.js executable, resolved as described in 2.1>"
args = ["<installed package>/bin/dsh-delegate-mcp.js"]
```

* `command` is an **absolute path to a Node.js executable**, never a bare `node` and
  never the desktop application. A GUI-launched Codex often has a narrower `PATH`
  than the shell that started DSH, so a bare `node` fails at spawn time; and in the
  DSH Desktop (Electron) host `process.execPath` is `DeepSeek Harness.exe`, which
  would make Codex launch a second GUI instead of an MCP server. Section 2.1 states
  how the executable is chosen and what happens when no candidate can be proved.
* `args[0]` is derived from `import.meta.url` of the running module, so it names
  the *installed* package — never a repository checkout and never a path captured
  when the tarball was built.
* `env.DSH_DELEGATE_DISCOVERY_FILE` is written only when DSH uses a non-default
  discovery location (`DSH_HOME` set, or `DSH_DELEGATE_DISCOVERY_FILE` set). The
  default stays implicit so a later `DSH_HOME` change is not silently overridden.

### 2.1 The `command` executable (`resolveNodeExecutable`)

The host is classified first (`hostRuntimeKind`): `process.versions.electron` makes
it an **electron** host; `process.resourcesPath` (set by Electron and by nothing in
plain Node.js) is an equivalent desktop signal; otherwise it is a **node** host.

| host | `process.execPath` | selected `command` |
| --- | --- | --- |
| plain Node.js | `node`/`node.exe` | that path, unchanged — it is the runtime that loaded this plugin |
| plain Node.js, `execPath` is not a Node binary | an embedded host binary | falls through to the desktop rules below, never `execPath` |
| DSH Desktop (Electron) | `DeepSeek Harness.exe` | the DSH **bundled runtime**, below |

The bundled runtime is
`<resources>/runtime/primary-runtime/dependencies/node/bin/node.exe` on Windows and
`…/bin/node` elsewhere (`packagedNodePath`). `<resources>` is `process.resourcesPath`
when the host exposes it; otherwise it is derived from the application executable as
`<dirname(execPath)>/resources` — the layout DSH Desktop installs into
(`…\DeepSeek Harness\resources\…` beside `…\DeepSeek Harness\DeepSeek Harness.exe`).

If the bundled runtime is not there, these environment variables are consulted **in
this order**, and the first usable one wins:

| variable | accepted when |
| --- | --- |
| `DSH_NODE_PATH` | an absolute path |
| `DSH_NODE_EXECUTABLE` | an absolute path |
| `CODEX_MCP_NODE_PATH` | an absolute path |

"Usable" is strict: the value must be **absolute**, its basename must be a Node
binary (`node`, `node.exe`, or a versioned `node-*.exe`), and `lstat` must report an
existing **regular file**. A relative path, a directory, a link and a missing file
are each rejected with a reason, and their rejection does not stop the next
candidate from being tried.

**Fail closed.** When no candidate is usable, `resolveNodeExecutable` throws
`CodexInstallError('MCP_EXECUTABLE_UNRESOLVED')`. The desktop application executable
and a bare `node` are never substituted. The status document reports this instead of
throwing: `mcp.node = null`, `mcp.nodeResolved = false`, `mcp.nodeError = { code,
message, details }`, `mcp.state = unreadable` (`reason: no-executable`), `ready =
false`, plus an `MCP_EXECUTABLE_UNRESOLVED` note. `install` and `repair` refuse the
MCP target with `MCP_EXECUTABLE_UNRESOLVED` and leave `config.toml` byte-identical;
the agent file is an independent target and is still installed.

### 2.1 Classification

`classifyMcpEntry` locates the definition (block or inline), then decides:

| state | meaning | install |
| --- | --- | --- |
| `not-configured` | no `mcp_servers.dsh-delegate` at all | writes the block |
| `configured` | the marker is present **and** the values are exactly the owned shape | no change |
| `outdated` | marked owned command, but stale `args`/discovery; or the narrowly recognised 0.1.6 Desktop command with the current package `args` and owned env shape | rewrites only those values in place |
| `conflict` | anything else (`unmanaged-entry`, `command-not-ours`, `legacy-command-shape`, `url`, `unknown-field`, `extra-env`, `args-not-an-array`, `command-not-a-string`, `not-a-table`, `array-table`) | **refuses** with `MCP_ENTRY_CONFLICT` and a note explaining why |

Two rules are deliberate:

* **`unmanaged-entry`.** Values alone never establish ownership. An entry without
  the marker comment — even one whose `command`/`args` are byte-identical to what
  the plugin would write — is the operator's. It is reported as a conflict, and
  `install`, `repair` and `remove` all leave it byte-identical. The marker must be
  the comment line directly above the definition (or above the `[mcp_servers]`
  header when the definition is the inline `dsh-delegate = { … }` spelling); a
  marker elsewhere in the file does not count.
* **`command-not-ours`.** A different command is a different program, so even
  identical arguments do not make the entry ours. `extra-env` is symmetrical — an
  `env` key the plugin did not write is the operator's data, and an entry carrying
  one is reported as a conflict rather than pruned.

* **0.1.6 Desktop migration.** Version 0.1.6 could write the DSH Desktop GUI as
  `command`. A marked entry is eligible for one automatic migration only when its
  command has a path whose case-insensitive basename is exactly `DeepSeek Harness.exe`,
  its `args` already name this installed package's `bin/dsh-delegate-mcp.js`, and its
  env keys and values exactly match the currently owned shape. The installer then
  reports `outdated` and replaces only the command with the proven Node runtime.
  A bare GUI name, a similarly named executable, stale args, extra env or any other
  command remains `conflict` and is left byte-identical.

### 2.2 Merge mechanics

`src/codex/toml.js` locates structure by line and column ranges and edits only
those ranges. It is a locator, not a validating TOML implementation, and it
refuses (`TomlSyntaxError`, carrying a line number) rather than guess:

* an unterminated single-line string, array or inline table;
* a table header with trailing text;
* a raw control character (0x00–0x08, 0x0A–0x1F except tab) **anywhere other than
  as a line ending** — see below;
* text after a table header, an unbalanced bracket, a key without `=`.

**CRLF.** A Codex config touched by a Windows editor is normally CRLF. The locator
splits on `\n` only, treats a *terminal* `\r` as the second byte of a line ending
(it is skipped wherever whitespace would end a token), and every mutation re-joins
with the document's detected ending. Installing, updating and removing an entry in
a CRLF file therefore preserves CRLF and leaves every unrelated byte — comments,
settings, table order — exactly as it was. A `\r` **inside** a line (a broken or
mixed-ending file) is still a control character and still refuses the document as
a whole.

A refusal makes the whole action refuse (`CODEX_CONFIG_UNSUPPORTED`) and leaves
the file byte-identical. Nothing is ever written with a parsed-then-serialized
round trip, so comments and ordering cannot be lost.

Writes land through `writeFileAtomic` (temp file + rename), so a crash leaves the
previous or the new full document, never a partial one. A *first* agent file is
created with `link`, which fails when the target exists: a file that appears
between the status read and the write is reported (`AGENT_PATH_CONFLICT`,
`created-concurrently`) instead of being replaced.

### 2.3 Removal

`remove` deletes the `mcp_servers.dsh-delegate` table (header, assignments, child
tables and the plugin marker line) and the agent file when — and only when — that
file is the managed template or a byte-exact known prior build. Comments the
operator wrote *above* the marker stay; the marker itself is the plugin's line.
A `conflict` or `modified` target is reported and left untouched, including an
unmarked same-name entry. Removing twice is a no-op.

**The agent file is re-proved immediately before it is unlinked.** The status read
is stale by the time a removal runs: the operator, an editor or another tool may
have rewritten the file after the verdict. Deleting on the strength of that verdict
would destroy the new content, so `removeManagedAgentFile` reads the file again and
requires all of:

* it is still a **regular file** (not a link, not a directory) — otherwise
  `AGENT_PATH_CONFLICT` (`reason: not-a-regular-file`);
* it still exists — otherwise `AGENT_PATH_CONFLICT`
  (`reason: missing-before-removal`), reported as "no change", never as a deletion;
* its bytes are **exactly** the content the status derived its verdict from
  (`agent.expect`) — otherwise `AGENT_USER_MODIFIED`
  (`reason: modified-before-removal`) and the file is kept.

Only then is `unlink` called. A file that *looks* managed but differs by one
character is therefore refused, and an unlink the filesystem refuses (`EPERM`,
`EACCES`, `EBUSY`) is reported as `AGENT_PATH_CONFLICT` (`reason: unlink-refused`)
rather than thrown at the operator.

---

## 3. Actions and their guarantees

Reachable only through the authenticated user plane (section 4) or the CLI
`bin/dsh-delegate-codex-agent.js`.

| action | writes | never writes |
| --- | --- | --- |
| `status` | nothing | anything |
| `install` | agent file (absent / older managed build) + MCP entry (absent / `outdated`) | a user's agent file, a conflicting MCP entry, the DSH switch |
| `repair` | the MCP entry only (absent / `outdated`), exactly as `install` would | the agent file: it is **not created, not refreshed and not deleted**, nor is `agents/` created |
| `remove` | deletes only owned targets | a user's agent file, a conflicting entry |

`install` is idempotent: a second run with nothing changed reports
`changed: []` and does not rewrite either file.

`install` reports the agent and MCP targets independently. One may succeed while
the other is refused (for example: no agent file yet, but a conflicting entry), and
the response says exactly which. The same holds for an unresolvable executable:
the agent file is still installed, and the MCP half is refused with
`MCP_EXECUTABLE_UNRESOLVED` (section 2.1).

**`repair` is MCP-only.** It is the action behind the settings page's
「仅修复 MCP 配置」 button and is the same code path `install` uses for its MCP half.
It never touches the agent file, so with a missing agent it reports
`agent.state = not-installed` and changes nothing, with an `outdated` agent it leaves
that file byte-identical (it stays `outdated`), and with a `modified`/`conflict` agent
it does not even report an agent refusal — the agent is simply out of this action's
scope. Concretely, `repair`:

* returns `changed` containing `mcp` (or nothing) and never `agent`;
* does not create `$CODEX_HOME/agents` when it is missing;
* still refuses a `conflict` MCP entry with `MCP_ENTRY_CONFLICT`, exactly like `install`.

Updating a stale agent is therefore always an explicit `install`.

**No write happens on plugin load, on package install, or when the settings page
opens.** The page's `init()` issues a `GET`; the three buttons are the only
callers of the `POST`.

---

## 4. Routes

One exact path, two methods, registered on `ctx.connection.fetch` (the
authenticated operator channel):

| method | path | body | result |
| --- | --- | --- | --- |
| `GET` | `/api/dsh-delegate/codex` | — | `{ ok, action: 'status', changed: [], refused: [], codex, switch }` |
| `POST` | `/api/dsh-delegate/codex` | `{ "action": "install" \| "repair" \| "remove" }` | `{ ok, action, changed, refused, codex, switch }` |

Refusals use the standard envelope and these codes: `CODEX_ACTION_INVALID` (400),
`CODEX_HOME_INVALID` (400), `CODEX_CONFIG_UNSUPPORTED` (409),
`CODEX_CONFIG_UNREADABLE` (409), `CODEX_INTEGRATION_UNAVAILABLE` (503). A refusal
*per target* is not an HTTP error: it appears in `refused[]` with a stable `code`
(`AGENT_USER_MODIFIED`, `AGENT_PATH_CONFLICT`, `MCP_ENTRY_CONFLICT`,
`MCP_SCRIPT_MISSING`, `CODEX_CONFIG_UNSUPPORTED`) and the action still answers 200
with the fresh status, because "I did not touch your file, and here is why" is a
successful diagnosis.

`codex` (status document):

```jsonc
{
  "codexHome": "…",
  "packageVersion": "0.1.8",
  "boundary": { "blocked": false, "link": null, "unknown": false, "home": "directory", "agents": "directory" },
  "agent": {
    "path": "…", "state": "installed", "installed": true, "managed": true,
    "reason": null, "expect": "<the exact bytes a refresh may replace>"
  },
  "mcp": {
    "path": "…", "exists": true, "serverName": "dsh-delegate",
    "state": "configured", "configured": true,
    "previous": { "command": "…", "args": ["…"], "envKeys": [] },
    "reason": null,
    "marked": true,
    "desired": { "command": "…", "args": ["…"], "env": {} },
    "node": "…", "nodeResolved": true, "nodeError": null,
    "script": "…", "scriptExists": true,
    "discoveryFile": "…", "discoveryPinned": false
  },
  "config": { "readable": true, "error": null },
  "ready": true,
  "notes": [{ "code": "…", "text": "…" }]
}
```

Agent states: `not-installed`, `installed`, `outdated`, `modified`, `conflict`.
MCP states: `not-configured`, `configured`, `outdated`, `conflict`, `unreadable`.
`unreadable` covers both "the config cannot be read safely" and — as of 0.1.7 —
"no Node.js executable could be proved" (`reason: no-executable`), in which case
`desired` is `null`, `node` is `null`, `nodeResolved` is `false` and `nodeError`
carries the `MCP_EXECUTABLE_UNRESOLVED` diagnosis (section 2.1).
Boundary kinds: `directory`, `missing`, `link`, `other`, `unchecked` (for the level
below a link, which is deliberately not inspected), and `unknown` when the platform
answer could not be obtained.

`boundary.blocked` is true when either directory is a link or could not be verified;
`boundary.link` names the level (`codex-home` or `agents`) and is `null` otherwise.
`agent.reason` carries `codex-home-is-link`, `agents-dir-is-link` or
`boundary-unverified` in that case, so the page can say which boundary it refused.

`agent.expect` and `mcp.marked` are the two ownership facts: `expect` is what a
refresh compares against immediately before its rename, and `marked` is true only
when the entry carries the plugin marker (i.e. when a `remove` may delete it).

`switch` reports the DSH posture and always carries
`changedByThisAction: false`: no Codex action can authorize dispatch.

---

## 4.1 The preflight tool the agent depends on

`delegate_preflight` is the fifth MCP tool and the only one that is not an
authorization at all: it is a read-only measurement of one workspace, added so a
dispatcher learns *before* submitting that a checkout is dirty, is not a
repository, or needs an isolation decision — instead of learning it from a job that
failed after admission.

| property | value |
|---|---|
| tool | `delegate_preflight` |
| arguments | `workspacePath` (string, required, absolute), `allowShared` (boolean, optional) |
| schema | closed: `additionalProperties: false`; `allowShared` must be a real boolean (`MCP_ARGUMENT_TYPE` otherwise, and the plane is never reached) |
| execution-plane route | `POST /dsh-delegate/x/workspace/preflight` |
| writes | nothing: no commit, stash, branch, worktree, lock, task, grant or setting |
| gate | transport fence + connection identity only — **not** the switch, because it authorizes nothing |

The answer is `{ ok, readOnly, workspacePath, isolation, reason, sharedExplicit,
decisionRequired, facts, guidance, checkedAt }` with `isolation` one of
`worktree` / `shared` / `block` and `reason` a stable `PREFLIGHT_*` code. The full
shape, the decision table and the four git reads it is allowed to issue are stated
in `docs/workspace-contract.md` §3.5; this document only records the contract the
agent file depends on.

The one rule a reviewer should check: **a dirty repository is never downgraded
automatically.** Without `allowShared` the answer is `block` with
`decisionRequired: true`; with `allowShared: true` — a per-call decision record,
never a stored preference — it is `shared` with `sharedExplicit: true`. The Codex
coordinator evaluates the requested task and changed paths and may decide to use
shared isolation without asking on every dispatch; it pauses when ownership or risk
is unclear. To make the actual job match that decision, `delegate_submit` passes
only `{ isolation: "shared" }` as an override. Provider, model, effort and timeout
remain those selected in the plugin settings.

---

## 5. The agent file

```toml
version = "0.1.8"   # stamped from package.json when written
name = "dsh-delegate"
description = "…"
developer_instructions = """…"""
```

The file is a custom-agent definition, not an MCP registration: it deliberately
contains no `[mcp_servers.*]` table, because the agent inherits the parent Codex
session's MCP tools, and a second definition would start a second server.

**Ownership is content identity, not a heuristic.** `readAgentState` reports:

* `installed` — byte-identical to the file this build would write;
* `outdated` — byte-identical to one of the enumerated `KNOWN_AGENT_TEMPLATES`
  digests (published builds only: `0.1.6` and `0.1.7` today, and any later build listed when it
  is packed and verified);
* `modified`/`conflict` — everything else.

The version line is *never* the proof. A file that still starts with the managed
header, still contains the dispatch rules, but has an old or invented version line
and one edited body byte is the operator's: the digest no longer matches, so it is
`modified`, it is never refreshed, and it is never removed. Conversely a
byte-exact published build is refreshed and removable, as documented.

### 5.1 Required dispatch semantics

The instructions must state all of the following. They are asserted in
`tests/codex-integration.test.js` and `tests/package.test.js`, so an edit that drops
one fails the build:

1. **Explicit assignment only.** Dispatch only when the parent request explicitly
   selects this agent (the exact mention `@dsh-delegate`, the agent picker, or an
   explicit instruction to delegate this implementation task to DSH).
2. **Mention is not dispatch.** Text that merely mentions DSH, DeepSeek,
   dsh-delegate, delegation or the agent while asking something else is not a
   dispatch request, and neither is a question about the plugin, its settings or
   its status.
3. **No dispatch for non-implementation work.** Explanation, planning,
   review-only, summarising and status questions are answered in Codex.
4. **Ambiguity is a question.** If it is unclear whether the task was assigned, ask
   once instead of dispatching.
5. **Switch first, facts second.** Call `delegate_status` first; then call
   `delegate_preflight` with the exact authorized workspace path. If either fails,
   the tool is missing, the switch is off, or the answer is ambiguous, stop and
   report the bounded refusal. Never open the switch; never fall back to DSH Crew,
   another endpoint, another provider or local execution.
6. **The isolation is decided from the measured facts, and never downgraded.**
   `delegate_preflight` returns `isolation` (`worktree` / `shared` / `block`) and a
   stable `reason` code:
   * `worktree` (`PREFLIGHT_CLEAN_REPOSITORY`) — a clean repository; dispatch with
     the worktree isolation selected in the plugin settings, unchanged.
   * `block` + `decisionRequired: true` (`PREFLIGHT_DIRTY_NEEDS_DECISION`) — the
     checkout is dirty, so a worktree cannot be prepared from a commit. The agent
     must **not** silently downgrade and must **not** probe by submitting. As
     coordinator, it inspects the changed-file count and bounded path list and
     decides whether this authorized task can safely run in place while preserving
     the existing changes. It need not ask the operator to choose on every dispatch:
     it states a safe shared decision and its reason before dispatch, re-runs the
     preflight with `allowShared: true`, and proceeds only if the answer is `shared`
     (`PREFLIGHT_DIRTY_SHARED_EXPLICIT`). If ownership, overlap or risk is unclear,
     it pauses for one focused question.
   * `block` for any other reason (`PREFLIGHT_GIT_UNAVAILABLE`,
     `PREFLIGHT_NOT_A_REPOSITORY`, `PREFLIGHT_NO_COMMITS`, `PREFLIGHT_GIT_FAILED`,
     `PREFLIGHT_WORKSPACE_INVALID`, `PREFLIGHT_NOT_A_DIRECTORY`) — stop and report
     the code; no fallback exists.
7. **The dispatch text carries the workspace facts and the isolation reason.** A
   shared run is named as such, because the worker writes into a checkout that
   already has uncommitted work.
8. **Route settings stay in the plugin.** For `worktree`, call `delegate_submit`
   without `overrides` so the configured isolation applies. For an explicitly chosen
   `shared` run, pass only `{ isolation: "shared" }` as the per-task override because
   the plugin may still be configured for `worktree`. Never override provider,
   model, effort or timeout, and never encode a route in the prompt. `allowShared`
   on preflight records the decision but does not change the submitted job's
   isolation by itself.
9. **One task, polled.** Keep the returned `taskId`, poll `delegate_result` for that
   same task until terminal, and never submit a duplicate because a result is still
   running; `delegate_cancel` stops it.
10. **Evidence, not approval.** Return state, the actual provider/model/effort,
    changed-file summary, verification evidence, limitations, and the preflight
    facts with the isolation reason actually used. Executing is not accepting:
    Codex remains responsible for review. Do not claim a check passed without
    evidence, and never commit or push.
11. **The workspace is not tidied up to pass a check.** No commit, stash, branch,
    worktree creation, `clean`, `reset` or revert on the operator's behalf. A dirty
    workspace is an isolation decision for the coordinator; pause only when the
    existing edits' ownership or risk is unclear.
12. **No secrets.** Never read, request, store or relay provider credentials or
    connection tokens.

### 5.2 What the file cannot guarantee: `@` selection

**This plugin does not claim that any Codex surface supports selecting the agent by
typing `@dsh-delegate`.** Only verified facts are stated:

* A custom-agent file at `$CODEX_HOME/agents/<name>.toml` is a Codex-recognised
  definition, and the parent session's MCP tools are inherited by it — this is what
  the installation relies on.
* Whether the *current* Codex Desktop / CLI input box offers an `@`-mention picker
  for that file is a property of the Codex build, not of this plugin. No official
  documentation or runtime evidence in this repository establishes it for the
  versions under test, so the wording here (and in the settings page) says the
  mention *may* select the agent, and claims no more.

Consequently the agent's own instructions treat `@dsh-delegate` as **one example**
of an explicit selection, alongside the agent picker and an explicit instruction to
delegate. If a Codex build does not offer `@` selection, the agent still works when
chosen through whatever selection mechanism that build does provide. A new Codex
session (or a restart) is required to load the new file and the new MCP entry.

---

## 6. Failure modes a reviewer should check

| Situation | Expected |
| --- | --- |
| `CODEX_HOME` relative | 400 `CODEX_HOME_INVALID`; nothing read or written |
| `CODEX_HOME` unset | diagnosed against `~/.codex` |
| `$CODEX_HOME` is a symlink or a Windows junction | `conflict` (`codex-home-is-link`); nothing below it is inspected, written or deleted |
| `$CODEX_HOME/agents` is a symlink or a Windows junction | `conflict` (`agents-dir-is-link`); install/repair/remove refuse with `AGENT_PATH_CONFLICT` and no file is created outside the home |
| an ordinary real Windows directory | `directory` in every spelling of the helper's boolean (`dir/False`, `dir/false`); never reported as a link |
| `repair` with the agent file missing or `outdated` | `changed: ["mcp"]` or `[]`; the agent file is not created and not refreshed, and `agents/` is not created |
| the boundary cannot be verified (no spawnable shell / no PowerShell) | `conflict` (`boundary-unverified`); everything refused, nothing assumed safe |
| agents dir missing | created on install (`0700`) when the boundary is clean |
| `agents/dsh-delegate.toml` is a symlink or a directory | `conflict`; untouched |
| a different agent file appears between status and install | `modified`; untouched (first install is exclusive) |
| an agent file is rewritten between the status read and `remove` | `AGENT_USER_MODIFIED` (`modified-before-removal`); the new bytes are kept |
| the agent path is replaced by a directory / a link before `remove` | `AGENT_PATH_CONFLICT`; the entry is left in place |
| an edited agent file with an old version line | `modified`; never refreshed, never removed |
| a byte-exact previously published agent file | `outdated`; refreshed on install, removed on remove |
| `config.toml` is a symlink | `unreadable`; refused |
| `config.toml` > 1 MiB | refused (`other`), untouched |
| `config.toml` contains a NUL / control character | `CODEX_CONFIG_UNSUPPORTED`, untouched |
| `config.toml` uses CRLF | edited in place; CRLF and every unrelated byte preserved |
| an unmarked same-name `mcp_servers.dsh-delegate` entry | `conflict` (`unmanaged-entry`); byte-identical after install/repair/remove |
| entry added between the read and the write | re-classified; refused if it stopped being ours |
| package `bin/dsh-delegate-mcp.js` missing | MCP refused (`MCP_SCRIPT_MISSING`), agent still installed |
| plain Node.js host (`process.execPath` is a Node binary) | `command` is that path; no override is consulted |
| DSH Desktop host (`process.versions.electron` set) | `command` is the bundled runtime, **never** `DeepSeek Harness.exe` |
| desktop host that exposes no `resourcesPath` | `<dirname(execPath)>/resources` is derived and the bundled runtime is used |
| bundled runtime missing, `DSH_NODE_PATH` set to an absolute existing file | that file is written as `command` |
| an override that is relative / a directory / a link / missing | ignored; the next candidate is tried, and the reason is kept in `nodeError.details.rejected` |
| no candidate can be proved | status: `mcp.node = null`, `nodeResolved: false`, `ready: false`; install/repair refuse `MCP_EXECUTABLE_UNRESOLVED`; `config.toml` byte-identical; agent file still installed |
| no candidate can be proved, an owned entry already points at a stale command | left as written (nothing is guessed); the note names the environment variable to set |
| DSH has no execution plane (public bind) | unchanged by this feature; delegation still refuses |
| the agent is asked to dispatch into a dirty repository | `delegate_preflight` answers `block` / `PREFLIGHT_DIRTY_NEEDS_DECISION`; the coordinator evaluates the listed paths and task, then either reports and dispatches with an isolation-only `shared` override or pauses when risk/ownership is unclear |
| the agent is asked to dispatch into a non-repository or commit-less directory | `block` with the matching `PREFLIGHT_*` code; the agent stops and reports it rather than submitting |
| the workspace path is relative, missing or a file | `block` / `PREFLIGHT_WORKSPACE_INVALID` or `PREFLIGHT_NOT_A_DIRECTORY`; nothing is resolved against the process cwd |
| `delegate_preflight` is called while the switch is off | answered normally: it authorizes nothing, and that is when a coordinator needs it most |
| `delegate_preflight` is sent `allowShared: "true"` | `MCP_ARGUMENT_TYPE`; the plane is not called |
