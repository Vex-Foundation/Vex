/**
 * Long-memory suggest policy — pure deterministic system-field derivation for
 * the `MemorySuggest` boundary (S2).
 *
 * S2 stamps ONLY safe, deterministic values on an accepted candidate and defers
 * every nuanced judgement to the stages that consume them:
 *   - the authoritative `source` / `sensitivity` tier is re-derived by the async
 *     manager (S4) from the full transcript — the boundary uses a conservative
 *     floor here (memory-system/s2-plan.md §0 D-B / D-D);
 *   - HOW a not-consolidated candidate is surfaced / weighted is owned by the
 *     dual-trace reader (S3); S2 only sets the bounded TTL upper limit (D-C).
 *
 * Pure module: constants + total functions over primitives. No DB, no
 * embeddings, no I/O — unit-tested in isolation.
 */

import type {
  CandidateSensitivity,
} from "./schema/memory-candidate-enums.js";
import type { KnowledgeSource } from "./long-memory-source-policy.js";

/**
 * Dual-trace TTL upper bound (genesis §240): an accepted candidate's
 * not-consolidated trace stops surfacing `retrievalUntil = recordedAt + 7d`.
 * Named so the boundary, the schema, and the tests reference ONE value.
 */
export const CANDIDATE_DUAL_TRACE_TTL_DAYS = 7;

/** Milliseconds in one day — local constant so the TTL math has no magic number. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Source-tier FLOOR for every accepted candidate (D-B). The manager (S4) owns
 * the authoritative tier and re-derives it from the transcript; a `hypothesis`
 * floor can never poison hot context (§949 — `inferred` / `hypothesis` never
 * enter Active Memory), so deriving anything stronger here would be fake
 * authority. Always `'hypothesis'`.
 */
export function deriveCandidateSource(): KnowledgeSource {
  return "hypothesis";
}

/**
 * Sensitivity tier from the aggregate Tier-2 mask count (D-D). Tier-1 redact
 * already stripped real secrets and the ≥30% live-state reject already blocked
 * transient-value dumps, so the only residual in-text privacy marker is a masked
 * wallet / tx address: `maskCount > 0 ⇒ 'sensitive'`, else `'normal'`. S4's LLM
 * re-classifies with full context.
 */
export function deriveCandidateSensitivity(maskCount: number): CandidateSensitivity {
  return maskCount > 0 ? "sensitive" : "normal";
}

/**
 * Dual-trace retrieval cutoff: `recordedAt + CANDIDATE_DUAL_TRACE_TTL_DAYS`
 * (D-C). Returns a fresh `Date`; never mutates the input.
 */
export function computeRetrievalUntil(recordedAt: Date): Date {
  return new Date(recordedAt.getTime() + CANDIDATE_DUAL_TRACE_TTL_DAYS * MS_PER_DAY);
}

/**
 * Bounded reject-reason vocabulary advertised to `memLog`'s `rejectReason`
 * (enum) key. Two reasons:
 *   - `secret_or_live_state` — a Tier-1 secret OR a live-state aggregate over
 *     threshold (both collapse to one reason: the security boundary tripped,
 *     no row written — D-A).
 *   - `non_english` — the English-by-contract check (§10.4) rejected the
 *     persisted text; the agent is steered to rewrite the lesson in English.
 * Kept as a bounded `as const` tuple so values can never drift into free-text.
 */
export const SUGGEST_REJECT_REASONS = ["secret_or_live_state", "non_english"] as const;

export type SuggestRejectReason = (typeof SUGGEST_REJECT_REASONS)[number];
