import type {
  LighterAccount,
  LighterAccountOrder,
  LighterAccountOrdersResponse,
  LighterAccountPosition,
  LighterAccountResponse,
  LighterApiKey,
  LighterApiKeysResponse,
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

import {
  classifyLighterPositionEffect,
  lighterCampaignTradeType,
  readLighterAccountFillFacts,
  type LighterPositionEffect,
} from "./fill-position-effect.js";
import {
  initialMarginFractionToLeverageDisplay,
  marginModeFromWire,
  positionInitialMarginFractionToProviderScale,
} from "@tools/lighter/margin-fraction.js";

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

export function takePage<T>(
  rows: readonly T[],
  page: number,
  limit: number,
): LighterSlice<T> & {
  readonly offset: number;
  readonly hasMore: boolean;
  readonly lastPage: number;
} {
  const offset = (page - 1) * limit;
  const sliced = rows.slice(offset, offset + limit);
  const lastPage = Math.max(1, Math.ceil(rows.length / limit));
  return {
    rows: sliced,
    total: rows.length,
    count: sliced.length,
    truncated: rows.length > sliced.length,
    offset,
    hasMore: offset + sliced.length < rows.length,
    lastPage,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * A 10000-scale margin fraction rendered as the leverage a human reads.
 *
 * `null` rather than a throw for the same reason every other projector helper
 * degrades: a spot row carries no fraction at all, and a market read must not
 * fail because one field was absent or out of range.
 */
function leverageDisplayOrNull(fraction: unknown): string | null {
  if (typeof fraction !== "number" || !Number.isInteger(fraction)) return null;
  try {
    return initialMarginFractionToLeverageDisplay(fraction);
  } catch {
    return null;
  }
}

function epochMillisecondsIsoOrNull(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function marketStatusRank(market: LighterMarket): number {
  return market.status === "active" ? 0 : 1;
}

export function sortMarketsForDisplay(markets: readonly LighterMarket[]): LighterMarket[] {
  return markets
    .map((market, index) => ({ market, index }))
    .sort((left, right) => {
      const status = marketStatusRank(left.market) - marketStatusRank(right.market);
      if (status !== 0) return status;
      const marketId = left.market.market_id - right.market.market_id;
      if (marketId !== 0) return marketId;
      const symbol = left.market.symbol.localeCompare(right.market.symbol);
      return symbol === 0 ? left.index - right.index : symbol;
    })
    .map(({ market }) => market);
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
    // MARGIN AND REFERENCE PRICES, perpetual markets only (the spot detail
    // model carries neither, so every field here is null on a spot row rather
    // than absent). The fractions come on the provider's 10000 scale and the
    // scale travels with them: a bare 5000 read as a percentage is a 5000%
    // margin requirement, and read as a fraction it is 5000x too small.
    margin: {
      scale: 10_000,
      scaleNote: "Provider fractions on a 10000 scale: 5000 is 50 percent.",
      defaultInitialFraction: numberOrNull(detail.default_initial_margin_fraction),
      minInitialFraction: numberOrNull(detail.min_initial_margin_fraction),
      maintenanceFraction: numberOrNull(detail.maintenance_margin_fraction),
      closeoutFraction: numberOrNull(detail.closeout_margin_fraction),
      // THE DEFECT THIS CLOSES: the only leverage-shaped facts an agent could
      // read here were the bare fractions, so "5000 is 50 percent" was the whole
      // story and `minInitialFraction: 200` was explained nowhere. An agent
      // reading that answered "max leverage 2, and only 50%". The fractions
      // stay exactly as the provider sent them; these are DERIVED and additive.
      defaultLeverage: leverageDisplayOrNull(detail.default_initial_margin_fraction),
      maxLeverage: leverageDisplayOrNull(detail.min_initial_margin_fraction),
      note:
        "Leverage is a per-market account setting the user changes in Settings -> Lighter; the account's current value is on its position row as leverage.current.",
    },
    // Decimal strings as the provider reports them, never parsed to a float.
    markPrice: detail.mark_price ?? null,
    indexPrice: detail.index_price ?? null,
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

/**
 * A position row, EXACTLY as the provider sent it, plus one derived `leverage`
 * object.
 *
 * The raw row is preserved in full: `initial_margin_fraction` arrives as a
 * PERCENT STRING ("50.00", measured live on RHC account 24226), which is a third
 * representation of the same concept the market rows report as a 10000-scale
 * integer. Rewriting the row would hide the provider's own answer; leaving it
 * alone was what made the number unreadable. So both travel, and
 * `margin-fraction.ts` is the only thing that ever parses the string.
 *
 * NEVER THROWS. A row whose fraction cannot be parsed keeps its raw value and
 * gets `leverage: null` with the reason. A projection that threw would take a
 * whole account read down over one malformed row.
 */
export function projectPositionRow(position: LighterAccountPosition): Record<string, unknown> {
  return { ...position, leverage: deriveLeverage(position) };
}

function deriveLeverage(position: LighterAccountPosition): Record<string, unknown> | null {
  const raw = position.initial_margin_fraction;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let initialMarginFraction: number;
  try {
    initialMarginFraction = positionInitialMarginFractionToProviderScale(raw);
  } catch {
    return null;
  }
  let current: string;
  try {
    current = initialMarginFractionToLeverageDisplay(initialMarginFraction);
  } catch {
    return null;
  }
  let marginMode: string | null;
  try {
    marginMode = marginModeFromWire(position.margin_mode);
  } catch {
    marginMode = null;
  }
  return { initialMarginFraction, current, marginMode };
}

export function projectAccount(account: LighterAccount, positionLimit: number): Record<string, unknown> {
  const positions = Array.isArray(account.positions) ? takeFirst(account.positions, positionLimit) : null;
  const assets = Array.isArray(account.assets) ? takeFirst(account.assets, positionLimit) : null;
  return {
    accountIndex: account.index ?? account.account_index ?? null,
    l1Address: account.l1_address ?? null,
    status: account.status ?? null,
    collateral: account.collateral ?? null,
    availableBalance: account.available_balance ?? null,
    positionCount: positions?.total ?? 0,
    positionsTruncated: positions?.truncated ?? false,
    positions: (positions?.rows ?? []).map(projectPositionRow),
    assetCount: assets?.total ?? 0,
    assetsTruncated: assets?.truncated ?? false,
    assets: assets?.rows ?? [],
  };
}

export function projectAccountResponse(
  response: LighterAccountResponse,
  accountLimit: number,
  positionLimit: number,
): Record<string, unknown> {
  const accounts = takeFirst(response.accounts.map((account) => projectAccount(account, positionLimit)), accountLimit);
  return {
    count: accounts.count,
    totalProviderRows: response.total ?? accounts.total,
    truncated: accounts.truncated || (response.total ?? accounts.total) > accounts.count,
    accounts: accounts.rows,
  };
}

export function projectPositions(
  response: LighterAccountResponse,
  accountLimit: number,
  positionLimit: number,
): Record<string, unknown> {
  const accounts = takeFirst(response.accounts.map((account) => {
    const positions = Array.isArray(account.positions) ? takeFirst(account.positions, positionLimit) : null;
    return {
      accountIndex: account.index ?? account.account_index ?? null,
      l1Address: account.l1_address ?? null,
      count: positions?.count ?? 0,
      totalProviderRows: positions?.total ?? 0,
      truncated: positions?.truncated ?? false,
      positions: (positions?.rows ?? []).map(projectPositionRow),
    };
  }), accountLimit);
  return {
    accountCount: accounts.count,
    totalProviderAccounts: response.total ?? accounts.total,
    truncatedAccounts: accounts.truncated || (response.total ?? accounts.total) > accounts.count,
    accounts: accounts.rows,
  };
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
    orderExpiryIso: epochMillisecondsIsoOrNull(order.order_expiry),
    orderExpiryUnit: "epoch_milliseconds",
    transactionTime: order.transaction_time,
  };
}

export function projectAccountOrder(order: LighterAccountOrder): Record<string, unknown> {
  const orderIndexNumeric = safeIntegerOrNull(order.order_index);
  const clientOrderIndexNumeric = safeIntegerOrNull(order.client_order_index);
  return {
    orderIndex: order.order_id,
    orderIndexPrecision: "provider_string_canonical",
    orderIndexNumeric,
    orderIndexNumericPrecision: orderIndexNumeric === null ? "unsafe_provider_number_omitted" : "safe",
    orderId: order.order_id,
    clientOrderIndex: order.client_order_id,
    clientOrderIndexPrecision: "provider_string_canonical",
    clientOrderIndexNumeric,
    clientOrderIndexNumericPrecision: clientOrderIndexNumeric === null ? "unsafe_provider_number_omitted" : "safe",
    clientOrderId: order.client_order_id,
    marketIndex: order.market_index,
    ownerAccountIndex: order.owner_account_index,
    side: order.side ?? null,
    type: order.type ?? null,
    status: order.status ?? null,
    timeInForce: order.time_in_force ?? null,
    reduceOnly: order.reduce_only ?? null,
    price: order.price,
    initialBaseAmount: order.initial_base_amount,
    remainingBaseAmount: order.remaining_base_amount ?? null,
    filledBaseAmount: order.filled_base_amount ?? null,
    filledQuoteAmount: order.filled_quote_amount ?? null,
    triggerPrice: order.trigger_price ?? null,
    orderExpiry: order.order_expiry ?? null,
    blockHeight: order.block_height ?? null,
    timestamp: order.timestamp ?? null,
    createdAt: order.created_at ?? null,
    updatedAt: order.updated_at ?? null,
    transactionTime: order.transaction_time ?? null,
    parentOrderId: order.parent_order_id ?? null,
    triggerOrderIds: [
      order.to_trigger_order_id_0 ?? null,
      order.to_trigger_order_id_1 ?? null,
    ].filter((value): value is string => value !== null),
    cancelOrderIds: [
      order.to_cancel_order_id_0 ?? null,
    ].filter((value): value is string => value !== null),
  };
}

export function projectAccountOrders(response: LighterAccountOrdersResponse, limit: number): Record<string, unknown> {
  const orders = takeFirst(response.orders.map(projectAccountOrder), limit);
  return {
    count: orders.count,
    totalProviderRows: orders.total,
    truncated: orders.truncated,
    nextCursor: response.next_cursor ?? null,
    orders: orders.rows,
  };
}

export function projectApiKey(apiKey: LighterApiKey): Record<string, unknown> {
  const nonce = safeIntegerOrNull(apiKey.nonce);
  const transactionTime = safeIntegerOrNull(apiKey.transaction_time);
  return {
    accountIndex: apiKey.account_index,
    apiKeyIndex: apiKey.api_key_index,
    nonce,
    noncePrecision: nonce === null ? "unsafe_provider_number_omitted" : "safe",
    publicKey: apiKey.public_key,
    transactionTime,
    transactionTimePrecision: transactionTime === null ? "unsafe_provider_number_omitted" : "safe",
  };
}

export function projectApiKeys(response: LighterApiKeysResponse, limit: number): Record<string, unknown> {
  const apiKeys = takeFirst(response.api_keys.map(projectApiKey), limit);
  return {
    count: apiKeys.count,
    totalProviderRows: apiKeys.total,
    truncated: apiKeys.truncated,
    apiKeys: apiKeys.rows,
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

/**
 * One trade record, projected.
 *
 * `accountIndex` is the account the reader is asking ABOUT. Lighter's
 * account-relative fields (position size before, sign changed, realized PnL)
 * describe one side of the trade, and which side is the account's own is
 * decided by the ask and bid account ids on the record itself. Without an
 * account there is no "our side", so those fields project as null and the
 * position effect as unknown - the public `recentTrades` surface, where the
 * rows belong to strangers.
 */
export function projectTrade(trade: LighterTrade, accountIndex?: number): Record<string, unknown> {
  const tradeIdNumeric = safeIntegerOrNull(trade.trade_id);
  const askOrderIdNumeric = safeIntegerOrNull(trade.ask_id);
  const bidOrderIdNumeric = safeIntegerOrNull(trade.bid_id);
  const account = projectTradeAccountView(trade, accountIndex);
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
    timestampUnit: "epoch_milliseconds",
    tradedAt: epochMillisecondsIsoOrNull(trade.timestamp),
    transactionTime: trade.transaction_time ?? null,
    transactionTimeUnit: "epoch_microseconds",
    txHash: trade.tx_hash,
    // FEE RATE TICKS, in millionths of notional - never amounts. Measured live
    // 2026-09-08: 350 on RHC, 100 and 28 on Core beside notionals under one
    // dollar. Reading one as an amount overstates a sub-dollar fill's fee by
    // orders of magnitude.
    fees: {
      unit: "rate_tick_millionths_of_notional",
      exchangeMakerTick: feeRateTickOrNull(trade.maker_fee),
      exchangeTakerTick: feeRateTickOrNull(trade.taker_fee),
      integratorMakerTick: feeRateTickOrNull(trade.integrator_maker_fee),
      integratorTakerTick: feeRateTickOrNull(trade.integrator_taker_fee),
      integratorMakerCollectorIndex: safeIntegerOrNull(trade.integrator_maker_fee_collector_index),
      integratorTakerCollectorIndex: safeIntegerOrNull(trade.integrator_taker_fee_collector_index),
    },
    account,
  };
}

/**
 * The account's own half of a trade record: which side it was on, what it held
 * before the fill, what Lighter says it realized, and the effect the fill had.
 *
 * `known: false` says the account-relative fields were absent (a public row,
 * or a row the account did not take part in) - which is a different statement
 * from an effect of "unknown", and the two are deliberately not collapsed.
 */
function projectTradeAccountView(
  trade: LighterTrade,
  accountIndex?: number,
): Record<string, unknown> {
  const absent = {
    known: false,
    side: null,
    role: null,
    positionSizeBefore: null,
    positionSignChanged: null,
    entryQuoteBefore: null,
    initialMarginFractionBefore: null,
    marginFractionScale: 10_000,
    realizedPnl: null,
    positionEffect: "unknown" as LighterPositionEffect,
    campaignType: "unknown",
  };
  if (accountIndex === undefined || !Number.isSafeInteger(accountIndex)) return absent;
  const isAsk = trade.ask_account_id === accountIndex;
  const isBid = trade.bid_account_id === accountIndex;
  // An account on BOTH sides of one trade is its own counterparty: there is no
  // single side to report, so nothing is reported rather than one half guessed.
  if (isAsk === isBid) return absent;
  const side = isAsk ? "sell" : "buy";
  const role = (side === "sell" ? trade.is_maker_ask : !trade.is_maker_ask) ? "maker" : "taker";
  const facts = readLighterAccountFillFacts({ trade, role, side });
  if (facts === null) return { ...absent, side, role };
  const effect = classifyLighterPositionEffect({
    positionSizeBefore: facts.positionSizeBefore,
    positionSignChanged: facts.positionSignChanged,
    fillBaseSize: trade.size,
    side,
  });
  return {
    known: true,
    side,
    role,
    positionSizeBefore: facts.positionSizeBefore,
    positionSignChanged: facts.positionSignChanged,
    entryQuoteBefore: facts.entryQuoteBefore,
    initialMarginFractionBefore: facts.initialMarginFractionBefore,
    marginFractionScale: 10_000,
    // Lighter's own realized PnL for this account and this fill. Never
    // computed here from entry and exit.
    realizedPnl: facts.accountPnl,
    positionEffect: effect,
    campaignType: lighterCampaignTradeType(effect),
  };
}

/** A provider fee RATE TICK in millionths of notional; anything else is "not reported". */
function feeRateTickOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= 0 && value <= 1_000_000 ? value : null;
}

export function projectRecentTrades(
  response: LighterRecentTradesResponse,
  limit: number,
  accountIndex?: number,
): Record<string, unknown> {
  const trades = takeFirst(response.trades.map((trade) => projectTrade(trade, accountIndex)), limit);
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
