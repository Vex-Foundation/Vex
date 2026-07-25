/**
 * Jupiter Prediction API — base types: constants re-export, union types, params, pagination.
 */

import {
  JUPITER_PREDICTION_API_BASE_URL,
  JUPITER_PREDICTION_USDC_MINT,
} from "../../constants.js";

export {
  JUPITER_PREDICTION_API_BASE_URL,
  JUPITER_PREDICTION_USDC_MINT,
};

export type JupiterPredictionProvider = "kalshi" | "polymarket" | "bisonfi";
export type JupiterPredictionCategory =
  | "all"
  | "crypto"
  | "sports"
  | "politics"
  | "esports"
  | "culture"
  | "economics"
  | "tech";
export type JupiterPredictionFilter = "new" | "live" | "trending" | "upcoming";
export type JupiterPredictionSortBy = "volume" | "beginAt";
export type JupiterPredictionSortDirection = "asc" | "desc";
export type JupiterPredictionMarketStatus = "open" | "closed" | "cancelled" | (string & {});
export type JupiterPredictionLeaderboardPeriod = "all_time" | "weekly" | "monthly";
export type JupiterPredictionLeaderboardMetric = "pnl" | "volume" | "win_rate";
export type JupiterPredictionPnlInterval = "24h" | "1w" | "1m";

export interface JupiterPredictionEventsParams {
  provider?: JupiterPredictionProvider;
  includeMarkets?: boolean;
  /**
   * Include every allowed sports market type (moneyline/spread/totals) plus
   * extra provider markets (e.g. Saba) instead of the default subset. Live
   * default is falsy/omitted (docs: `false`). Multiplies market count per
   * sports event when `true` — see `JupiterPredictionUnits.md` for the
   * output-size tradeoff this controls.
   */
  includeAllMarkets?: boolean;
  start?: number;
  end?: number;
  category?: JupiterPredictionCategory;
  subcategory?: string | string[];
  /**
   * Free-text tag filter (docs example: `soccer`). Single tag per the
   * documented examples; multi-tag encoding is unconfirmed, so only a single
   * string is modeled here.
   */
  tags?: string;
  sortBy?: JupiterPredictionSortBy;
  sortDirection?: JupiterPredictionSortDirection;
  filter?: JupiterPredictionFilter;
}

export interface JupiterPredictionSearchEventsParams {
  provider?: JupiterPredictionProvider;
  query: string;
  limit?: number;
}

export interface JupiterPredictionGetEventParams {
  eventId: string;
  includeMarkets?: boolean;
  /** See `JupiterPredictionEventsParams.includeAllMarkets`. */
  includeAllMarkets?: boolean;
}

export interface JupiterPredictionSuggestedEventsParams {
  pubkey: string;
  provider?: JupiterPredictionProvider;
}

export interface JupiterPredictionEventMarketsParams {
  eventId: string;
  start?: number;
  end?: number;
}

export interface JupiterPredictionEventMarketParams {
  eventId: string;
  marketId: string;
}

export interface JupiterPredictionMarketParams {
  marketId: string;
}

export interface JupiterPredictionOrdersParams {
  start?: number;
  end?: number;
  ownerPubkey?: string;
}

export interface JupiterPredictionOrderParams {
  orderPubkey: string;
}

export interface JupiterPredictionPositionsParams {
  start?: number;
  end?: number;
  ownerPubkey?: string;
  marketPubkey?: string;
  marketId?: string;
  isYes?: boolean;
}

export interface JupiterPredictionPositionParams {
  positionPubkey: string;
}

export interface JupiterPredictionHistoryParams {
  start?: number;
  end?: number;
  ownerPubkey?: string;
  id?: number;
  positionPubkey?: string;
}

export interface JupiterPredictionProfileParams {
  ownerPubkey: string;
}

export interface JupiterPredictionPnlHistoryParams {
  ownerPubkey: string;
  interval?: JupiterPredictionPnlInterval;
  count?: number;
}

export interface JupiterPredictionLeaderboardsParams {
  period?: JupiterPredictionLeaderboardPeriod;
  limit?: number;
  metric?: JupiterPredictionLeaderboardMetric;
}

export interface JupiterPredictionCreateOrderRequest {
  ownerPubkey: string;
  marketId?: string;
  positionPubkey?: string;
  isYes?: boolean;
  isBuy: boolean;
  contracts?: string | number;
  depositAmount?: string | number;
  depositMint?: string;
}

export interface JupiterPredictionClosePositionRequest {
  ownerPubkey: string;
}

export interface JupiterPredictionCloseAllPositionsRequest {
  ownerPubkey: string;
  /**
   * Slippage tolerance applied to each sell, in basis points. REQUIRED by
   * the provider (OpenAPI spec: `required`, `type: number`, no documented
   * min/max) — no Vex-side default; the caller must pick a value. Vex
   * enforces a 0-10,000 bps (0-100%) product-safety bound at the request
   * validator (see `validation/body.ts`), matching this domain's own
   * order-level `slippageBps`/`maxSlippageBps` convention (0 = none, 250 =
   * 2.5%) since the spec itself does not bound this field.
   */
  minSellPriceSlippageBps: number;
}

export interface JupiterPredictionClaimPositionRequest {
  ownerPubkey: string;
}

/**
 * `POST /execute` — managed execution for a Jupiter Forecast (bisonfi)
 * order: submit the already-signed transaction plus the `execution.context`
 * object from the order build, unchanged. Used ONLY when the order build's
 * `executionModel` is `"atomic_swap"` (see `JupiterPredictionCreateOrderResponse`);
 * EVERY prediction build carrying an `execution` object calls this —
 * keeper-filled (kalshi/polymarket) AND Forecast (bisonfi). Corrected
 * 2026-07-25: keeper-filled orders were wrongly believed never to.
 */
export interface JupiterPredictionExecuteRequest {
  signedTransaction: string;
  context?: Record<string, unknown>;
  requestId?: string;
}

export interface JupiterPredictionPagination {
  start: number;
  end: number;
  total: number;
  hasNext: boolean;
}
