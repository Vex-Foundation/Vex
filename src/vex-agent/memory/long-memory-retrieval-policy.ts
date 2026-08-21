/**
 * Long-memory RETRIEVAL policy (S3) — pure TS scoring, blend, and dual-trace
 * ranking. No DB, no embeddings, no I/O. Tested as plain unit tests.
 *
 * S3 surfaces TWO retrieval sources in ONE ranked list:
 *   - `long_memory`     — a promoted `knowledge_entries` row (the canonical
 *                         lesson). Scored by the existing knowledge `rerank`
 *                         BASE score × a SOURCE-TIER weight (so inferred /
 *                         hypothesis entries rank LOWER without being excluded —
 *                         genesis §951).
 *   - `memory_candidate` — a fresh `not_consolidated` dual-trace candidate.
 *                         Scored as `similarity × CANDIDATE_DUAL_TRACE_WEIGHT`
 *                         with NO boosts, gated by a minimum similarity and
 *                         capped — a SOFT signal, never a hard constraint
 *                         (genesis §247-272, §260).
 *
 * The two sources are scored by SEPARATE scorers (R1-#1): candidates are NEVER
 * pushed through the knowledge `rerank` (it drops non-`active` rows and assumes
 * numeric ids). The hard invariant `CANDIDATE_DUAL_TRACE_WEIGHT <
 * SOURCE_SOFT_WEIGHT ≤ 1` with candidates carrying no boosts GUARANTEES a
 * confirmed knowledge entry always outranks a candidate at equal raw similarity
 * (R1-#2). A much-higher-similarity fresh candidate may still surface.
 */

import { RECALL_MAX_K } from "@vex-agent/knowledge/policy.js";
import type { KnowledgeSource } from "@vex-agent/memory/long-memory-source-policy.js";
import type { MaturityState } from "@vex-agent/memory/schema/long-memory-enums.js";
import {
  ACTIVATION_MIN_FACTOR,
  ACTIVATION_MIN_FACTOR_PROVEN_BOUND,
  activationFactor,
} from "@vex-agent/memory/manager/maturity-policy.js";

// ── Constants (§4) ───────────────────────────────────────────────

/** Default `k` for `MemorySearch` when the caller omits it. */
export const LONG_MEMORY_DEFAULT_K = 8;

/** Hard upper bound on `k` — reuses the long-memory recall ceiling (one source of truth). */
export const LONG_MEMORY_MAX_K = RECALL_MAX_K;

/** Maximum number of entries returned inline in a search response. */
export const LONG_MEMORY_INLINE_CAP = 10;

/** Maximum total chars across all inline `contentMd` payloads (detailed format). */
export const LONG_MEMORY_INLINE_CHARS_CAP = 50_000;

/**
 * Source-tier de-weight for knowledge entries whose provenance is NOT a
 * confirmed observation. `observed` / `user_confirmed` → 1.0 (full weight);
 * `inferred` / `hypothesis` → this weight (ranked lower, never excluded).
 */
export const SOURCE_SOFT_WEIGHT = 0.7;

/**
 * Dual-trace de-weight for fresh candidates. STRICTLY below `SOURCE_SOFT_WEIGHT`
 * so the worst confirmed knowledge entry (a hypothesis at `× 0.7`) always beats
 * a candidate at the SAME raw similarity (`× 0.6`). Candidates carry NO boosts.
 */
export const CANDIDATE_DUAL_TRACE_WEIGHT = 0.6;

/** A candidate below this raw similarity is dropped — too weak to surface as a soft signal. */
export const LONG_MEMORY_CANDIDATE_MIN_SIMILARITY = 0.35;

/** Maximum number of candidates that may surface in one search. */
export const LONG_MEMORY_CANDIDATE_MAX = 3;

// ── Graph expansion (S8 / D-EXPAND) — tune, do not freeze ────────

/**
 * Per-hop confidence decay for a graph-expansion result (S8). A neighbor reached
 * through ONE entity hop scores `seed.score × GRAPH_HOP_DECAY × neighbor
 * factors` — strictly below its seed, so the graph ENRICHES results and never
 * dominates them (graph is the weakest of the three signals). 0.5 deliberately
 * avoids an accidental collision with CANDIDATE_DUAL_TRACE_WEIGHT (0.6) so the
 * two de-weights stay visually and numerically distinct. Tune, do not freeze.
 */
export const GRAPH_HOP_DECAY = 0.5;

/** Max blended ENTRY results used as expansion seeds (top of the ranked list). */
export const GRAPH_EXPANSION_MAX_SEEDS = 5;

/** Max seed/neighbor entities considered per expansion (and per-entity edge cap). */
export const GRAPH_EXPANSION_MAX_ENTITIES = 8;

/** Max graph-expansion results appended to one search response. */
export const GRAPH_EXPANSION_MAX_RESULTS = 5;

/** Max chars of the `viaEntity` marker name surfaced on an expansion result. */
export const GRAPH_VIA_ENTITY_MAX = 50;

// Import-time assert (S8): the hop decay MUST stay a strict de-weight in (0, 1).
// A decay ≥ 1 would let a 1-hop neighbor match or beat its seed — breaking the
// "graph enriches, never dominates" doctrine silently.
if (!(GRAPH_HOP_DECAY > 0 && GRAPH_HOP_DECAY < 1)) {
  throw new Error(
    `long-memory-retrieval-policy: invariant 0 < GRAPH_HOP_DECAY < 1 violated (got ${GRAPH_HOP_DECAY})`,
  );
}

// Compile-time + runtime assertion of the hard invariant
// `CANDIDATE_DUAL_TRACE_WEIGHT < SOURCE_SOFT_WEIGHT ≤ 1`. A future edit that
// breaks it would silently let a candidate outrank a confirmed entry.
if (
  !(
    CANDIDATE_DUAL_TRACE_WEIGHT < SOURCE_SOFT_WEIGHT &&
    SOURCE_SOFT_WEIGHT <= 1
  )
) {
  throw new Error(
    "long-memory-retrieval-policy: invariant CANDIDATE_DUAL_TRACE_WEIGHT < SOURCE_SOFT_WEIGHT ≤ 1 violated",
  );
}

// S6a (§7 / D-RERANK): activation enters the knowledge score as a BOUNDED
// multiplier `activationFactor(activation) ∈ [ACTIVATION_MIN_FACTOR, 1]`. The
// "confirmed > candidate" invariant needs the worst-tier knowledge entry (0.7) at
// activation 0 to still beat a max-similarity candidate (× 0.6):
//   0.7 × ACTIVATION_MIN_FACTOR ≥ CANDIDATE_DUAL_TRACE_WEIGHT.
// Assert it here (the value lives in maturity-policy.ts, which also self-checks
// MIN_FACTOR ≥ the proven 0.857 bound) so the dependency between the two modules'
// constants is verified at import time.
if (SOURCE_SOFT_WEIGHT * ACTIVATION_MIN_FACTOR < CANDIDATE_DUAL_TRACE_WEIGHT) {
  throw new Error(
    `long-memory-retrieval-policy: SOURCE_SOFT_WEIGHT (${SOURCE_SOFT_WEIGHT}) × ACTIVATION_MIN_FACTOR (${ACTIVATION_MIN_FACTOR}) < CANDIDATE_DUAL_TRACE_WEIGHT (${CANDIDATE_DUAL_TRACE_WEIGHT}) — activation de-weight would break "confirmed > candidate" (proven bound ${ACTIVATION_MIN_FACTOR_PROVEN_BOUND})`,
  );
}

// ── Source-discriminated result type ─────────────────────────────

/**
 * Provenance tiers eligible for FULL ranking weight. A knowledge entry whose
 * `source` is one of these keeps its raw rerank base score; everything else is
 * de-weighted by `SOURCE_SOFT_WEIGHT`.
 */
const FULL_WEIGHT_SOURCES: readonly KnowledgeSource[] = ["observed", "user_confirmed"];

/**
 * One blended retrieval result. Source-discriminated (R1-#1): a `long_memory`
 * result carries a numeric `knowledge_entries.id` + knowledge-only fields;
 * a `memory_candidate` result carries a UUID string id + `notConsolidated:true`.
 * Both carry `similarity` (raw cosine in [0,1]) and the final `score`.
 */
export type LongMemoryResult =
  | LongMemoryKnowledgeResult
  | LongMemoryCandidateResult;

/** A blended result sourced from a promoted `knowledge_entries` row. */
export interface LongMemoryKnowledgeResult {
  readonly source: "long_memory";
  /** `knowledge_entries.id` (serial integer). */
  readonly id: number;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly contentMd: string;
  /** Raw cosine similarity in [0,1]. */
  readonly similarity: number;
  /** Final blended score used for ordering (set by `blendAndRank`). */
  readonly score: number;
  /** Provenance tier — drives the source-tier de-weight. */
  readonly sourceTier: KnowledgeSource;
  readonly maturityState: MaturityState;
  /** 0..1 influence weight (S6a) — drives the BOUNDED rerank activation factor. */
  readonly activationStrength: number;
  readonly tags: readonly string[];
  readonly validUntil: string | null;
  /** Knowledge provenance refs (`knowledge_entries.source_refs`), surfaced under the unified output key. */
  readonly evidenceRefs: Record<string, unknown>;
  /** Knowledge `rerank` BASE score (similarity + boosts) — the de-weight multiplies this. */
  readonly rerankScore: number;
  /** S8 — present iff this result was reached via graph expansion, never direct recall. */
  readonly via?: "graph";
  /** S8 — the entity name (≤ GRAPH_VIA_ENTITY_MAX chars) the expansion hopped through. */
  readonly viaEntity?: string;
}

/** A blended result sourced from a fresh `not_consolidated` candidate. */
export interface LongMemoryCandidateResult {
  readonly source: "memory_candidate";
  /** `memory_candidates.id` (UUID string). */
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly contentMd: string;
  /** Raw cosine similarity in [0,1]. */
  readonly similarity: number;
  /** Final blended score used for ordering (set by `blendAndRank`). */
  readonly score: number;
  /** Always true — marks this as a soft, un-consolidated dual-trace signal. */
  readonly notConsolidated: true;
  /** Candidate provenance tier (de-weight does NOT apply — candidates are flat-weighted). */
  readonly sourceTier: KnowledgeSource;
  readonly tags: readonly string[];
  readonly evidenceRefs: readonly unknown[];
  /** Dual-trace TTL — when this un-consolidated signal stops surfacing, or null. */
  readonly retrievalUntil: string | null;
}

// ── Scorers (pure) ───────────────────────────────────────────────

/**
 * The knowledge-only inputs `scoreKnowledge` needs: the `rerank` BASE score
 * (already includes recency/confidence/pinned boosts), the provenance tier, and
 * the 0..1 activation strength (S6a influence weight).
 */
export interface KnowledgeScoreInput {
  readonly rerankScore: number;
  readonly sourceTier: KnowledgeSource;
  readonly activationStrength: number;
}

/**
 * Score a knowledge entry: `rerankScore × sourceTierWeight × activationFactor`.
 *   - `sourceTierWeight`: `observed`/`user_confirmed` → ×1.0; `inferred`/
 *     `hypothesis` → ×`SOURCE_SOFT_WEIGHT` (lower rank, never excluded).
 *   - `activationFactor`: BOUNDED in [ACTIVATION_MIN_FACTOR, 1] (S6a / §7) so a
 *     decayed lesson ranks below a reinforced one at equal base score WITHOUT
 *     ever dropping a confirmed entry under a candidate (the import-time assert
 *     above proves `worst tier × MIN_FACTOR ≥ candidate weight`).
 */
export function scoreKnowledge(input: KnowledgeScoreInput): number {
  return (
    input.rerankScore *
    sourceTierWeight(input.sourceTier) *
    activationFactor(input.activationStrength)
  );
}

/**
 * Source-tier weight shared by direct knowledge scoring and graph expansion:
 * `observed`/`user_confirmed` → ×1.0; `inferred`/`hypothesis` →
 * ×`SOURCE_SOFT_WEIGHT` (ranked lower, never excluded).
 */
export function sourceTierWeight(tier: KnowledgeSource): number {
  return (FULL_WEIGHT_SOURCES as readonly string[]).includes(tier) ? 1 : SOURCE_SOFT_WEIGHT;
}

/** The neighbor-side credibility inputs `graphScore` composes (S8 / D-EXPAND). */
export interface GraphNeighborScoreInput {
  readonly sourceTier: KnowledgeSource;
  readonly activationStrength: number;
}

/**
 * Score a graph-expansion neighbor (S8 / D-EXPAND): `seedScore ×
 * GRAPH_HOP_DECAY × tierWeight(neighbor) × activationFactor(neighbor)`.
 *
 * `seedScore` ALREADY contains the SEED's tier × activation (`scoreKnowledge`),
 * so the composition multiplies in the NEIGHBOR's credibility only — never the
 * seed factors twice. For any POSITIVE seed score the result is strictly below
 * it (decay < 1, both neighbor factors ≤ 1) — the property the import-time
 * assert above protects. Callers must skip seeds with score ≤ 0 (the strict
 * inequality is meaningless there).
 */
export function graphScore(seedScore: number, neighbor: GraphNeighborScoreInput): number {
  return (
    seedScore *
    GRAPH_HOP_DECAY *
    sourceTierWeight(neighbor.sourceTier) *
    activationFactor(neighbor.activationStrength)
  );
}

/**
 * Score a candidate: `similarity × CANDIDATE_DUAL_TRACE_WEIGHT`. NO recency /
 * confidence / pinned boosts — this is what guarantees a confirmed entry wins
 * at equal raw similarity (R1-#2).
 */
export function scoreCandidate(input: { readonly similarity: number }): number {
  return input.similarity * CANDIDATE_DUAL_TRACE_WEIGHT;
}

// ── Blend + rank (pure) ──────────────────────────────────────────

export interface BlendResult {
  /** Merged, score-DESC, stable-sorted list. */
  readonly results: LongMemoryResult[];
  /** Candidates dropped because they exceeded `LONG_MEMORY_CANDIDATE_MAX` after gating. */
  readonly droppedCandidates: number;
}

/**
 * Blend the two scored sources into one ranked list (pure):
 *   1. score knowledge with `scoreKnowledge`, candidates with `scoreCandidate`;
 *   2. gate candidates below `LONG_MEMORY_CANDIDATE_MIN_SIMILARITY`;
 *   3. cap surviving candidates to `LONG_MEMORY_CANDIDATE_MAX` (count the drop);
 *   4. merge + stable sort by score DESC.
 *
 * Inputs are the source rows WITHOUT a final `score` (it is computed here). The
 * candidate cap drop is RETURNED (not silently truncated). Stable sort: equal
 * scores keep input order (knowledge before candidates, both already in cosine
 * order from SQL).
 */
export function blendAndRank(
  knowledge: readonly Omit<LongMemoryKnowledgeResult, "score">[],
  candidates: readonly Omit<LongMemoryCandidateResult, "score">[],
): BlendResult {
  const scoredKnowledge: LongMemoryResult[] = knowledge.map((k) => ({
    ...k,
    score: scoreKnowledge({
      rerankScore: k.rerankScore,
      sourceTier: k.sourceTier,
      activationStrength: k.activationStrength,
    }),
  }));

  // Gate (min similarity) → order by raw similarity DESC for a deterministic cap
  // → take the strongest `LONG_MEMORY_CANDIDATE_MAX`; the rest are dropped+counted.
  const gated = candidates.filter(
    (c) => c.similarity >= LONG_MEMORY_CANDIDATE_MIN_SIMILARITY,
  );
  const orderedBySimilarity = [...gated].sort((a, b) => b.similarity - a.similarity);
  const kept = orderedBySimilarity.slice(0, LONG_MEMORY_CANDIDATE_MAX);
  const droppedCandidates = orderedBySimilarity.length - kept.length;

  const scoredCandidates: LongMemoryResult[] = kept.map((c) => ({
    ...c,
    score: scoreCandidate({ similarity: c.similarity }),
  }));

  // Merge knowledge-first so equal scores keep knowledge ahead of candidates.
  const merged = [...scoredKnowledge, ...scoredCandidates];

  // Stable sort by score DESC (Array.prototype.sort is stable in modern V8).
  merged.sort((a, b) => {
    if (b.score === a.score) return 0;
    return b.score - a.score;
  });

  return { results: merged, droppedCandidates };
}
