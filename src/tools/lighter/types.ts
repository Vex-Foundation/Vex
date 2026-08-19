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

export interface LighterInfoResponse {
  contract_address: string;
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

export interface LighterContractAddress {
  name: string;
  address: string;
  [key: string]: unknown;
}

export interface LighterLayer1Provider {
  chainId: number;
  networkId: number;
  latestBlockNumber: number;
  [key: string]: unknown;
}

export interface LighterLayer1BasicInfoResponse {
  code: number;
  message?: string;
  l1_providers: LighterLayer1Provider[];
  l1_providers_health: boolean;
  contract_addresses: LighterContractAddress[];
  [key: string]: unknown;
}

export interface LighterAssetDetail {
  asset_id: number;
  symbol: string;
  l1_decimals: number;
  decimals: number;
  min_transfer_amount: string;
  min_withdrawal_amount?: string;
  l1_address: string;
  margin_mode?: "enabled" | "disabled";
  [key: string]: unknown;
}

export interface LighterAssetDetailsResponse {
  code: number;
  message?: string;
  asset_details: LighterAssetDetail[];
  [key: string]: unknown;
}

export interface LighterSubAccount {
  account_type: number;
  index: number;
  l1_address: string;
  [key: string]: unknown;
}

export interface LighterAccountsByL1AddressResponse {
  code: number;
  message?: string;
  l1_address: string;
  sub_accounts: LighterSubAccount[];
  next_cursor?: string;
  [key: string]: unknown;
}

export interface LighterTxFromL1Response {
  code: number;
  message?: string;
  hash: string;
  type: number;
  info: string;
  event_info: string;
  status: number;
  transaction_index: number;
  l1_address: string;
  account_index: number;
  nonce: number;
  expire_at: number;
  block_height: number;
  queued_at: number;
  executed_at: number;
  sequence_index: number;
  parent_hash: string;
  api_key_index: number;
  transaction_time: number;
  committed_at: number;
  verified_at: number;
  [key: string]: unknown;
}

export interface LighterAccount {
  index?: number;
  account_index?: number;
  l1_address?: string;
  status?: number;
  collateral?: string;
  available_balance?: string;
  pending_order_count?: number;
  cross_initial_margin_requirement?: string;
  cross_maintenance_margin_requirement?: string;
  positions?: LighterAccountPosition[];
  assets?: unknown[];
  [key: string]: unknown;
}

export interface LighterAccountPosition {
  market_id: number;
  symbol: string;
  initial_margin_fraction: string;
  open_order_count: number;
  pending_order_count: number;
  position_tied_order_count: number;
  sign: number;
  position: string;
  avg_entry_price: string;
  position_value: string;
  unrealized_pnl: string;
  realized_pnl: string;
  liquidation_price: string;
  total_funding_paid_out?: string;
  margin_mode: number;
  allocated_margin: string;
  total_discount?: string;
  [key: string]: unknown;
}

export interface LighterAccountResponse {
  code: number;
  message?: string;
  total?: number;
  accounts: LighterAccount[];
  [key: string]: unknown;
}

export interface LighterReadOnlyTokensResponse {
  code: number;
  message?: string;
  tokens: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface LighterApiKey {
  account_index: number;
  api_key_index: number;
  nonce: number;
  public_key: string;
  transaction_time: number;
  [key: string]: unknown;
}

export interface LighterApiKeysResponse {
  code: number;
  message?: string;
  api_keys: LighterApiKey[];
  [key: string]: unknown;
}

export interface LighterNextNonceResponse {
  code: number;
  message?: string;
  nonce: number;
  [key: string]: unknown;
}

export interface LighterWithdrawalDelayResponse {
  seconds: number;
  [key: string]: unknown;
}

export type LighterWithdrawHistoryStatus =
  | "failed"
  | "pending"
  | "claimable"
  | "refunded"
  | "completed";

export interface LighterWithdrawHistoryItem {
  id: string;
  amount: string;
  timestamp: number;
  status: LighterWithdrawHistoryStatus;
  type: "secure" | "fast";
  l1_tx_hash: string;
  asset_id: number;
  [key: string]: unknown;
}

export interface LighterWithdrawHistoryResponse {
  code: number;
  message?: string;
  withdraws: LighterWithdrawHistoryItem[];
  cursor: string;
  [key: string]: unknown;
}

export interface LighterSendTxParams {
  txType: number;
  txInfo: string;
  priceProtection?: boolean;
}

export interface LighterSendTxResponse {
  code: number;
  message?: string;
  tx_hash: string;
  predicted_execution_time_ms: number;
  volume_quota_remaining?: number;
  [key: string]: unknown;
}

export interface LighterAccountTradesResponse {
  code: number;
  message?: string;
  next_cursor?: string;
  trades: LighterTrade[];
  [key: string]: unknown;
}

export interface LighterAccountOrder {
  order_index: number;
  client_order_index: number;
  order_id: string;
  client_order_id: string;
  market_index: number;
  owner_account_index: number;
  initial_base_amount: string;
  price: string;
  nonce?: number;
  remaining_base_amount?: string;
  is_ask?: boolean;
  base_size?: number;
  base_price?: number;
  filled_base_amount?: string;
  filled_quote_amount?: string;
  side?: string;
  type?: string;
  time_in_force?: string;
  reduce_only?: boolean;
  trigger_price?: string;
  order_expiry?: number;
  status?: string;
  trigger_status?: string;
  trigger_time?: number;
  parent_order_index?: number;
  parent_order_id?: string;
  to_trigger_order_id_0?: string;
  to_trigger_order_id_1?: string;
  to_cancel_order_id_0?: string;
  block_height?: number;
  timestamp?: number;
  created_at?: number;
  updated_at?: number;
  transaction_time?: number;
  [key: string]: unknown;
}

export interface LighterAccountOrdersResponse {
  code: number;
  message?: string;
  next_cursor?: string;
  orders: LighterAccountOrder[];
  [key: string]: unknown;
}

/**
 * Authenticated `account_all_orders/{ACCOUNT_ID}` WebSocket evidence.
 *
 * The provider sends order IDs in both numeric and string form. Consumers must
 * match the string `client_order_id`; JavaScript numbers cannot represent the
 * full identifier range losslessly.
 */
export interface LighterAccountAllOrdersStreamMessage {
  readonly type: "update/account_all_orders";
  readonly channel: string;
  readonly orders: Readonly<Record<string, readonly LighterAccountOrder[]>>;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

/** Authenticated account-wide trade evidence. Initial snapshots use an array; updates are keyed by market. */
export interface LighterAccountAllTradesStreamMessage {
  readonly type: "subscribed/account_all_trades" | "update/account_all_trades";
  readonly channel: string;
  readonly trades: readonly LighterTrade[] | Readonly<Record<string, readonly LighterTrade[]>>;
  readonly total_volume?: number;
  readonly monthly_volume?: number;
  readonly weekly_volume?: number;
  readonly daily_volume?: number;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

/** Account-wide position evidence. Both subscription snapshots and updates are full market maps. */
export interface LighterAccountAllPositionsStreamMessage {
  readonly type: "subscribed/account_all_positions" | "update/account_all_positions";
  readonly channel: string;
  readonly positions: Readonly<Record<string, LighterAccountPosition>>;
  readonly shares: readonly Record<string, unknown>[];
  readonly last_funding_round?: Readonly<Record<string, string>>;
  readonly last_funding_discount?: Readonly<Record<string, string>>;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

export type LighterAccountStreamMessage =
  | LighterAccountAllOrdersStreamMessage
  | LighterAccountAllTradesStreamMessage
  | LighterAccountAllPositionsStreamMessage;

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

export interface LighterAccountQuery {
  by: "index" | "l1_address";
  value: number | string;
  activeOnly?: boolean;
}

export interface LighterAccountsByL1AddressParams {
  l1Address: string;
  cursor?: string;
}

export interface LighterTxFromL1Params {
  hash: string;
}

export interface LighterTxQuery {
  by: "hash" | "sequence_index";
  value: string;
}

export type LighterWithdrawHistoryFilter = "all" | "pending" | "claimable";

export interface LighterWithdrawHistoryParams {
  accountIndex: number;
  cursor?: string;
  filter?: LighterWithdrawHistoryFilter;
}

export interface LighterReadOnlyTokensParams {
  accountIndex: number;
}

export interface LighterApiKeysParams {
  accountIndex: number;
  apiKeyIndex?: number;
}

export interface LighterNextNonceParams {
  accountIndex: number;
  apiKeyIndex: number;
}

export interface LighterAccountTradesParams {
  accountIndex?: number;
  limit?: number;
  sortBy?: "timestamp";
}

export interface LighterAccountActiveOrdersParams {
  accountIndex?: number;
  marketId?: number;
  marketType?: LighterMarketFilter;
}

export interface LighterAccountInactiveOrdersParams extends LighterAccountActiveOrdersParams {
  limit?: number;
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
