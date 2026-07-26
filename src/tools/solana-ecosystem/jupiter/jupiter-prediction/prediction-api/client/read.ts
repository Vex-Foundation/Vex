/**
 * Jupiter Prediction API — GET endpoints (read operations).
 */

import { fetchJson } from "../../../../../../utils/http.js";
import { JUPITER_PREDICTION_API_BASE_URL } from "../../constants.js";
import type {
  JupiterPredictionEventsParams,
  JupiterPredictionEventsResponse,
  JupiterPredictionSearchEventsParams,
  JupiterPredictionSearchEventsResponse,
  JupiterPredictionGetEventParams,
  JupiterPredictionSuggestedEventsParams,
  JupiterPredictionSuggestedEventsResponse,
  JupiterPredictionEventMarketsParams,
  JupiterPredictionEventMarketsResponse,
  JupiterPredictionEventMarketParams,
  JupiterPredictionEventMarketResponse,
  JupiterPredictionMarketParams,
  JupiterPredictionMarketResponse,
  JupiterPredictionOrderbookResponse,
  JupiterPredictionTradingStatusResponse,
  JupiterPredictionOrdersParams,
  JupiterPredictionOrdersResponse,
  JupiterPredictionOrderParams,
  JupiterPredictionOrderResponse,
  JupiterPredictionOrderStatusResponse,
  JupiterPredictionPositionsParams,
  JupiterPredictionPositionsResponse,
  JupiterPredictionPositionParams,
  JupiterPredictionPositionResponse,
  JupiterPredictionHistoryParams,
  JupiterPredictionHistoryResponse,
  JupiterPredictionProfileParams,
  JupiterPredictionProfileResponse,
  JupiterPredictionPnlHistoryParams,
  JupiterPredictionPnlHistoryResponse,
  JupiterPredictionTradesResponse,
  JupiterPredictionLeaderboardsParams,
  JupiterPredictionLeaderboardsResponse,
  JupiterPredictionVaultInfoResponse,
} from "../types.js";
import {
  getJupiterPredictionHeaders,
  requireJupiterPredictionApiKey,
  validateJupiterPredictionEventsParams,
  validateJupiterPredictionSearchEventsParams,
  validateJupiterPredictionGetEventParams,
  validateJupiterPredictionSuggestedEventsParams,
  validateJupiterPredictionEventMarketsParams,
  validateJupiterPredictionEventMarketParams,
  validateJupiterPredictionMarketParams,
  validateJupiterPredictionOrdersParams,
  validateJupiterPredictionOrderParams,
  validateJupiterPredictionPositionsParams,
  validateJupiterPredictionPositionParams,
  validateJupiterPredictionHistoryParams,
  validateJupiterPredictionProfileParams,
  validateJupiterPredictionPnlHistoryParams,
  validateJupiterPredictionLeaderboardsParams,
} from "../validation.js";
import {
  jupiterPredictionEventSchema,
  jupiterPredictionEventsResponseSchema,
  jupiterPredictionSearchEventsResponseSchema,
  jupiterPredictionSuggestedEventsResponseSchema,
  jupiterPredictionEventMarketsResponseSchema,
  jupiterPredictionMarketResponseSchema,
  jupiterPredictionOrderbookResponseSchema,
  jupiterPredictionTradingStatusResponseSchema,
  jupiterPredictionOrdersResponseSchema,
  jupiterPredictionOrderResponseSchema,
  jupiterPredictionOrderStatusResponseSchema,
  jupiterPredictionPositionsResponseSchema,
  jupiterPredictionPositionResponseSchema,
  jupiterPredictionHistoryResponseSchema,
  jupiterPredictionProfileResponseSchema,
  jupiterPredictionPnlHistoryResponseSchema,
  jupiterPredictionTradesResponseSchema,
  jupiterPredictionLeaderboardsResponseSchema,
  jupiterPredictionVaultInfoResponseSchema,
} from "../schemas.js";
import { withQuery } from "./url.js";

// ── Events ─────────────────────────────────────────────────────────

export async function jupiterPredictionEvents(
  params: JupiterPredictionEventsParams = {},
): Promise<JupiterPredictionEventsResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionEventsParams(params);

  return fetchJson<JupiterPredictionEventsResponse>(
    withQuery("/events", {
      provider: validated.provider,
      includeMarkets: validated.includeMarkets != null ? String(validated.includeMarkets) : undefined,
      includeAllMarkets: validated.includeAllMarkets != null ? String(validated.includeAllMarkets) : undefined,
      start: validated.start != null ? String(validated.start) : undefined,
      end: validated.end != null ? String(validated.end) : undefined,
      category: validated.category,
      subcategory: typeof validated.subcategory === "string" ? validated.subcategory : undefined,
      tags: validated.tags,
      sortBy: validated.sortBy,
      sortDirection: validated.sortDirection,
      filter: validated.filter,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionEventsResponseSchema,
  );
}

export async function jupiterPredictionSearchEvents(
  params: JupiterPredictionSearchEventsParams,
): Promise<JupiterPredictionSearchEventsResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionSearchEventsParams(params);

  return fetchJson<JupiterPredictionSearchEventsResponse>(
    withQuery("/events/search", {
      provider: validated.provider,
      query: validated.query,
      limit: validated.limit != null ? String(validated.limit) : undefined,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionSearchEventsResponseSchema,
  );
}

export async function jupiterPredictionEvent(
  params: JupiterPredictionGetEventParams,
): Promise<JupiterPredictionEventsResponse["data"][number]> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionGetEventParams(params);

  return fetchJson<JupiterPredictionEventsResponse["data"][number]>(
    withQuery(`/events/${validated.eventId}`, {
      includeMarkets: validated.includeMarkets != null ? String(validated.includeMarkets) : undefined,
      includeAllMarkets: validated.includeAllMarkets != null ? String(validated.includeAllMarkets) : undefined,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionEventSchema,
  );
}

export async function jupiterPredictionSuggestedEvents(
  params: JupiterPredictionSuggestedEventsParams,
): Promise<JupiterPredictionSuggestedEventsResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionSuggestedEventsParams(params);

  // LIVE-GATE FIX 1 (2026-07-24): confirmed live that `pubkey` is a QUERY
  // param on the base `/events/suggested` route, not a path segment — the
  // documented `/events/suggested/{pubkey}` path 404s (gateway-level, route
  // not registered) for every pubkey tried, while `/events/suggested?pubkey=
  // ...` returns 200 with real data.
  return fetchJson<JupiterPredictionSuggestedEventsResponse>(
    withQuery("/events/suggested", {
      pubkey: validated.pubkey,
      provider: validated.provider,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionSuggestedEventsResponseSchema,
  );
}

// ── Markets ────────────────────────────────────────────────────────

export async function jupiterPredictionEventMarkets(
  params: JupiterPredictionEventMarketsParams,
): Promise<JupiterPredictionEventMarketsResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionEventMarketsParams(params);

  return fetchJson<JupiterPredictionEventMarketsResponse>(
    withQuery(`/events/${validated.eventId}/markets`, {
      start: validated.start != null ? String(validated.start) : undefined,
      end: validated.end != null ? String(validated.end) : undefined,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionEventMarketsResponseSchema,
  );
}

export async function jupiterPredictionEventMarket(
  params: JupiterPredictionEventMarketParams,
): Promise<JupiterPredictionEventMarketResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionEventMarketParams(params);

  return fetchJson<JupiterPredictionEventMarketResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/events/${validated.eventId}/markets/${validated.marketId}`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionMarketResponseSchema,
  );
}

export async function jupiterPredictionMarket(
  params: JupiterPredictionMarketParams,
): Promise<JupiterPredictionMarketResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionMarketParams(params);

  return fetchJson<JupiterPredictionMarketResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/markets/${validated.marketId}`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionMarketResponseSchema,
  );
}

export async function jupiterPredictionOrderbook(
  params: JupiterPredictionMarketParams,
): Promise<JupiterPredictionOrderbookResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionMarketParams(params);

  return fetchJson<JupiterPredictionOrderbookResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/orderbook/${validated.marketId}`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionOrderbookResponseSchema,
  );
}

export async function jupiterPredictionTradingStatus(): Promise<JupiterPredictionTradingStatusResponse> {
  requireJupiterPredictionApiKey();

  return fetchJson<JupiterPredictionTradingStatusResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/trading-status`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionTradingStatusResponseSchema,
  );
}

// ── Orders ─────────────────────────────────────────────────────────

export async function jupiterPredictionOrders(
  params: JupiterPredictionOrdersParams = {},
): Promise<JupiterPredictionOrdersResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionOrdersParams(params);

  return fetchJson<JupiterPredictionOrdersResponse>(
    withQuery("/orders", {
      start: validated.start != null ? String(validated.start) : undefined,
      end: validated.end != null ? String(validated.end) : undefined,
      ownerPubkey: validated.ownerPubkey,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionOrdersResponseSchema,
  );
}

export async function jupiterPredictionOrder(
  params: JupiterPredictionOrderParams,
): Promise<JupiterPredictionOrderResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionOrderParams(params);

  return fetchJson<JupiterPredictionOrderResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/orders/${validated.orderPubkey}`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionOrderResponseSchema,
  );
}

export async function jupiterPredictionOrderStatus(
  params: JupiterPredictionOrderParams,
): Promise<JupiterPredictionOrderStatusResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionOrderParams(params);

  return fetchJson<JupiterPredictionOrderStatusResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/orders/status/${validated.orderPubkey}`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionOrderStatusResponseSchema,
  );
}

// ── Positions ──────────────────────────────────────────────────────

export async function jupiterPredictionPositions(
  params: JupiterPredictionPositionsParams = {},
): Promise<JupiterPredictionPositionsResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionPositionsParams(params);

  return fetchJson<JupiterPredictionPositionsResponse>(
    withQuery("/positions", {
      start: validated.start != null ? String(validated.start) : undefined,
      end: validated.end != null ? String(validated.end) : undefined,
      ownerPubkey: validated.ownerPubkey,
      marketPubkey: validated.marketPubkey,
      marketId: validated.marketId,
      isYes: validated.isYes != null ? String(validated.isYes) : undefined,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionPositionsResponseSchema,
  );
}

export async function jupiterPredictionPosition(
  params: JupiterPredictionPositionParams,
): Promise<JupiterPredictionPositionResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionPositionParams(params);

  return fetchJson<JupiterPredictionPositionResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/positions/${validated.positionPubkey}`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionPositionResponseSchema,
  );
}

// ── History / Profile / PnL ────────────────────────────────────────

export async function jupiterPredictionHistory(
  params: JupiterPredictionHistoryParams = {},
): Promise<JupiterPredictionHistoryResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionHistoryParams(params);

  return fetchJson<JupiterPredictionHistoryResponse>(
    withQuery("/history", {
      start: validated.start != null ? String(validated.start) : undefined,
      end: validated.end != null ? String(validated.end) : undefined,
      ownerPubkey: validated.ownerPubkey,
      id: validated.id != null ? String(validated.id) : undefined,
      positionPubkey: validated.positionPubkey,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionHistoryResponseSchema,
  );
}

export async function jupiterPredictionProfile(
  params: JupiterPredictionProfileParams,
): Promise<JupiterPredictionProfileResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionProfileParams(params);

  return fetchJson<JupiterPredictionProfileResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/profiles/${validated.ownerPubkey}`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionProfileResponseSchema,
  );
}

export async function jupiterPredictionPnlHistory(
  params: JupiterPredictionPnlHistoryParams,
): Promise<JupiterPredictionPnlHistoryResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionPnlHistoryParams(params);

  return fetchJson<JupiterPredictionPnlHistoryResponse>(
    withQuery(`/profiles/${validated.ownerPubkey}/pnl-history`, {
      interval: validated.interval,
      count: validated.count != null ? String(validated.count) : undefined,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionPnlHistoryResponseSchema,
  );
}

// ── Misc ─���─────────────────────────────────────────────────────────

export async function jupiterPredictionTrades(): Promise<JupiterPredictionTradesResponse> {
  requireJupiterPredictionApiKey();

  return fetchJson<JupiterPredictionTradesResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/trades`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionTradesResponseSchema,
  );
}

export async function jupiterPredictionLeaderboards(
  params: JupiterPredictionLeaderboardsParams = {},
): Promise<JupiterPredictionLeaderboardsResponse> {
  requireJupiterPredictionApiKey();
  const validated = validateJupiterPredictionLeaderboardsParams(params);

  return fetchJson<JupiterPredictionLeaderboardsResponse>(
    withQuery("/leaderboards", {
      period: validated.period,
      limit: validated.limit != null ? String(validated.limit) : undefined,
      metric: validated.metric,
    }),
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionLeaderboardsResponseSchema,
  );
}

export async function jupiterPredictionVaultInfo(): Promise<JupiterPredictionVaultInfoResponse> {
  requireJupiterPredictionApiKey();

  return fetchJson<JupiterPredictionVaultInfoResponse>(
    `${JUPITER_PREDICTION_API_BASE_URL}/vault-info`,
    { headers: getJupiterPredictionHeaders() },
    jupiterPredictionVaultInfoResponseSchema,
  );
}
