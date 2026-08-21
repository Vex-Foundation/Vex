/**
 * Long-memory recall scoring — pure TS, no DB, no embeddings.
 *
 * Scores SQL candidates by combined signal:
 *   score = similarity + recencyBoost + confidenceBoost + pinnedBoost
 *
 * Notable absence: NO `kindWeight`. Kinds grow organically (via
 * `MemorySuggest`) and the code does not pretend to know which kinds
 * matter more. Scoring is purely based on signal we actually own (vector
 * distance, freshness, recorded confidence rating, pinned flag).
 */

import type { KnowledgeStatus } from "./policy.js";

export interface RecallCandidate {
  id: number;
  kind: string;
  title: string;
  summary: string;
  contentMd: string;
  /** Cosine similarity in [0, 1]. Higher is better. */
  similarity: number;
  /** Agent-assigned 0..1 (optional). */
  confidence: number | null;
  status: KnowledgeStatus;
  pinned: boolean;
  validUntil: Date | null;
  validFrom: Date;
  updatedAt: Date;
  sourceRefs: Record<string, unknown>;
  tags: string[];
}

// ── Tunable boost weights ────────────────────────────────────────
// These are constants in source, not env-config. They are signal weights, not knobs.

/** Maximum recency boost added (entry just updated). */
const RECENCY_BOOST_MAX = 0.15;

/** Half-life for recency decay (after this many days, boost halves). */
const RECENCY_HALF_LIFE_DAYS = 7;

/** Maximum confidence boost (when confidence == 1.0). Linear with confidence. */
const CONFIDENCE_BOOST_MAX = 0.10;

/** Flat boost added when entry has pinned=true. */
const PINNED_BOOST = 0.20;

// ── Public API ───────────────────────────────────────────────────

/**
 * Compute the BASE recall score for a SINGLE candidate (`similarity + recency +
 * confidence + pinned`), without filtering or slicing. The S3 long-memory
 * blend uses this as its knowledge sub-list base score, then applies its own
 * source-tier de-weight on top. `now` defaults to `new Date()`.
 */
export function scoreRecallCandidate(c: RecallCandidate, now: Date = new Date()): number {
  return computeScore(c, now);
}

// ── Internals ────────────────────────────────────────────────────

function computeScore(c: RecallCandidate, now: Date): number {
  const similarity = clamp01(c.similarity);
  const recency = recencyBoost(c.updatedAt, now);
  const confidence = c.confidence !== null ? clamp01(c.confidence) * CONFIDENCE_BOOST_MAX : 0;
  const pinned = c.pinned ? PINNED_BOOST : 0;
  return similarity + recency + confidence + pinned;
}

function recencyBoost(updatedAt: Date, now: Date): number {
  const ageMs = Math.max(0, now.getTime() - updatedAt.getTime());
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  // exp decay: boost = MAX * 0.5^(ageDays / halfLife)
  const decay = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  return RECENCY_BOOST_MAX * decay;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
