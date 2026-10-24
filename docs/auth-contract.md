# Local delegation switch and legacy grant internals

The current DSH plugin uses one persisted `delegationEnabled` switch. A new
installation starts OFF. When it is OFF, the execution plane refuses new task
submissions with `DELEGATION_DISABLED` and the engine requests cancellation of
live tasks. Status, result reads and cancellation remain available. The DSH UI
updates this switch through the authenticated user plane; MCP has no switch,
grant, credential or settings write tool and needs no issued token.

In switch mode, the user plane does not register the old connection, grant or
revoke-all routes. The execution plane is registered only on loopback. While the
switch is ON, any local process that can reach that port may submit a task, so
this setting is not per-process authentication or a same-user security boundary.

The remaining notes document the grant registry retained for compatibility and
its isolated grant-mode tests. They are not the current product authorization
contract.

## Legacy grant-mode contract

The short version of how a delegation authorization is created, kept alive, and
ended. `src/auth/grants.js` is the only component that decides any of it.

## 1. The engine uses two things, not one

`JobEngine` (`src/jobs/engine.js`) depends on the registry in exactly two ways.

**Subscribe for invalidation.** `AuthorizationRegistry#subscribe` delivers one
event per authorization that stops being usable for a reason other than "this
request failed":

| event | when |
| --- | --- |
| `{kind:'grant', grantId, connectionId, reason:'revoked'}` | operator revoked one grant |
| `{kind:'grant', grantId, connectionId, reason:'expired'}` | the grant passed `expiresAt`, including a grant a running task already consumed |
| `{kind:'connection', connectionId, reason:'revoked'}` | operator revoked a connection; its grants are revoked in the same step |
| `{kind:'connection', connectionId, reason:'lease-expired'}` | the connection's idle lease lapsed |
| `{kind:'all', reason:'revoked-all'}` | `revokeAll()` — the dispose path |

The engine cancels the tasks named by those ids. That is the whole reason
revocation is a cancellation rather than a promise.

**Call `assertTaskAuthorized` while a task runs.** Each progress check re-proves
four facts: the connection is live, the grant belongs to that connection and
covers that workspace, and — for a `task` grant — the grant is consumed by
*this* task id. Only `revokedAt` and `expiresAt` disqualify the grant itself;
being consumed is the binding being checked, not a refusal. An unconsumed task
grant yields `GRANT_NOT_CONSUMED`, a grant consumed by someone else yields
`GRANT_CONSUMED`.

Events are emitted once. A grant already announced as revoked is not announced
again as expired, and a connection already revoked is not re-announced.

## 2. The host runs the sweep timer

`AUTH_SWEEP_INTERVAL_MS` is 30 seconds. The host calls
`AuthorizationRegistry#sweep()` on that interval; the registry itself owns no
timer, so a disposed plugin cannot be woken by one. Each sweep is idempotent and
does three things:

1. revokes connections past their idle lease, with their grants, emitting one
   `connection` event each;
2. emits one `grant` expiry event for every unrevoked grant past `expiresAt`
   (consumed or not);
3. deletes grants and connections settled longer than `AUTH_RETENTION_MS`
   (10 minutes) ago.

Deletion is measured from the moment of settlement, never from the deadline, so
an entry that dies during a sweep is still visible for one full retention window.
A sweep that settles and deletes in the same step would hide the change from the
operator surface.

## 3. MCP heartbeats every 30 seconds

The MCP adapter authenticates to the execution plane with
`Authorization: Bearer <connection token>` on every request. That authentication
*is* the heartbeat: `authenticate()` is the only path that pushes `lastSeenAt`
forward.

- Default lease: **120 seconds** (`DEFAULT_CONNECTION_LEASE_MS`), overridable per
  registry. With a 30-second heartbeat that tolerates three missed beats.
- A lapsed token is refused *without* renewal, so a stale token cannot revive
  its own connection.
- Heartbeat interval = sweep interval = 30 seconds, so a silent connection is
  revoked before the next sweep would need to notice it.

## 4. Ordinary reads do not renew the lease

`listGrants`, `listConnections`, `isDelegationAuthorized`, `requireSessionGrant`,
`consumeTaskGrant` and `assertTaskAuthorized` never touch `lastSeenAt`. An
idle MCP client polling status cannot keep its delegation authorization alive;
only an authenticated request can. The tests pin this.

## 5. Transport fence

Before the Bearer token is examined, `src/auth/fence.js` requires a loopback
peer, a Host header that parses as exactly one authority naming this machine, a
`Sec-Fetch-Site` of `same-origin`/`none` (or absent), and — when `Origin` is
present — a same-origin local Origin.

`parseRequestAuthority` rejects a Host header outright rather than normalising
it: no leading/trailing whitespace, no userinfo, path, query, fragment,
backslash, comma or control character, and no numeric host that the URL parser
would expand. `127.1`, `2130706433`, `0x7f.0.0.1`, `0177.0.0.1` and
`127.0.0.256` are all refusals, not `127.0.0.1`.

The user plane (`fenceUserPlane`) is deliberately asymmetric: an authenticated
read (`GET`/`HEAD`) may omit `Origin`, while any write must carry a same-origin
`Origin` and a JSON content type. This helper is a rule under test; the live
user plane runs on the native `connection.fetch` carrier, which applies the
harness's own fence and browser-session authentication, so it does not call this
function and does not parse HTTP headers itself.
