/**
 * What a caller may ask the ACTIVITY lane for.
 *
 * Its page ceiling is its own and is deliberately higher than the entity lanes':
 * a transaction row is a fraction of a market row's complexity and a history is
 * only useful in bulk.
 */

import type { MorphoOrder } from "./shared.js";

// -- Activity -------------------------------------------------------

/**
 * Agent-facing transaction-type vocabulary mapped to `MarketTransactionType`.
 *
 * The canonical side is camelCase because that is this tree's param grammar; the
 * values are Morpho's PascalCase members verbatim. Nothing outside this table
 * can be requested, so a typo is a named refusal rather than a page filtered by
 * a predicate the server ignored.
 */
export const MORPHO_ACTIVITY_TYPES = {
  supply: "Supply",
  withdraw: "Withdraw",
  borrow: "Borrow",
  repay: "Repay",
  supplyCollateral: "SupplyCollateral",
  withdrawCollateral: "WithdrawCollateral",
  liquidation: "Liquidation",
} as const;

export type MorphoActivityType = keyof typeof MORPHO_ACTIVITY_TYPES;
export const MORPHO_ACTIVITY_TYPE_KEYS = Object.keys(MORPHO_ACTIVITY_TYPES) as readonly MorphoActivityType[];

/**
 * `MarketTransactionOrderBy`, restricted to the members that mean something on a
 * mixed-type page. `RepaidShares` and `BadDebtShares` are declared by the schema
 * and deliberately omitted: share counts are not comparable across markets, so
 * ranking a history by one presents an ordering the reader would misread as size.
 */
export const MORPHO_ACTIVITY_SORTS = {
  timestamp: "Timestamp",
  assets: "Assets",
  repaidAssets: "RepaidAssets",
  seizedAssets: "SeizedAssets",
  badDebtAssets: "BadDebtAssets",
} as const;

export type MorphoActivitySort = keyof typeof MORPHO_ACTIVITY_SORTS;
export const MORPHO_ACTIVITY_SORT_KEYS = Object.keys(MORPHO_ACTIVITY_SORTS) as readonly MorphoActivitySort[];

/**
 * Activity pages are allowed to be larger than entity pages. A transaction row
 * is a fraction of a market row's complexity (measured 2026-08-14: 200 rows of
 * the activity document cost 11,000 against the 1,000,000 ceiling), and a
 * history is only useful in bulk.
 */
export const MORPHO_MAX_ACTIVITY_LIMIT = 100;

/** `MarketTransactionFilters`, restricted to the predicates this lane exposes. */
export interface MorphoActivityFilters {
  chainId_in?: readonly number[];
  marketUniqueKey_in?: readonly string[];
  userAddress_in?: readonly string[];
  liquidatorAddress_in?: readonly string[];
  type_in?: readonly string[];
  timestamp_gte?: number;
  timestamp_lte?: number;
  /** One transaction hash. A `String`, not a list - the schema declares no `hash_in`. */
  hash?: string;
  /**
   * RAW BASE UNITS of the market's own asset, as a decimal string, because the
   * schema types both as `BigInt`. Bad debt is denominated in the LOAN asset and
   * a seizure in the COLLATERAL asset, so the two floors are not interchangeable
   * and neither can be read without the market's decimals beside it.
   */
  badDebtAssets_gte?: string;
  seizedAssets_gte?: string;
}

export interface MorphoActivityQuery {
  first: number;
  skip: number;
  orderBy: MorphoActivitySort;
  order: MorphoOrder;
  where: MorphoActivityFilters;
}

/** Clamp an activity page size to this lane's ceiling. Same contract as {@link clampPageLimit}. */
export function clampActivityLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return MORPHO_MAX_ACTIVITY_LIMIT;
  return Math.min(Math.floor(limit), MORPHO_MAX_ACTIVITY_LIMIT);
}
