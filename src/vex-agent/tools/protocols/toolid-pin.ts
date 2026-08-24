/**
 * Exact / unique-prefix NAME pin for `ToolSearch` query mode.
 *
 * Dense retrieval is an embedding-similarity search over capability prose, so a
 * query that IS a tool name ("dexscreener__pairs_search", "khalani.brid") is
 * exactly the case it handles worst — the model already knows the answer and
 * only needs the param schema back. This pre-step recognises that query and
 * puts the named manifest at rank 0; everything after it keeps the ranking
 * retrieval produced.
 *
 * BOTH IDENTITIES ARE MATCHED, and that is the point. A manifest has a durable
 * dotted `toolId` and a model-visible `publicName` (`./types.ts`), and the
 * model only ever SEES the latter — it is the only name reaching a provider
 * `tools` array. Matching `toolId` alone made the `query` schema's promise
 * ("an exact tool name you have already seen is returned first") false for
 * every name the model could actually have seen. The two are matched
 * SEPARATELY against their own fields, never derived from one another: the
 * projection is a table and is not invertible by string surgery (`types.ts`).
 *
 * Deliberately narrow (owner decision 2026-07-30): no hybrid retrieval, no
 * BM25, no new storage. A query containing whitespace is ordinary intent prose
 * and is never treated as a name.
 */

import type { ScoredManifest } from "./lexical-score.js";
import type { ProtocolToolManifest } from "./types.js";

/** Score assigned to a pinned row — above any cosine similarity. */
const PINNED_SCORE = 1;

/** Neither identity contains whitespace; anything that does is intent prose. */
function asNameQuery(query: string): string | null {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0 || /\s/.test(normalized)) return null;
  return normalized;
}

/** Which identity a pin matched on, reported to the model as match evidence. */
export type PinnedIdentity = "toolId" | "publicName";

interface PinnedMatch {
  manifest: ProtocolToolManifest;
  identity: PinnedIdentity;
}

/**
 * The manifest a name-shaped query names.
 *
 * Precedence, and each step preserves the original "ambiguous names nothing"
 * rule:
 *
 *   1. exact `toolId`;
 *   2. exact `publicName`;
 *   3. the single manifest the query prefixes, across BOTH identities.
 *
 * Exact beats prefix so a name that is also another name's prefix still
 * resolves to itself. Step 3 dedupes by manifest before counting, so a query
 * prefixing one tool's `toolId` AND that same tool's `publicName` is one
 * candidate, not an ambiguity; a query prefixing two DIFFERENT manifests names
 * nothing and leaves ranking untouched, exactly as before.
 */
function resolvePinnedManifest(
  nameQuery: string,
  candidates: readonly ProtocolToolManifest[],
): PinnedMatch | null {
  const exactToolId = candidates.find((manifest) => manifest.toolId.toLowerCase() === nameQuery);
  if (exactToolId) return { manifest: exactToolId, identity: "toolId" };

  const exactPublicName = candidates.find((manifest) => manifest.publicName.toLowerCase() === nameQuery);
  if (exactPublicName) return { manifest: exactPublicName, identity: "publicName" };

  const prefixed = candidates.filter(
    (manifest) =>
      manifest.toolId.toLowerCase().startsWith(nameQuery)
      || manifest.publicName.toLowerCase().startsWith(nameQuery),
  );
  if (prefixed.length !== 1) return null;

  const manifest = prefixed[0]!;
  return {
    manifest,
    identity: manifest.publicName.toLowerCase().startsWith(nameQuery) ? "publicName" : "toolId",
  };
}

/**
 * Move the manifest named by a name-shaped query to rank 0, with `whyMatched`
 * naming the identity that actually matched (`toolId` or `publicName`). The
 * relative order of every other row is preserved. Returns `scored` unchanged
 * when the query is not name-shaped or names no single candidate.
 *
 * `whyMatched` reports the REAL matched identity rather than a fixed `toolId`
 * literal: it is match evidence shown to the model, and telling it a query
 * matched a dotted id when it matched the callable name is exactly the kind of
 * self-report that must not become product truth.
 */
export function pinExactToolIdMatch(
  query: string,
  candidates: readonly ProtocolToolManifest[],
  scored: readonly ScoredManifest[],
): ScoredManifest[] {
  const nameQuery = asNameQuery(query);
  if (!nameQuery) return [...scored];

  const pinned = resolvePinnedManifest(nameQuery, candidates);
  if (!pinned) return [...scored];

  return [
    { manifest: pinned.manifest, score: PINNED_SCORE, whyMatched: [pinned.identity] },
    ...scored.filter((entry) => entry.manifest.toolId !== pinned.manifest.toolId),
  ];
}
