import {
  LIGHTER_CANDLE_RESOLUTION_MS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import type {
  LighterCandle,
  LighterMarket,
  LighterMarketDetail,
  LighterSimpleOrder,
} from "@tools/lighter/types.js";
import type {
  LighterTradingMarket,
  LighterTradingMarketList,
  LighterTradingResolution,
  LighterTradingSnapshot,
  LighterTradingStreamCandle,
} from "@shared/schemas/lighter-trading.js";

const SNAPSHOT_CANDLE_COUNT = 300;
const SNAPSHOT_BOOK_ROWS = 24;
const SNAPSHOT_TRADE_ROWS = 30;
const ALL_MARKET_DETAILS_ID = 255;

export const LIGHTER_STREAM_CANDLE_RESOLUTIONS = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "12h",
  "1d",
] as const satisfies readonly LighterTradingResolution[];

export type LighterStreamCandleResolution =
  (typeof LIGHTER_STREAM_CANDLE_RESOLUTIONS)[number];

export interface LighterCandleTarget {
  readonly environment: LighterEnvironment;
  readonly marketId: number;
  readonly resolution: LighterStreamCandleResolution;
}

export interface LighterInternalCandle extends LighterTradingStreamCandle {
  readonly receivedAt: number;
}

export type LighterTradingPanelClient = Pick<
  LighterClient,
  | "getMarkets"
  | "getMarketDetails"
  | "getOrderBookOrders"
  | "getRecentTrades"
  | "getCandles"
>;

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeEpochMilliseconds(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

export function canonicalLighterCandleTarget(input: {
  readonly environment: LighterEnvironment;
  readonly marketId: number;
  readonly resolution: LighterTradingResolution;
}): LighterCandleTarget {
  if (input.environment !== "core" && input.environment !== "rhc") {
    throw new Error("Unsupported Lighter candle environment.");
  }
  if (!Number.isSafeInteger(input.marketId) || input.marketId < 0 || input.marketId > 65_535) {
    throw new Error("Unsupported Lighter candle market.");
  }
  if (input.resolution === "1w") {
    throw new Error("Lighter's live candle channel does not support 1w.");
  }
  if (!(LIGHTER_STREAM_CANDLE_RESOLUTIONS as readonly string[]).includes(input.resolution)) {
    throw new Error("Unsupported Lighter candle resolution.");
  }
  return {
    environment: input.environment,
    marketId: input.marketId,
    resolution: input.resolution as LighterStreamCandleResolution,
  };
}

export function lighterCandleTargetKey(target: LighterCandleTarget): string {
  return `${target.environment}:${target.marketId}:${target.resolution}`;
}

export function lighterCandleSubscribeChannel(target: LighterCandleTarget): string {
  return `candle/${target.marketId}/${target.resolution}`;
}

export function lighterCandleResponseChannel(target: LighterCandleTarget): string {
  return `candle:${target.marketId}:${target.resolution}`;
}

function marketStatusRank(market: LighterMarket): number {
  return market.status === "active" ? 0 : 1;
}

export function projectLighterTradingMarket(
  market: LighterMarket,
  detail: LighterMarketDetail | null = null,
): LighterTradingMarket {
  return {
    marketId: market.market_id,
    symbol: market.symbol,
    marketType: market.market_type,
    status: market.status,
    baseAssetId: market.base_asset_id,
    quoteAssetId: market.quote_asset_id,
    minBaseAmount: market.min_base_amount,
    minQuoteAmount: market.min_quote_amount,
    orderQuoteLimit: market.order_quote_limit,
    decimals: {
      size: market.supported_size_decimals,
      price: market.supported_price_decimals,
      quote: market.supported_quote_decimals,
    },
    fees: {
      maker: market.maker_fee,
      taker: market.taker_fee,
      makerEnabled: market.is_maker_fee_enabled,
      takerEnabled: market.is_taker_fee_enabled,
    },
    activity24h: {
      tradesCount: nonNegativeNumberOrNull(detail?.daily_trades_count),
      quoteVolume: nonNegativeNumberOrNull(detail?.daily_quote_token_volume),
    },
  };
}

function nonNegativeNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function matchingMarketDetail(
  market: LighterMarket,
  details: readonly LighterMarketDetail[],
): LighterMarketDetail | null {
  return details.find((detail) => (
    detail.market_id === market.market_id
    && detail.market_type === market.market_type
    && detail.symbol === market.symbol
    && detail.base_asset_id === market.base_asset_id
    && detail.quote_asset_id === market.quote_asset_id
  )) ?? null;
}

function sortMarkets(markets: readonly LighterMarket[]): LighterMarket[] {
  return markets
    .map((market, index) => ({ market, index }))
    .sort((left, right) => {
      const status = marketStatusRank(left.market) - marketStatusRank(right.market);
      if (status !== 0) return status;
      const type = left.market.market_type.localeCompare(right.market.market_type);
      if (type !== 0) return type;
      const symbol = left.market.symbol.localeCompare(right.market.symbol);
      if (symbol !== 0) return symbol;
      const marketId = left.market.market_id - right.market.market_id;
      return marketId === 0 ? left.index - right.index : marketId;
    })
    .map(({ market }) => market);
}

export async function readLighterTradingMarketList(
  environment: LighterEnvironment,
  client: LighterTradingPanelClient = getLighterClient(),
  now: () => number = Date.now,
): Promise<LighterTradingMarketList> {
  const [response, detailsResult] = await Promise.all([
    client.getMarkets(environment, { filter: "all" }),
    client.getMarketDetails(environment, {
      // Lighter uses 255 as the read-only all-market detail sentinel.
      marketId: ALL_MARKET_DETAILS_ID,
      filter: "all",
    }).then(
      (details) => ({ ok: true as const, details }),
      () => ({ ok: false as const }),
    ),
  ]);
  const details = detailsResult.ok
    ? [
        ...detailsResult.details.order_book_details,
        ...detailsResult.details.spot_order_book_details,
      ]
    : [];
  return {
    environment,
    retrievedAt: now(),
    markets: sortMarkets(response.order_books)
      .slice(0, 500)
      .map((market) => projectLighterTradingMarket(
        market,
        matchingMarketDetail(market, details),
      )),
  };
}

function findDetail(
  marketId: number,
  details: readonly LighterMarketDetail[],
): LighterMarketDetail | null {
  return details.find((candidate) => candidate.market_id === marketId) ?? null;
}

function bookRows(
  orders: readonly LighterSimpleOrder[],
  direction: "ascending" | "descending",
): LighterTradingSnapshot["book"]["asks"] {
  const multiplier = direction === "ascending" ? 1 : -1;
  return orders
    .map((order, index) => ({ order, index }))
    .sort((left, right) => {
      const price = (Number(left.order.price) - Number(right.order.price)) * multiplier;
      return price === 0 ? left.index - right.index : price;
    })
    .slice(0, SNAPSHOT_BOOK_ROWS)
    .map(({ order }) => ({
      orderId: order.order_id,
      price: order.price,
      size: order.remaining_base_amount,
    }));
}

export function isUsableLighterCandle(candle: LighterCandle): boolean {
  const values = [candle.t, candle.o, candle.h, candle.l, candle.c, candle.v, candle.V];
  if (!values.every((value) => Number.isFinite(value))) return false;
  if (candle.v < 0 || candle.V < 0) return false;
  if (!/^\d{1,128}$/.test(candle.i)) return false;
  return (
    candle.h >= Math.max(candle.o, candle.c, candle.l) &&
    candle.l <= Math.min(candle.o, candle.c, candle.h)
  );
}

export function projectLighterInternalCandles(
  candles: readonly LighterCandle[],
  resolution: LighterStreamCandleResolution,
  source: LighterTradingStreamCandle["source"],
  receivedAt: number,
): LighterInternalCandle[] {
  const byTimestamp = new Map<number, LighterInternalCandle>();
  for (const candle of candles) {
    if (!isUsableLighterCandle(candle)) continue;
    const timestamp = normalizeEpochMilliseconds(candle.t);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) continue;
    const candidate: LighterInternalCandle = {
      timestamp,
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
      volumeBase: candle.v,
      volumeQuote: candle.V,
      lastTradeId: candle.i,
      providerResolution: resolution,
      source,
      receivedAt,
    };
    const existing = byTimestamp.get(timestamp);
    if (
      existing === undefined
      || compareLighterDecimalIds(candidate.lastTradeId, existing.lastTradeId) > 0
    ) {
      byTimestamp.set(timestamp, candidate);
    }
  }
  return [...byTimestamp.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-SNAPSHOT_CANDLE_COUNT);
}

function projectSnapshotCandles(
  candles: readonly LighterInternalCandle[],
): LighterTradingSnapshot["candles"] {
  return candles.map((candle) => ({
    timestamp: candle.timestamp,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volumeBase: candle.volumeBase,
    volumeQuote: candle.volumeQuote,
    lastTradeId: candle.lastTradeId,
    providerResolution: candle.providerResolution,
    source: candle.source,
  }));
}

function compareLighterDecimalIds(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft > normalizedRight ? 1 : -1;
}

export async function readLighterTradingCandleHistory(
  input: {
    readonly environment: LighterEnvironment;
    readonly marketId: number;
    readonly resolution: LighterTradingResolution;
    readonly count?: number;
    readonly endTimestamp?: number;
  },
  client: Pick<LighterTradingPanelClient, "getCandles"> = getLighterClient(),
  now: () => number = Date.now,
): Promise<LighterInternalCandle[]> {
  const target = canonicalLighterCandleTarget(input);
  const count = input.count ?? SNAPSHOT_CANDLE_COUNT;
  if (!Number.isSafeInteger(count) || count < 1 || count > SNAPSHOT_CANDLE_COUNT) {
    throw new Error("Lighter candle history count is out of bounds.");
  }
  const receivedAt = now();
  const endTimestamp = input.endTimestamp ?? receivedAt;
  const resolutionMs = LIGHTER_CANDLE_RESOLUTION_MS[target.resolution];
  const response = await client.getCandles(target.environment, {
    marketId: target.marketId,
    resolution: target.resolution,
    startTimestamp: endTimestamp - resolutionMs * count,
    endTimestamp,
    countBack: count,
    // Provider `t` is the candle open timestamp. Keep REST and WS semantics equal.
    setTimestampToEnd: false,
  });
  if (response.r !== target.resolution) {
    throw new Error("Lighter candle history resolution does not match the request.");
  }
  return projectLighterInternalCandles(
    response.c,
    target.resolution,
    "rest_snapshot",
    receivedAt,
  );
}

export async function readLighterTradingSnapshot(
  input: {
    readonly environment: LighterEnvironment;
    readonly marketId: number;
    readonly resolution: LighterTradingResolution;
  },
  client: LighterTradingPanelClient = getLighterClient(),
  now: () => number = Date.now,
): Promise<LighterTradingSnapshot> {
  return readLighterTradingSnapshotInternal(input, client, now, true);
}

/**
 * Reads only the REST fields that are not bootstrapped by the authoritative
 * candle supervisor. This prevents the renderer's initial depth/tape/metrics
 * from waiting on a second, redundant 300-candle request.
 */
export async function readLighterTradingMarketSnapshot(
  input: {
    readonly environment: LighterEnvironment;
    readonly marketId: number;
    readonly resolution: LighterTradingResolution;
  },
  client: LighterTradingPanelClient = getLighterClient(),
  now: () => number = Date.now,
): Promise<LighterTradingSnapshot> {
  return readLighterTradingSnapshotInternal(input, client, now, false);
}

async function readLighterTradingSnapshotInternal(
  input: {
    readonly environment: LighterEnvironment;
    readonly marketId: number;
    readonly resolution: LighterTradingResolution;
  },
  client: LighterTradingPanelClient,
  now: () => number,
  includeCandles: boolean,
): Promise<LighterTradingSnapshot> {
  const target = canonicalLighterCandleTarget(input);
  const [marketResult, candleResult] = await Promise.allSettled([
    Promise.all([
      client.getMarkets(input.environment, {
        marketId: input.marketId,
        filter: "all",
      }),
      client.getMarketDetails(input.environment, {
        marketId: input.marketId,
        filter: "all",
      }),
      client.getOrderBookOrders(input.environment, {
        marketId: input.marketId,
        limit: SNAPSHOT_BOOK_ROWS,
      }),
      client.getRecentTrades(input.environment, {
        marketId: input.marketId,
        limit: SNAPSHOT_TRADE_ROWS,
      }),
    ]),
    includeCandles
      ? readLighterTradingCandleHistory(target, client, now)
      : Promise.resolve([]),
  ]);
  if (marketResult.status === "rejected") throw marketResult.reason;
  if (candleResult.status === "rejected") throw candleResult.reason;
  const [markets, details, orderBook, recentTrades] = marketResult.value;
  const candles = candleResult.value;

  const market = markets.order_books.find(
    (candidate) => candidate.market_id === input.marketId,
  );
  if (market === undefined) {
    throw new Error("Selected Lighter market is not present in the live market response.");
  }
  const detail = findDetail(
    input.marketId,
    market.market_type === "spot"
      ? details.spot_order_book_details
      : details.order_book_details,
  );
  if (detail === null) {
    throw new Error("Selected Lighter market detail is unavailable.");
  }
  if (
    detail.market_type !== market.market_type
    || detail.symbol !== market.symbol
    || detail.base_asset_id !== market.base_asset_id
    || detail.quote_asset_id !== market.quote_asset_id
  ) {
    throw new Error("Selected Lighter market detail does not match the requested market identity.");
  }
  if (recentTrades.trades.some((trade) => trade.market_id !== input.marketId)) {
    throw new Error("Recent Lighter trades do not match the requested market identity.");
  }

  return {
    environment: input.environment,
    retrievedAt: now(),
    market: projectLighterTradingMarket(market, detail),
    detail: {
      lastTradePrice: numberOrNull(detail.last_trade_price),
      openInterest: numberOrNull(detail.open_interest),
      daily: {
        tradesCount: numberOrNull(detail.daily_trades_count),
        baseTokenVolume: numberOrNull(detail.daily_base_token_volume),
        quoteTokenVolume: numberOrNull(detail.daily_quote_token_volume),
        priceLow: numberOrNull(detail.daily_price_low),
        priceHigh: numberOrNull(detail.daily_price_high),
        priceChange: numberOrNull(detail.daily_price_change),
      },
      funding: {
        clampSmall: detail.funding_clamp_small ?? null,
        clampBig: detail.funding_clamp_big ?? null,
        baseInterestRate: detail.base_interest_rate ?? null,
      },
    },
    book: {
      asks: bookRows(orderBook.asks, "ascending"),
      bids: bookRows(orderBook.bids, "descending"),
    },
    trades: recentTrades.trades.slice(0, SNAPSHOT_TRADE_ROWS).map((trade) => ({
      tradeId: trade.trade_id_str,
      type: trade.type,
      price: trade.price,
      size: trade.size,
      usdAmount: trade.usd_amount,
      takerSide: trade.is_maker_ask ? "buy" : "sell",
      timestamp: normalizeEpochMilliseconds(trade.timestamp),
    })),
    candles: projectSnapshotCandles(candles),
  };
}
