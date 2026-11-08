// Per-task DSH policy for delegated worker sessions.
//
// A worker must be able to modify its own workspace. DSH keeps that fact in the
// Session event log: `sandbox/mode` is folded by `ctx.sandboxPolicy` and
// `approval/policy` is folded by `ctx.approval`. Writing the events is therefore
// only half the job — the two services that read them back are what actually
// make a run confined, so this module installs the policy through the official
// writers and then READS IT BACK through the resolving services:
//
//   * `ctx.sandboxPolicy.resolve({ session })` must answer the requested mode and
//     the Session's own workspace root, and
//   * `ctx.approval.effectivePolicy(session)` must answer the requested stance,
//     and an escalation asked by that session must actually be rejected without
//     reaching an approval answerer when no bridge is armed (a `never` session
//     rejects deterministically).
//
// Any of these being unavailable, refusing, or disagreeing with what was written
// is a fail-closed refusal raised BEFORE the prompt is delivered
// ({@link SANDBOX_CODES}). Appending the events and hoping is exactly the failure
// mode this contract removes: a session that carries the events but is not
// actually confined would be reported as protected while it was not.
//
// ## The approval stance now has two values, and exactly one of them is per-run
//
// `never` remains the stance of every run WITHOUT a permission bridge, which is
// still the default and still the fail-closed answer: nothing in DSH can prompt
// this plugin, so an escalation is refused immediately and the worker is told so.
//
// `ask` is installed for ONE run, and only when that run hands over an ARMED
// bridge ({@link ./permissions.js}) bound to the Agent being driven. The bridge is
// the answerer: `ctx.approval.request()` dispatches `approval/request` as an
// agent-scoped waterfall, the bridge decides whether the request is its own, and
// the commander decides `allow-once`/`reject` out of band. The standing sandbox
// mode is NOT widened by this: a grant applies to the single call that asked, and
// `workspace-write` stays the Session's mode for the whole run.
//
// The two facts are verified together, and a bridge that is present but not armed
// is treated as NO bridge (the run keeps `never`) rather than as a promise to
// answer a question this plugin cannot see.
//
// Every value set here is per Session and per run: a continuation re-applies it,
// so a resumed thread converges on the current delegate contract instead of
// inheriting an older, possibly interactive policy. Nothing here touches the
// operator's ordinary sessions or the read-only review composition, because it is
// only ever called for a delegated worker run.

import { sameSessionPath } from './session-placement.js';

/** Stable delegated-session policy values. */
export const DELEGATE_SANDBOX_MODE = 'workspace-write';
/** The stance of a delegated run with NO permission bridge: deterministic rejection. */
export const DELEGATE_APPROVAL_POLICY = 'never';
/** The stance of a delegated run whose ARMED bridge answers its own requests. */
export const DELEGATE_BRIDGED_APPROVAL_POLICY = 'ask';

/** Refusal codes for a worker session that cannot be made safe to drive. */
export const SANDBOX_CODES = Object.freeze({
  unavailable: 'RUN_SANDBOX_POLICY_UNAVAILABLE',
});

/**
 * Stable reasons carried in `details.reason`.
 *
 * They are fixed strings chosen by this module — never a caller-supplied value —
 * so an operator can tell which capability was missing without reading a raw
 * upstream error into a job record.
 */
const REASONS = Object.freeze({
  noSession: 'session.append unavailable',
  noPolicyService: 'sandbox policy service unavailable',
  noApprovalService: 'approval service unavailable',
  writeRejected: 'policy event rejected',
  sandboxUnreadable: 'sandbox policy could not be read back',
  approvalUnreadable: 'approval policy could not be read back',
  sandboxMismatch: 'sandbox policy read back disagrees',
  approvalMismatch: 'approval policy read back disagrees',
  // A bridge was handed over but is not usable as the answerer for THIS Agent: it
  // is unarmed, disposed, or bound to another conversation. Such a bridge is not
  // a promise this plugin can keep, so the run keeps the deterministic `never`
  // stance instead of installing an `ask` nobody services.
  bridgeUnarmed: 'the permission bridge is not armed for this session',
});

/** Raised before a delegated prompt when its session policy cannot be installed. */
export class SandboxPolicyError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - bounded operator-facing explanation.
   * @param {object} [details] - non-secret facts.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SandboxPolicyError';
    this.code = code;
    this.details = details;
  }
}

/**
 * The two native services that own a Session's policy.
 *
 * Both are read live on every call (`ctx.get(name, false)`), for the same reason
 * the placement controllers are: DSH may compose a service after this plugin
 * activated, and a load-time snapshot would refuse every run forever on a harness
 * that composed it moments later.
 * @param {object} ctx - plugin context.
 * @returns {{ sandboxPolicy: object | null, approval: object | null }} the live services, or null.
 */
export function policyServicesOf(ctx) {
  return {
    sandboxPolicy: readOptionalService(ctx, 'sandboxPolicy'),
    approval: readOptionalService(ctx, 'approval'),
  };
}

/**
 * Read one optional native service without turning absence into a throw.
 * @param {object} ctx - plugin context.
 * @param {string} name - service name.
 * @returns {object | null} the service, or null when absent or unreadable.
 */
function readOptionalService(ctx, name) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return null;
  try {
    return ctx.get(name, false) ?? null;
  } catch {
    // An unreadable service is an ABSENT service: the run is then refused with
    // `RUN_SANDBOX_POLICY_UNAVAILABLE` instead of surfacing a property error.
    return null;
  }
}

/**
 * The Session a delegated run's policy belongs to.
 *
 * A live native Agent carries its Session; a Session passed directly is accepted
 * too, so a caller that already resolved one does not have to re-wrap it.
 * @param {object} agentOrSession - native Agent or Session.
 * @returns {object | null} the Session, or null.
 */
function sessionOf(agentOrSession) {
  const candidate = agentOrSession?.session ?? agentOrSession ?? null;
  if (candidate === null || typeof candidate !== 'object') return null;
  return typeof candidate.append === 'function' ? candidate : null;
}

/**
 * Install the delegate policy for one worker Session and prove it took effect.
 *
 * The policy is intentionally applied on every run, including an explicit
 * continuation, so a resumed session converges on the current contract.
 *
 * The approval stance is decided by CAPABILITY, never by configuration:
 *
 *  * a run that hands over an ARMED bridge bound to this Agent gets `ask`, and the
 *    bridge is the answerer the seam will consult;
 *  * every other run — including one whose bridge is absent, unarmed, disposed or
 *    bound elsewhere — gets `never`, which the native service resolves by
 *    rejecting the ask before any answerer runs.
 *
 * Either way the SAME read-back proves what was installed, and `workspace-write`
 * is installed and verified exactly as before. Nothing here ever writes a wider
 * sandbox mode: a bridge can only answer a per-call escalation the native tool
 * asked for, and that grant never becomes the Session's standing mode.
 * @param {object} agentOrSession - native Agent or Session.
 * @param {object} [services] - `{ sandboxPolicy, approval }`; both are natively available
 *   and are required for the policy to be verifiable.
 * @param {object} [options] - `bridge`: the run's {@link PermissionBridge}, when it has one.
 * @returns {{ mode: string, approvalPolicy: string, workspaceRoot: string, bridged: boolean }} verified facts.
 * @throws {SandboxPolicyError} when the Session cannot accept the events, when either
 *   service is missing, or when either service does not read the policy back.
 */
export function configureDelegatedSession(agentOrSession, services = {}, options = {}) {
  const session = sessionOf(agentOrSession);
  if (session === null) {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      'the delegated DSH session cannot accept sandbox policy events, so the worker was not started',
      { reason: REASONS.noSession },
    );
  }
  const sandboxPolicy = services?.sandboxPolicy ?? null;
  const approval = services?.approval ?? null;
  // Capability checks come BEFORE anything is written: a run that could not be
  // verified must not leave a half-installed policy on a live Session.
  assertCapability(sandboxPolicy, 'resolve', REASONS.noPolicyService,
    'the DSH sandbox policy service is unavailable, so the worker could not be confined');
  assertCapability(approval, 'effectivePolicy', REASONS.noApprovalService,
    'the DSH approval service is unavailable, so the worker\'s approval stance could not be established');

  // The stance is `ask` ONLY for a bridge that can actually answer: armed, not
  // disposed, and bound to the very Agent this policy is installed for. A bridge
  // that fails any of those is treated as no bridge (see {@link REASONS.bridgeUnarmed}).
  const bridge = options?.bridge ?? null;
  const bridged = bridgeUsableFor(bridge, agentOrSession, session);
  const stance = bridged ? DELEGATE_BRIDGED_APPROVAL_POLICY : DELEGATE_APPROVAL_POLICY;

  // `sandbox/mode` carries the whole post-change state (the whole-value event
  // rule), and `approval/policy` carries the stance the next ask resolves under.
  // `never` is deterministic rejection, not automatic approval: an escalation
  // asked by this session is refused without reaching any answerer. `ask` is not
  // approval either — it delegates the question to the composed answerers, of
  // which this run's bridge is one, and an unanswerable question still fails closed.
  try {
    session.append('sandbox/mode', { mode: DELEGATE_SANDBOX_MODE });
    session.append('approval/policy', { policy: stance });
  } catch (error) {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      'the delegated DSH session rejected its sandbox policy, so the worker was not started',
      { reason: REASONS.writeRejected, cause: typeof error?.code === 'string' ? error.code : null },
    );
  }

  const resolved = readSandboxPolicy(sandboxPolicy, session);
  const observed = readApprovalPolicy(approval, session);

  if (resolved.mode !== DELEGATE_SANDBOX_MODE) {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      'the DSH sandbox policy does not resolve as installed, so the worker was not started',
      { reason: REASONS.sandboxMismatch, expected: DELEGATE_SANDBOX_MODE, observed: resolved.mode },
    );
  }
  // A `workspace-write` session with no workspace root would write nowhere; a root
  // that is not the Session's own directory would write somewhere else. Both are
  // the same operator situation: the confinement does not cover this conversation.
  // The comparison is `sameSessionPath` — the one canonical-directory identity this
  // plugin already uses to place and to resume sessions — so a separator, a
  // trailing slash or a letter case on Windows cannot make one directory look like
  // another (or a different one look the same) here.
  const headerCwd = typeof session.header?.cwd === 'string' ? session.header.cwd : null;
  if (typeof resolved.workspaceRoot !== 'string' || resolved.workspaceRoot === '') {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      'the DSH sandbox policy reports no workspace root for this session, so the worker was not started',
      { reason: REASONS.sandboxMismatch },
    );
  }
  if (headerCwd !== null && !sameSessionPath(resolved.workspaceRoot, headerCwd)) {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      'the DSH sandbox policy resolves another workspace than this session\'s own, so the worker was not started',
      { reason: REASONS.sandboxMismatch, sessionPath: headerCwd, workspaceRoot: resolved.workspaceRoot },
    );
  }
  if (observed !== stance) {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      bridged
        ? 'the DSH approval policy does not resolve as the armed bridge stance, so the worker was not started'
        : 'the DSH approval policy does not resolve as installed, so the worker was not started',
      { reason: REASONS.approvalMismatch, expected: stance, observed },
    );
  }
  return {
    mode: resolved.mode,
    approvalPolicy: observed,
    workspaceRoot: resolved.workspaceRoot,
    // Whether an armed bridge is the reason this Session asks instead of rejecting.
    bridged,
  };
}

/**
 * Whether a bridge can actually answer this run's requests.
 *
 * The three facts are checked together because any one of them missing makes the
 * `ask` stance a promise nobody keeps: an unarmed bridge never answers, a disposed
 * one answers `unavailable`, and a bridge bound to another Agent refuses every
 * request as foreign. In all three cases the run keeps `never` and is told so by
 * the read-back, instead of installing a stance whose answerer cannot exist.
 * @param {object | null} bridge - the run's permission bridge, when it has one.
 * @param {unknown} agentOrSession - the policy subject.
 * @param {object} session - the Session the policy is installed on.
 * @returns {boolean} true when the bridge is the answerer for this Session.
 */
function bridgeUsableFor(bridge, agentOrSession, session) {
  if (bridge === null || bridge === undefined || typeof bridge !== 'object') return false;
  if (bridge.armed !== true || bridge.disposed === true) return false;
  if (typeof bridge.owns !== 'function') return false;
  const agent = agentOrSession?.session !== undefined ? agentOrSession : { session };
  try {
    // The bridge's own identity rule decides, on the same shape a live request has.
    return bridge.owns({ agent, toolName: '', callId: '' }) === true;
  } catch {
    return false;
  }
}

/**
 * Refuse a service that cannot answer the question the policy needs answered.
 * @param {unknown} service - native service or null.
 * @param {string} method - the call the policy verifies through.
 * @param {string} reason - stable `details.reason`.
 * @param {string} message - operator-facing explanation.
 * @returns {void}
 * @throws {SandboxPolicyError} when the call is absent.
 */
function assertCapability(service, method, reason, message) {
  if (service === null || typeof service !== 'object' || typeof service[method] !== 'function') {
    throw new SandboxPolicyError(SANDBOX_CODES.unavailable, message, { reason });
  }
}

/**
 * Read the resolved sandbox policy back through the owning service.
 *
 * This is the same call an enforcing tool layer makes at each capability
 * boundary, so a value read here is what the next confined call will run under.
 * @param {object} sandboxPolicy - `ctx.sandboxPolicy`.
 * @param {object} session - the delegated Session, and the exact policy subject.
 * @returns {{ mode: unknown, workspaceRoot: unknown }} resolved policy facts.
 * @throws {SandboxPolicyError} when the service refuses to answer.
 */
function readSandboxPolicy(sandboxPolicy, session) {
  let resolved;
  try {
    resolved = sandboxPolicy.resolve({ session });
  } catch (error) {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      'the DSH sandbox policy could not be resolved for this session, so the worker was not started',
      { reason: REASONS.sandboxUnreadable, cause: typeof error?.code === 'string' ? error.code : null },
    );
  }
  if (resolved === null || typeof resolved !== 'object') {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      'the DSH sandbox policy service answered without a policy, so the worker was not started',
      { reason: REASONS.sandboxUnreadable },
    );
  }
  return { mode: resolved.mode, workspaceRoot: resolved.workspaceRoot };
}

/**
 * Read the Session's effective approval stance back through the owning service.
 *
 * `never` is the only stance that makes the worker unable to wait for an approval
 * prompt this plugin cannot answer, so anything else — including a service that
 * answers with a non-string — is refused rather than interpreted.
 * @param {object} approval - `ctx.approval`.
 * @param {object} session - the delegated Session.
 * @returns {unknown} the effective policy.
 * @throws {SandboxPolicyError} when the service refuses to answer.
 */
function readApprovalPolicy(approval, session) {
  try {
    return approval.effectivePolicy(session);
  } catch (error) {
    throw new SandboxPolicyError(
      SANDBOX_CODES.unavailable,
      'the DSH approval policy could not be read for this session, so the worker was not started',
      { reason: REASONS.approvalUnreadable, cause: typeof error?.code === 'string' ? error.code : null },
    );
  }
}
