// Per-call permission bridge for delegated worker sessions.
//
// A delegated worker edits files inside its own workspace. DSH confines that with
// `workspace-write`, and until now the delegate policy also installed the
// `never` approval stance, because this plugin had no way to answer an approval
// prompt: any escalation was rejected deterministically and the worker could never
// ask for anything wider for a single call.
//
// This module is the ONE addition that changes that, and it is deliberately the
// narrowest thing that could: while the commander is actively following a task,
// a native DSH approval request pauses that exact tool call, is surfaced to the
// commander through the existing MCP result/status view, and is decided by the
// NEW bounded tool `delegate_permission_decide` as `allow-once` or `reject`.
//
// What it is NOT, stated here because the rest of the product depends on it:
//
//   * it cannot grant an account, a workspace or a standing policy — the native
//     approval seam already has exactly one grant outcome (`allowed-once`) and the
//     tool contract here exposes only that and `reject`;
//   * it cannot change settings, credentials, the switch, the provider/model, the
//     ISOLATION or the worker's standing sandbox mode (`workspace-write` stays in
//     place for the whole run; nothing here writes `danger-full-access` into a
//     Session);
//   * it cannot approve a FUTURE call. A request is bound to one native
//     `callId`, to one task, to one Session, to one tool name, and to an exact
//     fingerprint of the real tool arguments. It is consumed by the decision, and
//     the next escalation asks again;
//   * it is not a human-click workflow, an automatic allow-all rule, or an
//     LLM/API reviewer. The decision is the commander's, taken by an external
//     bounded call.
//
// ## The one native API this is built on (recorded evidence)
//
// Both supported DSH shapes expose the same two facts this module uses, verified
// against the installed sources rather than assumed:
//
//   * `@deepseek-ai/dsh-user-approval` (`lib/index.js`, `ApprovalService.decide`):
//     the asking tool's arguments are NOT carried on the approval request. The
//     request is `{ agent, toolName, callId?, reason?, displayReason?, signal? }`
//     and the outcome vocabulary is closed:
//     `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`. The decision is
//     dispatched as the agent-scoped waterfall `'approval/request'`, and a
//     session whose effective policy is `never` is answered `'rejected'` BEFORE
//     any listener runs — which is exactly why this module writes `ask` only when
//     it is armed, and why an unarmed run keeps `never`.
//   * `@deepseek-ai/dsh-sandbox` `approveEscalation`: a `sandbox_permissions`
//     escalation is resolved through `ctx.approval.request({ agent, toolName,
//     callId, reason, displayReason, signal })` before anything executes, and
//     only `allowed-once` returns the wider mode for that one call.
//
// Because the approval request carries no arguments, the REAL operation is read
// from the native Session log: the requesting tool has already committed its
// `tool/call` event (`{ turn, step, callId, name, arguments }`) before it asks, so
// this module looks the call up by `callId` and parses the model's own argument
// JSON. A model-written `reason` string is never treated as the operation — it is
// stored beside the fingerprint as a claim, labelled as one.
//
// ## Identity, and the honest limit
//
// A request is reachable only through the task that armed the bridge: the engine
// looks the request up BY THE DECIDING CALLER'S OWN TASK, so another task's (or
// another connection's) pending request is not addressable at all. Within a run,
// `owns()` requires the EXACT live Agent object the bridge was armed for, so a
// request with no Agent, a foreign Agent or a look-alike object is never claimed.
//
// What this module does NOT claim, in either direction:
//
//  * It is **not process authentication** against arbitrary code running as the
//    same OS user. The execution plane's switch mode deliberately uses one shared
//    `local-mcp` identity and issues no user-managed token, so any local process
//    may present itself as that commander. The switch is an operator control, not a
//    per-process security boundary, and this module does not pretend otherwise.
//  * The worker's inability to answer its own request is a **tool-surface
//    restriction**, not a security boundary: `delegate_permission_decide` is an MCP
//    tool and is not part of the native worker's preset tool surface, so the
//    worker's model is never handed it. That is a real restriction on what the
//    worker composition exposes — it is NOT a claim that a process running as the
//    same user could not call the execution plane directly. Nothing here relies on
//    a caller-supplied role label either.
//
// ## Lifetime
//
// Waiting never spends the run's execution budget: the run's deadline is really
// PAUSED around every wait (its timer is disarmed and the elapsed span charged,
// so a wait longer than the remaining budget cannot time the run out), and the
// request has its own bounded deadline ({@link PERMISSION_DEFAULT_TIMEOUT_MS}).
// Cancellation, switch-off, revocation, disposal and that deadline all settle the
// outstanding waiter (`cancelled`/`rejected`/`unavailable`) and restore the timer,
// so a paused call can never outlive the reason it was paused for. A restart begins
// with no bridge, no request and no decision: an interrupted request is history
// only and is never replayed into a new call.

import { createHash } from 'node:crypto';

/** Fixed default lifetime of one permission request, in milliseconds (10 minutes). */
export const PERMISSION_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Hard bound on a request lifetime a test or caller may configure. */
export const PERMISSION_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** The closed decision vocabulary this plugin's tool accepts. */
export const PERMISSION_DECISIONS = Object.freeze(['allow-once', 'reject']);

/**
 * The closed native outcome vocabulary, mirrored from the approval seam so a
 * non-vocabulary answer can never be interpreted as a grant.
 */
export const APPROVAL_OUTCOMES = Object.freeze(['allowed-once', 'rejected', 'cancelled', 'unavailable']);

/** Stable request states; a request is `pending` until it is settled exactly once. */
export const PERMISSION_STATES = Object.freeze({
  pending: 'pending',
  decided: 'decided',
  expired: 'expired',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
});

/** Machine codes for a bridge refusal the commander reads. */
export const PERMISSION_CODES = Object.freeze({
  unknownTask: 'JOB_TASK_NOT_FOUND',
  notFound: 'PERMISSION_REQUEST_NOT_FOUND',
  notPending: 'PERMISSION_REQUEST_NOT_PENDING',
  expired: 'PERMISSION_REQUEST_EXPIRED',
  changed: 'PERMISSION_REQUEST_CHANGED',
  duplicates: 'PERMISSION_DECISION_REFUSED',
  unbound: 'PERMISSION_REQUEST_UNBOUND',
  invalid: 'PERMISSION_DECISION_INVALID',
  // The request's own evidence cannot support an allow: it was shortened by a
  // bound, or its call can no longer be re-verified. `reject` remains available.
  incomplete: 'PERMISSION_EVIDENCE_INCOMPLETE',
});

/** Fixed `details.reason` strings for a native ask refused before it is surfaced. */
export const PERMISSION_REASONS = Object.freeze({
  notArmed: 'no armed permission bridge for this session',
  noSession: 'the asking agent exposes no session log',
  noCallId: 'the approval request carries no tool call identity',
  callNotFound: 'no tool/call event matches this call identity',
  nameMismatch: 'the recorded tool call names a different tool',
  argumentsUnusable: 'the recorded tool arguments could not be read',
  agentMismatch: 'the approval request names another agent',
  aborted: 'the asking tool withdrew the request',
  disposed: 'the permission bridge was disposed',
  stop: 'the run stopped while the request was pending',
  // -- refusals of a DECISION (not of the ask) --------------------------------
  //
  // Each names a reason an allow cannot be granted, and each is checked at the
  // moment of decision rather than only when the request was created.
  incompleteEvidence: 'the operation was shortened by a bound, so an allow cannot be granted on it',
  noCallSeq: 'the recorded tool call carries no session offset to re-verify',
  callChanged: 'the recorded tool call changed after the request was created',
  callMissing: 'the recorded tool call is no longer in the session log',
  turnClosed: 'the turn that asked for this call has already ended',
  sessionGone: 'the asking session is no longer the one this bridge is bound to',
  fingerprintRequired: 'an allow-once decision must quote the request fingerprint',
});

/**
 * Which evidence problems gate an `allow-once` but NOT a `reject`.
 *
 * `reject` is always safe: it denies the call. Only a grant needs complete,
 * still-current evidence, so the listing lives here in one place and both the
 * bridge and its docs refer to it.
 */
export const ALLOW_BLOCKING_REASONS = Object.freeze([
  PERMISSION_REASONS.incompleteEvidence,
  PERMISSION_REASONS.noCallSeq,
  PERMISSION_REASONS.callChanged,
  PERMISSION_REASONS.callMissing,
  PERMISSION_REASONS.turnClosed,
  PERMISSION_REASONS.sessionGone,
  PERMISSION_REASONS.fingerprintRequired,
]);

/**
 * The one refusal this bridge raises as an error instead of an outcome.
 *
 * It exists for the CALLER's path (a binding that cannot be established must fail
 * closed with diagnostics), never for the tool call itself: the approval seam
 * maps any thrown answerer to `'unavailable'`, so the worker sees "no approval
 * channel" rather than a half-understood request.
 */
export class PermissionError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - bounded operator-facing explanation.
   * @param {object} [details] - non-secret facts.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Bounds on what one request keeps, so a hostile argument blob cannot become a
 * memory or history problem. Every bound is applied to a REDACTED value.
 */
export const PERMISSION_BOUNDS = Object.freeze({
  /** Maximum characters retained for the redacted JSON arguments. */
  argumentsChars: 4000,
  /** Maximum characters retained for any single redacted argument scalar. */
  argumentValueChars: 400,
  /** Maximum depth retained when projecting arguments. */
  argumentDepth: 6,
  /** Maximum argument keys retained per object. */
  argumentKeys: 24,
  /** Maximum characters retained for the asker's own claimed reason. */
  reasonChars: 600,
  /** Maximum characters retained for a decision reason. */
  decisionReasonChars: 600,
});

/**
 * The redaction this module applies to every published string.
 *
 * Injected rather than imported so the module stays a leaf with one dependency;
 * the plugin passes `redactText` from `config/redact.js` (the same redaction the
 * MCP result path applies), and a test may pass its own.
 */
const IDENTITY_REDACTION = /\b(sk|pk|ak)-[A-Za-z0-9_-]{16,}\b/g;

/**
 * The default redaction: credential-shaped substrings.
 *
 * `config/redact.js`'s {@link redactText} is what the plugin injects, and this
 * fallback deliberately mirrors its three patterns (bearer tokens, key-like
 * secrets, and `NAME=value` assignments) so a bridge constructed without an
 * injected redaction is not WEAKER than the production one. The module still stays
 * a leaf: this is a local copy of the shape, not an import of the config layer.
 * @param {string} text - untrusted text.
 * @returns {string} text with credential-shaped substrings replaced.
 */
function defaultRedact(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer ••••••••')
    .replace(IDENTITY_REDACTION, '••••••••')
    .replace(
      /\b([A-Za-z0-9_]*(?:API_?KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/giu,
      (_match, name) => `${name}=••••••••`,
    );
}

/**
 * Keys that may never be assigned through `object[key] = value`.
 *
 * `out['__proto__'] = x` on an ordinary object does not create an own property: it
 * invokes the prototype setter, so the key silently disappears. Two different JSON
 * objects — one carrying `__proto__` and one not — then hash and project
 * identically, which is a real collision between two different operations. Every
 * assignment below therefore goes through {@link setOwn}, which defines an own
 * data property instead.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Assign an own enumerable data property, including for `__proto__`.
 * @param {object} target - object to write into (created with a null prototype).
 * @param {string} key - property name.
 * @param {unknown} value - property value.
 * @returns {void}
 */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * A projection result: the bounded/redacted value AND whether it is complete.
 *
 * Completeness is a first-class fact, not an inference. A truncated value can hide
 * the part of a command that matters (the tail of `bash.command`, the body of a
 * `write`), so a caller must be able to refuse an allow decision on evidence it
 * could not see in full.
 */
export const PERMISSION_COMPLETENESS = Object.freeze({
  complete: 'complete',
  truncated: 'truncated',
  unbounded: 'unbounded',
});

/**
 * Create a projection context that tracks whether any bound was applied.
 * @param {boolean} redactKeys - whether key names are redacted too.
 * @returns {{ cuts: string[], valueChars: number, keys: number } } mutable counters.
 */
function newProjectionState() {
  return { cuts: [], valueCuts: 0, keyCuts: 0, depthCuts: 0, itemCuts: 0 };
}

/**
 * Mark one bound as applied, so its kind can be reported.
 * @param {object} state - projection counters.
 * @param {string} cut - cut kind.
 * @param {number} [amount] - how much was dropped.
 * @returns {void}
 */
function noteCut(state, cut, amount = 1) {
  if (cut === 'value') state.valueCuts += amount;
  else if (cut === 'key') state.keyCuts += amount;
  else if (cut === 'depth') state.depthCuts += amount;
  else if (cut === 'item') state.itemCuts += amount;
  if (state.cuts.length < 8 && !state.cuts.includes(cut)) state.cuts.push(cut);
}

/**
 * Whether a value is a credential-bearing KEY name.
 *
 * This is the key-aware half of redaction, and it is why the projection cannot rely
 * on scalar patterns alone: `{"apiKey":"…"}` carries a secret in its VALUE with no
 * credential-shaped text in it at all. The rule is deliberately the same predicate
 * the redaction module uses for stored documents
 * ({@link import('../config/redact.js').isSecretKey}), injected here through
 * `isSecretKey` so there is exactly one definition of "this key names a secret".
 * @param {string} key - object key.
 * @param {(key: string) => boolean} isSecretKey - the injected predicate.
 * @returns {boolean} true when the value behind this key must be masked.
 */
function secretKeyName(key, isSecretKey) {
  if (typeof isSecretKey === 'function' && isSecretKey(key) === true) return true;
  // A defence-in-depth fallback for the harness-free default: the same shape the
  // configuration module matches, so a module imported without it is not weaker.
  return typeof key === 'string' && /(api[_-]?key|apikey|secret|token|password|passwd|credential[_-]?value|authorization)/iu.test(key);
}

/**
 * Project one JSON value into a bounded, redacted, JSON-safe copy.
 *
 * Three rules, and every one of them is load-bearing:
 *
 *  1. **Key-aware redaction.** A key whose NAME says it holds a credential has its
 *     whole value masked, whatever the value looks like; every remaining string is
 *     also passed through the injected {@link redactText}. Scalar patterns alone
 *     would publish `{"apiKey":"some-secret"}` verbatim.
 *  2. **Proto-safe keys.** Assignments go through {@link setOwn}, so a JSON key
 *     named `__proto__` becomes a real own property instead of vanishing through the
 *     prototype setter (R9's collision).
 *  3. **Explicit completeness.** Every bound that fires is COUNTED, so the caller
 *     can tell a fully-projected operation from a shortened one and refuse an allow
 *     decision on evidence it could not review in full.
 * @param {unknown} value - parsed argument value.
 * @param {object} options - `redact`, `isSecretKey`, `state`, `depth`.
 * @returns {unknown} bounded projection.
 */
function projectValue(value, options) {
  const redact = typeof options.redact === 'function' ? options.redact : defaultRedact;
  const isSecretKey = options.isSecretKey;
  const state = options.state ?? newProjectionState();
  const depth = options.depth ?? 0;
  const cap = PERMISSION_BOUNDS.argumentValueChars;
  if (value === null || typeof value === 'undefined') return null;
  if (typeof value === 'string') {
    const text = redact(value);
    if (text.length > cap) {
      noteCut(state, 'value', text.length - cap);
      return `${text.slice(0, cap)}…[+${text.length - cap} chars]`;
    }
    return text;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (depth >= PERMISSION_BOUNDS.argumentDepth) {
    noteCut(state, 'depth');
    return '[depth limit]';
  }
  if (Array.isArray(value)) {
    const keep = value.slice(0, PERMISSION_BOUNDS.argumentKeys);
    if (value.length > keep.length) noteCut(state, 'item', value.length - keep.length);
    const projected = keep.map((entry) => projectValue(entry, { redact, isSecretKey, state, depth: depth + 1 }));
    if (value.length > keep.length) projected.push(`[+${value.length - keep.length} more items]`);
    return projected;
  }
  if (typeof value === 'object') {
    // A null prototype keeps the projection itself free of inherited keys; every
    // assignment still goes through `setOwn` so `__proto__` survives as data.
    const out = Object.create(null);
    const entries = Object.entries(value);
    if (entries.length > PERMISSION_BOUNDS.argumentKeys) {
      noteCut(state, 'key', entries.length - PERMISSION_BOUNDS.argumentKeys);
    }
    for (const [key, entry] of entries.slice(0, PERMISSION_BOUNDS.argumentKeys)) {
      const safeKey = redact(key);
      if (secretKeyName(key, isSecretKey)) {
        // The whole value is masked because its KEY says it is a credential. The key
        // name stays, so an operator can still see WHICH argument was hidden.
        setOwn(out, safeKey, '••••••••');
        // A masked credential is not a truncation: the operation is fully described
        // by "this credential is set".
        continue;
      }
      setOwn(out, safeKey, projectValue(entry, { redact, isSecretKey, state, depth: depth + 1 }));
    }
    if (entries.length > PERMISSION_BOUNDS.argumentKeys) {
      setOwn(out, '…', `[+${entries.length - PERMISSION_BOUNDS.argumentKeys} more keys]`);
    }
    return out;
  }
  return '[not representable]';
}

/**
 * Serialize a projected value to bounded JSON text.
 *
 * The whole-value cap is applied only when the projection still does not fit, and
 * it always REPORTS that it fired (through {@link boundedJsonText.exceeded}) so a
 * caller can refuse an allow decision rather than approve a tail it never saw.
 * @param {unknown} projected - bounded projection.
 * @returns {{ text: string, exceeded: boolean }} JSON text and whether the cap fired.
 */
function boundedJsonText(projected) {
  let text;
  try {
    text = JSON.stringify(projected);
  } catch {
    return { text: '[unserializable]', exceeded: true };
  }
  if (typeof text !== 'string') return { text: '[unserializable]', exceeded: true };
  const cap = PERMISSION_BOUNDS.argumentsChars;
  if (text.length > cap) {
    return { text: `${text.slice(0, cap)}…[+${text.length - cap} chars omitted]`, exceeded: true };
  }
  return { text, exceeded: false };
}

/**
 * A stable, proto-safe canonical JSON text of an exact value.
 *
 * `JSON.stringify` is not usable on its own here: it uses ordinary assignment
 * internally for the value it returns, but the real problem is the REPLACER an
 * earlier version used — `out[key] = value` silently drops a key named
 * `__proto__`, so `{"__proto__":{"a":1}}` and `{}` produced the same digest and two
 * different operations could be decided by one fingerprint.
 *
 * This serializer builds the text directly: keys are sorted for stability (so key
 * order is not part of the operation), every key is escaped as a JSON string rather
 * than assigned as a property, and nesting is explicit. Two objects are therefore
 * equal here only when they have the same keys and the same values.
 * @param {unknown} value - JSON-compatible value.
 * @returns {string} canonical JSON text.
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (typeof value === 'object') {
    // `Object.keys` reports own enumerable keys only, including one named
    // `__proto__` created by `JSON.parse` (which defines it as data, not accessor).
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/**
 * A stable fingerprint of an exact value.
 *
 * The digest is over {@link canonicalJson}, so it depends on the operation and not
 * on key order, and it is a digest rather than the value so the private binding
 * never has to keep (or publish) a second copy of the arguments.
 * @param {unknown} value - JSON-compatible value.
 * @returns {string} `sha256:<hex>` digest.
 */
export function fingerprintOf(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

/**
 * Read the real tool call one approval request is about, from the Session log.
 *
 * The native loop commits `tool/call` before the tool executes, so the arguments
 * are already in the log when the tool asks. The match is:
 *
 *  * the event type is `tool/call`;
 *  * its `callId` equals the request's `callId` EXACTLY (a missing `callId` is a
 *    refusal, not a search);
 *  * its `name` equals the request's `toolName` (a mismatch is a refusal: the
 *    request and the log disagree about what is being decided);
 *  * the newest such event wins if an id were ever repeated (the live one).
 *
 * A Session that exposes no readable log, a log whose reads throw, and a missing
 * match are all refusals with their own bounded reason.
 * @param {object} session - the asking agent's Session.
 * @param {object} request - native approval request (`callId`, `toolName`).
 * @returns {{ ok: true, call: { callId: string, name: string, argumentsText: string, turn: number|null, step: number|null, seq: number|null } }
 *   | { ok: false, reason: string }} the located call, or a bounded refusal.
 */
export function locateToolCall(session, request) {
  const callId = request?.callId;
  if (typeof callId !== 'string' || callId === '') return { ok: false, reason: PERMISSION_REASONS.noCallId };
  if (session === null || typeof session !== 'object') return { ok: false, reason: PERMISSION_REASONS.noSession };
  const seq = typeof session.seq === 'number' && Number.isInteger(session.seq) ? session.seq : null;
  if (seq === null || typeof session.eventAt !== 'function') return { ok: false, reason: PERMISSION_REASONS.noSession };
  const toolName = typeof request?.toolName === 'string' ? request.toolName : null;
  let found = null;
  for (let index = seq - 1; index >= 0; index -= 1) {
    let event;
    try {
      event = session.eventAt(index);
    } catch {
      return { ok: false, reason: PERMISSION_REASONS.callNotFound };
    }
    if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue;
    const data = event.data ?? {};
    if (data.callId !== callId) continue;
    found = { event, data, index };
    break;
  }
  if (found === null) return { ok: false, reason: PERMISSION_REASONS.callNotFound };
  const name = typeof found.data.name === 'string' ? found.data.name : null;
  if (toolName !== null && name !== toolName) return { ok: false, reason: PERMISSION_REASONS.nameMismatch };
  const argumentsText = typeof found.data.arguments === 'string' ? found.data.arguments : null;
  if (argumentsText === null) return { ok: false, reason: PERMISSION_REASONS.argumentsUnusable };
  return {
    ok: true,
    call: {
      callId,
      name: name ?? toolName ?? null,
      argumentsText,
      turn: Number.isInteger(found.data.turn) ? found.data.turn : null,
      step: Number.isInteger(found.data.step) ? found.data.step : null,
      seq: found.index,
    },
  };
}

/**
 * Whether the Session log is inside an open turn at one offset.
 *
 * This mirrors the native check `ApprovalService.request()` performs before it will
 * answer at all (`hasOpenTurn` in the legacy service, the `turnOpen` projection in
 * the modern one): the last `turn/start`/`turn/end` before the offset decides. It is
 * re-used here because a decision re-verifies the operation at decision time, and a
 * call whose turn has closed is not a call an allow can still apply to.
 * @param {object} session - Session with `eventAt`.
 * @param {number} seq - the tool call's offset.
 * @returns {boolean | null} true/false, or null when the log cannot be read.
 */
export function turnOpenAt(session, seq) {
  return openTurnAt(session, seq) !== null;
}

/**
 * The turn NUMBER that is open at the CURRENT tail of the log, or `null`.
 *
 * `turnOpenAt` answers "is anything open now"; this answers "WHICH turn is open
 * now". The difference matters: a request asked inside turn 2, then closed and a
 * turn 3 opened, is still "a turn is open" — but it is not the turn that asked. The
 * live-binding check compares this number against the one recorded when the request
 * was created, which is what refuses a close-then-reopen.
 *
 * The scan starts at the END of the log (the live tail) and uses each `turn/start`
 * event's own `turn` field when present, falling back to a running counter so a log
 * that omits the field is still distinguishable across turns.
 * @param {object} session - Session with `eventAt`.
 * @param {number} [fromSeq] - lowest offset to scan back to (the call's offset).
 * @returns {number | null} the open turn number, or null when none is open or the log is unreadable.
 */
export function openTurnAt(session, fromSeq) {
  if (session === null || typeof session !== 'object' || typeof session.eventAt !== 'function') return null;
  const total = typeof session.seq === 'number' && Number.isInteger(session.seq) ? session.seq : null;
  if (total === null) return null;
  const floor = typeof fromSeq === 'number' && Number.isInteger(fromSeq) && fromSeq >= 0 ? fromSeq : 0;
  try {
    for (let index = total - 1; index >= floor; index -= 1) {
      const event = session.eventAt(index);
      if (event === null || event === undefined || typeof event !== 'object') continue;
      if (event.type === 'turn/end') return null;
      if (event.type !== 'turn/start') continue;
      const declared = event.data?.turn;
      if (typeof declared === 'number' && Number.isInteger(declared)) return declared;
      // No field: identify the turn by its POSITION, which is still a stable and
      // comparable identity for the same log. Negative so it can never be mistaken
      // for a real turn number.
      return -1 - index;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The permission bridge for ONE delegated run.
 *
 * One broker per worker run. It is written in the run's own scope, armed before
 * the prompt is delivered and disposed when the run ends, and it answers only
 * requests that name the Agent it was armed for. A request whose identity cannot
 * be established is answered from the fail-closed vocabulary — never allowed.
 */
export class PermissionBridge {
  /**
   * @param {object} options - `taskId`, `connectionId`, `sessionId`, optional
   *   `timeoutMs` (bounded), optional `now`, optional `redact`, optional
   *   `isSecretKey` (the key-aware redaction predicate), optional `onPending`,
   *   optional `onSettled`, optional `logger`.
   */
  constructor(options) {
    if (typeof options?.taskId !== 'string' || options.taskId === '') {
      throw new TypeError('PermissionBridge needs the taskId it belongs to');
    }
    this.taskId = options.taskId;
    this.connectionId = typeof options.connectionId === 'string' ? options.connectionId : null;
    this.sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
    this.redact = typeof options.redact === 'function' ? options.redact : defaultRedact;
    // The key-aware half of redaction. Injected so this module and the stored-document
    // redaction agree on ONE definition of "this key names a secret"; the fallback
    // above keeps a harness-free import from being weaker than the plugin.
    this.isSecretKey = typeof options.isSecretKey === 'function' ? options.isSecretKey : null;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    const configured = Number(options.timeoutMs);
    this.timeoutMs = Number.isFinite(configured) && configured > 0
      ? Math.min(configured, PERMISSION_MAX_TIMEOUT_MS)
      : PERMISSION_DEFAULT_TIMEOUT_MS;
    this.onPending = typeof options.onPending === 'function' ? options.onPending : null;
    this.onSettled = typeof options.onSettled === 'function' ? options.onSettled : null;
    this.logger = options.logger ?? null;
    // The lifecycle latch. `armed` is what the policy writer reads: only an armed
    // bridge may have `ask` installed for its Session, and `dispose()` clears it
    // before the policy is restored.
    this.armed = false;
    this.disposed = false;
    this.agent = null;
    this.session = null;
    // At most one outstanding request: a single tool call cannot be asked twice,
    // and "one pending request per task" is what makes the commander's decision
    // unambiguous without a second ordering rule.
    this.pending = null;
    // Every settled request, newest last, bounded. This is the evidence trail the
    // task view and the durable history carry; it never holds an argument value
    // that was not redacted at construction time.
    this.history = [];
    this.sequence = 0;
    // The Session identity the bridge was ARMED for, kept separately from
    // `this.session` so a replaced `agent.session` is detectable rather than silently
    // followed (see {@link liveBindingRefusal}).
    this.boundSessionId = null;
  }

  /** Maximum settled requests retained on one run. */
  static get HISTORY_BOUND() {
    return 8;
  }

  /**
   * Bind the bridge to the Agent/Session it will answer for.
   *
   * Called from the run's setup step, AFTER the preset is mounted (so the tool
   * surface is the real one) and BEFORE the prompt (so no turn can ask under an
   * unarmed bridge). Re-arming the same run is idempotent; binding a DIFFERENT
   * Agent is a refusal, because a bridge belongs to one conversation.
   * @param {object} agent - the live native Agent the run will drive.
   * @returns {{ taskId: string, sessionId: string }} what was armed.
   * @throws {PermissionError} when the agent is unusable or is not the bound one.
   */
  arm(agent) {
    if (this.disposed) {
      throw new PermissionError(PERMISSION_CODES.unbound, 'the permission bridge was already disposed', {
        reason: PERMISSION_REASONS.disposed,
      });
    }
    const session = agent?.session ?? null;
    const sessionId = typeof session?.id === 'string' ? session.id : (typeof agent?.id === 'string' ? agent.id : null);
    if (session === null || sessionId === null) {
      throw new PermissionError(PERMISSION_CODES.unbound, 'the delegated agent exposes no session to bind approvals to', {
        reason: PERMISSION_REASONS.noSession,
      });
    }
    if (this.agent !== null && this.agent !== agent) {
      throw new PermissionError(PERMISSION_CODES.unbound, 'the permission bridge is already bound to another agent', {
        reason: PERMISSION_REASONS.agentMismatch,
      });
    }
    this.agent = agent;
    this.session = session;
    this.sessionId = this.sessionId ?? sessionId;
    // Pinned at arm time: the exact Session id this bridge answers for.
    this.boundSessionId = sessionId;
    this.armed = true;
    return { taskId: this.taskId, sessionId: this.sessionId };
  }

  /**
   * Whether this bridge answers for one native approval request.
   *
   * The rule is EXACT identity, and it is deliberately strict in both directions:
   *
   *  * the bridge must be armed, bound, and not disposed;
   *  * `request.agent` MUST be present — a request with no agent (`null`,
   *    `undefined`) is not "probably mine", it is unidentifiable, and answering it
   *    would let any caller that forgets to pass an agent be decided by this bridge;
   *  * that agent must be the SAME OBJECT the bridge was armed for. The native
   *    approval seam passes the live Agent the requesting tool is running for, so
   *    object identity is exactly the question "is this my Agent", and it cannot be
   *    forged from data;
   *  * when the agent exposes a Session id, it must equal the bound one.
   *
   * A request for a different agent in the same process is not this bridge's
   * business: the listener falls through to the next answerer so the ordinary
   * session keeps whatever prompt it actually has.
   * @param {object} request - native approval request.
   * @returns {boolean} true when this bridge owns the request.
   */
  owns(request) {
    if (this.armed !== true || this.disposed === true) return false;
    if (this.agent === null || this.session === null) return false;
    const agent = request?.agent;
    // No agent at all: unidentifiable, so NOT owned. `?? null` here would have made
    // a missing agent match every bridge, which is the defect this check removes.
    if (agent === null || agent === undefined || typeof agent !== 'object') return false;
    if (agent !== this.agent) return false;
    const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : null;
    if (sessionId !== null && this.sessionId !== null && sessionId !== this.sessionId) return false;
    return true;
  }

  /**
   * Re-read the bound operation from the live Session and prove it is unchanged.
   *
   * A decision is not taken against the copy captured when the request was created:
   * the native log is read AGAIN at the moment of decision, and the operation must
   * still be there, still be the same record at the same offset, still carry the
   * same tool name, and still carry byte-identical arguments. It must also still be
   * inside an OPEN turn — a call whose turn has already ended is history, and an
   * allow for it would apply to nothing (or, worse, to whatever reuses the id).
   *
   * This is what makes "the session/tool call/argument snapshot is re-verified at
   * decision" a checked fact rather than an assumption.
   * @param {object} pending - pending record, whose `callId`/`callSeq` pin the call.
   * @returns {string | null} a fixed refusal reason, or null when still exact.
   */
  reverifyOperation(pending) {
    const live = this.liveBindingRefusal();
    if (live !== null) return live;
    const seq = pending?.callSeq;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      return PERMISSION_REASONS.noCallSeq;
    }
    let event;
    try {
      event = this.session.eventAt(seq);
    } catch {
      return PERMISSION_REASONS.callMissing;
    }
    if (event === null || event === undefined || typeof event !== 'object' || event.type !== 'tool/call') {
      return PERMISSION_REASONS.callMissing;
    }
    const data = event.data ?? {};
    if (data.callId !== pending.callId) return PERMISSION_REASONS.callChanged;
    // EXACT name equality. The old `typeof data.name === 'string' && …` guard made a
    // REMOVED name pass, so a record whose tool name had been stripped still allowed.
    if (data.name !== pending.toolName) return PERMISSION_REASONS.callChanged;
    // Turn/step identity, compared exactly when the request pinned one.
    if (pending.turn !== null && data.turn !== pending.turn) return PERMISSION_REASONS.callChanged;
    if (pending.step !== null && data.step !== pending.step) return PERMISSION_REASONS.callChanged;
    if (typeof data.arguments !== 'string' || data.arguments !== pending.exactArguments) {
      // A changed argument string at the SAME offset means the record was mutated
      // or the Session was replaced underneath this bridge. Either way the evidence
      // the commander saw is not the operation any more.
      return PERMISSION_REASONS.callChanged;
    }
    // The SAME originating turn must still be the open one at the CURRENT TAIL.
    // Checking only "is some turn open now" would accept a close-then-reopen: the
    // question was asked in turn N, and a decision taken in turn N+1 is not about the
    // same live step. A closed tail (`null`) never equals a recorded turn number.
    if (openTurnAt(this.session) !== pending.turnAtAsk) return PERMISSION_REASONS.turnClosed;
    return null;
  }

  /**
   * Prove the bridge is still bound to the LIVE Agent and Session it was armed for.
   *
   * The previous check only looked at `this.session`. That misses the case the audit
   * reproduced: while a request is pending, the Agent's `session` is REPLACED, so the
   * bridge keeps reading the old (frozen, still-open-looking) log while the agent
   * actually drives a different conversation. Both the object identity AND the id are
   * compared, because a replaced session with a recycled id is still a different
   * conversation.
   * @returns {string | null} a fixed refusal reason, or null when still bound.
   */
  liveBindingRefusal() {
    const agent = this.agent;
    if (agent === null || agent === undefined) return PERMISSION_REASONS.sessionGone;
    const liveSession = agent.session;
    if (liveSession === null || liveSession === undefined) return PERMISSION_REASONS.sessionGone;
    if (liveSession !== this.session) return PERMISSION_REASONS.sessionGone;
    if (this.boundSessionId !== null && liveSession.id !== this.boundSessionId) {
      return PERMISSION_REASONS.sessionGone;
    }
    if (this.session === null || typeof this.session.eventAt !== 'function') {
      return PERMISSION_REASONS.sessionGone;
    }
    return null;
  }

  /**
   * Answer one native approval request.
   *
   * The closed outcomes and their causes:
   *
   *  * `unavailable` — the bridge is not armed/disposed, the request is not this
   *    bridge's, or a request is already outstanding. Fail closed, because
   *    "somebody else's question" and "two questions at once" are both states this
   *    plugin cannot decide honestly.
   *  * `cancelled` — the asking tool withdrew the request (its own signal), or
   *    the run stopped while it was pending.
   *  * `rejected` — the deadline expired, the request had no call identity, or no
   *    `tool/call` matching it could be read. The operation is refused; the
   *    diagnostics say which check failed.
   *  * `allowed-once` — ONLY a commander decision that matched this exact
   *    fingerprint.
   *
   * @param {object} request - `{ agent, toolName, callId?, reason?, signal? }`.
   * @returns {Promise<string>} one of {@link APPROVAL_OUTCOMES}.
   */
  async answer(request) {
    if (this.armed !== true || this.disposed === true) return 'unavailable';
    if (!this.owns(request)) return 'unavailable';
    if (this.pending !== null) {
      this.logger?.warn?.('dsh-delegate: a second approval request arrived while one was pending; refusing it');
      return 'unavailable';
    }
    const signal = request?.signal;
    if (signal?.aborted === true) return 'cancelled';
    const located = locateToolCall(this.session, request);
    if (located.ok !== true) {
      // An unidentifiable request is a refusal, not a silent wait: nobody could
      // bind a decision to it, so it must not occupy the pending slot.
      this.recordRejectedBinding(request, located.reason);
      return 'rejected';
    }
    const pending = this.createPending(request, located.call);
    if (pending === null) {
      this.recordRejectedBinding(request, PERMISSION_REASONS.argumentsUnusable);
      return 'rejected';
    }
    return await this.waitForDecision(pending, signal);
  }

  /**
   * Build the pending record for one identified request.
   *
   * The record keeps BOTH halves of the operation:
   *
   *  * the exact fingerprint and the exact argument text, which are private and are
   *    what a decision is bound to and re-verified against;
   *  * the redacted projection and its COMPLETENESS, which is what the commander is
   *    shown.
   *
   * The completeness flags are computed here, once, from the real arguments:
   * `argumentsComplete` is false when any bound fired, and `allowBlocked` names the
   * reason an `allow-once` would be refused for it (see {@link allowRefusalReason}).
   * @param {object} request - native approval request.
   * @param {object} call - located `tool/call` facts.
   * @returns {object | null} pending record, or null when it cannot be described.
   */
  createPending(request, call) {
    let parsed;
    try {
      parsed = JSON.parse(call.argumentsText);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // A tool call whose arguments are not an object cannot be fingerprinted
      // per-key, and every enforcing tool in this composition takes one.
      return null;
    }
    this.sequence += 1;
    const createdAt = this.now();
    const state = newProjectionState();
    const projected = projectValue(parsed, {
      redact: this.redact,
      isSecretKey: this.isSecretKey,
      state,
    });
    const rendered = boundedJsonText(projected);
    if (rendered.exceeded) noteCut(state, 'value');
    const pending = {
      requestId: `permission-${this.taskId}-${this.sequence}`,
      taskId: this.taskId,
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      toolName: call.name,
      callId: call.callId,
      turn: call.turn,
      step: call.step,
      // The Session log offset the operation was read from. A decision re-reads
      // that same offset and refuses if the call is no longer the same record.
      callSeq: call.seq,
      // WHICH turn was open when the question was asked. A decision needs this exact
      // turn to still be the open one; "some turn is open" is not enough, because a
      // close-then-reopen opens a DIFFERENT turn the request never asked in.
      //
      // Read at the TAIL (no lower bound): the seam asks while its call is the newest
      // event, so the tail's open turn IS the asking turn. Passing the call's offset
      // here would start the scan at the `turn/start` behind it and report a turn that
      // a later `turn/end` had already closed.
      turnAtAsk: openTurnAt(this.session),
      // The exact Session object and id the operation was read from.
      boundSessionId: this.boundSessionId,
      // A non-reusable identity: the fingerprint is over the EXACT arguments as
      // the model produced them, so a later call with different arguments can
      // never be decided by this request's evidence.
      fingerprint: fingerprintOf(parsed),
      // The exact argument text, retained PRIVATELY (never published) so a decision
      // can re-compare the operation byte for byte instead of trusting a digest of
      // a record it did not re-read.
      exactArguments: call.argumentsText,
      // Redacted, bounded rendering of the same operation, safe to publish.
      arguments: rendered.text,
      argumentKeys: Object.keys(parsed).slice(0, PERMISSION_BOUNDS.argumentKeys).map((key) => this.redact(key)),
      // Completeness, stated rather than inferred from a trailing marker.
      argumentsComplete: state.cuts.length === 0,
      completeness: state.cuts.length === 0 ? PERMISSION_COMPLETENESS.complete : PERMISSION_COMPLETENESS.truncated,
      omitted: {
        valueChars: state.valueCuts,
        keys: state.keyCuts,
        depth: state.depthCuts,
        items: state.itemCuts,
      },
      // Which bounds fired, in a fixed vocabulary, so the refusal can be explained.
      boundsApplied: [...state.cuts],
      // The asker's own claim about why it asks, labelled as a claim. It is never
      // the operation and never a grant.
      claimedReason: this.boundText(request?.reason, PERMISSION_BOUNDS.reasonChars),
      requestedAccess: this.requestedAccessOf(parsed),
      createdAt,
      deadlineAt: createdAt + this.timeoutMs,
      state: PERMISSION_STATES.pending,
      decision: null,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      settledOutcome: null,
      resolve: null,
      timer: null,
      onExternalAbort: null,
      externalSignal: null,
    };
    pending.allowBlocked = this.allowRefusalReason(pending);
    return pending;
  }

  /**
   * Why an `allow-once` must be refused for this request, or `null`.
   *
   * The rule is the one the commander's decision depends on: **never allow an
   * operation whose executable material was omitted by a bound.** A truncated
   * `bash.command` can hide the tail that actually runs; a truncated `write.body`
   * can hide what is written. `reject` stays available in every one of these cases,
   * because refusing is always safe — it is the ALLOW that needs complete evidence.
   * @param {object} pending - pending record.
   * @returns {string | null} fixed reason, or null when an allow is decidable.
   */
  allowRefusalReason(pending) {
    if (pending?.argumentsComplete !== true) {
      return PERMISSION_REASONS.incompleteEvidence;
    }
    if (pending?.callSeq === null || pending?.callSeq === undefined) {
      return PERMISSION_REASONS.noCallSeq;
    }
    return null;
  }


  /**
   * Describe the access the call asks for, from the REAL arguments.
   *
   * Stated from the operation, never from the asker's prose: a sandbox escalation
   * is `{ mode, requested: true }`, any other asking call is `{ mode: null }`.
   * @param {object} args - parsed arguments.
   * @returns {{ kind: string, mode: string | null }} bounded access fact.
   */
  requestedAccessOf(args) {
    const mode = args?.sandbox_permissions;
    if (typeof mode === 'string' && mode !== '') {
      return { kind: 'sandbox-escalation', mode };
    }
    return { kind: 'tool-call', mode: null };
  }

  /**
   * Wait, boundedly, for the commander's decision.
   *
   * Two lifetimes race here and both settle the waiter exactly once: the
   * commander's decision (bound to this request id and fingerprint) and the
   * request's own deadline. A third, the asking tool's abort signal, pierces the
   * wait so a cancelled tool call cannot leave a request looking pending.
   * @param {object} pending - pending record.
   * @param {AbortSignal | undefined} signal - the asking tool's signal.
   * @returns {Promise<string>} the closed native outcome.
   */
  async waitForDecision(pending, signal) {
    this.pending = pending;
    const decision = new Promise((resolvePromise) => {
      pending.resolve = resolvePromise;
    });
    // The deadline is this request's OWN bound: it is independent of the run's
    // execution budget, which the engine pauses while this is outstanding.
    pending.timer = setTimeout(() => {
      pending.timer = null;
      this.settle(pending, PERMISSION_STATES.expired, 'rejected', {
        reason: 'the permission request reached its deadline without a decision',
        decidedBy: 'deadline',
      });
    }, this.timeoutMs);
    pending.timer.unref?.();
    if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
      pending.externalSignal = signal;
      pending.onExternalAbort = () => {
        this.settle(pending, PERMISSION_STATES.cancelled, 'cancelled', {
          reason: PERMISSION_REASONS.aborted,
          decidedBy: 'asker',
        });
      };
      signal.addEventListener('abort', pending.onExternalAbort, { once: true });
    }
    this.emitPending(pending);
    try {
      return await decision;
    } finally {
      this.clearPending(pending);
    }
  }

  /**
   * Publish one pending request to its observers (the engine records the phase).
   *
   * An observer throw is contained: a task view that cannot be updated must not
   * turn a live approval wait into a failed tool call.
   * @param {object} pending - pending record.
   * @returns {void}
   */
  emitPending(pending) {
    if (this.onPending === null) return;
    try {
      this.onPending(this.publicView(pending));
    } catch (error) {
      this.logger?.warn?.('dsh-delegate: permission observer failed', String(error?.code ?? ''));
    }
  }

  /**
   * Decide one pending request. Called by the engine on behalf of ONE task.
   *
   * The order is the whole contract, and each step can refuse. It is deliberately
   * ordered so the CHEAP identity checks come first and the LIVE re-verification
   * comes before any grant:
   *
   *  1. the decision value must be one of `allow-once`/`reject` (validated before
   *     anything is looked up or mutated);
   *  2. the request must be THIS bridge's own pending request (`requestId`);
   *  3. it must still be pending — a second decision, an expired request and a
   *     cancelled one are all refused rather than re-applied;
   *  4. it must not be past its deadline (by the clock, not only by the timer);
   *  5. the fingerprint is **mandatory for `allow-once`** and is compared exactly
   *     when supplied for `reject`. An allow must name the operation it grants;
   *  6. **for an allow only**, the operation is re-read from the LIVE Session and
   *     must be unchanged at the same offset, in the same tool, with byte-identical
   *     arguments, inside a still-open turn; and the projection must have been
   *     COMPLETE (no bound fired). Any failure refuses the allow.
   *
   * `reject` deliberately skips 6: refusing is always safe, so a commander can deny
   * a request whose evidence was shortened or whose call has since changed. An
   * `allow-once` may not.
   * @param {object} request - `{ requestId, decision, reason, fingerprint }`.
   * @returns {object} bounded result: the settled request view.
   * @throws {PermissionError} on any refusal.
   */
  decide(request) {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (requestId === '') {
      throw new PermissionError(PERMISSION_CODES.invalid, 'requestId is required', { field: 'requestId' });
    }
    const decision = request?.decision;
    if (!PERMISSION_DECISIONS.includes(decision)) {
      throw new PermissionError(PERMISSION_CODES.invalid, 'decision must be allow-once or reject', {
        field: 'decision',
        accepted: [...PERMISSION_DECISIONS],
      });
    }
    const allow = decision === 'allow-once';
    const pending = this.pending;
    if (pending === null || pending.requestId !== requestId) {
      // An unknown id, another run's id and an already-settled id are ONE answer:
      // the caller learns nothing about requests it did not own.
      const settled = this.history.find((entry) => entry.requestId === requestId) ?? null;
      if (settled !== null) {
        throw new PermissionError(PERMISSION_CODES.notPending, 'this permission request is already settled', {
          requestId,
          state: settled.state,
          outcome: settled.settledOutcome,
        });
      }
      throw new PermissionError(PERMISSION_CODES.notFound, 'no pending permission request matches this identity', {
        requestId,
      });
    }
    if (pending.state !== PERMISSION_STATES.pending) {
      throw new PermissionError(PERMISSION_CODES.notPending, 'this permission request is already settled', {
        requestId,
        state: pending.state,
      });
    }
    if (this.now() >= pending.deadlineAt) {
      // Expiry is decided by the clock, not only by the timer: a decision that
      // races the deadline must not resurrect a request nobody may answer.
      this.settle(pending, PERMISSION_STATES.expired, 'rejected', {
        reason: 'the permission request reached its deadline',
        decidedBy: 'deadline',
      });
      throw new PermissionError(PERMISSION_CODES.expired, 'the permission request expired before this decision', {
        requestId,
      });
    }

    const supplied = request?.fingerprint;
    if (allow && (typeof supplied !== 'string' || supplied === '')) {
      // An allow without a fingerprint would grant "whatever is pending", which is
      // exactly the substitution this design refuses. The request stays pending so
      // a correct decision can still be made.
      throw new PermissionError(
        PERMISSION_CODES.invalid,
        'an allow-once decision must quote the request fingerprint',
        { requestId, field: 'fingerprint', reason: PERMISSION_REASONS.fingerprintRequired },
      );
    }
    if (typeof supplied === 'string' && supplied !== pending.fingerprint) {
      // The operation the caller believes it is deciding is not the operation that
      // is pending. Refused, and the request is left pending for the two parties
      // that actually know what it is.
      throw new PermissionError(PERMISSION_CODES.changed, 'the pending operation does not match the fingerprint supplied', {
        requestId,
      });
    }

    if (allow) {
      // 6a. completeness: never allow an operation whose material was omitted.
      const blocked = pending.allowBlocked ?? this.allowRefusalReason(pending);
      if (blocked !== null) {
        throw new PermissionError(
          PERMISSION_CODES.incomplete,
          blocked === PERMISSION_REASONS.incompleteEvidence
            ? 'the operation was shortened by a bound, so it cannot be allowed; reject it or ask the worker to narrow the call'
            : 'the recorded tool call cannot be re-verified, so an allow cannot be granted',
          { requestId, reason: blocked, boundsApplied: [...pending.boundsApplied] },
        );
      }
      // 6b. the operation must still be the SAME live record.
      const changed = this.reverifyOperation(pending);
      if (changed !== null) {
        throw new PermissionError(
          PERMISSION_CODES.changed,
          'the recorded tool call is no longer the exact operation this request was created for',
          { requestId, reason: changed },
        );
      }
    }

    const reason = this.boundText(request?.reason, PERMISSION_BOUNDS.decisionReasonChars);
    const outcome = allow ? 'allowed-once' : 'rejected';
    this.settle(pending, PERMISSION_STATES.decided, outcome, {
      reason: reason ?? (allow ? 'the commander allowed this call once' : 'the commander rejected this call'),
      decidedBy: 'commander',
      // Record which checks the grant passed, so the evidence states WHY an allow
      // was allowed instead of only that it was.
      ...(allow
        ? {
          verified: {
            fingerprintQuoted: true,
            argumentsComplete: pending.argumentsComplete === true,
            callReread: true,
            turnOpen: true,
            boundsApplied: [...pending.boundsApplied],
          },
        }
        : {}),
    });
    return this.history.at(-1) ?? null;
  }

  /**
   * Settle one pending request exactly once and release its waiter.
   *
   * Idempotent by state: the deadline timer, the tool's abort signal, a decision
   * and a stop can all race, and only the first one is applied. The waiter's
   * promise is resolved with the OUTCOME, so the paused tool call resumes with
   * the native vocabulary rather than with this module's own words.
   * @param {object} pending - pending record.
   * @param {string} state - `decided`/`expired`/`cancelled`/`unavailable`.
   * @param {string} outcome - one of {@link APPROVAL_OUTCOMES}.
   * @param {object} [evidence] - `reason`, `decidedBy`.
   * @returns {boolean} true when this call settled the request.
   */
  settle(pending, state, outcome, evidence = {}) {
    if (pending === null || pending.state !== PERMISSION_STATES.pending) return false;
    pending.state = state;
    pending.settledOutcome = APPROVAL_OUTCOMES.includes(outcome) ? outcome : 'unavailable';
    pending.decidedAt = this.now();
    pending.decidedBy = evidence.decidedBy ?? null;
    pending.decisionReason = typeof evidence.reason === 'string' ? this.redact(evidence.reason).slice(0, PERMISSION_BOUNDS.decisionReasonChars) : null;
    if (evidence.verified !== undefined && evidence.verified !== null) {
      pending.verified = evidence.verified;
    }
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (pending.externalSignal !== null && pending.onExternalAbort !== null) {
      try {
        pending.externalSignal.removeEventListener?.('abort', pending.onExternalAbort);
      } catch {
        // Removing a listener from a foreign signal is best effort by contract.
      }
      pending.onExternalAbort = null;
      pending.externalSignal = null;
    }
    this.history.push(this.publicView(pending));
    if (this.history.length > PermissionBridge.HISTORY_BOUND) this.history.shift();
    const resolvePromise = pending.resolve;
    pending.resolve = null;
    if (typeof resolvePromise === 'function') resolvePromise(pending.settledOutcome);
    if (this.pending === pending) this.pending = null;
    try {
      this.onSettled?.(this.history.at(-1));
    } catch (error) {
      this.logger?.warn?.('dsh-delegate: permission observer failed', String(error?.code ?? ''));
    }
    return true;
  }

  /**
   * Clear the pending slot of an answered request.
   * @param {object} pending - pending record.
   * @returns {void}
   */
  clearPending(pending) {
    if (this.pending === pending) this.pending = null;
  }

  /**
   * Record a request that was refused because its identity could not be bound.
   *
   * This is evidence, not a decision: nothing was granted, and the record says
   * which check failed so an operator can act on the tool surface instead of
   * guessing why a worker was told "no approval channel".
   * @param {object} request - native approval request.
   * @param {string} reason - fixed {@link PERMISSION_REASONS} value.
   * @returns {void}
   */
  recordRejectedBinding(request, reason) {
    this.sequence += 1;
    const createdAt = this.now();
    const entry = {
      requestId: `permission-${this.taskId}-${this.sequence}`,
      taskId: this.taskId,
      connectionId: this.connectionId,
      sessionId: this.sessionId,
      toolName: this.boundText(request?.toolName, 120),
      callId: this.boundText(request?.callId, 200),
      turn: null,
      step: null,
      fingerprint: null,
      arguments: null,
      argumentKeys: [],
      claimedReason: this.boundText(request?.reason, PERMISSION_BOUNDS.reasonChars),
      requestedAccess: { kind: 'unbound', mode: null },
      createdAt,
      deadlineAt: createdAt,
      state: PERMISSION_STATES.unavailable,
      decision: null,
      decidedAt: createdAt,
      decidedBy: 'binding',
      decisionReason: reason ?? PERMISSION_REASONS.unbound,
      settledOutcome: 'rejected',
      bindingReason: reason ?? PERMISSION_REASONS.unbound,
    };
    this.history.push(entry);
    if (this.history.length > PermissionBridge.HISTORY_BOUND) this.history.shift();
    try {
      this.onSettled?.(entry);
    } catch {
      // The refusal is already recorded; an observer throw cannot change it.
    }
  }

  /**
   * Stop the outstanding request, if any, and restore the policy.
   *
   * The outcome is chosen by the caller because the CAUSE differs and the worker
   * must see the difference: a cancel/stop/switch-off withdraws the question
   * (`cancelled`), while disposal makes the bridge unusable (`unavailable`).
   * Either way the paused call resumes immediately with a refusal, the request's
   * timer and listener are released, and no later decision can apply.
   * @param {string} state - `cancelled` or `unavailable`.
   * @param {string} [reason] - fixed reason text.
   * @returns {boolean} true when a pending request was settled.
   */
  stop(state = PERMISSION_STATES.cancelled, reason = PERMISSION_REASONS.stop) {
    const outcome = state === PERMISSION_STATES.unavailable ? 'unavailable' : 'cancelled';
    const pending = this.pending;
    if (pending === null) {
      return false;
    }
    return this.settle(pending, state, outcome, { reason, decidedBy: 'stop' });
  }

  /**
   * Disarm the bridge permanently.
   *
   * Disposal settles an outstanding request `unavailable` (no decision can be
   * applied to a bridge that no longer exists), clears `armed` so no policy writer
   * may keep `ask` installed, and drops the bound Agent so a disposed bridge can
   * never answer a request that a live Session still holds a reference to.
   * @returns {void}
   */
  dispose() {
    if (this.disposed) return;
    this.stop(PERMISSION_STATES.unavailable, PERMISSION_REASONS.disposed);
    this.armed = false;
    this.disposed = true;
    this.agent = null;
    this.session = null;
  }

  /**
   * The public, bounded projection of one request.
   *
   * Everything here is either an identifier the caller already holds, a redacted
   * argument projection, or a timestamp. The exact fingerprint IS published,
   * because the decision tool accepts it back to bind a decision to exactly this
   * operation; it is a digest of the arguments, not the arguments.
   * @param {object} pending - pending or settled record.
   * @returns {object} redacted view.
   */
  publicView(pending) {
    return {
      requestId: pending.requestId,
      taskId: pending.taskId,
      // Stated, not implied: the commander is told which conversation and which
      // tool call is paused, so the decision is about an operation it can name.
      sessionId: pending.sessionId,
      toolName: pending.toolName,
      callId: pending.callId,
      turn: pending.turn,
      step: pending.step,
      tool: { name: pending.toolName, callId: pending.callId },
      state: pending.state,
      // The asker's own one-line claim, kept apart from the operation itself.
      reason: pending.claimedReason ?? null,
      reasonSource: 'asker-claim',
      requestedAccess: pending.requestedAccess,
      argumentKeys: pending.argumentKeys,
      arguments: pending.arguments,
      argumentsRedacted: true,
      // Completeness, published so a reader never has to infer it from a trailing
      // marker in the text: an allow is refused when this is not `complete`.
      completeness: pending.completeness ?? PERMISSION_COMPLETENESS.complete,
      argumentsComplete: pending.argumentsComplete !== false,
      boundsApplied: Array.isArray(pending.boundsApplied) ? [...pending.boundsApplied] : [],
      omitted: pending.omitted ?? { valueChars: 0, keys: 0, depth: 0, items: 0 },
      // Why an allow would be refused, or null. Stated so the commander is not left
      // guessing why `allow-once` came back refused.
      allowBlocked: pending.allowBlocked ?? null,
      fingerprint: pending.fingerprint,
      createdAt: pending.createdAt,
      deadlineAt: pending.deadlineAt,
      decision: pending.decision,
      decidedAt: pending.decidedAt,
      decidedBy: pending.decidedBy,
      decisionReason: pending.decisionReason,
      outcome: pending.settledOutcome,
      // For a settled allow: which checks the grant actually passed.
      ...(pending.verified === undefined || pending.verified === null ? {} : { verified: pending.verified }),
      ...(pending.bindingReason === undefined ? {} : { bindingReason: pending.bindingReason }),
      // The narrow exception, restated on the evidence itself so no reader has to
      // infer it: this is one call, decided once, and nothing was granted beyond it.
      grant: pending.settledOutcome === 'allowed-once'
        ? { kind: 'allowed-once', appliesTo: 'this-call-only', callId: pending.callId, reusable: false }
        : null,
      standingModeUnchanged: true,
    };
  }

  /** The pending request's public view, or `null`. */
  pendingView() {
    return this.pending === null ? null : this.publicView(this.pending);
  }

  /** Copy of the settled evidence trail, newest last. */
  historyView() {
    return this.history.map((entry) => ({ ...entry }));
  }

  /**
   * Redact and bound one free-form string.
   * @param {unknown} value - untrusted text.
   * @param {number} cap - character bound.
   * @returns {string | null} bounded redacted text, or null when empty.
   */
  boundText(value, cap) {
    if (typeof value !== 'string' || value === '') return null;
    const text = this.redact(value);
    return text.length > cap ? `${text.slice(0, cap)}…` : text;
  }
}

/**
 * Whether a value is an outcome this plugin may act on.
 * @param {unknown} value - candidate outcome.
 * @returns {boolean} true for the closed vocabulary.
 */
export function isApprovalOutcome(value) {
  return typeof value === 'string' && APPROVAL_OUTCOMES.includes(value);
}
