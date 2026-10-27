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
     and every fact a continuation depends on is re-checked (below), then
     `resolveAgent` returns the live Agent of the *same* Session, so the next turn
     lands in the same native session log.
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

| Check | Refusal |
| --- | --- |
| Parent task id is unknown, pruned, or was never recorded here | `SESSION_CONTINUATION_UNKNOWN` |
| Parent is still running in this process | `SESSION_CONTINUATION_STATE` |
| Parent ended without a conversation (e.g. admission refusal) | `SESSION_CONTINUATION_STATE` |
| Parent was submitted by another connection | `JOB_TASK_NOT_FOUND` (reported as absent, not forbidden) |
| Parent ran for another source repository | `SESSION_CONTINUATION_WORKSPACE_MISMATCH` |
| Parent's execution path differs from this submission's (including a different worktree) | `SESSION_CONTINUATION_PATH_MISMATCH` |
| Parent's recorded Workspace id is not this run's Workspace | `SESSION_CONTINUATION_WORKSPACE_MISMATCH` |
| Recorded identity has no session, source/execution path or recognized isolation, or a removed/mismatched worktree | `SESSION_CONTINUATION_UNAVAILABLE` |
| The build cannot resolve a Session at all | `SESSION_RESUME_UNAVAILABLE` |
| The Session no longer exists | `SESSION_RESUME_FAILED` with `cause: session/not-found` |
| The resolved Agent's own `cwd` header names another directory | `SESSION_RESUME_PATH_MISMATCH` |
| The identity map is missing or unreadable | `SESSION_CONTINUATION_UNAVAILABLE` |

At the job boundary these surface as `JOB_CONTINUATION_REFUSED`, with the
specific `SESSION_*` code in `error.details.session`.

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

**After a plugin restart** a continuation still works when the identity map and
the native Session both exist: the row is loaded from disk and the Session is
resolved from the session controller. When either is gone the answer is an
explicit `SESSION_CONTINUATION_UNKNOWN` / `SESSION_CONTINUATION_UNAVAILABLE` /
`SESSION_RESUME_FAILED`, never a different or a new session.

## Ownership and disposal

A resolved Agent belongs to its Session, so the runner never disposes one:
disposal would end the conversation and make a later `continueFromTaskId`
follow-up unable to resolve it. Only the unplaced path (`allowUnplaced`, used by
the additional review) creates an Agent through `agents.create`, and only that
Agent is disposed.

The review sets `allowUnplaced: true` deliberately: it must not join the
operator's Workspace history, it is not part of the worker thread, and it is not
resumable by a later continuation.
