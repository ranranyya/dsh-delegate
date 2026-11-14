// The one bound and normalization for a host-review note.
//
// A review note is free prose: Chinese, line breaks and emoji are ordinary in it. That is
// why the bound is counted in Unicode code points — `Array.from(text).length` — rather than
// in UTF-16 units, where an emoji counts twice. The same rule applies at every entry point
// (MCP schema, HTTP route, engine, durable history projection), because a note one layer
// accepts and another cuts is worse than a refusal: the caller would be told "recorded"
// about text that was never recorded.
//
// This module has no imports on purpose: `src/mcp/server.js` is loaded by the standalone
// MCP binary, which must not pull the engine or any native DSH module in through a shared
// constant.

/** Longest review note, in Unicode code points. */
export const REVIEW_NOTE_MAX_CHARS = 8_000;

/**
 * The normalization applied wherever a note is accepted or stored: surrounding whitespace
 * only. The body of the note is preserved exactly.
 * @param {unknown} value - candidate note.
 * @returns {string} the trimmed note, or '' for a non-string.
 */
export function normalizeReviewNote(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {string} value - text to measure.
 * @returns {number} length in Unicode code points (0 for a non-string).
 */
export function reviewNoteLength(value) {
  return typeof value === 'string' ? Array.from(value).length : 0;
}

/**
 * Refusal facts for an over-long note, so every surface reports the same numbers.
 * @param {string} value - the rejected note.
 * @returns {{ limit: number, length: number, message: string }} bound, actual length, message.
 */
export function reviewNoteOverflow(value) {
  const length = reviewNoteLength(value);
  return {
    limit: REVIEW_NOTE_MAX_CHARS,
    length,
    message: `note must be at most ${REVIEW_NOTE_MAX_CHARS} Unicode code points, but it is ${length}`,
  };
}

/**
 * Cut a string to a code-point bound.
 *
 * Only for a stored value that reached the document some other way (an older build, a
 * hand-edited file). An accepted request is REFUSED when it is too long, never shortened.
 * @param {unknown} value - candidate text.
 * @param {number} [limit] - code points to keep.
 * @returns {string | null} bounded text, or null when the value is not a non-empty string.
 */
export function truncateCodePoints(value, limit = REVIEW_NOTE_MAX_CHARS) {
  if (typeof value !== 'string' || value === '') return null;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  return points.slice(0, limit).join('');
}
