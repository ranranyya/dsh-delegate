// The review composition: a dedicated, plugin-owned native agent preset.
//
// Why this module exists. An Agent that joins no preset has no tools at all, and
// the deployment's DEFAULT preset is not a read-only surface: the shipped
// `standard` composition mounts `dsh-tool-subagent`, whose tool is registered
// into the composing agent's OWN scope layer before the agent's setup hook runs.
// A scope-local registration is exactly what `tools.restrict()` cannot remove
// (see `ToolRuntime.view()`: a restriction filters what a scope INHERITS and
// never what its own layer registers). A reviewer that joins the default preset
// therefore advertises `subagent` and cannot honestly be called read-only.
//
// The fix is composition, not a wider allow-list: register ONE dedicated preset
// whose rows are only the filesystem readers, so there is no delegation row to
// inject anything agent-local in the first place. The scoped restriction in
// `reviewer.js` still removes `write`/`edit` (which `dsh-tool-fs` registers into
// the preset plane unless told otherwise) and the post-install proof still
// re-reads the advertised surface.
//
// Readiness is a FINITE STATE, not a boolean:
//
//   idle -> preparing -> ready
//          preparing -> idle      (a failure a later review may retry)
//          any state -> disposed  (the plugin unloaded)
//
// and the transitions exist to make four race conditions unrepresentable:
//
//  1. NOTHING becomes ready before it is VALIDATED. `register()` resolves for a
//     definition whose rows failed to mount (the registry records the diagnostic
//     and `resolve()` reports it), so "registered" is not "usable". A resolve
//     that fails, times out or reports a broken row retires that registration and
//     returns the composition to `idle`; a later review then starts a NEW
//     attempt instead of mounting a composition nothing ever proved.
//  2. A registration that finishes after the caller that asked for it has given
//     up is retired immediately and never publishes its id. Readiness is
//     published only by the attempt that completes the whole sequence.
//  3. Concurrent preparers each honour their OWN deadline and signal. They share
//     the registration work, but a caller that times out or is cancelled gets
//     its own distinct refusal without cancelling the other callers' work.
//  4. A late registration from an abandoned attempt, or one from a registry this
//     instance no longer uses, is retired rather than republishing ownership.
//  5. A registration that RESOLVES after `dispose()` has completed is retired on
//     arrival: it is never claimed, never validated, never published, and its
//     disposer runs exactly once. Readiness is published only from a claim this
//     instance made while it was still usable.
//
// Contract notes this module is shaped by, read from the installed
// `@deepseek-ai/dsh-agent-preset-registry` (0.2.0-rc.2 and 0.2.1-rc.2, which
// agree on every call used here):
//  - `register(definition)` validates the id, refuses a duplicate id with
//    `Duplicate agent preset: <id>`, activates the definition eagerly and
//    resolves to an async disposer. A definition whose rows FAIL to mount is not
//    rejected here: `activate()` records the diagnostic and `register` still
//    resolves. So registration is followed by `resolve(id)`, which reports the
//    failure as `broken` and becomes `REVIEW_PRESET_UNUSABLE` here.
//  - `resolve(id?)` rejects with `Unknown agent preset: <id>` when the
//    registration is gone.
//  - `mount(ctx, id)` binds an unpublished Agent to that definition.
//  - `diagnostic()` may wait for the Host Loader tree to settle, and the registry
//    says callers must not run inside a Host row's own activation. Registration
//    is therefore LAZY — it happens on the first review request, from a request
//    handler, never from this plugin's `apply`.
//  - Registration and verification are the two preparation steps that can wait
//    on other plugins, so BOTH are bounded, separately, by the caller's deadline.
//  - Nothing here mutates the registry's configured default, the installed
//    profile YAML, or any user preset: only a new, namespaced declaration is
//    added, and its disposer removes it again on unload.

import { randomBytes } from 'node:crypto';

import { RunError } from '../runtime/agent-runner.js';

/** Codes this module raises. Distinct from every tool-policy code in `reviewer.js`. */
export const PRESET_CODES = Object.freeze({
  // The registry cannot register a composition at all.
  unsupported: 'REVIEW_PRESET_UNSUPPORTED',
  // `register()` itself refused (duplicate id, invalid definition, ...).
  registerFailed: 'REVIEW_PRESET_REGISTER_FAILED',
  // Registered, but the composition has an unusable row (`resolve()` reported it).
  unusable: 'REVIEW_PRESET_UNUSABLE',
  // The composition rows could not be loaded at all.
  rowsUnavailable: 'REVIEW_PRESET_ROWS_UNAVAILABLE',
  // A mount for an id this plugin does not own was requested.
  notOwned: 'REVIEW_PRESET_NOT_OWNED',
  // Registration/mount preparation exceeded its own bounded deadline.
  prepareTimeout: 'REVIEW_PRESET_PREPARE_TIMEOUT',
  cancelled: 'REVIEW_PRESET_PREPARE_CANCELLED',
  // The plugin lifecycle closed while preparation was still pending.
  disposed: 'REVIEW_PRESET_DISPOSED',
});

/**
 * The readiness states of one instance's composition.
 *
 * `failed` is not a state: a failure returns the instance to `idle` so the next
 * review retries, and every caller sees the refusal that its own attempt got.
 */
export const PRESET_STATES = Object.freeze({
  idle: 'idle',
  preparing: 'preparing',
  ready: 'ready',
  disposing: 'disposing',
  disposed: 'disposed',
});

/**
 * Native packages the review composition is built from.
 *
 * Both are real `@deepseek-ai/dsh-*` entry points and are loaded through this
 * package (or, in a linked install, through the host). They are peer
 * dependencies of the preset registry's environment, not of the Cordis
 * composition: the composition mounts them inside the Agent scope.
 */
export const REVIEW_PACKAGES = Object.freeze(Object.freeze({
  fs: '@deepseek-ai/dsh-tool-fs',
  search: '@deepseek-ai/dsh-tool-fs-search',
}));

/**
 * The rows of the dedicated review composition, in mount order.
 *
 * Deliberately tiny. Every row here is a read surface:
 *  - `dsh-tool-fs` with `read`/`read_image` on and `write`/`edit` off, so the
 *    preset plane never contains a mutation tool at all;
 *  - `dsh-tool-fs-search` with `sampleOverCapGlobResults: false`, the same
 *    deterministic glob page the deployment uses.
 *
 * Excluded on purpose: delegation (`dsh-tool-subagent`, `dsh-tool-workflow`,
 * `dsh-workflow-ptc`), shell (`dsh-tool-bash`, `dsh-tool-pwsh`), scheduling
 * (`dsh-tool-schedule`), skills, jobs, web, todos, goals, plan mode, compaction
 * and every other mutating or self-directed capability. Session, agent loop,
 * system prompt, working directory and the model route are Host services the
 * Agent already has; a preset does not (and must not) re-provide them.
 *
 * `read_image` needs the deployment's attachment store, which is a Host service
 * the agent scope inherits; `glob`/`grep` need `subprocess`, also Host-supplied.
 * Neither is re-mounted here.
 * @returns {object[]} fresh row list (the registry may keep references).
 */
export function reviewCompositionRows() {
  return [
    {
      id: 'tool-fs',
      name: REVIEW_PACKAGES.fs,
      config: {
        read: true,
        readImage: true,
        // Composition-level exclusion, not a policy claim: these tools are never
        // registered inside the review plane, so no restriction has to remove
        // them and no future `restrict()` gap can expose them.
        write: false,
        edit: false,
      },
    },
    {
      id: 'tool-fs-search',
      name: REVIEW_PACKAGES.search,
      config: { sampleOverCapGlobResults: false },
    },
  ];
}

/**
 * The preset definition this plugin registers.
 * @param {string} id - the owned, namespaced preset id.
 * @returns {{ id: string, name: string, description: string, order: number, plugins: object[] }} definition.
 */
export function reviewPresetDefinition(id) {
  return {
    id,
    // Shown in a roster if an operator ever looks: it must not read as a preset
    // they may select for their own sessions, and it is not the default.
    name: 'dsh-delegate additional review (plugin-owned)',
    description: 'Read-only filesystem composition used by the dsh-delegate independent review.',
    // Sorted after the shipped presets so a roster listing keeps them first.
    order: 1000,
    plugins: reviewCompositionRows(),
  };
}

/**
 * Load the native rows the composition names.
 *
 * A failure here is a deployment fact (the tool packages are absent), not a
 * policy decision, and it is reported before anything is registered.
 *
 * The load itself is bounded: a package import is normally a file read, but a
 * solver seam (a test importer, a host resolver) may be slow or never settle,
 * and preparation must not hang on it. The failure code distinguishes a
 * deadline from an absent package, because the operator fixes them differently.
 * @param {(specifier: string) => Promise<object>} importer - dynamic importer.
 * @param {{ timeoutMs?: number|null, signal?: AbortSignal|null }} [bounds] - preparation bounds.
 * @returns {Promise<Map<string, object>>} package name -> module.
 * @throws {RunError} with `rowsUnavailable`, `prepareTimeout` or `cancelled`.
 */
async function loadRows(importer, bounds = {}) {
  const loaded = new Map();
  const missing = [];
  for (const specifier of [REVIEW_PACKAGES.fs, REVIEW_PACKAGES.search]) {
    let pending;
    try {
      pending = Promise.resolve(importer(specifier));
    } catch (error) {
      // An importer that throws synchronously is the same deployment fact as one
      // that rejects: the package could not be loaded.
      missing.push(`${specifier}: ${messageOf(error)}`);
      continue;
    }
    let module;
    try {
      module = await bounded(pending, {
        timeoutMs: bounds.timeoutMs ?? null,
        signal: bounds.signal ?? null,
        code: PRESET_CODES.prepareTimeout,
        message: 'loading the native packages for the read-only review composition did not finish in time',
      });
    } catch (error) {
      // A deadline or a cancellation is the CALLER's outcome, not a missing
      // package: reporting it as `rowsUnavailable` would tell an operator to
      // install something they already have.
      if (error instanceof RunError && (error.code === PRESET_CODES.prepareTimeout || error.code === PRESET_CODES.cancelled)) {
        throw error;
      }
      missing.push(`${specifier}: ${messageOf(error)}`);
      continue;
    }
    if (module === null || typeof module !== 'object' || typeof module.apply !== 'function') {
      missing.push(`${specifier} (no apply export)`);
      continue;
    }
    loaded.set(specifier, module);
  }
  if (missing.length > 0) {
    throw new RunError(
      PRESET_CODES.rowsUnavailable,
      'the read-only review composition needs the native filesystem tool packages, which this deployment does not provide',
      { missingPackages: missing },
    );
  }
  return loaded;
}

/** One bounded, redacted-ish line of an error for a fixed-shape detail field. */
function messageOf(error) {
  return String(error?.message ?? error).slice(0, 200);
}

/**
 * Settle a promise under a deadline and an optional cancellation signal.
 *
 * Used for every step of preparation that can wait on something else (a package
 * solve, `register()`, `resolve()`). A caller that runs out of budget gets its
 * own refusal; the abandoned work keeps running and is retired by the attempt
 * that started it, because the registry owns whatever it created.
 *
 * An empty signal (`reason === undefined`) is a legacy abort and is honoured the
 * same way as a named one: abort is abort.
 * @param {Promise<unknown>} promise - work to bound.
 * @param {{ timeoutMs?: number|null, signal?: AbortSignal|null, code?: string, message?: string }} options - bounds.
 * @returns {Promise<unknown>} the work's result.
 * @throws {RunError} when the deadline or the signal fires first.
 */
async function bounded(promise, options) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : null;
  const signal = options.signal ?? null;
  if (signal?.aborted === true) {
    throw new RunError(PRESET_CODES.cancelled, cancelMessage(options.message), {});
  }
  if (timeoutMs === null && signal === null) return await promise;

  let timer = null;
  let onAbort = null;
  const guards = [];
  if (timeoutMs !== null) {
    guards.push(new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RunError(options.code ?? PRESET_CODES.prepareTimeout, options.message ?? 'preparing the review composition did not finish in time', { timeoutMs }));
      }, timeoutMs);
      timer.unref?.();
    }));
  }
  if (signal !== null) {
    guards.push(new Promise((_resolve, reject) => {
      onAbort = () => reject(new RunError(PRESET_CODES.cancelled, cancelMessage(options.message), {}));
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }
  try {
    return await Promise.race([promise, ...guards]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) signal?.removeEventListener?.('abort', onAbort);
    // A guard that lost the race must never surface as an unhandled rejection
    // when its deadline fires later (the timer is cleared, but a signal that
    // aborts after this point would otherwise reject an unwatched promise).
    for (const guard of guards) guard.catch(() => {});
  }
}

/** Turn a step description into a cancellation message. */
function cancelMessage(detail) {
  return typeof detail === 'string' && detail !== ''
    ? `the review was cancelled while ${detail}`
    : 'the review was cancelled while preparing its composition';
}

/**
 * Install a late continuation on a promise, swallowing both outcomes.
 *
 * This is the shape every abandonable registration/resolve uses: the caller is
 * gone, so nobody may observe the rejection, and nobody may be kept waiting for
 * it either. `settle` is called exactly once, when the work finishes, and is
 * whatever cleanup the attempt owns.
 * @param {Promise<unknown>} promise - work to continue.
 * @param {(outcome: { ok: boolean, value?: unknown, error?: unknown }) => unknown} settle - continuation.
 * @param {object|null} [logger] - logger for a cleanup failure; never throws.
 * @returns {void}
 */
function continueLate(promise, settle, logger = null) {
  const run = async (outcome) => {
    try {
      await settle(outcome);
    } catch (error) {
      logger?.warn?.('dsh-delegate: a late review composition cleanup failed', messageOf(error));
    }
  };
  promise.then(
    (value) => run({ ok: true, value }),
    (error) => run({ ok: false, error }),
  );
}

/** Bound on one preparation step performed by the shared attempt. */
const PREPARE_STEP_TIMEOUT_MS = 30_000;

/** Bound on waiting for a registration disposer during unload. */
const DISPOSE_TIMEOUT_MS = 5_000;

/**
 * A plugin-instance-owned native preset for the independent review.
 *
 * One instance per plugin activation. The composition is registered lazily on
 * the first request that needs it, exactly once, and every concurrent request
 * shares that one registration promise. The instance owns the id it created and
 * refuses to mount anything else.
 *
 * `createdId` is the instance's published ownership: it is non-null only in the
 * `ready` state, i.e. only after a full register -> resolve -> validate sequence
 * succeeded for a registry the instance still uses.
 */
export class ReviewPreset {
  /**
   * @param {object} [options] - `registry`, `logger`, `importer`, `id` (test seam).
   */
  constructor(options = {}) {
    this.registry = options.registry ?? null;
    this.logger = options.logger ?? null;
    // Overridable only so a test can prove the "packages absent" refusal without
    // uninstalling anything.
    this.importer = options.importer ?? ((specifier) => import(specifier));
    this.id = typeof options.id === 'string' && options.id !== '' ? options.id : ownedPresetId();
    // The published ownership. Only the `ready` state sets it.
    this.createdId = null;
    this.state = PRESET_STATES.idle;
    // The registration this instance currently owns (registry + disposer) and the
    // attempt that is producing or produced it. `pending` is null unless the
    // state is `preparing`.
    this.claim = null;
    this.pending = null;
    // Attempt sequence, so a late completion can tell whether it is still the
    // current attempt and whether its registry is still the attached one.
    this.sequence = 0;
    // Callers currently awaiting the shared attempt, and whether the last one
    // already gave up on it.
    this.waiters = 0;
    this.abandoned = false;
    // Resolves when `dispose()` has finished retiring everything; `null` outside
    // `disposing`.
    this.closing = null;
  }

  /** Whether a claim is the live, validated registration of this instance. */
  get ready() {
    return this.state === PRESET_STATES.ready && this.createdId !== null && this.claim !== null;
  }

  /**
   * Bind another registry to this instance (used when the service appears after
   * the plugin loaded). Never allowed to change the id this instance owns.
   *
   * Replacing the registry RETIRES the previous registration instead of
   * forgetting it: the composition in the old registry is still live, and
   * dropping the disposer would leave it there for the life of the process. The
   * old registration is also marked superseded, so a verification that is still
   * in flight for it retires itself instead of publishing an id that now belongs
   * to a registry no review will mount from.
   * @param {object|null} registry - native preset registry.
   * @returns {void}
   */
  attach(registry) {
    if (registry === null || registry === undefined) return;
    if (this.registry === registry) return;
    const previous = this.claim;
    // Mark BEFORE reassigning: any in-flight verification compares against
    // `claim.superseded` and against `registry` identity.
    if (previous !== null) previous.superseded = true;
    this.registry = registry;
    this.createdId = null;
    this.claim = null;
    if (this.state === PRESET_STATES.ready || this.state === PRESET_STATES.idle) {
      // The next preparation must run against the new registry, even if the old
      // attempt is still finishing (it is now superseded and will retire itself).
      this.state = PRESET_STATES.idle;
      this.pending = null;
    }
    // The state may be `preparing` (its own attempt owns the transition) or
    // `disposed` (nothing may be republished). Either way the old registration is
    // no longer this instance's, so it is released now, without waiting.
    if (previous !== null) this.release(previous);
  }

  /** Whether this registry exposes the API a review composition needs. */
  get supported() {
    const registry = this.registry;
    return registry !== null
      && registry !== undefined
      && typeof registry.register === 'function'
      && typeof registry.resolve === 'function'
      && typeof registry.mount === 'function';
  }

  /**
   * The preset id a review should mount, registering the composition if needed.
   *
   * Idempotent and concurrency-safe: the first caller starts the attempt, every
   * other caller awaits the same attempt, and each caller still applies its OWN
   * deadline and signal to that shared work. So one review that gives up never
   * cancels another review's preparation, and a shared attempt that ultimately
   * succeeds still publishes readiness for the reviews that waited.
   *
   * A failure returns the instance to `idle` so a later review can retry instead
   * of being poisoned by a transient one.
   * @param {{ timeoutMs?: number|null, signal?: AbortSignal|null }} [bounds] - this caller's deadline.
   * @returns {Promise<string>} the owned preset id, ready to mount.
   * @throws {RunError} with a stable code from {@link PRESET_CODES}.
   */
  async preparation(bounds = {}) {
    const caller = {
      timeoutMs: Number.isInteger(bounds?.timeoutMs) && bounds.timeoutMs > 0 ? bounds.timeoutMs : null,
      signal: bounds?.signal ?? null,
    };
    if (this.state === PRESET_STATES.disposed || this.state === PRESET_STATES.disposing) {
      throw new RunError(PRESET_CODES.disposed, 'the plugin was unloaded before the review composition could be prepared', {});
    }
    if (caller.signal?.aborted === true) {
      throw new RunError(PRESET_CODES.cancelled, cancelMessage(null), {});
    }
    if (!this.supported) {
      throw new RunError(
        PRESET_CODES.unsupported,
        'the native agent preset registry cannot register a composition, so a read-only review cannot be composed',
        {},
      );
    }
    if (this.ready) return this.createdId;
    if (this.pending === null) {
      this.state = PRESET_STATES.preparing;
      this.waiters = 0;
      this.pending = this.prepare();
      // The attempt settles itself; this observer only guarantees that a
      // rejection nobody awaited can never become an unhandled one.
      continueLate(this.pending, () => {
        if (this.pending === null) return;
        // Only clear the slot if the attempt did not already do so.
        this.pending = null;
        if (this.state === PRESET_STATES.preparing) this.state = PRESET_STATES.idle;
      }, this.logger);
    }
    // The shared attempt is raced against THIS caller's own bounds. A caller
    // that gives up returns its own refusal and never cancels work other callers
    // are still waiting for — but when the LAST caller gives up, the attempt is
    // marked abandoned, so a registration that completes afterwards retires
    // itself instead of publishing ownership nobody is waiting for.
    this.waiters += 1;
    try {
      return await bounded(this.pending, caller);
    } finally {
      this.waiters -= 1;
      if (this.waiters === 0 && this.state === PRESET_STATES.preparing) this.abandoned = true;
    }
  }

  /**
   * Run one full preparation attempt against the currently attached registry.
   *
   * The sequence is: load the native rows -> register -> claim the registration
   * -> resolve and validate -> publish readiness. Every step after the claim can
   * fail in a way that must NOT leave the composition marked ready, and a
   * superseded or closed attempt retires its registration instead of publishing.
   * @returns {Promise<string>} the owned preset id.
   */
  async prepare() {
    const registry = this.registry;
    const attempt = { sequence: this.sequence += 1, superseded: false };
    // This attempt starts with a clean abandonment mark; `preparation` sets it
    // again if the last caller of THIS attempt gives up.
    this.abandoned = false;
    // The attempt owns the `preparing` state: it was entered by `preparation`
    // before this method ran, and every exit below either publishes `ready` or
    // returns to `idle` through `settle(reason)`.
    const stepTimeoutMs = PREPARE_STEP_TIMEOUT_MS;

    const settle = (error) => {
      // Only the CURRENT attempt may move the instance out of `preparing`; a
      // superseded attempt that finishes later must not overwrite the state of a
      // newer one. `disposed`/`disposing` is terminal: a late step that fails
      // after unload leaves the instance disposed instead of resurrecting `idle`.
      if (this.registry === registry && this.pending !== null) {
        this.pending = null;
        this.waiters = 0;
        this.abandoned = false;
        if (this.state === PRESET_STATES.preparing) this.state = PRESET_STATES.idle;
      }
      throw error;
    };
    const abandon = settle;

    let rows;
    try {
      rows = await loadRows(this.importer, { timeoutMs: stepTimeoutMs, signal: null });
    } catch (error) {
      return abandon(error);
    }
    void rows;
    if (this.isStale(attempt, registry)) {
      return abandon(new RunError(
        PRESET_CODES.cancelled,
        'the review composition preparation was superseded before it could finish',
        {},
      ));
    }

    // A duplicate id is the one registration failure we must not paper over: it
    // means another owner already uses this namespace, and mounting THEIR
    // composition would silently review on a surface we did not define.
    let disposer;
    let registering;
    try {
      registering = Promise.resolve(registry.register(reviewPresetDefinition(this.id)));
    } catch (error) {
      return abandon(registerRefusal(error));
    }
    try {
      disposer = await bounded(registering, {
        timeoutMs: stepTimeoutMs,
        signal: null,
        code: PRESET_CODES.prepareTimeout,
        message: 'registering the read-only review composition did not finish in time',
      });
    } catch (error) {
      // The registration may still complete after this deadline. If it does, the
      // disposer retires it; nothing here waits for that. This is the case that
      // used to leak a live composition AND republish its ownership later.
      continueLate(registering, (outcome) => {
        if (outcome.ok && typeof outcome.value === 'function') return retireQuietly(outcome.value, this.logger);
        return undefined;
      }, this.logger);
      return abandon(error instanceof RunError ? error : registerRefusal(error));
    }
    if (typeof disposer !== 'function') {
      return abandon(new RunError(
        PRESET_CODES.registerFailed,
        'the native preset registry did not return a disposer for the review composition',
        {},
      ));
    }

    // A registration that arrives after unload began must never become this
    // instance's claim — not even for an instant. `dispose()` snapshotted the
    // claim (null, because nothing was registered yet), cleared `createdId` and
    // marked the attempt superseded, but the claim object did not exist then, so
    // it cannot carry that mark. Retiring it here is the only way its disposer
    // runs exactly once and the registry never keeps a composition nothing owns.
    if (this.state === PRESET_STATES.disposing || this.state === PRESET_STATES.disposed) {
      await retireQuietly(disposer, this.logger);
      return abandon(new RunError(
        PRESET_CODES.disposed,
        'the plugin was unloaded before the review composition finished registering',
        {},
      ));
    }

    // The claim exists from here on: whatever happens, this instance is the owner
    // of this registration and will retire it on failure or on unload.
    const claim = { registry, attempt: attempt.sequence, disposer, superseded: attempt.superseded };
    this.claim = claim;

    if (this.isStale(attempt, registry, claim)) {
      this.retireClaim(claim);
      return abandon(new RunError(
        PRESET_CODES.cancelled,
        'the review composition preparation was superseded before it could be verified',
        {},
      ));
    }

    // `register()` resolves for a definition whose rows failed to mount — it
    // records the diagnostic instead. `resolve()` is the supported read that
    // reports it, which is what turns "registered" into "usable".
    let resolving;
    try {
      resolving = Promise.resolve(registry.resolve(this.id));
    } catch (error) {
      return this.failVerification(claim, unusableRefusal(error, null));
    }
    let resolved;
    try {
      resolved = await bounded(resolving, {
        timeoutMs: stepTimeoutMs,
        signal: null,
        code: PRESET_CODES.prepareTimeout,
        message: 'verifying the read-only review composition did not finish in time',
      });
    } catch (error) {
      // Same shape as registration: the verification may still settle after the
      // deadline, and its outcome must not be able to publish anything.
      return this.failVerification(
        claim,
        error instanceof RunError ? error : unusableRefusal(error, null),
        resolving,
      );
    }

    // From here the verdict is final, so a late resolution of a raced deadline is
    // only ever observed, never acted on.
    continueLate(resolving, () => undefined, this.logger);
    if (this.isStale(attempt, registry, claim)) {
      this.retireClaim(claim);
      return abandon(new RunError(
        PRESET_CODES.cancelled,
        'the review composition preparation was superseded before it could be trusted',
        {},
      ));
    }

    const broken = typeof resolved?.broken === 'string' && resolved.broken !== '' ? resolved.broken : null;
    if (broken !== null) {
      return this.failVerification(claim, unusableRefusal(null, broken));
    }
    if (resolved?.id !== undefined && resolved.id !== null && resolved.id !== this.id) {
      // Defensive: a registry that answers about a different definition has not
      // verified this one, and publishing it would claim an unproven surface.
      return this.failVerification(claim, new RunError(
        PRESET_CODES.unusable,
        'the native preset registry resolved a different composition than the one this review registered',
        {},
      ));
    }

    // Validated, current and not superseded: NOW readiness is published.
    claim.validated = true;
    this.state = PRESET_STATES.ready;
    this.createdId = this.id;
    this.pending = null;
    this.waiters = 0;
    this.abandoned = false;
    this.logger?.info?.(`dsh-delegate: registered read-only review preset ${this.id}`);
    return this.id;
  }

  /**
   * Whether an attempt may no longer publish its result.
   * @param {{ sequence: number, superseded: boolean }} attempt - the attempt.
   * @param {object} registry - the registry the attempt started against.
   * @param {object|null} [claim] - the registration the attempt made, if any.
   * @returns {boolean} true when the result must be retired instead of published.
   */
  isStale(attempt, registry, claim = null) {
    if (attempt.superseded || this.closing !== null) return true;
    if (this.abandoned) return true;
    if (this.registry !== registry) return true;
    const current = this.claim;
    if (claim !== null && current !== claim) return true;
    if (claim !== null && claim.superseded === true) return true;
    return false;
  }

  /**
   * Fail a verification: retire the registration and return the instance to idle.
   * @param {object} claim - the registration to retire.
   * @param {RunError} error - the refusal to raise.
   * @param {Promise<unknown>|null} [late] - in-flight verification to observe.
   * @returns {never} always throws.
   */
  failVerification(claim, error, late = null) {
    if (late !== null) continueLate(late, () => undefined, this.logger);
    // Retiring the claim never publishes readiness, so a verification failure can
    // never leave the instance claiming a composition nothing proved.
    this.retireClaim(claim);
    this.createdId = null;
    if (this.pending !== null) this.pending = null;
    this.waiters = 0;
    this.abandoned = false;
    if (this.state === PRESET_STATES.preparing) this.state = PRESET_STATES.idle;
    throw error;
  }

  /**
   * Retire one registration without waiting for it, keeping the instance usable.
   * @param {object} claim - registration to retire.
   * @returns {void}
   */
  retireClaim(claim) {
    if (this.claim === claim) this.claim = null;
    this.release(claim);
  }

  /**
   * Call a registration disposer at most once, never throwing and never awaited.
   * @param {object} claim - registration whose disposer to call.
   * @returns {void}
   */
  release(claim) {
    const disposer = claim.disposer;
    claim.disposer = null;
    if (typeof disposer !== 'function') return;
    let pending;
    try {
      pending = Promise.resolve(disposer());
    } catch (error) {
      this.logger?.warn?.('dsh-delegate: the review preset could not be unregistered', messageOf(error));
      return;
    }
    continueLate(pending, () => undefined, this.logger);
  }

  /**
   * Whether this instance owns `id` (i.e. the caller may mount it).
   * @param {string} id - requested preset id.
   * @returns {boolean} true when this instance registered AND validated it.
   */
  owns(id) {
    return typeof id === 'string' && id !== '' && id === this.createdId && this.ready;
  }

  /**
   * Remove the composition from the registry, if this instance registered one.
   *
   * Unload must not block forever on a registration that a foreign plugin never
   * finishes: the disposer is an external promise. So the early-return is the
   * `disposed` state, and a disposer that has not settled after its own bound is
   * left to a late continuation — the instance is already unusable by then,
   * because `createdId` is cleared synchronously.
   * @returns {Promise<void>} resolves once the instance is released.
   */
  async dispose() {
    if (this.state === PRESET_STATES.disposed) return;
    if (this.closing !== null) {
      await this.closing;
      return;
    }
    this.state = PRESET_STATES.disposing;
    // Every published fact goes away synchronously: a review that asks while the
    // disposer is still running must refuse, not mount a composition that is
    // being torn down.
    this.createdId = null;
    const claim = this.claim;
    this.claim = null;
    this.pending = null;
    if (claim !== null) claim.superseded = true;

    let resolveClosing;
    this.closing = new Promise((resolvePromise) => { resolveClosing = resolvePromise; });
    try {
      if (claim !== null) await this.releaseAndWait(claim);
    } finally {
      this.state = PRESET_STATES.disposed;
      this.closing = null;
      resolveClosing();
    }
  }

  /**
   * Release one claim, waiting for its disposer under a bound.
   * @param {object} claim - registration to retire.
   * @returns {Promise<void>} resolves when retired, or when the bound expires.
   */
  async releaseAndWait(claim) {
    const disposer = claim.disposer;
    claim.disposer = null;
    if (typeof disposer !== 'function') return;
    let pending;
    try {
      pending = Promise.resolve(disposer());
    } catch (error) {
      this.logger?.warn?.('dsh-delegate: the review preset could not be unregistered', messageOf(error));
      return;
    }
    try {
      await bounded(pending, {
        timeoutMs: DISPOSE_TIMEOUT_MS,
        signal: null,
        code: PRESET_CODES.prepareTimeout,
        message: 'unregistering the read-only review composition did not finish in time',
      });
    } catch (error) {
      this.logger?.warn?.('dsh-delegate: the review preset could not be unregistered', messageOf(error));
      // The disposer is still pending and still owned by the registry: observe it
      // so a late rejection is never unhandled, and stop waiting for it.
      continueLate(pending, () => undefined, this.logger);
    }
  }
}

/** Project a registration refusal into a stable code. */
function registerRefusal(error) {
  if (error instanceof RunError) return error;
  return new RunError(
    PRESET_CODES.registerFailed,
    'the native preset registry refused the read-only review composition',
    { cause: messageOf(error) },
  );
}

/** Project a failed or broken verification into a stable code. */
function unusableRefusal(error, broken) {
  if (error !== null && error !== undefined && !(error instanceof RunError)) {
    return new RunError(
      PRESET_CODES.unusable,
      'the read-only review composition could not be resolved after registration',
      { cause: messageOf(error) },
    );
  }
  return new RunError(
    PRESET_CODES.unusable,
    'the read-only review composition has an unusable row, so no read-only review can be composed',
    {
      unusable: String(broken ?? '')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(0, 5)
        // Fixed-shape evidence: the rows the registry reported, never a message
        // this module invented, and each line bounded.
        .map((line) => line.trim().slice(0, 200)),
    },
  );
}

/** Retire one registration that a late completion produced, never throwing. */
async function retireQuietly(disposer, logger) {
  try {
    await disposer();
  } catch (error) {
    logger?.warn?.('dsh-delegate: a late review preset registration could not be retired', messageOf(error));
  }
}

/**
 * A plugin-instance-unique, namespaced preset id.
 *
 * The namespace makes a collision impossible in practice and recognisable in a
 * diagnostic; the suffix keeps two plugin instances in one process apart, and
 * `register()` refuses a duplicate outright rather than letting one instance
 * mount another's composition.
 * @returns {string} preset id.
 */
export function ownedPresetId() {
  return `dsh-delegate-review-${randomBytes(6).toString('hex')}`;
}
