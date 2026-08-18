/**
 * What a caller may ask the VAULTS lane for.
 *
 * `Vault` (V1 / MetaMorpho) and `VaultV2` are separate GraphQL types with
 * separate filter inputs and separate order-by enums, so this module carries two
 * of everything and a helper that answers which generation can serve a given
 * ranking. A predicate or a sort one generation cannot serve is refused BY NAME
 * upstream rather than half-applied.
 */

import type { MorphoOrder } from "./shared.js";

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
 *
 * WHAT IS DELIBERATELY ABSENT from both tables: `Address`, and the RAW-UNIT
 * twins `TotalAssets`, `TotalSupply`, `Liquidity`, `RealAssets` and
 * `IdleAssets`. Ranking vaults by contract address answers nothing, and ranking
 * a USDC vault against a WETH vault by raw integer presents a decimals artefact
 * as a size ordering - the `*Usd` members below are the comparable twins and
 * are all offered.
 */
export const MORPHO_VAULT_V1_SORTS = {
  tvlUsd: "TotalAssetsUsd",
  netApy: "NetApy",
  apy: "Apy",
  avgApy: "AvgApy",
  avgNetApy: "AvgNetApy",
  dailyApy: "DailyApy",
  dailyNetApy: "DailyNetApy",
  name: "Name",
  curator: "Curator",
  fee: "Fee",
} as const;

export const MORPHO_VAULT_V2_SORTS = {
  tvlUsd: "TotalAssetsUsd",
  netApy: "NetApy",
  apy: "Apy",
  liquidityUsd: "LiquidityUsd",
  idleAssetsUsd: "IdleAssetsUsd",
  realAssetsUsd: "RealAssetsUsd",
} as const;

/** Every ranking key either generation can serve. Which one is checked per call. */
export const MORPHO_VAULT_SORTS = { ...MORPHO_VAULT_V1_SORTS, ...MORPHO_VAULT_V2_SORTS } as const;

export type MorphoVaultSort = keyof typeof MORPHO_VAULT_SORTS;
export const MORPHO_VAULT_SORT_KEYS = Object.keys(MORPHO_VAULT_SORTS) as readonly MorphoVaultSort[];

/** Sort keys BOTH generations declare, so a merged ranking is a real ranking. */
export const MORPHO_VAULT_MERGEABLE_SORT_KEYS = (
  Object.keys(MORPHO_VAULT_V1_SORTS) as MorphoVaultSort[]
).filter((key) => key in MORPHO_VAULT_V2_SORTS) as readonly MorphoVaultSort[];

/** Can this generation rank by this key at all? */
export function vaultSortSupported(version: "v1" | "v2", sort: MorphoVaultSort): boolean {
  return version === "v1" ? sort in MORPHO_VAULT_V1_SORTS : sort in MORPHO_VAULT_V2_SORTS;
}

/** The generations that CAN serve this ranking, so a refusal can name the fix. */
export function vaultSortVersions(sort: MorphoVaultSort): readonly ("v1" | "v2")[] {
  return (["v1", "v2"] as const).filter((version) => vaultSortSupported(version, sort));
}

/** Morpho's `VaultFilters` (V1 / MetaMorpho), restricted to what this lane exposes. */
export interface MorphoVaultV1Filters {
  chainId_in?: readonly number[];
  listed?: boolean;
  search?: string;
  assetAddress_in?: readonly string[];
  assetSymbol_in?: readonly string[];
  /** V1-ONLY. `VaultV2sFilters` declares no tag predicate (2026-08-18). */
  assetTags_in?: readonly string[];
  /** V1-ONLY. "Which vaults supply this market" has no V2 equivalent (2026-08-18). */
  marketUniqueKey_in?: readonly string[];
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
