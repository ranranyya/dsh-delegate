// Minimal TOML reader plus a *span-aware* editor for one document.
//
// Why this file exists
// --------------------
// dsh-delegate registers one stdio MCP server in Codex's `config.toml`. That file
// belongs to the operator and to Codex: it holds model settings, project trust
// levels, notifications and other MCP servers, usually with explanatory comments.
// Rewriting it from a parsed object (`JSON.parse`-style round trip) would silently
// drop every comment and reorder every table. So the editor below works on the
// original *text*: it locates the byte range of exactly the assignment it owns
// and replaces that range, leaving every other byte untouched.
//
// Scope of the parser
// -------------------
// It is a *structure locator*, not a validating TOML implementation. It must be
// accurate about the things a merge depends on:
//
//   * where a table header starts and ends (`[a.b]`, `[[a.b]]`),
//   * which keys live in which table, including dotted and quoted keys,
//   * the full extent of a value, including multi-line strings, arrays, inline
//     tables and trailing comments,
//   * which values are a *definition of a table* (`mcp_servers.dsh-delegate` and
//     any child of it), because exactly those are the ones this plugin owns.
//
// It deliberately does not evaluate values. `readToml` returns values as their raw
// text with a small type tag, which is all a diagnostic needs ("is this entry a
// string where a command must be?"), and `TomlDocument` never re-serializes text
// it did not itself create.
//
// Line endings
// ------------
// A Codex `config.toml` touched by a Windows editor is usually CRLF. The locator
// therefore splits on `\n` only, keeps the `\r` as part of each line, and treats a
// *terminal* `\r` as a line ending rather than a control character: it is skipped
// wherever whitespace ends a token, and every mutation re-joins with the document's
// original ending. A `\r` anywhere else is still a control character and still
// refuses the document, so mixed or broken files are diagnosed, not rewritten.
//
// Any syntax this locator cannot follow raises `TomlSyntaxError` with the 1-based
// line number. Callers treat that as "refuse to touch the file": editing a
// document we could not read correctly is how a user's config gets corrupted.

/** Raised when the document cannot be located structurally. */
export class TomlSyntaxError extends Error {
  /**
   * @param {string} message - what went wrong, without quoting file content.
   * @param {number} line - 1-based line number.
   */
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = 'TomlSyntaxError';
    this.line = line;
  }
}

/** Characters that may appear in a bare key. */
const BARE_KEY = /[A-Za-z0-9_-]/u;

/** The trailing byte of a CRLF file, which is a line ending rather than content. */
const CR = '\r';

/**
 * Advance a scanner over one line, skipping spaces and a trailing comment.
 *
 * A comment yields a negative sentinel rather than the end offset, so callers can
 * tell "nothing but a comment remains" apart from "this line ended", which are
 * different outcomes: the first is a document with nothing left to read, the
 * second may be a value continuing on the next line. The `\r` of a CRLF line
 * ending is skipped like a space: it is not content.
 * @param {string} line - one line of text.
 * @param {number} index - start offset.
 * @returns {number} offset of the first significant character, or a negative sentinel at a comment.
 */
function skipSpaceAndComment(line, index) {
  let cursor = index;
  while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t' || line[cursor] === CR)) cursor += 1;
  if (cursor < line.length && line[cursor] === '#') return -line.length - 1;
  return cursor;
}

/**
 * Read one key segment starting at `index`.
 * @param {string} line - line text.
 * @param {number} index - offset of the first character of the segment.
 * @returns {{ key: string, end: number }} decoded key, or throws.
 */
function readKeySegment(line, index, lineNumber = 1) {
  const first = line[index];
  if (first === '"' || first === "'") {
    const { value, end } = readBasicOrLiteralString(line, index, lineNumber);
    return { key: value, end };
  }
  let cursor = index;
  while (cursor < line.length && BARE_KEY.test(line[cursor])) cursor += 1;
  if (cursor === index) throw new TomlSyntaxError('a key is malformed', lineNumber);
  return { key: line.slice(index, cursor), end: cursor };
}

/**
 * Read a single-line basic (`"…"`) or literal (`'…'`) string.
 * @param {string} line - line text.
 * @param {number} index - offset of the opening quote.
 * @returns {{ value: string, end: number }} decoded value and offset after the closing quote.
 */
function readBasicOrLiteralString(line, index, lineNumber = 1) {
  const quote = line[index];
  let cursor = index + 1;
  let out = '';
  while (cursor < line.length) {
    const char = line[cursor];
    if (quote === '"' && char === '\\') {
      const next = line[cursor + 1];
      if (next === undefined) break;
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      cursor += 2;
      continue;
    }
    if (char === quote) return { value: out, end: cursor + 1 };
    out += char;
    cursor += 1;
  }
  throw new TomlSyntaxError('a string is not terminated on this line', lineNumber);
}

/**
 * Read a dotted key (one or more segments separated by `.`).
 * @param {string} line - line text.
 * @param {number} index - start offset.
 * @returns {{ path: string[], end: number }} decoded key path and end offset.
 */
function readKeyPath(line, index) {
  const path = [];
  let cursor = index;
  for (;;) {
    const segment = readKeySegment(line, cursor);
    path.push(segment.key);
    cursor = segment.end;
    // Inter-segment padding is ordinary whitespace, never a comment: a `#` here
    // would end the line before an `=`, which is a syntax error the caller reports.
    while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t')) cursor += 1;
    if (line[cursor] !== '.') return { path, end: cursor };
    cursor += 1;
    while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t')) cursor += 1;
  }
}

/**
 * Locate the end of a table header `[...]` or `[[...]]`.
 * @param {string} line - line text, starting at `[`.
 * @returns {{ path: string[], array: boolean, end: number }} header facts.
 */
function readTableHeader(line, index) {
  const array = line.startsWith('[[', index);
  const opener = array ? 2 : 1;
  let cursor = index + opener;
  const path = [];
  /** Skip header padding; a comment cannot occur inside a header. */
  const skip = (from) => {
    let at = from;
    while (at < line.length && (line[at] === ' ' || line[at] === '\t' || line[at] === CR)) at += 1;
    return at;
  };
  for (;;) {
    cursor = skip(cursor);
    const segment = readKeySegment(line, cursor);
    path.push(segment.key);
    cursor = skip(segment.end);
    if (line[cursor] === '.') {
      cursor += 1;
      continue;
    }
    break;
  }
  const closer = array ? ']]' : ']';
  if (!line.startsWith(closer, cursor)) throw new TomlSyntaxError('a table header is not closed', 1);
  const end = cursor + closer.length;
  if (skipSpaceAndComment(line, end) !== line.length) throw new TomlSyntaxError('trailing text after a table header', 1);
  return { path, array, end };
}

/**
 * Read the extent of one value that begins on a line.
 *
 * The result is the offset just past the last significant character of the value,
 * before any trailing comment. Multi-line values are consumed by advancing
 * `current`, which is why this takes the document's line array rather than one line.
 * @param {string[]} lines - document lines (no newline characters).
 * @param {number} lineIndex - line the value starts on.
 * @param {number} index - offset inside that line where the value starts.
 * @returns {{ endLine: number, endColumn: number }} position just past the value.
 */
function readValueExtent(lines, lineIndex, index) {
  const first = lines[lineIndex];
  // Bracket depth of the *outer* value only. Parentheses are not TOML brackets, so
  // they are ordinary characters here; guessing otherwise would swallow following
  // text on a malformed document.
  let depth = 0;
  let cursor = index;
  let line = first;
  let current = lineIndex;
  let quote = null;
  let triple = false;
  for (;;) {
    if (cursor >= line.length) {
      if (quote !== null) {
        // Only a multi-line string continues past the end of a line; a single-line
        // string or an unterminated array is a syntax error the locator must not
        // guess about.
        if (!triple) throw new TomlSyntaxError('a string is not terminated', current + 1);
        current += 1;
        if (current >= lines.length) throw new TomlSyntaxError('a multi-line string is not terminated', lineIndex + 1);
        line = lines[current];
        cursor = 0;
        continue;
      }
      if (depth > 0) {
        current += 1;
        if (current >= lines.length) throw new TomlSyntaxError('a value is not closed', lineIndex + 1);
        line = lines[current];
        cursor = 0;
        continue;
      }
      return { endLine: current, endColumn: cursor };
    }
    const char = line[cursor];
    if (quote === null) {
      // Outside a string, whitespace with nothing open ends the value, and a `#`
      // with nothing open starts a trailing comment — except inside an open array,
      // where a comment sits *between elements* and the value continues. A `\r` only
      // ever occurs at the end of a line, so reaching one here means the value ended
      // and the CRLF line ending begins.
      if (depth === 0 && (char === '#' || char === ' ' || char === '\t' || char === CR)) {
        return lastSignificant(lines, index, current, cursor);
      }
      if (char === '#' && depth > 0) {
        cursor = line.length;
        continue;
      }
    }
    if (quote !== null) {
      if (triple) {
        if (char === '\\' && quote === '"') {
          cursor += 2;
          continue;
        }
        if (line.startsWith(quote.repeat(3), cursor)) {
          cursor += 3;
          // A basic multi-line string may end with up to two extra quotes: in
          // `"""a""""` the fourth quote belongs to the value, not to the delimiter.
          if (quote === '"' && line[cursor] === '"') cursor += 1;
          quote = null;
          triple = false;
          continue;
        }
        cursor += 1;
        continue;
      }
      if (quote === '"' && char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
        cursor += 1;
        continue;
      }
      cursor += 1;
      continue;
    }
    if (char === '#') {
      if (depth === 0) {
        // The value ended at its last significant character, which may be on an
        // earlier line of a multi-line array. A `#` inside an open array is a
        // comment *between elements* and the value continues on the next line.
        return lastSignificant(lines, index, current, cursor);
      }
      // Skip a comment between array elements; it is not part of the structure but
      // stays inside the entry's line range, so an edit preserves it.
      cursor = line.length;
      continue;
    }
    if (char === '"' || char === "'") {
      const nextTriple = line.startsWith(char.repeat(3), cursor);
      quote = char;
      triple = nextTriple;
      cursor += nextTriple ? 3 : 1;
      continue;
    }
    if (char === '[' || char === '{') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (char === ']' || char === '}') {
      depth -= 1;
      if (depth < 0) throw new TomlSyntaxError('a value has an unbalanced bracket', current + 1);
      cursor += 1;
      continue;
    }
    if (depth === 0 && (char === ' ' || char === '\t' || char === CR)) {
      // Trailing whitespace (or a CRLF line ending) after a complete value ends it.
      return lastSignificant(lines, index, current, cursor);
    }
    cursor += 1;
  }
}

/**
 * Walk backwards from a stopping offset to the last non-space character.
 *
 * Used so the replacement range never swallows the whitespace before a trailing
 * comment: `key = "x"   # note` keeps its `   # note`. The `\r` of a CRLF ending is
 * not part of the value either, so a multi-line array in a CRLF file does not keep
 * a stray carriage return inside its raw text.
 * @param {string[]} lines - document lines.
 * @param {number} startColumn - column the value starts on its first line.
 * @param {number} stopLine - line the scan stopped on.
 * @param {number} stopColumn - column the scan stopped at.
 * @returns {{ endLine: number, endColumn: number }} position just past the value.
 */
function lastSignificant(lines, startColumn, stopLine, stopColumn) {
  let lineIndex = stopLine;
  let column = stopColumn;
  for (;;) {
    while (column > 0 && (lines[lineIndex][column - 1] === ' ' || lines[lineIndex][column - 1] === '\t' || lines[lineIndex][column - 1] === CR)) {
      column -= 1;
    }
    if (column > 0) return { endLine: lineIndex, endColumn: column };
    lineIndex -= 1;
    if (lineIndex < 0) throw new TomlSyntaxError('a value is missing', stopLine + 1);
    column = lines[lineIndex].length;
  }
}

/**
 * One assignment or table header located in the source text.
 * @typedef {object} TomlEntry
 * @property {'table' | 'array-table' | 'assignment'} kind - entry kind.
 * @property {string[]} path - full key path (table path, plus the key for an assignment).
 * @property {string} [raw] - raw value text of an assignment.
 * @property {number} startLine - first line (0-based).
 * @property {number} endLine - last line (0-based).
 * @property {number} startColumn - column of the first character.
 * @property {number} endColumn - column just past the last character.
 * @property {string[]} [leadingCommentLines] - contiguous comment lines directly above.
 */

/**
 * The line ending a document already uses.
 *
 * CRLF is chosen when the document has at least one line ending and *none* of them
 * is a bare LF — the same rule `finalNewline` uses, applied to the joiner. Mixed
 * endings therefore stay LF, which is the conservative outcome: the file is written
 * the way it mostly already was rather than converted wholesale.
 * @param {string} text - document text.
 * @returns {string} `'\r\n'` or `'\n'`.
 */
export function detectEol(text) {
  if (typeof text !== 'string') return '\n';
  // Every `\n` that is not preceded by a `\r` would be a bare LF. Splitting on `\n`
  // and checking each line's predecessor is the cheapest exact test.
  const lines = text.split('\n');
  let crlf = 0;
  let lf = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index].endsWith('\r')) crlf += 1;
    else lf += 1;
  }
  return crlf > 0 && lf === 0 ? '\r\n' : '\n';
}

/**
 * Parse a document into entries by source range.
 *
 * Only structure is decoded; comments and blank lines inside values are kept by
 * the range logic, and nothing is normalized. The document's line ending is
 * detected once and reported as `eol`, so an edit can reproduce it byte for byte.
 * @param {string} text - TOML document.
 * @returns {{ entries: TomlEntry[], lines: string[], finalNewline: boolean, eol: string }} structure.
 * @throws {TomlSyntaxError} when the document cannot be located.
 */
export function parseTomlStructure(text) {
  if (typeof text !== 'string') throw new TypeError('parseTomlStructure expects text');
  const finalNewline = text.endsWith('\n');
  const eol = detectEol(text);
  const lines = text.split('\n');
  if (finalNewline) lines.pop();
  /** @type {TomlEntry[]} */
  const entries = [];
  let currentPath = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex];
    // A raw control character (tab excepted) is not valid TOML text. A terminal CR
    // is exempt: it is the second byte of a CRLF line ending, which Windows editors
    // produce routinely. A CR anywhere else is still refused, so a document with
    // mixed or broken endings is diagnosed instead of silently rewritten.
    const content = line.endsWith(CR) ? line.slice(0, -1) : line;
    if (/[\u0000-\u0008\u000a-\u001f]/u.test(content)) {
      throw new TomlSyntaxError('the document contains a control character', lineIndex + 1);
    }
    const start = skipSpaceAndComment(line, 0);
    // A blank line, or a line holding only a comment, produces the negative
    // "nothing significant here" sentinel.
    if (start < 0 || start >= line.length) {
      lineIndex += 1;
      continue;
    }
    if (line[start] === '[') {
      const header = readTableHeader(line, start);
      currentPath = header.path;
      entries.push({
        kind: header.array ? 'array-table' : 'table',
        path: [...header.path],
        startLine: lineIndex,
        endLine: lineIndex,
        startColumn: start,
        endColumn: header.end,
      });
      lineIndex += 1;
      continue;
    }
    const key = readKeyPath(line, start);
    // `readKeyPath` stops at the first significant character that cannot continue
    // the key, which for a well-formed assignment is the `=` itself.
    if (line[key.end] !== '=') throw new TomlSyntaxError('a key is not followed by "="', lineIndex + 1);
    const valueStart = skipSpaceAndComment(line, key.end + 1);
    if (valueStart < 0) throw new TomlSyntaxError('a value is missing', lineIndex + 1);
    const extent = readValueExtent(lines, lineIndex, valueStart);
    // The value's end column only has meaning on its last line; a single-line value
    // spans one line, a multi-line value always ends at the end of its last line.
    const endColumn = extent.endLine === lineIndex ? extent.endColumn : lines[extent.endLine].length;
    // A multiline value is joined with plain `\n`, not the document's ending: `raw`
    // is a rendering of the value, never a byte range that could be written back.
    // Each line's own CR (present in a CRLF file) is dropped for the same reason —
    // the CR is a line ending, not part of the value.
    const rawParts = extent.endLine === lineIndex
      ? [lines[lineIndex].slice(valueStart, extent.endColumn)]
      : [lines[lineIndex].slice(valueStart), ...lines.slice(lineIndex + 1, extent.endLine + 1)];
    const raw = rawParts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part)).join('\n');
    entries.push({
      kind: 'assignment',
      path: [...currentPath, ...key.path],
      raw,
      startLine: lineIndex,
      endLine: extent.endLine,
      startColumn: start,
      endColumn,
    });
    lineIndex = extent.endLine + 1;
  }
  return { entries, lines, finalNewline, eol };
}

/**
 * Read a bounded subset of the document as data, for diagnostics only.
 *
 * Values are returned as `{ type, text }` pairs: `type` is the TOML type name this
 * reader recognizes (`string`, `integer`, `float`, `boolean`, `array`, `table`,
 * `datetime`) and `text` is the raw source. No value is ever re-serialized from
 * this representation, so the reader cannot be a lossy path back to disk.
 * @param {string} text - TOML document.
 * @returns {Record<string, { type: string, text: string }>} flat dotted-path map.
 */
export function readTomlValues(text) {
  const { entries } = parseTomlStructure(text);
  /** @type {Record<string, { type: string, text: string }>} */
  const values = {};
  for (const entry of entries) {
    if (entry.kind !== 'assignment') continue;
    values[entry.path.join('.')] = { type: tomlValueType(entry.raw), text: entry.raw };
  }
  return values;
}

/**
 * Classify a raw TOML value.
 * @param {string} raw - raw value text.
 * @returns {string} type name.
 */
export function tomlValueType(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return 'empty';
  if (text.startsWith('"""') || text.startsWith("'''")) return 'string';
  if (text.startsWith('"') || text.startsWith("'")) return 'string';
  if (text.startsWith('[')) return 'array';
  if (text.startsWith('{')) return 'table';
  if (text === 'true' || text === 'false') return 'boolean';
  if (/^[+-]?\d[\d_]*$/u.test(text)) return 'integer';
  if (/^[+-]?(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][+-]?\d+)?$/u.test(text)) return 'float';
  if (/^\d{4}-\d{2}-\d{2}/u.test(text) || /^\d{2}:\d{2}:\d{2}/u.test(text)) return 'datetime';
  return 'unknown';
}

/**
 * A document being edited in place, one owned region at a time.
 *
 * Every mutation works on line/column ranges in the current text, so unrelated
 * content (other tables, comments, blank lines, ordering) survives verbatim.
 */
export class TomlDocument {
  /**
   * @param {string} text - original document.
   */
  constructor(text) {
    this.text = typeof text === 'string' ? text : '';
    this.reparse();
  }

  /** Re-read the structure after an edit. */
  reparse() {
    const structure = parseTomlStructure(this.text);
    this.entries = structure.entries;
    this.lines = structure.lines;
    this.finalNewline = structure.finalNewline;
    this.eol = structure.eol;
  }

  /**
   * The document text for a line array, using the document's own line endings.
   *
   * Every mutation goes through this, which is what makes an edit to a CRLF file
   * stay a CRLF file. The line array keeps each trailing `\r`, so the `\r` is
   * stripped here before the document's own ending is applied — otherwise the result
   * would carry `\r\r\n` and the re-parse would (correctly) reject the stray CR.
   * @param {string[]} lines - lines to join.
   * @param {boolean} [trailing] - whether to end with a line ending.
   * @returns {string} text.
   */
  join(lines, trailing = true) {
    const eol = this.eol ?? '\n';
    const body = lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)).join(eol);
    return trailing ? `${body}${eol}` : body;
  }

  /**
   * Every assignment whose path is `prefix` or a child of it.
   * @param {string[]} prefix - key path.
   * @returns {TomlEntry[]} matching assignments.
   */
  assignmentsUnder(prefix) {
    return this.entries.filter((entry) => entry.kind === 'assignment' && startsWithPath(entry.path, prefix));
  }

  /**
   * Every table header whose path is `prefix` or a child of it.
   * @param {string[]} prefix - key path.
   * @returns {TomlEntry[]} matching table headers.
   */
  tablesUnder(prefix) {
    return this.entries.filter((entry) => entry.kind !== 'assignment' && startsWithPath(entry.path, prefix));
  }

  /**
   * The assignment at exactly `path`, if present.
   * @param {string[]} path - key path.
   * @returns {TomlEntry | undefined} entry.
   */
  assignmentAt(path) {
    return this.entries.find((entry) => entry.kind === 'assignment' && samePath(entry.path, path));
  }

  /**
   * Replace one line range with new lines, keeping the trailing newline policy.
   * @param {number} startLine - first line to replace (0-based, inclusive).
   * @param {number} endLine - last line to replace (0-based, inclusive).
   * @param {string[]} replacement - new lines.
   * @returns {void}
   */
  replaceLines(startLine, endLine, replacement) {
    const next = [...this.lines.slice(0, startLine), ...replacement, ...this.lines.slice(endLine + 1)];
    this.text = this.join(next, this.finalNewline || next.length > 0);
    this.reparse();
  }

  /**
   * Append lines at the end of the document, separated by exactly one blank line.
   * @param {string[]} newLines - lines to append.
   * @returns {void}
   */
  appendBlock(newLines) {
    const base = this.lines.slice();
    while (base.length > 0 && base[base.length - 1].trim() === '') base.pop();
    const combined = base.length === 0 ? newLines.slice() : [...base, '', ...newLines];
    this.text = this.join(combined);
    this.reparse();
  }

  /**
   * Replace the raw value of one assignment, keeping its key and indentation.
   * @param {TomlEntry} entry - assignment entry.
   * @param {string} rawValue - replacement value text.
   * @returns {void}
   */
  replaceValue(entry, rawValue) {
    const lines = this.lines.slice();
    const first = lines[entry.startLine];
    // Keep the key exactly as the operator wrote it — indentation included — and
    // keep whatever followed the old value on its last line (a trailing comment).
    const equals = first.indexOf('=', entry.startColumn - 1);
    const prefix = first.slice(0, equals + 1);
    const trailing = entry.endLine === entry.startLine
      ? first.slice(entry.endColumn)
      : lines[entry.endLine].slice(entry.endColumn);
    const head = `${prefix} ${rawValue}${trailing}`;
    if (entry.endLine === entry.startLine) lines[entry.startLine] = head;
    else lines.splice(entry.startLine, entry.endLine - entry.startLine + 1, head);
    this.text = this.join(lines);
    this.reparse();
  }

  /**
   * Delete a contiguous run of lines, dropping the blank line it leaves behind.
   * @param {number} startLine - first line (0-based).
   * @param {number} endLine - last line (0-based).
   * @returns {void}
   */
  removeLines(startLine, endLine) {
    const lines = this.lines.slice();
    lines.splice(startLine, endLine - startLine + 1);
    // Collapse the blank line a removal leaves behind, so the surrounding document
    // keeps its spacing rather than growing a gap. Whichever side of the hole is
    // blank is dropped; when both are, exactly one blank line survives, which is the
    // separator the document already had.
    const before = lines[startLine - 1];
    const after = lines[startLine];
    if (startLine > 0 && before.trim() === '' && after !== undefined && after.trim() === '') {
      lines.splice(startLine, 1);
    } else if (startLine > 0 && before.trim() === '' && (after === undefined || after.trim() !== '')) {
      lines.splice(startLine - 1, 1);
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    this.text = lines.length === 0 ? '' : this.join(lines);
    this.reparse();
  }

  /**
   * The comment lines directly above an entry, without a blank line between.
   * @param {TomlEntry} entry - entry.
   * @returns {number} first line of that comment block.
   */
  leadingCommentStart(entry) {
    let cursor = entry.startLine - 1;
    while (cursor >= 0 && this.lines[cursor].trimStart().startsWith('#')) cursor -= 1;
    return cursor + 1;
  }

  /**
   * The line range of one table header and everything that belongs to it.
   *
   * The range ends at the last line before the next header at the same or a
   * shallower depth — *not* at the end of the document — so deleting a table never
   * takes a sibling with it. Trailing blank lines inside the range are trimmed so a
   * removal does not leave a growing gap.
   * @param {number} headerIndex - index into {@link TomlDocument#entries}.
   * @returns {{ startLine: number, endLine: number }} inclusive line range, including the comment block above the header.
   */
  tableRange(headerIndex) {
    const header = this.entries[headerIndex];
    if (header === undefined || header.kind === 'assignment') throw new TypeError('tableRange expects a table header');
    const end = this.tableBodyEnd(headerIndex);
    return { startLine: this.leadingCommentStart(header), endLine: end };
  }

  /**
   * The last line that belongs to one table: its body and child tables, not siblings.
   * @param {number} headerIndex - index into {@link TomlDocument#entries}.
   * @returns {number} last owned line, 0-based, trailing blank lines already trimmed.
   */
  tableBodyEnd(headerIndex) {
    const header = this.entries[headerIndex];
    let end = this.lines.length - 1;
    for (let index = headerIndex + 1; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry.kind === 'assignment') continue;
      // A sibling (`[mcp_servers.other]`) or a shallower header (`[other]`) closes
      // this table. A deeper one (`[mcp_servers.dsh-delegate.env]`) is its child
      // and is owned by it.
      if (entry.path.length <= header.path.length) {
        end = entry.startLine - 1;
        break;
      }
    }
    while (end > header.startLine && this.lines[end].trim() === '') end -= 1;
    return end;
  }

  /**
   * Is this line a comment carrying `marker`?
   *
   * Matching is exact after trimming: a line that merely mentions the marker text
   * inside a longer comment is not the marker the plugin wrote.
   * @param {number} lineIndex - line to test.
   * @param {string} marker - marker comment, including its `#`.
   * @returns {boolean} true when the line is that marker, alone.
   */
  isMarkerLine(lineIndex, marker) {
    const line = this.lines[lineIndex];
    if (typeof line !== 'string') return false;
    return line.trim() === marker.trim();
  }

  /**
   * The line range of one table header together with *its own* marker comment only.
   *
   * Deliberately narrower than {@link TomlDocument#tableRange}: a comment block the
   * operator wrote above the header may explain their own settings, and a removal
   * must not take it. Only the exact plugin marker is owned, and only when it is the
   * last comment line before the header.
   * @param {number} headerIndex - index into {@link TomlDocument#entries}.
   * @param {string} marker - the plugin's marker comment.
   * @returns {{ startLine: number, endLine: number }} inclusive range.
   */
  markedTableRange(headerIndex, marker) {
    const header = this.entries[headerIndex];
    let startLine = header.startLine;
    if (this.isMarkerLine(startLine - 1, marker)) startLine -= 1;
    return { startLine, endLine: this.tableBodyEnd(headerIndex) };
  }
}

/**
 * Is `path` equal to `prefix` or below it?
 * @param {string[]} path - candidate path.
 * @param {string[]} prefix - prefix path.
 * @returns {boolean} true when the prefix matches.
 */
export function startsWithPath(path, prefix) {
  if (path.length < prefix.length) return false;
  return prefix.every((segment, index) => path[index] === segment);
}

/**
 * Are two key paths identical?
 * @param {string[]} left - first path.
 * @param {string[]} right - second path.
 * @returns {boolean} true when equal.
 */
export function samePath(left, right) {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/**
 * Render a key path as a TOML bare/dotted key, quoting only where required.
 * @param {string[]} path - key path.
 * @returns {string} rendered key.
 */
export function renderKey(path) {
  return path.map((segment) => (/^[A-Za-z0-9_-]+$/u.test(segment) ? segment : renderString(segment))).join('.');
}

/**
 * Render a TOML basic string.
 *
 * Windows paths appear in this file constantly (`node.exe`), and TOML basic
 * strings treat `\` as an escape, so a raw path would corrupt the document. The
 * writer always emits basic strings with escaped backslashes, which both TOML and
 * Codex read back as the intended path.
 * @param {string} value - string to render.
 * @returns {string} quoted, escaped TOML string.
 */
export function renderString(value) {
  const text = String(value);
  let out = '"';
  for (const char of text) {
    if (char === '\\') out += '\\\\';
    else if (char === '"') out += '\\"';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char.codePointAt(0) < 0x20) out += `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`;
    else out += char;
  }
  return `${out}"`;
}

/**
 * Render an array of strings.
 * @param {string[]} values - strings.
 * @returns {string} TOML array.
 */
export function renderStringArray(values) {
  return `[${values.map(renderString).join(', ')}]`;
}
