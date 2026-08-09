import type {
  LighterCandleResolution,
  LighterEnvironment,
  LighterMarketFilter,
} from "./constants.js";

export type { LighterCandleResolution, LighterEnvironment, LighterMarketFilter };

export interface LighterStatusResponse {
  status: number;
  network_id: number;
  timestamp: number;
  [key: string]: unknown;
}

export interface LighterSystemConfigResponse {
  code: number;
  message?: string;
  liquidity_pool_index: number;
  staking_pool_index: number;
  funding_fee_rebate_account_index: number;
  market_maker_incentive_account_index: number;
  liquidity_pool_cooldown_period: number;
  staking_pool_lockup_period: number;
  max_integrator_perps_maker_fee: number;
  max_integrator_perps_taker_fee: number;
  max_integrator_spot_maker_fee: number;
  max_integrator_spot_taker_fee: number;
  [key: string]: unknown;
}

export type LighterMarketType = "perp" | "spot";
export type LighterMarketStatus = "inactive" | "active";

export interface LighterMarket {
  symbol: string;
  market_id: number;
  market_type: LighterMarketType;
  base_asset_id: number;
  quote_asset_id: number;
  status: LighterMarketStatus;
  taker_fee: string;
  maker_fee: string;
  liquidation_fee: string;
  min_base_amount: string;
  min_quote_amount: string;
  supported_size_decimals: number;
  supported_price_decimals: number;
  supported_quote_decimals: number;
  order_quote_limit: string;
  is_maker_fee_enabled: boolean;
  is_taker_fee_enabled: boolean;
  [key: string]: unknown;
}

export interface LighterMarketsResponse {
  code: number;
  message?: string;
  order_books: LighterMarket[];
  [key: string]: unknown;
}

export interface LighterMarketDetail extends LighterMarket {
  size_decimals?: number;
  price_decimals?: number;
  quote_multiplier?: number;
  last_trade_price?: number;
  daily_trades_count?: number;
  daily_base_token_volume?: number;
  daily_quote_token_volume?: number;
  daily_price_low?: number;
  daily_price_high?: number;
  daily_price_change?: number;
  daily_chart?: Record<string, number>;
  open_interest?: number;
  market_config?: Record<string, unknown>;
  strategy_index?: number;
  funding_clamp_small?: string;
  funding_clamp_big?: string;
  base_interest_rate?: string;
}

export interface LighterMarketDetailsResponse {
  code: number;
  message?: string;
  order_book_details: LighterMarketDetail[];
  spot_order_book_details: LighterMarketDetail[];
  [key: string]: unknown;
}

export interface LighterSimpleOrder {
  order_index: number;
  order_id: string;
  owner_account_index: number;
  initial_base_amount: string;
  remaining_base_amount: string;
  price: string;
  order_expiry: number;
  transaction_time: number;
  [key: string]: unknown;
}

export interface LighterOrderBookOrdersResponse {
  code: number;
  message?: string;
  total_asks: number;
  asks: LighterSimpleOrder[];
  total_bids: number;
  bids: LighterSimpleOrder[];
  [key: string]: unknown;
}

export type LighterTradeType = "trade" | "liquidation" | "deleverage" | "market-settlement";

export interface LighterTrade {
  trade_id: number;
  trade_id_str: string;
  tx_hash: string;
  type: LighterTradeType;
  market_id: number;
  size: string;
  price: string;
  usd_amount: string;
  ask_id: number;
  ask_id_str: string;
  bid_id: number;
  bid_id_str: string;
  ask_account_id: number;
  bid_account_id: number;
  is_maker_ask: boolean;
  block_height: number;
  timestamp: number;
  transaction_time?: number;
  taker_fee?: number;
  maker_fee?: number;
  ask_client_id?: number;
  bid_client_id?: number;
  ask_client_id_str?: string;
  bid_client_id_str?: string;
  [key: string]: unknown;
}

export interface LighterRecentTradesResponse {
  code: number;
  message?: string;
  next_cursor?: string;
  trades: LighterTrade[];
  [key: string]: unknown;
}

export interface LighterCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  V: number;
  i: number;
  O?: number;
  H?: number;
  L?: number;
  C?: number;
  [key: string]: unknown;
}

export interface LighterCandlesResponse {
  code: number;
  r: LighterCandleResolution;
  c: LighterCandle[];
  message?: string;
  [key: string]: unknown;
}

export interface LighterMarketQuery {
  marketId?: number;
  filter?: LighterMarketFilter;
}

export interface LighterMarketDetailQuery {
  marketId: number;
  filter?: LighterMarketFilter;
}

export interface LighterOrderBookOrdersParams {
  marketId: number;
  limit?: number;
}

export interface LighterRecentTradesParams {
  marketId: number;
  limit?: number;
}

export interface LighterCandlesParams {
  marketId: number;
  resolution: LighterCandleResolution;
  startTimestamp: number;
  endTimestamp: number;
  countBack?: number;
  setTimestampToEnd?: boolean;
}
