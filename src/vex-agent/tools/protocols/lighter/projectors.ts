import type {
  LighterCandle,
  LighterCandlesResponse,
  LighterMarket,
  LighterMarketDetail,
  LighterMarketDetailsResponse,
  LighterOrderBookOrdersResponse,
  LighterRecentTradesResponse,
  LighterSimpleOrder,
  LighterStatusResponse,
  LighterSystemConfigResponse,
  LighterTrade,
} from "@tools/lighter/types.js";

export interface LighterSlice<T> {
  readonly rows: T[];
  readonly total: number;
  readonly count: number;
  readonly truncated: boolean;
}

export function takeFirst<T>(rows: readonly T[], limit: number): LighterSlice<T> {
  const sliced = rows.slice(0, limit);
  return {
    rows: sliced,
    total: rows.length,
    count: sliced.length,
    truncated: rows.length > sliced.length,
  };
}

export function takeLast<T>(rows: readonly T[], limit: number): LighterSlice<T> {
  const sliced = rows.slice(Math.max(0, rows.length - limit));
  return {
    rows: sliced,
    total: rows.length,
    count: sliced.length,
    truncated: rows.length > sliced.length,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function projectMarket(market: LighterMarket): Record<string, unknown> {
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
      liquidation: market.liquidation_fee,
      makerEnabled: market.is_maker_fee_enabled,
      takerEnabled: market.is_taker_fee_enabled,
    },
  };
}

export function projectMarketDetail(detail: LighterMarketDetail): Record<string, unknown> {
  return {
    ...projectMarket(detail),
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
    engineDecimals: {
      size: numberOrNull(detail.size_decimals),
      price: numberOrNull(detail.price_decimals),
      quoteMultiplier: numberOrNull(detail.quote_multiplier),
    },
    strategyIndex: numberOrNull(detail.strategy_index),
    funding: {
      clampSmall: detail.funding_clamp_small ?? null,
      clampBig: detail.funding_clamp_big ?? null,
      baseInterestRate: detail.base_interest_rate ?? null,
    },
  };
}

export function projectMarketDetails(response: LighterMarketDetailsResponse): Record<string, unknown>[] {
  return [
    ...response.order_book_details,
    ...response.spot_order_book_details,
  ].map(projectMarketDetail);
}

export function projectOrder(order: LighterSimpleOrder): Record<string, unknown> {
  const orderIndex = safeIntegerOrNull(order.order_index);
  return {
    orderIndex,
    orderIndexPrecision: orderIndex === null ? "unsafe_provider_number_omitted" : "safe",
    orderId: order.order_id,
    ownerAccountIndex: order.owner_account_index,
    price: order.price,
    initialBaseAmount: order.initial_base_amount,
    remainingBaseAmount: order.remaining_base_amount,
    orderExpiry: order.order_expiry,
    transactionTime: order.transaction_time,
  };
}

function priceNumber(order: LighterSimpleOrder): number | null {
  const value = Number(order.price);
  return Number.isFinite(value) ? value : null;
}

function sortOrdersByPrice(
  rows: readonly LighterSimpleOrder[],
  direction: "ascending" | "descending",
): LighterSimpleOrder[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const leftPrice = priceNumber(left.row);
      const rightPrice = priceNumber(right.row);
      if (leftPrice === null && rightPrice === null) return left.index - right.index;
      if (leftPrice === null) return 1;
      if (rightPrice === null) return -1;
      const diff = direction === "ascending"
        ? leftPrice - rightPrice
        : rightPrice - leftPrice;
      return diff === 0 ? left.index - right.index : diff;
    })
    .map(({ row }) => row);
}

export function projectOrderBook(response: LighterOrderBookOrdersResponse, limit: number): Record<string, unknown> {
  const sortedAsks = sortOrdersByPrice(response.asks, "ascending");
  const sortedBids = sortOrdersByPrice(response.bids, "descending");
  const asks = takeFirst(sortedAsks.map(projectOrder), limit);
  const bids = takeFirst(sortedBids.map(projectOrder), limit);
  return {
    totalAsks: response.total_asks,
    totalBids: response.total_bids,
    shownAsks: asks.count,
    shownBids: bids.count,
    sorting: {
      asks: "price_ascending",
      bids: "price_descending",
    },
    asksTruncated: asks.truncated || response.total_asks > asks.count,
    bidsTruncated: bids.truncated || response.total_bids > bids.count,
    asks: asks.rows,
    bids: bids.rows,
  };
}

export function projectTrade(trade: LighterTrade): Record<string, unknown> {
  const tradeIdNumeric = safeIntegerOrNull(trade.trade_id);
  const askOrderIdNumeric = safeIntegerOrNull(trade.ask_id);
  const bidOrderIdNumeric = safeIntegerOrNull(trade.bid_id);
  return {
    tradeId: trade.trade_id_str,
    tradeIdPrecision: "provider_string_canonical",
    tradeIdNumeric,
    tradeIdNumericPrecision: tradeIdNumeric === null ? "unsafe_provider_number_omitted" : "safe",
    tradeIdStr: trade.trade_id_str,
    type: trade.type,
    marketId: trade.market_id,
    price: trade.price,
    size: trade.size,
    usdAmount: trade.usd_amount,
    isMakerAsk: trade.is_maker_ask,
    askAccountId: trade.ask_account_id,
    bidAccountId: trade.bid_account_id,
    askOrderId: trade.ask_id_str,
    askOrderIdPrecision: "provider_string_canonical",
    askOrderIdNumeric,
    askOrderIdNumericPrecision: askOrderIdNumeric === null ? "unsafe_provider_number_omitted" : "safe",
    askOrderIdStr: trade.ask_id_str,
    bidOrderId: trade.bid_id_str,
    bidOrderIdPrecision: "provider_string_canonical",
    bidOrderIdNumeric,
    bidOrderIdNumericPrecision: bidOrderIdNumeric === null ? "unsafe_provider_number_omitted" : "safe",
    bidOrderIdStr: trade.bid_id_str,
    blockHeight: trade.block_height,
    timestamp: trade.timestamp,
    transactionTime: trade.transaction_time ?? null,
    txHash: trade.tx_hash,
  };
}

export function projectRecentTrades(response: LighterRecentTradesResponse, limit: number): Record<string, unknown> {
  const trades = takeFirst(response.trades.map(projectTrade), limit);
  return {
    count: trades.count,
    totalProviderRows: trades.total,
    truncated: trades.truncated,
    nextCursor: response.next_cursor ?? null,
    trades: trades.rows,
  };
}

export function projectCandle(candle: LighterCandle): Record<string, unknown> {
  return {
    timestamp: candle.t,
    open: candle.o,
    high: candle.h,
    low: candle.l,
    close: candle.c,
    volumeBase: candle.v,
    volumeQuote: candle.V,
    index: candle.i,
    originalOpen: candle.O ?? null,
    originalHigh: candle.H ?? null,
    originalLow: candle.L ?? null,
    originalClose: candle.C ?? null,
  };
}

export function projectCandles(response: LighterCandlesResponse, outputLimit: number): Record<string, unknown> {
  const candles = takeLast(response.c.map(projectCandle), outputLimit);
  return {
    resolution: response.r,
    count: candles.count,
    totalProviderRows: candles.total,
    truncated: candles.truncated,
    truncationNote: candles.truncated
      ? `Showing the most recent ${candles.count} candle rows from ${candles.total} provider rows.`
      : null,
    candles: candles.rows,
  };
}

export function projectSystem(
  status: LighterStatusResponse,
  config: LighterSystemConfigResponse,
): Record<string, unknown> {
  return {
    status: {
      code: status.status,
      networkId: status.network_id,
      timestamp: status.timestamp,
    },
    systemConfig: {
      code: config.code,
      message: config.message ?? null,
      liquidityPoolIndex: config.liquidity_pool_index,
      stakingPoolIndex: config.staking_pool_index,
      fundingFeeRebateAccountIndex: config.funding_fee_rebate_account_index,
      marketMakerIncentiveAccountIndex: config.market_maker_incentive_account_index,
      liquidityPoolCooldownPeriod: config.liquidity_pool_cooldown_period,
      stakingPoolLockupPeriod: config.staking_pool_lockup_period,
      maxIntegratorPerpsMakerFee: config.max_integrator_perps_maker_fee,
      maxIntegratorPerpsTakerFee: config.max_integrator_perps_taker_fee,
      maxIntegratorSpotMakerFee: config.max_integrator_spot_maker_fee,
      maxIntegratorSpotTakerFee: config.max_integrator_spot_taker_fee,
    },
  };
}
