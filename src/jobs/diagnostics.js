// Closed vocabulary shared by the activity monitor and the MCP wait answer.
//
// This module exists only to hold string constants that BOTH sides compare, so the
// producer and the consumer cannot drift apart, and so neither has to import the other.
// It has no imports of its own: it is the leaf of the graph, which is what keeps the
// `server ⇄ wait` pair and the engine from forming a cycle over one literal.

/**
 * `failure.kind` for a repeated-tool-failure reminder.
 *
 * The reminder rides the existing `attention` reason rather than adding a new one; this
 * discriminator is what lets a host tell "silent for the configured interval" from "kept
 * failing the same operation", which need different decisions.
 */
export const REPEATED_FAILURE_KIND = 'repeated-tool-failure';
