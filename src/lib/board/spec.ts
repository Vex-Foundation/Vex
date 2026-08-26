/**
 * BoardSpec v1 - the single canonical contract for the agent-composed board.
 *
 * This module is the ONE source of truth named by the lane's frozen contract
 * table. The agent runtime validates model input with it, the compose tool
 * builds the persisted document with it, the Electron main process re-parses
 * durable rows with it, and the renderer types its components from it. No
 * consumer redefines a shape.
 *
 * WHY IT LIVES IN `src/lib/`. That directory is the repository's pure shared
 * root: `vex-app/tsconfig.shared.json` includes `../src/lib` and aliases it as
 * `@vex-lib/*`, and `vex-app/scripts/check-process-boundaries.mjs` admits a
 * `@vex-lib` module into `shared` and `renderer` only when it appears in that
 * script's `PURE_VEX_LIB_MODULES` allowlist. This module qualifies for the
 * same reason `@vex-lib/diagnostics/bug-report-schema.js` does: its only
 * import is `zod`. It reaches no database, no Electron, no React, no wallet,
 * no provider client and no filesystem, and it must not acquire one - doing so
 * would drag privileged code into the untrusted renderer bundle.
 *
 * TWO SCHEMAS, DELIBERATELY SEPARATE:
 *
 *  - {@link boardComposeInputSchema} is what the MODEL may author. Everything
 *    in it is analysis: a title, which pools to show, the agent's own captions
 *    and notes, and the chart coordinates it derived from tool results it had
 *    already read. It carries NO provider facts, no URLs, no HTML, no
 *    Markdown, no colors, no CSS classes, no chart options, and nothing on a
 *    money path (no fee, destination, amount or transaction field). A model
 *    that sends an unknown key is refused, not trimmed.
 *  - {@link boardSpecV1Schema} is what is PERSISTED. It is the validated input
 *    plus a `version` discriminant plus a `hydration` block that the RUNTIME
 *    authors at compose time from the DexScreener surface. Hydration can never
 *    come from the model; keeping it in a schema the input schema does not
 *    contain is what makes that structural rather than a review promise.
 */

import { z } from "zod";

import {
  checkBoardText,
  describeBoardTextFailure,
  type BoardTextRule,
} from "./board-text.js";

/* ------------------------------------------------------------------ */
/* Bounds table - the frozen contract, transcribed                     */
/* ------------------------------------------------------------------ */

/** Board heading. Single-line. */
export const BOARD_TITLE_RULE: BoardTextRule = {
  minChars: 1,
  maxChars: 80,
  multiline: false,
};

/** Per-card note written by the agent. Single-line. */
export const BOARD_CAPTION_RULE: BoardTextRule = {
  minChars: 1,
  maxChars: 140,
  multiline: false,
};

/** Annotation label on the chart. Single-line: it renders inside a price line. */
export const BOARD_ANNOTATION_LABEL_RULE: BoardTextRule = {
  minChars: 1,
  maxChars: 60,
  multiline: false,
};

/**
 * One analysis note: a risk, a caveat, a caveat's evidence.
 *
 * Multi-line, because prose paragraphs are the point of the block. 600
 * characters is a REFUSAL threshold, never a target: a note that needs a
 * paragraph gets one, and a note that fits in a line stays a line. The old 280
 * was a tweet-shaped number with nothing behind it, and it made the model
 * compress caveats that deserved the room.
 */
export const BOARD_NOTE_RULE: BoardTextRule = {
  minChars: 1,
  maxChars: 600,
  multiline: true,
};

/**
 * The model's own assessment of ONE token on the board. Multi-line.
 *
 * NOT a caption. A caption is the one-line takeaway that fits on a card; this
 * is the FULL read the spotlight surface shows under "VEX assessment": the
 * thesis, what is actually moving the price, the levels that matter with their
 * numbers, the risk read and what would invalidate it. The field exists so the
 * model can present REAL INSIGHT about a token, and the contract must not turn
 * that into an editing exercise.
 *
 * 10000 CHARACTERS IS A REFUSAL THRESHOLD, NEVER A TARGET. Length is not the
 * product; insight is. A model that pads to the bound has misread the field as
 * badly as one that stops at a sentence, and two to five paragraphs is what a
 * real assessment costs.
 *
 * THE ONLY REASON A BOUND EXISTS HERE IS {@link BOARD_SPEC_MAX_BYTES}. The
 * document is persisted whole in one JSONB row, so per-field bounds are what
 * keep a legal board from being an unstorable one; the number is derived from
 * that budget, not from an opinion about how much the model should say.
 *
 * BOTH BOUNDS ARE REJECT-ONLY. This one refuses a longer assessment with its
 * class named, and the byte budget refuses an oversize board with its measured
 * size and its largest pool named. NOTHING ANYWHERE IS SLICED: a trimmed
 * assessment would say something the model did not write, under the model's
 * name, to a user who cannot tell it was cut.
 *
 * Line breaks are allowed, exactly as they are for a note, because an
 * assessment that separates its thesis, its evidence and its risk reads as
 * several paragraphs. Every other forbidden class (controls, bidi, tag blocks,
 * zero-width) is rejected here on the same table.
 *
 * IT IS PROSE, AND PROSE NEVER COLOURS A CHIP. The safety chip is decided by
 * the pure classifier over provider evidence
 * (`vex-app/src/shared/board/safety-classifier.ts`); this string is displayed
 * beside it and can never move it. That separation is the whole reason the
 * field is allowed to be free text at all.
 */
export const BOARD_ANALYSIS_RULE: BoardTextRule = {
  minChars: 1,
  maxChars: 10_000,
  multiline: true,
};

/**
 * The PROVIDER's blurb for a token, from its DexScreener CMS profile.
 *
 * UNTRUSTED PROVIDER TEXT, and the opposite of {@link BOARD_ANALYSIS_RULE} in
 * every way that matters: the analysis is the model's own reading, this is a
 * string a token's own marketing team wrote about itself. It is carried so the
 * surface can show what the project claims to be, and it is never evidence of
 * anything. It NEVER reaches an HTML sink, never reaches the safety
 * classifier, and never influences a figure.
 *
 * Bounded REJECT-ONLY at 1000 characters, on the same forbidden code-point
 * table as every other board string (controls, bidi, tag blocks, zero-width).
 * A blurb past the bound, or one carrying a forbidden class, is dropped to
 * `null` by the hydrator rather than cut: half a description is a sentence the
 * project did not write, and the honest rendering of "we could not carry this"
 * is no description at all.
 *
 * WHY 1000 AND NOT MORE. Two measurements, not a preference:
 *
 *  - LIVE (`board-v4-probes/description-vex.json`): the provider served 546
 *    code points for VEX on robinhood, 8 for Pistacio, and NO description key
 *    at all for WETH. 1000 covers the observed distribution with room.
 *  - BUDGET: this field is the one board string the MODEL CANNOT SHORTEN. At
 *    8 pools in a two-byte script, every 1000 characters here costs 16,000
 *    bytes of {@link BOARD_SPEC_MAX_BYTES}, and the measured worst case leaves
 *    only ~10 KiB of headroom at this bound. A larger ceiling would let the
 *    PROVIDER's marketing copy push a board the agent composed correctly over
 *    the budget, refusing work the model had no way to make smaller.
 *
 * So an unusually long blurb costs the reader a blurb, never the board.
 *
 * Multi-line, because CMS blurbs routinely carry paragraph breaks.
 */
export const BOARD_DESCRIPTION_RULE: BoardTextRule = {
  minChars: 1,
  maxChars: 1000,
  multiline: true,
};

/** Maximum pools on one board. Order in the array is display order. */
export const BOARD_MAX_POOLS = 8;
/**
 * Maximum analysis notes.
 *
 * A REFUSAL threshold. Raised from 6 after a production refusal: the model
 * composed 7 notes of real content and the whole board was rejected, which
 * traded a page of insight for a limit that was defending nothing. 12 notes at
 * {@link BOARD_NOTE_RULE}.maxChars is 14,400 bytes in a two-byte script, which
 * the document budget below absorbs without argument.
 */
export const BOARD_MAX_NOTES = 12;
/** Maximum chart annotations. */
export const BOARD_MAX_ANNOTATIONS = 12;
/** Maximum candles carried in one hydrated board. */
export const BOARD_MAX_CANDLES = 200;

/**
 * Serialized ceiling for one persisted board document, in BYTES of UTF-8.
 *
 * 256 KiB. This is a REFUSAL threshold, never a trimming threshold: a board
 * over budget is refused with its measured size AND the pool that contributed
 * most named, because silently dropping pools, notes or candles would show the
 * user a board the agent did not compose. See {@link checkBoardSpecByteBudget}.
 *
 * THE ARITHMETIC, at the bounds the field rules admit:
 *
 *  - analysis: {@link BOARD_MAX_POOLS} x {@link BOARD_ANALYSIS_RULE}.maxChars
 *    = 8 x 10,000 = 80,000 characters. Latin prose costs 80,000 bytes; prose
 *    in a two-byte script (Cyrillic, Greek, Hebrew) costs 160,000 bytes, and
 *    that two-byte figure is the one this budget is sized against.
 *  - notes: {@link BOARD_MAX_NOTES} x {@link BOARD_NOTE_RULE}.maxChars = 12 x
 *    600 = 7,200 characters, or 14,400 bytes in the same two-byte script.
 *  - descriptions: 8 x {@link BOARD_DESCRIPTION_RULE}.maxChars = 8,000
 *    characters of PROVIDER prose, 16,000 bytes in the same script.
 *  - the rest of an authored board: title (80), 8 captions (140 each), 12
 *    annotation labels (60 each) and the 8 hydration rows the runtime writes
 *    (token names and symbols dominate). Call it 16 KiB.
 *  - a full chart: 200 candles of maximum-width decimal strings, ~32 KiB.
 *
 * MEASURED, NOT ESTIMATED. Every field at its bound, in a two-byte script,
 * with a full chart: 251,963 bytes, inside 256 KiB with ~10 KiB spare. Without
 * the chart: 208,556. The same board with NO provider descriptions: 235,979
 * with a chart. Those are the figures the bounds above actually produce, and
 * the description ceiling was chosen FROM this table rather than before it.
 *
 * What can still exceed the budget is 4-byte emoji-dense prose at the same
 * bounds (8 x 10,000 code points at 4 bytes each is 320,000 bytes of analysis
 * alone), and that board is REFUSED WHOLE with its size and heaviest pool
 * named, never trimmed to fit.
 *
 * DOWNSTREAM INVARIANT: `TOOL_ARGS_DISPLAY_CEILING` in
 * `vex-app/src/shared/schemas/messages.ts` must stay ABOVE this budget plus
 * the BoardCompose args envelope, or a legal board's tool args would fall off
 * the transcript as `null`.
 */
export const BOARD_SPEC_MAX_BYTES = 262_144;

/**
 * Staleness horizon for hydrated market data, in milliseconds.
 *
 * Fixed for v1 and persisted with the document rather than read from renderer
 * configuration, so a board re-opened months later still states the horizon it
 * was composed under.
 */
export const BOARD_STALE_AFTER_MS = 60_000;

/**
 * The 18 candle resolutions the DexScreener surface serves.
 *
 * Transcribed from `src/tools/dexscreener/endpoints/bars.ts` (`BAR_RESOLUTIONS`)
 * because that module is NOT reachable from the Electron app's shared or
 * renderer trees, while this contract must be. The duplication is pinned by a
 * table test in `src/__tests__/lib/board/spec.test.ts`, which imports BOTH and
 * asserts they are identical member for member and in the same order; the
 * provider vocabulary can therefore never drift from this list unnoticed.
 */
export const BOARD_CHART_RESOLUTIONS = [
  "1s",
  "5s",
  "15s",
  "30s",
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1mo",
] as const;

export type BoardChartResolution = (typeof BOARD_CHART_RESOLUTIONS)[number];

/**
 * A non-negative decimal number written as a string.
 *
 * Money and prices never round-trip through binary floating point anywhere in
 * this product, and a sub-cent pool price is real down to 1e-13, so every
 * price on a board - the model's analytical coordinates included - is text.
 * No exponent form and no sign: the shape stays comparable by the string-safe
 * comparator below, and a negative price is not a thing a pool has.
 */
const DECIMAL_STRING_PATTERN = /^[0-9]+(\.[0-9]+)?$/;

/** Maximum characters in a decimal string. Generous; it is a bound, not a cut. */
export const BOARD_DECIMAL_MAX_CHARS = 40;

/** DexScreener chain slug, e.g. `solana`, `base`, `arbitrum-one`. */
const CHAIN_SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * The DexScreener CMS icon reference, as the provider spells it.
 *
 * It is an OPAQUE handle, never a URL and never a path: the only thing any
 * consumer may do with it is name it to the one main-process owner that knows
 * which host serves it. The character class is deliberately narrow (the
 * unreserved URL-safe set, no dot and no slash), so an id can never carry a
 * path segment, a scheme, a query, or a traversal even before the fetcher's
 * own host-and-prefix allowlist runs. This pattern is repeated verbatim by the
 * IPC input schema in the desktop app, and this module cannot import it: this
 * file's only legal dependency is zod (see the header), which is what keeps it
 * loadable in the untrusted renderer.
 */
export const BOARD_ICON_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

/** Pool identity as the provider spells it. Base58 or hex-without-prefix. */
const PAIR_ADDRESS_PATTERN = /^[A-Za-z0-9]+$/;

/** Epoch-millisecond floor: 2001-09-09. Below this the value is seconds. */
export const BOARD_MARKER_MIN_MS = 1_000_000_000_000;
/** Epoch-millisecond ceiling: year 5138. Above this the value is microseconds. */
export const BOARD_MARKER_MAX_MS = 100_000_000_000_000;

/* ------------------------------------------------------------------ */
/* Text and decimal primitives                                         */
/* ------------------------------------------------------------------ */

/**
 * A zod string that applies one {@link BoardTextRule} as a REJECT-ONLY check.
 *
 * The bounds are enforced here rather than through `z.string().min().max()`
 * because zod counts UTF-16 units and this contract counts code points; an
 * emoji must cost one character of a caption's budget, not two. The issue
 * message names the class and never echoes the offending text, and zod
 * supplies the field path.
 */
export function boardText(rule: BoardTextRule): z.ZodString {
  return z.string().superRefine((value, ctx) => {
    const failure = checkBoardText(value, rule);
    if (failure === null) return;
    ctx.addIssue({
      code: "custom",
      message: describeBoardTextFailure(failure),
    });
  });
}

const decimalString = z
  .string()
  .max(BOARD_DECIMAL_MAX_CHARS)
  .regex(
    DECIMAL_STRING_PATTERN,
    "must be a non-negative decimal number written as digits, optionally with a single decimal point"
  );

/**
 * Order two non-negative decimal STRINGS without converting them to numbers.
 *
 * Returns -1, 0 or 1. Compares the integer parts by length first (a longer
 * digit run is the larger number once leading zeros are discounted) and only
 * then lexicographically, then compares the fraction parts padded to equal
 * length. This is exact for every input the pattern above admits, including
 * values a double could not represent, which is precisely why the board never
 * parses a price to compare it.
 *
 * Exported because the zone ordering rule and the chart adapter both need the
 * same answer, and two comparators would eventually disagree.
 */
export function compareDecimalStrings(left: string, right: string): -1 | 0 | 1 {
  const [leftWhole = "", leftFraction = ""] = left.split(".");
  const [rightWhole = "", rightFraction = ""] = right.split(".");
  const leftDigits = leftWhole.replace(/^0+(?=\d)/, "");
  const rightDigits = rightWhole.replace(/^0+(?=\d)/, "");
  if (leftDigits.length !== rightDigits.length) {
    return leftDigits.length < rightDigits.length ? -1 : 1;
  }
  if (leftDigits !== rightDigits) return leftDigits < rightDigits ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const leftPadded = leftFraction.padEnd(width, "0");
  const rightPadded = rightFraction.padEnd(width, "0");
  if (leftPadded === rightPadded) return 0;
  return leftPadded < rightPadded ? -1 : 1;
}

/* ------------------------------------------------------------------ */
/* Model input                                                         */
/* ------------------------------------------------------------------ */

/** One pool the agent chose to display. */
export const boardPoolInputSchema = z
  .object({
    chain: z.string().min(1).max(32).regex(CHAIN_SLUG_PATTERN),
    pairAddress: z.string().min(1).max(128).regex(PAIR_ADDRESS_PATTERN),
    caption: boardText(BOARD_CAPTION_RULE).optional(),
    /**
     * The model's full assessment of this token, or null when it wrote none.
     *
     * OPTIONAL ON READ, ALWAYS WRITTEN - the same expand-and-contract half
     * `iconId` documents on the hydrated row, and for the same durable reason.
     * Boards composed before this field existed are already persisted in
     * transcript rows, and this schema re-parses those rows on every read; a
     * required key would turn each of them into a parse failure, which the DB
     * mapper renders as a board that silently vanished. A missing key
     * therefore lands as `null` through the default, which is exactly what the
     * reader would have seen anyway ("No saved analysis"), and writers emit
     * the key on every board from now on.
     *
     * It is IMMUTABLE and HONESTLY DATED: it was written at compose time
     * against the figures of that moment, and the surface stamps it with the
     * board's own compose clock rather than the live one.
     */
    analysis: boardText(BOARD_ANALYSIS_RULE).nullable().default(null),
  })
  .strict();

/** A horizontal price line the agent drew. */
export const boardLevelAnnotationSchema = z
  .object({
    kind: z.literal("level"),
    price: decimalString,
    label: boardText(BOARD_ANNOTATION_LABEL_RULE),
  })
  .strict();

/**
 * A price band the agent drew.
 *
 * `priceFrom` must be strictly below `priceTo`. Enforced through the
 * string-safe comparator, never by parsing to a number: a band between
 * 0.00000000000012 and 0.00000000000013 is an ordinary sub-cent band and must
 * not collapse to equality on the way to being checked.
 */
export const boardZoneAnnotationSchema = z
  .object({
    kind: z.literal("zone"),
    priceFrom: decimalString,
    priceTo: decimalString,
    label: boardText(BOARD_ANNOTATION_LABEL_RULE),
  })
  .strict()
  .superRefine((zone, ctx) => {
    if (compareDecimalStrings(zone.priceFrom, zone.priceTo) >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["priceFrom"],
        message: "must be strictly below priceTo",
      });
    }
  });

/** A point in time the agent marked. */
export const boardMarkerAnnotationSchema = z
  .object({
    kind: z.literal("marker"),
    atMs: z
      .number()
      .int()
      .min(BOARD_MARKER_MIN_MS)
      .max(BOARD_MARKER_MAX_MS),
    label: boardText(BOARD_ANNOTATION_LABEL_RULE),
  })
  .strict();

/** The annotation union, discriminated by `kind`. */
export const boardAnnotationSchema = z.discriminatedUnion("kind", [
  boardLevelAnnotationSchema,
  boardZoneAnnotationSchema,
  boardMarkerAnnotationSchema,
]);

/**
 * The one annotated chart a board may carry.
 *
 * `poolIndex` is bounded against `pools.length` at the root of the input
 * schema, because that is the only place both facts are in scope.
 */
export const boardChartInputSchema = z
  .object({
    poolIndex: z.number().int().min(0).max(BOARD_MAX_POOLS - 1),
    resolution: z.enum(BOARD_CHART_RESOLUTIONS),
    annotations: z.array(boardAnnotationSchema).max(BOARD_MAX_ANNOTATIONS).optional(),
  })
  .strict();

/**
 * Everything the model may author on a board.
 *
 * `.strict()` throughout: an unknown key is a refusal with the key named, not
 * a silent drop. A model that tried to send `color`, `html`, `url` or a fee
 * field learns that the field does not exist rather than watching it vanish.
 */
export const boardComposeInputSchema = z
  .object({
    title: boardText(BOARD_TITLE_RULE),
    pools: z.array(boardPoolInputSchema).min(1).max(BOARD_MAX_POOLS),
    chart: boardChartInputSchema.optional(),
    notes: z.array(boardText(BOARD_NOTE_RULE)).max(BOARD_MAX_NOTES).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.chart !== undefined && input.chart.poolIndex >= input.pools.length) {
      ctx.addIssue({
        code: "custom",
        path: ["chart", "poolIndex"],
        message: `must address one of the ${input.pools.length} pool(s) on this board, so at most ${input.pools.length - 1}`,
      });
    }
  });

export type BoardComposeInput = z.infer<typeof boardComposeInputSchema>;
export type BoardPoolInput = z.infer<typeof boardPoolInputSchema>;
export type BoardAnnotation = z.infer<typeof boardAnnotationSchema>;
export type BoardChartInput = z.infer<typeof boardChartInputSchema>;

/* ------------------------------------------------------------------ */
/* Runtime-authored hydration                                          */
/* ------------------------------------------------------------------ */

/**
 * Nullable-required money field.
 *
 * Required-and-nullable rather than optional, everywhere in hydration: a
 * missing key is a schema failure while an explicit `null` is the honest fact
 * "the provider did not report this". Collapsing the two would let an absent
 * liquidity figure render as a confident zero.
 */
const hydratedDecimal = decimalString.nullable();

/** Percent change over a window, as a decimal string with an optional sign. */
const hydratedSignedDecimal = z
  .string()
  .max(BOARD_DECIMAL_MAX_CHARS)
  .regex(/^-?[0-9]+(\.[0-9]+)?$/)
  .nullable();

/** The provider snapshot for one pool, as of `marketDataFetchedAt`. */
export const boardHydratedRowSchema = z
  .object({
    baseTokenSymbol: z.string().min(1).max(512).nullable(),
    baseTokenName: z.string().min(1).max(512).nullable(),
    quoteTokenSymbol: z.string().min(1).max(512).nullable(),
    chainId: z.string().min(1).max(32).nullable(),
    dexId: z.string().min(1).max(64).nullable(),
    priceUsd: hydratedDecimal,
    priceChange: z
      .object({
        h1: hydratedSignedDecimal,
        h24: hydratedSignedDecimal,
      })
      .strict(),
    liquidityUsd: hydratedDecimal,
    volumeH24Usd: hydratedDecimal,
    txns: z
      .object({
        buys: z.number().int().min(0).nullable(),
        sells: z.number().int().min(0).nullable(),
      })
      .strict(),
    pairAgeSeconds: z.number().int().min(0).nullable(),
    /**
     * The base token's DexScreener CMS icon handle, or null when the token has
     * no profile artwork this board may show.
     *
     * OPTIONAL ON READ, ALWAYS WRITTEN. This is the one field on this schema
     * that is optional rather than required-and-nullable, and the asymmetry is
     * the expand half of an expand-and-contract, not an oversight. Boards
     * composed before this field existed are ALREADY PERSISTED in transcript
     * rows, and `boardSpecV1Schema` is what re-parses those rows on every read;
     * a required key would turn every one of them into a parse failure, which
     * the DB mapper renders as a board that silently vanished. So a missing key
     * parses and lands as `null` through the default below, which is the same
     * value the reader would have seen anyway: "no icon".
     *
     * Writers (`vex-agent/tools/internal/board/hydrate.ts`) always emit the
     * key, null included, so every board written from now on is explicit. The
     * contract half that may be made required later is exactly that: once no
     * durable row predates the field, `.default(null)` becomes `.nullable()`
     * and nothing else changes.
     *
     * NOT A URL. See {@link BOARD_ICON_ID_PATTERN}: the renderer hands this
     * handle to the main process, which owns the host, the transport, the byte
     * bound and the image validation. Nothing on this path lets a persisted
     * document name an origin.
     */
    iconId: z
      .string()
      .regex(
        BOARD_ICON_ID_PATTERN,
        "must be a DexScreener CMS icon handle: 4 to 128 characters of A-Z, a-z, 0-9, hyphen or underscore",
      )
      .nullable()
      .default(null),

    /**
     * The base token's DexScreener CMS description, or null when the token has
     * no profile blurb this board may show.
     *
     * OPTIONAL ON READ, ALWAYS WRITTEN, for exactly the reason `iconId` above
     * is: this is the expand half of an expand-and-contract over a schema that
     * re-parses DURABLE transcript rows. Boards persisted before this field
     * existed carry no key, a required key would turn each of them into a
     * parse failure, and the DB mapper renders a parse failure as a board that
     * silently vanished. A missing key therefore lands as `null`, which is the
     * same thing the reader would have seen anyway.
     *
     * UNTRUSTED PROVIDER PROSE. See {@link BOARD_DESCRIPTION_RULE}: it is the
     * token's own marketing copy, it is bounded reject-only rather than cut,
     * and it is rendered as TEXT. Nothing on this path may hand it to an HTML
     * sink, and the safety classifier never reads it.
     */
    description: boardText(BOARD_DESCRIPTION_RULE).nullable().default(null),
  })
  .strict();

/** One candle. Every price is a decimal string all the way to the canvas. */
export const boardCandleSchema = z
  .object({
    tMs: z.number().int().min(BOARD_MARKER_MIN_MS).max(BOARD_MARKER_MAX_MS),
    o: decimalString,
    h: decimalString,
    l: decimalString,
    c: decimalString,
  })
  .strict();

/**
 * The candle series behind the annotated chart.
 *
 * `truncated` is the honest report required whenever the provider had more
 * bars than {@link BOARD_MAX_CANDLES}: the reader is told bars exist beyond
 * the window and `coveredRange` says exactly which span is shown. That is a
 * bound, not a silent cut.
 */
export const boardCandleSeriesSchema = z
  .object({
    bars: z.array(boardCandleSchema).max(BOARD_MAX_CANDLES),
    lastBarPartial: z.boolean(),
    coveredRange: z
      .object({
        fromMs: z.number().int().min(BOARD_MARKER_MIN_MS).max(BOARD_MARKER_MAX_MS),
        toMs: z.number().int().min(BOARD_MARKER_MIN_MS).max(BOARD_MARKER_MAX_MS),
      })
      .strict(),
    resolution: z.enum(BOARD_CHART_RESOLUTIONS),
    truncated: z.boolean(),
  })
  .strict();

/** Where the hydration bytes came from. */
export const boardProvenanceSchema = z
  .object({
    transport: z.string().min(1).max(64),
    sourceObservation: z.string().min(1).max(512),
  })
  .strict();

/**
 * Everything the RUNTIME authored, and the model could not.
 *
 * TWO CLOCKS, deliberately. `analysisCreatedAt` is when the agent composed the
 * analysis and is IMMUTABLE for the life of the document - it dates the
 * captions, notes and annotations, which are opinions that were formed at a
 * moment. `marketDataFetchedAt` dates the numbers, and a refresh updates it
 * together with `rows` and `candles` and nothing else. One timestamp for both
 * would either make a fresh price claim the analysis is fresh, or make a
 * refreshed board look stale.
 */
export const boardHydrationSchema = z
  .object({
    rows: z.array(boardHydratedRowSchema).min(1).max(BOARD_MAX_POOLS),
    candles: boardCandleSeriesSchema.nullable(),
    analysisCreatedAt: z
      .number()
      .int()
      .min(BOARD_MARKER_MIN_MS)
      .max(BOARD_MARKER_MAX_MS),
    marketDataFetchedAt: z
      .number()
      .int()
      .min(BOARD_MARKER_MIN_MS)
      .max(BOARD_MARKER_MAX_MS),
    provenance: boardProvenanceSchema,
    /**
     * Marker instants the runtime could NOT match to a hydrated candle, in the
     * order the annotations were given. Null when the board carries no chart.
     *
     * MEASURED REASON THIS EXISTS. The chart library snaps a marker whose time
     * is not in the series to a NEIGHBOURING bar rather than refusing it, so a
     * marker the agent placed at 14:03 on a 1-hour series would be drawn on
     * the 14:00 candle and read as analysis of that bar. A marker is the
     * agent's claim about a specific moment, so the only honest options are
     * "exactly this bar" or "not drawn, and said so".
     *
     * Membership is decided ONCE, at compose time, against the candle set that
     * was persisted beside the marker (`./hydrate.ts`), because that is the
     * only moment both facts are authoritative and runtime-authored. The
     * renderer omits these markers from the canvas and names each one in the
     * legend; nothing is silently dropped.
     */
    unmatchedMarkerAtMs: z
      .array(z.number().int().min(BOARD_MARKER_MIN_MS).max(BOARD_MARKER_MAX_MS))
      .max(BOARD_MAX_ANNOTATIONS)
      .nullable(),
    staleAfterMs: z.literal(BOARD_STALE_AFTER_MS),
  })
  .strict();

export type BoardHydration = z.infer<typeof boardHydrationSchema>;
export type BoardHydratedRow = z.infer<typeof boardHydratedRowSchema>;
export type BoardCandle = z.infer<typeof boardCandleSchema>;
export type BoardCandleSeries = z.infer<typeof boardCandleSeriesSchema>;

/* ------------------------------------------------------------------ */
/* The persisted document                                              */
/* ------------------------------------------------------------------ */

/**
 * The board as it is stored in the transcript row's metadata and as the
 * renderer receives it.
 *
 * `version` is a literal so that a future v2 is a discriminated sibling rather
 * than a field that quietly changes meaning; a durable row written by a newer
 * writer fails this parse and the mapper turns it into a null board, which is
 * the reader-before-writer behavior the persistence layer already uses for
 * `explorerRefs`.
 *
 * One structural invariant beyond the field shapes: `hydration.rows` is
 * positional against `pools`, so the two lengths must match. The renderer pairs
 * them by index and would otherwise show one pool's caption over another
 * pool's numbers.
 */
export const boardSpecV1Schema = z
  .object({
    version: z.literal(1),
    title: boardText(BOARD_TITLE_RULE),
    pools: z.array(boardPoolInputSchema).min(1).max(BOARD_MAX_POOLS),
    chart: boardChartInputSchema.optional(),
    notes: z.array(boardText(BOARD_NOTE_RULE)).max(BOARD_MAX_NOTES).optional(),
    hydration: boardHydrationSchema,
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.hydration.rows.length !== spec.pools.length) {
      ctx.addIssue({
        code: "custom",
        path: ["hydration", "rows"],
        message: `must carry exactly one row per pool: ${spec.pools.length} pool(s), ${spec.hydration.rows.length} row(s)`,
      });
    }
    if (spec.chart !== undefined && spec.chart.poolIndex >= spec.pools.length) {
      ctx.addIssue({
        code: "custom",
        path: ["chart", "poolIndex"],
        message: `must address one of the ${spec.pools.length} pool(s) on this board, so at most ${spec.pools.length - 1}`,
      });
    }
    if (spec.chart !== undefined && spec.hydration.candles !== null) {
      if (spec.hydration.candles.resolution !== spec.chart.resolution) {
        ctx.addIssue({
          code: "custom",
          path: ["hydration", "candles", "resolution"],
          message: "must echo the resolution the chart requested",
        });
      }
    }
    if (spec.chart === undefined && spec.hydration.candles !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["hydration", "candles"],
        message: "must be null when the board has no chart",
      });
    }
    // The unmatched-marker verdict is positional against the chart's OWN
    // markers: a board that reports an instant no marker claimed would omit
    // the wrong annotation from the canvas, and one that reports nothing while
    // carrying a chart has not been through the membership check at all.
    if (spec.chart === undefined) {
      if (spec.hydration.unmatchedMarkerAtMs !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["hydration", "unmatchedMarkerAtMs"],
          message: "must be null when the board has no chart",
        });
      }
    } else if (spec.hydration.unmatchedMarkerAtMs === null) {
      ctx.addIssue({
        code: "custom",
        path: ["hydration", "unmatchedMarkerAtMs"],
        message:
          "must be the list of marker instants that matched no candle (empty when they all matched)",
      });
    } else {
      const claimed = new Set(
        (spec.chart.annotations ?? []).flatMap((annotation) =>
          annotation.kind === "marker" ? [annotation.atMs] : [],
        ),
      );
      for (const atMs of spec.hydration.unmatchedMarkerAtMs) {
        if (!claimed.has(atMs)) {
          ctx.addIssue({
            code: "custom",
            path: ["hydration", "unmatchedMarkerAtMs"],
            message: `names ${atMs}, which no marker annotation on this chart claims`,
          });
        }
      }
    }
  });

export type BoardSpecV1 = z.infer<typeof boardSpecV1Schema>;

/* ------------------------------------------------------------------ */
/* The serialized byte budget                                          */
/* ------------------------------------------------------------------ */

/**
 * The serialized weight of ONE pool: its authored entry plus the hydration row
 * the runtime wrote for it. Named so an over-budget refusal can point at the
 * pool worth shortening instead of leaving the model to guess.
 */
export interface BoardPoolByteWeight {
  /** Index into `spec.pools`, which is also the display order. */
  readonly index: number;
  /** UTF-8 bytes of `pools[index]` plus `hydration.rows[index]`. */
  readonly byteLength: number;
}

/** The measured size of a candidate board against {@link BOARD_SPEC_MAX_BYTES}. */
export interface BoardByteBudgetResult {
  readonly withinBudget: boolean;
  /** UTF-8 bytes of the JSON the row would store. */
  readonly byteLength: number;
  readonly maxBytes: number;
  /**
   * The heaviest pool, or `null` when the value carries no readable `pools`
   * array (a malformed candidate, or a non-board object measured directly).
   * Ties resolve to the lowest index, so the figure is deterministic.
   */
  readonly largestPool: BoardPoolByteWeight | null;
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Find the heaviest pool of a candidate board.
 *
 * Reads defensively rather than through the schema: this runs on values that
 * have NOT necessarily parsed (the compose path measures a serialized round
 * trip, the DB mapper measures a durable row), and a measurement helper must
 * never be the thing that throws on a malformed document.
 */
function heaviestPool(spec: unknown): BoardPoolByteWeight | null {
  if (typeof spec !== "object" || spec === null) return null;
  const pools: unknown = "pools" in spec ? spec.pools : undefined;
  if (!Array.isArray(pools) || pools.length === 0) return null;

  const hydration: unknown = "hydration" in spec ? spec.hydration : undefined;
  const rows: unknown =
    typeof hydration === "object" && hydration !== null && "rows" in hydration
      ? hydration.rows
      : undefined;
  const hydrationRows: readonly unknown[] = Array.isArray(rows) ? rows : [];

  let heaviest: BoardPoolByteWeight = { index: 0, byteLength: 0 };
  pools.forEach((pool: unknown, index: number) => {
    const byteLength = utf8Bytes(pool) + (index < hydrationRows.length ? utf8Bytes(hydrationRows[index]) : 0);
    if (byteLength > heaviest.byteLength) heaviest = { index, byteLength };
  });
  return heaviest;
}

/**
 * Measure a board document against the persisted byte budget.
 *
 * Measures the JSON the row would actually store, in UTF-8 BYTES, because that
 * is what the column holds; a code-point or UTF-16 count would understate a
 * board written in a non-Latin script by up to a factor of three.
 *
 * This function only MEASURES. The compose tool refuses an over-budget board
 * and names both the size and the heaviest pool in the refusal; nothing
 * anywhere drops a pool, a note or a candle to make a board fit, because a
 * silently shortened board is a board the agent did not compose and the user
 * cannot tell was shortened.
 *
 * PURE: no clock, no I/O, no mutation of the argument. `TextEncoder` is used
 * rather than `Buffer.byteLength` so the function runs unchanged in the
 * renderer, which has no Node globals.
 */
export function checkBoardSpecByteBudget(spec: unknown): BoardByteBudgetResult {
  const byteLength = utf8Bytes(spec);
  return {
    withinBudget: byteLength <= BOARD_SPEC_MAX_BYTES,
    byteLength,
    maxBytes: BOARD_SPEC_MAX_BYTES,
    largestPool: heaviestPool(spec),
  };
}

/** The model-visible refusal sentence for an over-budget board. */
export function describeBoardByteBudgetFailure(
  result: BoardByteBudgetResult
): string {
  const culprit =
    result.largestPool === null
      ? ""
      : `; the largest single contribution is pool ${result.largestPool.index} at ${result.largestPool.byteLength} bytes`;
  return `board is ${result.byteLength} bytes serialized, over the ${result.maxBytes} byte limit${culprit}; compose a smaller board (fewer pools, a shorter assessment on that pool, or no chart) - nothing was truncated`;
}
