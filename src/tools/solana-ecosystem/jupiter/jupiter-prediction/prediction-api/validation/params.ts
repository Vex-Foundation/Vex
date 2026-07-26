/**
 * Parameter validators for Jupiter Prediction API endpoints.
 */

import { validateSolanaAddress } from "../../../../shared/solana-validation.js";
import type {
  JupiterPredictionEventsParams,
  JupiterPredictionSearchEventsParams,
  JupiterPredictionGetEventParams,
  JupiterPredictionSuggestedEventsParams,
  JupiterPredictionEventMarketsParams,
  JupiterPredictionEventMarketParams,
  JupiterPredictionMarketParams,
  JupiterPredictionOrdersParams,
  JupiterPredictionOrderParams,
  JupiterPredictionPositionsParams,
  JupiterPredictionPositionParams,
  JupiterPredictionHistoryParams,
  JupiterPredictionProfileParams,
  JupiterPredictionPnlHistoryParams,
  JupiterPredictionLeaderboardsParams,
} from "../types.js";
import {
  assertNonEmptyString,
  assertIntegerInRange,
  assertEnumValue,
  normalizeOptionalCsv,
  normalizePaginationRange,
  normalizeOptionalPubkey,
  normalizeOptionalNonEmptyString,
  PREDICTION_PROVIDERS,
  PREDICTION_CATEGORIES,
  PREDICTION_FILTERS,
  PREDICTION_SORT_BY,
  PREDICTION_SORT_DIRECTIONS,
  PREDICTION_PNL_INTERVALS,
  PREDICTION_LEADERBOARD_PERIODS,
  PREDICTION_LEADERBOARD_METRICS,
} from "./helpers.js";
import { VexError, ErrorCodes } from "../../../../../../errors.js";

export function validateJupiterPredictionEventsParams(
  params: JupiterPredictionEventsParams = {},
): JupiterPredictionEventsParams {
  normalizePaginationRange(params.start, params.end);

  return {
    provider: params.provider
      ? assertEnumValue("provider", params.provider, PREDICTION_PROVIDERS)
      : undefined,
    includeMarkets: params.includeMarkets,
    includeAllMarkets: params.includeAllMarkets,
    start: params.start,
    end: params.end,
    category: params.category
      ? assertEnumValue("category", params.category, PREDICTION_CATEGORIES)
      : undefined,
    subcategory: normalizeOptionalCsv(params.subcategory),
    tags: normalizeOptionalNonEmptyString(params.tags),
    sortBy: params.sortBy
      ? assertEnumValue("sortBy", params.sortBy, PREDICTION_SORT_BY)
      : undefined,
    sortDirection: params.sortDirection
      ? assertEnumValue("sortDirection", params.sortDirection, PREDICTION_SORT_DIRECTIONS)
      : undefined,
    filter: params.filter
      ? assertEnumValue("filter", params.filter, PREDICTION_FILTERS)
      : undefined,
  };
}

export function validateJupiterPredictionSearchEventsParams(
  params: JupiterPredictionSearchEventsParams,
): JupiterPredictionSearchEventsParams {
  const query = assertNonEmptyString("query", params.query);
  if (query.length > 200) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `Invalid query length: ${query.length}`,
      "query must be between 1 and 200 characters.",
    );
  }
  if (params.limit != null) assertIntegerInRange("limit", params.limit, 1, 20);

  return {
    provider: params.provider
      ? assertEnumValue("provider", params.provider, PREDICTION_PROVIDERS)
      : undefined,
    query,
    limit: params.limit,
  };
}

export function validateJupiterPredictionGetEventParams(
  params: JupiterPredictionGetEventParams,
): JupiterPredictionGetEventParams {
  return {
    eventId: assertNonEmptyString("eventId", params.eventId),
    includeMarkets: params.includeMarkets,
    includeAllMarkets: params.includeAllMarkets,
  };
}

export function validateJupiterPredictionSuggestedEventsParams(
  params: JupiterPredictionSuggestedEventsParams,
): JupiterPredictionSuggestedEventsParams {
  return {
    pubkey: validateSolanaAddress(params.pubkey),
    provider: params.provider
      ? assertEnumValue("provider", params.provider, PREDICTION_PROVIDERS)
      : undefined,
  };
}

export function validateJupiterPredictionEventMarketsParams(
  params: JupiterPredictionEventMarketsParams,
): JupiterPredictionEventMarketsParams {
  normalizePaginationRange(params.start, params.end);
  return {
    eventId: assertNonEmptyString("eventId", params.eventId),
    start: params.start,
    end: params.end,
  };
}

export function validateJupiterPredictionEventMarketParams(
  params: JupiterPredictionEventMarketParams,
): JupiterPredictionEventMarketParams {
  return {
    eventId: assertNonEmptyString("eventId", params.eventId),
    marketId: assertNonEmptyString("marketId", params.marketId),
  };
}

export function validateJupiterPredictionMarketParams(
  params: JupiterPredictionMarketParams,
): JupiterPredictionMarketParams {
  return {
    marketId: assertNonEmptyString("marketId", params.marketId),
  };
}

export function validateJupiterPredictionOrdersParams(
  params: JupiterPredictionOrdersParams = {},
): JupiterPredictionOrdersParams {
  normalizePaginationRange(params.start, params.end);
  return {
    start: params.start,
    end: params.end,
    ownerPubkey: normalizeOptionalPubkey(params.ownerPubkey),
  };
}

export function validateJupiterPredictionOrderParams(
  params: JupiterPredictionOrderParams,
): JupiterPredictionOrderParams {
  return {
    orderPubkey: validateSolanaAddress(params.orderPubkey),
  };
}

export function validateJupiterPredictionPositionsParams(
  params: JupiterPredictionPositionsParams = {},
): JupiterPredictionPositionsParams {
  normalizePaginationRange(params.start, params.end);
  return {
    start: params.start,
    end: params.end,
    ownerPubkey: normalizeOptionalPubkey(params.ownerPubkey),
    marketPubkey: normalizeOptionalPubkey(params.marketPubkey),
    marketId: normalizeOptionalNonEmptyString(params.marketId),
    isYes: params.isYes,
  };
}

export function validateJupiterPredictionPositionParams(
  params: JupiterPredictionPositionParams,
): JupiterPredictionPositionParams {
  return {
    positionPubkey: validateSolanaAddress(params.positionPubkey),
  };
}

export function validateJupiterPredictionHistoryParams(
  params: JupiterPredictionHistoryParams = {},
): JupiterPredictionHistoryParams {
  normalizePaginationRange(params.start, params.end);
  if (params.id != null) assertIntegerInRange("id", params.id, 1);
  return {
    start: params.start,
    end: params.end,
    ownerPubkey: normalizeOptionalPubkey(params.ownerPubkey),
    id: params.id,
    positionPubkey: normalizeOptionalPubkey(params.positionPubkey),
  };
}

export function validateJupiterPredictionProfileParams(
  params: JupiterPredictionProfileParams,
): JupiterPredictionProfileParams {
  return { ownerPubkey: validateSolanaAddress(params.ownerPubkey) };
}

export function validateJupiterPredictionPnlHistoryParams(
  params: JupiterPredictionPnlHistoryParams,
): JupiterPredictionPnlHistoryParams {
  if (params.count != null) assertIntegerInRange("count", params.count, 1, 1000);
  return {
    ownerPubkey: validateSolanaAddress(params.ownerPubkey),
    interval: params.interval
      ? assertEnumValue("interval", params.interval, PREDICTION_PNL_INTERVALS)
      : undefined,
    count: params.count,
  };
}

export function validateJupiterPredictionLeaderboardsParams(
  params: JupiterPredictionLeaderboardsParams = {},
): JupiterPredictionLeaderboardsParams {
  if (params.limit != null) assertIntegerInRange("limit", params.limit, 1, 100);
  return {
    period: params.period
      ? assertEnumValue("period", params.period, PREDICTION_LEADERBOARD_PERIODS)
      : undefined,
    limit: params.limit,
    metric: params.metric
      ? assertEnumValue("metric", params.metric, PREDICTION_LEADERBOARD_METRICS)
      : undefined,
  };
}
