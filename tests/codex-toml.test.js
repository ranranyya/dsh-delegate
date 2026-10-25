// Unit tests for the TOML locator and its in-place editor.
//
// The point of these tests is the property the installer depends on: editing one
// owned key must not disturb anything else in the document — not other tables, not
// comments, not the order of anything, not even a Windows path in a literal string.
// A lossy round trip here would corrupt a user's Codex config, so the cases below
// are the ones that actually appear in a real `~/.codex/config.toml` plus the ones
// that historically break naive editors.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TomlDocument,
  TomlSyntaxError,
  detectEol,
  parseTomlStructure,
  readTomlValues,
  renderKey,
  renderString,
  renderStringArray,
  samePath,
  startsWithPath,
  tomlValueType,
} from '../src/codex/toml.js';

/** A document shaped like the real thing: comments, inline tables, sub-tables. */
const REALISTIC = [
  '# my Codex config — keep this comment',
  'model = "gpt-6.1"   # trailing note',
  'notify = [ "C:\\\\Tools\\\\notify.exe", "turn-ended" ]',
  '',
  '[model_providers.custom]',
  'name = "custom"',
  "base_url = 'https://example.invalid'",
  '',
  '[mcp_servers]',
  'other = { command = "node", args = ["C:/other/server.mjs"] }',
  '',
  '[mcp_servers.dsh-delegate]',
  'command = "node" # keep me',
  'args = [',
  '  "E:/old/path/dsh-delegate-mcp.js", # old entry point',
  ']',
  '',
  '[mcp_servers.dsh-delegate.env]',
  'SOMETHING = "1"',
  '',
  '[projects."e:\\\\work\\\\demo"]',
  'trust_level = "trusted"',
  '',
].join('\n');

test('the locator finds assignments and tables with their full paths', () => {
  const { entries } = parseTomlStructure(REALISTIC);
  const paths = entries.map((entry) => entry.path.join('.'));
  assert.ok(paths.includes('model'));
  assert.ok(paths.includes('mcp_servers.other'));
  assert.ok(paths.includes('mcp_servers.dsh-delegate.command'));
  assert.ok(paths.includes('mcp_servers.dsh-delegate.args'));
  assert.ok(paths.includes('mcp_servers.dsh-delegate.env.SOMETHING'));
  assert.ok(paths.includes('projects.e:\\work\\demo.trust_level'));

  const document = new TomlDocument(REALISTIC);
  assert.deepEqual(
    document.assignmentsUnder(['mcp_servers', 'dsh-delegate']).map((entry) => entry.path.join('.')),
    ['mcp_servers.dsh-delegate.command', 'mcp_servers.dsh-delegate.args', 'mcp_servers.dsh-delegate.env.SOMETHING'],
  );
});

test('multi-line values are located exactly: arrays, comments inside arrays, multi-line strings', () => {
  const document = new TomlDocument(REALISTIC);
  const args = document.assignmentAt(['mcp_servers', 'dsh-delegate', 'args']);
  assert.equal(args.startLine, 13);
  assert.equal(args.endLine, 15, 'the array ends at its closing bracket, not at the next header');
  assert.equal(args.raw, '[\n  "E:/old/path/dsh-delegate-mcp.js", # old entry point\n]');

  const values = readTomlValues([
    'a = """',
    'line # not a comment',
    '[not a header]',
    '"""',
    'b = 1',
  ].join('\n'));
  assert.equal(values.a.type, 'string');
  assert.match(values.a.text, /\[not a header\]/u);
  assert.equal(values.b.text, '1');
});

test('a malformed document raises a located syntax error instead of guessing', () => {
  for (const broken of ['a = "unterminated', '[table', 'a = [1, 2', 'a = 1\n= 2', '= 3']) {
    assert.throws(() => parseTomlStructure(broken), TomlSyntaxError, `should refuse: ${broken}`);
  }
});

test('replacing one value leaves every other byte alone', () => {
  const document = new TomlDocument(REALISTIC);
  const args = document.assignmentAt(['mcp_servers', 'dsh-delegate', 'args']);
  document.replaceValue(args, '["E:/new/path/dsh-delegate-mcp.js"]');

  const lines = document.text.split('\n');
  const original = REALISTIC.split('\n');
  // Everything except the three array lines is identical, in the same order.
  assert.deepEqual(lines.slice(0, 13), original.slice(0, 13));
  assert.equal(lines[13], 'args = ["E:/new/path/dsh-delegate-mcp.js"]');
  assert.deepEqual(lines.slice(14), original.slice(16));
  // The trailing comment on the untouched key is still there.
  assert.match(document.text, /^command = "node" # keep me$/mu);
  assert.match(document.text, /^# my Codex config — keep this comment$/mu);
});

test('a trailing comment and the key spelling survive a same-line replacement', () => {
  const document = new TomlDocument('  model = "old"   # why\n');
  const entry = document.assignmentAt(['model']);
  document.replaceValue(entry, '"new"');
  assert.equal(document.text, '  model = "new"   # why\n');
});

test('table ranges stop at the next sibling and include child tables', () => {
  const document = new TomlDocument(REALISTIC);
  const headerIndex = document.entries.findIndex(
    (entry) => entry.kind === 'table' && samePath(entry.path, ['mcp_servers', 'dsh-delegate']),
  );
  const range = document.tableRange(headerIndex);
  const body = document.lines.slice(range.startLine, range.endLine + 1).join('\n');
  assert.match(body, /^\[mcp_servers\.dsh-delegate\]$/mu);
  assert.match(body, /^\[mcp_servers\.dsh-delegate\.env\]$/mu);
  assert.doesNotMatch(body, /projects/u, 'a later table must not be swallowed');
});

test('removing the owned table keeps the rest of the document byte-identical', () => {
  const document = new TomlDocument(REALISTIC);
  const headerIndex = document.entries.findIndex(
    (entry) => entry.kind === 'table' && samePath(entry.path, ['mcp_servers', 'dsh-delegate']),
  );
  const range = document.tableRange(headerIndex);
  document.removeLines(range.startLine, range.endLine);

  assert.equal(document.text, [
    '# my Codex config — keep this comment',
    'model = "gpt-6.1"   # trailing note',
    'notify = [ "C:\\\\Tools\\\\notify.exe", "turn-ended" ]',
    '',
    '[model_providers.custom]',
    'name = "custom"',
    "base_url = 'https://example.invalid'",
    '',
    '[mcp_servers]',
    'other = { command = "node", args = ["C:/other/server.mjs"] }',
    '',
    '[projects."e:\\\\work\\\\demo"]',
    'trust_level = "trusted"',
    '',
  ].join('\n'));
});

test('appending a block adds exactly one blank separator and keeps a trailing newline', () => {
  const document = new TomlDocument('a = 1\n');
  document.appendBlock(['# marker', '[b]', 'c = 2']);
  assert.equal(document.text, 'a = 1\n\n# marker\n[b]\nc = 2\n');

  const empty = new TomlDocument('');
  empty.appendBlock(['[b]']);
  assert.equal(empty.text, '[b]\n');
});

test('values are rendered as TOML that reads back unchanged, including Windows paths', () => {
  const path = 'C:\\Program Files\\nodejs\\node.exe';
  const rendered = renderString(path);
  assert.deepEqual(readTomlValues(`command = ${rendered}`).command.text, rendered);
  // The escaped form is the only safe spelling: TOML treats `\` as an escape.
  assert.match(rendered, /^"C:\\\\Program Files\\\\nodejs\\\\node\.exe"$/u);
  assert.match(renderString('a"b'), /^"a\\"b"$/u);
  assert.equal(renderStringArray(['a', 'b']), '["a", "b"]');
  assert.equal(renderKey(['mcp_servers', 'dsh-delegate']), 'mcp_servers.dsh-delegate');
  assert.equal(renderKey(['weird key']), '"weird key"');
});

test('path helpers compare whole segments, not prefixes', () => {
  assert.equal(startsWithPath(['a', 'b', 'c'], ['a', 'b']), true);
  assert.equal(startsWithPath(['a', 'bc'], ['a', 'b']), false);
  assert.equal(startsWithPath(['a'], ['a', 'b']), false);
  assert.equal(samePath(['a', 'b'], ['a', 'b']), true);
  assert.equal(samePath(['a', 'b'], ['a']), false);
});

test('value types are classified without evaluating them', () => {
  assert.equal(tomlValueType('"x"'), 'string');
  assert.equal(tomlValueType("'x'"), 'string');
  assert.equal(tomlValueType('"""\nx\n"""'), 'string');
  assert.equal(tomlValueType('[1, 2]'), 'array');
  assert.equal(tomlValueType('{ command = "x" }'), 'table');
  assert.equal(tomlValueType('true'), 'boolean');
  assert.equal(tomlValueType('42'), 'integer');
  assert.equal(tomlValueType('-1.5e3'), 'float');
  assert.equal(tomlValueType('1979-05-27T07:32:00Z'), 'datetime');
});

test('a document with only comments and blank lines is parsed, not edited', () => {
  const document = new TomlDocument('# only a comment\n\n');
  assert.equal(document.entries.length, 0);
  document.appendBlock(['[a]']);
  assert.equal(document.text, '# only a comment\n\n[a]\n');
});

// ---------------------------------------------------------------------------
// CRLF documents
//
// A Codex `config.toml` written or touched by a Windows editor is CRLF. Refusing it
// would also refuse to install; rewriting it as LF would show up as a whole-file diff
// in the operator's editor. Both are unacceptable, so the locator accepts CRLF and
// every edit reproduces the original line ending byte for byte.
// ---------------------------------------------------------------------------

/** The same realistic document, but with Windows line endings. */
const REALISTIC_CRLF = REALISTIC.replace(/\n/gu, '\r\n');

test('a CRLF document is located exactly like its LF twin', () => {
  const lf = parseTomlStructure(REALISTIC);
  const crlf = parseTomlStructure(REALISTIC_CRLF);
  assert.equal(crlf.eol, '\r\n');
  assert.equal(lf.eol, '\n');
  assert.equal(detectEol('a = 1\r\nb = 2\r\n'), '\r\n');
  assert.equal(detectEol('a = 1\nb = 2\n'), '\n');
  assert.equal(detectEol(''), '\n');
  // Same structure: same entry kinds, paths and line ranges (columns differ only by
  // the CR that ends each line, which is never inside a located token).
  assert.deepEqual(
    crlf.entries.map((entry) => [entry.kind, entry.path.join('.'), entry.startLine, entry.endLine]),
    lf.entries.map((entry) => [entry.kind, entry.path.join('.'), entry.startLine, entry.endLine]),
  );
  // Raw values carry no stray CR.
  const args = crlf.entries.find((entry) => entry.path.join('.') === 'mcp_servers.dsh-delegate.args');
  assert.equal(args.raw, lf.entries.find((entry) => entry.path.join('.') === 'mcp_servers.dsh-delegate.args').raw);
  assert.doesNotMatch(args.raw, /\r/u);
});

test('every mutation on a CRLF document keeps CRLF and leaves unrelated bytes alone', () => {
  const document = new TomlDocument(REALISTIC_CRLF);
  const args = document.assignmentAt(['mcp_servers', 'dsh-delegate', 'args']);
  document.replaceValue(args, '["E:/new/path/dsh-delegate-mcp.js"]');
  // No lone LF anywhere: the file is still a pure CRLF file.
  assert.equal(/(^|[^\r])\n/u.test(document.text), false, 'a CRLF document must not gain a bare LF');
  assert.match(document.text, /^args = \["E:\/new\/path\/dsh-delegate-mcp\.js"\]\r$/mu);

  const headerIndex = document.entries.findIndex(
    (entry) => entry.kind === 'table' && samePath(entry.path, ['mcp_servers', 'dsh-delegate']),
  );
  const range = document.tableRange(headerIndex);
  document.removeLines(range.startLine, range.endLine);
  assert.equal(/(^|[^\r])\n/u.test(document.text), false, 'removal must not normalize the file to LF');
  assert.match(document.text, /^# my Codex config — keep this comment\r$/mu);
  assert.match(document.text, /^trust_level = "trusted"\r$/mu);
  assert.doesNotMatch(document.text, /dsh-delegate/u);
});

test('appending to a CRLF document uses CRLF, and to an empty document uses LF', () => {
  const document = new TomlDocument('model = "gpt-6.1"\r\n');
  document.appendBlock(['# marker', '[b]', 'c = 2']);
  assert.equal(document.text, 'model = "gpt-6.1"\r\n\r\n# marker\r\n[b]\r\nc = 2\r\n');

  const empty = new TomlDocument('');
  empty.appendBlock(['[b]']);
  assert.equal(empty.text, '[b]\n');
});

test('an ordinary LF document is unaffected by the CRLF support', () => {
  const document = new TomlDocument('a = 1\nb = "x"\n');
  document.appendBlock(['[c]', 'd = 3']);
  assert.equal(document.eol, '\n');
  assert.equal(document.text, 'a = 1\nb = "x"\n\n[c]\nd = 3\n');
  assert.doesNotMatch(document.text, /\r/u);
});

test('a CR inside a line is still a control character, so a broken document is refused', () => {
  // A CR that is not the last byte of its line is not a line ending; refusing keeps
  // the "never guess" contract for mixed or damaged files.
  assert.throws(() => new TomlDocument('a = "x\rb"\n'), TomlSyntaxError);
  assert.throws(() => new TomlDocument('a = 1\rb = 2\n'), TomlSyntaxError);
  // A CRLF document with a NUL is still refused for the NUL.
  assert.throws(() => new TomlDocument('a = 1\r\nb = "\u0000"\r\n'), TomlSyntaxError);
});
