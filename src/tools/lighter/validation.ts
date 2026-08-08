import { z } from "zod";
import { ErrorCodes, VexError } from "../../errors.js";
import {
  LIGHTER_CANDLE_RESOLUTIONS,
  LIGHTER_MARKET_FILTERS,
} from "./constants.js";
import type {
  LighterCandlesResponse,
  LighterMarketDetailsResponse,
  LighterMarketsResponse,
  LighterOrderBookOrdersResponse,
  LighterRecentTradesResponse,
  LighterStatusResponse,
  LighterSystemConfigResponse,
} from "./types.js";

const int = z.number().int().finite();
const providerInteger = z
  .number()
  .finite()
  .refine((value) => Number.isInteger(value), { message: "Expected integer" });
const finiteNumber = z.number().finite();
const numericString = z.string().min(1);
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
    order_id: numericString,
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
    tx_hash: z.string().min(1),
    type: z.enum(["trade", "liquidation", "deleverage", "market-settlement"]),
    market_id: int,
    size: numericString,
    price: numericString,
    usd_amount: numericString,
    ask_id: providerInteger,
    bid_id: providerInteger,
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
    ask_client_id_str: z.string().optional(),
    bid_client_id_str: z.string().optional(),
    ask_id_str: z.string().optional(),
    bid_id_str: z.string().optional(),
    trade_id_str: z.string().optional(),
  })
  .passthrough();

const candleSchema = z
  .object({
    t: int,
    o: finiteNumber,
    h: finiteNumber,
    l: finiteNumber,
    c: finiteNumber,
    v: finiteNumber,
    V: finiteNumber,
    i: int,
    O: finiteNumber.optional(),
    H: finiteNumber.optional(),
    L: finiteNumber.optional(),
    C: finiteNumber.optional(),
  })
  .passthrough();

const statusSchema = z
  .object({
    status: int,
    network_id: int,
    timestamp: int,
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
    spot_order_book_details: z.array(marketDetailSchema).optional().default([]),
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

export function validateLighterSystemConfig(raw: unknown): LighterSystemConfigResponse {
  return parseOrThrow(systemConfigSchema, raw, "system config");
}

export function validateLighterMarkets(raw: unknown): LighterMarketsResponse {
  return parseOrThrow(marketsResponseSchema, raw, "markets");
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
