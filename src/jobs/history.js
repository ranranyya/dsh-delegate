// Bounded durable job history.
//
// What may be stored is decided by explicit projection, not by whatever the
// caller happens to hold. `projectView` allow-lists the public fields a job view
// may contribute; every string passes `redactText`, the whole projection passes
// `redactDeep`, and the result is fitted to `maxEntryBytes`. Authorization
// handles (grant id, grant kind), prompts, native agent/session ids and
// controller state are deliberately absent: a restart cannot resume anything
// from this file, so nothing in it may look resumable.
//
// Two conditions are refusals rather than repairs:
//
//  * A document that is not valid JSON, or carries an unknown `schemaVersion`, is
//    refused and the file is left exactly as found. Later saves refuse too, so
//    nothing overwrites a document the operator may still want to inspect.
//  * A limit that cannot be met by evicting a terminal record is refused. A live
//    (pending/running) job is never silently dropped.
//
// On load, `pending`/`running` records become `interrupted` with
// `error.code = JOB_INTERRUPTED_RESTART`. They are never resubmitted, and the
// authorization that once covered them is not restored.

import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { redactDeep } from '../config/redact.js';
import { REVIEW_NOTE_MAX_CHARS, truncateCodePoints } from './review-note.js';

/** Persisted document format version. Unknown versions are refused, never migrated. */
const SCHEMA_VERSION = 1;

/** Document file name inside the plugin data directory. */
const HISTORY_FILE = 'history.json';

/** Default bounds. */
const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 200,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 256 * 1024,
});

/** Below this an entry cannot even carry an empty job record. */
const MIN_ENTRY_BYTES = 4096;

/** Room held back for the `truncation` block so fitting never overruns. */
const FIT_RESERVE = 512;

/** Appended to any string this module had to cut. */
const TRUNCATION_MARK = '… [truncated]';

const MAX_PATH_CHARS = 4096;
const MAX_LABEL_CHARS = 256;
const MAX_MESSAGE_CHARS = 4096;
const MAX_DETAIL_STRING_CHARS = 512;
const MAX_TEXT_CHARS = 64 * 1024;
const MAX_LIST_ITEMS = 500;
const MAX_DETAIL_KEYS = 32;
const MAX_DETAIL_DEPTH = 4;
const MAX_TRUNCATION_ITEMS = 12;
const MIN_DOCUMENT_BYTES = 64 * 1024;
const MAX_SAFE_TIMESTAMP = 8.64e15;

/** States this module understands. `interrupted` is produced only by history. */
const KNOWN_STATES = new Set(['pending', 'running', 'awaiting-host-review', 'failed', 'cancelled', 'interrupted']);

/** States that occupy a slot in the running engine and must never be evicted. */
const LIVE_STATES = new Set(['pending', 'running']);

/** Stable refusal codes. Each one means "nothing was written". */
export const HISTORY_CODES = Object.freeze({
  unreadable: 'HISTORY_UNREADABLE',
  fileTooLarge: 'HISTORY_FILE_TOO_LARGE',
  malformed: 'HISTORY_MALFORMED',
  schemaUnsupported: 'HISTORY_SCHEMA_UNSUPPORTED',
  viewInvalid: 'HISTORY_VIEW_INVALID',
  entryTooLarge: 'HISTORY_ENTRY_TOO_LARGE',
  limitExceeded: 'HISTORY_LIMIT_EXCEEDED',
  writeFailed: 'HISTORY_WRITE_FAILED',
  disposed: 'HISTORY_DISPOSED',
});

/** Windows rename races are transient: retry them briefly before refusing. */
const WINDOWS_TRANSIENT_RENAME = new Set(['EACCES', 'EBUSY', 'EPERM']);

/** Raised for every history refusal. `details` is bounded and secret-free. */
export class HistoryError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - operator-readable explanation.
   * @param {object} [details] - bounded, non-secret context.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
    this.details = details;
  }
}

/** Fields that may be long enough to need cutting to fit the entry budget. */
const TEXT_PATHS = [
  ['diff', 'patchText'],
  ['execution', 'text'],
  ['review', 'text'],
  ['error', 'message'],
  ['execution', 'error'],
  ['review', 'error', 'message'],
  ['reviewRouteError', 'message'],
];

/** Arrays that may be shrunk when an entry does not fit. */
const ARRAY_PATHS = [
  ['diff', 'files'],
  ['diff', 'changes'],
  ['diff', 'sensitivePaths'],
  ['baseline', 'preexistingPaths'],
  ['review', 'denials'],
  ['permission', 'evidence'],
  ['permission', 'pending', 'boundsApplied'],
  ['permission', 'pending', 'argumentKeys'],
];

/** Whole blocks dropped, in order, only when an entry still does not fit. */
const DROP_PATHS = [
  ['worktree'],
  ['baseline'],
  ['diff', 'changes'],
  ['diff', 'files'],
  ['diff', 'sensitivePaths'],
  ['review', 'denials'],
  ['execution', 'turnEnd'],
  ['review', 'selection'],
  ['effective', 'provenance'],
  ['permission', 'evidence'],
];

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * How many settled permission decisions one stored task record keeps.
 *
 * Small on purpose: this is human evidence ("what did the commander decide, and
 * why"), not an audit log, and an unbounded trail would let one noisy run push
 * every other field out of the entry budget.
 */
const MAX_PERMISSION_EVIDENCE = 8;

/**
 * How many distinct activity kinds one stored record keeps counts for.
 *
 * The live classifier owns a closed vocabulary far smaller than this, so the cap
 * only ever bounds a document written by a FUTURE build that learned more kinds —
 * a stored record must never be able to grow with model output, and the count map
 * is the one field keyed by something other than a fixed name.
 */
const MAX_ACTIVITY_KINDS = 24;

/**
 * One bounded, versioned job history document.
 *
 * Writes are serialized through an internal queue and land through a temp file
 * plus rename, so a concurrent save cannot lose an earlier one and a crash leaves
 * either the old or the new complete document. Each method returns detached data:
 * mutating a returned view cannot reach the stored document.
 */
export class HistoryStore {
  /**
   * @param {string} dataDir - plugin data directory.
   * @param {object} [options] - `maxEntries`, `maxBytes`, `maxEntryBytes`, and an
   *   optional test-only `fs` seam (`stat`, `readFile`, `writeFile`, `rename`,
   *   `mkdir`, `rm`).
   */
  constructor(dataDir, options = {}) {
    if (typeof dataDir !== 'string' || dataDir.trim() === '') {
      throw new TypeError('HistoryStore needs a data directory');
    }
    const limits = { ...DEFAULT_LIMITS };
    for (const key of Object.keys(DEFAULT_LIMITS)) {
      const value = options[key];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be a positive integer`);
      limits[key] = value;
    }
    if (limits.maxEntryBytes < MIN_ENTRY_BYTES) {
      throw new TypeError(`maxEntryBytes must be at least ${MIN_ENTRY_BYTES}`);
    }
    if (limits.maxBytes < limits.maxEntryBytes) {
      throw new TypeError('maxBytes must be at least maxEntryBytes');
    }

    this.dir = dataDir;
    this.path = join(dataDir, HISTORY_FILE);
    this.maxEntries = limits.maxEntries;
    this.maxBytes = limits.maxBytes;
    this.maxEntryBytes = limits.maxEntryBytes;
    // The document adds a small envelope plus one separator per entry; this read
    // bound leaves room for both and for a hand-edited file.
    this.maxDocumentBytes = Math.max(limits.maxBytes * 2, MIN_DOCUMENT_BYTES);
    this.fs = options.fs ?? nodeFs;

    this.jobs = null;
    this.loading = null;
    this.refusal = null;
    this.queue = Promise.resolve();
    this.disposed = false;
  }

  /**
   * Read the stored views, newest first.
   *
   * Idempotent: the first call reads and normalizes, later calls return detached
   * copies of the same data. A missing file is an empty history. A refused
   * document leaves the file untouched and makes every later call refuse alike.
   * @returns {Promise<object[]>} detached, redacted public views, newest first.
   */
  async load() {
    const jobs = await this.ensureLoaded();
    return jobs.slice().reverse().map((job) => structuredClone(job));
  }

  /**
   * Atomically upsert one public view by `taskId`.
   *
   * The view is projected and bounded before it reaches the document; limits are
   * enforced by evicting the oldest terminal record first. A live view is never
   * evicted, and a limit that cannot be met is refused with nothing written.
   * @param {object} view - public job view.
   * @returns {Promise<object>} detached copy of the stored entry.
   */
  async save(view) {
    if (this.disposed) throw this.disposedError();
    if (this.refusal !== null) this.throwIfRefused();
    let entry = projectView(view, this.maxEntryBytes, { rejectOversizeNote: true });
    const run = this.enqueue(async () => {
      this.throwIfRefused();
      const base = await this.ensureLoaded();
      const draft = base.map((job) => structuredClone(job));
      const index = draft.findIndex((job) => job.taskId === entry.taskId);
      if (index >= 0) {
        // A LIVE snapshot may never roll a TERMINAL record back. The engine writes a
        // checkpoint while a task waits for a decision, and that write can land after
        // the run has already finished (or been interrupted at load time). Losing that
        // race must not resurrect a finished task as `running`, so the terminal record
        // wins and the stale checkpoint is discarded instead of stored.
        if (isTerminal(draft[index].state) && !isTerminal(entry.state)) return structuredClone(draft[index]);
        // Inspect the current row INSIDE the write queue. A terminal snapshot can
        // have been captured before a review, then queued behind its slow write.
        const recorded = draft[index].hostAcceptance;
        if (recorded !== null && recorded !== undefined) {
          if (entry.hostAcceptance !== null && entry.hostAcceptance !== undefined
            && (entry.hostAcceptance.state !== recorded.state || entry.hostAcceptance.note !== recorded.note)) {
            throw new HistoryError(HISTORY_CODES.viewInvalid, 'a saved review cannot be replaced by a task snapshot', {
              taskId: entry.taskId,
            });
          }
          entry = projectView({ ...entry, hostAcceptance: recorded }, this.maxEntryBytes, { rejectOversizeNote: true });
        }
        draft[index] = entry;
      } else {
        draft.push(entry);
      }
      draft.sort(compareStored);
      const now = Date.now();
      this.enforceLimits(draft, entry.taskId, now);
      await this.writeDocument(draft, now);
      this.jobs = draft;
      return structuredClone(entry);
    });
    return await run;
  }

  /**
   * Atomically patch ONE stored record through a caller-supplied mutation.
   *
   * The stored row is the base, so a patch can add a conclusion without discarding the
   * execution evidence already on disk, and it runs on the same write queue as `save` so
   * two writes can never interleave. The mutation receives a detached copy of the CURRENT
   * row (re-read under the write) and returns the row to store; throwing refuses with the
   * caller's error and nothing is written.
   * @param {string} taskId - stored task id.
   * @param {(row: object) => object} mutate - mutation of the current stored row.
   * @returns {Promise<object>} detached copy of the stored entry.
   * @throws {HistoryError} `HISTORY_VIEW_INVALID` when this task has no stored row.
   */
  async update(taskId, mutate) {
    if (this.disposed) throw this.disposedError();
    if (this.refusal !== null) this.throwIfRefused();
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new HistoryError(HISTORY_CODES.viewInvalid, 'a job history update needs a taskId', {});
    }
    const run = this.enqueue(async () => {
      this.throwIfRefused();
      const base = await this.ensureLoaded();
      const index = base.findIndex((job) => job.taskId === taskId);
      if (index < 0) {
        throw new HistoryError(HISTORY_CODES.viewInvalid, 'no stored record exists for this task', { taskId });
      }
      const entry = projectView(await mutate(structuredClone(base[index])), this.maxEntryBytes, { rejectOversizeNote: true });
      if (entry.taskId !== taskId) {
        throw new HistoryError(HISTORY_CODES.viewInvalid, 'a history update may not change the task it patches', { taskId });
      }
      const draft = base.map((job) => structuredClone(job));
      draft[index] = entry;
      draft.sort(compareStored);
      const now = Date.now();
      this.enforceLimits(draft, entry.taskId, now);
      await this.writeDocument(draft, now);
      this.jobs = draft;
      return structuredClone(entry);
    });
    return await run;
  }

  /**
   * Wait for the in-flight read and every queued write to settle.
   * @returns {Promise<void>} resolves when the document is consistent.
   */
  async flush() {
    if (this.loading !== null) await this.loading.catch(() => undefined);
    await this.queue;
  }

  /**
   * Flush and refuse every later save.
   * @returns {Promise<void>} resolves after the last queued write lands.
   */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.flush();
  }

  /**
   * Run one mutation on the write queue. A rejected mutation settles the tail, so
   * one failed write does not poison every later save.
   * @param {() => Promise<object>} work - queued mutation.
   * @returns {Promise<object>} mutation result.
   */
  enqueue(work) {
    const run = this.queue.then(work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Share one physical read between concurrent callers.
   * @returns {Promise<object[]>} stored entries, ascending by creation time.
   */
  async ensureLoaded() {
    if (this.jobs !== null) return this.jobs;
    if (this.refusal !== null) this.throwIfRefused();
    if (this.loading === null) {
      this.loading = this.readOnce().finally(() => { this.loading = null; });
    }
    return await this.loading;
  }

  /**
   * Perform the single physical read, normalize interrupted jobs, and persist the
   * normalization when the document changed.
   * @returns {Promise<object[]>} stored entries, ascending by creation time.
   */
  async readOnce() {
    let info;
    try {
      info = await this.fs.stat(this.path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.jobs = [];
        return this.jobs;
      }
      throw this.refuse(HISTORY_CODES.unreadable, 'the job history document could not be inspected', {
        cause: typeof error?.code === 'string' ? error.code : 'unknown',
      });
    }
    if (typeof info?.isFile === 'function' && !info.isFile()) {
      throw this.refuse(HISTORY_CODES.unreadable, 'the job history path is not a regular file', {});
    }
    if (Number.isFinite(info?.size) && info.size > this.maxDocumentBytes) {
      throw this.refuse(HISTORY_CODES.fileTooLarge, 'the job history document exceeds the readable bound', {
        bytes: info.size,
        limit: this.maxDocumentBytes,
      });
    }

    let raw;
    try {
      raw = await this.fs.readFile(this.path, 'utf8');
    } catch (error) {
      throw this.refuse(HISTORY_CODES.unreadable, 'the job history document could not be read', {
        cause: typeof error?.code === 'string' ? error.code : 'unknown',
      });
    }
    if (Buffer.byteLength(raw, 'utf8') > this.maxDocumentBytes) {
      throw this.refuse(HISTORY_CODES.fileTooLarge, 'the job history document exceeds the readable bound', {
        limit: this.maxDocumentBytes,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw this.refuse(HISTORY_CODES.malformed, 'the job history document is not valid JSON', {});
    }
    if (!isPlainObject(parsed)) {
      throw this.refuse(HISTORY_CODES.malformed, 'the job history document is not a JSON object', {});
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      throw this.refuse(
        HISTORY_CODES.schemaUnsupported,
        'the job history document uses a schemaVersion this release does not support',
        { schemaVersion: Number.isSafeInteger(parsed.schemaVersion) ? parsed.schemaVersion : 'unknown' },
      );
    }
    if (!Array.isArray(parsed.jobs)) {
      throw this.refuse(HISTORY_CODES.malformed, 'the job history document has no jobs array', {});
    }

    const stored = parsed.jobs;
    const projected = [];
    for (let index = 0; index < stored.length; index += 1) {
      try {
        projected.push(projectView(stored[index], this.maxEntryBytes));
      } catch (error) {
        // A record that cannot be projected is not repaired by guessing: the whole
        // document is refused, because dropping one record silently loses evidence.
        throw this.refuse(HISTORY_CODES.malformed, 'the job history document contains an unusable job record', {
          index,
          reason: error?.code === HISTORY_CODES.viewInvalid ? 'invalid view' : 'not an object',
        });
      }
    }

    const now = Date.now();
    const normalized = projected.map((entry) => markInterrupted(entry, now)).sort(compareStored);

    if (JSON.stringify(stored) !== JSON.stringify(normalized)) {
      // Persist the normalization before claiming it: a later restart must not
      // report the same live jobs again. A failed write is not cached, so a later
      // load retries the read instead of refusing forever.
      await this.writeDocument(normalized, now);
    }
    this.jobs = normalized;
    return this.jobs;
  }

  /**
   * Replace the document atomically: write a random sibling, then rename over the
   * target. A crash leaves either the old or the new complete document, and a
   * failed write removes its temp file.
   * @param {object[]} jobs - entries, ascending.
   * @param {number} now - update stamp.
   * @returns {Promise<void>} resolves after the rename.
   */
  async writeDocument(jobs, now) {
    const content = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, updatedAt: now, jobs })}\n`;
    const temp = `${this.path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await this.fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await this.fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' });
      await renameWithRetry(this.fs, temp, this.path);
    } catch (error) {
      await this.fs.rm(temp, { force: true }).catch(() => undefined);
      throw new HistoryError(HISTORY_CODES.writeFailed, 'the job history document could not be written', {
        cause: typeof error?.code === 'string' ? error.code : 'unknown',
      });
    }
  }

  /**
   * Enforce `maxEntries` and `maxBytes` on a draft by evicting the oldest terminal
   * record first. The entry just saved is protected, so a save never discards
   * itself silently. Nothing is written when no safe eviction exists.
   * @param {object[]} draft - mutable entry list, ascending.
   * @param {string} protectedId - id of the entry just upserted.
   * @param {number} now - update stamp used for exact byte accounting.
   * @returns {void}
   * @throws {HistoryError} when the bounds cannot be met without dropping a live view.
   */
  enforceLimits(draft, protectedId, now) {
    const slots = draft.map((job) => ({ job, bytes: byteLength(JSON.stringify(job)) }));
    let sum = slots.reduce((total, slot) => total + slot.bytes, 0);
    const envelope = byteLength(JSON.stringify({ schemaVersion: SCHEMA_VERSION, updatedAt: now, jobs: [] }));
    // `jobs: []` contributes two bracket bytes; the real document spends one
    // separator byte between each pair of entries instead.
    const documentBytes = () => envelope - 2 + sum + Math.max(0, slots.length - 1);

    while (slots.length > this.maxEntries || documentBytes() > this.maxBytes) {
      const chosen = slots
        .map((slot) => slot.job)
        .filter((job) => isTerminal(job.state) && job.taskId !== protectedId)
        .sort(compareOldestFirst)[0] ?? null;
      if (chosen === null) {
        throw new HistoryError(
          HISTORY_CODES.limitExceeded,
          'the job history bounds cannot be met without dropping a live job',
          { entries: slots.length, limit: this.maxEntries, bytes: documentBytes(), byteLimit: this.maxBytes },
        );
      }
      const index = slots.findIndex((slot) => slot.job === chosen);
      sum -= slots[index].bytes;
      slots.splice(index, 1);
    }

    draft.length = 0;
    for (const slot of slots) draft.push(slot.job);
  }

  /**
   * Record a refusal and return it, so the caller can `throw`.
   * @param {string} code - refusal code.
   * @param {string} message - explanation.
   * @param {object} details - bounded, non-secret context.
   * @returns {HistoryError} the refusal.
   */
  refuse(code, message, details) {
    const refusal = this.refusal ?? { code, message, details };
    this.refusal = refusal;
    return new HistoryError(refusal.code, refusal.message, { ...refusal.details });
  }

  /**
   * Re-throw a cached refusal, if the document was refused earlier.
   * @returns {void}
   * @throws {HistoryError} the original refusal.
   */
  throwIfRefused() {
    if (this.refusal === null) return;
    throw new HistoryError(this.refusal.code, this.refusal.message, { ...this.refusal.details });
  }

  /** @returns {HistoryError} the refusal used once the store is disposed. */
  disposedError() {
    return new HistoryError(HISTORY_CODES.disposed, 'the job history store has been disposed', {});
  }
}

/**
 * Project one public job view onto the stored field set.
 *
 * Every nested block is rebuilt from an allow-list, so a caller cannot add a
 * field, a credential or a native handle by widening its own object.
 * @param {object} view - public job view.
 * @param {number} maxEntryBytes - per-entry byte budget.
 * @param {{ rejectOversizeNote?: boolean }} [options] - `rejectOversizeNote` refuses an
 *   oversized review note instead of cutting it (writes); a load keeps the cut.
 * @returns {object} bounded, redacted entry.
 * @throws {HistoryError} when the view, or the note under `rejectOversizeNote`, is invalid.
 */
function projectView(view, maxEntryBytes, options = {}) {
  if (!isPlainObject(view)) {
    throw new HistoryError(HISTORY_CODES.viewInvalid, 'a job history view must be an object', {});
  }
  const taskId = typeof view.taskId === 'string' ? view.taskId.trim() : '';
  if (taskId === '' || taskId.length > MAX_LABEL_CHARS) {
    throw new HistoryError(HISTORY_CODES.viewInvalid, 'a job history view needs a bounded taskId', {});
  }
  if (!KNOWN_STATES.has(view.state)) {
    throw new HistoryError(HISTORY_CODES.viewInvalid, 'a job history view needs a known state', {});
  }

  const ctx = newCutContext(view.truncation, maxEntryBytes);
  const acceptance = acceptanceView(view.hostAcceptance, ctx, { rejectOversize: options.rejectOversizeNote === true });
  const entry = {
    taskId,
    state: view.state,
    phase: label(view.phase),
    createdAt: time(view.createdAt),
    startedAt: time(view.startedAt),
    endedAt: time(view.endedAt),
    sourcePath: path(view.sourcePath, ctx, 'sourcePath'),
    workspacePath: path(view.workspacePath, ctx, 'workspacePath'),
    executionWorkspacePath: path(view.executionWorkspacePath, ctx, 'executionWorkspacePath'),
    isolation: knownValue(view.isolation, ['worktree', 'shared']),
    interruptedFrom: knownValue(view.interruptedFrom, ['pending', 'running']),
    // The connection identity is provenance: which external connection asked for
    // the work. Grant id and grant kind are authorization state and are not
    // stored, so a restart cannot be mistaken for a still-valid grant.
    connectionId: label(view.connectionId),
    effective: effectiveView(view.effective),
    route: selectionView(view.route),
    reviewRoute: selectionView(view.reviewRoute),
    reviewRouteError: errorView(view.reviewRouteError, ctx),
    worktree: worktreeView(view.worktree),
    baseline: baselineView(view.baseline, ctx),
    diff: diffView(view.diff, ctx),
    execution: executionView(view.execution, ctx),
    review: reviewView(view.review, ctx),
    // The per-call permission evidence. Persisted so a restart can show WHY a call
    // was allowed or refused, and so an interrupted wait is visible as history
    // instead of vanishing. Every field is re-projected here from an allow-list and
    // then re-redacted, so a stored record inherits the same masking the live view
    // had — including key-aware masking of anything credential-named.
    permission: permissionView(view.permission, ctx),
    // The bounded progress summary. Stored so a restart can show what the run was
    // doing when it stopped and how much activity it had — and stored through the
    // same allow-list discipline as everything else, so no model text, reasoning,
    // tool argument or diff can enter through it. `waitingOn` is what lets an
    // interrupted record say "it was waiting on a tool call", which is the same
    // fact as `permission.interrupted` for a paused approval but is a different
    // story for an ordinary long-running command.
    activity: activityView(view.activity),
    error: errorView(view.error, ctx),
    cancelledBy: label(view.cancelledBy),
    hostAcceptance: acceptance,
    // A completed job is not an accepted one. This is fixed, never copied.
    selfApproved: false,
  };

  // A live state is normalized to `interrupted` by `markInterrupted` on the next
  // load, which also closes its outstanding permission request. A terminal record
  // never passes through that path, so its permission block must be closed HERE:
  // the process that could decide the request is gone as soon as this record is
  // durable, and a stored `pending` would otherwise remain apparently decidable
  // forever. Keep the terminal task state untouched; only the request becomes
  // history. `decidedBy: 'restart'` is the existing public vocabulary for this
  // normalization and covers both crash recovery and terminal-record projection.
  if (!LIVE_STATES.has(entry.state)) markPermissionInterrupted(entry);

  const redacted = redactDeep(entry);
  fitEntry(redacted, ctx);
  // Markers recorded by an earlier projection are carried forward, so fitting an
  // already-fitted entry is a no-op and a reload never rewrites the file.
  const truncation = cutView(ctx);
  if (truncation !== null) redacted.truncation = truncation;
  return redacted;
}

/**
 * Mark a job that was live when the process stopped as history-only
 * `interrupted`. Finished states and their actual metadata are preserved.
 * @param {object} entry - projected entry.
 * @param {number} now - load time, used when the record never recorded an end.
 * @returns {object} the same entry, updated in place.
 */
function markInterrupted(entry, now) {
  if (!LIVE_STATES.has(entry.state)) return entry;
  entry.interruptedFrom = entry.state;
  entry.state = 'interrupted';
  entry.phase = 'interrupted';
  entry.endedAt = entry.endedAt ?? now;
  entry.error = {
    code: 'JOB_INTERRUPTED_RESTART',
    message: 'the job was still live when the plugin restarted; it was not resubmitted',
    details: { previousState: entry.interruptedFrom },
  };
  // A permission wait that was open when the process stopped is part of the same
  // fact: the request is history only and can never be decided or replayed.
  markPermissionInterrupted(entry);
  // The same for the activity summary: a span that was still open is closed here,
  // so a restart reports "interrupted while a tool was running" instead of an idle
  // duration that keeps growing for a run nobody is watching.
  markActivityInterrupted(entry);
  return entry;
}

/** @returns {object | null} bounded effective-configuration snapshot. */
function effectiveView(value) {
  if (!isPlainObject(value)) return null;
  const worker = isPlainObject(value.worker) ? value.worker : {};
  const review = isPlainObject(value.review) ? value.review : {};
  const provenance = isPlainObject(value.provenance) ? value.provenance : {};
  return {
    worker: {
      providerId: label(worker.providerId),
      model: label(worker.model),
      reasoningEffort: label(worker.reasoningEffort),
      timeoutSeconds: count(worker.timeoutSeconds),
      maxParallelism: count(worker.maxParallelism),
      isolation: knownValue(worker.isolation, ['worktree', 'shared']),
    },
    review: {
      enabled: review.enabled === true,
      providerId: label(review.providerId),
      model: label(review.model),
      reasoningEffort: label(review.reasoningEffort),
    },
    // The conversation policy the task was frozen with (a rule, not a stored
    // setting) plus, in `value.conversation` below, what the run actually did. No
    // session id is stored here, so history is not a way back into a conversation.
    conversation: isPlainObject(value.conversation)
      ? { policy: label(value.conversation.policy) }
      : null,
    // The silence thresholds this task froze at admission. Stored because they are
    // the only way a stored activity block can be interpreted: "idle for 12 minutes"
    // means something different under a 10-minute attention threshold than under a
    // two-hour one, and the live settings may have changed since.
    monitoring: isPlainObject(value.monitoring)
      ? {
        selfCheckSeconds: count(value.monitoring.selfCheckSeconds),
        attentionSeconds: count(value.monitoring.attentionSeconds),
        repeatFailureThreshold: count(value.monitoring.repeatFailureThreshold),
      }
      : null,
    provenance: {
      projectPath: path(provenance.projectPath),
      projectKey: path(provenance.projectKey),
      applied: stringList(provenance.applied),
    },
  };
}

/** @returns {object | null} bounded model-selection summary. */
function selectionView(value) {
  if (!isPlainObject(value)) return null;
  return {
    providerId: label(value.providerId),
    providerRoute: label(value.providerRoute),
    model: label(value.model),
    reasoningEffort: label(value.reasoningEffort),
  };
}

/** @returns {object | null} bounded worktree metadata. */
function worktreeView(value) {
  if (!isPlainObject(value)) return null;
  return {
    taskId: label(value.taskId),
    workspacePath: path(value.workspacePath),
    sourcePath: path(value.sourcePath),
    baseHead: label(value.baseHead),
    isolated: value.isolated === true,
    detached: value.detached === true,
    state: label(value.state),
    createdAt: time(value.createdAt),
    completedAt: time(value.completedAt),
    sourcePreexistingChanges: count(value.sourcePreexistingChanges),
    disposable: value.disposable === true,
  };
}

/** @returns {object | null} bounded audit baseline. */
function baselineView(value, ctx) {
  if (!isPlainObject(value)) return null;
  return {
    head: label(value.head),
    dirtyBaseline: value.dirtyBaseline === true,
    preexistingChanges: count(value.preexistingChanges),
    preexistingPaths: pathList(value.preexistingPaths, ctx, 'baseline.preexistingPaths'),
    statusTruncated: value.statusTruncated === true,
    statusFormat: label(value.statusFormat),
    capturedAt: time(value.capturedAt),
  };
}

/** @returns {object | null} bounded change evidence. */
function diffView(value, ctx) {
  if (!isPlainObject(value)) return null;
  const files = [];
  const fileTotal = Array.isArray(value.files) ? value.files.length : 0;
  if (Array.isArray(value.files)) {
    for (const item of value.files.slice(0, MAX_LIST_ITEMS)) {
      if (isPlainObject(item)) {
        files.push({ code: label(item.code), path: path(item.path), from: path(item.from) });
      } else {
        files.push({ code: null, path: path(item), from: null });
      }
    }
  }
  const changes = [];
  if (Array.isArray(value.changes)) {
    for (const item of value.changes.slice(0, MAX_LIST_ITEMS)) {
      if (!isPlainObject(item)) continue;
      changes.push({
        added: count(item.added),
        removed: count(item.removed),
        path: path(item.path),
        from: path(item.from),
      });
    }
  }
  return {
    head: label(value.head),
    baseHead: label(value.baseHead),
    dirtyBaseline: value.dirtyBaseline === true,
    preexistingChanges: count(value.preexistingChanges),
    files,
    fileCount: count(value.fileCount),
    truncatedFiles: value.truncatedFiles === true || fileTotal > files.length,
    changes,
    // Paths stay visible; their content was excluded before the diff ran.
    sensitivePaths: pathList(value.sensitivePaths, ctx, 'diff.sensitivePaths'),
    sensitiveTouchedCount: count(value.sensitiveTouchedCount),
    sensitiveContentWithheld: value.sensitiveContentWithheld !== false,
    patchWithheld: value.patchWithheld === true,
    patchText: text(value.patchText, ctx, 'diff.patchText'),
    patchTruncated: value.patchTruncated === true,
    patchBytes: count(value.patchBytes),
    capturedAt: time(value.capturedAt),
    error: errorView(value.error, ctx),
  };
}

/**
 * @returns {object | null} bounded execution record. Native agent and session ids
 *   are dropped: this module stores outcomes, never a way back into a run. The
 *   `conversation` block is the exception and is deliberately narrow — it carries
 *   the mode that was frozen for the task, whether a conversation was continued,
 *   and the Workspace id the run was grouped in. It never carries the session id,
 *   so a restart cannot resume a conversation from this file.
 */
function executionView(value, ctx) {
  if (!isPlainObject(value)) return null;
  return {
    workspacePath: path(value.workspacePath),
    outcome: label(value.outcome),
    text: text(value.text, ctx, 'execution.text'),
    reasoningOnly: value.reasoningOnly === true,
    textTruncated: value.textTruncated === true,
    usage: usageView(value.usage),
    turnEnd: isPlainObject(value.turnEnd) ? { reason: label(value.turnEnd.reason) } : null,
    conversation: conversationView(value.conversation),
    cancelCause: label(value.cancelCause),
    error: typeof value.error === 'string'
      ? text(value.error, ctx, 'execution.error', MAX_MESSAGE_CHARS)
      : errorView(value.error, ctx),
  };
}

/**
 * @returns {object | null} bounded conversation placement. `sessionId` and every
 *   other resumable handle is absent on purpose: the durable job history must not be
 *   a second way into a conversation. `kind`/`continuedFromTaskId` state whether the
 *   run started a new thread or continued the task it named.
 */
function conversationView(value) {
  if (!isPlainObject(value)) return null;
  return {
    kind: knownValue(value.kind, ['new', 'continuation']),
    continuedFromTaskId: label(value.continuedFromTaskId),
    reused: value.reused === true,
    workspaceId: label(value.workspaceId),
    workspacePath: path(value.workspacePath),
    workspaceCreated: value.workspaceCreated === true,
    sessionCreated: value.sessionCreated === true,
  };
}

/**
 * @returns {object | null} usage counters. Only finite non-negative numbers are
 *   kept; `redactDeep` masks any counter-named field that is not one.
 */
function usageView(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const key of [
    'inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens',
    'cacheTokens', 'cacheReadTokens', 'cacheWriteTokens',
  ]) {
    if (value[key] === undefined) continue;
    const number = count(value[key]);
    if (number !== null) setOwn(out, key, number);
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** @returns {object | null} bounded additional-review outcome. */
function reviewView(value, ctx) {
  if (!isPlainObject(value)) return null;
  return {
    state: label(value.state),
    verdict: isPlainObject(value.verdict)
      ? { verdict: label(value.verdict.verdict), reason: text(value.verdict.reason, ctx, 'review.verdict.reason') }
      : null,
    text: text(value.text, ctx, 'review.text'),
    error: errorView(value.error, ctx),
    selection: selectionView(value.selection),
    denials: stringList(value.denials, ctx, 'review.denials'),
    denialsDelivered: count(value.denialsDelivered),
  };
}

/**
 * Bounded projection of one per-call permission request.
 *
 * The allow-list is deliberate and narrow: identifiers, the redacted argument
 * rendering, the completeness facts, the timestamps, and the decision evidence.
 * What is NOT stored: the exact private fingerprint (it binds one live call and is
 * meaningless after a restart, where the call it named is gone), the exact argument
 * text, and the internal timer/signal handles. A restarted record therefore cannot
 * be used to replay or re-authorise anything — it is evidence, not a capability.
 * @param {unknown} value - one pending or settled permission view.
 * @param {object} ctx - cut context.
 * @param {string} field - path prefix for truncation markers.
 * @returns {object | null} bounded copy.
 */
function permissionEntryView(value, ctx, field) {
  if (!isPlainObject(value)) return null;
  const access = isPlainObject(value.requestedAccess) ? value.requestedAccess : {};
  const verified = isPlainObject(value.verified) ? value.verified : null;
  const grant = isPlainObject(value.grant) ? value.grant : null;
  return {
    requestId: label(value.requestId),
    taskId: label(value.taskId),
    sessionId: label(value.sessionId),
    toolName: label(value.toolName),
    callId: label(value.callId),
    turn: count(value.turn),
    step: count(value.step),
    state: label(value.state),
    // The asker's own claim, still labelled as one.
    reason: label(value.reason),
    reasonSource: label(value.reasonSource),
    requestedAccess: { kind: label(access.kind), mode: label(access.mode) },
    argumentKeys: stringList(value.argumentKeys, ctx, `${field}.argumentKeys`),
    // The redacted, bounded rendering of the real arguments. Already redacted by the
    // bridge; `redactDeep` runs again over the whole entry below, so a stored record
    // is masked twice rather than trusted once.
    arguments: text(value.arguments, ctx, `${field}.arguments`, MAX_DETAIL_STRING_CHARS * 8),
    argumentsRedacted: value.argumentsRedacted === true,
    completeness: label(value.completeness),
    argumentsComplete: value.argumentsComplete === true,
    boundsApplied: stringList(value.boundsApplied, ctx, `${field}.boundsApplied`),
    omitted: isPlainObject(value.omitted)
      ? {
        valueChars: count(value.omitted.valueChars),
        keys: count(value.omitted.keys),
        depth: count(value.omitted.depth),
        items: count(value.omitted.items),
      }
      : null,
    allowBlocked: label(value.allowBlocked),
    createdAt: time(value.createdAt),
    deadlineAt: time(value.deadlineAt),
    decision: label(value.decision),
    decidedAt: time(value.decidedAt),
    decidedBy: label(value.decidedBy),
    decisionReason: label(value.decisionReason),
    outcome: label(value.outcome),
    verified: verified === null
      ? null
      : {
        fingerprintQuoted: verified.fingerprintQuoted === true,
        argumentsComplete: verified.argumentsComplete === true,
        callReread: verified.callReread === true,
        turnOpen: verified.turnOpen === true,
        boundsApplied: stringList(verified.boundsApplied, ctx, `${field}.verified.boundsApplied`),
      },
    grant: grant === null
      ? null
      : {
        kind: label(grant.kind),
        appliesTo: label(grant.appliesTo),
        callId: label(grant.callId),
        reusable: grant.reusable === true,
      },
    standingModeUnchanged: value.standingModeUnchanged === true,
  };
}

/**
 * Bounded projection of a task's whole permission block.
 *
 * The settled trail is stored oldest-last-first and cut to a small bound, because
 * it is evidence an operator reads rather than machine state. `pending` is stored
 * too: after a restart it is what proves the task was WAITING when the process
 * stopped, and it is written with the same allow-list, so it cannot be replayed.
 * @param {unknown} value - task `permission` block.
 * @param {object} ctx - cut context.
 * @returns {object | null} bounded copy.
 */
function permissionView(value, ctx) {
  if (!isPlainObject(value)) return null;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const pending = permissionEntryView(value.pending, ctx, 'permission.pending');
  return {
    bridged: value.bridged === true,
    waiting: value.waiting === true,
    pending,
    evidence: evidence
      .slice(-MAX_PERMISSION_EVIDENCE)
      .map((entry, index) => permissionEntryView(entry, ctx, `permission.evidence[${index}]`))
      .filter((entry) => entry !== null),
    pausedExecutionMs: count(value.pausedExecutionMs),
    standingSandboxMode: label(value.standingSandboxMode),
    grantScope: label(value.grantScope),
  };
}

/**
 * Mark a live task's outstanding request as interrupted on load.
 *
 * A request that was pending when the process stopped can never be decided: the
 * bridge, the Agent and the paused native tool call all died with the process, and
 * `markInterrupted` has already made the task non-live. This rewrites only the
 * PENDING record so the stored history says "this wait did not survive", instead of
 * leaving a record a reader could mistake for a still-decidable request.
 * @param {object} entry - projected entry.
 * @returns {object} the same entry.
 */
function markPermissionInterrupted(entry) {
  const permission = entry?.permission;
  if (!isPlainObject(permission)) return entry;
  const pending = permission.pending;
  if (!isPlainObject(pending)) {
    if (permission.waiting === true) permission.waiting = false;
    return entry;
  }
  // Already normalized to "cannot be decided" (a checkpoint that was written before
  // the terminal record, or a re-load of one): state the interrupt fact as well, so
  // every interrupted record says the same thing regardless of which write produced it.
  if (pending.state !== 'pending') {
    permission.waiting = false;
    permission.interrupted = true;
    return entry;
  }
  pending.state = 'unavailable';
  pending.outcome = 'unavailable';
  pending.decidedBy = 'restart';
  pending.decidedAt = entry.endedAt ?? pending.decidedAt ?? null;
  pending.decisionReason = 'the process stopped while this request was pending; it cannot be decided and was not replayed';
  pending.allowBlocked = 'the process stopped while this request was pending';
  permission.waiting = false;
  permission.interrupted = true;
  return entry;
}

/**
 * Bounded projection of one task's activity summary.
 *
 * Every field is a count, a timestamp or an identifier. The tool name and call id
 * are identifiers the native session log already carries; the argument text and
 * result body are NOT reachable from here because the live summary never holds
 * them. `kinds` is rebuilt from a closed key allow-list rather than copied, so a
 * widened live shape cannot smuggle a new field into the document.
 * @param {unknown} value - task `activity` block.
 * @returns {object | null} bounded copy, or null when the task never ran.
 */
function activityView(value) {
  if (!isPlainObject(value)) return null;
  const tool = isPlainObject(value.currentTool) ? value.currentTool : null;
  const lastTool = isPlainObject(value.lastTool) ? value.lastTool : null;
  const selfCheck = isPlainObject(value.selfCheck) ? value.selfCheck : null;
  const kinds = {};
  if (isPlainObject(value.kinds)) {
    for (const [key, countValue] of Object.entries(value.kinds).slice(0, MAX_ACTIVITY_KINDS)) {
      const number = count(countValue);
      if (number === null) continue;
      if (key.length === 0 || key.length > MAX_LABEL_CHARS) continue;
      setOwn(kinds, key, number);
    }
  }
  return {
    lastActivityAt: time(value.lastActivityAt),
    // The idle span and what the run was doing during it. `waitingOn: 'tool'` is
    // the one case where a long span is WORK rather than silence, and recording it
    // is what stops a restarted record from describing a build as a stall.
    idleForMs: count(value.idleForMs),
    waitingOn: knownValue(value.waitingOn, ['idle', 'tool']),
    currentTool: tool === null
      ? null
      : {
        name: label(tool.name),
        callId: label(tool.callId),
        startedAt: time(tool.startedAt),
        elapsedMs: count(tool.elapsedMs),
      },
    lastTool: lastTool === null
      ? null
      : { name: label(lastTool.name), durationMs: count(lastTool.durationMs) },
    events: count(value.events),
    activityEvents: count(value.activityEvents),
    toolCallsStarted: count(value.toolCallsStarted),
    toolCallsFinished: count(value.toolCallsFinished),
    selfCheckSeconds: count(value.selfCheckSeconds),
    attentionSeconds: count(value.attentionSeconds),
    // Present when the elapsed values were frozen at the run's end, so a reader can
    // tell a final span from one still being measured.
    finalizedAt: time(value.finalizedAt),
    selfCheck: selfCheck === null
      ? null
      : {
        episode: count(selfCheck.episode),
        checkedAt: time(selfCheck.checkedAt),
        verdict: label(selfCheck.verdict),
      },
    // A stored record whose run was interrupted while a tool was in flight keeps the
    // cut-off call as evidence instead of dropping it.
    ...(isPlainObject(value.interruptedTool)
      ? {
        interruptedTool: {
          name: label(value.interruptedTool.name),
          callId: label(value.interruptedTool.callId),
          startedAt: time(value.interruptedTool.startedAt),
          elapsedMs: count(value.interruptedTool.elapsedMs),
        },
      }
      : {}),
    kinds,
    // The repeated-failure reminder as bounded evidence: a tool NAME, a failure CODE,
    // an operation digest and counts. No arguments, no output, no error prose — the
    // live monitor already reduced it to that, and this keeps the same shape.
    repeatFailure: repeatFailureOf(value.repeatFailure),
  };
}

/**
 * Project a stored `repeatFailure` block, dropping anything but the bounded facts.
 * @param {unknown} value - candidate block.
 * @returns {object | null} projection.
 */
function repeatFailureOf(value) {
  if (!isPlainObject(value)) return null;
  const reported = Array.isArray(value.reported) ? value.reported : [];
  return {
    threshold: count(value.threshold),
    reported: reported.filter(isPlainObject).slice(0, 32).map((entry) => ({
      kind: label(entry.kind),
      toolName: label(entry.toolName),
      failureCode: label(entry.failureCode),
      operationDigest: label(entry.operationDigest),
      consecutive: count(entry.consecutive),
      threshold: count(entry.threshold),
      firstSeenAt: time(entry.firstSeenAt),
      lastSeenAt: time(entry.lastSeenAt),
    })),
  };
}

/**
 * Mark a live task's activity summary as belonging to an interrupted run.
 *
 * `markInterrupted` already rewrote the state; this makes the silence describe what
 * it actually was, so a restarted record cannot present a tool that was mid-flight
 * as "idle for four hours". The span is closed at the recorded end time and the
 * outstanding tool call is marked cut off rather than deleted — it is evidence that
 * something was running when the process stopped.
 * @param {object} entry - projected entry.
 * @returns {object} the same entry.
 */
function markActivityInterrupted(entry) {
  const activity = entry?.activity;
  if (!isPlainObject(activity)) return entry;
  if (isPlainObject(activity.currentTool)) {
    activity.interruptedTool = { ...activity.currentTool };
  }
  activity.currentTool = null;
  activity.waitingOn = null;
  activity.idleForMs = null;
  activity.interrupted = true;
  return entry;
}

/**
 * Bounded error record.
 * @param {unknown} value - error value.
 * @param {object} ctx - cut context.
 * @returns {object | null} bounded error record.
 */
function errorView(value, ctx) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return { code: null, message: text(value, ctx, 'error.message', MAX_MESSAGE_CHARS), details: null };
  }
  if (!isPlainObject(value)) return null;
  return {
    code: label(value.code),
    message: text(value.message, ctx, 'error.message', MAX_MESSAGE_CHARS),
    details: boundedDetails(value.details, ctx, 'error.details', 0),
  };
}

/**
 * Bounded host-acceptance record.
 *
 * A recorded conclusion is free prose, so `label()` (256 characters) is the wrong rule for
 * its note: that silently dropped most of a longer conclusion. A note within the shared
 * code-point bound is kept exactly as written and REFUSED here when it is longer, so a
 * caller can never be told a shortened conclusion was saved; a document already carrying
 * more than the bound keeps read-compatible behaviour.
 * @param {unknown} value - host-acceptance value.
 * @param {object} ctx - cut context.
 * @param {{ rejectOversize?: boolean }} [options] - `rejectOversize` refuses instead of cutting.
 * @returns {object | null} bounded host-acceptance record.
 * @throws {HistoryError} `HISTORY_VIEW_INVALID` when the note exceeds the bound and
 *   `rejectOversize` is set.
 */
function acceptanceView(value, ctx, options = {}) {
  if (!isPlainObject(value)) return null;
  const note = options.rejectOversize === true ? requireNote(value.note) : noteText(value.note, ctx);
  return {
    accepted: value.accepted === true,
    state: label(value.state),
    acceptedAt: time(value.acceptedAt),
    by: label(value.by),
    note,
    noteChars: typeof value.note === 'string' ? Array.from(value.note).length : null,
  };
}

/**
 * Validate an incoming note against the shared bound, refusing rather than cutting.
 * @param {unknown} value - note.
 * @returns {string | null} the note as given, or null when there is none.
 * @throws {HistoryError} `HISTORY_VIEW_INVALID` with the actual length and the limit.
 */
function requireNote(value) {
  if (typeof value !== 'string' || value === '') return null;
  const length = Array.from(value).length;
  if (length > REVIEW_NOTE_MAX_CHARS) {
    throw new HistoryError(
      HISTORY_CODES.viewInvalid,
      `hostAcceptance.note must be at most ${REVIEW_NOTE_MAX_CHARS} Unicode code points, but it is ${length}`,
      { field: 'hostAcceptance.note', limit: REVIEW_NOTE_MAX_CHARS, length, unit: 'unicode-code-points' },
    );
  }
  return value;
}

/**
 * Keep a stored review note as written, cutting only a value beyond the accepted bound and
 * stating that cut.
 * @param {unknown} value - note.
 * @param {object} ctx - cut context.
 * @returns {string | null} the note, or null when there is none.
 */
function noteText(value, ctx) {
  if (typeof value !== 'string' || value === '') return null;
  const bounded = truncateCodePoints(value, REVIEW_NOTE_MAX_CHARS);
  if (bounded !== value) {
    ctx.fields.add('hostAcceptance.note');
    return `${bounded}${TRUNCATION_MARK}`;
  }
  return value;
}

/**
 * Bound an open-ended detail object by shape, not by name: depth, key count and
 * string size. `redactDeep` still masks every secret-named key inside it.
 * @param {unknown} value - detail value.
 * @param {object} ctx - cut context.
 * @param {string} field - field label for the truncation marker.
 * @param {number} depth - current depth.
 * @returns {unknown} bounded copy.
 */
function boundedDetails(value, ctx, field, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return text(value, ctx, field, MAX_DETAIL_STRING_CHARS);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= MAX_DETAIL_DEPTH) {
    ctx.fields.add(field);
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DETAIL_KEYS) ctx.fields.add(field);
    return value.slice(0, MAX_DETAIL_KEYS).map((item) => boundedDetails(item, ctx, field, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    const entries = Object.entries(value);
    if (entries.length > MAX_DETAIL_KEYS) ctx.fields.add(field);
    for (const [key, item] of entries.slice(0, MAX_DETAIL_KEYS)) {
      if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) continue;
      setOwn(out, key, boundedDetails(item, ctx, `${field}.${key}`, depth + 1));
    }
    return out;
  }
  return null;
}

/**
 * Fit one entry into `maxEntryBytes`.
 *
 * Free text is halved first, then long arrays, then optional blocks; each cut is
 * recorded, so a consumer can see that evidence was reduced instead of receiving
 * a silently short record. Only when nothing more can be cut is the entry refused.
 * @param {object} entry - mutable entry.
 * @param {object} ctx - cut context.
 * @returns {void}
 * @throws {HistoryError} when the entry cannot be bounded.
 */
function fitEntry(entry, ctx) {
  const budget = ctx.maxEntryBytes - FIT_RESERVE;
  let size = byteLength(JSON.stringify(entry));
  for (let guard = 0; guard < 200 && size > budget; guard += 1) {
    if (!cutLargestText(entry, ctx) && !cutLargestArray(entry, ctx) && !dropBlock(entry, ctx)) break;
    size = byteLength(JSON.stringify(entry));
  }
  if (size > budget) {
    throw new HistoryError(
      HISTORY_CODES.entryTooLarge,
      'the job history view cannot be bounded to the configured entry budget',
      { bytes: size, limit: ctx.maxEntryBytes },
    );
  }
}

/**
 * Halve the longest remaining free-text field.
 *
 * The recorded host review is NOT in {@link TEXT_PATHS}: an accepted conclusion is the most
 * valuable prose in the entry, so a large diff or a long worker output is reduced first,
 * then the long arrays and optional blocks. If a legal note still does not fit beside all
 * of that, the save is REFUSED — a conclusion is never shortened and then reported saved.
 * Only a note past the accepted bound (another writer's document) is cut, by
 * {@link noteText}, with the cut stated.
 * @param {object} entry - mutable entry.
 * @param {object} ctx - cut context.
 * @returns {boolean} whether anything was cut.
 */
function cutLargestText(entry, ctx) {
  let chosen = null;
  let length = 0;
  for (const parts of TEXT_PATHS) {
    const value = getPath(entry, parts);
    if (typeof value !== 'string' || value === '') continue;
    if (value.length > length) {
      chosen = parts;
      length = value.length;
    }
  }
  if (chosen === null) return false;
  const current = getPath(entry, chosen);
  const base = current.endsWith(TRUNCATION_MARK) ? current.slice(0, -TRUNCATION_MARK.length) : current;
  const limit = Math.floor(base.length / 2);
  setPath(entry, chosen, `${base.slice(0, limit)}${TRUNCATION_MARK}`);
  const field = chosen.join('.');
  ctx.fields.add(field);
  // Keep the existing evidence flags honest when the patch itself was cut.
  if (field === 'diff.patchText') entry.diff.patchTruncated = true;
  return true;
}

/**
 * Halve the longest remaining list.
 * @param {object} entry - mutable entry.
 * @param {object} ctx - cut context.
 * @returns {boolean} whether anything was cut.
 */
function cutLargestArray(entry, ctx) {
  let chosen = null;
  let length = 0;
  for (const parts of ARRAY_PATHS) {
    const value = getPath(entry, parts);
    if (!Array.isArray(value) || value.length === 0) continue;
    if (value.length > length) {
      chosen = parts;
      length = value.length;
    }
  }
  if (chosen === null) return false;
  const current = getPath(entry, chosen);
  setPath(entry, chosen, current.slice(0, Math.floor(current.length / 2)));
  const field = chosen.join('.');
  ctx.fields.add(field);
  if (field === 'diff.files') entry.diff.truncatedFiles = true;
  return true;
}

/**
 * Drop the first optional block that is still present.
 * @param {object} entry - mutable entry.
 * @param {object} ctx - cut context.
 * @returns {boolean} whether anything was dropped.
 */
function dropBlock(entry, ctx) {
  for (const parts of DROP_PATHS) {
    if (!deletePath(entry, parts)) continue;
    ctx.dropped.add(parts.join('.'));
    return true;
  }
  return false;
}

/** @returns {object} empty cut context seeded with markers a stored entry carried. */
function newCutContext(incoming, maxEntryBytes) {
  const ctx = {
    fields: new Set(),
    dropped: new Set(),
    maxEntryBytes,
  };
  if (!isPlainObject(incoming)) return ctx;
  for (const [key, target] of [['fields', ctx.fields], ['dropped', ctx.dropped]]) {
    const list = incoming[key];
    if (!Array.isArray(list)) continue;
    for (const item of list.slice(0, MAX_TRUNCATION_ITEMS)) {
      if (typeof item === 'string' && item !== '') target.add(item.slice(0, 120));
    }
  }
  return ctx;
}

/** @returns {object | null} the recorded cuts, bounded and stable. */
function cutView(ctx) {
  const fields = [...ctx.fields].slice(0, MAX_TRUNCATION_ITEMS);
  const dropped = [...ctx.dropped].slice(0, MAX_TRUNCATION_ITEMS);
  if (fields.length === 0 && dropped.length === 0) return null;
  return {
    fields,
    dropped,
    note: 'entry fitted to the job history byte budget',
  };
}

/**
 * Read a nested value without trusting any level's prototype.
 * @param {object} target - root object.
 * @param {string[]} parts - key path.
 * @returns {unknown} the value, or undefined.
 */
function getPath(target, parts) {
  let node = target;
  for (const part of parts) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Replace a nested value on an entry this module built itself.
 * @param {object} target - root object.
 * @param {string[]} parts - key path.
 * @param {unknown} value - next value.
 * @returns {void}
 */
function setPath(target, parts, value) {
  let node = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    node = node[parts[index]];
    if (!isPlainObject(node)) return;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Remove a nested key from an entry this module built itself.
 * @param {object} target - root object.
 * @param {string[]} parts - key path.
 * @returns {boolean} whether the key existed.
 */
function deletePath(target, parts) {
  let node = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    node = node[parts[index]];
    if (!isPlainObject(node)) return false;
  }
  const key = parts[parts.length - 1];
  if (!isPlainObject(node) || !Object.hasOwn(node, key)) return false;
  delete node[key];
  return true;
}

/**
 * Assign an own property without ever reaching a prototype setter.
 * @param {object} target - object.
 * @param {string} key - key.
 * @param {unknown} value - value.
 * @returns {void}
 */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** @returns {boolean} true for plain objects (never arrays or class instances' prototypes). */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @returns {string | null} bounded label, or null when absent. */
function label(value) {
  if (typeof value !== 'string' || value === '') return null;
  return value.slice(0, MAX_LABEL_CHARS);
}

/**
 * @param {unknown} value - path.
 * @param {object} [ctx] - cut context; omitted for project-owned paths.
 * @param {string} [field] - field label used when the path had to be cut.
 * @returns {string | null} bounded path, or null when absent.
 */
function path(value, ctx = null, field = '') {
  if (typeof value !== 'string' || value === '') return null;
  if (value.length <= MAX_PATH_CHARS) return value;
  if (ctx !== null && field !== '') ctx.fields.add(field);
  return value.slice(0, MAX_PATH_CHARS);
}

/**
 * @param {unknown} value - value to read.
 * @param {string} field - field label for truncation reporting.
 * @param {number} [cap] - characters kept.
 * @param {object} [ctx] - cut context; omitted only for non-nested calls.
 * @returns {string} bounded text.
 */
function text(value, ctx, field, cap = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || value === '') return '';
  if (value.length <= cap) return value;
  ctx.fields.add(field);
  return `${value.slice(0, cap)}${TRUNCATION_MARK}`;
}

/**
 * @param {unknown} value - list value.
 * @param {object} [ctx] - cut context.
 * @param {string} [field] - field label when the list had to be cut.
 * @returns {string[]} bounded string list.
 */
function stringList(value, ctx = null, field = '') {
  if (!Array.isArray(value)) return [];
  const kept = value
    .filter((item) => typeof item === 'string')
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => item.slice(0, MAX_MESSAGE_CHARS));
  if (ctx !== null && field !== '' && value.length > kept.length) ctx.fields.add(field);
  return kept;
}

/**
 * @param {unknown} value - path list.
 * @param {object} ctx - cut context.
 * @param {string} field - field label.
 * @returns {string[]} bounded path list.
 */
function pathList(value, ctx, field) {
  if (!Array.isArray(value)) return [];
  const kept = value
    .filter((item) => typeof item === 'string' && item !== '')
    .slice(0, MAX_LIST_ITEMS)
    .map((item) => item.slice(0, MAX_PATH_CHARS));
  if (value.length > kept.length) ctx.fields.add(field);
  return kept;
}

/** @returns {number | null} finite non-negative integer, or null. */
function count(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

/** @returns {number | null} finite, plausible millisecond timestamp. */
function time(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > MAX_SAFE_TIMESTAMP) return null;
  return Math.trunc(value);
}

/**
 * @param {unknown} value - candidate.
 * @param {string[]} allowed - exact permitted values.
 * @returns {string | null} the value, or null when it is not one of them.
 */
function knownValue(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

/** @returns {boolean} true when this state must never be evicted by a save. */
function isTerminal(state) {
  return KNOWN_STATES.has(state) && !LIVE_STATES.has(state);
}

/**
 * Total order used on disk: creation time, then id, so serialization is stable.
 * @param {object} a - first entry.
 * @param {object} b - second entry.
 * @returns {number} sort order.
 */
function compareStored(a, b) {
  const left = a.createdAt ?? 0;
  const right = b.createdAt ?? 0;
  if (left !== right) return left - right;
  return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/**
 * Eviction order: oldest end (or creation) first.
 * @param {object} a - first entry.
 * @param {object} b - second entry.
 * @returns {number} sort order.
 */
function compareOldestFirst(a, b) {
  const left = a.endedAt ?? a.createdAt ?? 0;
  const right = b.endedAt ?? b.createdAt ?? 0;
  if (left !== right) return left - right;
  return compareStored(a, b);
}

/** @returns {number} UTF-8 byte length of a string. */
function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Rename over the target, retrying the transient Windows sharing errors.
 * @param {object} fs - filesystem seam.
 * @param {string} temp - source path.
 * @param {string} target - destination path.
 * @returns {Promise<void>} resolves after the rename.
 */
async function renameWithRetry(fs, temp, target) {
  let delay = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temp, target);
      return;
    } catch (error) {
      const transient = process.platform === 'win32' && WINDOWS_TRANSIENT_RENAME.has(error?.code ?? '');
      if (!transient || attempt >= 8) throw error;
    }
    await new Promise((resolve) => { setTimeout(resolve, delay); });
    delay = Math.min(delay * 2, 200);
  }
}
