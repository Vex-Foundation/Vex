/**
 * Lighter public endpoint constants for Core and Robinhood Chain.
 *
 * These are public, non-secret URLs. Do not add credentials or signing material
 * to this module; authenticated/account and trading surfaces are later phases.
 */

export const LIGHTER_ENVIRONMENTS = ["core", "rhc"] as const;
export type LighterEnvironment = (typeof LIGHTER_ENVIRONMENTS)[number];
export const LIGHTER_DEFAULT_ENVIRONMENT: LighterEnvironment = "rhc";

export interface LighterEndpointConfig {
  restBaseUrl: string;
  wsUrl: string;
  readonlyWsUrl: string;
}

export const LIGHTER_ENDPOINTS: Record<LighterEnvironment, LighterEndpointConfig> = {
  core: {
    restBaseUrl: "https://mainnet.zklighter.elliot.ai",
    wsUrl: "wss://mainnet.zklighter.elliot.ai/stream",
    readonlyWsUrl: "wss://mainnet.zklighter.elliot.ai/stream?readonly=true",
  },
  rhc: {
    restBaseUrl: "https://api.rh.lighter.xyz",
    wsUrl: "wss://api.rh.lighter.xyz/stream",
    readonlyWsUrl: "wss://api.rh.lighter.xyz/stream?readonly=true",
  },
} as const;

export const LIGHTER_ENDPOINT_PATHS = {
  status: "/",
  systemConfig: "/api/v1/systemConfig",
  layer1BasicInfo: "/api/v1/layer1BasicInfo",
  assetDetails: "/api/v1/assetDetails",
  accountsByL1Address: "/api/v1/accountsByL1Address",
  txFromL1TxHash: "/api/v1/txFromL1TxHash",
  account: "/api/v1/account",
  accountActiveOrders: "/api/v1/accountActiveOrders",
  accountInactiveOrders: "/api/v1/accountInactiveOrders",
  apiKeys: "/api/v1/apikeys",
  nextNonce: "/api/v1/nextNonce",
  tokens: "/api/v1/tokens",
  orderBooks: "/api/v1/orderBooks",
  orderBookDetails: "/api/v1/orderBookDetails",
  orderBookOrders: "/api/v1/orderBookOrders",
  recentTrades: "/api/v1/recentTrades",
  trades: "/api/v1/trades",
  candles: "/api/v1/candles",
  sendTx: "/api/v1/sendTx",
} as const;

export const LIGHTER_MARKET_FILTERS = ["all", "spot", "perp"] as const;
export type LighterMarketFilter = (typeof LIGHTER_MARKET_FILTERS)[number];

export const LIGHTER_CANDLE_RESOLUTIONS = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "12h",
  "1d",
  "1w",
] as const;
export type LighterCandleResolution = (typeof LIGHTER_CANDLE_RESOLUTIONS)[number];

export const LIGHTER_CANDLE_RESOLUTION_MS: Record<LighterCandleResolution, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export const LIGHTER_ORDER_BOOK_LIMIT_MIN = 1;
export const LIGHTER_ORDER_BOOK_LIMIT_MAX = 250;
export const LIGHTER_RECENT_TRADES_LIMIT_MIN = 1;
export const LIGHTER_RECENT_TRADES_LIMIT_MAX = 100;
export const LIGHTER_CANDLES_COUNT_MIN = 1;
export const LIGHTER_CANDLES_COUNT_MAX = 500;
export const LIGHTER_API_KEY_INDEX_MIN = 0;
export const LIGHTER_API_KEY_INDEX_ALL = 255;
export const LIGHTER_API_KEY_INDEX_MAX = LIGHTER_API_KEY_INDEX_ALL;
/** Reject seconds-scale Unix timestamps; Lighter candle calls use epoch milliseconds. */
export const LIGHTER_TIMESTAMP_MIN = 1_000_000_000_000;
export const LIGHTER_TIMESTAMP_MAX = 5_000_000_000_000;

/**
 * Conservative local freshness for market reads. The low-level client caches
 * duplicate requests briefly so repeated agent planning does not burn provider
 * rate budget for identical bytes.
 */
export const LIGHTER_CACHE_TTL_MS = 5_000;

/** Standard public REST allowance. Premium/account-specific buckets are out of scope for P1. */
export const LIGHTER_PUBLIC_REST_RATE_PER_MINUTE = 60;
