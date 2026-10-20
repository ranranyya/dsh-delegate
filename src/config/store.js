// Durable document store for plugin-owned state.
//
// Two properties matter here and nowhere else: a reader never observes a
// half-written document, and a document from an unknown schema version is
// refused instead of being reinterpreted. Delegation authorization is
// deliberately NOT stored here — see src/auth/grants.js.

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
    this.queue = Promise.resolve();
  }

  /**
   * Read the document, creating the in-memory default when absent.
   * @returns {Promise<object>} the current document.
   */
  async load() {
    if (this.current !== null) return this.current;
    let raw;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.current = this.initial();
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
    this.current = parsed;
    return this.current;
  }

  /**
   * Apply a synchronous mutation and commit it durably.
   * @param {(document: object) => object | void} mutate - receives a deep copy; returns the next document or mutates it.
   * @returns {Promise<object>} the committed document.
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
      this.current = next;
      return next;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
