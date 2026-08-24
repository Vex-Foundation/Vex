/**
 * `MemorySearch` graph expansion (step 7 / S8 / D-EXPAND, split out in
 * 0R.15, refactor-only): ONE hop over `memory_entities`/`memory_edges` from
 * the top blended seeds, bounded, score-decayed BELOW every seed, and marked
 * `via:'graph'`. Fills ONLY the inline slots the direct results left free.
 */

import { getActiveEntriesByIds } from "@vex-agent/db/repos/knowledge.js";
import {
  listEntityIdsForEntries,
  listEntryIdsForEntities,
} from "@vex-agent/db/repos/memory-entry-entities/index.js";
import { listActiveEdgesForEntities } from "@vex-agent/db/repos/memory-edges/index.js";
import {
  graphScore,
  GRAPH_EXPANSION_MAX_ENTITIES,
  GRAPH_EXPANSION_MAX_RESULTS,
  GRAPH_EXPANSION_MAX_SEEDS,
  GRAPH_VIA_ENTITY_MAX,
  LONG_MEMORY_INLINE_CAP,
  type LongMemoryResult,
  type LongMemoryKnowledgeResult,
} from "@vex-agent/memory/long-memory-retrieval-policy.js";

/** Injectable repo IO so the expansion is unit-testable without a database. */
export interface GraphExpansionDeps {
  listEntityIdsForEntries: typeof listEntityIdsForEntries;
  listActiveEdgesForEntities: typeof listActiveEdgesForEntities;
  listEntryIdsForEntities: typeof listEntryIdsForEntities;
  getActiveEntriesByIds: typeof getActiveEntriesByIds;
}

function defaultGraphExpansionDeps(): GraphExpansionDeps {
  return {
    listEntityIdsForEntries,
    listActiveEdgesForEntities,
    listEntryIdsForEntities,
    getActiveEntriesByIds,
  };
}

export interface GraphExpansion {
  /** Expansion results, graph-score DESC, already capped to the free slots. */
  results: LongMemoryKnowledgeResult[];
  /** Expansion results dropped by the remaining-slot / MAX_RESULTS cap. */
  dropped: number;
  /** Seeds that actually fed the expansion (0 ⇒ the graph was not touched). */
  seedCount: number;
}

export const EMPTY_EXPANSION: GraphExpansion = { results: [], dropped: 0, seedCount: 0 };

/**
 * Bounded fetch headroom over the result cap so dedupe vs already-returned ids
 * and duplicate per-entity links cannot starve the fill — still a hard bound
 * (never unbounded fan-out).
 */
const EXPANSION_ENTRY_FETCH_LIMIT = 4 * LONG_MEMORY_INLINE_CAP;

/**
 * ONE-hop graph expansion (S8 / D-EXPAND), post-blend pre-cap:
 *   seeds (top GRAPH_EXPANSION_MAX_SEEDS positive-score ENTRY results)
 *   → seed entities (cap GRAPH_EXPANSION_MAX_ENTITIES)
 *   → active valid-time edges (both directions, per-entity cap)
 *   → neighbor entities → their ACTIVE entries (dedupe vs already returned,
 *     cap min(remainingSlots, GRAPH_EXPANSION_MAX_RESULTS)).
 * Four batch queries total — zero N+1.
 *
 * Scoring: `graphScore(seed.score, neighbor)` — strictly below every positive
 * seed (the seed's own tier×activation already live in seed.score; only the
 * NEIGHBOR's credibility multiplies in). Seeds with score ≤ 0 are skipped
 * (Codex R1 — the strict inequality is meaningless for them). Results carry
 * `via:'graph'` + `viaEntity` and an EMPTY contentMd (bounded pointers — the
 * agent fetches full content via MemoryGet).
 */
export async function expandViaGraph(
  seedResults: readonly LongMemoryResult[],
  alreadyReturnedIds: ReadonlySet<number>,
  remainingSlots: number,
  deps: GraphExpansionDeps = defaultGraphExpansionDeps(),
): Promise<GraphExpansion> {
  if (remainingSlots <= 0) return EMPTY_EXPANSION;

  const seeds = seedResults
    .filter(
      (r): r is LongMemoryKnowledgeResult => r.source === "long_memory" && r.score > 0,
    )
    .slice(0, GRAPH_EXPANSION_MAX_SEEDS);
  if (seeds.length === 0) return EMPTY_EXPANSION;

  // 1. Seed entries → their entities (batch).
  const links = await deps.listEntityIdsForEntries(seeds.map((s) => s.id));
  if (links.length === 0) return { ...EMPTY_EXPANSION, seedCount: seeds.length };

  const seedScoreByEntry = new Map<number, number>();
  for (const s of seeds) {
    const prev = seedScoreByEntry.get(s.id);
    if (prev === undefined || s.score > prev) seedScoreByEntry.set(s.id, s.score);
  }

  // Per entity: the BEST seed score that reaches it (path certainty source).
  const seedEntityScore = new Map<string, number>();
  for (const link of links) {
    const score = seedScoreByEntry.get(link.entryId);
    if (score === undefined) continue;
    const prev = seedEntityScore.get(link.entityId);
    if (prev === undefined || score > prev) seedEntityScore.set(link.entityId, score);
  }
  const seedEntityIds = Array.from(seedEntityScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, GRAPH_EXPANSION_MAX_ENTITIES)
    .map(([id]) => id);

  // 2. Active valid-time edges, both directions (batch, per-entity cap).
  const edges = await deps.listActiveEdgesForEntities(
    seedEntityIds,
    GRAPH_EXPANSION_MAX_ENTITIES,
  );
  const seedEntitySet = new Set(seedEntityIds);
  const neighborScore = new Map<string, number>();
  const propagate = (fromSeedEntity: string, toNeighbor: string): void => {
    const score = seedEntityScore.get(fromSeedEntity);
    if (score === undefined) return;
    const prev = neighborScore.get(toNeighbor);
    if (prev === undefined || score > prev) neighborScore.set(toNeighbor, score);
  };
  for (const edge of edges) {
    const sourceSeeded = seedEntitySet.has(edge.sourceEntityId);
    const targetSeeded = seedEntitySet.has(edge.targetEntityId);
    if (sourceSeeded && !targetSeeded) propagate(edge.sourceEntityId, edge.targetEntityId);
    else if (targetSeeded && !sourceSeeded) propagate(edge.targetEntityId, edge.sourceEntityId);
    // Both endpoints seeded → no NEW neighbor; nothing to expand through.
  }
  if (neighborScore.size === 0) return { ...EMPTY_EXPANSION, seedCount: seeds.length };

  const neighborEntityIds = Array.from(neighborScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, GRAPH_EXPANSION_MAX_ENTITIES)
    .map(([id]) => id);

  // 3. Neighbor entities → their ACTIVE entries (batch; bounded headroom).
  const refs = await deps.listEntryIdsForEntities(
    neighborEntityIds,
    EXPANSION_ENTRY_FETCH_LIMIT,
  );
  const viaByEntry = new Map<number, { seedScore: number; entityName: string }>();
  for (const ref of refs) {
    if (alreadyReturnedIds.has(ref.entryId)) continue; // dedupe vs direct hits
    const score = neighborScore.get(ref.entityId);
    if (score === undefined) continue;
    const prev = viaByEntry.get(ref.entryId);
    if (prev === undefined || score > prev.seedScore) {
      viaByEntry.set(ref.entryId, { seedScore: score, entityName: ref.entityName });
    }
  }
  if (viaByEntry.size === 0) return { ...EMPTY_EXPANSION, seedCount: seeds.length };

  // 4. Entry DTOs (active + non-expired in SQL — the S3 invariant holds).
  const entries = await deps.getActiveEntriesByIds(Array.from(viaByEntry.keys()));
  const scored: LongMemoryKnowledgeResult[] = [];
  for (const entry of entries) {
    // Every requested id has a via-path by construction; an unrequested row
    // (anomalous repo behavior) is SKIPPED, never emitted with a zero score.
    const via = viaByEntry.get(entry.id);
    if (via === undefined) continue;
    scored.push({
      source: "long_memory" as const,
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      summary: entry.summary,
      // Bounded pointer — expansion never inlines full content; the agent
      // fetches it via MemoryGet when the lead matters.
      contentMd: "",
      similarity: 0,
      score: graphScore(via.seedScore, {
        sourceTier: entry.source,
        activationStrength: entry.activationStrength,
      }),
      sourceTier: entry.source,
      maturityState: entry.maturityState,
      activationStrength: entry.activationStrength,
      tags: [],
      validUntil: entry.validUntil,
      evidenceRefs: {},
      rerankScore: 0,
      via: "graph" as const,
      viaEntity: via.entityName.slice(0, GRAPH_VIA_ENTITY_MAX),
    });
  }
  scored.sort((a, b) => b.score - a.score);

  const take = Math.min(remainingSlots, GRAPH_EXPANSION_MAX_RESULTS);
  return {
    results: scored.slice(0, take),
    dropped: Math.max(0, scored.length - take),
    seedCount: seeds.length,
  };
}
