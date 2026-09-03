import { z } from "zod";
import { ErrorCodes, VexError } from "../../errors.js";
import {
  LIGHTER_CANDLE_RESOLUTIONS,
  LIGHTER_MARKET_FILTERS,
} from "./constants.js";
import type {
  LighterAccountOrdersResponse,
  LighterAccountAllOrdersStreamMessage,
  LighterAccountAllPositionsStreamMessage,
  LighterAccountAllTradesStreamMessage,
  LighterAccountResponse,
  LighterAccountsByL1AddressResponse,
  LighterAccountTradesResponse,
  LighterApiKeysResponse,
  LighterAssetDetailsResponse,
  LighterCandlesResponse,
  LighterMarketDetailsResponse,
  LighterMarketsResponse,
  LighterNextNonceResponse,
  LighterOrderBookOrdersResponse,
  LighterReadOnlyTokensResponse,
  LighterRecentTradesResponse,
  LighterSendTxResponse,
  LighterStatusResponse,
  LighterSystemConfigResponse,
  LighterLayer1BasicInfoResponse,
  LighterInfoResponse,
  LighterTxFromL1Response,
  LighterWithdrawalDelayResponse,
  LighterWithdrawHistoryResponse,
} from "./types.js";

const int = z.number().int().finite();
const providerInteger = z
  .number()
  .finite()
  .refine((value) => Number.isInteger(value), { message: "Expected integer" });
const finiteNumber = z.number().finite();
const numericString = z.string().min(1);
const integerString = z.string().regex(/^\d+$/, {
  message: "Expected decimal integer string",
});
const optionalIntegerString = integerString.optional();
const optionalNumericString = z.string().optional();
const message = z.string().optional();

const marketType = z.enum(["perp", "spot"]);
const marketStatus = z.enum(["inactive", "active"]);
export const lighterMarketFilterSchema = z.enum(LIGHTER_MARKET_FILTERS);
export const lighterCandleResolutionSchema = z.enum(LIGHTER_CANDLE_RESOLUTIONS);

const marketSchema = z
  .object({
    symbol: z.string().min(1),
    market_id: int,
    market_type: marketType,
    base_asset_id: int,
    quote_asset_id: int,
    status: marketStatus,
    taker_fee: numericString,
    maker_fee: numericString,
    liquidation_fee: numericString,
    min_base_amount: numericString,
    min_quote_amount: numericString,
    supported_size_decimals: int,
    supported_price_decimals: int,
    supported_quote_decimals: int,
    order_quote_limit: numericString,
    is_maker_fee_enabled: z.boolean(),
    is_taker_fee_enabled: z.boolean(),
  })
  .passthrough();

const marketDetailSchema = marketSchema
  .extend({
    size_decimals: int.optional(),
    price_decimals: int.optional(),
    quote_multiplier: int.optional(),
    default_initial_margin_fraction: int.optional(),
    min_initial_margin_fraction: int.optional(),
    maintenance_margin_fraction: int.optional(),
    closeout_margin_fraction: int.optional(),
    last_trade_price: finiteNumber.optional(),
    daily_trades_count: int.optional(),
    daily_base_token_volume: finiteNumber.optional(),
    daily_quote_token_volume: finiteNumber.optional(),
    daily_price_low: finiteNumber.optional(),
    daily_price_high: finiteNumber.optional(),
    daily_price_change: finiteNumber.optional(),
    daily_chart: z.record(z.string(), finiteNumber).optional(),
    open_interest: finiteNumber.optional(),
    market_config: z.record(z.string(), z.unknown()).optional(),
    strategy_index: int.optional(),
    funding_clamp_small: optionalNumericString,
    funding_clamp_big: optionalNumericString,
    base_interest_rate: optionalNumericString,
  })
  .passthrough();

const simpleOrderSchema = z
  .object({
    order_index: providerInteger,
    order_id: integerString,
    owner_account_index: int,
    initial_base_amount: numericString,
    remaining_base_amount: numericString,
    price: numericString,
    order_expiry: int,
    transaction_time: int,
  })
  .passthrough();

const tradeSchema = z
  .object({
    trade_id: providerInteger,
    trade_id_str: integerString,
    tx_hash: z.string().min(1),
    type: z.enum(["trade", "liquidation", "deleverage", "market-settlement"]),
    market_id: int,
    size: numericString,
    price: numericString,
    usd_amount: numericString,
    ask_id: providerInteger,
    ask_id_str: integerString,
    bid_id: providerInteger,
    bid_id_str: integerString,
    ask_account_id: int,
    bid_account_id: int,
    is_maker_ask: z.boolean(),
    block_height: int,
    timestamp: int,
    transaction_time: int.optional(),
    taker_fee: int.optional(),
    maker_fee: int.optional(),
    ask_client_id: providerInteger.optional(),
    bid_client_id: providerInteger.optional(),
    ask_client_id_str: optionalIntegerString,
    bid_client_id_str: optionalIntegerString,
  })
  .passthrough();

const rawCandleSchema = z
  .object({
    t: int,
    o: finiteNumber.optional(),
    h: finiteNumber.optional(),
    l: finiteNumber.optional(),
    c: finiteNumber.optional(),
    v: finiteNumber.optional(),
    V: finiteNumber.optional(),
    i: integerString,
    O: finiteNumber.optional(),
    H: finiteNumber.optional(),
    L: finiteNumber.optional(),
    C: finiteNumber.optional(),
  })
  .passthrough();

const candleSchema = rawCandleSchema.transform((candle, context) => {
  const o = candle.o ?? candle.O;
  const h = candle.h ?? candle.H;
  const l = candle.l ?? candle.L;
  const c = candle.c ?? candle.C;
  if (o === undefined || h === undefined || l === undefined || c === undefined) {
    context.addIssue({
      code: "custom",
      message: "Candle is missing OHLC values.",
    });
    return z.NEVER;
  }
  return {
    ...candle,
    o,
    h,
    l,
    c,
    // Lighter omits zero-valued fields in sparse REST candles.
    v: candle.v ?? 0,
    V: candle.V ?? 0,
  };
});

const statusSchema = z
  .object({
    status: int,
    network_id: int,
    timestamp: int,
  })
  .passthrough();

const infoSchema = z
  .object({
    contract_address: z.string().min(1),
  })
  .passthrough();

const systemConfigSchema = z
  .object({
    code: int,
    message,
    liquidity_pool_index: int,
    staking_pool_index: int,
    funding_fee_rebate_account_index: int,
    market_maker_incentive_account_index: int,
    liquidity_pool_cooldown_period: int,
    staking_pool_lockup_period: int,
    max_integrator_perps_maker_fee: int,
    max_integrator_perps_taker_fee: int,
    max_integrator_spot_maker_fee: int,
    max_integrator_spot_taker_fee: int,
  })
  .passthrough();

const layer1BasicInfoResponseSchema = z
  .object({
    code: int,
    message,
    l1_providers: z.array(z.object({
      chainId: int,
      networkId: int,
      latestBlockNumber: providerInteger,
    }).passthrough()),
    l1_providers_health: z.boolean(),
    contract_addresses: z.array(z.object({
      name: z.string().min(1),
      address: z.string().min(1),
    }).passthrough()),
  })
  .passthrough();

const assetDetailsResponseSchema = z
  .object({
    code: int,
    message,
    asset_details: z.array(z.object({
      asset_id: int,
      symbol: z.string().min(1),
      l1_decimals: int,
      decimals: int,
      min_transfer_amount: numericString,
      min_withdrawal_amount: numericString.optional(),
      l1_address: z.string().min(1),
      // Lighter added `priced_only` for assets that expose an index price but
      // are not collateral-enabled. Withdrawal/deposit preflights still
      // require the exact settlement asset (USDC/USDG) to be `enabled`.
      margin_mode: z.enum(["enabled", "disabled", "priced_only"]).optional(),
    }).passthrough()),
  })
  .passthrough();

const accountsByL1AddressResponseSchema = z
  .object({
    code: int,
    message,
    l1_address: z.string().min(1),
    sub_accounts: z.array(z.object({
      account_type: int,
      index: int,
      l1_address: z.string().min(1),
    }).passthrough()),
    next_cursor: z.string().optional(),
  })
  .passthrough();

const txFromL1ResponseSchema = z
  .object({
    code: int,
    message,
    hash: z.string().min(1).max(256),
    type: int,
    info: z.string().min(1),
    event_info: z.string().min(1),
    status: int,
    transaction_index: providerInteger,
    l1_address: z.string().min(1),
    account_index: int,
    nonce: providerInteger,
    expire_at: providerInteger,
    block_height: providerInteger,
    queued_at: providerInteger,
    executed_at: providerInteger,
    sequence_index: providerInteger,
    parent_hash: z.string(),
    api_key_index: int,
    transaction_time: providerInteger,
    committed_at: providerInteger,
    verified_at: providerInteger,
  })
  .passthrough();

const accountPositionSchema = z
  .object({
    market_id: int,
    symbol: z.string().min(1),
    initial_margin_fraction: numericString,
    open_order_count: int,
    pending_order_count: int,
    position_tied_order_count: int,
    sign: int,
    position: numericString,
    avg_entry_price: numericString,
    position_value: numericString,
    unrealized_pnl: numericString,
    realized_pnl: numericString,
    liquidation_price: numericString,
    total_funding_paid_out: numericString.optional(),
    margin_mode: int,
    allocated_margin: numericString,
    total_discount: numericString.optional(),
  })
  .passthrough();

const accountAssetSchema = z
  .object({
    symbol: z.string().min(1),
    asset_id: int,
    balance: numericString,
    locked_balance: numericString,
    margin_balance: numericString,
    margin_mode: z.enum(["enabled", "disabled"]),
    multiplier: numericString,
  })
  .passthrough();

const accountSchema = z
  .object({
    index: int.optional(),
    account_index: int.optional(),
    l1_address: z.string().optional(),
    status: int.optional(),
    collateral: optionalNumericString,
    available_balance: optionalNumericString,
    pending_order_count: int.optional(),
    cross_initial_margin_requirement: optionalNumericString,
    cross_maintenance_margin_requirement: optionalNumericString,
    positions: z.array(accountPositionSchema).optional(),
    assets: z.array(accountAssetSchema).optional(),
  })
  .passthrough();

const accountResponseSchema = z
  .object({
    code: int,
    message,
    total: int.optional(),
    accounts: z.array(accountSchema),
  })
  .passthrough();

const readOnlyTokensResponseSchema = z
  .object({
    code: int,
    message,
    tokens: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .passthrough();

const apiKeySchema = z
  .object({
    account_index: int,
    api_key_index: int,
    nonce: providerInteger,
    public_key: z.string().min(1),
    transaction_time: providerInteger,
  })
  .passthrough();

const apiKeysResponseSchema = z
  .object({
    code: int,
    message,
    api_keys: z.array(apiKeySchema).default([]),
  })
  .passthrough();

const nextNonceResponseSchema = z
  .object({
    code: int,
    message,
    nonce: providerInteger,
  })
  .passthrough();

const withdrawalDelayResponseSchema = z
  .object({
    seconds: int.nonnegative(),
  })
  .passthrough();

const withdrawHistoryResponseSchema = z
  .object({
    code: int,
    message,
    withdraws: z.array(z.object({
      id: z.string().min(1).max(256),
      amount: numericString,
      timestamp: providerInteger,
      status: z.enum(["failed", "pending", "claimable", "refunded", "completed"]),
      type: z.enum(["secure", "fast"]),
      l1_tx_hash: z.string().max(256),
      asset_id: int,
    }).passthrough()).max(1_000),
    cursor: z.string(),
  })
  .passthrough();

const sendTxResponseSchema = z
  .object({
    code: int,
    message,
    tx_hash: z.string().min(1),
    predicted_execution_time_ms: int,
    volume_quota_remaining: int.optional(),
  })
  .passthrough();

const accountTradesResponseSchema = z
  .object({
    code: int,
    message,
    next_cursor: z.string().optional(),
    trades: z.array(tradeSchema),
  })
  .passthrough();

const accountOrderSchema = z
  .object({
    order_index: providerInteger,
    client_order_index: providerInteger,
    order_id: integerString,
    client_order_id: integerString,
    market_index: int,
    owner_account_index: int,
    initial_base_amount: numericString,
    price: numericString,
    nonce: providerInteger.optional(),
    remaining_base_amount: optionalNumericString,
    is_ask: z.boolean().optional(),
    base_size: providerInteger.optional(),
    base_price: providerInteger.optional(),
    filled_base_amount: optionalNumericString,
    filled_quote_amount: optionalNumericString,
    side: z.string().optional(),
    type: z.string().optional(),
    time_in_force: z.string().optional(),
    reduce_only: z.boolean().optional(),
    trigger_price: optionalNumericString,
    order_expiry: providerInteger.optional(),
    status: z.string().optional(),
    trigger_status: z.string().optional(),
    trigger_time: providerInteger.optional(),
    parent_order_index: providerInteger.optional(),
    parent_order_id: optionalIntegerString,
    to_trigger_order_id_0: optionalIntegerString,
    to_trigger_order_id_1: optionalIntegerString,
    to_cancel_order_id_0: optionalIntegerString,
    block_height: providerInteger.optional(),
    timestamp: providerInteger.optional(),
    created_at: providerInteger.optional(),
    updated_at: providerInteger.optional(),
    transaction_time: providerInteger.optional(),
  })
  .passthrough();

const accountOrdersResponseSchema = z
  .object({
    code: int,
    message,
    next_cursor: z.string().optional(),
    orders: z.array(accountOrderSchema).default([]),
  })
  .passthrough();

const accountAllOrdersStreamSchema = z
  .object({
    type: z.literal("update/account_all_orders"),
    channel: z.string().min(1).max(160),
    orders: z.record(
      z.string().regex(/^\d+$/),
      z.array(accountOrderSchema).max(2_000),
    ),
    timestamp: providerInteger.optional(),
  })
  .passthrough();

const accountAllTradesStreamSchema = z
  .object({
    type: z.enum(["subscribed/account_all_trades", "update/account_all_trades"]),
    channel: z.string().min(1).max(160),
    trades: z.union([
      z.array(tradeSchema).max(5_000),
      z.record(z.string().regex(/^\d+$/), z.array(tradeSchema).max(2_000)),
    ]),
    total_volume: finiteNumber.optional(),
    monthly_volume: finiteNumber.optional(),
    weekly_volume: finiteNumber.optional(),
    daily_volume: finiteNumber.optional(),
    timestamp: providerInteger.optional(),
  })
  .passthrough();

const accountAllPositionsStreamSchema = z
  .object({
    type: z.enum(["subscribed/account_all_positions", "update/account_all_positions"]),
    channel: z.string().min(1).max(160),
    positions: z.record(z.string().regex(/^\d+$/), accountPositionSchema),
    shares: z.array(z.record(z.string(), z.unknown())).max(2_000).default([]),
    last_funding_round: z.record(z.string().regex(/^\d+$/), numericString).optional(),
    last_funding_discount: z.record(z.string().regex(/^\d+$/), numericString).optional(),
    timestamp: providerInteger.optional(),
  })
  .passthrough();

const marketsResponseSchema = z
  .object({
    code: int,
    message,
    order_books: z.array(marketSchema),
  })
  .passthrough();

const marketDetailsResponseSchema = z
  .object({
    code: int,
    message,
    order_book_details: z.array(marketDetailSchema),
    spot_order_book_details: z.array(marketDetailSchema).nullish().transform((rows) => rows ?? []),
  })
  .passthrough();

const orderBookOrdersResponseSchema = z
  .object({
    code: int,
    message,
    total_asks: int,
    asks: z.array(simpleOrderSchema),
    total_bids: int,
    bids: z.array(simpleOrderSchema),
  })
  .passthrough();

const recentTradesResponseSchema = z
  .object({
    code: int,
    message,
    next_cursor: z.string().optional(),
    trades: z.array(tradeSchema),
  })
  .passthrough();

const candlesResponseSchema = z
  .object({
    code: int,
    r: lighterCandleResolutionSchema,
    c: z.array(candleSchema),
    message,
  })
  .passthrough();

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, label: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");

  throw new VexError(
    ErrorCodes.LIGHTER_INVALID_RESPONSE,
    `Invalid Lighter ${label} response: ${detail}`,
    "The Lighter API returned an unexpected response shape.",
  );
}

export function validateLighterStatus(raw: unknown): LighterStatusResponse {
  return parseOrThrow(statusSchema, raw, "status");
}

export function validateLighterInfo(raw: unknown): LighterInfoResponse {
  return parseOrThrow(infoSchema, raw, "info");
}

export function validateLighterSystemConfig(raw: unknown): LighterSystemConfigResponse {
  return parseOrThrow(systemConfigSchema, raw, "system config");
}

export function validateLighterLayer1BasicInfo(raw: unknown): LighterLayer1BasicInfoResponse {
  return parseOrThrow(layer1BasicInfoResponseSchema, raw, "layer 1 basic info");
}

export function validateLighterAssetDetails(raw: unknown): LighterAssetDetailsResponse {
  return parseOrThrow(assetDetailsResponseSchema, raw, "asset details");
}

export function validateLighterAccountsByL1Address(
  raw: unknown,
): LighterAccountsByL1AddressResponse {
  return parseOrThrow(accountsByL1AddressResponseSchema, raw, "accounts by L1 address");
}

export function validateLighterTxFromL1(raw: unknown): LighterTxFromL1Response {
  return parseOrThrow(txFromL1ResponseSchema, raw, "transaction from L1");
}

export function validateLighterMarkets(raw: unknown): LighterMarketsResponse {
  return parseOrThrow(marketsResponseSchema, raw, "markets");
}

export function validateLighterAccount(raw: unknown): LighterAccountResponse {
  return parseOrThrow(accountResponseSchema, raw, "account");
}

export function validateLighterReadOnlyTokens(raw: unknown): LighterReadOnlyTokensResponse {
  return parseOrThrow(readOnlyTokensResponseSchema, raw, "read-only tokens");
}

export function validateLighterApiKeys(raw: unknown): LighterApiKeysResponse {
  return parseOrThrow(apiKeysResponseSchema, raw, "api keys");
}

export function validateLighterNextNonce(raw: unknown): LighterNextNonceResponse {
  return parseOrThrow(nextNonceResponseSchema, raw, "next nonce");
}

export function validateLighterWithdrawalDelay(raw: unknown): LighterWithdrawalDelayResponse {
  return parseOrThrow(withdrawalDelayResponseSchema, raw, "withdrawal delay");
}

export function validateLighterWithdrawHistory(raw: unknown): LighterWithdrawHistoryResponse {
  return parseOrThrow(withdrawHistoryResponseSchema, raw, "withdraw history");
}

export function validateLighterSendTx(raw: unknown): LighterSendTxResponse {
  return parseOrThrow(sendTxResponseSchema, raw, "sendTx");
}

export function validateLighterAccountTrades(raw: unknown): LighterAccountTradesResponse {
  return parseOrThrow(accountTradesResponseSchema, raw, "account trades");
}

export function validateLighterAccountOrders(raw: unknown): LighterAccountOrdersResponse {
  return parseOrThrow(accountOrdersResponseSchema, raw, "account orders");
}

/**
 * Validate one authenticated account-wide order stream frame against the exact
 * account used to mint the auth token. The market map and every embedded order
 * must agree; a cross-account or cross-market frame is rejected before it can
 * mutate durable execution state.
 */
export function validateLighterAccountAllOrdersStreamMessage(
  raw: unknown,
  expectedAccountIndex: number,
): LighterAccountAllOrdersStreamMessage {
  if (!Number.isSafeInteger(expectedAccountIndex) || expectedAccountIndex < 0) {
    throw invalidStreamMessage("expected account index is invalid");
  }
  const parsed = parseOrThrow(
    accountAllOrdersStreamSchema,
    raw,
    "account all orders stream",
  );
  if (parsed.channel !== `account_all_orders:${expectedAccountIndex}`) {
    throw invalidStreamMessage("channel does not match the authenticated account");
  }

  let totalOrders = 0;
  const clientOrderIds = new Set<string>();
  for (const [marketIndexRaw, orders] of Object.entries(parsed.orders)) {
    const marketIndex = Number(marketIndexRaw);
    if (!Number.isSafeInteger(marketIndex) || marketIndex < 0) {
      throw invalidStreamMessage("market map contains an invalid index");
    }
    totalOrders += orders.length;
    if (totalOrders > 5_000) {
      throw invalidStreamMessage("frame exceeds the bounded order count");
    }
    for (const order of orders) {
      if (order.owner_account_index !== expectedAccountIndex) {
        throw invalidStreamMessage("order owner does not match the authenticated account");
      }
      if (order.market_index !== marketIndex) {
        throw invalidStreamMessage("order market does not match its market-map key");
      }
      if (order.status !== undefined && order.status.length > 80) {
        throw invalidStreamMessage("order status exceeds the bounded length");
      }
      if (clientOrderIds.has(order.client_order_id)) {
        throw invalidStreamMessage("frame contains a duplicate client order id");
      }
      clientOrderIds.add(order.client_order_id);
    }
  }
  return parsed;
}

export function validateLighterAccountAllTradesStreamMessage(
  raw: unknown,
  expectedAccountIndex: number,
): LighterAccountAllTradesStreamMessage {
  assertExpectedStreamAccount(expectedAccountIndex);
  const parsed = parseOrThrow(accountAllTradesStreamSchema, raw, "account all trades stream");
  if (parsed.channel !== `account_all_trades:${expectedAccountIndex}`) {
    throw invalidAccountStreamMessage("trades channel does not match the authenticated account");
  }
  const seenTradeIds = new Set<string>();
  let totalTrades = 0;
  const entries = Array.isArray(parsed.trades)
    ? [[null, parsed.trades] as const]
    : Object.entries(parsed.trades);
  for (const [marketIndexRaw, trades] of entries) {
    const marketIndex = marketIndexRaw === null ? null : Number(marketIndexRaw);
    if (marketIndex !== null && (!Number.isSafeInteger(marketIndex) || marketIndex < 0)) {
      throw invalidAccountStreamMessage("trade market map contains an invalid index");
    }
    totalTrades += trades.length;
    if (totalTrades > 5_000) throw invalidAccountStreamMessage("frame exceeds the bounded trade count");
    for (const trade of trades) {
      if (marketIndex !== null && trade.market_id !== marketIndex) {
        throw invalidAccountStreamMessage("trade market does not match its market-map key");
      }
      if (trade.ask_account_id !== expectedAccountIndex && trade.bid_account_id !== expectedAccountIndex) {
        throw invalidAccountStreamMessage("trade does not involve the authenticated account");
      }
      if (seenTradeIds.has(trade.trade_id_str)) {
        throw invalidAccountStreamMessage("frame contains a duplicate trade id");
      }
      seenTradeIds.add(trade.trade_id_str);
    }
  }
  return parsed;
}

export function validateLighterAccountAllPositionsStreamMessage(
  raw: unknown,
  expectedAccountIndex: number,
): LighterAccountAllPositionsStreamMessage {
  assertExpectedStreamAccount(expectedAccountIndex);
  const parsed = parseOrThrow(accountAllPositionsStreamSchema, raw, "account all positions stream");
  if (parsed.channel !== `account_all_positions:${expectedAccountIndex}`) {
    throw invalidAccountStreamMessage("positions channel does not match the authenticated account");
  }
  if (Object.keys(parsed.positions).length > 5_000) {
    throw invalidAccountStreamMessage("frame exceeds the bounded position count");
  }
  for (const [marketIndexRaw, position] of Object.entries(parsed.positions)) {
    const marketIndex = Number(marketIndexRaw);
    if (!Number.isSafeInteger(marketIndex) || marketIndex < 0 || position.market_id !== marketIndex) {
      throw invalidAccountStreamMessage("position market does not match its market-map key");
    }
  }
  return parsed;
}

function assertExpectedStreamAccount(expectedAccountIndex: number): void {
  if (!Number.isSafeInteger(expectedAccountIndex) || expectedAccountIndex < 0) {
    throw invalidAccountStreamMessage("expected account index is invalid");
  }
}

function invalidAccountStreamMessage(detail: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_RESPONSE,
    `Invalid Lighter account stream response: ${detail}.`,
    "The Lighter stream returned evidence outside the expected account scope.",
  );
}

function invalidStreamMessage(detail: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_RESPONSE,
    `Invalid Lighter account all orders stream response: ${detail}.`,
    "The Lighter stream returned evidence outside the authenticated account scope.",
  );
}

export function validateLighterMarketDetails(raw: unknown): LighterMarketDetailsResponse {
  return parseOrThrow(marketDetailsResponseSchema, raw, "market details");
}

export function validateLighterOrderBookOrders(raw: unknown): LighterOrderBookOrdersResponse {
  return parseOrThrow(orderBookOrdersResponseSchema, raw, "order book");
}

export function validateLighterRecentTrades(raw: unknown): LighterRecentTradesResponse {
  return parseOrThrow(recentTradesResponseSchema, raw, "recent trades");
}

export function validateLighterCandles(raw: unknown): LighterCandlesResponse {
  return parseOrThrow(candlesResponseSchema, raw, "candles");
}
