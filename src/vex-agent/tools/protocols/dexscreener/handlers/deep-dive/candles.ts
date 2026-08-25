/**
 * Handler for `dexscreener__candles_list`.
 *
 * The endpoint module owns the transports, the anchor and the walk. What is
 * left here is the shape the model sees and the honesty the shape has to
 * carry:
 *
 *  1. COLUMN-ORIENTED ROWS, NOT OBJECTS. `columns` plus `rows` costs about 40
 *     percent of what an array of objects costs, and 999 hourly bars decode to
 *     271 KB of provider bytes, so this is a budget decision with a measured
 *     reason rather than a style. The column names ship WITH the rows, so
 *     nothing about the shape is implicit.
 *  2. `lastBarPartial` IS MANDATORY. Across 999 hourly bars, all 998 completed
 *     bars matched exactly between the two provider transports and only the
 *     forming bar differed between two responses five seconds apart. A summary
 *     computed over a partial bar is wrong in a way nothing downstream can
 *     detect, so the flag is on every answer and the summary says which
 *     figures the partial bar touched.
 *  3. GAPS ARE COUNTED, NEVER FILLED. Second-scale series are genuinely sparse
 *     (5s bars measured with a median 50-second gap), so a missing bucket is
 *     reported as a gap and is never invented as a zero-volume bar.
 *  4. THE ANCHOR'S ERROR IS PUBLISHED. `endAtMs` resolves through the nearest
 *     prior trade, which was measured landing 393 seconds early. The distance
 *     ships on every anchored answer, and an anchor that is missing or beyond
 *     ten resolution steps is abandoned for the backward walk and said so.
 */

import {
  barStepMs,
  barTransportFor,
  resolveAnchorFallbackThreshold,
  walkBars,
  BARS_DEADLINE_MS_CEILING,
  BARS_DEADLINE_MS_DEFAULT,
  BARS_MAX_PAGES_DEFAULT,
  BARS_PER_CALL,
  BAR_RESOLUTIONS,
  type BarResolution,
  type ProjectedBar,
} from "@tools/dexscreener/endpoints/bars.js";
import { resolveBlockAnchor } from "@tools/dexscreener/endpoints/trades.js";
import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import { num, ok } from "../../../handler-helpers.js";
import {
  CANDLE_FIELD_GROUPS,
  CANDLE_FIELD_GROUPS_DEFAULT,
  CANDLE_LIMIT_DEFAULT,
  CANDLE_LIMIT_MAX,
  CANDLE_LIMIT_MIN,
  CANDLE_PRICE_BASES,
  CANDLE_SERIES,
  type CandleFieldGroup,
  type CandlePriceBasis,
} from "../../manifests/deep-dive-params.js";
import {
  CHANNEL_TIMEOUT_MS,
  observation,
  readBoundedInteger,
  readEnum,
  readFieldGroups,
  readInstantMs,
  readSubject,
  subjectBlock,
} from "./_shared.js";

export async function runCandles(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<ReturnType<typeof ok>> {
  const resolution = readEnum<BarResolution>(
    params,
    "resolution",
    BAR_RESOLUTIONS,
    "1h"
  );
  const groups = readFieldGroups(
    params,
    CANDLE_FIELD_GROUPS,
    CANDLE_FIELD_GROUPS_DEFAULT,
    ["ohlc"]
  );
  const series = readEnum(params, "series", CANDLE_SERIES, "price");
  const priceBasis = readEnum<CandlePriceBasis>(
    params,
    "priceBasis",
    CANDLE_PRICE_BASES,
    "usd"
  );
  const inverted = params["inverted"] === true;
  // Whether the caller NAMED a row count, read the same way the bound reader
  // reads it, so a value the reader would ignore does not count as one.
  const limitGiven = num(params, "limit") !== undefined;
  const limit = readBoundedInteger(
    params,
    "limit",
    CANDLE_LIMIT_MIN,
    CANDLE_LIMIT_MAX,
    CANDLE_LIMIT_DEFAULT,
    `${CANDLE_LIMIT_MAX} is the provider's own page size, not a Vex cap. For a longer history give startAtMs and let the walk page backward.`
  );
  // No Vex ceiling (owner decision D-DS5): deadlineMs is the real bound.
  const maxPages = readBoundedInteger(
    params,
    "maxPages",
    1,
    Number.MAX_SAFE_INTEGER,
    BARS_MAX_PAGES_DEFAULT,
    "Each page is up to 999 bars. There is no upper ceiling here: deadlineMs bounds the walk, which reports how many pages it used and hands back a cursor when it stops."
  );
  const beforeBlock = readBoundedInteger(
    params,
    "beforeBlock",
    1,
    Number.MAX_SAFE_INTEGER,
    0,
    "Pass back the nextBeforeBlock value from a previous candles answer, unchanged. It is the provider's own EXCLUSIVE block anchor, so the continued page starts at the bar below it."
  );
  const deadlineMs = readBoundedInteger(
    params,
    "deadlineMs",
    1_000,
    BARS_DEADLINE_MS_CEILING,
    BARS_DEADLINE_MS_DEFAULT,
    `The ceiling is ${BARS_DEADLINE_MS_CEILING} ms because the engine's own call budget is the outer bound.`
  );
  const startAtMs = readInstantMs(params, "startAtMs");
  const endAtMs = readInstantMs(params, "endAtMs");

  if (beforeBlock !== 0 && endAtMs !== undefined) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      '"beforeBlock" and "endAtMs" both decide where the walk starts, and this call gave both',
      "Continue an interrupted walk with beforeBlock alone, or start a fresh window with endAtMs alone. Honouring one of them silently would answer a different window than the one asked for."
    );
  }

  /*
   * WHAT LIMIT MEANS WHEN A RANGE WAS ASKED FOR.
   *
   * The manifest states that startAtMs takes precedence over limit: the answer
   * is the range, not a row count. That is real here rather than prose. With a
   * range and no explicit limit, the row bound is the provider's own page size
   * instead of the modest default, so a requested range is not silently
   * reduced to the newest 100 bars. An EXPLICIT limit is still honoured, and
   * whatever it holds back is reported as truncated with a cursor that reaches
   * it.
   */
  const rowBound =
    startAtMs !== undefined && !limitGiven ? CANDLE_LIMIT_MAX : limit;

  const { transport, subject } = await readSubject(params, signal);

  /* --- anchor ----------------------------------------------------- */

  const stepMs = barStepMs(resolution);
  const fallbackThresholdMs = resolveAnchorFallbackThreshold(resolution);
  let anchorBlock: number | undefined;
  let anchorResolvedAtMs: number | null = null;
  let anchorDistanceMs: number | null = null;
  let anchorFallback = false;
  let anchorFallbackReason: string | null = null;

  if (endAtMs !== undefined) {
    const anchor = await resolveBlockAnchor({
      transport,
      chainId: subject.chainId,
      pairAddress: subject.pairAddress,
      ammId: subject.ammId,
      quoteTokenAddress: subject.quoteTokenAddress,
      inverted,
      timeoutMs: CHANNEL_TIMEOUT_MS,
      atMs: endAtMs,
      ...(signal === undefined ? {} : { signal }),
    });
    if (anchor === null) {
      anchorFallback = true;
      anchorFallbackReason =
        "The provider reported no trade at or before endAtMs, so there is no block to anchor on. The walk started from the newest bar instead, and coveredRange states what it actually reached.";
    } else if (anchor.distanceMs > fallbackThresholdMs) {
      anchorFallback = true;
      anchorResolvedAtMs = anchor.resolvedAtMs;
      anchorDistanceMs = anchor.distanceMs;
      anchorFallbackReason =
        `The nearest trade at or before endAtMs sits ${anchor.distanceMs} ms earlier, beyond the ${fallbackThresholdMs} ms limit of ten ${resolution} steps, so anchoring there would have answered a different window. The walk started from the newest bar instead.`;
    } else {
      // `bbn` is EXCLUSIVE, so anchoring one block later includes the
      // anchoring trade's own bar.
      anchorBlock = anchor.blockNumber + 1;
      anchorResolvedAtMs = anchor.resolvedAtMs;
      anchorDistanceMs = anchor.distanceMs;
    }
  }

  /* --- walk -------------------------------------------------------- */

  const walk = await walkBars({
    transport,
    chainId: subject.chainId,
    pairAddress: subject.pairAddress,
    ammId: subject.ammId,
    quoteTokenAddress: subject.quoteTokenAddress,
    resolution,
    series,
    inverted,
    limit: rowBound,
    ...(startAtMs === undefined ? {} : { startAtMs }),
    ...(anchorBlock === undefined ? {} : { beforeBlockNumber: anchorBlock }),
    ...(beforeBlock === 0 ? {} : { beforeBlockNumber: beforeBlock }),
    maxPages,
    deadlineMs,
    timeoutMs: CHANNEL_TIMEOUT_MS,
    ...(signal === undefined ? {} : { signal }),
  });

  // Newest `rowBound` in-range bars, still oldest-first. A row cut here is a
  // reported bound, never a silent one: it sets truncated and moves the cursor
  // to the oldest bar actually returned.
  const inRange = barsInRange(walk.bars, startAtMs, endAtMs);
  const windowed = windowBars(inRange, rowBound);
  const columns = columnNames(groups, priceBasis);
  const rows = windowed.map((bar) => columns.map((column) => cell(bar, column)));

  const lastBarPartial = isLastBarPartial(windowed, stepMs, walk.fetchedAtMs);
  const boundHit =
    walk.stopReason === "page_budget" || walk.stopReason === "deadline";
  /*
   * WITHHELD DATA IS ALWAYS TRUNCATION.
   *
   * Two different things can hold bars back: the walk stopping at a bound
   * before it reached startAtMs, and the row bound cutting bars the walk did
   * fetch inside the range. Measured, the second reported `truncated: false`
   * while returning 25 of 999 in-range bars, which is a silent cut. Both are
   * truncation and both carry a cursor.
   */
  const withheldInRange = inRange.length - windowed.length;
  /*
   * TRUNCATION IS ABOUT A REQUESTED RANGE, NOT ABOUT `limit`.
   *
   * A call that names no range asks for "the newest N bars", and returning
   * exactly N of them is the request satisfied, not a cut. The provider serves
   * a fixed 999-bar page whatever `limit` says, so counting the rest as
   * withheld set `truncated: true` on EVERY call with limit under 999,
   * including the manifest's own example (limit 48 reported 951 withheld and
   * `rangeFullyCovered: false` for a request that named no range). A flag that
   * is always on is a flag the model learns to ignore, and it was set on the
   * flag that had just been made trustworthy.
   *
   * So `truncated` now means: a range WAS requested and this answer does not
   * cover it. Bars the row bound held back are still reported, and still carry
   * a cursor that reaches them; on a limit-only call they are an ordinary
   * continuation rather than a failure to deliver.
   */
  const rangeRequested =
    startAtMs !== undefined || endAtMs !== undefined || beforeBlock !== 0;
  const truncated = rangeRequested && (boundHit || withheldInRange > 0);
  /*
   * The cursor continues from the OLDEST BAR THIS ANSWER RETURNED, not from
   * the oldest bar fetched: continuing below the fetched floor would leave
   * every bar between the two reachable by no request at all. `bbn` is
   * exclusive, so the oldest emitted bar's own first block is the right
   * anchor for the bar below it. This holds unconditionally now: when nothing
   * was withheld the cursor used to fall through to the walk's own oldest
   * FETCHED bar, which on a closed window pointed 283,467 blocks below the
   * oldest bar the answer actually returned, contradicting the parameter's
   * stated contract.
   */
  const oldestEmitted = windowed[0];
  const nextBeforeBlock =
    oldestEmitted?.minBlockNumber ?? walk.nextBeforeBlock;

  return ok({
    summary: summarize(subject.baseTokenSymbol, resolution, windowed, series),
    subject: subjectBlock(subject, { series, priceBasis, inverted }),
    resolution,
    columns,
    rows,
    returned: rows.length,
    columnsNote:
      "Rows are column-oriented: each row is an array of values in the order of `columns`. This costs about 40 percent of what an array of objects costs, which matters because 999 hourly bars are 271 KB of provider data. Every price is a DECIMAL STRING and must not be parsed into a float for money arithmetic.",
    summaryBlock: buildSummary(windowed, {
      resolution,
      stepMs,
      lastBarPartial,
      requestedStartAtMs: startAtMs ?? null,
      requestedEndAtMs: endAtMs ?? null,
      walkStopReason: walk.stopReason,
      rowsWithheldInRange: withheldInRange,
    }),
    anchor:
      endAtMs === undefined
        ? {
            used: false,
            note: "No endAtMs was given, so the newest bars were read directly and no anchoring was needed.",
          }
        : {
            used: !anchorFallback,
            requestedAtMs: endAtMs,
            anchorResolvedAtMs,
            anchorDistanceMs,
            anchorFallback,
            ...(anchorFallbackReason === null
              ? {}
              : { anchorFallbackReason }),
            note: "endAtMs is resolved through the nearest PRIOR trade, which makes it APPROXIMATE by contract: trades are not evenly spaced, and one measured 90-day target landed 393 seconds early. anchorDistanceMs is that error for this call. It is reported rather than corrected, because the provider offers no exact timestamp anchor and inventing one would hide the error instead of removing it.",
          },
    providerWindow: {
      endpoint:
        barTransportFor(resolution) === "http"
          ? "/dex/chart/amm/v3/{ammId}/bars/{chain}/{pair}"
          : "feed/ws getHistoricalBars",
      transport: walk.transport,
      transportNote:
        barTransportFor(resolution) === "http"
          ? "Served over HTTP. The provider's chart endpoint answers 400 for 5s and for daily and above, which is why those resolutions use the WebSocket instead. The split is a provider fact, not a missing capability."
          : "Served over the feed WebSocket, which is the ONLY transport for 5s, daily, 3-day, weekly and monthly bars. Both transports were measured agreeing exactly on all 998 completed bars of a 999-bar hourly page.",
      barsPerCall: BARS_PER_CALL,
      pagesWalked: walk.pagesWalked,
      maxPages,
      deadlineMs,
      pageBudgetHit: walk.stopReason === "page_budget",
      deadlineHit: walk.stopReason === "deadline",
      responseBytes: walk.bytes,
      stopReason: walk.stopReason,
      ...(walk.stopReason === "provider_exhausted"
        ? {
            stopReasonNote:
              `The provider returned NO BARS for this subject${walk.pagesWalked <= 1 ? " on the very first page, so no bar was ever seen" : ", after this walk had already collected bars"}. This reason is AMBIGUOUS and the bytes cannot resolve it: measured, a wrong AMM id, a wrong chain slug and a wrong pair address each answer with an empty page BYTE-IDENTICAL to a genuine end of history. `
              + (walk.pagesWalked <= 1
                ? "Because no page ever returned a bar, \"the pool has no history here\" and \"this identity is not the one the provider indexes\" are equally consistent with what arrived. The subject was resolved by the provider itself rather than supplied by the caller, which makes the second unlikely; confirm it with dexscreener__pair_get before concluding the pool is new."
                : "Since earlier pages did return bars for the same subject, the identity is good and this is the provider's own end of history for this filter."),
          }
        : {}),
    },
    truncated,
    nextBeforeBlock,
    barsWithheldByLimit: withheldInRange,
    ...(truncated
      ? {
          truncationNote:
            (boundHit
              ? `The walk stopped at its ${walk.stopReason === "page_budget" ? "page budget" : "deadline"} before covering the requested range. `
              : "")
            + (withheldInRange > 0
              ? `${withheldInRange} bar(s) inside the requested range were fetched but held back by the row bound of ${rowBound}. `
              : "")
            + "coveredRange states exactly what arrived; pass nextBeforeBlock back as the beforeBlock parameter to continue from the bar below the oldest one returned"
            + (boundHit ? ", or raise deadlineMs" : ", or raise limit")
            + `. ${DEEPER_ONLY_VIA_BEFORE_BLOCK} Nothing was dropped from what is shown, and nothing withheld is unreachable.`,
        }
      : {}),
    ...(!truncated && withheldInRange > 0
      ? {
          continuationNote:
            `This call named no range, so the newest ${rows.length} bars ARE the answer and nothing is missing from it. `
            + `The provider serves a fixed ${CANDLE_LIMIT_MAX}-bar page whatever limit says, so ${withheldInRange} older bar(s) came back in the same page and were not shown. `
            + `Raise limit to see them in one call, or pass nextBeforeBlock back as beforeBlock to continue below the oldest bar returned. ${DEEPER_ONLY_VIA_BEFORE_BLOCK}`,
        }
      : {}),
    withheldFields: {
      fields: ["volumeBase", "volumeQuote", "vwap"],
      reason:
        "The provider's token-denominated volumes are raw fixed-point strings and it publishes no token decimals on this channel: a captured bar carried a normal 4.58 million USD volume beside a 24-digit token volume. All three values would be wrong by a power of ten, so they are withheld rather than shipped with a caveat. USD volume is unaffected and is available in the volume field group.",
    },
    withheldCapabilities: {
      capabilities: ["supplyOverride"],
      reason:
        "The provider's chart endpoint accepts a circulating-supply OVERRIDE alongside the market-cap series (measured: it multiplies the price series by exactly the supply given, replacing the provider's own). It is deliberately not exposed. series marketCap already returns the PROVIDER-COMPUTED market cap with no supply argument, measured matching the WebSocket market-cap series exactly on every completed bar; a caller-supplied supply would produce a chart that looks equally authoritative and means whatever number was passed. This is a named omission, not an oversight.",
    },
    flowHandoff:
      "For the individual trades inside any bar, call dexscreener__trades_list with that bar's timestamp as startAtMs and the next bar's as endAtMs; the provider honours that window to the second.",
    sourceObservation: observation(transport, walk.fetchedAtMs),
  });
}

/**
 * The one sentence that stops a model raising the wrong knob.
 *
 * Measured 2026-08-24: the same call at `maxPages` 1 and 2 returned the
 * identical 999 rows and the identical cursor while doubling the provider
 * bytes, because `limit` is capped at 999 and a walk of any depth cannot emit
 * more than that. Only `beforeBlock` moves the window.
 */
const DEEPER_ONLY_VIA_BEFORE_BLOCK =
  "Raising maxPages cannot return more rows: limit is capped at 999 and a walk of any depth still emits at most that many, so extra pages are fetched and discarded. beforeBlock is the only parameter that reaches deeper history.";

/* ------------------------------------------------------------------ */
/* Column projection                                                   */
/* ------------------------------------------------------------------ */

type Column =
  | "t" | "o" | "h" | "l" | "c"
  | "oUsd" | "hUsd" | "lUsd" | "cUsd"
  | "vUsd" | "blockMin" | "blockMax";

function columnNames(
  groups: readonly CandleFieldGroup[],
  basis: CandlePriceBasis
): readonly Column[] {
  const columns: Column[] = ["t"];
  if (basis === "native" || basis === "both") columns.push("o", "h", "l", "c");
  if (basis === "usd" || basis === "both") {
    columns.push("oUsd", "hUsd", "lUsd", "cUsd");
  }
  if (groups.includes("volume")) columns.push("vUsd");
  if (groups.includes("blockRange")) columns.push("blockMin", "blockMax");
  return columns;
}

function cell(bar: ProjectedBar, column: Column): string | number | null {
  switch (column) {
    case "t": return bar.timestampMs;
    case "o": return bar.openNative;
    case "h": return bar.highNative;
    case "l": return bar.lowNative;
    case "c": return bar.closeNative;
    case "oUsd": return bar.openUsd;
    case "hUsd": return bar.highUsd;
    case "lUsd": return bar.lowUsd;
    case "cUsd": return bar.closeUsd;
    case "vUsd": return bar.volumeUsd;
    case "blockMin": return bar.minBlockNumber;
    case "blockMax": return bar.maxBlockNumber;
  }
}

/**
 * Narrow the walk's output to the requested window and row count.
 *
 * The NEWEST `limit` bars, because "the last N candles" is what a limit means
 * on a time series. The totals travel in `providerWindow` and the cursor
 * reaches everything older, so this is a ranked bound rather than a cut.
 */
function barsInRange(
  bars: readonly ProjectedBar[],
  startAtMs: number | undefined,
  endAtMs: number | undefined
): readonly ProjectedBar[] {
  return bars.filter(
    (bar) =>
      (startAtMs === undefined || bar.timestampMs >= startAtMs)
      && (endAtMs === undefined || bar.timestampMs <= endAtMs)
  );
}

function windowBars(
  inRange: readonly ProjectedBar[],
  rowBound: number
): readonly ProjectedBar[] {
  return inRange.length <= rowBound
    ? inRange
    : inRange.slice(inRange.length - rowBound);
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

/**
 * Whether the newest returned bar is still forming.
 *
 * True when the bar's own period has not yet ended at the time the provider
 * answered. Measured necessity: the forming bar was the ONLY one of 999 that
 * differed between two responses five seconds apart, so every figure computed
 * over it is provisional.
 */
function isLastBarPartial(
  bars: readonly ProjectedBar[],
  stepMs: number,
  fetchedAtMs: number
): boolean {
  const last = bars[bars.length - 1];
  if (last === undefined) return false;
  return fetchedAtMs < last.timestampMs + stepMs;
}

function buildSummary(
  bars: readonly ProjectedBar[],
  context: {
    readonly resolution: BarResolution;
    readonly stepMs: number;
    readonly lastBarPartial: boolean;
    readonly requestedStartAtMs: number | null;
    readonly requestedEndAtMs: number | null;
    readonly walkStopReason: string;
    /** In-range bars the row bound held back. A covered range cannot have any. */
    readonly rowsWithheldInRange: number;
  }
): Record<string, unknown> {
  const first = bars[0];
  const last = bars[bars.length - 1];
  const coveredRange =
    first === undefined || last === undefined
      ? null
      : { startAtMs: first.timestampMs, endAtMs: last.timestampMs };
  const requestedRange = {
    startAtMs: context.requestedStartAtMs,
    endAtMs: context.requestedEndAtMs,
  };
  const rangeFullyCovered =
    context.walkStopReason !== "page_budget"
    && context.walkStopReason !== "deadline"
    && context.rowsWithheldInRange === 0
    && (context.requestedStartAtMs === null
      || (first !== undefined && first.timestampMs <= context.requestedStartAtMs + context.stepMs));

  const extremes = findExtremes(bars);
  const move = largestMove(bars);
  // `high`, `low` and `changePct` all read the USD columns when the provider
  // sent any, whatever `priceBasis` asked for. A native-basis answer therefore
  // showed rows at 0.000000001640 beside a high of 0.000004188, three orders
  // of magnitude apart, with no unit named anywhere. Naming the series is the
  // honest fix; silently switching it would change what a caller measured.
  const summaryPriceBasis = bars.some((bar) => bar.highUsd !== null)
    ? "usd"
    : "native";
  return {
    barCount: bars.length,
    summaryPriceBasis,
    summaryPriceBasisNote:
      summaryPriceBasis === "usd"
        ? "high, low, changePct and largestMovePct are computed on the USD series. When priceBasis is native the row columns are in the quote token and these figures are NOT: they are dollars."
        : "high, low, changePct and largestMovePct are computed on the native (quote-token) series, because the provider sent no USD columns for these bars.",
    changePct: changePct(bars),
    high: extremes.high,
    highAtMs: extremes.highAtMs,
    low: extremes.low,
    lowAtMs: extremes.lowAtMs,
    extremesNote:
      "high and low are taken over EVERY price column of every returned bar, open and close included, not over the high/low columns alone. The provider's rows are not internally consistent: measured across 999 hourly bars, 382 carried an open or close outside their own row's high/low, so reading only the extremes columns could report a period high BELOW a close printed in the same answer.",
    usdConsistencyNote:
      "THE USD COLUMNS ARE THE PROVIDER'S DERIVED RENDERING; THE NATIVE COLUMNS ARE THE EXACT SERIES. Measured 2026-08-25: closeUSD exceeds highUSD on rows whose native columns are exactly equal, by up to 1.81 percent (183 of 200 rows on an inverted series, 10 of 15 hourly rows on a non-inverted solana pair), while the native columns were clean across 2,190 captured bars. The USD extremes are the native extremes converted at a different moment than the close, so a USD figure here can disagree with a USD figure beside it by about a percent through no fault of this tool. For a decision that turns on a sub-percent difference, ask for priceBasis native and convert once yourself.",
    volumeUsdTotal: volumeTotal(bars),
    largestMovePct: move.pct,
    largestMoveAtMs: move.atMs,
    gapCount: gapCount(bars, context.stepMs),
    gapNote:
      "Bars the provider did not emit inside the covered range, counted against the nominal step. A sparse series is NORMAL at second-scale resolutions: 5s bars were measured with a median 50-second and maximum 1,600-second spacing. Missing buckets are never filled with zero volume.",
    requestedRange,
    coveredRange,
    rangeFullyCovered,
    // Mandatory on every answer. Measured: only the forming bar ever differs.
    lastBarPartial: context.lastBarPartial,
    lastBarPartialNote: context.lastBarPartial
      ? "The newest returned bar is STILL FORMING: its close, high, low and volume will change. changePct, high, low, volumeUsdTotal and largestMovePct above all include it and are therefore provisional. Drop it before comparing two calls or two transports."
      : "Every returned bar is complete, so the summary figures are final for this window.",
    priceFormatNote:
      "Prices are decimal STRINGS. changePct and the move figures are ratios derived from them and are the only floating-point values here; the prices themselves are never converted.",
  };
}

/** Close over first open, in percent. Null when either end is unusable. */
function changePct(bars: readonly ProjectedBar[]): number | null {
  const first = bars[0];
  const last = bars[bars.length - 1];
  const open = Number(first?.openUsd ?? first?.openNative ?? "");
  const close = Number(last?.closeUsd ?? last?.closeNative ?? "");
  if (!Number.isFinite(open) || !Number.isFinite(close) || open === 0) return null;
  return ((close - open) / open) * 100;
}

/**
 * The period high and low, over EVERY price column the answer printed.
 *
 * OPEN AND CLOSE ARE FOLDED IN, and that is the whole point. The provider's
 * own rows are not internally consistent: measured 2026-08-25 across 999
 * non-inverted hourly bars, 382 rows carried an `openUsd` or `closeUsd`
 * OUTSIDE their own `[lowUsd, highUsd]` (row 1784037600000: openUsd
 * 0.000002874 against highUsd 0.000002871), and 166 rows showed the same on
 * the native columns. On the inverted series it compounds: 183 of 200 rows.
 * Reading only the h/l columns therefore let `summary.high` come back BELOW a
 * close printed in the same answer, which is a wrong number on a money path
 * and one the reader could catch by looking two lines down.
 *
 * The page-level impact of the old behaviour was measured at zero on a full
 * 999-bar page and is reachable on short windows, which is exactly what
 * `limit: 1` returns, so this is a small fix on a real path rather than a
 * theoretical one.
 *
 * The winning LEXEME is emitted, never a re-rendered number: the comparison
 * uses doubles because an ordering needs one, the value returned is the
 * provider's own digits.
 */
function findExtremes(bars: readonly ProjectedBar[]): {
  readonly high: string | null;
  readonly highAtMs: number | null;
  readonly low: string | null;
  readonly lowAtMs: number | null;
} {
  let high: { value: number; raw: string; atMs: number } | null = null;
  let low: { value: number; raw: string; atMs: number } | null = null;
  for (const bar of bars) {
    // The same basis the rest of the summary uses: USD when the provider sent
    // any column of it, native otherwise. Mixing the two would compare dollars
    // with quote-token units.
    const usd = bar.highUsd !== null || bar.lowUsd !== null
      || bar.openUsd !== null || bar.closeUsd !== null;
    const candidates = usd
      ? [bar.highUsd, bar.lowUsd, bar.openUsd, bar.closeUsd]
      : [bar.highNative, bar.lowNative, bar.openNative, bar.closeNative];
    for (const raw of candidates) {
      if (raw === null) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (high === null || value > high.value) {
        high = { value, raw, atMs: bar.timestampMs };
      }
      if (low === null || value < low.value) {
        low = { value, raw, atMs: bar.timestampMs };
      }
    }
  }
  return {
    high: high?.raw ?? null,
    highAtMs: high?.atMs ?? null,
    low: low?.raw ?? null,
    lowAtMs: low?.atMs ?? null,
  };
}

/** Sum of USD volume. Null when no bar reported one, never zero. */
function volumeTotal(bars: readonly ProjectedBar[]): number | null {
  let total = 0;
  let seen = false;
  for (const bar of bars) {
    if (bar.volumeUsd === null) continue;
    const value = Number(bar.volumeUsd);
    if (!Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

/** The biggest single-bar open-to-close move, and when it happened. */
function largestMove(bars: readonly ProjectedBar[]): {
  readonly pct: number | null;
  readonly atMs: number | null;
} {
  let best: { pct: number; atMs: number } | null = null;
  for (const bar of bars) {
    const open = Number(bar.openUsd ?? bar.openNative ?? "");
    const close = Number(bar.closeUsd ?? bar.closeNative ?? "");
    if (!Number.isFinite(open) || !Number.isFinite(close) || open === 0) continue;
    const pct = ((close - open) / open) * 100;
    if (best === null || Math.abs(pct) > Math.abs(best.pct)) {
      best = { pct, atMs: bar.timestampMs };
    }
  }
  return { pct: best?.pct ?? null, atMs: best?.atMs ?? null };
}

/** Bars the provider did not emit inside the covered range. */
function gapCount(bars: readonly ProjectedBar[], stepMs: number): number {
  let gaps = 0;
  for (let index = 1; index < bars.length; index += 1) {
    const previous = bars[index - 1];
    const current = bars[index];
    if (previous === undefined || current === undefined) continue;
    const span = current.timestampMs - previous.timestampMs;
    if (span > stepMs) gaps += Math.round(span / stepMs) - 1;
  }
  return gaps;
}

function summarize(
  symbol: string | null,
  resolution: BarResolution,
  bars: readonly ProjectedBar[],
  series: string
): string {
  const subject = symbol ?? "this pair";
  if (bars.length === 0) {
    return `No ${resolution} ${series} bars for ${subject} in the requested window. The provider answered; an empty window means it emitted no bar there, which at second-scale resolutions is normal.`;
  }
  const change = changePct(bars);
  return (
    `${bars.length} ${resolution} ${series} bars for ${subject}`
    + `${change === null ? "" : `, ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(2)} percent across the window`}.`
  );
}
