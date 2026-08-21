/**
 * Long-memory source provenance policy — pure TS constants, types, and helpers
 * describing knowledge-entry provenance tiers (`knowledge_entries.source`) and
 * which tiers are eligible for Active Memory hot-context injection.
 *
 * No DB, no embeddings, no I/O. Tested as plain unit tests.
 */

import { z } from "zod";

// ── Banner / state surface ──────────────────────────────────────

/** Maximum number of `kind` values shown in the Active Memory banner top-kinds line. */
export const KNOWLEDGE_BANNER_TOP_KINDS_LIMIT = 5;

// ── Knowledge source provenance ─────────────────────────────────

/**
 * Provenance tiers for `knowledge_entries.source` AND (reused) the
 * `memory_candidates.source` system-derived tier.
 *
 * SINGLE SOURCE OF TRUTH (rules/20 §4; N2): declared as an `as const` tuple so
 * `KnowledgeSource`, `knowledgeSourceSchema`, and the `mc_source_valid` SQL
 * CHECK can lockstep against ONE definition. Authoring order matches the SQL
 * `IN (...)` list. Behavior is unchanged from the prior hand-written union.
 */
export const KNOWLEDGE_SOURCES = [
  "observed",
  "user_confirmed",
  "inferred",
  "hypothesis",
] as const;

export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

/** Zod mirror of `KNOWLEDGE_SOURCES` for boundary validation + lockstep tests. */
export const knowledgeSourceSchema = z.enum(KNOWLEDGE_SOURCES);

/**
 * Sources eligible for Active Memory hot-context injection. Inferred and
 * hypothesis entries are still recallable via `MemorySearch` but never
 * auto-injected — they require deliberate retrieval by the agent.
 */
export const HOT_CONTEXT_SOURCES: readonly KnowledgeSource[] = [
  "observed",
  "user_confirmed",
] as const;

export function isKnowledgeSource(value: unknown): value is KnowledgeSource {
  return typeof value === "string"
    && (KNOWLEDGE_SOURCES as readonly string[]).includes(value);
}

export function isHotContextSource(source: KnowledgeSource): boolean {
  return (HOT_CONTEXT_SOURCES as readonly string[]).includes(source);
}
