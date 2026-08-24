/**
 * Usage schemas — last-turn + session totals from the `usage_log` table.
 *
 * Renderer surfaces the session runtime bar (global model + usage +
 * context) and a per-session totals tooltip. Currency defaults to `USD`;
 * legacy rows that predate the column carry `null` provider/model so the
 * DTO is `nullable` for both.
 *
 * Field names match the canonical refs vocabulary in
 * `BUG-REPORTING.md §3` so Phase 2 BugReportSink can stamp refs without
 * a mapper (`sessionId`, `correlationId` if/when added).
 */

import { z } from "zod";

export const USAGE_DEFAULT_CURRENCY = "USD";

/**
 * Aggregated totals for one session, filtered by currency. The DB query
 * sums per-row counts/cost and returns `requestCount` + the latest
 * `created_at`. Empty sessions resolve to all-zero counts with
 * `lastRequestAt: null` (read-only handler never returns an error
 * shape for "no rows" — that's a normal session state).
 */
export const sessionUsageTotalsDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    totalPromptTokens: z.number().int().min(0),
    totalCompletionTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    totalCachedTokens: z.number().int().min(0),
    totalCost: z.number().nullable(),
    /**
     * Session-summed NET cache savings. NO `.min(0)` (negative net is
     * real - see `turnUsageRollupDtoSchema.turnCachedSavings`).
     */
    totalCachedSavings: z.number().nullable(),
    currency: z.string().min(1).max(8),
    requestCount: z.number().int().min(0),
    lastRequestAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type SessionUsageTotalsDto = z.infer<typeof sessionUsageTotalsDtoSchema>;

export const usageInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    currency: z.string().min(1).max(8).default(USAGE_DEFAULT_CURRENCY),
  })
  .strict();
export type UsageInput = z.infer<typeof usageInputSchema>;

/**
 * Usage for ONE TURN, aggregated across every model round that turn ran.
 *
 * ## Why this is not a `usage_log` row
 *
 * A "turn" in this engine is a LOOP: `runTurnLoop` performs up to
 * `maxIterations` model round-trips and `executeTurn` writes one `usage_log`
 * row per round. Reading the newest row therefore describes the LAST ROUND, not
 * the turn, and under-reported a real multi-round turn by roughly the round
 * count - the reported v0.2.6 case displayed `OUT 1 / $0.0405` for a turn that
 * had run fifty rounds. Rule 90 forbids shipping a false money figure on a
 * user-facing surface, so the panel aggregates.
 *
 * ## What each number means, and why the two sides differ
 *
 * INPUT is a SNAPSHOT of the newest round. Every round re-sends the whole
 * growing conversation, so summing prompt tokens across rounds would count the
 * same conversation repeatedly and produce a number that means nothing.
 * `latestRound*` is the honest input measurement: the size of the last request
 * this turn issued.
 *
 * OUTPUT, COST and cache savings are RUNNING SUMS across the turn's rounds.
 * Each round's completion tokens are new tokens actually generated and actually
 * billed, and tool-call arguments are part of them (the provider bills them as
 * completion tokens; this code has never had a separate bucket for them), so
 * summing is the only correct answer for what the turn spent.
 *
 * Same split VS Code's chat model uses (`chatModel.ts`: `promptTokens`
 * latest-call, `completionTokens` running total).
 *
 * `roundCount` makes the aggregation legible rather than implicit: the reader
 * can see the figures cover N rounds, not one.
 */
export const turnUsageRollupDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    /** SNAPSHOT: prompt tokens of the turn's most recent round. Never summed. */
    latestRoundPromptTokens: z.number().int().min(0),
    /**
     * SNAPSHOT: cached prompt tokens of that SAME round. Cache-hit share is a
     * property of one request's prompt, so it must come from the same round as
     * `latestRoundPromptTokens` or the percentage divides two unrelated
     * measurements.
     */
    latestRoundCachedTokens: z.number().int().min(0),
    /** RUNNING SUM: completion tokens generated across every round of the turn. */
    turnCompletionTokens: z.number().int().min(0),
    /** RUNNING SUM: reasoning tokens across every round of the turn. */
    turnReasoningTokens: z.number().int().min(0),
    /** RUNNING SUM: cache-write tokens across every round of the turn. */
    turnCacheWriteTokens: z.number().int().min(0),
    /**
     * RUNNING SUM of every round's cost. `null` when the DB `NUMERIC` could not
     * be coerced to a finite JS number - a missing measurement is never printed
     * as `$0`.
     */
    turnCost: z.number().nullable(),
    /**
     * RUNNING SUM of NET cache savings (read savings − write surcharge).
     * Deliberately NO `.min(0)`: a write-heavy explicit-cache turn yields a real
     * negative net, and clamping would make honest data a contract violation.
     */
    turnCachedSavings: z.number().nullable(),
    /** How many model round-trips these figures cover. Always >= 1. */
    roundCount: z.number().int().min(1),
    currency: z.string().min(1).max(8),
    /** Provider/model of the most recent round (a turn can fail over mid-run). */
    provider: z.string().nullable(),
    model: z.string().nullable(),
    /** `created_at` of the most recent round in the turn. */
    latestRoundAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type TurnUsageRollupDto = z.infer<typeof turnUsageRollupDtoSchema>;

/**
 * Result for `usage.getLastTurn` — `null` when the session has no
 * usage rows yet (mission setup hasn't produced a turn, or all rows
 * were reaped by retention). The renderer renders an empty chip then,
 * not an error toast.
 *
 * The channel name is unchanged and is now ACCURATE: it returns the last TURN,
 * where it used to return the last round.
 */
export const lastTurnUsageResultSchema = turnUsageRollupDtoSchema.nullable();
export type LastTurnUsageResult = z.infer<typeof lastTurnUsageResultSchema>;

/**
 * Input for `usage.getContextWindow`. Session-scoped only — the context
 * limit itself is global runtime config, not a per-session value.
 */
export const contextWindowInputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();
export type ContextWindowInput = z.infer<typeof contextWindowInputSchema>;

/**
 * Context-window meter for a session: tokens consumed vs the global
 * model context limit.
 *
 *  - `tokensUsed` mirrors the engine's `sessions.token_count` — the
 *    prompt size of the most recent turn. It lags the live transcript by
 *    one turn (the engine stamps it before the next turn runs), so the
 *    renderer labels it as an approximate pressure indicator.
 *  - `contextLimit` is the effective `AGENT_CONTEXT_LIMIT` the engine
 *    uses for pressure bands. `null` when the configured value is invalid
 *    (the engine would reject it) — the renderer then shows the token
 *    count without a limit bar instead of a fabricated default.
 *  - `pressureWarningFraction` / `pressureBarrierFraction` /
 *    `pressureCriticalFraction` are the ENGINE's own context-pressure band
 *    edges (`src/vex-agent/engine/core/context-pressure-policy.ts`), read by
 *    main and carried here so the renderer's meter markers can never drift
 *    from the thresholds that actually gate compaction. The renderer MUST
 *    NOT hardcode them.
 *
 * ADDITIVE + OPTIONAL. The three fractions are optional so a payload minted
 * by an older main still parses (both sides validate this DTO); a consumer
 * that does not see them simply draws no markers rather than inventing
 * positions.
 */
export const contextWindowDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    tokensUsed: z.number().int().min(0),
    contextLimit: z.number().int().positive().nullable(),
    pressureWarningFraction: z.number().gt(0).lte(1).optional(),
    pressureBarrierFraction: z.number().gt(0).lte(1).optional(),
    pressureCriticalFraction: z.number().gt(0).lte(1).optional(),
  })
  .strict();
export type ContextWindowDto = z.infer<typeof contextWindowDtoSchema>;

/**
 * Result for `usage.getContextWindow` — `null` when the session is
 * unknown, soft-deleted, or outside the app scope. No fabricated
 * `0 / limit` meter for a session that does not exist.
 */
export const contextWindowResultSchema = contextWindowDtoSchema.nullable();
export type ContextWindowResult = z.infer<typeof contextWindowResultSchema>;
