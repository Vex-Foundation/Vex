/**
 * Projection of validated Morpho MARKET reads into agent-facing rows.
 *
 * The two disciplines rules/90 makes non-negotiable for this protocol live in
 * `./_shared.ts` (money always `{raw, decimals, symbol, human, usd}`, USD always
 * labelled an oracle estimate); this file owns the market-shaped APY contract.
 *
 * APY. A supply APY excluding rewards, a supply APY including rewards, and a
 * reward APR denominated in a third token are three DIFFERENT numbers that look
 * identical once printed. They are never emitted under a shared name here. Each
 * field carries its basis in its own key (`supplyApyPercent` = base,
 * `netSupplyApyPercent` = net), rewards are a separate list keyed by their own
 * token, and the block carries an explicit `basis` note the agent can quote.
 */

import { morphoChainSlug } from "@tools/morpho/chains.js";
import { wadToPercent } from "@tools/morpho/request.js";
import type {
  MorphoApyWindow,
  MorphoMarket,
  MorphoMarketApy,
  MorphoMarketDetail,
} from "@tools/morpho/types.js";
import {
  formatRawAmount,
  projectAmount,
  projectAsset,
  projectStandalone,
  toPercent,
  type ProjectedAmount,
  type ProjectedAsset,
} from "./_shared.js";

/** The sentence every APY block is qualified by. */
export const MORPHO_APY_DISCLAIMER =
  "APY bases are NOT comparable unqualified: `supplyApyPercent`/`borrowApyPercent` EXCLUDE incentives, "
  + "`netSupplyApyPercent`/`netBorrowApyPercent` INCLUDE them, and each `rewards[]` entry is an APR paid in its own "
  + "token, whose value can move independently. Never compare a net figure against a base figure.";

export interface ProjectedApy {
  basis: string;
  supplyApyPercent: number | null;
  netSupplyApyPercent: number | null;
  borrowApyPercent: number | null;
  netBorrowApyPercent: number | null;
  apyAtTargetPercent: number | null;
  rewards: Array<{
    tokenAddress: string;
    symbol: string | null;
    decimals: number;
    supplyAprPercent: number | null;
    borrowAprPercent: number | null;
  }>;
}

function projectApy(apy: MorphoMarketApy): ProjectedApy {
  return {
    basis: MORPHO_APY_DISCLAIMER,
    supplyApyPercent: toPercent(apy.supplyApy),
    netSupplyApyPercent: toPercent(apy.netSupplyApy),
    borrowApyPercent: toPercent(apy.borrowApy),
    netBorrowApyPercent: toPercent(apy.netBorrowApy),
    apyAtTargetPercent: toPercent(apy.apyAtTarget),
    rewards: apy.rewards.map((reward) => ({
      tokenAddress: reward.asset.address,
      symbol: reward.asset.symbol,
      decimals: reward.asset.decimals,
      supplyAprPercent: toPercent(reward.supplyApr),
      borrowAprPercent: toPercent(reward.borrowApr),
    })),
  };
}

export function projectApyWindow(window: MorphoApyWindow | null, lookback: string): Record<string, unknown> | null {
  if (window === null) return null;
  return {
    lookback,
    basis: MORPHO_APY_DISCLAIMER,
    supplyApyPercent: toPercent(window.supplyApy),
    netSupplyApyPercent: toPercent(window.netSupplyApy),
    borrowApyPercent: toPercent(window.borrowApy),
    netBorrowApyPercent: toPercent(window.netBorrowApy),
  };
}

export interface ProjectedMarketRow {
  marketId: string;
  chain: string | null;
  chainId: number;
  listed: boolean;
  lltvPercent: number;
  loanAsset: ProjectedAsset;
  collateralAsset: ProjectedAsset | null;
  /** True when the market has no collateral leg at all and can only be supplied to. */
  idle: boolean;
  utilizationPercent: number | null;
  feePercent: number | null;
  supply: ProjectedAmount | null;
  borrow: ProjectedAmount | null;
  collateral: ProjectedAmount | null;
  liquidity: {
    available: ProjectedAmount | null;
    /** What a Public Allocator reallocation could add on top of `available`. */
    reallocatable: ProjectedAmount | null;
  };
  apy: ProjectedApy | null;
  oracle: { address: string; type: string | null } | null;
  irmAddress: string;
  warnings: Array<{ type: string; level: string }>;
  stateAsOf: string | null;
}

/** One validated market -> one agent-facing row. */
export function projectMarketRow(market: MorphoMarket): ProjectedMarketRow {
  const loanSymbol = market.loanAsset.symbol;
  const collateralSymbol = market.collateralAsset?.symbol ?? null;
  const state = market.state;
  return {
    marketId: market.marketId,
    chain: morphoChainSlug(market.chainId) ?? null,
    chainId: market.chainId,
    listed: market.listed,
    lltvPercent: wadToPercent(market.lltv),
    loanAsset: {
      address: market.loanAsset.address,
      symbol: loanSymbol,
      decimals: market.loanAsset.decimals,
      priceUsd: market.loanAsset.priceUsd,
    },
    collateralAsset: projectAsset(market.collateralAsset),
    idle: market.collateralAsset === null,
    utilizationPercent: toPercent(state?.utilization ?? null),
    feePercent: toPercent(state?.fee ?? null),
    supply: projectAmount(state?.supply ?? null, loanSymbol),
    borrow: projectAmount(state?.borrow ?? null, loanSymbol),
    collateral: projectAmount(state?.collateral ?? null, collateralSymbol),
    liquidity: {
      available: projectAmount(state?.liquidity ?? null, loanSymbol),
      reallocatable: projectStandalone(market.reallocatableLiquidityRaw, market.loanAsset),
    },
    apy: state === null ? null : projectApy(state.apy),
    oracle: market.oracle,
    irmAddress: market.irmAddress,
    warnings: market.warnings,
    stateAsOf: state?.timestamp === null || state?.timestamp === undefined
      ? null
      : new Date(state.timestamp * 1_000).toISOString(),
  };
}

/**
 * Detail projection: the discovery row plus everything only `marketById`
 * returns. Bad debt is denominated in the LOAN asset; the oracle price carries
 * its own scale, since a bare 39-digit integer is not readable without one.
 */
export function projectMarketDetail(detail: MorphoMarketDetail, lookback: string): Record<string, unknown> {
  const row = projectMarketRow(detail);
  return {
    ...row,
    badDebt: {
      outstanding: projectStandalone(detail.badDebtRaw, detail.loanAsset),
      outstandingUsd: detail.badDebtUsd,
      realized: projectStandalone(detail.realizedBadDebtRaw, detail.loanAsset),
      realizedUsd: detail.realizedBadDebtUsd,
      note:
        "Bad debt is borrowed value the market could not liquidate. Outstanding bad debt is socialised across "
        + "suppliers of this market - a non-zero figure means supplying here has already lost principal.",
    },
    oraclePrice:
      detail.oraclePriceRaw === null || detail.oraclePriceScaleDecimals === null
        ? null
        : {
            raw: detail.oraclePriceRaw,
            scaleDecimals: detail.oraclePriceScaleDecimals,
            human: formatRawAmount(detail.oraclePriceRaw, detail.oraclePriceScaleDecimals),
            note:
              "Collateral priced in loan-asset units, scaled by 36 + loanDecimals - collateralDecimals. "
              + "This is the price liquidations are decided against.",
          },
    liquidity: {
      ...row.liquidity,
      total: projectAmount(detail.totalLiquidity, detail.loanAsset.symbol),
      publicAllocatorByVault: detail.sharedLiquidity.map((entry) => ({
        vaultAddress: entry.vaultAddress,
        vaultName: entry.vaultName,
        assets: {
          raw: entry.assetsRaw,
          decimals: detail.loanAsset.decimals,
          symbol: detail.loanAsset.symbol,
          human: formatRawAmount(entry.assetsRaw, detail.loanAsset.decimals),
          usd: null,
        },
      })),
      note:
        "`available` is borrowable right now. `reallocatable` and `publicAllocatorByVault` are extra liquidity a "
        + "Public Allocator reallocation COULD move in - it is not committed and can be gone by the next block.",
    },
    supplyingVaults:
      detail.supplyingVaults === null
        ? null
        : {
            note:
              "A vault's `netApyPercent` is NET of the vault's fee and is not the same basis as this market's "
              + "`supplyApyPercent`. Do not rank the two against each other.",
            vaults: detail.supplyingVaults.map((vault) => ({
              address: vault.address,
              name: vault.name,
              netApyPercent: toPercent(vault.netApy),
            })),
          },
    apyWindow: projectApyWindow(detail.apyWindow, lookback),
  };
}

/** Keep only the requested field groups. `undefined` keeps the whole row. */
export function selectMarketFields(
  row: ProjectedMarketRow,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  if (fields === undefined) return { ...row };
  const kept: Record<string, unknown> = { marketId: row.marketId, chain: row.chain, chainId: row.chainId };
  for (const field of fields) {
    switch (field) {
      case "identity":
        Object.assign(kept, { listed: row.listed, lltvPercent: row.lltvPercent, idle: row.idle, stateAsOf: row.stateAsOf });
        break;
      case "assets":
        Object.assign(kept, { loanAsset: row.loanAsset, collateralAsset: row.collateralAsset });
        break;
      case "apy":
        Object.assign(kept, { apy: row.apy });
        break;
      case "size":
        Object.assign(kept, {
          supply: row.supply,
          borrow: row.borrow,
          collateral: row.collateral,
          liquidity: row.liquidity,
          utilizationPercent: row.utilizationPercent,
        });
        break;
      case "risk":
        Object.assign(kept, {
          warnings: row.warnings,
          oracle: row.oracle,
          irmAddress: row.irmAddress,
          feePercent: row.feePercent,
          lltvPercent: row.lltvPercent,
        });
        break;
    }
  }
  return kept;
}
