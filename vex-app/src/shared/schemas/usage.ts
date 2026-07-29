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
 * One row from `usage_log` mapped for the renderer. All token counts
 * are non-negative integers; `cost` is a JS number (DB column is
 * `NUMERIC` — the mapper parses safely or drops to `null` on overflow,
 * keeping JSON-serializable shape).
 */
export const turnUsageDtoSchema = z
  .object({
    sessionId: z.string().uuid(),
    promptTokens: z.number().int().min(0),
    completionTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    cachedTokens: z.number().int().min(0),
    reasoningTokens: z.number().int().min(0),
    /** `null` when the DB `NUMERIC` could not be coerced to a finite JS number. */
    cost: z.number().nullable(),
    /**
     * NET cache savings (read savings − write surcharge) for this turn.
     * Deliberately NO `.min(0)` — a write-heavy explicit-cache request
     * yields a real NEGATIVE net, and clamping it would turn every read of
     * such a session into a contract violation. `null` when the NUMERIC
     * could not be coerced.
     */
    cachedSavings: z.number().nullable(),
    cacheWriteTokens: z.number().int().min(0),
    currency: z.string().min(1).max(8),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type TurnUsageDto = z.infer<typeof turnUsageDtoSchema>;

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
     * real — see `turnUsageDtoSchema.cachedSavings`).
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
 * Result for `usage.getLastTurn` — `null` when the session has no
 * usage rows yet (mission setup hasn't produced a turn, or all rows
 * were reaped by retention). The renderer renders an empty chip then,
 * not an error toast.
 */
export const lastTurnUsageResultSchema = turnUsageDtoSchema.nullable();
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
