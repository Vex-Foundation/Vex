/**
 * Per-market detail reads:
 *   GET /v1/sdk/{chainId}/markets/{market}/tokens           → accepted token sets
 *   GET /v1/sdk/{chainId}/markets/{market}/swapping-prices  → live PT/YT rates
 *   GET /v3/{chainId}/markets/{market}/historical-data      → APY/TVL/price series
 *
 * All three describe ONE market, which is why they share a module: they change
 * together when Pendle changes what a market read returns.
 *
 * The token sets are validated STRICTLY as address lists even though nothing
 * consumes them yet. Their whole purpose is to be compared against a `tokenIn`
 * or `tokenOut` before a convert request, and a comparison against a
 * half-validated list is worse than no comparison at all.
 */

import { pendleInvalidResponse } from "../../errors.js";
import type {
  PendleReadHistoryField,
  PendleReadMarketHistory,
  PendleReadMarketHistoryPoint,
  PendleReadMarketTokens,
  PendleReadSwappingPrices,
} from "../types.js";
import {
  isRecord,
  readDisplayNumber,
  readDisplayString,
  requireAddress,
  requireAddressList,
  requireFiniteNumber,
} from "./_shared.js";

const TOKENS_ENDPOINT = "market tokens";
const PRICES_ENDPOINT = "market swapping-prices";
const HISTORY_ENDPOINT = "market historical-data";

const TOKEN_LIST_KEYS = ["tokensMintSy", "tokensRedeemSy", "tokensIn", "tokensOut"] as const;

/**
 * `GET /v1/sdk/{chainId}/markets/{market}/tokens` → the four token sets.
 *
 * Every documented list must be present and must contain ONLY well-formed
 * addresses; anything else RAISES. An empty list is accepted — a market can
 * legitimately accept nothing on a leg — but a list with an unreadable entry is
 * not, because a caller filtering against it would silently accept the wrong
 * token. Served for MATURED markets too (live-verified).
 */
export function validatePendleMarketTokens(raw: unknown): PendleReadMarketTokens {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(TOKENS_ENDPOINT, "expected a JSON object at the root");
  }
  const lists: Partial<Record<(typeof TOKEN_LIST_KEYS)[number], string[]>> = {};
  for (const key of TOKEN_LIST_KEYS) {
    const parsed = requireAddressList(raw[key]);
    if (parsed === null) {
      throw pendleInvalidResponse(TOKENS_ENDPOINT, `\`${key}\` was absent or carried a value that is not an address`);
    }
    lists[key] = parsed;
  }
  return {
    tokensMintSy: lists.tokensMintSy ?? [],
    tokensRedeemSy: lists.tokensRedeemSy ?? [],
    tokensIn: lists.tokensIn ?? [],
    tokensOut: lists.tokensOut ?? [],
  };
}

/**
 * `GET /v1/sdk/{chainId}/markets/{market}/swapping-prices` → live rates.
 *
 * Rates are TOLERANT on purpose: Pendle documents a null leg as "the swap cannot
 * be done", and a null that became 0 here would read as a free swap. The caller
 * must render a null leg as "not swappable", never as a rate.
 *
 * A matured market never reaches this validator — the endpoint answers HTTP 404
 * (`Given market is expired`), which the client maps before parsing.
 */
export function validatePendleSwappingPrices(raw: unknown): PendleReadSwappingPrices {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(PRICES_ENDPOINT, "expected a JSON object at the root");
  }
  return {
    underlyingToken: requireAddress(raw.underlyingToken),
    underlyingTokenToPtRate: readDisplayNumber(raw.underlyingTokenToPtRate),
    ptToUnderlyingTokenRate: readDisplayNumber(raw.ptToUnderlyingTokenRate),
    underlyingTokenToYtRate: readDisplayNumber(raw.underlyingTokenToYtRate),
    ytToUnderlyingTokenRate: readDisplayNumber(raw.ytToUnderlyingTokenRate),
    impliedApy: readDisplayNumber(raw.impliedApy),
  };
}

function normalizeHistoryPoint(
  raw: unknown,
  requested: readonly PendleReadHistoryField[],
): PendleReadMarketHistoryPoint | null {
  if (!isRecord(raw)) return null;
  const timestamp = readDisplayString(raw.timestamp);
  if (timestamp === null) return null;

  // Only REQUESTED fields are projected. The provider echoes what was asked for,
  // so an unexpected key means the contract moved — it must not ride along into
  // a consumer that never declared it.
  const values: Partial<Record<PendleReadHistoryField, number>> = {};
  for (const field of requested) {
    const value = requireFiniteNumber(raw[field]);
    if (value !== null) values[field] = value;
  }
  return { timestamp, values };
}

/**
 * `GET /v3/{chainId}/markets/{market}/historical-data` → a bounded series.
 *
 * SHAPE NOTE (live-verified 2026-07-27): `results` is an array of ROW OBJECTS,
 * each `{timestamp, <selected field>: number, …}` — NOT the parallel "points
 * arrays" the endpoint is sometimes described as returning. The window bounds
 * come back as ISO strings under `timestamp_start` / `timestamp_end`, which are
 * also the REQUEST parameter names (not `from`/`to`).
 *
 * A selected field can legitimately be missing from a row, so an absent value is
 * simply not projected. An unreadable timestamp drops the point; rows arriving
 * with none of them readable RAISES.
 */
export function validatePendleMarketHistory(
  raw: unknown,
  requested: readonly PendleReadHistoryField[],
): PendleReadMarketHistory {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(HISTORY_ENDPOINT, "expected a JSON object at the root");
  }
  const results = raw.results;
  if (!Array.isArray(results)) {
    throw pendleInvalidResponse(HISTORY_ENDPOINT, "the root carried no `results` array");
  }
  const total = readDisplayNumber(raw.total);
  if (total === null) {
    throw pendleInvalidResponse(HISTORY_ENDPOINT, "the root carried no readable `total`");
  }

  const points = results
    .map((row) => normalizeHistoryPoint(row, requested))
    .filter((p): p is PendleReadMarketHistoryPoint => p !== null);
  if (points.length === 0 && results.length > 0) {
    throw pendleInvalidResponse(HISTORY_ENDPOINT, "no row carried a readable timestamp");
  }

  return {
    total,
    timestampStart: readDisplayString(raw.timestamp_start),
    timestampEnd: readDisplayString(raw.timestamp_end),
    points,
  };
}
