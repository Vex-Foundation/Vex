/**
 * BOARD CHART - the IPC contract for the SPOTLIGHT's candle chart.
 *
 * WHAT THIS CHANNEL IS. One pool, one resolution pill, one fresh page of bars.
 * It is the view-time feed behind the spotlight's area chart and it is NOT the
 * persisted analyst chart: a composed board carries its own candles and its own
 * `marketDataFetchedAt`, and nothing here edits that document. Leaving the
 * spotlight ends this channel and the board goes back to what it was composed
 * with.
 *
 * FOUR PILLS AND NOTHING ELSE. The owner's mockup offers 1H, 24H, 7D and 30D,
 * which the chart contract maps to `1m`, `15m`, `2h` and `8h`. This channel
 * accepts exactly those four by POSITIVE PICK. It deliberately does not accept
 * the board's full eighteen-member resolution vocabulary: the bar counts, the
 * poll cadences and the live smoke behind this surface were all measured for
 * four buckets, and a renderer that could name `1s` would be asking for a
 * resolution nobody sized a window, a cadence or a politeness budget for.
 *
 * THE RENDERER HOLDS NO OTHER KNOB. There is no host, route, bar count,
 * deadline, cadence, transport or series selector on this input, because every
 * one of those is a constant in `main/market/board-chart-service.ts`. A channel
 * with two fields and a closed enum is a channel a compromised renderer cannot
 * turn.
 *
 * ABSENCE AND UNAVAILABILITY ARE SUCCESSES, exactly as on the sibling board
 * channels: a pool minutes old genuinely has no line, and the chart must render
 * its own honest empty state rather than an error dialog. A `Result` error here
 * means only invalid input, an untrusted sender, or cancellation.
 *
 * MONEY IS TEXT. The series reuses the board's own `boardCandleSeriesSchema`,
 * whose prices are decimal STRINGS, so the spotlight chart, a card's sparkline
 * and a persisted board chart are the same shape produced the same way.
 */

import { z } from "zod";
import {
  BOARD_CHART_RESOLUTIONS,
  BOARD_DECIMAL_MAX_CHARS,
  boardCandleSeriesSchema,
  boardPoolInputSchema,
} from "@vex-lib/board/index.js";

/**
 * A per-bar USD volume as the provider spells it: a non-negative decimal
 * string, never a float. The same grammar the board's own candle legs use
 * (`src/lib/board/spec.ts`), restated here because that module keeps its
 * decimal primitive private and its persisted candle schema is deliberately
 * NOT extended: volume travels on this live channel only.
 */
const volumeDecimalString = z
  .string()
  .max(BOARD_DECIMAL_MAX_CHARS)
  .regex(
    /^[0-9]+(\.[0-9]+)?$/,
    "must be a non-negative decimal number written as digits, optionally with a single decimal point",
  );

/**
 * The four resolutions the spotlight's pills select, in pill order.
 *
 * 1H, 24H, 7D, 30D. Every member is a member of
 * {@link BOARD_CHART_RESOLUTIONS} and that is pinned by a table test rather
 * than trusted: a resolution spelled here that the provider vocabulary does not
 * carry would be a wire name written from convention, which rule 10 forbids
 * even when it happens to be correct.
 */
export const BOARD_CHART_PILL_RESOLUTIONS = ["1m", "15m", "2h", "8h"] as const;
export type BoardChartPillResolution =
  (typeof BOARD_CHART_PILL_RESOLUTIONS)[number];

/**
 * The pool a chart read is about: the same POSITIVE PICK the live, details and
 * spotlight channels take. Identity crosses; the pool document does not.
 */
export const boardChartSubjectSchema = boardPoolInputSchema
  .pick({ chain: true, pairAddress: true })
  .strict();
export type BoardChartSubject = z.infer<typeof boardChartSubjectSchema>;

/**
 * One chart read's outcome. Three families, deliberately not collapsed.
 *
 *  - `series`      the provider answered and these are the bars;
 *  - `absent`      settled: there is no drawable series right now, and asking
 *                  again this second answers the same way;
 *  - `unavailable` unknown: nothing was learned and asking again may work.
 */
export const boardChartOutcomeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("series"),
      series: boardCandleSeriesSchema,
      /**
       * Bars this read ASKED the provider for, per the resolution's own window
       * constant in main. Reported so a short answer is legible as the
       * provider's own bound rather than as a bug in the window.
       */
      requestedBars: z.number().int().min(1),
      /** Bars the provider returned before any projection dropped one. */
      providerBars: z.number().int().min(0),
      /**
       * Bars dropped because they carried no complete set of USD prices.
       *
       * COUNTED, never silent: a bar that cannot be drawn is a bar the reader
       * would otherwise read as a flat candle. `series.truncated` is true
       * whenever this or {@link windowedOutBars} is non-zero.
       */
      undrawableBars: z.number().int().min(0),
      /** Drawable bars beyond the resolution's window, cut from the tail end. */
      windowedOutBars: z.number().int().min(0),
      /**
       * Per-bar USD volume, POSITIONALLY aligned with `series.bars`: index i
       * is the volume of bar i, or null when the provider reported none.
       *
       * On this live channel and NOT on the durable candle. `boardCandleSchema`
       * is a persisted, strict format; a new key there would be rejected by
       * every already-written reader. A null here is a whitespace slot in the
       * volume histogram, never a zero bar.
       */
      volumes: z.array(volumeDecimalString.nullable()),
      /** Drawn bars whose volume is null. Counted beside `undrawableBars`. */
      volumelessBars: z.number().int().min(0),
      fetchedAtMs: z.number().int().nonnegative(),
    })
    .strict()
    .refine((value) => value.volumes.length === value.series.bars.length, {
      message: "volumes must be aligned one-to-one with series.bars",
      path: ["volumes"],
    }),
  z
    .object({
      kind: z.literal("absent"),
      reason: z.enum(["no_drawable_bars", "unknown_pair"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason: z.enum([
        "transport",
        "provider",
        "busy",
        "not_mounted",
        "cancelled",
      ]),
    })
    .strict(),
]);
export type BoardChartOutcome = z.infer<typeof boardChartOutcomeSchema>;

export const boardChartPollInputSchema = z
  .object({
    subject: boardChartSubjectSchema,
    /** One of the four pills. A closed enum, refused by name otherwise. */
    resolution: z.enum(BOARD_CHART_PILL_RESOLUTIONS),
  })
  .strict();
export type BoardChartPollInput = z.infer<typeof boardChartPollInputSchema>;

/**
 * One chart tick.
 *
 * `resolution` is ECHOED so a renderer that switched pills mid-flight can
 * refuse an answer belonging to the pill it left. Bars carried under the wrong
 * pill are the exact defect the chart contract's "old bars are never labelled
 * with a new pill" rule exists to prevent, and the echo is what makes that rule
 * checkable on the renderer's side rather than merely intended.
 */
export const boardChartPollResultSchema = z
  .object({
    subject: boardChartSubjectSchema,
    resolution: z.enum(BOARD_CHART_PILL_RESOLUTIONS),
    outcome: boardChartOutcomeSchema,
  })
  .strict();
export type BoardChartPollResult = z.infer<typeof boardChartPollResultSchema>;

/** The identity two sides pair a chart read on. Lowercased: providers vary case. */
export function boardChartKey(subject: BoardChartSubject): string {
  return `${subject.chain}:${subject.pairAddress}`.toLowerCase();
}
