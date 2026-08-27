/**
 * BOARD SPARKLINE - the IPC contract for the price line on a board card.
 *
 * WHAT A SPARKLINE IS HERE. Fifty recent candles, drawn as a line with an area
 * fill and no axes, in the right third of a card's price row. It is decoration
 * with a job: it tells the reader whether the number above it arrived by
 * climbing or by falling. It is NOT the spotlight chart, which is a separate
 * channel with its own resolution pills and its own reconciliation contract.
 *
 * ONE REQUEST FOR A WHOLE BOARD, and that is the design rather than a
 * convenience. The pipeline that answers it owns a progressive queue, a global
 * deadline and a concurrency ceiling shared with the agent, and none of those
 * can be owned by a renderer issuing eight independent invocations. The
 * renderer names pools and a resolution; every bound is main's.
 *
 * PARTIAL IS A FIRST-CLASS ANSWER. Each pool carries its OWN outcome, so a
 * board whose deadline expired after five pools returns five series and three
 * typed absences rather than failing whole. A card with no series draws its
 * price row without a line, which is a designed state, not an error.
 *
 * MONEY IS TEXT. The series reuses the board's own `boardCandleSeriesSchema`,
 * whose prices are decimal STRINGS, so a sparkline and a persisted chart are
 * the same shape produced the same way and a card cannot change precision
 * depending on which one drew it.
 */

import { z } from "zod";
import {
  BOARD_CHART_RESOLUTIONS,
  BOARD_MAX_POOLS,
  boardCandleSeriesSchema,
  boardPoolInputSchema,
} from "@vex-lib/board/index.js";

/**
 * The pool a sparkline is about: the same POSITIVE PICK the live and details
 * channels take. Identity crosses; the pool document does not.
 */
export const boardSparklineSubjectSchema = boardPoolInputSchema
  .pick({ chain: true, pairAddress: true })
  .strict();
export type BoardSparklineSubject = z.infer<typeof boardSparklineSubjectSchema>;

/**
 * One pool's outcome. Three families, deliberately not collapsed.
 *
 *  - `series`      the provider answered and this is the line;
 *  - `absent`      settled: this pool has no drawable line right now;
 *  - `unavailable` unknown: nothing was learned, and asking again may work.
 *
 * `no_drawable_bars` is an ABSENCE rather than a failure: a pool minutes old,
 * or one whose bars carry no USD price, genuinely has no line to draw, and a
 * card that said "could not load" about it would be describing a provider
 * problem that did not happen.
 */
export const boardSparklineOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("series"), series: boardCandleSeriesSchema })
    .strict(),
  z
    .object({
      kind: z.literal("absent"),
      reason: z.enum(["no_drawable_bars", "unknown_pair"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      /**
       * `deadline` is the board-wide budget expiring before this pool's turn,
       * and it is told apart from a transport failure on purpose: the pool was
       * never asked, so nothing is known about it and a retry is cheap.
       */
      reason: z.enum([
        "transport",
        "provider",
        "deadline",
        "cancelled",
        "not_mounted",
      ]),
    })
    .strict(),
]);
export type BoardSparklineOutcome = z.infer<typeof boardSparklineOutcomeSchema>;

export const boardSparklineHydrateInputSchema = z
  .object({
    pools: z.array(boardSparklineSubjectSchema).min(1).max(BOARD_MAX_POOLS),
    /**
     * The candle resolution. The renderer picks from the frozen board
     * vocabulary and nothing else: it cannot name a provider resolution string,
     * a bar count, a deadline or a transport.
     */
    resolution: z.enum(BOARD_CHART_RESOLUTIONS),
  })
  .strict();
export type BoardSparklineHydrateInput = z.infer<
  typeof boardSparklineHydrateInputSchema
>;

/**
 * One entry per requested pool, in the order asked, keyed by identity anyway.
 *
 * Ordered AND keyed because the two protect against different mistakes: the
 * order makes the answer readable, and the key is what a consumer pairs on, so
 * a reordering can never draw one pool's line on another pool's card.
 */
export const boardSparklineEntrySchema = z
  .object({
    key: z.string().min(3).max(200),
    subject: boardSparklineSubjectSchema,
    outcome: boardSparklineOutcomeSchema,
  })
  .strict();
export type BoardSparklineEntry = z.infer<typeof boardSparklineEntrySchema>;

export const boardSparklineHydrateResultSchema = z
  .object({
    entries: z.array(boardSparklineEntrySchema).min(1).max(BOARD_MAX_POOLS),
    /**
     * Whether the board-wide deadline expired before every pool was read.
     *
     * A REPORTED BOUND, never a silent one: the entries say exactly which pools
     * were not reached and this says why, so a caller can ask again for those
     * rather than wondering whether the board simply has no lines.
     */
    deadlineHit: z.boolean(),
  })
  .strict();
export type BoardSparklineHydrateResult = z.infer<
  typeof boardSparklineHydrateResultSchema
>;
