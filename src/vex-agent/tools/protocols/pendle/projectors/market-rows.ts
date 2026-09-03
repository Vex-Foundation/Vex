/**
 * Catalogue markets → `pendle.yields` rows, through the trusted-fields boundary.
 *
 * Every structural field is re-narrowed: names are bounded and sanitized,
 * addresses are shape-checked, expiry is re-serialized to canonical ISO, numbers
 * are finite and bounded. Rates leave as PERCENT STRINGS with the unit in the
 * field name - a bare 0.0228 in agent-facing output is a unit trap, and the
 * repo's own money-format rule says the unit travels with the number.
 */

import { PENDLE_LOW_APY_THRESHOLD, PENDLE_POINTS_CATEGORY } from "@tools/pendle/constants.js";
import type { PendleAsset } from "@tools/pendle/types.js";
import type { PendleReadMarket } from "@tools/pendle/read/types.js";
import { bpsString, daysUntil, percentString, usdString } from "../money-format.js";
import {
  trustedAddress,
  trustedCategoryIds,
  trustedIsoTimestamp,
  trustedNumber,
  trustedText,
} from "../trusted-fields.js";
import { projectToken, type ProjectedToken } from "./_shared.js";

export type { ProjectedToken };

export interface ProjectedMarketRow {
  chain: string;
  market: string | null;
  name: string | null;
  protocol: string | null;
  expiry: string | null;
  daysToExpiry: number | null;
  matured: boolean;
  /** Full legs, each with the decimals an amount in that leg would need. */
  pt: ProjectedToken | null;
  yt: ProjectedToken | null;
  sy: ProjectedToken | null;
  underlying: ProjectedToken | null;
  liquidityUsd: string | null;
  tvlUsd: string | null;
  volume24hUsd: string | null;
  impliedApyPercent: string | null;
  underlyingApyPercent: string | null;
  pendleApyPercent: string | null;
  aggregatedApyPercent: string | null;
  maxBoostedApyPercent: string | null;
  ytFloatingApyPercent: string | null;
  swapFeeRateBps: string | null;
  categories: string[];
  isNew: boolean;
  isPrime: boolean;
  points?: string[];
  pointsWarning?: string;
  externalProtocols?: string[];
  externalProtocolsWarning?: string;
}

/**
 * Sorting comparator over the PROJECTED rows.
 *
 * Ordering happens here, on the merged multichain set, and not server-side:
 * `/v2/markets/all` is per-chain, so a cross-chain `order_by` would rank each
 * chain independently and then concatenate - which is how the old handler could
 * return fifty rows from one chain and call it "the deepest markets".
 */
export function compareMarketRows(sort: string, order: "asc" | "desc") {
  const direction = order === "asc" ? 1 : -1;
  return (a: ProjectedMarketRow, b: ProjectedMarketRow): number => {
    const compared = compareBySort(sort, a, b);
    return compared * direction;
  };
}

function numericOr(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareBySort(sort: string, a: ProjectedMarketRow, b: ProjectedMarketRow): number {
  // `-Infinity` for a missing value under a descending sort puts unknowns last,
  // which is the honest place for them: an unranked market is not a top market.
  switch (sort) {
    case "impliedApy":
      return numericOr(a.impliedApyPercent, -Infinity) - numericOr(b.impliedApyPercent, -Infinity);
    case "aggregatedApy":
      return numericOr(a.aggregatedApyPercent, -Infinity) - numericOr(b.aggregatedApyPercent, -Infinity);
    case "underlyingApy":
      return numericOr(a.underlyingApyPercent, -Infinity) - numericOr(b.underlyingApyPercent, -Infinity);
    case "maxBoostedApy":
      return numericOr(a.maxBoostedApyPercent, -Infinity) - numericOr(b.maxBoostedApyPercent, -Infinity);
    case "tvl":
      return numericOr(a.tvlUsd, -Infinity) - numericOr(b.tvlUsd, -Infinity);
    case "volume":
      return numericOr(a.volume24hUsd, -Infinity) - numericOr(b.volume24hUsd, -Infinity);
    case "expiry":
      return (a.daysToExpiry ?? Number.MAX_SAFE_INTEGER) - (b.daysToExpiry ?? Number.MAX_SAFE_INTEGER);
    case "name":
      return (a.name ?? "").localeCompare(b.name ?? "");
    default:
      return numericOr(a.liquidityUsd, -Infinity) - numericOr(b.liquidityUsd, -Infinity);
  }
}

/**
 * Project one catalogue market into a yields row.
 *
 * `assetByAddress` is the chain's FROZEN asset catalogue (`buildAssetMap`) - the
 * only source of per-leg decimals. Without it every amount an agent later builds
 * against these legs would be a guess.
 */
export function projectMarketRow(
  market: PendleReadMarket,
  chainSlug: string,
  assetByAddress: Map<string, PendleAsset>,
  nowMs: number,
): ProjectedMarketRow {
  const expiry = trustedIsoTimestamp(market.expiry);
  const days = daysUntil(expiry, nowMs);
  const categories = trustedCategoryIds(market.categoryIds);
  const impliedApyPercent = percentString(trustedNumber(market.details.impliedApy, 100));

  const row: ProjectedMarketRow = {
    chain: chainSlug,
    market: trustedAddress(market.address),
    name: trustedText(market.name),
    protocol: trustedText(market.protocol),
    expiry,
    daysToExpiry: days,
    matured: days !== null && days < 0,
    pt: projectToken(market.pt, assetByAddress),
    yt: projectToken(market.yt, assetByAddress),
    sy: projectToken(market.sy, assetByAddress),
    underlying: projectToken(market.underlyingAsset, assetByAddress),
    liquidityUsd: usdString(trustedNumber(market.details.liquidityUsd)),
    tvlUsd: usdString(trustedNumber(market.details.totalTvlUsd)),
    volume24hUsd: usdString(trustedNumber(market.details.tradingVolumeUsd)),
    impliedApyPercent,
    underlyingApyPercent: percentString(trustedNumber(market.details.underlyingApy, 100)),
    pendleApyPercent: percentString(trustedNumber(market.details.pendleApy, 100)),
    aggregatedApyPercent: percentString(trustedNumber(market.details.aggregatedApy, 100)),
    maxBoostedApyPercent: percentString(trustedNumber(market.details.maxBoostedApy, 100)),
    ytFloatingApyPercent: percentString(trustedNumber(market.details.ytFloatingApy, 100)),
    swapFeeRateBps: bpsString(trustedNumber(market.details.feeRate, 1)),
    categories,
    isNew: market.isNew,
    isPrime: market.isPrime,
  };

  if (categories.includes(PENDLE_POINTS_CATEGORY)) {
    row.points = [PENDLE_POINTS_CATEGORY];
    const headline = trustedNumber(market.details.impliedApy, 100);
    if (headline === null || headline < PENDLE_LOW_APY_THRESHOLD) {
      row.pointsWarning =
        "This market awards POINTS, not a fixed yield. The headline implied APY is low - points are speculative and are NOT a guaranteed return.";
    }
  }
  return row;
}

/**
 * Attach the external-protocol block. Kept separate from the row projection
 * because the mandatory risk sentence is a PRODUCT rule, not a formatting one:
 * a boosted APY sourced from another protocol carries that protocol's risk, and
 * the number must never travel without saying so.
 */
export function withExternalProtocols(row: ProjectedMarketRow, protocols: readonly string[]): ProjectedMarketRow {
  const names = trustedCategoryIds(protocols);
  if (names.length === 0) return row;
  return {
    ...row,
    externalProtocols: names,
    externalProtocolsWarning:
      "Part of this market's yield comes from an EXTERNAL protocol. That yield carries the external protocol's own smart-contract and solvency risk, which Pendle does not underwrite and Vex does not assess.",
  };
}
