/**
 * Trade history for one pair, on BOTH of the provider's channels, plus the
 * block anchor the candle walk is built on.
 *
 * TWO CHANNELS, ONE ROW SHAPE, AND A REASON FOR EACH.
 *
 *  - CONNECT GET (`/feed/rpc/dex_feed.PublicService/GetTransactions`) carries
 *    the whole filter set as urlsafe base64 in one `message` query parameter.
 *    It is a plain HTTP read, so it is what a filtered page and the block
 *    anchor use.
 *  - FEED WEBSOCKET (`getHistoricalTransactions`) is the ONLY channel that
 *    accepts an exact `(blockNumber, transactionIndex, eventIndex)`
 *    continuation. This is not a preference. A controlled probe set the cursor
 *    to `(25824167, 213, 558)` on a real BUY: the exact WS request resumed at
 *    `(25824167, 2, 7)` in the same block, while Connect with
 *    `beforeBlockNumber=25824167` started at `(25824148, 122, 171)` and OMITTED
 *    the remaining BUY in the boundary block. A block-only cursor loses real
 *    events, so every continuation this module issues is the exact triple and
 *    every continued page is fetched on the socket.
 *
 * FILTER GRAMMAR, MEASURED. `type` is a LOWERCASE string on Connect and is
 * case-sensitive: `type=BUY` answers the structured
 * `400 {"code":"invalid_argument"}`. The WebSocket takes the same filter as an
 * ENUM instead. Timestamps are second-precise on both and were measured exact
 * (a one-hour window returned 34 rows, all inside it).
 *
 * THE CONNECT TYPE VOCABULARY IS EXACTLY FOUR VALUES, RE-MEASURED 2026-08-25.
 * `buy`, `sell`, `add` and `remove` each answer HTTP 200 with 100 correctly
 * filtered rows (`add` and `remove` verified on ethereum PEPE/WETH, whose pool
 * carries real joinExit events: 100 of 100 rows came back with the matching
 * `joinExit.type` arm). Only the COMBINED spellings are refused: `swap`,
 * `liquidity`, `buy_or_sell`, `add_or_remove` and `all` each answer
 * `400 {"code":"invalid_argument"}`, as does any wrong casing and the empty
 * string. This build previously marked `add` and `remove` as having no proven
 * Connect spelling and routed them to the socket for a reason that was never
 * true; the socket is the more expensive and more fragile channel, so the
 * correction moves real traffic, not just a comment.
 *
 * THE QUOTE TOKEN IS THE ORIENTATION KEY AND IT IS CASE-SENSITIVE. See the
 * invariant recorded on `PairSubject.quoteTokenAddress`: a `quoteTokenAddress`
 * that is not the provider's own verbatim spelling of the pair's quote token
 * (including a correctly-spelled address that has merely been LOWER-CASED)
 * returns HTTP 200 with the pair silently INVERTED. `pairId` is likewise
 * case-sensitive on EVM: the checksum spelling returns 100 rows and the
 * lowercased one returns a 200 with zero. Neither value is ever re-cased or
 * hand-built here; both come from `resolvePairSubject`, which carries the
 * provider's own spelling.
 *
 * THE PER-TRADE COUNTERPARTY PROFILE, WITH ITS SEMANTICS CORRECTED. Every row
 * carries `traderScreener`. Three of its fields were being read wrongly and
 * each correction is load-bearing under rule 90:
 *
 *  - `balancePercentage` is `balanceAmount / volumeBuy * 100` (verified on 99
 *    of 100 captured rows). It is the share of what this wallet BOUGHT on this
 *    pair that it still holds. It is NOT percent of token supply and is named
 *    `retainedBoughtPct` here so it cannot be read as one.
 *  - `volumeUSDSell - volumeUSDBuy` is NET CASH FLOW, not realized profit. Cost
 *    basis and transfers are invisible to a venue.
 *  - `isNew` means new on THIS pair, not a globally fresh wallet, and is named
 *    `newOnPair`.
 *
 * There is deliberately no accumulating-versus-distributing label anywhere: the
 * provider cannot see transfers or other venues, so any such label would be a
 * guess presented as a measurement.
 */

import { encodeDexScreenerCommand } from "../codec/encode.js";
import { decodeDexScreenerMessageToJson } from "../codec/protobuf.js";
import {
  DexScreenerSiteErrorCodes,
  isDexScreenerSiteError,
  siteError,
} from "../site-errors.js";
import type { DexScreenerTransport } from "../transport.js";
import { DEXSCREENER_FEED_WS_URL } from "./pair-live.js";

/** The site host that serves the Connect RPC. */
export const DEXSCREENER_FEED_RPC_ORIGIN = "https://io.dexscreener.com";

/** Rows the provider serves in ONE page, on either channel. Measured on both. */
export const TRADES_PER_PAGE = 100;

/**
 * Byte ceiling for one trades page.
 *
 * Measured 27,410 bytes on Connect and 27,418 on the socket for 100 rows with
 * full counterparty profiles. One megabyte bounds a page well above that.
 */
export const TRADES_MAX_BYTES = 1_000_000;

/**
 * COUNTABLE frames to collect on the feed socket while looking for the answer.
 *
 * ONE, for the reason spelled out on `BARS_FRAMES`: `feed/ws` is strictly
 * request-response, so one command produces exactly one countable frame and
 * that frame IS the answer. Measured on this channel specifically: a
 * `getHistoricalTransactions` command produced `[27484, 0, 0]`, the
 * 27,484-byte answer arriving at t=0.54 s and every later frame a zero-length
 * keepalive that does not count.
 *
 * This was 4, which could never be met once keepalives stopped padding the
 * count, so every socket-served trades page timed out at 25 seconds with the
 * answer already in hand. That reached `eventType: swap` and `liquidity` and
 * EVERY cursor continuation page.
 */
export const TRADES_FRAMES = 1;

/** Frozen walk bounds, the same vocabulary and defaults candles use (plan 14.5). */
export const TRADES_MAX_PAGES_DEFAULT = 10;
export const TRADES_DEADLINE_MS_DEFAULT = 25_000;
export const TRADES_DEADLINE_MS_CEILING = 120_000;

/* ------------------------------------------------------------------ */
/* The filter vocabulary                                               */
/* ------------------------------------------------------------------ */

/**
 * What the caller can ask for.
 *
 * `swap` and `liquidity` are the provider's own combined filters, which a
 * side-only parameter would have hidden. `all` sends no type filter at all.
 */
export const TRADE_EVENT_TYPES = [
  "all", "swap", "buy", "sell", "liquidity", "add", "remove",
] as const;

export type TradeEventType = (typeof TRADE_EVENT_TYPES)[number];

interface EventTypeSpec {
  /**
   * The lowercase, case-sensitive string the Connect channel takes, or null
   * when the provider has no single-value spelling for it.
   *
   * Measured: `buy`, `sell`, `add` and `remove` are accepted (100 correctly
   * filtered rows each), and `BUY` is REFUSED with a structured 400, which is
   * what makes the casing a contract rather than a style. The provider's
   * COMBINED filters (`swap`, `liquidity`) answer 400 under every spelling
   * tried, so they are served on the WebSocket, whose enum members come from
   * the checked-in descriptor set and are therefore proven.
   */
  readonly connect: string | null;
  /** The `WSCommand.GetHistoricalTransactions.Type` member. Null sends none. */
  readonly ws: string | null;
  /** False when Connect cannot express this filter and the socket must serve it. */
  readonly connectCanExpress: boolean;
}

const EVENT_TYPES: Readonly<Record<TradeEventType, EventTypeSpec>> = {
  all: { connect: null, ws: null, connectCanExpress: true },
  swap: { connect: null, ws: "TYPE_BUY_OR_SELL", connectCanExpress: false },
  buy: { connect: "buy", ws: "TYPE_BUY", connectCanExpress: true },
  sell: { connect: "sell", ws: "TYPE_SELL", connectCanExpress: true },
  liquidity: { connect: null, ws: "TYPE_ADD_OR_REMOVE", connectCanExpress: false },
  // Measured accepted on Connect 2026-08-25, 100 matching joinExit rows each.
  add: { connect: "add", ws: "TYPE_ADD", connectCanExpress: true },
  remove: { connect: "remove", ws: "TYPE_REMOVE", connectCanExpress: true },
};

/**
 * Which channel serves a request.
 *
 * Two facts decide it and neither is a preference: a continuation needs the
 * exact `(block, transactionIndex, eventIndex)` triple, which only the socket
 * accepts; and a combined event-type filter Connect refuses must go where the
 * spelling IS proven. Everything else takes the cheaper HTTP read, and after
 * the 2026-08-25 re-measurement that now includes `add` and `remove`.
 */
export function tradesChannelFor(
  eventType: TradeEventType,
  hasCursor: boolean
): "connect" | "feed_ws" {
  if (hasCursor) return "feed_ws";
  return EVENT_TYPES[eventType].connectCanExpress ? "connect" : "feed_ws";
}

/**
 * The index pair that turns the socket's `after` TRIPLE into Connect's
 * BLOCK-exclusive `afterBlockNumber`.
 *
 * MEASURED LIVE 2026-08-25, solana/pumpfundex/Gyz6Rx..QJ1w, boundary block
 * B = 441363104 which carries three events at transaction indices 131, 51 and
 * 10 (archived: `scratchpad/s9/ws-after.out.json`, `ws-after-max.out.json`):
 *
 *  - `after = (B, 0, 0)`      -> 82 rows, ALL THREE of B's events PRESENT;
 *  - `after = (B, 10, 3)`     -> 81 rows, exactly that one event absent, so
 *                                the bound is STRICTLY EXCLUSIVE and compares
 *                                the triple lexicographically, newest-first;
 *  - `after = (B, MAX, MAX)`  -> 79 rows, NONE of B's events, oldest block
 *                                returned 441363187, which is the next block
 *                                above B.
 *
 * Connect's `afterBlockNumber = B` was measured on the same subject and the
 * same block returning the same 79-row shape (ep12: 77 rows above B on its own
 * smaller page, boundary block absent). So the two channels express the SAME
 * window when, and only when, the socket's triple is anchored at the largest
 * index pair. Anchoring at `(B, 0, 0)` instead would silently include a
 * boundary block that Connect excludes, which is the disagreement the previous
 * refusal existed to avoid; it is now measured rather than guessed.
 *
 * uint32 max, because `transactionIndex` and `eventIndex` are uint32 in
 * `dex_feed.TransactionIdentity` (descriptor, fields 2 and 3).
 */
const WS_AFTER_BLOCK_EXCLUSIVE_INDEX = 4_294_967_295;

/** Every filter the two channels share. Decimal values stay STRINGS end to end. */
export interface TradeFilters {
  readonly eventType: TradeEventType;
  /**
   * A lower BLOCK bound: return only events STRICTLY ABOVE this block.
   *
   * EXCLUSIVE, measured two-sided on a boundary block carrying three events
   * (solana, B = 441363104): `afterBlock = B` returned 77 rows and none of B's
   * three, `afterBlock = B - 1` returned 80 rows including all three. So the
   * block passed in is the last block ALREADY SEEN, which is exactly what an
   * incremental poll wants to hand back, and never a block whose events are
   * expected in the answer.
   *
   * Measured honoured on Connect 2026-08-25 (`afterBlockNumber=25830000`
   * returned 100 rows spanning blocks 25830786 down to 25830275) and it
   * AND-combines with `beforeBlockNumber` into a window. Ordering stays
   * newest-first: this is a bound, not a forward cursor, so a poll for "what
   * has traded since block N" reads the newest page of that window rather
   * than streaming forward from it.
   *
   * It is the primitive the plan prescribes as the substitute for the
   * provider's gated-off live push (`subscribeTransactions` acknowledges and
   * then sends nothing, re-measured), and without it an incremental poll
   * re-pages from the head of history every time.
   *
   * Expressible on BOTH channels: Connect sends `afterBlockNumber`, and the
   * socket sends the `after` triple anchored per
   * {@link WS_AFTER_BLOCK_EXCLUSIVE_INDEX}, which was measured returning the
   * same window. That is what lets a cursor walk continue inside an
   * `afterBlock` window instead of dead-ending on the second page.
   */
  readonly afterBlock?: number;
  readonly volumeUsdMin?: string;
  readonly volumeUsdMax?: string;
  readonly amountBaseMin?: string;
  readonly amountBaseMax?: string;
  readonly amountQuoteMin?: string;
  readonly amountQuoteMax?: string;
  readonly startAtMs?: number;
  readonly endAtMs?: number;
  /** One wallet's history on this pair. */
  readonly maker?: string;
}

/** The exact continuation the provider accepts, and the only one this module issues. */
export interface TradeCursor {
  readonly blockNumber: number;
  readonly transactionIndex: number;
  readonly eventIndex: number;
}

/* ------------------------------------------------------------------ */
/* Projected rows                                                      */
/* ------------------------------------------------------------------ */

/** The counterparty's aggregate on THIS pair, with corrected semantics. */
export interface TraderProfile {
  readonly buys: number | null;
  readonly sells: number | null;
  /** Dollars this wallet has put into this pair, lifetime. */
  readonly volumeUsdBuy: string | null;
  /** Dollars this wallet has taken out of this pair, lifetime. */
  readonly volumeUsdSell: string | null;
  readonly volumeBaseBuy: string | null;
  readonly volumeBaseSell: string | null;
  readonly balanceAmount: string | null;
  /**
   * `balanceAmount / volumeBuy * 100`: the share of what this wallet BOUGHT on
   * this pair that it still holds. NOT percent of token supply.
   */
  readonly retainedBoughtPct: number | null;
  /** New on THIS pair. Not a globally fresh wallet. */
  readonly newOnPair: boolean | null;
  readonly firstSwapAtMs: number | null;
  /**
   * `volumeUSDSell - volumeUSDBuy`: net cash flow on this pair.
   *
   * NOT realized profit. Cost basis and transfers are invisible here, so a
   * positive number means more dollars came out than went in on this venue and
   * nothing more.
   */
  readonly netCashFlowUsd: number | null;
}

/** One trade or liquidity event. */
export interface ProjectedTrade {
  /** `buy`, `sell`, `add`, `remove`, or null when the provider named neither arm. */
  readonly eventType: "buy" | "sell" | "add" | "remove" | null;
  readonly blockNumber: number | null;
  readonly blockTimestampMs: number | null;
  /** The transaction hash. */
  readonly transactionId: string | null;
  readonly transactionIndex: number | null;
  readonly eventIndex: number | null;
  readonly maker: string | null;
  readonly priceUsd: string | null;
  readonly priceNative: string | null;
  readonly volumeUsd: string | null;
  readonly amountBase: string | null;
  readonly amountQuote: string | null;
  /**
   * `swap.latest.marketCapUSD`. MEASURED NEVER POPULATED ON EITHER CHANNEL.
   *
   * Null on 300 of 300 live rows across two chains and two AMM classes
   * (`swap.metadata` likewise 0 of 300), so this field is dead on the trade
   * channels as they stand. It is KEPT rather than deleted because the wire
   * field exists in the checked-in descriptor and a provider that starts
   * populating it must not need a code change to be seen; but the declaration
   * is here so nothing downstream reads a permanent null as "this trade had no
   * market cap". The handler reports `rowsWithMarketCapUsd` per answer, which
   * is the honest way to notice the day this changes.
   */
  readonly marketCapUsd: string | null;
  readonly trader: TraderProfile | null;
}

/** One page of trades, newest first, exactly as the provider ordered them. */
export interface TradesPage {
  readonly trades: readonly ProjectedTrade[];
  readonly channel: "connect" | "feed_ws";
  readonly url: string;
  readonly bytes: number;
  readonly fetchedAtMs: number;
  /**
   * The exact cursor for the next page back, or null when the page was short.
   *
   * Built from the OLDEST row of this page. A short page is the provider's own
   * end of history on this filter and carries no continuation.
   */
  readonly nextCursor: TradeCursor | null;
}

export interface TradesPageOptions {
  readonly transport: DexScreenerTransport;
  readonly chainId: string;
  readonly pairAddress: string;
  readonly ammId: string;
  /** The pair's OWN quote token, resolved by the subject resolver. */
  readonly quoteTokenAddress: string;
  readonly inverted: boolean;
  readonly filters: TradeFilters;
  /**
   * Resume strictly before this exact event.
   *
   * Present means the page is fetched on the WEBSOCKET, because Connect cannot
   * express it and its block-only approximation loses same-block events.
   */
  readonly cursor?: TradeCursor;
  /**
   * Correlation id for the socket command.
   *
   * Per CALL, for the same reason bars carry one: the feed socket multiplexes
   * and a shared constant would let two concurrent requests read each other's
   * answers. Settable so a test can replay a capture under the site's own id.
   */
  readonly correlationId?: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Fetch one page of trades.
 *
 * Channel choice is a CONSEQUENCE of the request, not an option: a continued
 * page needs the exact triple, so it goes on the socket; a first page has no
 * cursor and takes the cheaper Connect read.
 */
export async function fetchTradesPage(
  options: TradesPageOptions
): Promise<TradesPage> {
  // `afterBlock` used to be refused on every socket-routed request, because
  // the socket's lower bound is a TRIPLE whose inclusivity was unmeasured. It
  // is measured now (see WS_AFTER_BLOCK_EXCLUSIVE_INDEX) and both channels
  // express the same window, so nothing here is inexpressible and no filter
  // is dropped on either route.
  return tradesChannelFor(options.filters.eventType, options.cursor !== undefined)
    === "connect"
    ? fetchTradesConnect(options)
    : fetchTradesWs(options);
}

/* --- Connect channel -------------------------------------------------- */

/**
 * Build the Connect request URL.
 *
 * Exported so the base64 grammar has a testable owner. The `message` parameter
 * is urlsafe base64 with padding STRIPPED, which is the Connect GET convention
 * and what the site itself sends.
 */
export function tradesConnectUrl(options: TradesPageOptions): string {
  const spec = EVENT_TYPES[options.filters.eventType];
  const message = encodeDexScreenerCommand("dex_feed.GetTransactionsRequest", {
    chainId: options.chainId,
    ammId: options.ammId,
    pairId: options.pairAddress,
    quoteTokenAddress: options.quoteTokenAddress,
    ...(options.inverted ? { invert: true } : {}),
    ...(spec.connect === null ? {} : { type: spec.connect }),
    ...(options.filters.afterBlock === undefined
      ? {}
      : { afterBlockNumber: String(options.filters.afterBlock) }),
    ...stringFilter("maker", options.filters.maker),
    ...stringFilter("volumeUSDMin", options.filters.volumeUsdMin),
    ...stringFilter("volumeUSDMax", options.filters.volumeUsdMax),
    ...stringFilter("amount0Min", options.filters.amountBaseMin),
    ...stringFilter("amount0Max", options.filters.amountBaseMax),
    ...stringFilter("amount1Min", options.filters.amountQuoteMin),
    ...stringFilter("amount1Max", options.filters.amountQuoteMax),
    ...timestampFilter("timestampStart", options.filters.startAtMs),
    ...timestampFilter("timestampEnd", options.filters.endAtMs),
  });
  const encoded = Buffer.from(message)
    .toString("base64")
    // Urlsafe alphabet, then the padding removed. This is structure removal,
    // not content removal: the decoder restores it from the length.
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
  return (
    `${DEXSCREENER_FEED_RPC_ORIGIN}/feed/rpc/dex_feed.PublicService/GetTransactions`
    + `?connect=v1&encoding=proto&base64=1&message=${encoded}`
  );
}

/**
 * What to do about a non-200 from the Connect channel, BY STATUS CLASS.
 *
 * One remediation for every status was wrong in both directions. The measured
 * inventory (2026-08-25) is three distinct classes and they need three
 * different actions:
 *
 *  - 400 `{"code":"invalid_argument"}`: a DETERMINISTIC refusal of a filter
 *    value. Retrying it repeats it exactly. This was previously the only case
 *    the text described, and it was attached to the other two as well.
 *  - 415: the request's encoding was refused (`encoding=json` answers 415 with
 *    an empty body). Not a filter problem at all, and this module never sends
 *    that encoding, so a 415 here means the request grammar changed.
 *  - 500 `{"code":"internal"}`: the provider crashed on a legal-looking value.
 *    Measured on `volumeUSDMin=-5`. Negative bounds are refused before they
 *    are sent, so a 500 reaching here is the provider's own fault and IS worth
 *    one retry.
 *
 * Rule 04: a deterministic rejection, a transport failure and an unknown
 * provider state are different outcomes and must not collapse into one advice.
 */
function tradesConnectRemediation(status: number): string {
  if (status === 400) {
    return "A 400 here is a DETERMINISTIC rejection of a filter VALUE, not an empty market and not a transient failure: retrying the identical request repeats it. The provider validates the request and answers structurally. Check the AMM id and quote token with dexscreener__pair_get, and check the filter values against the parameter descriptions before asking again.";
  }
  if (status === 415) {
    return "A 415 is the provider refusing the request ENCODING, not the filters. This channel only ever sends the protobuf-plus-base64 grammar the site itself uses, so a 415 reaching here means the request grammar changed. Do not retry; re-capture the wire format.";
  }
  if (status >= 500) {
    return "A 5xx is a provider-side failure, not a rejected request. It is worth ONE retry. If it repeats, the pair, the filters and the AMM id are not the thing to change: the provider was measured answering 500 for a value it should have refused with a 400, so report the exact filter set rather than varying it blindly.";
  }
  return "This status was not in the measured inventory for this channel (400, 415 and 5xx were). Treat it as an unknown outcome rather than as an empty market: nothing here is evidence about whether the pool has trades.";
}

async function fetchTradesConnect(
  options: TradesPageOptions
): Promise<TradesPage> {
  const url = tradesConnectUrl(options);
  const response = await options.transport.httpGet(url, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    accept: "application/proto",
    maxBytes: TRADES_MAX_BYTES,
  });
  if (response.status !== 200) {
    throw siteError(
      DexScreenerSiteErrorCodes.TRADES_INVALID,
      `The DexScreener trade-history RPC answered HTTP ${response.status} for ${options.chainId}:${options.pairAddress}`,
      tradesConnectRemediation(response.status)
    );
  }
  let decoded: unknown;
  try {
    decoded = decodeDexScreenerMessageToJson(
      "dex_feed.GetTransactionsResponse",
      response.body,
      { maxBytes: TRADES_MAX_BYTES }
    );
  } catch (error) {
    if (
      isDexScreenerSiteError(error) &&
      error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
    ) {
      throw error;
    }
    throw siteError(
      DexScreenerSiteErrorCodes.TRADES_INVALID,
      `${response.body.byteLength} bytes from the trade-history RPC did not decode as dex_feed.GetTransactionsResponse`,
      "The wire schema may have changed. Re-capture the fixture and re-extract the descriptors before trusting this channel."
    );
  }
  const raw = asObject(decoded)?.["transactions"];
  const trades = (Array.isArray(raw) ? raw : []).map(projectTrade);
  return {
    trades,
    channel: "connect",
    url,
    bytes: response.body.byteLength,
    fetchedAtMs: Date.now(),
    nextCursor: cursorFrom(trades),
  };
}

/* --- Feed WebSocket channel ------------------------------------------- */

/** A fresh correlation id per command. Per call, never per module. */
let tradesCidCounter = 0;

function nextTradesCid(): number {
  tradesCidCounter = (tradesCidCounter % 1_000_000) + 1;
  return tradesCidCounter;
}

async function fetchTradesWs(options: TradesPageOptions): Promise<TradesPage> {
  const spec = EVENT_TYPES[options.filters.eventType];
  const cid = options.correlationId ?? nextTradesCid();
  const command = encodeDexScreenerCommand("dex_feed.WSCommand", {
    getHistoricalTransactions: {
      cid,
      chainId: options.chainId,
      ammId: options.ammId,
      pairId: options.pairAddress,
      quoteTokenId: options.quoteTokenAddress,
      ...(spec.ws === null ? {} : { type: spec.ws }),
      ...stringFilter("maker", options.filters.maker),
      ...stringFilter("volumeUSDMin", options.filters.volumeUsdMin),
      ...stringFilter("volumeUSDMax", options.filters.volumeUsdMax),
      ...stringFilter("amount0Min", options.filters.amountBaseMin),
      ...stringFilter("amount0Max", options.filters.amountBaseMax),
      ...stringFilter("amount1Min", options.filters.amountQuoteMin),
      ...stringFilter("amount1Max", options.filters.amountQuoteMax),
      ...timestampFilter("timestampStart", options.filters.startAtMs),
      ...timestampFilter("timestampEnd", options.filters.endAtMs),
      ...(options.cursor === undefined
        ? {}
        : {
            before: {
              blockNumber: String(options.cursor.blockNumber),
              transactionIndex: options.cursor.transactionIndex,
              eventIndex: options.cursor.eventIndex,
            },
          }),
      // The lower bound, in the socket's own grammar. It AND-combines with
      // `before`: measured live with both set, a 56-row window came back
      // bounded above by the cursor triple and below by this anchor, which is
      // what makes a walk INSIDE an afterBlock window possible at all.
      ...(options.filters.afterBlock === undefined
        ? {}
        : {
            after: {
              blockNumber: String(options.filters.afterBlock),
              transactionIndex: WS_AFTER_BLOCK_EXCLUSIVE_INDEX,
              eventIndex: WS_AFTER_BLOCK_EXCLUSIVE_INDEX,
            },
          }),
    },
  });

  const frames = await options.transport.wsExchange(DEXSCREENER_FEED_WS_URL, {
    send: [command],
    expect: { binaryFrames: TRADES_FRAMES, maxTotalBytes: TRADES_MAX_BYTES },
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const trades = readTradesFrames(frames, cid);
  if (trades === null) {
    throw siteError(
      DexScreenerSiteErrorCodes.TRADES_NO_RESULT_FRAME,
      `The DexScreener feed socket sent ${frames.length} binary frames without a historicalTransactions answer for ${options.chainId}:${options.pairAddress}`,
      "The socket answered, so this is neither an outage nor proof the pool has no trades. Retry once; if it repeats, check the AMM id and quote token with dexscreener__pair_get."
    );
  }
  return {
    trades,
    channel: "feed_ws",
    url: DEXSCREENER_FEED_WS_URL,
    bytes: frames.reduce((sum, frame) => sum + frame.byteLength, 0),
    fetchedAtMs: Date.now(),
    nextCursor: cursorFrom(trades),
  };
}

/**
 * Find this call's trades among the frames the feed socket sent.
 *
 * Dispatch is on the protobuf ONEOF and the CORRELATION ID, never on frame
 * position. Returns null when no frame answers this `cid`; an empty ARRAY is a
 * different fact (the provider answered "none") and is returned as one.
 */
export function readTradesFrames(
  frames: readonly Uint8Array[],
  cid: number
): readonly ProjectedTrade[] | null {
  for (const bytes of frames) {
    if (bytes.byteLength === 0) continue;
    let decoded: unknown;
    try {
      decoded = decodeDexScreenerMessageToJson("dex_feed.WSMessage", bytes, {
        maxBytes: TRADES_MAX_BYTES,
      });
    } catch (error) {
      if (
        isDexScreenerSiteError(error) &&
        error.code === DexScreenerSiteErrorCodes.RESPONSE_OVER_CAP
      ) {
        throw error;
      }
      continue;
    }
    const arm = asObject(asObject(decoded)?.["historicalTransactions"]);
    if (arm === null) continue;
    if (readNumber(arm["cid"]) !== cid) continue;
    const raw = arm["transactions"];
    return (Array.isArray(raw) ? raw : []).map(projectTrade);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The block anchor                                                    */
/* ------------------------------------------------------------------ */

/** What a timestamp resolved to, and how far off it landed. */
export interface BlockAnchor {
  readonly blockNumber: number;
  /** When the anchoring trade actually happened. */
  readonly resolvedAtMs: number;
  /** `requestedAtMs - resolvedAtMs`. Measured 393,000 ms on a 90-day target. */
  readonly distanceMs: number;
}

/**
 * Resolve an instant to the block of the nearest PRIOR trade.
 *
 * This is the shortcut the candle walk is built on: a 90-day-old window cost
 * 980 ms and 33 KB through this anchor against 1,582 ms and 436 KB for a naive
 * three-page walk. It is APPROXIMATE BY CONTRACT and the caller reports the
 * distance, because the anchor is a trade and trades are not evenly spaced.
 *
 * Returns null when the provider has no trade at or before the instant, which
 * is a real answer (the pool did not exist yet) and not a failure.
 */
export async function resolveBlockAnchor(
  options: Omit<TradesPageOptions, "filters" | "cursor"> & {
    readonly atMs: number;
  }
): Promise<BlockAnchor | null> {
  const page = await fetchTradesConnect({
    ...options,
    filters: { eventType: "all", endAtMs: options.atMs },
  });
  // The page is newest-first and bounded at `atMs`, so its FIRST row is the
  // nearest prior event.
  for (const trade of page.trades) {
    if (trade.blockNumber === null || trade.blockTimestampMs === null) continue;
    return {
      blockNumber: trade.blockNumber,
      resolvedAtMs: trade.blockTimestampMs,
      distanceMs: options.atMs - trade.blockTimestampMs,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

function projectTrade(value: unknown): ProjectedTrade {
  const row = asObject(value) ?? {};
  const swap = asObject(row["swap"]);
  const joinExit = asObject(row["joinExit"]);
  const latest = swap === null ? null : asObject(swap["latest"]);
  return {
    eventType: eventTypeOf(swap, joinExit),
    blockNumber: readNumber(row["blockNumber"]),
    blockTimestampMs: timestampMs(row["blockTimestamp"]),
    transactionId: str(row["id"]),
    transactionIndex: readNumber(row["transactionIndex"]),
    eventIndex: readNumber(row["eventIndex"]),
    maker: str(row["traderId"]),
    priceUsd: swap === null ? null : str(swap["priceUSD"]),
    priceNative: swap === null ? null : str(swap["priceNative"]),
    volumeUsd: swap === null ? null : str(swap["volumeUSD"]),
    amountBase: str(row["amount0"]),
    amountQuote: str(row["amount1"]),
    marketCapUsd: latest === null ? null : str(latest["marketCapUSD"]),
    trader: projectTrader(asObject(row["traderScreener"])),
  };
}

function eventTypeOf(
  swap: Record<string, unknown> | null,
  joinExit: Record<string, unknown> | null
): ProjectedTrade["eventType"] {
  if (swap !== null) {
    const type = str(swap["type"]);
    if (type === "TYPE_BUY") return "buy";
    if (type === "TYPE_SELL") return "sell";
    return null;
  }
  if (joinExit !== null) {
    const type = str(joinExit["type"]);
    if (type === "TYPE_ADD") return "add";
    if (type === "TYPE_REMOVE") return "remove";
  }
  return null;
}

function projectTrader(
  source: Record<string, unknown> | null
): TraderProfile | null {
  if (source === null) return null;
  const usdBuy = str(source["volumeUSDBuy"]);
  const usdSell = str(source["volumeUSDSell"]);
  return {
    buys: readNumber(source["buys"]),
    sells: readNumber(source["sells"]),
    volumeUsdBuy: usdBuy,
    volumeUsdSell: usdSell,
    volumeBaseBuy: str(source["volumeBuy"]),
    volumeBaseSell: str(source["volumeSell"]),
    balanceAmount: str(source["balanceAmount"]),
    retainedBoughtPct: readFloat(source["balancePercentage"]),
    newOnPair: typeof source["isNew"] === "boolean" ? source["isNew"] : null,
    firstSwapAtMs: timestampMs(source["firstSwap"]),
    netCashFlowUsd: netCashFlow(usdSell, usdBuy),
  };
}

/**
 * Net cash flow in dollars.
 *
 * USD aggregates, not token amounts: the provider sends them as decimal
 * strings and a dollar figure at this magnitude is exact in a double. Token
 * amounts elsewhere in this module stay strings and are never subtracted.
 * Null when either side is missing, never zero, because an unknown flow and a
 * balanced flow are different facts.
 */
function netCashFlow(sell: string | null, buy: string | null): number | null {
  if (sell === null || buy === null) return null;
  const out = Number(sell);
  const into = Number(buy);
  if (!Number.isFinite(out) || !Number.isFinite(into)) return null;
  return out - into;
}

/**
 * The exact cursor for the next page back.
 *
 * Built from the OLDEST row, which on a newest-first page is the last one that
 * carries a complete triple. A page shorter than the provider's own page size
 * is the end of history for this filter and gets no cursor.
 */
function cursorFrom(trades: readonly ProjectedTrade[]): TradeCursor | null {
  if (trades.length < TRADES_PER_PAGE) return null;
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const trade = trades[index];
    if (trade === undefined) continue;
    const cursor = tradeCursorAt(trade);
    if (cursor !== null) return cursor;
  }
  return null;
}

/**
 * The exact continuation position of ONE row, or null when that row does not
 * carry the complete triple.
 *
 * Exported because a caller that emits FEWER rows than it fetched must
 * continue from its own last EMITTED row: continuing from the page's oldest
 * row would leave every row between the two permanently unreachable, which is
 * the silent cut this surface must not commit.
 */
export function tradeCursorAt(trade: ProjectedTrade): TradeCursor | null {
  if (
    trade.blockNumber === null
    || trade.transactionIndex === null
    || trade.eventIndex === null
  ) {
    return null;
  }
  return {
    blockNumber: trade.blockNumber,
    transactionIndex: trade.transactionIndex,
    eventIndex: trade.eventIndex,
  };
}

/* ------------------------------------------------------------------ */
/* Value readers                                                       */
/* ------------------------------------------------------------------ */

function stringFilter(
  key: string,
  value: string | undefined
): Record<string, string> {
  return value === undefined || value === "" ? {} : { [key]: value };
}

/**
 * A `google.protobuf.Timestamp` in protobuf JSON is an RFC 3339 string.
 *
 * Second precision is what the provider measures on this filter, and the
 * measurement showed the boundary honoured exactly, so the value is emitted at
 * whole-second resolution rather than with a millisecond fraction the provider
 * would have to round.
 */
function timestampFilter(
  key: string,
  atMs: number | undefined
): Record<string, string> {
  if (atMs === undefined || !Number.isFinite(atMs)) return {};
  return { [key]: new Date(Math.floor(atMs / 1000) * 1000).toISOString() };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function timestampMs(value: unknown): number | null {
  if (typeof value !== "string") return readNumber(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** uint64 renders as a STRING in protobuf JSON; both forms are read exactly. */
function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** A float wrapper renders as a number; a string form is parsed exactly. */
function readFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
