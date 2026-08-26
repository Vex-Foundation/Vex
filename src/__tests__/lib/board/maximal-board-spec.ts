/**
 * The SCHEMA-VALID ALL-FIELDS-MAX board, generated from the contract's own
 * bounds table.
 *
 * WHY THIS FILE EXISTS. `BOARD_SPEC_MAX_BYTES` is a REFUSAL threshold, so the
 * only honest way to choose it is to measure the largest document the schema
 * actually admits and put the ceiling above that. The previous figure was
 * hand-assembled arithmetic over a subset of the fields (it omitted the
 * provider descriptions and the maximum-width hydration labels), and it
 * understated the real worst case by roughly 19 KiB - which meant a board the
 * schema accepted could still be refused by the budget with nothing the model
 * could shorten.
 *
 * NOTHING HERE IS HAND-TYPED. Every count and every width is read from the
 * exported constants and rules in `src/lib/board/spec.ts`. Raising any bound
 * therefore moves this document, which moves the measured figure, which is
 * asserted against the budget in `./spec.test.ts`. A bound raised without a
 * budget re-check goes red instead of shipping.
 *
 * IT IS DELIBERATELY ABSURD, and that is the point: no real board looks like
 * this. It is the corner of the contract's own state space, and the budget's
 * job is to admit it.
 *
 * Shared with `vex-app`'s `TOOL_ARGS_DISPLAY_CEILING` invariant test, which
 * derives the BoardCompose args envelope from this same document rather than
 * from a second guess at how large a legal board can be.
 */

import {
  BOARD_ANALYSIS_RULE,
  BOARD_ANNOTATION_LABEL_RULE,
  BOARD_CAPTION_RULE,
  BOARD_CHAIN_SLUG_MAX_CHARS,
  BOARD_CHART_RESOLUTIONS,
  BOARD_DECIMAL_MAX_CHARS,
  BOARD_DESCRIPTION_RULE,
  BOARD_DEX_ID_MAX_CHARS,
  BOARD_ICON_ID_MAX_CHARS,
  BOARD_MARKER_MAX_MS,
  BOARD_MAX_ANNOTATIONS,
  BOARD_MAX_CANDLES,
  BOARD_MAX_NOTES,
  BOARD_MAX_POOLS,
  BOARD_NOTE_RULE,
  BOARD_PAIR_ADDRESS_MAX_CHARS,
  BOARD_PROVENANCE_OBSERVATION_MAX_CHARS,
  BOARD_PROVENANCE_TRANSPORT_MAX_CHARS,
  BOARD_STALE_AFTER_MS,
  BOARD_TITLE_RULE,
  BOARD_TOKEN_LABEL_MAX_CHARS,
} from "../../../lib/board/spec.js";

/**
 * One code point of prose filler, and the byte cost the budget is sized
 * against.
 *
 * TWO BYTES is the worst case the budget must ADMIT: Cyrillic, Greek and
 * Hebrew are ordinary scripts a user may ask for analysis in, and a board
 * written in one of them costs twice a Latin board. Latin is carried beside it
 * so a test can state the ratio rather than assert "it fits".
 *
 * FOUR BYTES is the case the budget deliberately REFUSES. Emoji-dense prose at
 * every bound cannot be stored, and the contract's answer is to refuse the
 * whole board naming its heaviest pool, never to cut it to fit.
 */
export const BOARD_FILLER = {
  latin: "a",
  twoByte: "д",
  fourByte: "\u{1F680}",
} as const;

export type BoardFillerScript = keyof typeof BOARD_FILLER;

/**
 * How the document is filled.
 *
 * `script` fills every bounded string. `analysisScript` overrides it for the
 * per-pool assessments alone, which is the ONE axis on which a board can be
 * pushed past the budget while staying schema-valid.
 *
 * WHY ONLY THE ASSESSMENTS TAKE A FOUR-BYTE SCRIPT. The prose fields are
 * bounded in CODE POINTS by `boardText`, so an emoji costs one character of
 * their budget and four bytes of the document. The provider labels
 * (`baseTokenSymbol` and its siblings) and the provenance strings are bounded
 * by zod's own `.max()`, which counts UTF-16 units, so an emoji costs TWO of
 * their characters and four bytes: the same byte cost per character as the
 * two-byte script, and no more. A whole-document four-byte fill is therefore
 * not merely heavier, it is SCHEMA-INVALID on those fields, which is why the
 * over-budget case below moves only the assessments.
 */
export interface MaximalBoardFill {
  readonly script?: BoardFillerScript;
  readonly analysisScript?: BoardFillerScript;
}

/** Repeat one code point `count` times. Astral-safe: `repeat` copies whole strings. */
function fill(script: BoardFillerScript, count: number): string {
  return BOARD_FILLER[script].repeat(count);
}

/**
 * The widest decimal string the contract admits: `9.999...` at exactly
 * {@link BOARD_DECIMAL_MAX_CHARS} characters. One leading digit, a point, and
 * the rest fraction, which is both the maximum width and a legal price.
 */
function widestDecimal(): string {
  return `9.${"9".repeat(BOARD_DECIMAL_MAX_CHARS - 2)}`;
}

/** The widest SIGNED decimal, for the percent-change fields. */
function widestSignedDecimal(): string {
  return `-9.${"9".repeat(BOARD_DECIMAL_MAX_CHARS - 3)}`;
}

/** Largest integer the runtime can write into a count field without precision loss. */
const WIDEST_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * Build the largest document `boardSpecV1Schema` will accept.
 *
 * The chart carries {@link BOARD_MAX_ANNOTATIONS} ZONE annotations rather than
 * markers on purpose: a zone is the heaviest member of the annotation union
 * (two maximum-width decimal strings against a marker's single integer), and a
 * marker's only extra cost, one entry in `hydration.unmatchedMarkerAtMs`, is
 * far smaller than the decimal it replaces. With no marker annotation on the
 * chart, `unmatchedMarkerAtMs` is necessarily the empty list, which is what
 * the schema's own cross-field rule requires.
 *
 * Returned as `unknown` so no caller can skip the parse: the whole claim this
 * document makes is that it is SCHEMA-VALID, and a typed return would let a
 * test measure a board the schema would have refused.
 */
export function maximalBoardSpec(options: MaximalBoardFill = {}): unknown {
  const script = options.script ?? "twoByte";
  const analysisScript = options.analysisScript ?? script;
  const resolution = BOARD_CHART_RESOLUTIONS[0];
  return {
    version: 1,
    title: fill(script, BOARD_TITLE_RULE.maxChars),
    pools: Array.from({ length: BOARD_MAX_POOLS }, () => ({
      // Chain and pool address have narrow character classes, so they take
      // their widest LEGAL spelling rather than prose filler.
      chain: "s".repeat(BOARD_CHAIN_SLUG_MAX_CHARS),
      pairAddress: "A".repeat(BOARD_PAIR_ADDRESS_MAX_CHARS),
      caption: fill(script, BOARD_CAPTION_RULE.maxChars),
      analysis: fill(analysisScript, BOARD_ANALYSIS_RULE.maxChars),
    })),
    chart: {
      poolIndex: 0,
      resolution,
      annotations: Array.from({ length: BOARD_MAX_ANNOTATIONS }, () => ({
        kind: "zone",
        priceFrom: `1.${"1".repeat(BOARD_DECIMAL_MAX_CHARS - 2)}`,
        priceTo: widestDecimal(),
        label: fill(script, BOARD_ANNOTATION_LABEL_RULE.maxChars),
      })),
    },
    notes: Array.from({ length: BOARD_MAX_NOTES }, () =>
      fill(script, BOARD_NOTE_RULE.maxChars),
    ),
    hydration: {
      rows: Array.from({ length: BOARD_MAX_POOLS }, () => ({
        baseTokenSymbol: fill(script, BOARD_TOKEN_LABEL_MAX_CHARS),
        baseTokenName: fill(script, BOARD_TOKEN_LABEL_MAX_CHARS),
        quoteTokenSymbol: fill(script, BOARD_TOKEN_LABEL_MAX_CHARS),
        chainId: fill(script, BOARD_CHAIN_SLUG_MAX_CHARS),
        dexId: fill(script, BOARD_DEX_ID_MAX_CHARS),
        priceUsd: widestDecimal(),
        priceChange: { h1: widestSignedDecimal(), h24: widestSignedDecimal() },
        liquidityUsd: widestDecimal(),
        volumeH24Usd: widestDecimal(),
        txns: { buys: WIDEST_COUNT, sells: WIDEST_COUNT },
        pairAgeSeconds: WIDEST_COUNT,
        // The icon handle's character class excludes the filler scripts.
        iconId: "i".repeat(BOARD_ICON_ID_MAX_CHARS),
        description: fill(script, BOARD_DESCRIPTION_RULE.maxChars),
      })),
      candles: {
        bars: Array.from({ length: BOARD_MAX_CANDLES }, () => ({
          // The widest legal instant, so every bar spends its full digit run.
          tMs: BOARD_MARKER_MAX_MS,
          o: widestDecimal(),
          h: widestDecimal(),
          l: widestDecimal(),
          c: widestDecimal(),
        })),
        lastBarPartial: true,
        coveredRange: { fromMs: BOARD_MARKER_MAX_MS, toMs: BOARD_MARKER_MAX_MS },
        resolution,
        truncated: true,
      },
      analysisCreatedAt: BOARD_MARKER_MAX_MS,
      marketDataFetchedAt: BOARD_MARKER_MAX_MS,
      provenance: {
        transport: fill(script, BOARD_PROVENANCE_TRANSPORT_MAX_CHARS),
        sourceObservation: fill(script, BOARD_PROVENANCE_OBSERVATION_MAX_CHARS),
      },
      unmatchedMarkerAtMs: [],
      staleAfterMs: BOARD_STALE_AFTER_MS,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The measured figures                                                */
/* ------------------------------------------------------------------ */

/**
 * UTF-8 bytes of `maximalBoardSpec()` in a two-byte script, as MEASURED.
 *
 * This is the number `BOARD_SPEC_MAX_BYTES` is derived from, and it is
 * asserted rather than assumed in `./spec.test.ts`. It is written here, beside
 * the generator that produces it, so a bound change fails one obvious place
 * with the new worst case in the diff.
 */
export const MAXIMAL_TWO_BYTE_DOCUMENT_BYTES = 272_697;

/** The same document in Latin prose: the everyday cost of the same shape. */
export const MAXIMAL_LATIN_DOCUMENT_BYTES = 161_945;

/** Bytes of `BOARD_SPEC_MAX_BYTES` left unspent by the two-byte worst case. */
export const MAXIMAL_TWO_BYTE_DOCUMENT_HEADROOM_BYTES = 54_983;
