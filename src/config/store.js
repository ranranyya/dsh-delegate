// Durable document store for plugin-owned state.
//
// Two properties matter here and nowhere else: a reader never observes a
// half-written document, and a document from an unknown schema version is
// refused instead of being reinterpreted. Delegation authorization is
// deliberately NOT stored here — see src/auth/grants.js.
//
// A third property is added because callers hand these documents to UI and
// HTTP layers: every document this module returns is deep-frozen, so a caller
// cannot mutate what the store believes is on disk. A writer must go through
// `commit`, which works on its own deep copy.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const WINDOWS_TRANSIENT_RENAME = new Set(['EACCES', 'EBUSY', 'EPERM']);

async function renameWithRetry(temp, target) {
  let delay = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      const transient = process.platform === 'win32' && WINDOWS_TRANSIENT_RENAME.has(error?.code ?? '');
      if (!transient || attempt >= 8) throw error;
    }
    await new Promise((resolve) => { setTimeout(resolve, delay); });
    delay = Math.min(delay * 2, 200);
  }
}

/**
 * Replace a file atomically: write a random sibling, then rename over the
 * target so a crash leaves either the old or the new complete document.
 * @param {string} filename - final path.
 * @param {string} content - complete next content.
 * @returns {Promise<void>} resolves after the rename.
 */
export async function writeFileAtomic(filename, content) {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await renameWithRetry(temp, filename);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Freeze a JSON-shaped value and everything below it.
 *
 * Used on every snapshot this module hands out, so "the caller changed the
 * document" is impossible rather than merely discouraged: a write to a frozen
 * object throws in the strict mode every ESM module runs in. The input is
 * expected to be JSON data (objects, arrays, primitives); a cyclic graph is not
 * produced by `JSON.parse` and is not supported.
 * @template T
 * @param {T} value - value to freeze in place.
 * @returns {T} the same value, frozen down to its leaves.
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  // Already frozen (possibly by an earlier pass): nothing below can be mutable.
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/** Refusal raised when a stored document cannot be trusted as-is. */
export class StoreError extends Error {
  /**
   * @param {string} code - stable machine code.
   * @param {string} message - human-readable explanation.
   */
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/**
 * One JSON document with a versioned envelope and serialized writes.
 *
 * Writes are queued: a read-modify-write cycle inside this process cannot lose
 * a concurrent update, and the last committed snapshot is what a restart reads.
 * Reads are not queued — the file is replaced atomically, and `current` only
 * ever points at a complete document, so a concurrent read returns either the
 * old or the new snapshot and never a partial one.
 */
export class JsonDocument {
  /**
   * @param {string} dataDir - plugin data directory.
   * @param {string} fileName - document file name inside the directory.
   * @param {object} options - `schemaVersion` and `initial` factory.
   */
  constructor(dataDir, fileName, { schemaVersion, initial }) {
    this.path = join(dataDir, fileName);
    this.schemaVersion = schemaVersion;
    this.initial = initial;
    this.current = null;
    // In-flight first read. Concurrent `load()` calls share it instead of each
    // issuing their own read of the same file.
    this.loading = null;
    this.queue = Promise.resolve();
  }

  /**
   * Read the document, creating the in-memory default when absent.
   * @returns {Promise<object>} the current document, frozen.
   */
  async load() {
    if (this.current !== null) return this.current;
    if (this.loading === null) {
      this.loading = this.readOnce().finally(() => { this.loading = null; });
    }
    return await this.loading;
  }

  /**
   * Perform the single physical read behind {@link JsonDocument#load}.
   * @returns {Promise<object>} the loaded document, frozen.
   */
  async readOnce() {
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.current = deepFreeze(this.initial());
        return this.current;
      }
      throw new StoreError('STORE_UNREADABLE', `cannot read ${this.path}: ${error?.code ?? 'unknown error'}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new StoreError('STORE_MALFORMED', 'stored document is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new StoreError('STORE_MALFORMED', 'stored document is not an object');
    }
    if (parsed.schemaVersion !== this.schemaVersion) {
      throw new StoreError(
        'STORE_SCHEMA_UNSUPPORTED',
        `stored schemaVersion ${String(parsed.schemaVersion)} is not supported by this release`,
      );
    }
    this.current = deepFreeze(parsed);
    return this.current;
  }

  /**
   * Apply a synchronous mutation and commit it durably.
   *
   * The mutation receives a mutable deep copy, so it can edit in place. It is
   * not allowed to reach back into this document (for example by awaiting
   * another `commit`), which would queue behind itself and never settle.
   * @param {(document: object) => object | void} mutate - receives a deep copy; returns the next document or mutates it.
   * @returns {Promise<object>} the committed document, frozen.
   */
  commit(mutate) {
    const run = this.queue.then(async () => {
      const base = await this.load();
      const draft = structuredClone(base);
      const returned = mutate(draft);
      const next = returned === undefined ? draft : returned;
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        throw new StoreError('STORE_INVALID', 'a committed document must be an object');
      }
      next.schemaVersion = this.schemaVersion;
      await writeFileAtomic(this.path, `${JSON.stringify(next, null, 2)}\n`);
      this.current = deepFreeze(next);
      return this.current;
    });
    // The queue tail is settled either way: one failed write must not poison
    // every later commit.
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
