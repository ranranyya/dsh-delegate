# Workspace contract: preflight, audit evidence and worktree isolation

This document is the contract between the workspace layer
(`src/workspace/preflight.js`, `src/workspace/audit.js`,
`src/workspace/worktrees.js`) and the job engine (`src/jobs/engine.js`). It states
what the layer guarantees, what it refuses, and the exact shapes that cross the
boundary, so the engine can be wired to it without either side guessing.

All three modules are read-only with respect to the repository they inspect, with
one deliberate exception: `WorktreeManager` creates and removes its own worktrees
using `git worktree` only. `preflight.js` (§3.5) is the strictly read-only one: it
runs five git reads and nothing else.

### Repository root

A **workspace** in this contract is a repository **root** — the directory
`git rev-parse --show-toplevel` reports — not merely a directory inside one.

Both the preflight and the worktree manager measure that top level with
`git rev-parse --show-toplevel` before deciding anything, and both refuse a path
that is inside a repository without being its root:

- `preflightWorkspace` answers `block` / `PREFLIGHT_NOT_A_REPOSITORY_ROOT` and
  names the measured root. A subdirectory is **not** a workspace: an isolated
  tree created "for" it would land inside the user's checkout, which is exactly
  what isolation is supposed to prevent. It is never recommended `worktree` or
  `shared`.
- `WorktreeManager.prepare` refuses with `WORKTREE_NESTED_DESTINATION` when its
  configured `rootDir` lies anywhere inside the **repository root**, even when the
  supplied `sourcePath` is a subdirectory that does not contain the root. The
  containment boundary is the measured top level, never the supplied path.

`git rev-parse --is-inside-work-tree` answers `true` for *any* directory inside a
work tree, so it is a necessary fact but never a sufficient one. An unmeasurable
top level is a refusal, never an assumed root: "could not tell" must not read as
"this is the root".

---

## 1. What "audited" means

The claim this layer supports is narrow and checkable:

> The diff the host reviews was produced by git, against a commit that was
> recorded before the run started, with credential material excluded before git
> read it.

It does **not** claim the run is sandboxed, that the agent could not write
elsewhere on disk, or that the evidence is complete when a bound was hit. Bounds
are reported, not hidden.

### Fixed comparison point

`captureBaseline` records `head` as a resolved 40-hex commit id. Every later
`captureDiff` compares against **that commit**, never against the string `HEAD`.
This matters because a delegated run can commit: with a mutable `HEAD`, a run
that commits its work would diff to nothing and appear to have done nothing.

A baseline without a pinned `head` is refused (`AUDIT_BASELINE_INVALID`) rather
than defaulted to `HEAD`.

### NUL parsing

Status and numstat are read with `-z`. In that form git never quotes or escapes a
path, so a filename containing a space, a quote, a backslash, `*`, `[` or
non-ASCII bytes is reported as itself.

```
$ git status --porcelain=v1 -z --untracked-files=all
XY <path>\0            regular record
R  <new path>\0<old path>\0    rename/copy: one extra token, new path first
```

A status read that returns no NUL delimiter at all is refused
(`AUDIT_GIT_FAILED`, `details.step = "status"`): filenames in that output have
been rewritten, and re-parsing them would mis-attribute a change to a file that
does not exist. The layer does not guess.

Rename and copy records keep **both** paths. `sensitive` is true when either side
is sensitive, because a rename *from* `.env` to `notes.txt` is exactly how
credential content would otherwise enter a patch under a harmless name.

### Sensitive paths

Sensitivity is decided by `isSensitivePath` in `src/config/redact.js` (`.env*`,
`credentials*`, `secret*`, `id_rsa*`, `id_ed25519*`, `*.pem`, `*.key`, `*.pfx`,
`*.p12` — matched per path segment, case-insensitive).

The order of operations is the security property:

1. `git status -z` lists what changed;
2. sensitive paths are collected from **both** sides of every rename, for
   **tracked and untracked** entries, and checked against
   `AUDIT_LIMITS.sensitivePaths`;
3. those paths are handed to `git diff` as literal exclusion pathspecs
   (`:(exclude,literal)<path>`);
4. untracked non-sensitive files are `lstat`-described and only then rendered;
5. resulting text passes through `redactText` as a safety net.

So the content of a sensitive path is never read by this process, and a sensitive
untracked file is never opened at all. `literal` is mandatory in step 3: a
filename containing `[` would otherwise be interpreted as a glob that matches a
different file — either leaking the excluded file back in or excluding the wrong
one.

If more sensitive paths were touched than `sensitivePaths` (100), the patch is
**withheld entirely** and `patchWithheld: true` is set. A partially filtered diff
over an unbounded set is precisely the leak the bound exists to prevent.

### Bounds

| Bound | Value | Effect when exceeded |
|---|---|---|
| `files` | 500 | `files` list truncated; `fileCount` keeps the true total; `truncatedFiles: true` |
| `statusEntries` | 2000 | extra entries not parsed; `truncatedFiles: true` |
| `patchBytes` | 64 KiB | patch cut on a byte boundary with a truncation marker; `patchTruncated: true` |
| `patchFiles` | 50 | further untracked files not rendered; `patchTruncated: true` |
| `sensitivePaths` | 100 | patch withheld (above) |
| `statLines` | 200 | `changes` truncated |
| `gitTimeoutMs` | 8000 | the invocation is killed; refusal |
| `gitMaxBytes` | 8 MiB | stdout/stderr capture refuses rather than truncating |

A file larger than `patchBytes` is skipped with an explicit
`diff -- omitted <path>: <n> bytes exceeds the patch budget` marker, so its
absence is visible in the evidence rather than silent.

### Git hardening

Every diff invocation carries `--no-ext-diff --no-textconv`, and every
invocation is an argv array with `shell: false`. `--no-ext-diff` stops a
repository-configured diff driver and `--no-textconv` stops a textconv filter
from running against a file being excluded — both are configured *inside the
audited repository*, so neither can be trusted to be absent.

Nothing in `audit.js` runs a mutating git command: no `add`, `commit`,
`checkout`, `reset`, `switch`, `stash`, `merge`, `rebase`, `clean`, `worktree`.

### Fail closed

Every git read either succeeds or throws an `AuditError`. The codes:

| Code | Meaning |
|---|---|
| `AUDIT_GIT_UNAVAILABLE` | git cannot be executed here (missing or denied by the sandbox) |
| `AUDIT_NOT_A_REPOSITORY` | not inside a git work tree |
| `AUDIT_NOT_A_REPOSITORY_ROOT` | inside a work tree but not its top level; used by the preflight, which maps it to `PREFLIGHT_NOT_A_REPOSITORY_ROOT` |
| `AUDIT_NO_COMMITS` | repository exists but has no commit |
| `AUDIT_GIT_FAILED` | a git read failed; `details.step` / `details.exitCode` / bounded `details.stderr` |
| `AUDIT_BASELINE_INVALID` | the baseline has no pinned `head` |

There is no "empty diff" fallback. A workspace that cannot be audited refuses
job execution; the engine maps this to `JOB_AUDIT_UNAVAILABLE`.

Bounded, redacted stderr is the only diagnostic text kept — never file content,
never a full git error dump.

---

## 2. `captureBaseline(deps, workspacePath)`

`deps` must expose `runGit(cwd, argv) => Promise<{ stdout: string, stderr: string, code: number }>`.
`src/workspace/audit.js` exports `createGitRunner()` as the production
implementation. A runner that throws `EPERM`/`EACCES`/`ENOENT` (or throws
synchronously) is normalised to `AUDIT_GIT_UNAVAILABLE`.

```json
{
  "head": "5d0f…(40 hex, the pinned comparison commit)",
  "dirtyBaseline": true,
  "preexistingChanges": 3,
  "preexistingPaths": ["src/a.js", "notes.txt", ".env"],
  "statusTruncated": false,
  "statusFormat": "porcelain-v1-z",
  "capturedAt": 1792400000000
}
```

`preexistingPaths` is names only, bounded to 100: the host needs to know the
checkout was already dirty, not what was already in it.

## 3. `captureDiff(deps, workspacePath, baseline)`

Optional `deps.statPath(absolutePath) => { kind, size }` overrides the file
inspector used for untracked files (default `describePath`, which uses `lstat`).

```json
{
  "head": "5d0f…",
  "baseHead": "5d0f…",
  "dirtyBaseline": false,
  "preexistingChanges": 0,
  "files": [{ "code": " M", "path": "src/a.js", "from": null, "status": "modified", "sensitive": false }],
  "fileCount": 1,
  "truncatedFiles": false,
  "changes": [{ "added": "3", "removed": "1", "path": "src/a.js", "from": null }],
  "sensitivePaths": [],
  "sensitiveTouchedCount": 0,
  "sensitiveContentWithheld": true,
  "patchWithheld": false,
  "patchText": "diff --git a/src/a.js b/src/a.js\n…",
  "patchTruncated": false,
  "patchBytes": 412,
  "capturedAt": 1792400000000
}
```

`files[].path` is always a string; `status` is one of `added`, `modified`,
`deleted`, `renamed`, `copied`, `conflicted`, `changed`. Sensitive paths appear in
`files` and in `sensitivePaths` by name — that is the point, an operator must know
a credential file was touched — but never in `patchText`.

`changes` is `[]` and `patchWithheld` is `true` when the sensitive bound was
exceeded; in that case no diff invocation was issued at all.

`captureDiff` is safe to call after a failed or cancelled run: the engine always
records whatever it can measure.

---

## 3.5 `preflightWorkspace(deps, request)` — the pre-admission check

`src/workspace/preflight.js`. This answers the question the engine used to answer
*by failing*: what is this workspace, and which isolation does it need? It runs
with no side effects — no commit, stash, branch, worktree, lock, task, grant or
settings write — and it is not authorization: it creates nothing, so it cannot
substitute for the switch or a grant.

```js
const decision = await preflightWorkspace({ runGit }, { workspacePath, allowShared });
```

`runGit` is the same argv runner the audit layer uses (`createGitRunner()` when
omitted), so a test can inject a refusal. `workspacePath` must be absolute and is
resolved with `realpath` exactly as `resolveWorkspacePath` does for the engine, so
a `worktree` recommendation can never be rejected later for naming an unusable
path.

Only these five invocations are ever issued, in this order, and the ordered list
is asserted by `tests/preflight.test.js`:

```
git --version
git rev-parse --is-inside-work-tree
git rev-parse --show-toplevel
git rev-parse --verify HEAD
git status --porcelain=v1 -z --untracked-files=all
```

`rev-parse --show-toplevel` is the root measurement: its output is compared
against the resolved workspace path (case-folded on Windows) to decide whether
the named path *is* the repository root or merely sits inside one. The status read
is not attempted at all for a path that fails that comparison.

### Answer

```json
{
  "ok": true,
  "readOnly": true,
  "workspacePath": "<resolved path>",
  "isolation": "worktree | shared | block",
  "reason": "PREFLIGHT_…",
  "sharedExplicit": false,
  "decisionRequired": false,
  "facts": {
    "gitAvailable": true,
    "repository": true,
    "hasCommits": true,
    "clean": false,
    "head": "5d0f…",
    "changedFiles": 3,
    "changedPaths": ["src/a.js", "notes.txt", ".env"],
    "changedPathsTruncated": false,
    "sensitivePaths": [".env"]
  },
  "guidance": "one sentence naming the next action",
  "checkedAt": 1792400000000
}
```

Every branch returns exactly this key set, so a caller never has to guard a field.
`facts.clean` is `null` — **unknown**, not "clean" — whenever the state could not
be measured; `changedFiles` is the true status total and `changedPaths` is the
bounded list, with `changedPathsTruncated: true` when they differ. Paths are names
only: content is never read (`git diff` and `git show` are never invoked), and a
sensitive name appears in `sensitivePaths` by name alone.

### Decision table

| Facts | `isolation` | `reason` | flags |
|---|---|---|---|
| not a directory / relative / unresolvable path | `block` | `PREFLIGHT_WORKSPACE_INVALID` or `PREFLIGHT_NOT_A_DIRECTORY` | — |
| git cannot be executed | `block` | `PREFLIGHT_GIT_UNAVAILABLE` | — |
| not inside a git work tree | `block` | `PREFLIGHT_NOT_A_REPOSITORY` | — |
| inside a repository but not its root (a subdirectory) | `block` | `PREFLIGHT_NOT_A_REPOSITORY_ROOT` | — |
| repository with no commit | `block` | `PREFLIGHT_NO_COMMITS` | — |
| a read-only git read failed | `block` | `PREFLIGHT_GIT_FAILED` | — |
| clean repository root | `worktree` | `PREFLIGHT_CLEAN_REPOSITORY` | — |
| dirty, `allowShared` not passed | `block` | `PREFLIGHT_DIRTY_NEEDS_DECISION` | `decisionRequired: true` |
| dirty, `allowShared: true` | `shared` | `PREFLIGHT_DIRTY_SHARED_EXPLICIT` | `sharedExplicit: true` |

**There is no automatic downgrade.** A dirty checkout is exactly the state in which
`WorktreeManager.prepare` refuses with `WORKTREE_SOURCE_DIRTY` (§3.6), which is why
the same condition is measured here — but the remedy is a decision, not a default.
`allowShared` is a per-call request, never a stored setting: the plugin does not
record that shared isolation is "fine" and cannot be made to prefer it silently.

**A subdirectory is not a workspace.** It has its own reason
(`PREFLIGHT_NOT_A_REPOSITORY_ROOT`) because the honest remedy is different:
`allowShared` decides *where* a dirty run executes and is not permission to treat a
subdirectory as a workspace, so the refusal is decided before status is read and
holds with or without `allowShared`. `facts.repository` is `true` for such a path
(it really is inside a repository) while `facts.clean` stays `null` (unmeasured),
and `guidance` names the measured repository root — it never suggests `worktree`
or `shared`, because neither is safe for a path that is not the root.

### Surfaces

| Surface | Shape |
|---|---|
| MCP tool | `delegate_preflight { workspacePath, allowShared? }`, `additionalProperties: false`; `allowShared` must be a real boolean |
| execution plane | `POST /dsh-delegate/x/workspace/preflight` → `200` with the decision, `400 WORKSPACE_PATH_REQUIRED` for a missing path |

The route is behind the same transport fence and connection identity as every other
execution-plane route, but it is deliberately **not** gated on the switch or on the
concurrency cap: it authorizes nothing and consumes nothing, so it stays answerable
while delegation is off (that is when a coordinator decides whether a dispatch is
worthwhile) and while every slot is busy. It is the only execution-plane route
besides `/status` and `/tasks` reads that answers with the switch off.

---

## 3.6 `WorktreeManager`

```js
const manager = new WorktreeManager({ runGit }, { rootDir });
const prepared = await manager.prepare({ taskId, sourcePath, signal });
```

`rootDir` must be absolute. It is created once (`mode: 0o700`) and resolved with
`realpath`, and every containment check compares real paths.

### `prepare({ taskId, sourcePath, signal })`

Returns:

```json
{
  "taskId": "task-…",
  "workspacePath": "<rootDir>/<safe-task-id>-<suffix>",
  "sourcePath": "<real path of the source repository>",
  "baseHead": "5d0f…",
  "isolated": true,
  "detached": true,
  "state": "active",
  "createdAt": 1792400000000,
  "completedAt": null,
  "sourcePreexistingChanges": 0,
  "disposable": true
}
```

Steps, in order — each can refuse:

1. validate `taskId`, `sourcePath`, signal;
2. resolve `sourcePath` with `realpath`;
3. measure the repository top level with `git rev-parse --show-toplevel` and
   resolve it with `realpath`; an unmeasurable top level is
   `WORKTREE_NOT_A_REPOSITORY`;
4. refuse if `rootDir` (declared or resolved) is anywhere inside that
   **repository root** — not merely inside `sourcePath`;
5. probe the source: git available, a work tree, at least one commit → pin `head`;
6. require a clean source (`git status -z` reports nothing);
7. claim a unique destination under the root and refuse if it exists, or if it
   falls inside the repository root;
8. `git worktree add --detach <path> <pinned-head>`;
9. verify `rev-parse --verify HEAD` in the new tree equals the pinned commit;
10. refuse if the signal aborted at any point.

Step 4 is the containment decision, and it is deliberately made against the
measured top level rather than against the supplied path. When `sourcePath` is a
subdirectory of its repository, a `rootDir` located elsewhere in that same
repository is outside `sourcePath` but still inside the user's checkout; only the
top level catches it. Step 7 repeats the check on the final destination.

A refusal at steps 1–7 touches nothing: the top-level read is read-only and
`rootDir` is not created until the containment check has passed. A refusal at
step 9 or a cancellation at step 10 removes the tree it just made
(`git worktree remove --force` + `prune`) and drops the registry entry, because
the caller never received the path — no unreviewed work can exist there.

**Why a clean source is required.** A worktree is built from a commit. If the
source has uncommitted edits, those edits are simply absent from the tree, and
the run fails for a reason nobody can see. The refusal says how many changes were
found and names them (bounded), never what they contain.

**Why `--detach`.** The tree is bound to a commit, not a branch. Nothing the run
does can move a ref in the user's repository, and no branch is checked out twice.

**Refusal codes**

| Code | Meaning |
|---|---|
| `WORKTREE_GIT_UNAVAILABLE` | git cannot be executed here |
| `WORKTREE_NOT_A_REPOSITORY` | the source is not inside a git work tree, or its top level cannot be measured |
| `WORKTREE_NO_COMMITS` | the source has no commit; commit first |
| `WORKTREE_SOURCE_DIRTY` | the source has uncommitted changes (`details.changes`, `details.paths`) |
| `WORKTREE_ROOT_INVALID` | `rootDir` is not absolute, or `sourcePath` is not absolute |
| `WORKTREE_PATH_ESCAPE` | the generated destination left the root |
| `WORKTREE_NESTED_DESTINATION` | `rootDir` or the destination is inside the **repository root** (`details.sourcePath`, `details.repositoryRoot`) |
| `WORKTREE_DESTINATION_EXISTS` | the chosen path already exists |
| `WORKTREE_CANCELLED` | the signal was aborted (`details.phase`: `before-probe`, `before-create`, `after-create`) |
| `WORKTREE_GIT_FAILED` | a git invocation failed (`details.step`, `details.exitCode`, bounded `stderr`) |
| `WORKTREE_TASK_ID_INVALID` | no usable task id |
| `WORKTREE_UNKNOWN_TREE` | not a tree this manager owns |
| `WORKTREE_NOT_REVIEWED` | refusing to delete a tree that is still active |

Cancellation is checked before the probe, before creation and again after
verification. A caller that receives `WORKTREE_CANCELLED` must not start a run;
there is no path where a cancelled request yields a usable workspace.

### `markComplete(workspacePath)`

Moves a tree to `awaiting-host-review` and stamps `completedAt`. It is **not**
approval: host acceptance is a separate, host-owned action, exactly as for a task.

### `list(filter)` / `get(workspacePath)`

Metadata only. The returned object has exactly these keys: `taskId`,
`workspacePath`, `sourcePath`, `baseHead`, `isolated`, `detached`, `state`,
`createdAt`, `completedAt`, `sourcePreexistingChanges`, `disposable`. No file
content, no diff, no error text. `filter` accepts `taskId` and `state`. Newest
first.

### `dispose(workspacePath, { reviewed })`

Removes one tree with `git worktree remove --force` + `prune`, then marks the
record `disposed`.

- A tree in `awaiting-host-review` may be disposed (the host looked at it).
- A tree still `active` is refused with `WORKTREE_NOT_REVIEWED` unless the caller
  passes `reviewed: true`. Deleting a tree a run may still be using would destroy
  the only evidence of what the run changed.
- An unmanaged path is refused with `WORKTREE_UNKNOWN_TREE`; the manager never
  deletes a directory it did not create.
- Removing an already-disposed tree is refused, so a double dispose cannot look
  like success.

**Trees are kept after a run.** Nothing in this module deletes a tree on a timer,
at startup, or when a task ends. A forgotten tree is still on disk and still
reviewable; a silently deleted one is lost evidence. The registry is in memory
only, so a restart forgets metadata and leaves the trees — that is stated here so
nobody mistakes `list()` being empty for the trees being gone.

---

## 5. Engine integration contract

The engine (`src/jobs/engine.js`) is not modified by this document; these are the
call shapes it should use, and the properties it can rely on.

### 5.1 Isolation is chosen before anything else happens

```js
if (effective.worker.isolation === 'worktree') {
  const manager = new WorktreeManager({ runGit: this.deps.runGit }, { rootDir: worktreeRoot(dataDir) });
  const prepared = await manager.prepare({ taskId, sourcePath: resolvedWorkspacePath, signal: task.controller.signal });
}
```

- `taskId` must be generated *before* `prepare` (the manager uses it in the path).
- `sourcePath` must already be resolved with `realpath` (`resolveWorkspacePath`).
- The workspace the agent runs in is `prepared.workspacePath`; the workspace the
  lock is keyed on and the baseline is captured in must be the **same** value.
- A refusal here is `JOB_ISOLATION_REFUSED` with `details.cause` set to the
  `WORKTREE_*` code. It must not fall back to `shared`: silently downgrading
  isolation executes a job with weaker isolation than the operator asked for.

### 5.2 Ordering with authorization and concurrency

Authorization is consumed before a worktree exists (one grant, one attempt). The
concurrency cap and the workspace lock are checked against the **source** path's
job slot before `prepare`, because creating a worktree is a side effect on disk.
Two jobs that request worktree isolation in the same source repository are
independent trees, but they still mutate the same git repository's administrative
area, so the source-path lock may be held for the duration of a run; that is a
policy decision for the engine, and it is the engine's to make explicitly.

### 5.3 Baseline and diff

Inside the tree, `captureBaseline` and `captureDiff` work unchanged: the tree is a
normal git work tree at a detached commit. `baseline.head` will equal
`prepared.baseHead` unless the run commits, and a run that commits is precisely
what the pinned comparison point protects against.

### 5.4 Cancellation

Pass `task.controller.signal` into `prepare`. A rejection with
`WORKTREE_CANCELLED` means no run may start. Do not catch it and continue to
`runAgent`.

### 5.5 Completion and disposal

When a run terminates, call `manager.markComplete(prepared.workspacePath)` and
record the metadata on the task view. Do **not** dispose. The host reviews the
tree (through the diff evidence, or directly) and only then calls
`dispose(workspacePath, { reviewed: true })`.

`manager.dispose()` on plugin shutdown must not remove trees; at most it should
stop tracking them, leaving the directories for the host. This module offers no
shutdown-time deletion, by design.

### 5.6 What the engine must not do

- Do not pass a caller-supplied path as `rootDir` or as the destination.
- Do not treat `isolated: true` as a security boundary statement — it means "the
  agent's cwd is a different checkout". Same OS account, same filesystem.
- Do not reuse a disposed tree, and do not re-enter `prepare` with a task id that
  already has a live tree; the manager will create a second tree, which is
  correct behaviour for a retry but must be a deliberate engine decision.

---

## 6. Known limits

1. **Not a sandbox.** Worktree isolation keeps the human's working tree clean. It
   does not confine a hostile process; an agent with the same OS account can write
   anywhere that account can.
2. **In-process registry.** A second DSH process, or a restart, sees no trees. The
   directories remain on disk.
3. **Crash orphans.** A plugin crash between `worktree add` and the registry write
   can leave a directory under the root with no record. It is inert and
   reviewable; nothing here deletes it automatically.
4. **Sensitivity is name-based.** A secret inside a file with an ordinary name is
   caught only by the `redactText` safety net, not by exclusion.
5. **Renames are detected by git's own similarity heuristic.** A move that git
   reports as delete+add yields two records; both sides are still inspected for
   sensitivity, so the outcome is the same.
