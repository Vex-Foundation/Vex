/**
 * Mission results ledger — read-only transport schemas for
 * `mission.listResults` / `mission.getResultForRun`.
 *
 * The ledger is written by the engine (migration 041 + capture hooks in
 * `engine/mission/mission-results-capture.ts`); these are the renderer-
 * facing reads for the Mission History view and the post-mission summary
 * card. Both queries are PER-WALLET — there is no "list every wallet's
 * missions" read.
 *
 * Naming: "mission result (ETH)", never "performance" — the number is an
 * honest ETH-denominated PnL record, not a guarantee of future results.
 * `stopReason` is the raw engine `StopReason` (mirrors
 * `src/vex-agent/engine/types.ts`); mapping it to a display outcome (e.g. a
 * reached time-box is not a failure) is a pure function in the renderer
 * model, never in this schema or in SQL.
 */

import { z } from "zod";

const MAX_RESULTS_LIMIT = 100;
const DEFAULT_RESULTS_LIMIT = 50;

/** Mirrors `mission_results.outcome` (migration 041) — the RAW run-level outcome. */
export const missionResultOutcomeSchema = z.enum([
  "running",
  "completed",
  "cancelled",
  "failed",
  "stopped",
]);
export type MissionResultOutcome = z.infer<typeof missionResultOutcomeSchema>;

/**
 * The mission's HARD CONSTRAINTS, as accepted — the operator's own limits,
 * read straight off `missions.constraints_json` / the allowlist columns.
 *
 * DETERMINISM IS THE WHOLE POINT. Every field here was WRITTEN by the
 * contract surface before the run started; none is inferred, paraphrased, or
 * re-read out of the agent's prose. The card renders these as chips
 * ("$5 cap · Robinhood · 5 min"), and a chip the operator did not set must
 * not appear — hence every field is nullable and the renderer OMITS rather
 * than defaults. A guessed cap is worse than no cap.
 */
export const missionConstraintFactsSchema = z
  .object({
    /** `constraints.maxSpendUsd` — the spend ceiling, in USD. */
    maxSpendUsd: z.number().nullable(),
    /** `constraints.maxLossUsd` — the loss ceiling, in USD. */
    maxLossUsd: z.number().nullable(),
    /** `constraints.maxIterations` — the agent's step budget. */
    maxIterations: z.number().int().nullable(),
    /** `constraints.deadlineAt` — the wall-clock time box. */
    deadlineAt: z.string().nullable(),
    /** `missions.allowed_chains` — the venue allowlist (e.g. `robinhood`). */
    allowedChains: z.array(z.string()),
    /** `missions.allowed_protocols` — the protocol allowlist. */
    allowedProtocols: z.array(z.string()),
  })
  .strict();
export type MissionConstraintFacts = z.infer<typeof missionConstraintFactsSchema>;

export const missionResultDtoSchema = z
  .object({
    missionRunId: z.string().min(1),
    /**
     * The run's session. Projected so the card can ask for THIS RUN's trades
     * (`portfolio.listMoves` is session-scoped and needs it); the ledger list
     * spans sessions, so it cannot be inferred from the surrounding view.
     */
    sessionId: z.string().min(1),
    seqNo: z.number().int().positive(),
    /**
     * 240-char display slice (see `mission-results-capture.ts`). Kept for
     * back-compat. NOT the source for the card's copy action — see `goalFull`.
     */
    goalSnippet: z.string().nullable(),
    /**
     * The operator's COMPLETE prompt, verbatim, from `missions.goal`.
     *
     * The card clamps the goal for reading but copies THIS to the clipboard,
     * so the operator can always recover exactly what was asked — no
     * truncation, no normalisation, no model in the loop. Null only when the
     * mission never carried a goal.
     */
    goalFull: z.string().nullable(),
    /** `missions.title` — short operator/setup-authored label, when present. */
    missionTitle: z.string().nullable(),
    /** Accepted hard limits; see `missionConstraintFactsSchema`. */
    constraints: missionConstraintFactsSchema,
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).nullable(),
    durationS: z.number().int().nullable(),
    bankrollStartEth: z.number().nullable(),
    bankrollEndEth: z.number().nullable(),
    pnlEth: z.number().nullable(),
    pnlPct: z.number().nullable(),
    ethPriceUsdEnd: z.number().nullable(),
    trades: z.number().int().nonnegative(),
    outcome: missionResultOutcomeSchema,
    /** Raw engine StopReason (e.g. "goal_reached", "deadline_reached"), or null. */
    stopReason: z.string().nullable(),
    openPositionsCount: z.number().int().nonnegative(),
    /**
     * The agent's own plain-language account of the run (`mission_stop`'s
     * `summary`), or null when it never stopped cleanly.
     *
     * PROSE ONLY. Every money figure the card shows is derived from the
     * numeric fields above — never parsed out of this string. See
     * `missionSummaryProse.ts`.
     */
    stopSummary: z.string().nullable(),
  })
  .strict();
export type MissionResultDto = z.infer<typeof missionResultDtoSchema>;

// ── listResults (per-wallet history, newest first) ──────────────

export const missionListResultsInputSchema = z
  .object({
    walletAddress: z.string().min(1),
    limit: z.number().int().min(1).max(MAX_RESULTS_LIMIT).optional(),
  })
  .strict();
export type MissionListResultsInput = z.infer<typeof missionListResultsInputSchema>;

export const missionListResultsResultSchema = z.array(missionResultDtoSchema);
export type MissionListResultsResult = z.infer<typeof missionListResultsResultSchema>;

export const DEFAULT_MISSION_RESULTS_LIMIT = DEFAULT_RESULTS_LIMIT;

// ── getResultForRun (single run, e.g. the post-mission summary card) ────

export const missionGetResultForRunInputSchema = z
  .object({
    missionRunId: z.string().min(1),
    walletAddress: z.string().min(1),
  })
  .strict();
export type MissionGetResultForRunInput = z.infer<typeof missionGetResultForRunInputSchema>;

export const missionGetResultForRunResultSchema = missionResultDtoSchema.nullable();
export type MissionGetResultForRunResult = z.infer<typeof missionGetResultForRunResultSchema>;

// ── getSessionResult (the session's newest run, for the in-session card) ──

/**
 * Session-scoped read powering the post-mission summary card in the session
 * view. The session view knows its session id and not a wallet address, so
 * this is deliberately NOT wallet-scoped like the two reads above — it
 * answers "what did the run in THIS session end up doing".
 */
export const missionGetSessionResultInputSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();
export type MissionGetSessionResultInput = z.infer<typeof missionGetSessionResultInputSchema>;

export const missionGetSessionResultResultSchema = missionResultDtoSchema.nullable();
export type MissionGetSessionResultResult = z.infer<typeof missionGetSessionResultResultSchema>;
