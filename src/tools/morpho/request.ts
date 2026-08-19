/**
 * What a caller may ASK the Morpho GraphQL surface for, and the guards that run
 * before any query variable is built.
 *
 * Split from `./client.ts` on the same seam Pendle's read lane uses: this module
 * owns the request contract (which filters exist, which sort keys the schema
 * actually declares, what a legal value is), the client owns how the call is
 * made. They move for different reasons.
 *
 * Every union here was read off the LIVE schema by introspection on 2026-08-14,
 * not from documentation. `MarketOrderBy` in particular does not contain the
 * names a reader would guess: there is no `LiquidityUsd` and no `SupplyUsd` -
 * the real members are `TotalLiquidityUsd` and `SupplyAssetsUsd`. A pass-through
 * string would therefore have produced a GraphQL validation error at best, and
 * at worst a ranking we then claimed to have applied.
 *
 * These values arrive from tool params, i.e. ultimately from model output.
 * GraphQL variables are not a string sink the way a URL path is, but an address
 * or a market id that is not one is still fed to a filter that will silently
 * match nothing - so identity-shaped inputs are checked for SHAPE here and
 * refused by name, never coerced.
 */

import { VexError, ErrorCodes } from "../../errors.js";

/** Provider page ceiling this client imposes. Morpho's own `first` accepts more. */
export const MORPHO_MAX_PAGE_LIMIT = 50;

/** WAD scale Morpho expresses `lltv` in (1e18 = 100%). */
export const MORPHO_WAD_DECIMALS = 18;

/**
 * Agent-facing sort vocabulary mapped to the `MarketOrderBy` enum members the
 * live schema declares. A key absent from this table cannot be requested.
 */
export const MORPHO_MARKET_SORTS = {
  supplyUsd: "SupplyAssetsUsd",
  netSupplyApy: "NetSupplyApy",
  netBorrowApy: "NetBorrowApy",
  utilization: "Utilization",
  liquidityUsd: "TotalLiquidityUsd",
  lltv: "Lltv",
} as const;

export type MorphoMarketSort = keyof typeof MORPHO_MARKET_SORTS;
export const MORPHO_MARKET_SORT_KEYS = Object.keys(MORPHO_MARKET_SORTS) as readonly MorphoMarketSort[];

export type MorphoOrder = "asc" | "desc";
export const MORPHO_ORDERS: readonly MorphoOrder[] = ["asc", "desc"];

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

// -- Vaults ---------------------------------------------------------

/**
 * Which vault generation a screening call reads.
 *
 * `both` is the default because a user asking "where do I deposit USDC" does not
 * know or care which contract generation a vault is, and the two populations are
 * disjoint sets of real vaults - reading only one silently hides half the answer.
 */
export type MorphoVaultVersionSelector = "v1" | "v2" | "both";
export const MORPHO_VAULT_VERSIONS: readonly MorphoVaultVersionSelector[] = ["v1", "v2", "both"];

/**
 * Agent-facing vault sort vocabulary, mapped per generation.
 *
 * The two tables are SEPARATE on purpose. `VaultOrderBy` and `VaultV2OrderBy`
 * are different enums (live introspection, 2026-08-14) and `Name` exists only on
 * the V1 side. A key missing from a generation's table is refused BY NAME
 * upstream, naming the version that cannot serve it; it is never quietly swapped
 * for a key that happens to exist, which would present one ranking as another.
 */
export const MORPHO_VAULT_V1_SORTS = {
  tvlUsd: "TotalAssetsUsd",
  netApy: "NetApy",
  apy: "Apy",
  name: "Name",
} as const;

export const MORPHO_VAULT_V2_SORTS = {
  tvlUsd: "TotalAssetsUsd",
  netApy: "NetApy",
  apy: "Apy",
} as const;

export type MorphoVaultSort = keyof typeof MORPHO_VAULT_V1_SORTS;
export const MORPHO_VAULT_SORT_KEYS = Object.keys(MORPHO_VAULT_V1_SORTS) as readonly MorphoVaultSort[];

/** Sort keys BOTH generations declare, so a merged ranking is a real ranking. */
export const MORPHO_VAULT_MERGEABLE_SORT_KEYS = Object.keys(
  MORPHO_VAULT_V2_SORTS,
) as readonly MorphoVaultSort[];

/** Can this generation rank by this key at all? */
export function vaultSortSupported(version: "v1" | "v2", sort: MorphoVaultSort): boolean {
  return version === "v1" ? sort in MORPHO_VAULT_V1_SORTS : sort in MORPHO_VAULT_V2_SORTS;
}

/** Morpho's `VaultFilters` (V1 / MetaMorpho), restricted to what this lane exposes. */
export interface MorphoVaultV1Filters {
  chainId_in?: readonly number[];
  listed?: boolean;
  search?: string;
  assetAddress_in?: readonly string[];
  assetSymbol_in?: readonly string[];
  curatorAddress_in?: readonly string[];
  totalAssetsUsd_gte?: number;
  totalAssetsUsd_lte?: number;
  netApy_gte?: number;
  /** FRACTION on V1, unlike the V2 fee filters. 0.05 = 5%. */
  fee_lte?: number;
}

/**
 * Morpho's `VaultV2sFilters`. Note the `s` in the type name, and note what is
 * ABSENT relative to V1: there is no `search` and no `assetSymbol_in`, so a
 * caller asking for either is refused by name rather than served a V2 page the
 * predicate never touched.
 */
export interface MorphoVaultV2Filters {
  chainId_in?: readonly number[];
  listed?: boolean;
  assetAddress_in?: readonly string[];
  curatorAddress_in?: readonly string[];
  totalAssetsUsd_gte?: number;
  totalAssetsUsd_lte?: number;
  netApy_gte?: number;
  /** WAD STRING on V2, unlike V1's fraction. `"200000000000000000"` = 20%. */
  performanceFee_lte?: string;
}

export interface MorphoVaultsQuery<F> {
  first: number;
  skip: number;
  orderBy: MorphoVaultSort;
  order: MorphoOrder;
  where: F;
}

export interface MorphoVaultQuery {
  vaultAddress: string;
  chainId: number;
  includeAllocations: boolean;
  includeHistory: boolean;
}

/** Guard a vault address before it becomes a `vaultByAddress` variable. */
export function requireVaultAddress(value: string): string {
  const trimmed = value.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) {
    const looksLikeMarketId = MARKET_ID_PATTERN.test(trimmed);
    throw new VexError(
      ErrorCodes.INVALID_ADDRESS,
      `Morpho: "${value}" is not a vault address.`
      + (looksLikeMarketId ? " That is a 32-byte MARKET id, not a vault contract address." : ""),
      "A Morpho vault address is a 0x-prefixed 40-hex contract address - read one from morpho.vaults.discover.",
    );
  }
  return trimmed.toLowerCase();
}

/** Morpho's `MarketFilters` input, restricted to the predicates this lane exposes. */
export interface MorphoMarketFilters {
  chainId_in?: readonly number[];
  search?: string;
  listed?: boolean;
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

// -- Positions ------------------------------------------------------

/**
 * Agent-facing ranking vocabulary for `marketPositions`, mapped to the
 * `MarketPositionOrderBy` members the live schema declares (introspection,
 * 2026-08-14). The enum has exactly four members and this table is all of them.
 */
export const MORPHO_MARKET_POSITION_SORTS = {
  collateral: "Collateral",
  borrowShares: "BorrowShares",
  supplyShares: "SupplyShares",
  healthFactor: "HealthFactor",
} as const;

export type MorphoMarketPositionSort = keyof typeof MORPHO_MARKET_POSITION_SORTS;
export const MORPHO_MARKET_POSITION_SORT_KEYS = Object.keys(
  MORPHO_MARKET_POSITION_SORTS,
) as readonly MorphoMarketPositionSort[];

/** Which halves of a wallet's Morpho footprint a positions read covers. */
export type MorphoPositionScope = "markets" | "vaults" | "all";
export const MORPHO_POSITION_SCOPES: readonly MorphoPositionScope[] = ["markets", "vaults", "all"];

/**
 * `MarketPositionFilters`, restricted to what this lane sends.
 *
 * The three `*_gte` bounds exist for ONE reason, measured on 2026-08-14: Morpho
 * keeps a position row for every market an address has ever touched, so a bare
 * `userAddress_in` read of `0x...dEaD` reports 2,002 "positions". A wallet's
 * real footprint is the UNION of rows with collateral, with supply, or with
 * borrow, and GraphQL filters are ANDed, so that union is three reads rather
 * than one predicate. Passing none of them returns the closed rows too.
 */
export interface MorphoMarketPositionFilters {
  userAddress_in: readonly string[];
  chainId_in?: readonly number[];
  marketListed?: boolean;
  healthFactor_lte?: number;
  collateral_gte?: string;
  supplyShares_gte?: string;
  borrowShares_gte?: string;
}

/** `VaultPositionFilters`. V1 (MetaMorpho) only - see `MORPHO_VAULT_V2_POSITION_QUERY`. */
export interface MorphoVaultPositionFilters {
  userAddress_in: readonly string[];
  chainId_in?: readonly number[];
  vaultListed?: boolean;
  shares_gte?: string;
}

export interface MorphoMarketPositionsQuery {
  first: number;
  skip: number;
  orderBy: MorphoMarketPositionSort;
  order: MorphoOrder;
  where: MorphoMarketPositionFilters;
}

export interface MorphoVaultPositionsQuery {
  first: number;
  skip: number;
  order: MorphoOrder;
  where: MorphoVaultPositionFilters;
}

export interface MorphoVaultV2PositionQuery {
  userAddress: string;
  vaultAddress: string;
  chainId: number;
}

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

/**
 * Guard a wallet address before it becomes a position or activity filter.
 *
 * Morpho itself rejects a malformed address with a `BAD_USER_INPUT` body naming
 * `where.userAddress_in`, so this check is not the only line of defence - it is
 * the one that answers in OUR vocabulary and without spending a request against
 * the seven-day ban budget. Casing does not matter to the server (measured
 * 2026-08-14: the checksummed and lowercased forms of the same address both
 * returned 22 rows), and lowercasing here makes our own cache key stable.
 */
export function requireUserAddress(value: string): string {
  const trimmed = value.trim();
  if (!ADDRESS_PATTERN.test(trimmed)) {
    throw new VexError(
      ErrorCodes.INVALID_ADDRESS,
      `Morpho: "${value}" is not a wallet address.`,
      "Pass one 0x-prefixed 40-hex account address - Morpho positions are read for a single wallet per call.",
    );
  }
  return trimmed.toLowerCase();
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MARKET_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** Guard an address destined for an `*_in` filter, and lowercase it. */
export function requireFilterAddress(value: string, label: string): string {
  if (!ADDRESS_PATTERN.test(value.trim())) {
    throw new VexError(
      ErrorCodes.INVALID_ADDRESS,
      `Morpho: ${label} "${value}" is not a valid EVM address.`,
      "Pass a 0x-prefixed 40-hex contract address.",
    );
  }
  return value.trim().toLowerCase();
}

/**
 * Guard a Morpho Blue market id: a 32-byte hash, NOT an address.
 *
 * Worth the separate check because the two are easy to confuse and the failure
 * mode differs. An address passed as a market id does not error - `marketById`
 * simply finds nothing - so without this the agent would read "no such market"
 * when the real fault was a 40-hex value where a 64-hex one belonged.
 */
export function requireMarketId(value: string): string {
  const trimmed = value.trim();
  if (!MARKET_ID_PATTERN.test(trimmed)) {
    const looksLikeAddress = ADDRESS_PATTERN.test(trimmed);
    throw new VexError(
      ErrorCodes.AGENT_VALIDATION_ERROR,
      `Morpho: "${value}" is not a market id.`
      + (looksLikeAddress ? " That is a 20-byte contract ADDRESS, not a market id." : ""),
      "A Morpho Blue market id is a 0x-prefixed 64-hex hash - read one from morpho.markets.discover.",
    );
  }
  return trimmed.toLowerCase();
}

/** Guard a chain id before it becomes a GraphQL variable. */
export function requireQueryChainId(chainId: number): number {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new VexError(
      ErrorCodes.CHAIN_MISMATCH,
      "Morpho: chain id must be a positive integer.",
      "Resolve the chain through the Morpho chain registry first.",
    );
  }
  return chainId;
}

/**
 * Clamp a page size to this client's ceiling.
 *
 * Clamping is safe HERE, and only here, because the agent-facing boundary
 * (`protocols/morpho/read-params.ts`) rejects an over-limit `limit` BY NAME
 * before it reaches this function. rules/90 forbids a silently clamped
 * parameter; this is the internal floor that keeps a programmatic caller from
 * asking for a page the budget cannot afford, not a place a caller's value is
 * quietly rewritten.
 */
export function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return MORPHO_MAX_PAGE_LIMIT;
  return Math.min(Math.floor(limit), MORPHO_MAX_PAGE_LIMIT);
}

/**
 * Percent -> a WAD integer string (1e18 = 100%).
 *
 * The conversion runs through a rounded integer rather than a float multiply so
 * an 86.5% bound cannot arrive as `865000000000000001`.
 */
export function percentToWadString(percent: number): string {
  const scaled = Math.round(percent * 1e16);
  return BigInt(scaled).toString();
}

/**
 * Percent -> the WAD integer string `lltv_gte` / `lltv_lte` expect.
 *
 * Morpho stores LLTV as a WAD fraction (`"860000000000000000"` = 86%).
 */
export function lltvPercentToWad(percent: number): string {
  return percentToWadString(percent);
}

/**
 * Percent -> the WAD integer string `VaultV2sFilters.performanceFee_*` expects.
 *
 * Separate from the LLTV helper only so the call site reads correctly; the scale
 * is the same. The V2 fee filters being WAD while the V2 fee OUTPUT is a plain
 * fraction (`performanceFee: 0.2`) is not an inference from the type - it was
 * measured on 2026-08-14: `performanceFee_gte: "150000000000000000"` returned
 * 474 vaults whose smallest reported `performanceFee` was exactly 0.15. Vault V1
 * is the opposite: its `fee_lte` takes the FRACTION directly.
 */
export function feePercentToWad(percent: number): string {
  return percentToWadString(percent);
}

/** WAD fraction -> percent, for display. Exact for every LLTV Morpho lists. */
export function wadToPercent(wad: string): number {
  return Number(wad) / 1e16;
}
