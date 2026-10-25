# DSH conversation placement

Which DSH **Workspace** a delegated run appears in, and which conversation it
drives. Implementation: `src/runtime/session-placement.js`, wired in
`src/index.js`, called by `src/runtime/agent-runner.js`.

This is unrelated to `docs/workspace-contract.md`: that document is about the
repository root a run mutates. This one is about the DSH Workspace *group* the
run's Session is filed under.

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
   - `new` (default): `sessionController.create({ workspaceId })` creates a fresh
     Session, then `resolveAgent` attaches its Agent.
   - `reuse` (opt-in): the Session recorded for the *same canonical path* is
     resumed via `resolveAgent`. A different directory is never reached across; a
     record whose path differs, or whose Agent reports another `cwd`, is refused
     (`SESSION_RESUME_PATH_MISMATCH`) rather than repaired.
4. **Drive.** Both modes return a resolved `agent`, and the runner drives it.
   `agents.create` is not used for a placed run: the Session already exists, so
   creating an Agent that way would create a *second* Session beside the placed
   one. The runner installs this run's provider/model/effort on the resolved
   Agent's own context, so a per-task selection still governs a continued
   conversation.
5. **Cancellation before placement.** An already-aborted signal returns
   `cancelled` before any Workspace or Session is created, so a run that never
   starts cannot leave an orphan group or an empty conversation.

## Settings

`conversation.mode` is `new` (default) or `reuse`, stored in the plugin settings
document and frozen per task into `task.effective`. Documents written before the
field existed resolve to `new`. An unknown value is refused
(`CONVERSATION_MODE_UNSUPPORTED`), never mapped onto the default.

The control lives in the Execution settings panel
(`src/client/index.jsx`, `ExecutionPanel`), and the value round-trips through
`draftFromSettings` / `documentFromDraft` / `publicSettings` via
`conversationOf`.

## What is stored

`sessions.json` beside the settings document, one row per directory:
`{ path, workspaceId, sessionId, updatedAt }`. No prompt, transcript, output,
credential or token count. The native session log stays the sole owner of
conversation content.

## Ownership and disposal

A resolved Agent belongs to its Session, so the runner never disposes one:
disposal would end the conversation and make the next `reuse` run unable to
resume. Only the unplaced path (`allowUnplaced`, used by the additional review)
creates an Agent through `agents.create`, and only that Agent is disposed.

The review sets `allowUnplaced: true` deliberately: it must not join the
operator's Workspace history, and it must not be resumable by a later `reuse`
run.
