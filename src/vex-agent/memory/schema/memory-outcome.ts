/**
 * Memory v2 — `MemoryOutcomeSummary` Zod boundary schema (S5).
 *
 * The system-derived trade/decision outcome the memory_manager writes to
 * `memory_candidates.outcome` (JSONB) BEFORE promote. Shape = genesis §227-237
 * plus `pnlSource` (s5-plan §3) — an audit trail of WHICH ledger table the
 * outcome was derived from, WITHOUT any raw monetary value.
 *
 * RETIREMENT (Agent Scan W4, 2026-07): the ledger-derived resolver
 * (`outcome-resolver.ts`) that read realized PnL / position status / LP
 * cashflow to populate this shape is DELETED, along with the S7 reconcile
 * worker that re-derived it on a later closing trade. `consolidate.ts` now
 * writes ONLY the neutral placeholder (`status:"open"`,
 * `lessonSignal:"neutral"`, `evidenceQuality:"weak"`, `pnlSource:"none"`) for
 * every trade-family candidate — no code path derives a graded outcome from
 * the ledger anymore. This schema and every vocabulary member below STAY
 * (historical decisions / promoted `knowledge_entries.outcome_version` rows
 * reference the full range and must remain readable); each const below notes
 * which of its members no current writer produces. A later phase may inject
 * the session's own transaction list into the judge instead of resurrecting
 * this resolver — that phase is out of scope here.
 *
 * D-OUTCOME-SRC: the outcome is FACTS, never the agent's declaration.
 * D-DEREF/FIX-1: nothing here stores a `proj_*` SERIAL id — the outcome is
 * re-derivable from the immutable `protocol_executions.id` anchor, so it
 * stays replay-stable after a TRUNCATE+regenerate of the projection tables.
 *
 * `outcome` lives on `memory_candidates` as JSONB (no SQL CHECK on the nested
 * enums — s5-plan §3 gate-point 1: JSONB → Zod-only validation). This schema is
 * the SOLE validation boundary; the repo writes only Zod-validated values.
 *
 * Pure module: Zod schemas + derived types. No DB, no I/O.
 */

import { z } from "zod";

// ── Bounded vocabularies (mirror genesis §227-237 + pnlSource) ──────

/**
 * Lifecycle status of the resolved outcome. Since the Agent Scan W4 resolver
 * retirement, the only value any writer produces is `open` (the neutral
 * placeholder); `closed` was resolver-only, and `settled`/`failed`/
 * `invalidated` were reserved genesis vocabulary no writer ever produced even
 * before the retirement — all stay for historical-row readability.
 */
export const OUTCOME_STATUS = ["open", "closed", "settled", "failed", "invalidated"] as const;
export const outcomeStatusSchema = z.enum(OUTCOME_STATUS);
export type OutcomeStatus = z.infer<typeof outcomeStatusSchema>;

/**
 * Product family the anchored execution belongs to (genesis §229). The
 * `productType` field this backs was resolver-only (derived from
 * `proj_activity.product_type`) and is left unset by the neutral-placeholder
 * writer — every member here now describes historical rows exclusively.
 */
export const OUTCOME_PRODUCT_TYPE = [
  "spot",
  "perps",
  "prediction",
  "bridge",
  "order",
  "lp",
  "lend",
  "stake",
  "reward",
] as const;
export const outcomeProductTypeSchema = z.enum(OUTCOME_PRODUCT_TYPE);
export type OutcomeProductType = z.infer<typeof outcomeProductTypeSchema>;

/**
 * Direction of the lesson the outcome supports. `neutral` when undetermined —
 * the ONLY value the current neutral-placeholder writer produces. `positive`/
 * `negative` were resolver-only; `mixed` was reserved reconcile-policy vocabulary
 * describing an incoming comparison state, never itself written by the resolver.
 */
export const OUTCOME_LESSON_SIGNAL = ["positive", "negative", "mixed", "neutral"] as const;
export const outcomeLessonSignalSchema = z.enum(OUTCOME_LESSON_SIGNAL);
export type OutcomeLessonSignal = z.infer<typeof outcomeLessonSignalSchema>;

/**
 * How well the outcome is grounded in ledger facts (gates `strong` evidence).
 * The neutral-placeholder writer always produces `weak`; `medium`/`strong`
 * were resolver-only (position/lp → medium, closed spot → strong).
 */
export const OUTCOME_EVIDENCE_QUALITY = ["weak", "medium", "strong"] as const;
export const outcomeEvidenceQualitySchema = z.enum(OUTCOME_EVIDENCE_QUALITY);
export type OutcomeEvidenceQuality = z.infer<typeof outcomeEvidenceQualitySchema>;

/**
 * Who/what computed the outcome. `deterministic_replay` was reserved genesis
 * vocabulary for a replay mechanism that was never built (the deleted S7
 * reconcile worker also always stamped `memory_manager`) — every writer,
 * before and after the Agent Scan W4 resolver retirement, produces only
 * `memory_manager`.
 */
export const OUTCOME_COMPUTED_BY = ["memory_manager", "deterministic_replay"] as const;
export const outcomeComputedBySchema = z.enum(OUTCOME_COMPUTED_BY);
export type OutcomeComputedBy = z.infer<typeof outcomeComputedBySchema>;

/**
 * Which LEDGER TABLE the outcome was derived from — an audit trail of provenance
 * with NO raw monetary value (s5-plan §3). `none` = thin/uncovered venue or no
 * resolvable facts — since the Agent Scan W4 resolver retirement, this is the
 * ONLY value any writer produces; `pnl_matches`/`open_position`/`lp_events`
 * were resolver-only and now describe historical rows exclusively.
 */
export const OUTCOME_PNL_SOURCE = ["pnl_matches", "open_position", "lp_events", "none"] as const;
export const outcomePnlSourceSchema = z.enum(OUTCOME_PNL_SOURCE);
export type OutcomePnlSource = z.infer<typeof outcomePnlSourceSchema>;

// ── MemoryOutcomeSummary (genesis §227-237 + pnlSource) ─────────────

/**
 * The validated outcome written to `memory_candidates.outcome`. `.strict()`
 * rejects any unknown key so a stray `proj_*` SERIAL or raw monetary field can
 * never leak into the stored JSONB. `outcomeLastChangedAt` is an ISO 8601
 * stamp — reserved for a re-derivation bump (the deleted S7 reconcile worker
 * used to set it; the current neutral-placeholder writer leaves it absent).
 * Raw PnL/price/wallet values are DELIBERATELY absent — the outcome carries
 * the LESSON SIGNAL, not the numbers (genesis §667-671).
 */
export const memoryOutcomeSummarySchema = z
  .object({
    status: outcomeStatusSchema,
    productType: outcomeProductTypeSchema.optional(),
    lessonSignal: outcomeLessonSignalSchema,
    evidenceQuality: outcomeEvidenceQualitySchema,
    pointInTimeChecked: z.boolean(),
    outcomeComputedBy: outcomeComputedBySchema,
    outcomeVersion: z.number().int().min(0),
    outcomeLastChangedAt: z.iso.datetime().optional(),
    needsReconciliation: z.boolean().optional(),
    pnlSource: outcomePnlSourceSchema.optional(),
  })
  .strict();

export type MemoryOutcomeSummary = z.infer<typeof memoryOutcomeSummarySchema>;
