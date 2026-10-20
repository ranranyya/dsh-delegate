# Stage B contracts: user plane and execution plane

This document is the contract a later Chinese-language native DSH settings UI
("Stage B UI") codes against. It records the exact routes, methods, request
bodies and response shapes that exist in this repository today, and it
distinguishes the two planes because they have different credentials, different
carriers and different authority.

Nothing here has to be renegotiated by the UI: the UI drives only the **user
plane**. The execution plane is documented for completeness because connection
tokens and task ids appear in both, and mixing them up is the one way the UI can
produce a security bug.

---

## 1. Two planes, two credentials

| | User plane | Execution plane |
|---|---|---|
| Full URL | `/api/dsh-delegate/<route>` | `/dsh-delegate/x/<route>` |
| Carrier | `ctx.connection.fetch` (native exact fetch routes) | `ctx.webServer.register` (plain node:http) |
| Transport fence | the harness's own `/api` Host/Origin fence | loopback socket + loopback Host + same-origin browser marker |
| Who is admitted | the operator's authenticated browser session, proven by the native `connection` service *before* any handler runs | one registered connection, proven by `Authorization: Bearer <connection token>` on each request |
| What it may do | issue and revoke connections and grants, read/write settings, read the catalog, read/cancel tasks | submit a task, read tasks, cancel tasks — it can only *exercise* an authorization, never create one |
| Adds its own auth header | **no** | yes: `authorization: Bearer <token>` |
| Method vocabulary | `GET`, `HEAD`, `POST` only | `GET`, `POST` |

Two rules follow and neither is negotiable in the UI:

1. **The user plane never inspects an `authorization` header.** Presenting a
   connection token to a user-plane route changes nothing; admission already
   happened in the carrier. A UI that works because "the browser has a cookie" is
   correct; a UI that works because "we sent a token" is relying on something the
   user plane does not implement.
2. **The execution plane cannot issue authorization.** No route there creates a
   connection, issues a grant, writes settings or changes policy.

### Native registration constraints (why the routes look like this)

From the installed `@deepseek-ai/dsh-client-connection` 0.2.0-rc.2
(`lib/index.js`, `lib/types/rpc.d.ts`):

- `path` must resolve below `/api` (`endpointFromPath(channel, pathname)` at
  `lib/index.js:711`, called with `"/api"`).
- `methods` may only be `GET`, `HEAD`, `POST`
  (`type ConnectionFetchMethod`).
- `requestBody` may only be `buffered` or `streaming`
  (`type ConnectionRequestBodyMode`). There is **no** `none` mode.
- Routes are keyed by exact path (`this.fetchRoutes.get(url.pathname)`); a second
  registration of one path throws
  (`connection: exact Fetch route "…" is already registered`, `lib/index.js:634`).

Therefore: one exact path per route, methods combined, and dispatch on
`request.method` inside handlers that own more than one method. All user-plane
routes declare `requestBody: 'buffered'` — the bodies are small JSON control
documents and streaming would only add an unbounded read. The plugin asserts
these properties itself before registering (`assertUserPlaneRoutes` in
`src/http/user-plane.js`), so a future edit cannot half-register the surface.

---

## 2. Common response conventions

Success bodies always carry `ok: true`. Refusals always carry:

```json
{ "ok": false, "error": { "code": "STABLE_CODE", "message": "human text", "details": {} } }
```

- `code` is stable and machine-checkable; the UI should switch on it and render
  its own Chinese label. `message` is English and may change.
- `details` is bounded, redacted, and may be `{}`.
- Responses are `cache-control: no-store` and `x-content-type-options: nosniff`.
- Nothing in any response contains a credential value, a credential hash, a
  provider endpoint's secret material or a connection token except at the single
  documented issuance moment (§3.6).

Status codes used: `200` read/commit, `201` issued, `202` accepted (execution
plane only), `400` malformed/validation, `401` execution-plane token missing or
invalid, `403` transport fence, `404` unknown route or unknown id, `405` method not
owned by the path, `409` conflict/refusal (grant consumed, workspace busy), `413`
body too large, `500` unexpected (message replaced by a generic one).

### Methods a path does not own

A path that declares `GET` and `POST` refuses anything else with:

```
405  allow: GET, POST
{ "ok": false, "error": { "code": "USER_PLANE_METHOD_NOT_ALLOWED",
  "message": "DELETE is not allowed on /api/dsh-delegate/settings",
  "details": { "method": "DELETE", "allowed": ["GET", "POST"] } } }
```

Note that the native carrier only forwards methods a route declared, so an
undeclared method normally never reaches the handler at all. The 405 exists for
direct and future in-process callers; the UI should treat a non-declared method
as a client bug rather than as a documented path.

---

## 3. User plane (authenticated; the UI's whole surface)

Prefix: `/api/dsh-delegate`. Eleven exact paths, one route each; `settings`,
`connections` and `grants` each carry both `GET` and `POST` on a single route and
dispatch on `request.method`.

| Path | Methods | Body | Purpose |
|---|---|---|---|
| `/api/dsh-delegate/status` | GET | — | plugin and delegation posture |
| `/api/dsh-delegate/settings` | GET, POST | — / `{settings}` | read / replace settings |
| `/api/dsh-delegate/catalog` | POST | `{}` or `{projectPath}` | provider model/effort catalog + effective config |
| `/api/dsh-delegate/connections` | GET, POST | — / `{label?}` | list / issue a connection |
| `/api/dsh-delegate/connections/revoke` | POST | `{connectionId}` | revoke one connection and its grants |
| `/api/dsh-delegate/grants` | GET, POST | — / `{connectionId,kind,workspacePath,ttlSeconds?,overrides?}` | list / issue a grant |
| `/api/dsh-delegate/grants/revoke` | POST | `{grantId}` | revoke one grant |
| `/api/dsh-delegate/authorization/revoke-all` | POST | `{}` | revoke every grant and connection |
| `/api/dsh-delegate/tasks` | GET | — | list tasks, optional `?connectionId=` |
| `/api/dsh-delegate/tasks/get` | POST | `{taskId}` | one task **with** its prompt |
| `/api/dsh-delegate/tasks/cancel` | POST | `{taskId}` | cancel, recorded as `cancelledBy: "operator"` |

(That table lists eleven paths: the count that matters is that every path appears
exactly once, and that `settings`, `connections` and `grants` each carry both
`GET` and `POST` rather than being split across two registrations of one path.)

### 3.1 `GET /api/dsh-delegate/status`

```json
{ "ok": true,
  "delegation": { "authorized": false, "reason": "no live delegation authorization exists" },
  "runtime": { "plugin": "dsh-delegate", "version": "0.1.0", "schemaVersion": 1,
    "bind": "127.0.0.1", "port": 3210,
    "executionPlane": "/dsh-delegate/x", "executionPlaneLocalOnly": true } }
```

`delegation.authorized` is the plugin's single "is delegation on" oracle. It is
`false` in a fresh process and after every restart, because authorization is held
only in memory. `runtime` is diagnostic: the UI should show `version` and may show
the bind facts, but must not build logic on them.

### 3.2 `GET /api/dsh-delegate/settings`

```json
{ "ok": true,
  "settings": {
    "schemaVersion": 1,
    "providers": [{ "id": "relay", "name": "Local relay", "protocol": "openai-chat",
      "baseUrl": "http://127.0.0.1:8443/v1",
      "credentialRef": "DSH_DELEGATE_RELAY_KEY", "models": [{ "id": "deepseek-chat", "efforts": ["low","medium","high"] }] }],
    "worker": { "providerId": "relay", "model": "deepseek-chat", "reasoningEffort": "medium",
      "timeoutSeconds": 1800, "maxParallelism": 1, "isolation": "shared" },
    "review": { "enabled": false, "providerId": null, "model": null, "reasoningEffort": null },
    "authorization": { "taskGrantTtlSeconds": 900, "sessionGrantTtlSeconds": 14400 },
    "projectOverrides": {}
  },
  "secrets": { "stored": "credential-seam-only", "values_returned": false } }
```

`credentialRef` is the *name* of a credential, not a credential. There is no field
in this document that ever carries a secret value; `secrets` says so explicitly so
the UI does not have to infer it. A masked secret the operator types belongs in the
credential seam, not in this document — settings validation refuses a provider that
carries a secret-shaped field (`PROVIDER_SECRET_IN_SETTINGS`).

### 3.3 `POST /api/dsh-delegate/settings`

Request: `{ "settings": <the full document above, minus `secrets`> }`.

Response `200`: `{ "ok": true, "settings": <committed public document> }`.

The document is replaced wholesale after full validation; there is no partial
patch on this path. Refusals:

| Code | Status | Meaning |
|---|---|---|
| `SETTINGS_MISSING` | 400 | no `settings` property in the body |
| `SETTINGS_INVALID` | 400 | envelope/schema problem |
| `SETTINGS_NO_PROVIDERS` | 400 | a document that needs a provider has none |
| `PROVIDER_*` | 400 | provider profile refused (`ID_INVALID`, `DUPLICATE`, `BASE_URL_INVALID`, `CREDENTIAL_REF_INVALID`, `PROTOCOL_UNSUPPORTED`, `SECRET_IN_SETTINGS`, …) |
| `MODEL_*` | 400 | model list refused (`INVALID`, `DUPLICATE`, `EFFORTS_INVALID`) |
| `SELECTION_*` | 409 | worker/review selection refused (`PROVIDER_REQUIRED`, `PROVIDER_UNKNOWN`, `MODEL_REQUIRED`, `MODEL_UNKNOWN`, `EFFORT_UNKNOWN`, `EFFORT_UNSUPPORTED`) |
| `BODY_INVALID_JSON`, `BODY_NOT_OBJECT`, `BODY_TOO_LARGE` | 400/413 | transport-level body problem |

A refused write leaves the stored document untouched; the UI can simply re-read
`GET` to recover. There is no `PUT` on this route and none should be added: the
native registry cannot carry it.

### 3.4 `POST /api/dsh-delegate/catalog`

Request: `{}` or `{ "projectPath": "C:\\work\\project" }` (`projectPath` is
optional and only affects the `effective` block).

```json
{ "ok": true,
  "catalog": [{ "providerId": "relay", "route": "relay",
    "models": [{ "id": "deepseek-chat", "efforts": ["low","medium","high"], "defaultEffort": null }],
    "error": null }],
  "effective": { "schemaVersion": 1,
    "worker": { "providerId": "relay", "model": "deepseek-chat", "reasoningEffort": "medium",
      "timeoutSeconds": 1800, "maxParallelism": 1, "isolation": "shared", "providerRoute": "relay" },
    "review": { "enabled": false, "providerId": null, "model": null, "reasoningEffort": null, "providerRoute": null },
    "provenance": { "projectPath": null, "applied": [] } } }
```

- `catalog[].models[].efforts` is the *authority* for which efforts the UI may
  offer. An effort absent here must not be selectable, and the server will refuse
  it anyway (`SELECTION_EFFORT_UNSUPPORTED`).
- `catalog[].error` is `null` or `{ code, message, detail? }`; a provider that
  cannot resolve models is reported, not hidden.
- `effective` is `null` when no provider is configured.
- `catalog` may be slow (it asks the routing layer per model). The UI must show a
  loading state and must not block the authorization controls on it.

### 3.5 `GET /api/dsh-delegate/connections`

```json
{ "ok": true,
  "connections": [{ "connectionId": "conn-<uuid>", "label": "codex",
    "createdAt": 1730000000000, "lastSeenAt": 1730000000000,
    "revoked": false, "revokedAt": null, "peer": { "address": "operator-session" } }] }
```

No token, no hash. A revoked connection stays listed so the operator can see what
happened; `revoked: true` means it can no longer authenticate on the execution
plane.

### 3.6 `POST /api/dsh-delegate/connections`

Request: `{ "label": "codex" }` (`label` optional; trimmed, max 80 chars).

```json
{ "ok": true,
  "connection": { "connectionId": "conn-<uuid>", "label": "codex", "createdAt": 1730000000000 },
  "token": "<base64url secret>",
  "tokenReturnedOnce": true }
```

**This is the only response in either plane that carries a secret.** The UI must
show it once, offer copy, and never persist it or request it again — a later
`GET` cannot return it. Refusal: `CONNECTION_LIMIT` (403) at the registry cap.

### 3.7 `POST /api/dsh-delegate/connections/revoke`

Request: `{ "connectionId": "conn-…" }` →
`{ "ok": true, "grantsRevoked": 2 }`.

Revoking a connection revokes every grant it holds in the same step. Refusals:
`CONNECTION_ID_REQUIRED` (400), `CONNECTION_UNKNOWN` (403 — the shared
`CONNECTION_` prefix maps to a transport-style refusal; the UI should read `code`,
not the status, to tell "unknown id" from "fence refused").

### 3.8 `GET /api/dsh-delegate/grants?connectionId=conn-…`

```json
{ "ok": true,
  "grants": [{ "grantId": "grant-<uuid>", "kind": "task", "workspacePath": "C:\\work\\project",
    "createdAt": 1730000000000, "expiresAt": 1730000900000,
    "consumedAt": null, "consumedByTaskId": null, "revokedAt": null, "overrides": null }] }
```

`connectionId` is a required query parameter (`CONNECTION_ID_REQUIRED`, 400).
The UI renders state from the four timestamps: `revokedAt !== null` → revoked;
`consumedAt !== null` → spent (task grants are single-use); `expiresAt <= now` →
expired; otherwise live.

### 3.9 `POST /api/dsh-delegate/grants`

```json
{ "connectionId": "conn-…", "kind": "task" | "session",
  "workspacePath": "C:\\work\\project",
  "ttlSeconds": 900,        // optional; defaults from settings.authorization
  "overrides": null }        // optional; providerId/model/reasoningEffort/timeoutSeconds/isolation
```

Response `201`:

```json
{ "ok": true,
  "grant": { "grantId": "grant-<uuid>", "kind": "task", "workspacePath": "C:\\work\\project",
    "createdAt": 1730000000000, "expiresAt": 1730000900000,
    "consumedAt": null, "consumedByTaskId": null, "revokedAt": null, "overrides": null } }
```

`kind` defaults to nothing: it must be `task` or `session` (`GRANT_KIND_INVALID`,
409). A grant always names exactly one connection and one absolute workspace, so it
cannot be spent elsewhere (`GRANT_MISMATCH`, 409). TTL defaults come from
`settings.authorization` (`taskGrantTtlSeconds` / `sessionGrantTtlSeconds`) and are
validated (`GRANT_TTL_INVALID`, 409). Other refusals: `GRANT_LIMIT` (409),
`CONNECTION_UNKNOWN` (403). This response contains **no** token — the operator
issues the grant, the connection already holds the credential.

### 3.10 `POST /api/dsh-delegate/grants/revoke`

Request: `{ "grantId": "grant-…" }` →
`{ "ok": true, "grant": { …grant snapshot with revokedAt set… } }`.

Operator-only: this path passes `allowOperator: true`, so it can revoke a grant
belonging to any connection. Refusals: `GRANT_ID_REQUIRED` (400),
`GRANT_UNKNOWN` (404). Revoking a grant takes effect immediately for session
grants (checked per execution) and permanently ends a task grant.

### 3.11 `POST /api/dsh-delegate/authorization/revoke-all`

Request: `{}` → `{ "ok": true, "grantsRevoked": 3 }`. Revokes every grant and every
connection. This is the "stop everything now" control, and `status.delegation`
must flip to `authorized: false` immediately after; the UI should re-read `status`.

### 3.12 `GET /api/dsh-delegate/tasks[?connectionId=conn-…]`

`{ "ok": true, "tasks": [ <task view> ] }`, newest first. Omitting the query
parameter lists across all connections. The task view is described once in §5.

### 3.13 `POST /api/dsh-delegate/tasks/get`

Request: `{ "taskId": "task-…" }` → `{ "ok": true, "task": <task view with prompt> }`.
Refusal: `JOB_TASK_NOT_FOUND` (404).

### 3.14 `POST /api/dsh-delegate/tasks/cancel`

Request: `{ "taskId": "task-…" }` → `{ "ok": true, "task": <task view> }`, with
`cancelledBy: "operator"`. A task already terminal is returned unchanged rather
than refused, so a double-click is harmless. Refusal: `JOB_TASK_NOT_FOUND` (404).

---

## 4. Execution plane (bearer token; not the UI's surface)

Prefix: `/dsh-delegate/x`. Plain node:http, **not** under `/api`, registered only
when the webserver binds `127.0.0.1`; otherwise it is not registered at all and
external submissions are refused.

Every request needs `Authorization: Bearer <connection token>`. The transport fence
(loopback socket, loopback Host, same-origin marker for browser-flagged requests)
runs first and is a filter, never proof: any local program can send those headers.
One refusal answers every authentication failure — `401` with
`CONNECTION_UNKNOWN` — because distinguishing "no token" from "bad token" from
"revoked" helps an attacker and not an operator.

| Path | Method | Body | Purpose |
|---|---|---|---|
| `/dsh-delegate/x/status` | GET | — | this connection, its live grants, delegation posture |
| `/dsh-delegate/x/tasks` | POST | `{grantId?, authorization?, workspacePath, prompt, overrides?}` | submit one task → `202` |
| `/dsh-delegate/x/tasks` | GET | — | list only this connection's tasks |
| `/dsh-delegate/x/tasks/get` | POST | `{taskId}` | one task; another connection's task reads as absent (`JOB_TASK_NOT_FOUND`) |
| `/dsh-delegate/x/tasks/cancel` | POST | `{taskId}` | cancel; cross-connection reads as absent |

`authorization` is `"task"` (default; consumes `grantId` exactly once) or
`"session"` (re-checks a live session grant covering the workspace). The
connection identity comes from the verified token, never from the body.

The UI never calls this plane. Its only overlap with the UI is that the token it
displays once becomes this plane's credential, and the `connectionId` is a
read-only join key in both planes.

---

## 5. Task view (shared shape, both planes)

```json
{
  "taskId": "task-<uuid>",
  "state": "pending | running | awaiting-host-review | failed | cancelled",
  "createdAt": 1730000000000, "startedAt": 1730000000100, "endedAt": 1730000000900,
  "workspacePath": "C:\\work\\project",
  "connectionId": "conn-<uuid>", "grantId": "grant-<uuid>",
  "effective": {
    "worker": { "providerId": "relay", "model": "deepseek-chat", "reasoningEffort": "medium",
      "timeoutSeconds": 1800, "maxParallelism": 1, "isolation": "shared", "providerRoute": "relay" },
    "review": { "enabled": false, "providerId": null, "model": null, "reasoningEffort": null, "providerRoute": null },
    "provenance": { "projectPath": null, "applied": [] }
  },
  "route": { "providerId": "relay", "model": "deepseek-chat", "reasoningEffort": "medium" },
  "baseline": {}, "diff": {},
  "execution": { "outcome": "completed", "text": "…", "reasoningOnly": false,
    "usage": { "inputTokens": 10, "outputTokens": 5, "totalTokens": 15 },
    "turnEnd": {}, "agentId": "…", "sessionId": "…", "cancelCause": null, "error": null },
  "review": { "state": "disabled | not_run | completed | failed",
    "verdict": "approve | changes-requested | unknown | null", "text": "", "error": null },
  "error": null, "cancelledBy": null,
  "hostAcceptance": null,
  "selfApproved": false,
  "prompt": "…"            // present only on tasks/get, never in tasks list
}
```

Rules the UI must honour when rendering this:

- `awaiting-host-review` means **executed**, not **approved**. `selfApproved` is
  always `false`, and `hostAcceptance` is `null` until the host records an
  acceptance of its own. The UI must not render "done" or "accepted" for either
  state.
- `effective` is the immutable snapshot taken when the task started; a later
  settings change does not apply to it. Show it as the task's actual configuration.
- `review` is separate from `state`. A review failure is not a task failure.
- `prompt` is only on `tasks/get`; the list view omits it. Prompt and error text
  are redacted before they leave the engine.

---

## 6. Settings surface mapping (four areas)

The Chinese UI's four areas map onto the contract as follows; no area needs a
route that does not exist.

1. **API 管理** — `GET`/`POST /api/dsh-delegate/settings` for the document,
   `POST /api/dsh-delegate/catalog` for model ids and effort capabilities.
   Credential references are names resolved by the DSH credential seam; masked
   input never round-trips through this API.
2. **执行设置** — `settings.worker` inside the same document, bounded by
   `catalog[].models[].efforts` for effort and by the validator for
   timeout/parallelism/isolation. `catalog.effective` previews the composed result.
3. **附加审查** — `settings.review`, independent of authorization and off by
   default.
4. **任务记录** — `GET /api/dsh-delegate/tasks`, `POST …/tasks/get`,
   `POST …/tasks/cancel`.

Authorization controls sit **above** those four areas and use only
`/connections*`, `/grants*`, `/authorization/revoke-all` and `/status`. A UI that
places grant issuance inside "执行设置" would misrepresent it: execution settings do
not authorize anything, and delegation stays off until a grant exists.

---

## 7. What this slice does not promise

- No admission test is claimed at this layer. Browser authentication and the
  Host/Origin fence belong to the native `connection` service and are exercised
  there; a unit test that hand-fed a cookie would assert a guarantee this module
  does not provide.
- CSRF for the user plane is the carrier's same-origin fence plus the
  browser-session cookie policy. This document does not add a second mechanism.
- `HEAD` is accepted by the registry but declared on no route here; a `HEAD`
  request therefore falls through to the carrier's `404`. If a future health check
  needs it, add it to the declared methods of `/status` — do not add a new route
  with the same path, which would throw at registration.
- The execution plane's `GET /tasks` and `POST /tasks` are two different routes on
  two different carriers (node:http prefix routing), unlike the `/api` exact-path
  registry; they are listed together only because they share a suffix.
