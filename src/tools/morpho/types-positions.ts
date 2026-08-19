/**
 * Shapes for the POSITIONS and ACTIVITY lanes.
 *
 * Split from `./types.ts` rather than appended to it: that file already owned
 * the market and vault read shapes, and a wallet's positions and a market's
 * transaction log change for different reasons than a market's state does.
 * `./types.ts` re-exports everything here, so no import outside this folder
 * moved.
 */

import type { MorphoAsset, MorphoMarketWarning, MorphoRawAmount, MorphoVaultVersion } from "./types.js";

// -- Positions ------------------------------------------------------

/**
 * A SIGNED base-unit amount.
 *
 * Distinct from {@link MorphoRawAmount} because the two are read by different
 * validators and confusing them is a correctness bug rather than a style one.
 * Morpho's `margin`, `borrowPnl` and vault `pnl` are `BigInt` scalars that go
 * NEGATIVE (measured 2026-08-14: `margin: -23633633` on a live position), while
 * every balance field in this tree is non-negative and is refused if it is not.
 */
export interface MorphoSignedAmount {
  /** Decimal base units, `-` prefixed when negative. */
  raw: string;
  decimals: number;
  usd: number | null;
}

/** The market a position is held in, carried on the position row itself. */
export interface MorphoPositionMarketRef {
  marketId: string;
  chainId: number;
  chainName: string | null;
  /** WAD fraction as an integer string, e.g. `"860000000000000000"` = 86%. */
  lltv: string;
  listed: boolean;
  loanAsset: MorphoAsset;
  collateralAsset: MorphoAsset | null;
  warnings: MorphoMarketWarning[];
}

export interface MorphoMarketPosition {
  id: string;
  userAddress: string;
  market: MorphoPositionMarketRef;
  /**
   * Collateral value divided by the debt's liquidation threshold. Below 1 the
   * position is liquidatable NOW.
   *
   * NULL MEANS NO DEBT, not unknown: Morpho returns null on every supply-only
   * row. A consumer must never render the absence as safety, and must never
   * render it as a number.
   */
  healthFactor: number | null;
  /** Fraction the collateral price may move before liquidation. Null with no debt. */
  priceVariationToLiquidationPrice: number | null;
  /** Whether Morpho lists the market this position is in. */
  marketListed: boolean;
  timestamp: number | null;
  /** Collateral posted, in COLLATERAL-asset units. Null on an idle market. */
  collateral: MorphoRawAmount | null;
  /** Assets lent into the market, in LOAN-asset units. */
  supply: MorphoRawAmount;
  /** Debt owed, in LOAN-asset units. */
  borrow: MorphoRawAmount;
  supplyShares: string | null;
  borrowShares: string | null;
  /** Collateral value less debt, in LOAN-asset units. Signed. */
  margin: MorphoSignedAmount | null;
  /** Interest paid so far on the debt, in LOAN-asset units. Signed. */
  borrowPnl: MorphoSignedAmount | null;
  borrowRoe: number | null;
}

export interface MorphoMarketPositionPage {
  positions: MorphoMarketPosition[];
  countTotal: number;
  count: number;
  limit: number;
  skip: number;
  droppedRows: number;
}

/** A vault position, in whichever generation the vault belongs to. */
export interface MorphoVaultPosition {
  id: string;
  userAddress: string;
  vaultAddress: string;
  vaultName: string | null;
  vaultSymbol: string | null;
  vaultListed: boolean;
  vaultVersion: MorphoVaultVersion;
  chainId: number;
  chainName: string | null;
  asset: MorphoAsset;
  timestamp: number | null;
  /** Deposit value, in the vault's ASSET units. */
  assets: MorphoRawAmount;
  /** Share balance, in SHARE units, whose scale is not the asset's. */
  shares: string | null;
  /** Profit since entry, in asset units. Signed. */
  pnl: MorphoSignedAmount | null;
  /** Return on equity as a fraction. */
  roe: number | null;
  /** The vault's APY NET of the curator's fee. */
  netApy: number | null;
  apy: number | null;
}

export interface MorphoVaultPositionPage {
  positions: MorphoVaultPosition[];
  countTotal: number;
  count: number;
  limit: number;
  skip: number;
  droppedRows: number;
}

/**
 * What a V2 position sweep actually covered.
 *
 * Reported on every read because the sweep is a COMPOSITION, not a query: the
 * schema has no per-user V2 position list, so the lane discovers candidate
 * vaults from the wallet's V2 transaction history and reads each one. A wallet
 * with more V2 transactions than one page holds, or with more distinct vaults
 * than the per-call ceiling, is covered PARTIALLY, and this block says so rather
 * than letting a short list read as a complete one.
 */
export interface MorphoVaultV2Coverage {
  scannedTransactions: number;
  totalTransactions: number;
  vaultsFound: number;
  vaultsRead: number;
  /** True only when every V2 vault the wallet ever touched was read. */
  complete: boolean;
}

// -- Activity -------------------------------------------------------

/** One raw amount from a transaction row, in a NAMED asset. */
export interface MorphoActivityAmount {
  raw: string;
  decimals: number;
  symbol: string | null;
  /** Which of the market's two legs this amount is denominated in. */
  asset: "loan" | "collateral";
}

/**
 * One Morpho Blue market transaction.
 *
 * `amounts` is a map rather than fixed fields because which amounts exist is
 * decided by the row's union branch: a collateral transfer has no `shares`, and
 * only a liquidation has `repaidAssets`, `seizedAssets` and `badDebtAssets`. An
 * absent key means the branch does not carry that amount; it never means zero.
 */
export interface MorphoMarketTransaction {
  txHash: string;
  chainId: number;
  chainName: string | null;
  timestamp: number | null;
  blockNumber: string | null;
  txIndex: number | null;
  logIndex: number | null;
  /** Morpho's own PascalCase member, mapped to this lane's camelCase vocabulary. */
  type: string;
  /** The union member Morpho actually returned, not the one `type` implied. */
  dataShape: string;
  userAddress: string;
  marketId: string;
  marketListed: boolean;
  /** WAD fraction as an integer string. */
  lltv: string;
  loanAsset: MorphoAsset;
  collateralAsset: MorphoAsset | null;
  amounts: Record<string, MorphoActivityAmount>;
  /** Share counts, which are NOT asset units and carry no decimals. */
  shares: Record<string, string>;
  /** Only on a liquidation row. */
  liquidatorAddress: string | null;
}

export interface MorphoActivityPage {
  transactions: MorphoMarketTransaction[];
  countTotal: number;
  count: number;
  limit: number;
  skip: number;
  droppedRows: number;
}
