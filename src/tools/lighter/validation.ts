import { z } from "zod";
import { ErrorCodes, VexError } from "../../errors.js";
import {
  LIGHTER_CANDLE_RESOLUTIONS,
  LIGHTER_MARKET_FILTERS,
} from "./constants.js";
import type {
  LighterAccountOrdersResponse,
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
  LighterTxFromL1Response,
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
    assets: z.array(z.object({
      asset_id: int,
      symbol: z.string().min(1),
      l1_decimals: int,
      decimals: int,
      min_transfer_amount: numericString,
      l1_address: z.string().min(1),
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

const accountSchema = z
  .object({
    index: int.optional(),
    account_index: int.optional(),
    l1_address: z.string().optional(),
    status: int.optional(),
    collateral: optionalNumericString,
    available_balance: optionalNumericString,
    positions: z.array(z.unknown()).optional(),
    assets: z.array(z.unknown()).optional(),
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

export function validateLighterSendTx(raw: unknown): LighterSendTxResponse {
  return parseOrThrow(sendTxResponseSchema, raw, "sendTx");
}

export function validateLighterAccountTrades(raw: unknown): LighterAccountTradesResponse {
  return parseOrThrow(accountTradesResponseSchema, raw, "account trades");
}

export function validateLighterAccountOrders(raw: unknown): LighterAccountOrdersResponse {
  return parseOrThrow(accountOrdersResponseSchema, raw, "account orders");
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
