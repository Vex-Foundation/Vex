/**
 * Handler for `dexscreener__trades_list`.
 *
 * The endpoint module owns the two channels, the filter grammar and the exact
 * cursor. What is left here is the shape and the two honesty properties that
 * shape has to hold:
 *
 *  1. AN AGGREGATE THAT DID NOT COVER ITS RANGE IS RENAMED. A summary computed
 *     over one page, presented as a summary of a time window, is the exact
 *     silent cut this surface must not commit. When a bound is hit the block
 *     becomes `pageAggregate` with `rangeFullyCovered: false` and the range it
 *     actually covered, so a reader can never mistake the two.
 *  2. NO TRADER FIELD CLAIMS PROFIT OR INTENT. `netCashFlowUsd` is dollars out
 *     minus dollars in on this pair; `retainedBoughtPct` is retained share of
 *     what the wallet bought here, not of supply; `newOnPair` is new on this
 *     pair, not a fresh wallet. There is deliberately no accumulating-versus-
 *     distributing label, because transfers and other venues are invisible to
 *     this channel and any such label would be a guess.
 *
 * `mode` never costs extra requests: raw, aggregate and both are three shapes
 * over ONE fetch set.
 */

import {
  fetchTradesPage,
  tradeCursorAt,
  TRADES_PER_PAGE,
  TRADE_EVENT_TYPES,
  type ProjectedTrade,
  type TradeCursor,
  type TradeEventType,
  type TradeFilters,
} from "@tools/dexscreener/endpoints/trades.js";
import {
  BARS_DEADLINE_MS_CEILING,
  BARS_DEADLINE_MS_DEFAULT,
  BARS_MAX_PAGES_DEFAULT,
} from "@tools/dexscreener/endpoints/bars.js";
import {
  DexScreenerSiteErrorCodes,
  siteError,
} from "@tools/dexscreener/site-errors.js";
import { num, ok, str } from "../../../handler-helpers.js";

/**
 * Pages an aggregate walks when the caller named no range.
 *
 * There is no start to walk towards, so the budget is a sample size rather than
 * a coverage target. Measured: the full default budget cost 12.2 s where one
 * page cost 1.5 s, for an answer no wider in meaning.
 */
const TRADES_UNRANGED_AGGREGATE_PAGES = 2;
import {
  TRADER_PROFILE_DEPTHS,
  TRADE_LARGEST_COUNT,
  TRADE_LIMIT_DEFAULT,
  TRADE_LIMIT_MAX,
  TRADE_LIMIT_MIN,
  TRADE_MODES,
  TRADE_SIZE_BUCKETS_USD,
  type TradeMode,
  type TraderProfileDepth,
} from "../../manifests/deep-dive-params.js";
import {
  CHANNEL_TIMEOUT_MS,
  observation,
  readBoundedInteger,
  readDecimalString,
  readEnum,
  readInstantMs,
  readSubject,
  subjectBlock,
} from "./_shared.js";

/** The cursor envelope version. Bumping it invalidates old cursors by name. */
const CURSOR_VERSION = "ds1";

export async function runTrades(
  params: Record<string, unknown>,
  signal: AbortSignal | undefined
): Promise<ReturnType<typeof ok>> {
  const mode = readEnum<TradeMode>(params, "mode", TRADE_MODES, "raw");
  const eventType = readEnum<TradeEventType>(
    params,
    "eventType",
    TRADE_EVENT_TYPES,
    "all"
  );
  const profileDepth = readEnum<TraderProfileDepth>(
    params,
    "traderProfile",
    TRADER_PROFILE_DEPTHS,
    "compact"
  );
  const limit = readBoundedInteger(
    params,
    "limit",
    TRADE_LIMIT_MIN,
    TRADE_LIMIT_MAX,
    TRADE_LIMIT_DEFAULT,
    `${TRADE_LIMIT_MAX} is the provider's own page size, not a Vex cap. Page deeper with the cursor from nextCursor.`
  );
  // No Vex ceiling (owner decision D-DS5): deadlineMs is the real bound on a
  // walk, and a second invented ceiling would refuse a range the deadline
  // would have covered.
  const maxPages = readBoundedInteger(
    params,
    "maxPages",
    1,
    Number.MAX_SAFE_INTEGER,
    BARS_MAX_PAGES_DEFAULT,
    "Only the aggregate modes walk pages; raw returns one page. There is no upper ceiling here: deadlineMs bounds the walk, and the answer reports how many pages it used."
  );
  const deadlineMs = readBoundedInteger(
    params,
    "deadlineMs",
    1_000,
    BARS_DEADLINE_MS_CEILING,
    BARS_DEADLINE_MS_DEFAULT,
    `The ceiling is ${BARS_DEADLINE_MS_CEILING} ms because the engine's own call budget is the outer bound.`
  );

  /*
   * THE FORWARD BOUND, AND WHY IT IS A BOUND RATHER THAN A CURSOR.
   *
   * The provider honours `afterBlockNumber` on Connect (measured: a lower
   * block bound that AND-combines with the upper one into a window) but keeps
   * the ordering newest-first, so this is "restrict the window", not "stream
   * forward from here". It is exposed because the plan's own substitute for
   * the gated-off live push is a poll, and without it every poll re-pages from
   * the head of history.
   *
   * STRICTLY EXCLUSIVE of the block passed, measured two-sided on a boundary
   * block carrying three events, and the window it opens is served under the
   * provider's 100-row page cap, so a busy pair needs the cursor walk below to
   * reach the older end of its own window.
   */
  const afterBlock = readBoundedInteger(
    params,
    "afterBlock",
    1,
    Number.MAX_SAFE_INTEGER,
    0,
    "A block NUMBER, not a timestamp and not a cursor. Take it from a previous answer's rows (blockNumber) to ask what has traded since; the block itself is EXCLUDED, so pass the newest block you have already seen. It bounds the window; the rows still arrive newest-first."
  );

  const filters: TradeFilters = {
    eventType,
    ...(afterBlock === 0 ? {} : { afterBlock }),
    ...optional("volumeUsdMin", usdString(params, "minVolumeUsd")),
    ...optional("volumeUsdMax", usdString(params, "maxVolumeUsd")),
    ...optional("amountBaseMin", readDecimalString(params, "minBaseAmountIn")),
    ...optional("amountBaseMax", readDecimalString(params, "maxBaseAmountIn")),
    ...optional("amountQuoteMin", readDecimalString(params, "minQuoteAmountIn")),
    ...optional("amountQuoteMax", readDecimalString(params, "maxQuoteAmountIn")),
    ...optional("startAtMs", readInstantMs(params, "startAtMs")),
    ...optional("endAtMs", readInstantMs(params, "endAtMs")),
    ...optional("maker", emptyToUndefined(str(params, "maker"))),
  };

  const { transport, subject } = await readSubject(params, signal);
  const cursor = decodeCursor(str(params, "cursor"), subject.pairAddress, filters);

  /* --- fetch ------------------------------------------------------- */

  const startedAtMs = Date.now();
  const collected: ProjectedTrade[] = [];
  let pagesFetched = 0;
  let bytes = 0;
  let channel: "connect" | "feed_ws" = "connect";
  let nextCursor: TradeCursor | null = null;
  let boundHit: "page_budget" | "deadline" | null = null;
  let lastResponseHeaders: ReadonlyMap<string, string> | undefined;
  /*
   * S10-2. AN AGGREGATE WITH NO RANGE HAS NOTHING TO WALK TOWARDS.
   *
   * Raw mode answers from one page; an aggregate walks until it has passed the
   * requested start. When no `startAtMs` was given there IS no start to pass,
   * so the walk simply spent the whole page budget every time: measured at 12.2
   * seconds by default against 1.5 seconds at maxPages 1, for an answer whose
   * coverage nobody had asked to extend. An UNRANGED aggregate therefore
   * defaults to a small budget, and an explicit maxPages is always honoured -
   * the caller who wants a deeper unranged sample says so and gets it.
   */
  const maxPagesGiven = num(params, "maxPages") !== undefined;
  const unrangedAggregateBudget = Math.min(
    maxPages,
    TRADES_UNRANGED_AGGREGATE_PAGES
  );
  const pageBudget =
    mode === "raw"
      ? 1
      : maxPagesGiven || filters.startAtMs !== undefined
        ? maxPages
        : unrangedAggregateBudget;
  let pageCursor = cursor;

  for (;;) {
    if (pagesFetched >= pageBudget) {
      if (mode !== "raw") boundHit = "page_budget";
      break;
    }
    if (pagesFetched > 0 && Date.now() - startedAtMs >= deadlineMs) {
      boundHit = "deadline";
      break;
    }
    const page = await fetchTradesPage({
      transport,
      chainId: subject.chainId,
      pairAddress: subject.pairAddress,
      ammId: subject.ammId,
      quoteTokenAddress: subject.quoteTokenAddress,
      inverted: false,
      filters,
      ...(pageCursor === null ? {} : { cursor: pageCursor }),
      timeoutMs: CHANNEL_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    pagesFetched += 1;
    // S10-36: the freshest Connect read's cache headers. Stays undefined on a
    // feed-WebSocket walk, where `not_cached` is the measured truth.
    if (page.responseHeaders !== undefined) {
      lastResponseHeaders = page.responseHeaders;
    }
    bytes += page.bytes;
    channel = page.channel;
    collected.push(...page.trades);
    nextCursor = page.nextCursor;
    if (page.nextCursor === null) break;
    if (mode === "raw") break;
    // A range aggregate stops as soon as it has walked past the requested
    // start; there is nothing older in the window to summarise.
    if (
      filters.startAtMs !== undefined
      && oldestTimestamp(page.trades) !== null
      && (oldestTimestamp(page.trades) ?? 0) <= filters.startAtMs
    ) {
      break;
    }
    pageCursor = page.nextCursor;
  }

  const wantsRows = mode === "raw" || mode === "both";
  const wantsAggregate = mode === "aggregate" || mode === "both";
  const rows = wantsRows ? collected.slice(0, limit) : [];
  const rangeFullyCovered = boundHit === null;

  /*
   * THE CONTINUATION RESUMES FROM THE LAST ROW THIS ANSWER EMITTED.
   *
   * The provider's own page cursor points at the oldest row it FETCHED. With
   * limit below the provider's 100-row page that is not where this answer
   * stopped: measured, limit 25 emitted rows 1-25 and handed back a cursor
   * built from row 100, so rows 26-100 were reachable by no request at all.
   * A row cut is only a bound when everything it withheld is still reachable,
   * so the cursor is rebuilt from the last EMITTED row whenever fewer rows
   * were returned than were fetched.
   */
  const withheldRows = wantsRows ? collected.length - rows.length : 0;
  const lastEmitted = rows[rows.length - 1];
  const emittedCursor =
    withheldRows > 0 && lastEmitted !== undefined
      ? tradeCursorAt(lastEmitted)
      : null;
  const continuation = withheldRows > 0 ? emittedCursor : nextCursor;
  const hasMore = withheldRows > 0 || nextCursor !== null;

  const aggregateBlockName = rangeFullyCovered ? "aggregate" : "pageAggregate";

  return ok({
    summary: summarize(subject.baseTokenSymbol, {
      mode,
      eventType,
      rows,
      population: collected,
      aggregateBlockName,
      rangeFullyCovered,
      withheldRows,
    }),
    subject: subjectBlock(subject),
    mode,
    // S10-60: `mode` echoes what was ASKED FOR and stays that way, because a
    // caller reconciling its own request needs its own word back. What the
    // answer actually contains is `aggregateBlockName`, which is the key the
    // aggregate is published under, and the summary above names that one.
    ...(wantsAggregate ? { aggregateBlockName } : {}),
    filtersApplied: {
      eventType,
      minVolumeUsd: filters.volumeUsdMin ?? null,
      maxVolumeUsd: filters.volumeUsdMax ?? null,
      minBaseAmountIn: filters.amountBaseMin ?? null,
      maxBaseAmountIn: filters.amountBaseMax ?? null,
      minQuoteAmountIn: filters.amountQuoteMin ?? null,
      maxQuoteAmountIn: filters.amountQuoteMax ?? null,
      startAtMs: filters.startAtMs ?? null,
      endAtMs: filters.endAtMs ?? null,
      afterBlock: filters.afterBlock ?? null,
      maker: filters.maker ?? null,
      note: "Every filter here ran SERVER-side and this echo is the proof of what was actually asked. Time filters are honoured to the second (measured exact on a one-hour window); a wrong-case or unsupported event type is rejected by the provider rather than ignored. afterBlock is a lower BLOCK bound, not a forward cursor, and it EXCLUDES the block passed: rows inside the window still arrive newest-first and the window is paged with cursor.",
    },
    ...(wantsRows
      ? {
          trades: rows.map((trade) => shapeTrade(trade, profileDepth)),
          returned: rows.length,
        }
      : { returned: 0 }),
    ...(wantsAggregate
      ? {
          [aggregateBlockName]: aggregate(
            collected,
            rangeFullyCovered,
            filters
          ),
        }
      : {}),
    traderSemantics:
      "netCashFlowUsd is dollars OUT minus dollars IN on this pair and is NOT profit: cost basis, transfers and every other venue are invisible to this channel. retainedBoughtPct is the share of what the wallet BOUGHT here that it still holds, never a share of token supply. newOnPair means new on THIS pair, not a newly created wallet. No accumulating-versus-distributing label is emitted, because this data cannot support one. THE WINDOW IS THE PROVIDER'S TRAILING 30 DAYS, not the range you filtered to and not the pair's whole life, and firstSwapAtMs is CLAMPED to that window floor: a wallet trading here before the window opened reports exact UTC midnight thirty days ago with a zero millisecond remainder, which means \"no later than\" and never \"first traded at\". dexscreener__top_traders_list ranks over its own declared window, so the two tools can answer the same wallet question with different numbers without either being wrong.",
    pagination: {
      mode: "exact_cursor",
      hasMore,
      nextCursor:
        continuation === null
          ? null
          : encodeCursor(continuation, subject.pairAddress, filters),
      rowsFetched: collected.length,
      rowsReturned: rows.length,
      rowsWithheldByLimit: withheldRows,
      ...(hasMore && continuation === null
        ? {
            cursorUnavailableReason:
              "There are more rows, but the last row this answer emitted did not carry the complete block, transaction and event triple, so no EXACT continuation can be built from it. A block-only position was measured skipping a real trade, so none is invented here. Raise limit to emit a row that carries the triple, or narrow the filters.",
          }
        : {}),
      note: `The cursor encodes the provider's block, transaction index and event index together. A block-only cursor was measured OMITTING a real buy that shared the boundary block, so nothing less than the exact triple is offered. It is built from the LAST ROW THIS ANSWER RETURNED, never from the oldest row fetched, so the ${withheldRows} row(s) held back by limit are reached by the next call rather than skipped. It is bound to this pair and these filters and is refused if replayed against a different query.${mode === "both" ? " In both mode it continues the ROW stream; the aggregate covered every row fetched, which coveredRange states, so a continued aggregate overlaps this one." : ""}`,
    },
    providerWindow: {
      endpoint:
        channel === "connect"
          ? "/feed/rpc/dex_feed.PublicService/GetTransactions"
          : "feed/ws getHistoricalTransactions",
      channel,
      channelNote:
        channel === "connect"
          ? "Served over the Connect HTTP read, whose single-value event-type vocabulary was re-measured 2026-08-25 as exactly buy, sell, add and remove, each returning 100 correctly filtered rows. Both channels express afterBlock: Connect sends afterBlockNumber, the socket sends the equivalent measured lower-bound triple, so a cursor walk inside an afterBlock window continues rather than dead-ending."
          : "Served over the feed WebSocket, which is the only channel that accepts an exact cursor and the only one that expresses the COMBINED filters (swap, liquidity). Connect refuses those with a structured 400; it does accept add and remove on their own, which is why those no longer come here.",
      rowsPerPage: TRADES_PER_PAGE,
      // A permanently-null provider field, counted rather than assumed. Every
      // one of 300 live rows across two chains carried no market cap, so a
      // zero here is the measured normal and a non-zero is news.
      rowsWithMarketCapUsd: collected.filter(
        (trade) => trade.marketCapUsd !== null
      ).length,
      // S10-58: the SAME accounting, for the block that was silently absent.
      // Measured: 0 of 204 robinhood rows carried a traderProfile because the
      // provider's bytes had no traderScreener block at all, and compact and
      // none returned byte-identical rows with nothing to say so. A wallet
      // study that finds no wallet data must be able to tell "no trader was
      // new here" from "this channel sent no trader data".
      rowsWithTraderProfile: collected.filter((trade) => trade.trader !== null)
        .length,
      traderProfileNote:
        "rowsWithTraderProfile counts how many rows in THIS answer carried the provider's per-wallet block. The block is a whole-response feature of the channel, not a per-row one: a chain where the provider omits it returns zero here on every row, which is a provider gap and not a statement that the wallets are ordinary. Measured 0 of 204 rows on robinhood. When this is zero, traderProfileDepth has nothing to shape and compact, full and none all return the same rows.",
      marketCapNote:
        "marketCapUsd on a trade row comes from the provider's swap.latest block, which was measured NEVER populated on either channel: 0 of 300 live rows in wave 1, and 0 of 757 rows across majors in wave 2, including a pair with a 2.1 billion USD market cap, so the absence is not a small-pair artefact. rowsWithMarketCapUsd counts how many rows in THIS answer carried one. A null there is the provider sending nothing, not a trade without a market cap; derive market cap from dexscreener__candles_list with series marketCap instead.",
      serverSide: true,
      pagesFetched,
      maxPages: pageBudget,
      ...(mode === "raw" || maxPagesGiven || filters.startAtMs !== undefined
        ? {}
        : {
            maxPagesNote: `This aggregate named no startAtMs, so there is no range for the walk to cover and it stopped at ${TRADES_UNRANGED_AGGREGATE_PAGES} page(s) rather than spending the ${maxPages}-page budget on an open-ended sample. Measured, the open-ended walk cost 12.2 seconds against 1.5 for one page. Pass maxPages explicitly for a deeper sample, or startAtMs for a real range.`,
          }),
      deadlineMs,
      pageBudgetHit: boundHit === "page_budget",
      deadlineHit: boundHit === "deadline",
      responseBytes: bytes,
    },
    contextHandoff:
      "For the price action around a window call dexscreener__candles_list with the same range; for the wallets ranked across the whole pair rather than this window call dexscreener__top_traders_list.",
    sourceObservation: observation(transport, Date.now(), lastResponseHeaders),
  });
}

/* ------------------------------------------------------------------ */
/* Row shaping                                                         */
/* ------------------------------------------------------------------ */

function shapeTrade(
  trade: ProjectedTrade,
  depth: TraderProfileDepth
): Record<string, unknown> {
  const trader = trade.trader;
  return {
    eventType: trade.eventType,
    blockNumber: trade.blockNumber,
    timestampMs: trade.blockTimestampMs,
    transactionId: trade.transactionId,
    // The position triple is the row's only unique identity. One transactionId
    // was measured carrying FOUR events (sell, remove, add, buy), so a model
    // de-duplicating by transaction hash, the only identity the rows offered,
    // dropped three real events. These two integers are also what the cursor
    // contract is built on, so a caller can now see the values it round-trips.
    transactionIndex: trade.transactionIndex,
    eventIndex: trade.eventIndex,
    maker: trade.maker,
    priceUsd: trade.priceUsd,
    priceNative: trade.priceNative,
    volumeUsd: trade.volumeUsd,
    amountBase: trade.amountBase,
    amountQuote: trade.amountQuote,
    marketCapUsd: trade.marketCapUsd,
    ...(depth === "none" || trader === null
      ? {}
      : {
          traderProfile: {
            buys: trader.buys,
            sells: trader.sells,
            volumeUsdBuy: trader.volumeUsdBuy,
            volumeUsdSell: trader.volumeUsdSell,
            netCashFlowUsd: trader.netCashFlowUsd,
            retainedBoughtPct: trader.retainedBoughtPct,
            newOnPair: trader.newOnPair,
            firstSwapAtMs: trader.firstSwapAtMs,
            ...(depth === "full"
              ? {
                  balanceAmount: trader.balanceAmount,
                  volumeBaseBuy: trader.volumeBaseBuy,
                  volumeBaseSell: trader.volumeBaseSell,
                }
              : {}),
          },
        }),
  };
}

/* ------------------------------------------------------------------ */
/* Aggregate                                                           */
/* ------------------------------------------------------------------ */

function aggregate(
  trades: readonly ProjectedTrade[],
  rangeFullyCovered: boolean,
  filters: TradeFilters
): Record<string, unknown> {
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  const newOnPair = new Set<string>();
  const makers = new Set<string>();
  let buyCount = 0;
  let sellCount = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  let addCount = 0;
  let removeCount = 0;
  const histogram = new Map<string, number>();
  for (const bucket of bucketLabels()) histogram.set(bucket, 0);
  // Events with no USD figure of their own. Liquidity adds and removes are the
  // measured population: they are real events, they are counted in
  // liquidityAdds and liquidityRemoves, and they belong in no dollar bucket.
  let unvalued = 0;

  for (const trade of trades) {
    const maker = trade.maker;
    if (maker !== null) {
      makers.add(maker);
      if (trade.trader?.newOnPair === true) newOnPair.add(maker);
    }
    // `Number("")` is 0 and `Number.isFinite(0)` is true, so `?? ""` turned
    // every event the provider reported no USD figure for into a $0 trade:
    // measured, the liquidity add and remove in a 25-row window were both
    // filed in the "0-100" bucket, in direct contradiction of the note printed
    // beside the histogram. With the default eventType of "all" that inflates
    // the smallest bucket on every aggregate.
    const usd = trade.volumeUsd === null ? NaN : Number(trade.volumeUsd);
    const usable = Number.isFinite(usd);
    if (!usable) unvalued += 1;
    if (trade.eventType === "buy") {
      buyCount += 1;
      if (maker !== null) buyers.add(maker);
      if (usable) buyUsd += usd;
    } else if (trade.eventType === "sell") {
      sellCount += 1;
      if (maker !== null) sellers.add(maker);
      if (usable) sellUsd += usd;
    } else if (trade.eventType === "add") {
      addCount += 1;
    } else if (trade.eventType === "remove") {
      removeCount += 1;
    }
    if (usable) {
      const label = bucketFor(usd);
      histogram.set(label, (histogram.get(label) ?? 0) + 1);
    }
  }

  const timestamps = trades
    .map((trade) => trade.blockTimestampMs)
    .filter((value): value is number => value !== null);

  return {
    tradeCount: trades.length,
    buys: buyCount,
    sells: sellCount,
    liquidityAdds: addCount,
    liquidityRemoves: removeCount,
    buyVolumeUsd: buyUsd,
    sellVolumeUsd: sellUsd,
    // Direction of pressure in dollars, on this pair, over the covered range.
    netFlowUsd: buyUsd - sellUsd,
    netFlowNote:
      "netFlowUsd here is buyVolumeUsd minus sellVolumeUsd: positive means dollars flowed INTO the token over this range. The per-row netCashFlowUsd on a trader profile uses the OPPOSITE convention on purpose - it is dollars out minus dollars in from the WALLET's side, so a wallet that bought reads negative there. One mode:\"both\" answer therefore shows the same activity as +1859.32 here and -1859.32 on the row, and neither is a sign error. Compare like with like before drawing a direction.",
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    uniqueMakers: makers.size,
    walletsOnBothSides: [...buyers].filter((maker) => sellers.has(maker)).length,
    newOnPairCount: newOnPair.size,
    newOnPairSharePct:
      makers.size === 0 ? null : (newOnPair.size / makers.size) * 100,
    newOnPairNote:
      "The share of the wallets in this range that the provider marks as new on THIS pair. It says nothing about wallet age, funding, or whether they are one entity.",
    sizeHistogramUsd: Object.fromEntries(histogram),
    unvaluedEvents: unvalued,
    sizeHistogramNote:
      "Buckets are fixed so two calls are comparable; a histogram whose buckets moved with the sample could not be. Events with no USD figure are counted in unvaluedEvents and in no bucket; they are never filed as zero-dollar trades. The bucket counts plus unvaluedEvents equal tradeCount.",
    largestTrades: largest(trades),
    coveredRange:
      timestamps.length === 0
        ? null
        : {
            startAtMs: Math.min(...timestamps),
            endAtMs: Math.max(...timestamps),
          },
    requestedRange: {
      startAtMs: filters.startAtMs ?? null,
      endAtMs: filters.endAtMs ?? null,
    },
    rangeFullyCovered,
    rangeNote: rangeFullyCovered
      ? "The walk reached the end of the requested range, so these figures cover it completely."
      : "A page or time bound was hit BEFORE the requested range was covered, so this block is named pageAggregate rather than aggregate: it summarises only coveredRange. Raise maxPages or deadlineMs, or narrow the range, before reading these figures as a statement about the whole window.",
  };
}

function bucketLabels(): readonly string[] {
  const labels: string[] = [];
  let previous = 0;
  for (const bound of TRADE_SIZE_BUCKETS_USD) {
    labels.push(`${previous}-${bound}`);
    previous = bound;
  }
  labels.push(`${previous}+`);
  return labels;
}

function bucketFor(usd: number): string {
  let previous = 0;
  for (const bound of TRADE_SIZE_BUCKETS_USD) {
    if (usd < bound) return `${previous}-${bound}`;
    previous = bound;
  }
  return `${previous}+`;
}

function largest(
  trades: readonly ProjectedTrade[]
): readonly Record<string, unknown>[] {
  return [...trades]
    // Same rule as the histogram: a row the provider gave no USD figure for is
    // not a zero-dollar trade and cannot compete for "largest".
    .filter(
      (trade) =>
        trade.volumeUsd !== null && Number.isFinite(Number(trade.volumeUsd))
    )
    .sort((a, b) => Number(b.volumeUsd) - Number(a.volumeUsd))
    .slice(0, TRADE_LARGEST_COUNT)
    .map((trade) => ({
      eventType: trade.eventType,
      volumeUsd: trade.volumeUsd,
      maker: trade.maker,
      timestampMs: trade.blockTimestampMs,
      transactionId: trade.transactionId,
    }));
}

/* ------------------------------------------------------------------ */
/* Cursor                                                              */
/* ------------------------------------------------------------------ */

/**
 * An opaque, versioned cursor bound to the pair and the filter set.
 *
 * Bound rather than bare so a cursor cannot be replayed against a different
 * query: continuing a `buy` walk with a `sell` cursor would silently answer a
 * question nobody asked, and the rows would look perfectly ordinary.
 */
function encodeCursor(
  cursor: TradeCursor,
  pairAddress: string,
  filters: TradeFilters
): string {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    p: pairAddress.toLowerCase(),
    f: filterFingerprint(filters),
    b: cursor.blockNumber,
    t: cursor.transactionIndex,
    e: cursor.eventIndex,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

function decodeCursor(
  raw: string,
  pairAddress: string,
  filters: TradeFilters
): TradeCursor | null {
  if (raw === "") return null;
  let parsed: Record<string, unknown>;
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    parsed = JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    throw siteError(
      DexScreenerSiteErrorCodes.TRADES_CURSOR_INVALID,
      "The cursor is not a continuation token this tool issued",
      "Pass back the exact nextCursor string from a previous dexscreener__trades_list answer, or omit it to start from the newest trades."
    );
  }
  if (parsed["v"] !== CURSOR_VERSION) {
    throw siteError(
      DexScreenerSiteErrorCodes.TRADES_CURSOR_INVALID,
      `The cursor was issued by a different version of this tool (${String(parsed["v"])})`,
      "Start the walk again without a cursor; the continuation format changed and an old position cannot be honoured safely."
    );
  }
  if (parsed["p"] !== pairAddress.toLowerCase()) {
    throw siteError(
      DexScreenerSiteErrorCodes.TRADES_CURSOR_INVALID,
      "The cursor belongs to a different pair than the one this call names",
      "A cursor is bound to the pair that issued it. Continue the original pair's walk, or start a fresh one for this pair without a cursor."
    );
  }
  if (parsed["f"] !== filterFingerprint(filters)) {
    throw siteError(
      DexScreenerSiteErrorCodes.TRADES_CURSOR_INVALID,
      "The cursor was issued under a different filter set than the one this call names",
      "Continuing one filter's walk with another filter's position would silently answer a question you did not ask. Repeat the original filters, or start a fresh walk without a cursor."
    );
  }
  const block = parsed["b"];
  const transactionIndex = parsed["t"];
  const eventIndex = parsed["e"];
  if (
    typeof block !== "number"
    || typeof transactionIndex !== "number"
    || typeof eventIndex !== "number"
  ) {
    throw siteError(
      DexScreenerSiteErrorCodes.TRADES_CURSOR_INVALID,
      "The cursor does not carry a complete block, transaction and event position",
      "Only the exact triple is a safe continuation: a block-only position was measured skipping a real trade. Start a fresh walk without a cursor."
    );
  }
  return { blockNumber: block, transactionIndex, eventIndex };
}

/** Everything that changes WHICH trades the provider returns. */
function filterFingerprint(filters: TradeFilters): string {
  return [
    filters.eventType,
    filters.volumeUsdMin ?? "",
    filters.volumeUsdMax ?? "",
    filters.amountBaseMin ?? "",
    filters.amountBaseMax ?? "",
    filters.amountQuoteMin ?? "",
    filters.amountQuoteMax ?? "",
    filters.startAtMs ?? "",
    filters.endAtMs ?? "",
    filters.afterBlock ?? "",
    (filters.maker ?? "").toLowerCase(),
  ].join("|");
}

/* ------------------------------------------------------------------ */
/* Small readers                                                       */
/* ------------------------------------------------------------------ */

function optional<K extends string, V>(
  key: K,
  value: V | undefined
): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function emptyToUndefined(value: string): string | undefined {
  return value === "" ? undefined : value;
}

/** A USD bound. Dollars, so a number is natural; rendered exactly for the wire. */
function usdString(
  params: Record<string, unknown>,
  key: string
): string | undefined {
  const raw = num(params, key);
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw < 0) {
    throw siteError(
      DexScreenerSiteErrorCodes.SCREEN_SHAPING_VALUE_INVALID,
      `"${key}" must be a non-negative number of US dollars; received ${String(raw)}`,
      "Send a plain number, for example 10000."
    );
  }
  return String(raw);
}

function oldestTimestamp(trades: readonly ProjectedTrade[]): number | null {
  let oldest: number | null = null;
  for (const trade of trades) {
    if (trade.blockTimestampMs === null) continue;
    if (oldest === null || trade.blockTimestampMs < oldest) {
      oldest = trade.blockTimestampMs;
    }
  }
  return oldest;
}

/** The coverage facts the summary is not allowed to contradict. */
interface TradesSummaryFacts {
  readonly mode: TradeMode;
  readonly eventType: TradeEventType;
  /** The rows actually emitted under `trades`. Empty when mode is aggregate. */
  readonly rows: readonly ProjectedTrade[];
  /** Every event fetched: the population the aggregate block is computed over. */
  readonly population: readonly ProjectedTrade[];
  /** The key the aggregate is published under: `aggregate` or `pageAggregate`. */
  readonly aggregateBlockName: "aggregate" | "pageAggregate";
  readonly rangeFullyCovered: boolean;
  readonly withheldRows: number;
}

function flowOf(trades: readonly ProjectedTrade[]): string {
  const buys = trades.filter((trade) => trade.eventType === "buy").length;
  const sells = trades.filter((trade) => trade.eventType === "sell").length;
  return `${buys} buys, ${sells} sells`;
}

/**
 * Describe what this answer actually contains, mode by mode and bound by bound.
 *
 * THE DEFECT THIS REPLACES INVERTED FLOW DIRECTION ON THE DEFAULT PATH. The old
 * sentence counted `collected` - the whole fetched page - in every mode, so a
 * default `limit: 25` call read "100 events (67 buys, 33 sells), returned as
 * raw" while the 25 rows in hand were 11 buys and 14 sells. A reader acting on
 * the summary saw buying pressure where the rows showed the opposite. It also
 * said "returned as aggregate" when the page budget had been hit and the block
 * was honestly published as `pageAggregate`, and counted 1000 events against 15
 * returned rows.
 *
 * So: row counts come from the rows, population counts are NAMED as population,
 * and the block name in the sentence is the block name in the envelope.
 */
function summarize(symbol: string | null, facts: TradesSummaryFacts): string {
  const subject = symbol ?? "this pair";
  const kind = facts.eventType === "all" ? "" : `${facts.eventType} `;
  if (facts.population.length === 0) {
    return `No ${kind}trades matched on ${subject}. The provider answered, so this is an empty match on these filters rather than an unreachable pair.`;
  }

  const coverage = facts.rangeFullyCovered
    ? ""
    : ` The requested range was NOT fully covered: the page budget stopped the walk, so this describes the newest part of the window only.`;

  if (facts.mode === "aggregate") {
    return `${facts.population.length} ${kind}events on ${subject} (${flowOf(facts.population)}) were fetched and summarised into the ${facts.aggregateBlockName} block; no individual rows were returned in this mode.${coverage}`;
  }

  const shown = `${facts.rows.length} ${kind}${facts.rows.length === 1 ? "event" : "events"} on ${subject} (${flowOf(facts.rows)})`;
  const withheld =
    facts.withheldRows === 0
      ? ""
      : ` ${facts.withheldRows} further fetched ${facts.withheldRows === 1 ? "event was" : "events were"} withheld by your limit and are reachable with the cursor in pagination.`;

  if (facts.mode === "raw") {
    return `${shown} are returned as raw rows.${withheld}${coverage}`;
  }
  return `${shown} are returned as raw rows, beside a ${facts.aggregateBlockName} block computed over the full fetched population of ${facts.population.length} ${kind}${facts.population.length === 1 ? "event" : "events"} (${flowOf(facts.population)}), which is a larger set than the rows.${withheld}${coverage}`;
}
