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
} from "@shared/schemas/lighter-trading.js";

const SNAPSHOT_CANDLE_COUNT = 300;
const SNAPSHOT_BOOK_ROWS = 24;
const SNAPSHOT_TRADE_ROWS = 30;

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

function marketStatusRank(market: LighterMarket): number {
  return market.status === "active" ? 0 : 1;
}

export function projectLighterTradingMarket(
  market: LighterMarket,
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
    },
  };
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
  const response = await client.getMarkets(environment, { filter: "all" });
  return {
    environment,
    retrievedAt: now(),
    markets: sortMarkets(response.order_books)
      .slice(0, 500)
      .map(projectLighterTradingMarket),
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

function isUsableCandle(candle: LighterCandle): boolean {
  const values = [candle.t, candle.o, candle.h, candle.l, candle.c, candle.v, candle.V];
  if (!values.every((value) => Number.isFinite(value))) return false;
  if (candle.v < 0 || candle.V < 0) return false;
  return (
    candle.h >= Math.max(candle.o, candle.c, candle.l) &&
    candle.l <= Math.min(candle.o, candle.c, candle.h)
  );
}

function projectCandles(
  candles: readonly LighterCandle[],
): LighterTradingSnapshot["candles"] {
  const byTimestamp = new Map<number, LighterTradingSnapshot["candles"][number]>();
  for (const candle of candles) {
    if (!isUsableCandle(candle)) continue;
    const timestamp = normalizeEpochMilliseconds(candle.t);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) continue;
    byTimestamp.set(timestamp, {
      timestamp,
      open: candle.o,
      high: candle.h,
      low: candle.l,
      close: candle.c,
      volumeBase: candle.v,
      volumeQuote: candle.V,
    });
  }
  return [...byTimestamp.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-SNAPSHOT_CANDLE_COUNT);
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
  const endTimestamp = now();
  const resolutionMs = LIGHTER_CANDLE_RESOLUTION_MS[input.resolution];
  const startTimestamp = endTimestamp - resolutionMs * SNAPSHOT_CANDLE_COUNT;
  const [markets, details, orderBook, recentTrades, candles] = await Promise.all([
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
    client.getCandles(input.environment, {
      marketId: input.marketId,
      resolution: input.resolution,
      startTimestamp,
      endTimestamp,
      countBack: SNAPSHOT_CANDLE_COUNT,
      setTimestampToEnd: true,
    }),
  ]);

  const market = markets.order_books.find(
    (candidate) => candidate.market_id === input.marketId,
  );
  if (market === undefined) {
    throw new Error("Selected Lighter market is not present in the live market response.");
  }
  const detail = findDetail(input.marketId, [
    ...details.order_book_details,
    ...details.spot_order_book_details,
  ]);
  if (detail === null) {
    throw new Error("Selected Lighter market detail is unavailable.");
  }

  return {
    environment: input.environment,
    retrievedAt: now(),
    market: projectLighterTradingMarket(market),
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
    candles: projectCandles(candles.c),
  };
}
