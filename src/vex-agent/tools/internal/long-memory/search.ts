/**
 * MemorySearch handler (S3) — the agent's high-level cross-session recall.
 * Hides the strategy (vector + dual-trace + rerank) behind one tool (genesis
 * §398). Ordered, fail-loud, IO only at the edges:
 *
 *   1. validate input (Zod) — query/k/kind/response_format/include_candidates/
 *      expand_graph. NO `scope` (R1-#5): S3 always returns active + non-expired.
 *   2. embedQuery → { embedding, providerModel }. providerModel + embedding.length
 *      are the recall filter for BOTH stores (write/read consistency).
 *   3. long-memory recall WITH `source` (recallLongMemoryTopK, includeExpired:false).
 *   4. dual-trace candidate recall (recallCandidatesTopK) when include_candidates.
 *   5. blendAndRank — knowledge scored by rerank-base × source-tier weight,
 *      candidates by similarity × 0.6 (no boosts); gated + capped; merged.
 *   6. inline-only cap of DIRECT results: LONG_MEMORY_INLINE_CAP / _CHARS_CAP,
 *      truncate-with-steering (no silent drop — R1-#3), emit search.truncated.
 *   7. graph expansion (S8, expand_graph default ON): 1 hop over
 *      memory_entities/memory_edges from the top blended seeds, bounded +
 *      score-decayed BELOW every seed, marked via:'graph'. Fills ONLY the
 *      remaining inline slots — never evicts a direct result. Fail-open: an
 *      expansion error never fails the search.
 *   8. format per response_format (concise | detailed) — expansion results
 *      carry a `via_graph(entity)` marker.
 *
 * This file is the public entry point; the stages live in `./search/` (0R.15
 * facade split, refactor-only): `input.ts` (1), `recall.ts` (2–4),
 * `format.ts` (6 + 8), `graph-expansion.ts` (7).
 *
 * Boundary discipline: imports the memory module + repos only — never renderer,
 * wallet, or signing authority. `fail(msg)` IS the agent's steering channel.
 */

import { memLog } from "@vex-agent/memory/observability/logger.js";
import {
  blendAndRank,
  LONG_MEMORY_INLINE_CAP,
  type LongMemoryResult,
} from "@vex-agent/memory/long-memory-retrieval-policy.js";

import type { ToolResult } from "../../types.js";
import type { InternalToolContext } from "../types.js";
import { ok, fail } from "../types.js";
import { ALLOWED_SEARCH_PARAMS, firstIssueMessage, mapAndValidate } from "./search/input.js";
import { recallLongMemory } from "./search/recall.js";
import { capInline, toConcise, toDetailed } from "./search/format.js";
import { EMPTY_EXPANSION, expandViaGraph, type GraphExpansion } from "./search/graph-expansion.js";

export {
  expandViaGraph,
  type GraphExpansion,
  type GraphExpansionDeps,
} from "./search/graph-expansion.js";

// ── Steering messages (agent-facing) ─────────────────────────────

const NOTHING_FOUND_MESSAGE =
  "No long-term memory matched this query. Nothing has been stored yet that is relevant — proceed without it, or refine the query and try again.";

/**
 * Emitted ONLY when graph expansion was attempted and failed. The search still
 * succeeds on its direct results (documented fail-open), so the marker exists
 * to stop the narrower set from reading as "nothing else is connected".
 */
const EXPANSION_DEGRADED_NOTE =
  "Related-memory graph expansion failed this turn, so these are direct matches only — entries connected through the memory graph are missing from this result. The direct recall itself succeeded; retry the search if those connected leads matter.";

// ── Handler ──────────────────────────────────────────────────────

export async function handleLongMemorySearch(
  params: Record<string, unknown>,
  _context: InternalToolContext,
): Promise<ToolResult> {
  const startedAt = Date.now();

  // 1. Validate. Reject unknown params (a typo or a removed param like `scope`
  // must not be silently ignored — final-gate fix).
  const unknownParams = Object.keys(params).filter(
    (key) => !(ALLOWED_SEARCH_PARAMS as readonly string[]).includes(key),
  );
  if (unknownParams.length > 0) {
    return fail(
      `MemorySearch rejected the input — unknown parameter(s): ${unknownParams.join(", ")}. Allowed: ${ALLOWED_SEARCH_PARAMS.join(", ")}.`,
    );
  }
  const mapResult = mapAndValidate(params);
  if (!mapResult.ok) {
    return fail(`MemorySearch rejected the input — ${firstIssueMessage(mapResult.error)}`);
  }
  const input = mapResult.input;

  // 2 + 3 + 4. Embed and recall both stores under the SAME provider/dim filter.
  const recall = await recallLongMemory(input);
  if (!recall.ok) return recall.result;
  const { knowledgeResults, candidateResults } = recall;

  // 5. Blend + rank (pure).
  const blended = blendAndRank(knowledgeResults, candidateResults);

  // 6. Inline-only cap of DIRECT results + truncate-with-steering (no silent
  // drop — R1-#3). Chars cap applies only to detailed (concise omits contentMd)
  // — final-gate fix.
  const direct = capInline(blended.results, input.responseFormat === "detailed");

  // 7. Graph expansion (S8 / D-EXPAND, default ON — F3): fills ONLY the inline
  // slots the direct results left free — it NEVER evicts a direct result.
  // Dedupe is against EVERY directly-recalled entry (returned or truncated),
  // so a truncated direct hit can never resurface mislabeled as a graph lead
  // (that would bypass the truncation steering). Fail-open: an expansion error
  // never fails the search (graph is help, not truth).
  let expansion: GraphExpansion = EMPTY_EXPANSION;
  let expansionDegraded = false;
  if (input.expandGraph) {
    const directKnowledgeIds = new Set<number>();
    for (const r of blended.results) {
      if (r.source === "long_memory") directKnowledgeIds.add(r.id);
    }
    const remainingSlots = LONG_MEMORY_INLINE_CAP - direct.inline.length;
    try {
      expansion = await expandViaGraph(blended.results, directKnowledgeIds, remainingSlots);
      memLog("search", "graph_expanded", {
        expandedCount: expansion.results.length,
        seedCount: expansion.seedCount,
      });
    } catch {
      memLog.warn("search", "graph_expansion_failed", { errorKind: "expansion_error" });
      expansion = EMPTY_EXPANSION;
      // The fail-open stays (graph is help, not truth) but stops being SILENT:
      // without this the model sees a narrower set with no explanation and
      // reads it as "nothing else is connected" (report §4, SPEC 0R.15).
      expansionDegraded = true;
    }
  }

  const inline: LongMemoryResult[] = [...direct.inline, ...expansion.results];
  // droppedCount split (S8): direct truncation vs expansion-cap drops are
  // reported separately — neither is silent.
  const droppedDirect = direct.dropped;
  const droppedExpansion = expansion.dropped;
  const dropped = droppedDirect + droppedExpansion;

  const candidateCount = candidateResults.length;
  memLog("search", "candidates", { count: candidateCount });
  if (droppedDirect > 0) memLog("search", "truncated", { count: droppedDirect });
  if (droppedExpansion > 0) {
    memLog("search", "graph_expansion_truncated", { count: droppedExpansion });
  }
  memLog("search", "served", { count: inline.length, durationMs: Date.now() - startedAt });

  // 8. Format + steering.
  if (inline.length === 0) {
    return fail(NOTHING_FOUND_MESSAGE);
  }

  const items =
    input.responseFormat === "detailed" ? inline.map(toDetailed) : inline.map(toConcise);

  const steering =
    dropped > 0
      ? `showing top ${inline.length} of ${inline.length + dropped} — refine your query for more`
      : undefined;

  return ok({
    count: inline.length,
    truncated: dropped > 0,
    ...(dropped > 0
      ? { droppedCount: dropped, droppedDirect, droppedExpansion, steering }
      : {}),
    ...(expansionDegraded ? { expansionDegraded: true, expansionNote: EXPANSION_DEGRADED_NOTE } : {}),
    candidateCount,
    droppedCandidates: blended.droppedCandidates,
    results: items,
  });
}
