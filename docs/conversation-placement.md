# DSH conversation placement and task threads

Which DSH **Workspace** a delegated run appears in, and which conversation it
drives. Implementation: `src/runtime/session-placement.js`, wired in
`src/index.js`, called by `src/runtime/agent-runner.js` and
`src/jobs/engine.js`.

This is unrelated to `docs/workspace-contract.md`: that document is about the
repository root a run mutates. This one is about the DSH Workspace *group* the
run's Session is filed under, and about which task thread it continues.

## The rule, in one paragraph

**A new submission is a new conversation. A follow-up continues exactly one named
task thread.** There is no directory-level `new`/`reuse` setting and no
directory-keyed identity map. `delegate_submit` accepts the optional field
`continueFromTaskId`; omitting it always creates a fresh DSH Session in the
Workspace for the run's execution path, and supplying it continues the DSH
Workspace and Session that *that* task drove. Supplying it is the only way any
conversation is ever continued.

## The two questions, and the two services that answer them

| Question | Native service | Dependency key |
| --- | --- | --- |
| Which Workspace group? | `ctx.workspaceController` | `deps.workspaces` |
| Which Session, and its Agent? | `ctx.sessionController` | `deps.sessionController` |

`ctx.sessions` is the native **persistence** service (`flush`). It cannot create
or resolve a Session, so `deps.sessions` is never used for placement. Reading it
there was a real defect: it reported a fully composed harness as having no
session controller, and every worker run failed with
`SESSION_CONTROLLER_UNAVAILABLE`. The wiring is asserted directly in
`tests/session-placement.test.js` ("placement reads the session CONTROLLER,
never the native sessions service").

## Verified native signatures

Read from the installed runtime declarations, not guessed:

- `WorkspaceController.create(request: { path }): Promise<{ workspace:
  WorkspaceView, created: boolean }>` — create-or-reuse over an existing
  directory; `WorkspaceView` carries `workspaceId` and the canonical `path`.
- `SessionController.create(request: { workspaceId?, cwd?, sessionId?,
  agentPreset? }): Promise<{ sessionId, agentPreset? }>`.
- `SessionController.resolveAgent(sessionId): Promise<{ agent } | { error }>`,
  where the error is a `RemoteError` of `session/not-found`,
  `session/agent-busy`, `session/writer-held` or `gateway/internal`.
- `Agent` carries `id`, `session`, a live `ctx: Context` (`ctx.on(...)`), plus
  `followup`, `cancel`, `whenIdle`.

## Flow

1. **Capability checks first.** A missing controller is a stated refusal
   (`SESSION_WORKSPACES_UNAVAILABLE` / `SESSION_CONTROLLER_UNAVAILABLE`), never a
   fallback to an ungrouped session.
2. **Workspace.** `workspaceController.create({ path })` with the run's *actual*
   execution directory (`task.executionPath` — the worktree when isolation
   prepared one, the source checkout otherwise). Repeating a run in one directory
   reuses one group instead of accumulating duplicates.
3. **Session.**
   - `continueFromTaskId` **omitted** — `sessionController.create({ workspaceId })`
     creates a fresh Session, then `resolveAgent` attaches its Agent. Nothing is
     read from the identity map, so a directory with a long history still gets a
     new conversation.
   - `continueFromTaskId` **supplied** — that task's recorded identity is loaded
     and every fact a continuation depends on is re-checked (below), including the
     connection that submitted it (from the live record, or from the durable job
     history after a restart), then `resolveAgent` returns the live Agent of the
     *same* Session, so the next turn lands in the same native session log. A
     parent whose ownership cannot be proven is refused before this step.
4. **Drive.** Both paths return a resolved `agent`, and the runner drives it.
   `agents.create` is not used for a placed run: the Session already exists, so
   creating an Agent that way would create a *second* Session beside the placed
   one. The runner installs this run's provider/model/effort on the resolved
   Agent's own context, so a per-task selection still governs a continued
   conversation.
5. **Cancellation before placement.** An already-aborted signal returns
   `cancelled` before any Workspace or Session is created, so a run that never
   starts cannot leave an orphan group or an empty conversation.

## Validating a continuation (fail-closed)

Every check below refuses. None of them falls back to creating a new Session,
because that would report a continued conversation the operator is not in.

Two vocabularies, in this order:

- **Ownership.** While it cannot be proven that this caller submitted the parent,
  every answer is the same `JOB_TASK_NOT_FOUND`, with no cause and no thread hint:
  an unknown id, a pruned or truncated record, a record with no owner, a caller
  with no verified identity, no durable history at all, and another connection's
  task are deliberately indistinguishable, so the answer cannot enumerate tasks.
- **Joinability.** Only a caller that has proven the same owner ever learns *why*
  a chain cannot be joined: `JOB_CONTINUATION_REFUSED` at the job boundary, with
  the specific `SESSION_*` code in `error.details.session`.

## Who owns a task thread (survives a restart)

**Strictly the connection that submitted it.** Ownership is compared as two
identity strings, never as a pattern: the `local-mcp` identity of the local
switch is a real, fixed identity and is matched exactly like an external
connection, and "no identity" is never a wildcard in either direction.

Two authorities answer this, depending on where the parent came from:

| Parent | Authority for ownership | Authority for outcome |
| --- | --- | --- |
| Admitted by this process | the live task record's `connectionId`, verified when it was admitted | the live record's state, plus its recorded conversation |
| Recovered from `sessions.json` after a restart | the durable job history (`history.json`) `connectionId` | the durable record's `state` and its `execution.conversation` block |

`sessions.json` is deliberately **not** an authority for either. It records
where a thread lives — task id, paths, Workspace/Session ids, isolation and tree
facts — and nothing about who asked for the work or how the run ended. That is
why resuming from it alone was a defect: after a restart the in-memory check
disappeared and the map would have answered "yes" to any caller that knew the
task id. The durable job history is the second authority; the two are checked in
sequence, and both must agree with the caller.

Both checks run **before** placement, and admission runs them **before settings
are read and before a concurrency slot is claimed**, so a refusal never resolves
or drives a native Session: the conversation of a task that is not yours is never
touched. The engine's authority is `JobEngine.assertContinuation`, which decides
ownership and joinability in one pass; `JobEngine.assertAdmissible` is the same
rule applied synchronously to a live record, and placement calls it as a re-check
of a chain admission already proved — including the exact execution directory, so
placement never resumes a thread whose Workspace id merely looks familiar.

## The admission gate, in order

A `continueFromTaskId` submission is decided by one pass in `admit()`, before
step 3 (settings) and before step 4 (effective config and the concurrency slot):

1. **Ownership first, with one refusal.** The caller must present a verified
   connection id, and it must equal the parent's owner exactly. A live parent
   record states its own `connectionId`; a parent this process no longer holds is
   proven by the **durable job history** row's `connectionId`. No verified caller,
   no history store, an unreadable or malformed history document, no record for
   the id, a truncated record and a record with no owner all answer the same
   `JOB_TASK_NOT_FOUND`.
2. **One snapshot, one shape.** History is read **exactly once** and reduced to
   `{ state, sourcePath, executionWorkspacePath, isolation, conversation }`, with
   `conversation` taken from `row.execution.conversation`; a live parent supplies
   the same shape from its own record. There is no second read of history and no
   "the row was null, so skip the checks" branch — a failed read is a refusal,
   never a pass.
3. **The identity map** (`sessions.json`) is read exactly once and judged together
   with that snapshot. Its Workspace id, execution dir, source repository and
   isolation must agree with the snapshot; a missing row or an empty Session id is
   refused.
4. **The verified result is what steps 4 and 7 read.** Only after every check
   passed is the identity recorded on the task, which is what makes the effective
   isolation the parent's and what makes a worktree parent reuse the original tree
   instead of preparing a new one.

| Check | Refusal |
| --- | --- |
| Parent task id is unknown, pruned, or was never recorded here | `JOB_TASK_NOT_FOUND` |
| Parent was submitted by another connection — in this process or, after a restart, according to the durable history | `JOB_TASK_NOT_FOUND` |
| Ownership cannot be proven at all (no verified caller identity, no durable history, no history record, a truncated record, a record that states no owner) | `JOB_TASK_NOT_FOUND` |
| Parent has not ended: `pending`/`running` (still running), `interrupted` (live when a previous process stopped), or a state this build does not know | `JOB_CONTINUATION_REFUSED` + `SESSION_CONTINUATION_STATE` |
| Parent ended without a placement that reached a Session (`kind` not `new`/`continuation`, or an empty Workspace id or Workspace path) — including an admission refusal or policy failure | `JOB_CONTINUATION_REFUSED` + `SESSION_CONTINUATION_STATE` |
| Parent ran for another source repository, in the snapshot or in the identity map — including a masked or missing source path, which cannot prove which repository it names | `JOB_CONTINUATION_REFUSED` + `SESSION_CONTINUATION_WORKSPACE_MISMATCH` |
| Snapshot or identity execution path is missing, empty or masked; the snapshot names no recognized isolation | `JOB_CONTINUATION_REFUSED` + `SESSION_CONTINUATION_UNAVAILABLE` |
| Identity map has no row, no Session id, or a Workspace id / execution dir / isolation that contradicts the snapshot | `JOB_CONTINUATION_REFUSED` + `SESSION_CONTINUATION_UNKNOWN` (no row) / `SESSION_CONTINUATION_UNAVAILABLE` (row contradicts the snapshot) |
| Parent's execution dir differs from this run's resolved directory (including a different worktree and a recorded conversation placed in another directory), or the parent's Workspace is not this run's | `JOB_CONTINUATION_REFUSED` + `SESSION_CONTINUATION_PATH_MISMATCH` / `SESSION_CONTINUATION_WORKSPACE_MISMATCH` |
| The build cannot resolve a Session at all | `JOB_CONTINUATION_REFUSED` + `SESSION_RESUME_UNAVAILABLE` |
| The Session no longer exists | `JOB_CONTINUATION_REFUSED` + `SESSION_RESUME_FAILED` with `cause: session/not-found` |
| The resolved Agent's own `cwd` header names another directory | `JOB_CONTINUATION_REFUSED` + `SESSION_RESUME_PATH_MISMATCH` |

Because the whole gate runs before the slot is claimed, a refusal is stable: a
parent that is still running is refused for its own state, never masked by
`JOB_CONCURRENCY_LIMIT`, and a parent's isolation mode is known before any mode is
resolved.

**A new grant is not a new owner.** Authorization tokens do not survive a
restart, so a returning client obtains a fresh grant; that grant authorizes the
*connection*, which is the same identity, so the follow-up is admitted. A
different connection holding its own perfectly valid grant is refused — a valid
authorization is never an authorization to join somebody else's chain. A
connection id that DSH re-issues after a restart is a **new** identity, so a
re-issued id is refused; there is no label or fuzzy matching anywhere in this
path.

**Fail closed, always.** Missing history, an unreadable or malformed history
document, a truncated record, a record with no owner, a pruned record, an
`interrupted` run (the job was live when a previous process stopped), a failed or
cancelled run that never drove a conversation, and a record naming another
repository are all refusals. None of them falls back to "the map says the thread
is there, so it must be yours".

**Masked paths are a refusal, never a wildcard.** The documents are projected
through redaction, which rewrites an account-identifying directory segment
(`masks-user-profile-segment`). A path carrying that segment cannot prove which
directory it names, so it is treated exactly like a missing path: it never equals
anything, it is never a pattern that matches a live path, and the continuation is
refused. Nothing in this path treats a mask as equality, and that holds for both
documents and for the live re-check.

**Equal Workspace ids are not proof of equal placement.** A recorded conversation
must name a real Workspace *and* a directory this run resolved, and a live parent
must have executed in this run's directory. A row that keeps the parent's
Workspace id while pointing the conversation at another directory is refused, and
so is a parent whose execution dir differs from the one this run resolved.

**Task locking.** A continuation chain is serialized by the existing workspace
locks rather than by a second mechanism: the parent holds the lease on its
execution path (and on its source path) for the whole run, so a follow-up that
targets the same path is refused with `JOB_WORKSPACE_BUSY` until the parent has
finished. A continuation can therefore never drive a thread mid-turn, and two
follow-ups of one chain cannot run at once.

## Preserving workspace state for a follow-up

The execution path is part of the continuation:

- a **shared** parent continues in that same source checkout;
- a **plugin-managed worktree** parent continues in that same tree. The tree is
  where the parent's uncommitted changes are, so a fresh tree would silently hide
  them. The caller continues to authorize the source repository in `workspacePath`;
  the engine restores the parent task's isolation and resolves the exact managed
  tree from its recorded identity. It never asks the caller to authorize an
  internal worktree path or substitutes a fresh tree. A tree that is gone,
  disposed, unregistered, mismatched, or not a real directory is refused with
  `SESSION_CONTINUATION_UNAVAILABLE`. A source checkout becoming dirty after the
  parent run does not redirect the continuation: the follow-up still targets the
  original isolated tree and captures a fresh baseline there.

Isolation belongs to the task chain. A follow-up uses the parent's recorded
`shared` or `worktree` isolation even if global or project settings changed after
the parent ran. A caller override that explicitly conflicts with that isolation is
refused. For a shared parent, the same source path is locked and audited again; for
a worktree parent, both the source and original tree are locked for the follow-up.

## Settings: what was removed, and what remains

`conversation.mode` is **retired**. It is still accepted on read so an existing
document keeps loading, and it is inert: no code path consults it, so a stored
`"reuse"` cannot cause an implicit reuse. The settings page no longer offers the
control, `setConversation` refuses with `CONVERSATION_MODE_REMOVED` rather than
silently accepting a value with no effect, and the effective snapshot carries
`conversation.policy: "per-task"` — the rule, not a stored choice.

## What is stored

`sessions.json` beside the settings document, **one row per task**:

```json
{
  "taskId": "task-…",
  "sourcePath": "E:\\work\\repo",
  "executionPath": "E:\\dsh\\data\\dsh-delegate\\worktrees\\task-…",
  "workspaceId": "…",
  "sessionId": "session-…",
  "isolation": "worktree",
  "worktreeId": "task-…",
  "worktreeState": "awaiting-host-review",
  "updatedAt": 1767225600000
}
```

No prompt, transcript, output, credential or token count. The native session log
stays the sole owner of conversation content.

**Migration.** Rows written by the previous build were keyed by canonical
execution directory and carried no task id (`{ path, workspaceId, sessionId,
updatedAt }`). They cannot name a task thread, so they are ignored on read: there
is nothing to continue and nothing that could act as an implicit source of reuse.
The document is rewritten as schema 2 on the next save.

**After a plugin restart** a continuation still works when all of the following
hold: the identity map and the native Session both exist, the durable job
history still has a record for the parent, that record names the SAME connection
and a terminal state that has a conversation, and its recorded repository agrees
with this submission. When any of these fails the answer is an explicit
`JOB_TASK_NOT_FOUND` (ownership) or `SESSION_CONTINUATION_UNKNOWN` /
`SESSION_CONTINUATION_STATE` / `SESSION_CONTINUATION_UNAVAILABLE` /
`SESSION_RESUME_FAILED` (everything else) — never a different or a new session,
and never the parent's Session. A connection identity that DSH re-issues under a
new id after the restart is a different identity and is refused; there is no
label or fuzzy matching anywhere in this path.

## Ownership and disposal

A resolved Agent belongs to its Session, so the runner never disposes one:
disposal would end the conversation and make a later `continueFromTaskId`
follow-up unable to resolve it. Only the unplaced path (`allowUnplaced`, used by
the additional review) creates an Agent through `agents.create`, and only that
Agent is disposed.

The review sets `allowUnplaced: true` deliberately: it must not join the
operator's Workspace history, it is not part of the worker thread, and it is not
resumable by a later continuation.
