# Codex integration contract

Status: implemented in 1.4.1 (1.1.0 introduced wait rules, 1.2.0 added installed-integration upgrades, 1.4.0 clarifies outer long waits and explicit host-review recording). This automatic installer covers Codex. Claude Code uses the separate manual MCP guide.

1.4.1 recognizes the exact unmodified
1.4.0 companion in LF and CRLF forms, and updates the review contract: a completed
task may be read and reviewed by its original identity after a restart. History
does not restore execution or old permissions. Reviews are confirmed only when
`reviewPersistence.durable` is true (`state: "saved"`); `saving` or `timed-out`
means the write is still unconfirmed, and `failed` permits a retry. Ordinary waits
omit review prose. A result that reports `noteOmitted: true` can be read with
`delegate_result` plus `reviewNoteOffset` and optional `reviewNoteLimit` (1–2000
Unicode code points per page, default 2000); follow `nextOffset` until `complete`.
Review notes accept up to 8000 code points after trimming and are stored redacted.
See the [release notes](releases/1.4.1.zh.md) for validation boundaries.

This document is the contract between the plugin's settings page (browser half),
the host-side installer (`src/codex/installer.js`) and the two files it manages.
It is written so a reviewer can check the code against it without reading the
README.

## TaskBridge companion migration (1.3.2)

The public companion is now `dsh-taskbridge`, installed as
`agents/dsh-taskbridge.toml`. An explicit install or the startup refresh migrates
an unchanged, recognized published `agents/dsh-delegate.toml` and removes the old
managed file after the new managed template is present. Edited files and an
operator-owned destination remain untouched; startup does not perform a first
installation when no previous managed companion exists. The MCP table remains
`mcp_servers.dsh-delegate`, and `delegate_*` tool names remain compatible.

1.4.0 recognizes the exact published 1.3.2 companion and refreshes its waiting rules
on plugin startup. After examining a delivered result, the companion records its own
accepted or changes-requested conclusion with `delegate_review`; the plugin never
derives acceptance from completion. A client may need reloading to see the refreshed
agent and tool catalog. Edited companion files remain operator-owned.

Explicit install/repair can also adopt a marked standard legacy MCP path after
the old `dsh-delegate` or `dsh-taskdispatch` package has been uninstalled from the
same `node_modules` as the current `dsh-taskbridge`. This narrow exception does
not apply to custom wrappers, other directories, or automatic startup refresh.
`repair` remains MCP-only. TaskBridge CLI aliases point at the existing bin files.

---

## 1. What is owned, and what is not

| Path | Owner | The plugin may | The plugin may never |
| --- | --- | --- | --- |
| `$CODEX_HOME/agents/dsh-taskbridge.toml` | managed copy of `codex/dsh-taskbridge.toml` | create it **exclusively** on explicit install when absent; refresh a byte-exact known build during plugin startup or explicit install; delete it on `remove` only after re-reading it and finding the same bytes it classified | overwrite or delete a file that is not that exact build — including a file with an old version line whose body was edited, and including a file that changed in the window between the status read and the write/removal |
| `$CODEX_HOME/config.toml`, table `mcp_servers.dsh-delegate` | operator, with one managed entry | add the entry when absent; update `command`/`args`/its own `env.DSH_DELEGATE_DISCOVERY_FILE` when the entry carries **the plugin marker** *and* is the exact shape this plugin writes; on an explicit `install`/`repair` only, adopt a recorded `args[0]` that is a PROVED real installation of this package (manifest `name` + `bin["dsh-delegate-mcp"]` mapping) | touch any other key, table, comment or ordering; adopt, update or delete an unmarked same-name entry, even one whose values coincide; adopt a differing script path from the automatic startup check |
| `$CODEX_HOME` and `$CODEX_HOME/agents` | Codex | read them (lstat **and** the Windows file attributes); create `agents` (`0700`) when both are real directories | create them relative to the process working directory; **follow a link at either level** (POSIX symlink, Windows junction/reparse point) for any read-through, write or delete |
| DSH local-call switch | operator | report it | change it |

`$CODEX_HOME` resolution: `CODEX_HOME` when set and absolute; otherwise
`~/.codex`. A relative override is refused (`CODEX_HOME_INVALID`), because
resolving it against the harness's cwd would report on, and write to, a directory
nobody named.

### 1.1 Link boundaries

`lstat` on the final file is not enough: if `$CODEX_HOME/agents` is a junction,
`mkdir -p` and the file create walk *through* it and write
`agents/dsh-taskbridge.toml` outside the Codex home entirely. Both directories are
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
tool_timeout_sec = 3660
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
* `tool_timeout_sec = 3660` (1.1.0) is an **owned scalar on this entry only**. The
  `delegate_wait` tool defaults to a 3600-second wait and caps it there, so a client that
  honours this field is allowed to let one call run that long. The plugin cannot prove that
  every client honours it: a client that applies its own tool timeout may still end the
  wait earlier. That is an OUTER limit and is not a `wait-limit` answer. The managed entry
  therefore *requests* 3660 s — the 3600-second wait plus one minute of slack, never a
  second wait window — while a client-side cap that ignores the field remains a client
  limit the plugin cannot lift. This is not a Codex-wide setting and the plugin writes it
  nowhere else.
  * When a client exposes a yield/pragmas parameter, an ordinary wait should request
    roughly `1200000` ms (20 minutes), not one minute. A one-minute return is a caller
    choice, not a documented hard maximum, and not every client supports the same long
    yield — the agent is told to state what its client actually offers rather than
    describe one minute as inherent.
  * A managed entry written by an earlier release has no such field. It is classified
    `outdated` and repaired **in place** (the line is inserted inside our table), so an
    existing installation updates through the settings page instead of being reported as
    somebody else's file.
  * A managed entry with a different integer is likewise `outdated` and rewritten to
    3660. A non-integer value is not a value this plugin writes, so the whole entry is
    treated as operator-owned and left untouched (`timeout-not-an-integer`).
  * An unmarked same-name entry stays a conflict regardless of its values: the marker
    comment is the only authorship proof this format carries.
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
| `outdated` | marked owned command, but stale `args`/discovery/`tool_timeout_sec`; or the narrowly recognised 0.1.6 Desktop command with the current package `args` and owned env shape | rewrites only those values in place |
| `conflict` | anything else (`unmanaged-entry`, `command-not-ours`, `legacy-command-shape`, `url`, `unknown-field`, `extra-env`, `args-not-an-array`, `command-not-a-string`, `not-a-table`, `array-table`, and the boundary reasons below) | **refuses** with `MCP_ENTRY_CONFLICT` and a note explaining why |

Every classification also reports **`drift`**: the list of owned facts that are stale
(`tool_timeout_sec`, `args`, `command`, `env`), or `null` when nothing is. The status
document publishes it as `mcp.drift`, and the note for an `outdated` entry names each
one, so neither the page nor a log line has to infer what a repair would change.

An `args[0]` that names `dsh-delegate-mcp.js` somewhere ELSE is a `conflict`
(`args-shape-not-ours`) in a bare status read: the synchronous classifier cannot prove that
a different path is this package, so it never labels one `outdated`. Only an explicit
`install`/`repair` may adopt it, after the asynchronous proof below — and only with the
config digest, the `$CODEX_HOME`/`agents` boundary and the current entry re-checked
immediately before the write. A different script name, a different command or an extra
argument stays `conflict` everywhere.

When `$CODEX_HOME` or `$CODEX_HOME/agents` is a link (or cannot be verified), the MCP
target is reported as `conflict` with `reason` `codex-home-is-link`,
`agents-dir-is-link` or `boundary-unverified` — the same verdict the agent target gets.
The entry is **not** read through the link, because a link bounds every write this
module makes, not only the agent file.

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

### 2.4 The startup upgrade of an installed integration (1.2.0)

`refreshKnownAgentTemplate({ refreshMcp: true })` — reached through the seam as
`refreshManagedIntegration({ startupTarget, backupDir })` and called once by plugin
activation — performs two independent upgrades:

| target | condition | write |
| --- | --- | --- |
| agent file | `outdated` (byte-exact published build) | replaced with this build's template |
| MCP entry | `outdated` **and** passing the write gate below | the owned values rewritten in place, in ONE atomic write |

The automatic check only ever accepts THIS installation's exact entry point. The
moved-install case (a recorded `args[0]` that is a different, provable installation of the
same package) is described below but is performed only by an explicit `install`/`repair`;
startup leaves it byte-identical and reports `conflict`.

#### The write gate (`isOwnedStaleEntry`)

"The classifier said `outdated`" is not permission to write. An automatic, unreviewed
write additionally requires that the entry is provably this plugin's in EVERY owned fact:

| fact | required |
| --- | --- |
| marker comment | present (authorship proof) |
| `command` | exactly this package's Node command (or the narrowed 0.1.6 Desktop command) |
| `args` length | exactly 1 — no wrapper flags, no extra arguments |
| `args[0]` | **provably** this package's entry point (see below) |
| `env` keys | none that this plugin did not write |

**`args[0]` must be PROVED, not pattern-matched** (`isOwnedEntryScript`, asynchronous
because the proof is a filesystem one). There are exactly two accepted proofs:

1. **This installation's own file** — an absolute path that is the same location as this
   package's `bin/dsh-delegate-mcp.js`, compared under the PLATFORM's case rules
   (`samePlatformPath`). Linux compares exactly: two case variants are different programs
   there. Windows is case-insensitive; macOS is treated the same way because its default
   volumes are, which is an assumption rather than a promise on a case-sensitive volume. A
   RELATIVE path is never equivalent: `relative/bin/dsh-delegate-mcp.js` names no location.
2. **A different, real installation of this package** — an absolute path ending in
   `<root>/bin/dsh-delegate-mcp.js` with ALL of:
   * `<root>` and `<root>/bin` are real directories and not links (a junction is caught by
     the same attribute read the boundary check uses);
   * `<root>/bin/dsh-delegate-mcp.js` is a regular, non-link file that IS the candidate
     (compared by `realpath`, so a link cannot smuggle in another program);
   * `<root>/package.json` is a regular, non-link file that BOTH declares
     `"name": "dsh-delegate"` AND maps `bin["dsh-delegate-mcp"]` to that very entry. A
     `./` prefix is allowed; an absolute path, a `..` segment, a trailing slash, a wrong
     mapping, a missing mapping or no `bin` object is refused.

The `<root>` is derived with the host's `dirname`/`basename` rules (`packageEntryRoot`), so
a POSIX leading `/` is preserved: splitting on `/` and rejoining would turn
`/opt/pkg/bin/dsh-delegate-mcp.js` into the relative `opt/pkg/...`, and no real Linux or
macOS installation could ever be proved.

Everything else — a wrapper that reuses the marker, the command or even the file name; a
same-layout script whose manifest maps its bin elsewhere; a missing path; a link; a
directory that declares another package — is **not** claimed. The synchronous classifier is
even stricter: only proof 1 can make an entry `outdated`, so a differing script is always a
`conflict` (`args-shape-not-ours`) and a bare status read can never authorize a write. Proof
2 is attempted **only by an explicit `install`/`repair`**, never by the unattended startup
check, and it is re-run immediately before the write together with the plan's config digest
and the boundary re-check; an edit in that window is refused (`config-changed`).

An unprovable path is therefore KEPT and reported, with a note pointing at the explicit
button: this is the intended outcome, not a gap. The core upgrade — an exact `args` match
with only `tool_timeout_sec` missing — always succeeds automatically.

#### No concurrent change (`config-changed`)

The plan records a SHA-256 of the WHOLE `config.toml` (`mcp.fingerprint`, stripped from the
public status by `publicCodexStatus`). Immediately before the write the file is re-read and
the digest must match. Re-classifying alone is not enough: an operator can change an owned
value and leave an entry that still looks stale and managed, which is exactly the overwrite
this refuses. The result is `MCP_ENTRY_CONFLICT` with `reason: config-changed` and the file
is kept byte-identical. This is covered by a deterministic test that changes the file
between the plan and the write.

#### The backup is a PRECONDITION (`MCP_ENTRY_BACKUP_UNAVAILABLE` / `_FAILED`)

Before any automatic MCP write the current document is copied to a protected location, and
that copy is **verified**. It is not best-effort:

* no destination supplied → `MCP_ENTRY_BACKUP_UNAVAILABLE`, nothing written; a RELATIVE
  destination is refused as well, because it would be resolved against the harness cwd;
* EVERY ancestor of the destination is proved to be a real directory — a symbolic link, a
  Windows junction/reparse point, a component the platform cannot verify, or a file in the
  chain refuses the whole backup, so a complete `config.toml` is never written through a
  linked parent (a leaf-only check is not enough: `/safe/backup` can be a plain directory
  below a junction);
* missing levels are created ONE at a time and each is inspected immediately afterwards; a
  recursive `mkdir` would follow a link that appeared at any depth in the window;
* the chain is re-checked immediately before the copy is written, then the copy is written
  atomically with owner-only permissions and RE-READ; a mismatch or a write failure →
  `MCP_ENTRY_BACKUP_FAILED`, nothing written;
* an existing destination that is a link, a non-file, or holds different bytes is refused
  rather than overwritten.

The seam supplies `<plugin dataDir>/codex-config-backup` by default, so a caller that passes
no location still gets one; a direct `refreshMcp` call with no trusted location refuses
instead of writing. The original file is always left exactly as it was on any refusal.

#### The rest of the guarantees

* an absent entry stays absent — the plugin never creates `config.toml` or the table at
  startup, so an upgrade can never turn a non-installation into an installation, and the
  same is true of `agents/` and the agent file;
* an unmarked entry, an operator-edited shape and any `conflict` are refused and left
  byte-identical (the outcome carries `MCP_ENTRY_CONFLICT` with the reason);
* a link or unverifiable directory at `$CODEX_HOME` / `agents` is re-inspected immediately
  before the write and produces ONE `AGENT_PATH_CONFLICT` refusal for the whole check, even
  when the visible state shows nothing stale: an upgrade that cannot be proved safe must not
  look successful;
* the pre-write document is copied to `backupDir` (the plugin data directory) first — never
  into the package, never into the Codex home, and never returned in a response;
* nothing else in `config.toml` is touched: comments, ordering, other MCP tables, CRLF
  line endings and every unrelated setting survive byte for byte.

#### Which home is targeted — ONE precedence for every seam call

`resolveHomePreference` is the single implementation, and `status()`, the explicit actions
and the automatic check all use it. Before that, the check consulted the recorded directory
while `status()` and the buttons consulted only `CODEX_HOME`/default, so removing
`CODEX_HOME` made the page report — and the buttons write — a different tree than the one
startup had just upgraded. The order is:

| precedence | target |
| --- | --- |
| 1 | an explicit `CODEX_HOME` (or the seam's explicit `codexHome`) |
| 2 | the home a SUCCESSFUL explicit install recorded in `<dataDir>/codex-installation.json` |
| 3 | the default (`~/.codex`), only when it exists and is a real directory |

A successful `install` records the directory even when it wrote nothing because the
installation was already exactly right: `changed: []` is a success, not "nothing happened".
A REFUSED install records nothing, so a refusal cannot become the remembered target.

A default that is a link (or cannot be verified) is reported as `default-is-link` /
`default-unverified`; a home that does not exist is `no-codex-home`. When no supported
directory applies, `status()` and the actions REFUSE with `CODEX_HOME_INVALID` instead of
falling back, and so does `refreshManagedIntegration` when the caller passes a
`startupTarget` whose `home` is `null` — the plugin never walks a junction and never
substitutes a tree nobody named.

The explicit 安装 / 更新 TaskBridge 智能体 button (action `install`) is unchanged and remains
the way to *create* the two managed targets. `status` reports the drift (`mcp.drift`)
and, when an entry is `outdated`, a note naming exactly which owned facts are stale.

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

Updating a stale agent is an explicit `install`, or the byte-exact startup refresh
described below.

**No action runs when the settings page opens, and package install writes nothing.**
The page's `init()` issues a `GET`; the three buttons are the only callers of the
`POST`.

**The single write at plugin load is the integration refresh.** `apply()` calls the
seam's `refreshManagedIntegration()` once — only when a Codex home directory exists — which
refreshes `agents/dsh-taskbridge.toml` when its complete bytes equal one of the enumerated
`KNOWN_AGENT_TEMPLATES` digests (section 5) **and** upgrades an already installed
`mcp_servers.dsh-delegate` entry that is provably this plugin's and merely stale
(section 2.4). Apart from migrating an existing recognized legacy companion to its new name in 1.3.2, it never creates a missing agent, never creates `agents/`, never creates
the MCP entry, and never touches a `modified`/`conflict` file: everything else stays an
explicit `install`. A refusal or failure is logged and startup continues, so a Codex
problem cannot stop the plugin from loading.

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
  "packageVersion": "1.4.1",
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
version = "1.0.0"   # stamped from package.json when written
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
  digests (published builds only: `0.1.6`, both `0.1.7` builds, `0.1.8`, `0.1.9`,
  `0.1.10` in both its CRLF and LF byte forms, `0.1.11`, `0.1.12`, `0.1.13`, `0.1.14`,
  `1.0.0` and `1.1.0` in both byte forms, plus any later build listed when it is packed
  and verified);
* `modified`/`conflict` — everything else.

Every release from `0.1.10` through `0.1.13` changes only the version line in the
companion file, so those templates share one body and differ only in that stamped line.
`0.1.14` changes the body as well (the per-call decision rules below), which is why its
predecessor is enumerated as a pinned identity rather than rebuilt. The bytes are what
ownership is proved against, so every release is enumerated on its own:

| Release | Digest enumerated in `KNOWN_AGENT_TEMPLATES` |
| --- | --- |
| `0.1.10` | `fc7b27104dbb50f4e614cd4fd8df8db87fd8f59fcf2b3c27b412b49f8b89fbba` (packed CRLF) |
| `0.1.10` | `6583f08a3ec4912a875249e6b127357b41cc3f8bf388b8e5cadbbeff469349be` (same template, LF) |
| `0.1.11` | `b6ca7c3258fc00c1c1682abf099994b9f5abe650acc3ecf9635eec4a35520151` (packed) |
| `0.1.12` | `ff04a4bf2c09b97747f835770c837637869581bb13bad3b8a870a3e92218514f` (packed) |
| `0.1.13` | `b3a1d2f0520774c0066ea733f27fd47c67c5f5ac44394d0eec2564c7959700aa` (packed, 9191 bytes, CRLF) |
| `0.1.14` | `11379c0152f3fb2bd4da1170812e51fe68006d98f6378c720cbadcee9ee4750c` (packed) |
| `1.0.0` | `b1fd531598087564b26df14d3261515e961012f3fd010ea493f222da7bbaf415` (git release bytes, CRLF) |
| `1.0.0` | `0cce75574107049413f4ddbdf7d8e6cddea92d45a0c4e0fa41b169cb790e5e13` (same template, LF) |
| `1.0.0` | `a8c888afaa0a1a6a0abfcb56670ffbdb67697f07e54871ece78c8adffb15c149` (**legacy** pinned identity) |
| `1.0.0` | `f51831e2ff265c9ba63a4760e245787060de7bd91dcc9663a11729fb472e5f62` (**legacy** pinned identity) |
| `1.1.0` | `7d3ea5c54647a92cebaa0521741eb27f5141f7b2127b47009195fdb976dae4fb` (git release bytes, CRLF) |
| `1.1.0` | `93d580bd849bb6d2c30c2db6286695ef3e0356896a88e552abae5f03eafc7601` (same template, LF) |

The `1.0.0` and `1.1.0` **git-verified** identities come from the release commits
themselves — `git show 2750047:codex/dsh-delegate.toml` and
`git show 2d71708:codex/dsh-delegate.toml` — and are kept as fixtures
(`tests/fixtures/codex-agent-1.0.0.toml`, `…-1.1.0.toml`) that are never packed.

The two **legacy** `1.0.0` entries are NOT claimed to be the Git bytes: the fixture above
is what the release commit contains, and these digests do not match it. They are retained
because a released build enumerated them, so an installation created by that build stays
structurally refreshable instead of flipping to "somebody else's file". Labelling them
`legacy` is the point: keeping an old identity is conservative (an unrecognised file is
never adopted and never removable), while pretending it came from Git would be a false
claim.

`0.1.10` therefore carries **two** entries, because that release exists in two byte forms
and either one can be on disk: the CRLF file inside the packed
`dsh-delegate-0.1.10.tgz`, and the same template kept as LF text. Both are hashes of
actual published bytes — the LF digest is an exact identity, not a normalized comparison.
`0.1.11` was delivered as an uncommitted candidate plus a verified tarball (the last
commit, `a750c0b`, is `0.1.10`), so that digest is cited from the tarball and the saved
baseline rather than from a `0.1.11` commit. The `0.1.12` digest is likewise verified
against the `package/codex/dsh-delegate.toml` inside the packed
`dsh-delegate-0.1.12.tgz` and against the saved release baseline. No earlier digest was
removed or replaced when a later release was added, so a machine that skipped a release is
still migrated directly to this build.

`0.1.13` is the last release whose companion body is the older one: `0.1.14` added the
per-call permission decision rules, so the `0.1.13` bytes are **not** recoverable by
relabelling the current template and are enumerated as an exact identity instead. The
digest was verified against `package/codex/dsh-delegate.toml` inside the packed
`dsh-delegate-0.1.13.tgz` (9191 bytes, CRLF) and the file is kept as
`tests/fixtures/codex-agent-0.1.13.toml`, so the "unchanged `0.1.13` is refreshed" and
"edited `0.1.13` is preserved" cases are both driven by real published bytes.

**What the product does with line endings: nothing.** `readAgentState` and
`refreshKnownAgent` read the file and hash it as it is; they never normalize CRLF to LF or
the reverse, and never rewrite a file to change its endings. A digest taken over
normalized text would not be an identity at all — it would let an edited file match a
known build — so normalization is a defect, not a convenience. The earlier `0.1.10`
entry `6583f08a…` was reported as a normalized digest; it is in fact the digest of the
LF form of that release, which is why it is retained (not replaced) alongside the CRLF
value. `tests/codex-integration.test.js` constructs both forms explicitly, pins each
digest, and proves for each that a byte-exact file is refreshed while an edited one is
refused.

A digest is added only for a build that was actually packed and verified, and the
current template's digest is never in the list under an older label; the tests assert
both facts (`tests/codex-integration.test.js`, `tests/package.test.js`).

At plugin startup, an `outdated` agent is refreshed automatically only when its
bytes still match a known shipped build. This does not create a missing agent or
edit `config.toml`. A file with any other content is preserved, even when its
version line names an older release.

Since 1.2.0 the startup check has a second half: an **already installed** managed
`mcp_servers.dsh-delegate` entry that is merely `outdated` is upgraded in place (see
section 2.4). It is still not an install: no entry is created, and no entry the plugin
cannot prove it wrote is adopted or rewritten.

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
   selects this agent (the exact mention `@dsh-taskbridge`, the agent picker, or an
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
9. **One task, WAITED — not polled (1.1.0).** Keep the returned `taskId` and call
   `delegate_wait({ taskId })` — with no `waitSeconds` argument — repeating it until it
   returns a reason that needs the host. `delegate_result` is **not** a polling loop: one
   `delegate_wait` blocks internally and re-issues its own bounded observation requests,
   which is the waiting loop. Never submit a duplicate because a task is still running;
   `delegate_cancel` stops it. The wait defaults to 3600 seconds and the tool caps it
   there, so there is nothing to raise: when a wait ends, call it again on the same task.
   A shorter explicit `waitSeconds` stays legal but is only for a one-off diagnostic the
   operator explicitly asked for.
   While the wait runs, stay silent: do not read intermediate code or diffs, do not run
   parallel implementation or research, and do not narrate unchanged snapshots. The only
   exceptions are work explicitly assigned as independent of the task, an inspection the
   operator explicitly asked for, a decision or diagnosis that genuinely needs a fact the
   wait did not return, and an explicit user-authorized takeover. Review happens once, on
   delivery.
   `heartbeat` means "nothing to report" and is internal: the tool re-waits rather than
   handing it to the model, so normal progress never wakes Codex.
   The roughly 25-second internal observation cadence belongs to the program, not to the
   agent: it is not a polling rate the model should imitate.
10. **Each wait reason has a stated policy (1.1.0).**
    - `attention` — the run has been completely silent past the configured attention
      interval (ten minutes by default). It does **not** mean an ordinary wait ended: a
      wait ending is `wait-limit`. It is a QUESTION, not a verdict: read the compact
      diagnostic (phase, last activity, current tool and its elapsed time, self-check
      verdict) and **default to waiting again** on the same task. Never cancel, never mark
      failed, and never resubmit merely because a task is quiet or one tool or test is
      slow. Only a concrete, stated error justifies anything else, and then it is reported
      rather than silently restarted.
    - `permission` — a per-call decision is outstanding; see item 12. After deciding,
      wait the SAME task again.
    - `ready` — execution finished and the task awaits **host review**; that is not
      acceptance. Read `delegate_result` **once** for full evidence and review it in
      Codex. A large diff is inspected file by relevant file, once each, not re-read.
    - `failed` / `cancelled` — read `delegate_result` once for the recorded reason and
      report it; do not resubmit identical work hoping for a different outcome.
    - `wait-limit` — this call's own wait budget ran out with nothing changed. The answer
      carries `actionable: false` and `terminal: false`: it is not a result, requires no
      business decision, and ends nothing. Immediately `delegate_wait` the same task
      again (no `waitSeconds`). It is not a failure, a stall, or a reason to submit
      anything new or to check the implementation locally.
      A **client-side tool timeout** is a different event and is *not* `wait-limit`: the
      host's own limit ending the call does not prove the execution stopped, and does not
      prove it is alive. Keep the `taskId` and wait again; if a compact fact is genuinely
      needed, read it with `delegate_result`. Never duplicate, restart or cancel a task
      because a wait or a client timeout ended.
    - `interrupted` — **the wait was cut off; that is not by itself a finished
      execution.** One call answers it at once (it does not loop), so the answer's own
      fields decide the response (1.2.0):
      * `terminal: false` with a live `state` (`running`/`pending`): the task is running.
        `delegate_wait` the same task; never resubmit, never implement locally, never
        cancel for this reason.
      * `terminal: true` and `state: "interrupted"`: the TASK record itself is a restart
        history and will not resume. Read `delegate_result` once and report; do not keep
        calling `delegate_wait` on it.
      * `terminal: false` with no state, an unrecognized state, or a state that
        contradicts the record (for example `running` with an end time): neither
        "running" nor "stopped" may be assumed. Keep the task id and check one fact with
        `delegate_result` before deciding — and do not re-wait indefinitely on a task the
        host cannot classify.
      A settled state carried by an `interrupted` observation is reported as that real
      outcome (`awaiting-host-review` → `ready`), so a completed run always reaches review.
10b. **When the host blocks the connection, the control channel is separate (1.2.0).**
    Some hosts forward one tool call at a time, so a long `delegate_wait` blocks
    `delegate_status`/`delegate_cancel` on that same MCP connection. When — and only
    when — the operator asks to stop or inspect that task in that situation, the agent
    may run `dsh-delegate-control status <taskId>` or
    `dsh-delegate-control cancel <taskId>` from the SAME package directory as the
    configured MCP script (derived from this plugin's own MCP `args[0]`, never another
    script), using the same `node` executable. It cannot submit, change a setting or
    the switch, act on another task, resubmit the work or switch models, and during a
    normal wait it stays silent instead of polling that binary.

    What the command guarantees, so the expected output is never mistaken for a hang:
    `status` reads the task's CURRENT compact state through ONE observation with the
    smallest positive wait (`waitMs: 1`) — not `waitMs: 0`, which the engine reads as
    "no bound requested" and replaces with a 25-second long poll. The commands answer
    inside a single budget (10 s by default; `DSH_DELEGATE_CONTROL_TIMEOUT_MS` may only
    lower it), enforced through one caller `AbortSignal` with the observation retry
    disabled for that call, so a dead endpoint cannot spend a backoff schedule after
    the answer. A failure — including an exhausted budget, `CONTROL_TIMEOUT` — is one
    bounded JSON document on stdout plus a non-zero exit code, never a stack trace.
11. **Evidence, not approval.** Return state, the actual provider/model/effort,
    changed-file summary, verification evidence, limitations, and the preflight
    facts with the isolation reason actually used. Executing is not accepting:
    Codex remains responsible for review. Do not claim a check passed without
    evidence, and never commit or push.
12. **The workspace is not tidied up to pass a check.** No commit, stash, branch,
    worktree creation, `clean`, `reset` or revert on the operator's behalf. A dirty
    workspace is an isolation decision for the coordinator; pause only when the
    existing edits' ownership or risk is unclear.
13. **A task awaiting a permission decision is still running, and the coordinating
    Codex decides it.** A wait reporting `permission` (with the full redacted request
    at the top level) is the worker paused on one native tool call, not a
    stall: never submit a duplicate, mark it failed, or cancel it merely because it
    waits, and keep waiting the SAME task. The agent does **not** invoke a second
    approval/review model, does **not** ask the operator to choose routine within-task
    decisions, and does **not** delegate the decision to the worker. The worker's own
    `reason` is a claim, never authority. It checks the actual tool, redacted
    arguments, call identity, session and repository against the authorized task,
    reading local evidence when it needs to understand an executable script or target,
    and approves only the specific operation the task needs — refusing anything
    unrelated, destructive or exfiltrating, any credential or configuration change, and
    any request whose evidence is unknown or materially incomplete. An allow requires
    `argumentsComplete: true`, `completeness: complete`, `allowBlocked: null`, no
    transport truncation affecting the pending operation, a still-pending request and
    its exact `fingerprint`, passed to `delegate_permission_decide` with the `taskId`,
    `requestId`, `decision` (`allow-once`/`reject`) and a bounded `reason`. An invalid or
    stale allow grants nothing: re-read the current request and decide safely, and never
    retry under broader settings. Waiting the SAME task continues after the decision, a
    later request needs a fresh check, and an approval is one call only — never host
    acceptance and never a standing sandbox grant. When dispatching on behalf of a
    parent commander, the complete request evidence is preserved for that commander
    rather than involving a separate review model.
14. **No local implementation while a delegated worker runs (1.1.0).** Neither the
    dispatch companion nor the parent commander writes, patches or "just fixes" the
    implementation while a delegated task is running, waiting, or awaiting review: that
    would make the reviewer a second implementer of the same change, produce conflicting
    edits in one workspace, and break the single-writer property the isolation mode
    provides. The only exception is an explicit, user-authorized takeover — the operator
    saying to take over and implement it here. A long silence, a permission refusal, a
    failed run, a wait-limit or the commander's own opinion of the plan is **not** that
    authorization. Permitted local actions while a task runs are: reading status and
    diagnostics, waiting, reading evidence, deciding a pending permission, cancelling,
    and writing the follow-up prompt. A believed-wrong result is reported and proposed
    as a follow-up in the same chain, never applied locally.
15. **No secrets.** Never read, request, store or relay provider credentials or
    connection tokens.
16. **Task threads are explicit.** A submission starts a NEW DSH task conversation
    by default; a directory-level reuse setting no longer exists. `continueFromTaskId`
    is passed **only** for a follow-up change, correction or retry that belongs to one
    earlier delegated task, and its value is the latest prior task id of that chain.
    An unrelated task, a new topic or a different workspace omits the field entirely:
    an id is never reused "to keep context" and never guessed. A follow-up to a
    `worktree` task keeps its original source `workspacePath` for preflight and
    submit; the plugin resolves the same internal tree and continues its earlier
    uncommitted changes there. Never send the tree's internal execution path as the
    authorization path or choose a new isolation override. A refusal naming an
    unavailable or mismatched tree is reported and escalated, never worked around
    by re-submitting as a new task. The run's report states which of the two happened.
    Corrections are consolidated into one follow-up submission rather than a scatter of
    new tasks.

### 5.2 What the file cannot guarantee: `@` selection

**This plugin does not claim that any Codex surface supports selecting the agent by
typing `@dsh-taskbridge`.** Only verified facts are stated:

* A custom-agent file at `$CODEX_HOME/agents/<name>.toml` is a Codex-recognised
  definition, and the parent session's MCP tools are inherited by it — this is what
  the installation relies on.
* Whether the *current* Codex Desktop / CLI input box offers an `@`-mention picker
  for that file is a property of the Codex build, not of this plugin. No official
  documentation or runtime evidence in this repository establishes it for the
  versions under test, so the wording here (and in the settings page) says the
  mention *may* select the agent, and claims no more.

Consequently the agent's own instructions treat `@dsh-taskbridge` as **one example**
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
| `agents/dsh-taskbridge.toml` is a symlink or a directory | `conflict`; untouched |
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
| `delegate_submit` is called twice for one directory | two Sessions in one Workspace: a new submission never continues a previous one |
| `delegate_submit` sends `continueFromTaskId` for an unknown, pruned or live parent | the run fails with `JOB_CONTINUATION_REFUSED` and `error.details.session` = `SESSION_CONTINUATION_UNKNOWN` / `SESSION_CONTINUATION_STATE`; no conversation is started |
| a follow-up names a parent that ran elsewhere (another directory, another worktree, another repository) | `JOB_CONTINUATION_REFUSED` with `SESSION_CONTINUATION_PATH_MISMATCH` / `SESSION_CONTINUATION_WORKSPACE_MISMATCH`; nothing runs |
| a follow-up to a `worktree` task is submitted with the source checkout | accepted: the source path remains the authorization/preflight path, and the engine restores the parent's exact managed tree internally |
| a follow-up's recorded tree was removed or belongs to another run | `SESSION_CONTINUATION_UNAVAILABLE` with the stated reason; no fresh tree is prepared |
| `continueFromTaskId` is not a string | refused at the MCP schema (`MCP_ARGUMENT_TYPE`) and again by the engine (`JOB_CONTINUATION_REFUSED`) |
| the settings page is asked to save a conversation mode | `setConversation` refuses with `CONVERSATION_MODE_REMOVED`; the stored legacy value is untouched and still inert |
