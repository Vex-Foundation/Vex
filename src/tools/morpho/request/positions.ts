/**
 * What a caller may ask the POSITIONS lane for.
 *
 * The three `*_gte` bounds on {@link MorphoMarketPositionFilters} are the whole
 * reason this is its own module rather than a paragraph in the markets one: a
 * wallet's real footprint is a UNION of three filtered reads, not one predicate.
 */

import type { MorphoOrder } from "./shared.js";

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
