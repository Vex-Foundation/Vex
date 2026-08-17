/**
 * Projection of validated Morpho positions into agent-facing rows.
 *
 * THE HEALTH FACTOR IS THE WHOLE POINT OF THIS MODULE, so its rendering rules
 * are here rather than spread across the handler.
 *
 * It is emitted as a DECIMAL STRING, never a float in agent output. Morpho types
 * the field `Float!` and a live row on 2026-08-14 read 1.0003866728625144: at
 * that magnitude any rounding a renderer applies decides whether the number
 * shows as 1.00 (which reads as safe) or as 1.0004 (which reads as an emergency
 * one block away). The string is the provider's own value, stringified, with no
 * arithmetic applied.
 *
 * NULL IS NOT ZERO AND IT IS NOT SAFETY. Morpho returns no health factor for a
 * supply-only position, because a position with no debt cannot be liquidated.
 * The projection says exactly that in words rather than leaving a blank the
 * reader fills in optimistically.
 *
 * THE BAND IS A LABEL, NOT A SCORE. Morpho Blue has NO close factor: at a health
 * factor below 1 a liquidator may repay the entire debt in one transaction and
 * take collateral worth up to the liquidation incentive on top, so the usual
 * lending-protocol intuition that a dip below 1 costs a slice of the position
 * does not hold here. The bands below are named accordingly, and the boundary
 * that matters is 1, not some comfortable distance above it.
 */

import type {
  MorphoMarketPosition,
  MorphoSignedAmount,
  MorphoVaultPosition,
} from "@tools/morpho/types.js";
import {
  formatRawAmount,
  projectAmount,
  projectAsset,
  projectShareQuantity,
  toPercent,
  type ProjectedAmount,
  type ProjectedShareQuantity,
} from "./_shared.js";

/** The sentence every health factor in this namespace is qualified by. */
export const MORPHO_HEALTH_FACTOR_NOTE =
  "A health factor below 1 means the position is liquidatable RIGHT NOW. Morpho Blue has no close factor, so one "
  + "liquidation can repay the entire debt and seize collateral worth up to the liquidation incentive on top of it: "
  + "there is no partial-liquidation cushion. A value near 1 is an emergency, not a warning. A null health factor "
  + "means the position has NO DEBT and therefore nothing to liquidate; it never means the position was not checked.";

/**
 * The sign convention of `priceDropToLiquidationPercent`, stated where the field
 * is built.
 *
 * Live values are NEGATIVE (-40.69, -15.17, -99.99 on the 2026-08-17 read) and
 * the name alone reads as an event that already happened. This is the one risk
 * number in the namespace a model can invert, so the convention is spelled out
 * here and repeated per row in words by `priceDropToLiquidationDirection`.
 */
export const MORPHO_PRICE_DROP_NOTE =
  "`priceDropToLiquidationPercent` is a SIGNED DISTANCE STILL TO GO, not a move that already happened. NEGATIVE "
  + "means the collateral price must FALL by that much from today's oracle mark to reach the liquidation threshold, "
  + "so -40.7 means liquidation is a 40.7% drop away. POSITIVE means the mark would have to RISE to reach the "
  + "threshold, which is a position already at or past the line. Null means no debt and so no liquidation price at "
  + "all. Each row's `priceDropToLiquidationDirection` says which case it is in words - quote that rather than "
  + "re-deriving the sign, and never report the number as a drop the collateral has already suffered.";

export const MORPHO_POSITION_USD_NOTE =
  "Every USD figure on a position is Morpho's own oracle mark for that market, not a traded price, and the totals "
  + "are the sum of those marks. A position on a market carrying an oracle warning contributes a number that cannot "
  + "be relied on, so read each row's `warnings` before trusting a total.";

export interface ProjectedSignedAmount {
  raw: string;
  decimals: number;
  symbol: string | null;
  human: string;
  usd: number | null;
}

function projectSigned(amount: MorphoSignedAmount | null, symbol: string | null): ProjectedSignedAmount | null {
  if (amount === null) return null;
  return {
    raw: amount.raw,
    decimals: amount.decimals,
    symbol,
    human: formatRawAmount(amount.raw, amount.decimals),
    usd: amount.usd,
  };
}

/**
 * The named band a health factor falls in.
 *
 * Deliberately coarse and deliberately blunt at the bottom. Anything at or below
 * 1 is already liquidatable and is labelled as such rather than as "risky"; the
 * bands above it describe distance from that line without implying that any of
 * them is a safe place to leave a leveraged position unattended.
 */
export function healthFactorBand(healthFactor: number | null): string {
  if (healthFactor === null) return "no_debt";
  if (healthFactor <= 1) return "liquidatable_now";
  if (healthFactor < 1.05) return "critical";
  if (healthFactor < 1.25) return "tight";
  if (healthFactor < 2) return "moderate";
  return "comfortable";
}

export type MorphoPriceMoveDirection =
  | "collateral_price_must_fall"
  | "collateral_price_must_rise"
  | "at_liquidation_price";

/** The signed distance's direction, named so no reader has to interpret a minus sign. */
export function priceMoveDirection(percent: number | null): MorphoPriceMoveDirection | null {
  if (percent === null) return null;
  if (percent < 0) return "collateral_price_must_fall";
  if (percent > 0) return "collateral_price_must_rise";
  return "at_liquidation_price";
}

export interface ProjectedMarketPositionRow {
  positionId: string;
  market: {
    marketId: string;
    chainId: number;
    chain: string | null;
    pair: string;
    lltvPercent: number | null;
    listed: boolean;
    warnings: { type: string; level: string }[];
  };
  loanAsset: ReturnType<typeof projectAsset>;
  collateralAsset: ReturnType<typeof projectAsset>;
  collateral: ProjectedAmount | null;
  supply: ProjectedAmount | null;
  borrow: ProjectedAmount | null;
  supplyShares: ProjectedShareQuantity | null;
  borrowShares: ProjectedShareQuantity | null;
  /** Decimal string, verbatim from Morpho. Null means NO DEBT. */
  healthFactor: string | null;
  healthFactorBand: string;
  /** SIGNED distance still to go, per {@link MORPHO_PRICE_DROP_NOTE}. */
  priceDropToLiquidationPercent: number | null;
  /** The same distance's direction in words, so the sign cannot be inverted. */
  priceDropToLiquidationDirection: MorphoPriceMoveDirection | null;
  margin: ProjectedSignedAmount | null;
  borrowPnl: ProjectedSignedAmount | null;
  borrowRoePercent: number | null;
  asOfTimestamp: number | null;
}

export function projectMarketPosition(position: MorphoMarketPosition): ProjectedMarketPositionRow {
  const loanSymbol = position.market.loanAsset.symbol;
  const collateralSymbol = position.market.collateralAsset?.symbol ?? null;
  return {
    positionId: position.id,
    market: {
      marketId: position.market.marketId,
      chainId: position.market.chainId,
      chain: position.market.chainName,
      pair: `${collateralSymbol ?? "idle"}/${loanSymbol ?? "?"}`,
      lltvPercent: Number(position.market.lltv) / 1e16,
      listed: position.market.listed,
      warnings: position.market.warnings,
    },
    loanAsset: projectAsset(position.market.loanAsset),
    collateralAsset: projectAsset(position.market.collateralAsset),
    collateral: projectAmount(position.collateral, collateralSymbol),
    supply: projectAmount(position.supply, loanSymbol),
    borrow: projectAmount(position.borrow, loanSymbol),
    supplyShares: projectShareQuantity(position.supplyShares),
    borrowShares: projectShareQuantity(position.borrowShares),
    healthFactor: position.healthFactor === null ? null : String(position.healthFactor),
    healthFactorBand: healthFactorBand(position.healthFactor),
    // Passed through as a percent with the SIGN INTACT rather than made
    // absolute, because the direction is what tells the two cases apart - and
    // the direction is then also emitted in words, because a bare minus sign on
    // a liquidation distance is the one number here a model can invert.
    priceDropToLiquidationPercent: toPercent(position.priceVariationToLiquidationPrice),
    priceDropToLiquidationDirection: priceMoveDirection(toPercent(position.priceVariationToLiquidationPrice)),
    margin: projectSigned(position.margin, loanSymbol),
    borrowPnl: projectSigned(position.borrowPnl, loanSymbol),
    borrowRoePercent: toPercent(position.borrowRoe),
    asOfTimestamp: position.timestamp,
  };
}

export interface ProjectedVaultPositionRow {
  positionId: string;
  vault: {
    address: string;
    version: string;
    name: string | null;
    symbol: string | null;
    chainId: number;
    chain: string | null;
    listed: boolean;
  };
  asset: ReturnType<typeof projectAsset>;
  assets: ProjectedAmount | null;
  /** Share balance in SHARE units, which are NOT the asset's units and carry no scale. */
  shares: ProjectedShareQuantity | null;
  pnl: ProjectedSignedAmount | null;
  roePercent: number | null;
  /** NET of the curator's fee. Never comparable with a market supply APY. */
  netApyPercent: number | null;
  apyPercent: number | null;
  asOfTimestamp: number | null;
}

export function projectVaultPosition(position: MorphoVaultPosition): ProjectedVaultPositionRow {
  return {
    positionId: position.id,
    vault: {
      address: position.vaultAddress,
      version: position.vaultVersion,
      name: position.vaultName,
      symbol: position.vaultSymbol,
      chainId: position.chainId,
      chain: position.chainName,
      listed: position.vaultListed,
    },
    asset: projectAsset(position.asset),
    assets: projectAmount(position.assets, position.asset.symbol),
    shares: projectShareQuantity(position.shares),
    pnl: projectSigned(position.pnl, position.asset.symbol),
    roePercent: toPercent(position.roe),
    netApyPercent: toPercent(position.netApy),
    apyPercent: toPercent(position.apy),
    asOfTimestamp: position.timestamp,
  };
}

export interface ProjectedPortfolioTotals {
  collateralUsd: number | null;
  suppliedUsd: number | null;
  borrowedUsd: number | null;
  vaultDepositsUsd: number | null;
  /** Supplied + collateral + vault deposits, less debt. Oracle estimate throughout. */
  netUsd: number | null;
  /** Rows whose USD mark was missing and therefore contributed nothing to a total. */
  rowsWithoutUsd: number;
}

/**
 * Portfolio totals in USD.
 *
 * A missing mark is COUNTED, not treated as zero. Silently summing over an
 * unpriced row understates a portfolio by exactly the amount nobody could see,
 * and a total that is quietly incomplete is worse than one that says how many
 * rows it could not price. When a row existed and could NOT be priced the total
 * is null rather than 0, because those are different answers.
 *
 * NOTHING TO PRICE IS NOT THE SAME AS COULD NOT PRICE. A wallet with no
 * positions holds exactly zero, and reporting that as null beside
 * `rowsWithoutUsd: 0` reads as "the total could not be computed" - which sent a
 * live agent looking for a failure that never happened. So the null answer is
 * reserved for the case that earns it: at least one row existed and none of them
 * carried a mark.
 */
export function projectPortfolioTotals(
  marketPositions: readonly MorphoMarketPosition[],
  vaultPositions: readonly MorphoVaultPosition[],
): ProjectedPortfolioTotals {
  let collateral = 0;
  let supplied = 0;
  let borrowed = 0;
  let deposits = 0;
  let priced = 0;
  let unpriced = 0;

  for (const position of marketPositions) {
    for (const [amount, add] of [
      [position.collateral, (v: number) => (collateral += v)] as const,
      [position.supply, (v: number) => (supplied += v)] as const,
      [position.borrow, (v: number) => (borrowed += v)] as const,
    ]) {
      if (amount === null || amount.raw === "0") continue;
      if (amount.usd === null) unpriced += 1;
      else {
        add(amount.usd);
        priced += 1;
      }
    }
  }

  for (const position of vaultPositions) {
    if (position.assets.raw === "0") continue;
    if (position.assets.usd === null) unpriced += 1;
    else {
      deposits += position.assets.usd;
      priced += 1;
    }
  }

  if (priced === 0 && unpriced > 0) {
    return {
      collateralUsd: null,
      suppliedUsd: null,
      borrowedUsd: null,
      vaultDepositsUsd: null,
      netUsd: null,
      rowsWithoutUsd: unpriced,
    };
  }
  return {
    collateralUsd: collateral,
    suppliedUsd: supplied,
    borrowedUsd: borrowed,
    vaultDepositsUsd: deposits,
    netUsd: collateral + supplied + deposits - borrowed,
    rowsWithoutUsd: unpriced,
  };
}
