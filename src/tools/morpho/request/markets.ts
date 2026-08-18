/**
 * What a caller may ask the MARKETS lane for: its filter input, its sort
 * vocabulary and its averaging windows.
 *
 * `MarketOrderBy` does not contain the names a reader would guess: there is no
 * `LiquidityUsd` and no `SupplyUsd` - the real members are `TotalLiquidityUsd`
 * and `SupplyAssetsUsd`. A pass-through string would therefore have produced a
 * GraphQL validation error at best, and at worst a ranking we then claimed to
 * have applied.
 *
 * VERIFIED AND WIDENED BY INTROSPECTION ON 2026-08-18, after an external
 * coverage audit found this lane shipping 15 of 43 `MarketFilters` and 6 of 23
 * usable `MarketOrderBy` members. Every filter field and enum member added that
 * day was confirmed present AND confirmed to change a live result count before
 * being encoded here; the deliberate omissions that remain are named with their
 * reason below and in `vex-agent/tools/protocols/morpho/Morpho.md`.
 */

import type { MorphoOrder } from "./shared.js";

/**
 * Agent-facing sort vocabulary mapped to the `MarketOrderBy` enum members the
 * live schema declares. A key absent from this table cannot be requested.
 *
 * WHAT IS DELIBERATELY ABSENT, and why, because "we shipped a subset" is only
 * acceptable when every omission is named. `MarketOrderBy` declares 24 members
 * (introspection, 2026-08-18); this table offers 18 of them.
 *
 *   RateAtUTarget       - deprecated in the live schema. `apyAtTarget` is the
 *                         living spelling and is offered.
 *   UniqueKey           - ranks by an opaque 32-byte hash. There is no question
 *                         a user can ask that this ordering answers.
 *   BorrowAssets        - RAW BASE UNITS. Ranking a 6-decimal USDC market
 *   SupplyAssets          against an 18-decimal WETH one by raw integer is the
 *                         unreadable-number hazard rules/90 names: the ordering
 *                         reads as size and is not one. `borrowUsd`, `supplyUsd`
 *                         and `sizeUsd` are the comparable twins.
 *   BorrowShares        - SHARE counts, not comparable across markets, for the
 *   SupplyShares          same reason `MORPHO_ACTIVITY_SORTS` refuses to rank a
 *                         history by `RepaidShares`.
 */
export const MORPHO_MARKET_SORTS = {
  supplyUsd: "SupplyAssetsUsd",
  borrowUsd: "BorrowAssetsUsd",
  sizeUsd: "SizeUsd",
  liquidityUsd: "TotalLiquidityUsd",
  supplyApy: "SupplyApy",
  netSupplyApy: "NetSupplyApy",
  borrowApy: "BorrowApy",
  netBorrowApy: "NetBorrowApy",
  avgBorrowApy: "AvgBorrowApy",
  avgNetBorrowApy: "AvgNetBorrowApy",
  dailyBorrowApy: "DailyBorrowApy",
  dailyNetBorrowApy: "DailyNetBorrowApy",
  apyAtTarget: "ApyAtTarget",
  utilization: "Utilization",
  lltv: "Lltv",
  fee: "Fee",
  loanAssetSymbol: "LoanAssetSymbol",
  collateralAssetSymbol: "CollateralAssetSymbol",
} as const;

export type MorphoMarketSort = keyof typeof MORPHO_MARKET_SORTS;
export const MORPHO_MARKET_SORT_KEYS = Object.keys(MORPHO_MARKET_SORTS) as readonly MorphoMarketSort[];

/**
 * APY averaging windows.
 *
 * These are NOT a GraphQL argument. Introspection on 2026-08-14 confirmed that
 * no field of `MarketState` takes arguments at all - Morpho exposes averages as
 * FIXED named fields (`dailyNetSupplyApy`, `weeklyNetSupplyApy`, ...). The enum
 * below therefore selects a field-name prefix, which is why `inception` maps to
 * `allTime` rather than to a lookback value the server would have to interpret.
 *
 * `biweekly` exists in the schema and is deliberately not offered: it has no
 * natural agent-facing name and adds a window nobody asks for.
 */
export const MORPHO_LOOKBACKS = {
  one_day: "daily",
  seven_days: "weekly",
  thirty_days: "monthly",
  ninety_days: "quarterly",
  one_year: "yearly",
  inception: "allTime",
} as const;

export type MorphoLookback = keyof typeof MORPHO_LOOKBACKS;
export const MORPHO_LOOKBACK_KEYS = Object.keys(MORPHO_LOOKBACKS) as readonly MorphoLookback[];

/**
 * The asset-tag vocabulary Morpho actually uses, as CAPTURED rather than as
 * declared.
 *
 * `loanAssetTags_in`, `collateralAssetTags_in` and `VaultFilters.assetTags_in`
 * are typed `[String!]` - the schema declares no enum, so introspection alone
 * cannot say what a legal tag is. This list is therefore a MEASUREMENT: every
 * distinct `Asset.tags` member across all 5,520 assets Morpho indexed, paged in
 * full on 2026-08-18. Refresh it by re-running that sweep.
 *
 * It is enforced as a closed set anyway, and the reason is the failure mode of
 * not doing so: a tag Morpho does not know is not an error to the server, it is
 * a predicate that matches NOTHING, and the agent reads the empty page as "no
 * such markets exist" rather than "you invented a tag". A named refusal that
 * lists the real vocabulary is strictly more useful than that silence.
 */
export const MORPHO_ASSET_TAGS = [
  "EUR",
  "btc",
  "convex-wrapper",
  "dai-specific-permit",
  "erc4626",
  "eth",
  "eur-pegged",
  "governance-token",
  "lrt",
  "lst",
  "permissioned",
  "rwa",
  "simple-permit",
  "stablecoin",
  "usd",
  "usd-pegged",
  "vault-v1",
  "vault-v2",
  "yield",
] as const;

export type MorphoAssetTag = (typeof MORPHO_ASSET_TAGS)[number];

/** Morpho's `MarketFilters` input, restricted to the predicates this lane exposes. */
export interface MorphoMarketFilters {
  chainId_in?: readonly number[];
  search?: string;
  listed?: boolean;
  isIdle?: boolean;
  uniqueKey_in?: readonly string[];
  oracleAddress_in?: readonly string[];
  irmAddress_in?: readonly string[];
  loanAssetTags_in?: readonly string[];
  collateralAssetTags_in?: readonly string[];
  loanAssetAddress_in?: readonly string[];
  collateralAssetAddress_in?: readonly string[];
  supplyAssetsUsd_gte?: number;
  supplyAssetsUsd_lte?: number;
  borrowAssetsUsd_gte?: number;
  borrowAssetsUsd_lte?: number;
  utilization_gte?: number;
  utilization_lte?: number;
  netSupplyApy_gte?: number;
  netBorrowApy_lte?: number;
  lltv_gte?: string;
  lltv_lte?: string;
}

export interface MorphoMarketsQuery {
  first: number;
  skip: number;
  orderBy: MorphoMarketSort;
  order: MorphoOrder;
  where: MorphoMarketFilters;
}

export interface MorphoMarketQuery {
  marketId: string;
  chainId: number;
  includeHistory: boolean;
  lookback: MorphoLookback;
  includeSupplyingVaults: boolean;
}
