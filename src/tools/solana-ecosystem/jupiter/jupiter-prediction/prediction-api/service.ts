/**
 * High-level Jupiter Prediction service.
 *
 * Preserves full wire responses. The `request*Transaction` functions return
 * the provider's UNSIGNED transaction (+ order/position preview fields)
 * without signing or broadcasting — W5 (migration 049) moved sign/persist/
 * submit orchestration to the staged `agent_activity` write path
 * (`vex-agent/tools/protocols/solana-jupiter/predict-execute.ts`, built on
 * the K2 primitives: `prepareVersionedTx` + `markActivitySolanaBroadcast` +
 * `submitPreparedTx`). The OLD monolithic sign-and-send wrappers
 * (`executeJupiterPredictionCreateOrder`/`ClosePosition`/`CloseAllPositions`/
 * `ClaimPosition`) were removed — they persisted nothing before broadcasting,
 * which the W5 recording-before-broadcast doctrine forbids for a Vex-signed
 * mutation.
 */

import { VexError, ErrorCodes } from "../../../../../errors.js";
import {
  jupiterPredictionClaimPosition,
  jupiterPredictionCloseAllPositions,
  jupiterPredictionClosePosition,
  jupiterPredictionCreateOrder,
  jupiterPredictionEvent,
  jupiterPredictionEventMarket,
  jupiterPredictionEventMarkets,
  jupiterPredictionEvents,
  jupiterPredictionHistory,
  jupiterPredictionLeaderboards,
  jupiterPredictionMarket,
  jupiterPredictionOrder,
  jupiterPredictionOrderbook,
  jupiterPredictionOrders,
  jupiterPredictionOrderStatus,
  jupiterPredictionPnlHistory,
  jupiterPredictionPosition,
  jupiterPredictionPositions,
  jupiterPredictionProfile,
  jupiterPredictionSearchEvents,
  jupiterPredictionSuggestedEvents,
  jupiterPredictionTrades,
  jupiterPredictionTradingStatus,
  jupiterPredictionVaultInfo,
} from "./client.js";
import type {
  JupiterPredictionClaimPositionResponse,
  JupiterPredictionCloseAllPositionsResponse,
  JupiterPredictionCloseAllPositionsRequest,
  JupiterPredictionClaimPositionRequest,
  JupiterPredictionClosePositionRequest,
  JupiterPredictionCreateOrderRequest,
  JupiterPredictionCreateOrderResponse,
  JupiterPredictionEventMarketResponse,
  JupiterPredictionEventMarketsParams,
  JupiterPredictionEventMarketsResponse,
  JupiterPredictionEventsParams,
  JupiterPredictionEventsResponse,
  JupiterPredictionGetEventParams,
  JupiterPredictionHistoryParams,
  JupiterPredictionHistoryResponse,
  JupiterPredictionLeaderboardsParams,
  JupiterPredictionLeaderboardsResponse,
  JupiterPredictionMarketResponse,
  JupiterPredictionOrderbookResponse,
  JupiterPredictionOrderResponse,
  JupiterPredictionOrdersParams,
  JupiterPredictionOrdersResponse,
  JupiterPredictionOrderStatusResponse,
  JupiterPredictionPnlHistoryParams,
  JupiterPredictionPnlHistoryResponse,
  JupiterPredictionPositionResponse,
  JupiterPredictionPositionsParams,
  JupiterPredictionPositionsResponse,
  JupiterPredictionProfileResponse,
  JupiterPredictionSearchEventsParams,
  JupiterPredictionSearchEventsResponse,
  JupiterPredictionSuggestedEventsParams,
  JupiterPredictionSuggestedEventsResponse,
  JupiterPredictionTradesResponse,
  JupiterPredictionTradingStatusResponse,
  JupiterPredictionVaultInfoResponse,
} from "./types.js";

/**
 * Fail-closed accessor for a provider response's `transaction` field — used
 * by every W5 mutation caller (`predict-execute.ts`) BEFORE any
 * `agent_activity` row is created, so a missing/empty transaction is a
 * PRE-broadcast failure (nothing was ever recorded), never a null passed
 * silently into `prepareVersionedTx`.
 */
export function requireTransaction(
  transaction: string | null | undefined,
  feature: string,
): string {
  if (!transaction) {
    throw new VexError(
      ErrorCodes.HTTP_REQUEST_FAILED,
      `${feature} did not return an executable transaction.`,
    );
  }
  return transaction;
}

// Managed-execution routing (`resolveManagedExecution`) lives in the sibling
// `./managed-execution.js` — it owns the endpoint allowlist and the
// `requiredSigners`/blockhash-evidence validation, a distinct reason to change
// from this file's request/response plumbing. It REPLACED
// `resolveForecastExecutionContext`, whose `executionModel === "atomic_swap"`
// gate was proven wrong against the live API on 2026-07-25 (see that module).
export {
  resolveManagedExecution,
  type JupiterPredictionManagedExecution,
} from "./managed-execution.js";

export async function getJupiterPredictionEvents(
  params: JupiterPredictionEventsParams = {},
): Promise<JupiterPredictionEventsResponse> {
  return jupiterPredictionEvents(params);
}

export async function searchJupiterPredictionEvents(
  params: JupiterPredictionSearchEventsParams,
): Promise<JupiterPredictionSearchEventsResponse> {
  return jupiterPredictionSearchEvents(params);
}

export async function getJupiterPredictionEvent(
  params: JupiterPredictionGetEventParams,
): Promise<JupiterPredictionEventsResponse["data"][number]> {
  return jupiterPredictionEvent(params);
}

export async function getJupiterPredictionSuggestedEvents(
  params: JupiterPredictionSuggestedEventsParams,
): Promise<JupiterPredictionSuggestedEventsResponse> {
  return jupiterPredictionSuggestedEvents(params);
}

export async function getJupiterPredictionEventMarkets(
  eventId: string,
  params: Pick<JupiterPredictionEventMarketsParams, "start" | "end"> = {},
): Promise<JupiterPredictionEventMarketsResponse> {
  return jupiterPredictionEventMarkets({ eventId, ...params });
}

export async function getJupiterPredictionEventMarket(
  eventId: string,
  marketId: string,
): Promise<JupiterPredictionEventMarketResponse> {
  return jupiterPredictionEventMarket({ eventId, marketId });
}

export async function getJupiterPredictionMarket(
  marketId: string,
): Promise<JupiterPredictionMarketResponse> {
  return jupiterPredictionMarket({ marketId });
}

export async function getJupiterPredictionOrderbook(
  marketId: string,
): Promise<JupiterPredictionOrderbookResponse> {
  return jupiterPredictionOrderbook({ marketId });
}

export async function getJupiterPredictionTradingStatus(): Promise<JupiterPredictionTradingStatusResponse> {
  return jupiterPredictionTradingStatus();
}

export async function getJupiterPredictionOrders(
  params: JupiterPredictionOrdersParams = {},
): Promise<JupiterPredictionOrdersResponse> {
  return jupiterPredictionOrders(params);
}

export async function getJupiterPredictionOrder(
  orderPubkey: string,
): Promise<JupiterPredictionOrderResponse> {
  return jupiterPredictionOrder({ orderPubkey });
}

export async function getJupiterPredictionOrderStatus(
  orderPubkey: string,
): Promise<JupiterPredictionOrderStatusResponse> {
  return jupiterPredictionOrderStatus({ orderPubkey });
}

export async function getJupiterPredictionPositions(
  params: JupiterPredictionPositionsParams = {},
): Promise<JupiterPredictionPositionsResponse> {
  return jupiterPredictionPositions(params);
}

export async function getJupiterPredictionPosition(
  positionPubkey: string,
): Promise<JupiterPredictionPositionResponse> {
  return jupiterPredictionPosition({ positionPubkey });
}

export async function getJupiterPredictionHistory(
  params: JupiterPredictionHistoryParams = {},
): Promise<JupiterPredictionHistoryResponse> {
  return jupiterPredictionHistory(params);
}

export async function getJupiterPredictionProfile(
  ownerPubkey: string,
): Promise<JupiterPredictionProfileResponse> {
  return jupiterPredictionProfile({ ownerPubkey });
}

export async function getJupiterPredictionPnlHistory(
  params: JupiterPredictionPnlHistoryParams,
): Promise<JupiterPredictionPnlHistoryResponse> {
  return jupiterPredictionPnlHistory(params);
}

export async function getJupiterPredictionTrades(): Promise<JupiterPredictionTradesResponse> {
  return jupiterPredictionTrades();
}

export async function getJupiterPredictionLeaderboards(
  params: JupiterPredictionLeaderboardsParams = {},
): Promise<JupiterPredictionLeaderboardsResponse> {
  return jupiterPredictionLeaderboards(params);
}

export async function getJupiterPredictionVaultInfo(): Promise<JupiterPredictionVaultInfoResponse> {
  return jupiterPredictionVaultInfo();
}

export async function requestJupiterPredictionCreateOrderTransaction(
  request: JupiterPredictionCreateOrderRequest,
): Promise<JupiterPredictionCreateOrderResponse> {
  return jupiterPredictionCreateOrder(request);
}

export async function requestJupiterPredictionClosePositionTransaction(
  positionPubkey: string,
  request: JupiterPredictionClosePositionRequest,
): Promise<JupiterPredictionCreateOrderResponse> {
  return jupiterPredictionClosePosition(positionPubkey, request);
}

export async function requestJupiterPredictionCloseAllPositionsTransactions(
  request: JupiterPredictionCloseAllPositionsRequest,
): Promise<JupiterPredictionCloseAllPositionsResponse> {
  return jupiterPredictionCloseAllPositions(request);
}

export async function requestJupiterPredictionClaimPositionTransaction(
  positionPubkey: string,
  request: JupiterPredictionClaimPositionRequest,
): Promise<JupiterPredictionClaimPositionResponse> {
  return jupiterPredictionClaimPosition(positionPubkey, request);
}
