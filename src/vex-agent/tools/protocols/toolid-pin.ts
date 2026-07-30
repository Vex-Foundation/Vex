/**
 * Exact / unique-prefix toolId pin for `discover_tools`.
 *
 * Dense retrieval is an embedding-similarity search over capability prose, so a
 * query that IS a toolId ("dexscreener.search", "khalani.brid") is exactly the
 * case it handles worst — the model already knows the answer and only needs the
 * param schema back. This pre-step recognises that query and puts the named
 * manifest at rank 0; everything after it keeps the ranking retrieval produced.
 *
 * Deliberately narrow (owner decision 2026-07-30): no hybrid retrieval, no
 * BM25, no new storage. A query containing whitespace is ordinary intent prose
 * and is never treated as a toolId.
 */

import type { ScoredManifest } from "./lexical-score.js";
import type { ProtocolToolManifest } from "./types.js";

/** Score assigned to a pinned row — above any cosine similarity. */
const PINNED_SCORE = 1;

/** A toolId never contains whitespace; anything that does is intent prose. */
function asToolIdQuery(query: string): string | null {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0 || /\s/.test(normalized)) return null;
  return normalized;
}

/**
 * The manifest a toolId-shaped query names: an exact case-insensitive toolId
 * match, or — when there is no exact match — the single candidate the query
 * prefixes. An ambiguous prefix names nothing and leaves ranking alone.
 */
function resolvePinnedManifest(
  toolIdQuery: string,
  candidates: readonly ProtocolToolManifest[],
): ProtocolToolManifest | null {
  const exact = candidates.find((manifest) => manifest.toolId.toLowerCase() === toolIdQuery);
  if (exact) return exact;

  const prefixed = candidates.filter((manifest) => manifest.toolId.toLowerCase().startsWith(toolIdQuery));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

/**
 * Move the manifest named by a toolId-shaped query to rank 0 with
 * `whyMatched: ["toolId"]`. The relative order of every other row is preserved.
 * Returns `scored` unchanged when the query is not toolId-shaped or names no
 * single candidate.
 */
export function pinExactToolIdMatch(
  query: string,
  candidates: readonly ProtocolToolManifest[],
  scored: readonly ScoredManifest[],
): ScoredManifest[] {
  const toolIdQuery = asToolIdQuery(query);
  if (!toolIdQuery) return [...scored];

  const pinned = resolvePinnedManifest(toolIdQuery, candidates);
  if (!pinned) return [...scored];

  return [
    { manifest: pinned, score: PINNED_SCORE, whyMatched: ["toolId"] },
    ...scored.filter((entry) => entry.manifest.toolId !== pinned.toolId),
  ];
}
