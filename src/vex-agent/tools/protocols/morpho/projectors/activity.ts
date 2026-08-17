/**
 * Projection of validated Morpho market transactions into agent-facing rows.
 *
 * TWO THINGS ARE DELIBERATELY ABSENT and their absence is the contract.
 *
 * NO USD. Morpho serves no USD figure on a transaction row, and the market's
 * `price.usd` on the same response is TODAY's mark rather than the price at the
 * block. Multiplying a historical amount by a current price and presenting the
 * product as what happened would be inventing a number, so every amount here
 * travels as {raw, decimals, symbol, human} with no USD at all, and the reply
 * says why.
 *
 * NO INFERRED TYPE. The row's `type` and the union member Morpho returned are
 * both passed through. They agree on every observed row; that is an observation
 * rather than a guarantee, and a reader that needs to know which amounts exist
 * should branch on the shape that arrived.
 *
 * Morpho's PascalCase type names are mapped back to this tree's camelCase
 * vocabulary so the value in a row matches the value the caller may filter on.
 * An unmapped member is passed through verbatim rather than dropped or renamed:
 * a transaction kind Vex has not met yet is still something that happened.
 */

import { MORPHO_ACTIVITY_TYPES } from "@tools/morpho/request.js";
import type { MorphoActivityAmount, MorphoMarketTransaction } from "@tools/morpho/types.js";
import {
  formatRawAmount,
  projectAsset,
  projectShareQuantity,
  type ProjectedShareQuantity,
} from "./_shared.js";

/** The sentence every activity reply is qualified by. */
export const MORPHO_ACTIVITY_USD_NOTE =
  "Transaction rows carry NO USD value. Morpho does not serve a price at the block for a historical transfer, and "
  + "pricing an old amount at today's mark would report a number that never existed. Each amount is given in its "
  + "own asset with the decimals needed to read it; convert only against a price you have for the right moment.";

export const MORPHO_ACTIVITY_HISTORY_NOTE =
  "This is a record of what happened, not a signal about what to do. Frequent or large liquidations on a market, "
  + "and especially liquidations leaving bad debt, say the market's oracle or its liquidity already failed somebody "
  + "there. Quiet activity on a large market and busy activity on a tiny one are both normal, so read volume "
  + "alongside the market's size rather than on its own.";

const MORPHO_TYPE_TO_CANONICAL = new Map<string, string>(
  Object.entries(MORPHO_ACTIVITY_TYPES).map(([canonical, morpho]) => [morpho, canonical]),
);

export interface ProjectedActivityAmount {
  raw: string;
  decimals: number;
  symbol: string | null;
  human: string;
  /** Which of the market's two legs this amount is denominated in. */
  asset: "loan" | "collateral";
}

function projectActivityAmount(amount: MorphoActivityAmount): ProjectedActivityAmount {
  return {
    raw: amount.raw,
    decimals: amount.decimals,
    symbol: amount.symbol,
    human: formatRawAmount(amount.raw, amount.decimals),
    asset: amount.asset,
  };
}

export interface ProjectedActivityRow {
  type: string;
  /** The union member Morpho actually returned, which decides which amounts exist. */
  dataShape: string;
  txHash: string;
  chainId: number;
  chain: string | null;
  timestamp: number | null;
  isoTime: string | null;
  blockNumber: string | null;
  logIndex: number | null;
  /** The account whose position moved. On a liquidation this is the BORROWER. */
  userAddress: string;
  /** Only on a liquidation row: who repaid the debt and took the collateral. */
  liquidatorAddress: string | null;
  market: {
    marketId: string;
    lltvPercent: number;
    listed: boolean;
    pair: string;
  };
  loanAsset: ReturnType<typeof projectAsset>;
  collateralAsset: ReturnType<typeof projectAsset>;
  amounts: Record<string, ProjectedActivityAmount>;
  /** Share legs, each carrying its scale explicitly - which here is UNKNOWN. */
  shares: Record<string, ProjectedShareQuantity>;
}

export function projectActivityRow(tx: MorphoMarketTransaction): ProjectedActivityRow {
  const amounts: Record<string, ProjectedActivityAmount> = {};
  for (const [key, amount] of Object.entries(tx.amounts)) amounts[key] = projectActivityAmount(amount);
  const shares: Record<string, ProjectedShareQuantity> = {};
  for (const [key, raw] of Object.entries(tx.shares)) {
    const quantity = projectShareQuantity(raw);
    if (quantity !== null) shares[key] = quantity;
  }
  return {
    type: MORPHO_TYPE_TO_CANONICAL.get(tx.type) ?? tx.type,
    dataShape: tx.dataShape,
    txHash: tx.txHash,
    chainId: tx.chainId,
    chain: tx.chainName,
    timestamp: tx.timestamp,
    isoTime: tx.timestamp === null ? null : new Date(tx.timestamp * 1_000).toISOString(),
    blockNumber: tx.blockNumber,
    logIndex: tx.logIndex,
    userAddress: tx.userAddress,
    liquidatorAddress: tx.liquidatorAddress,
    market: {
      marketId: tx.marketId,
      lltvPercent: Number(tx.lltv) / 1e16,
      listed: tx.marketListed,
      pair: `${tx.collateralAsset?.symbol ?? "idle"}/${tx.loanAsset.symbol ?? "?"}`,
    },
    loanAsset: projectAsset(tx.loanAsset),
    collateralAsset: projectAsset(tx.collateralAsset),
    amounts,
    shares,
  };
}

export interface ActivityBreakdown {
  byType: Record<string, number>;
  liquidations: number;
  /** Liquidations that left debt nobody can repay. The number that matters most. */
  liquidationsWithBadDebt: number;
}

/**
 * Counts over the RETURNED page, not over the whole match set.
 *
 * Named that way in the reply as well: a breakdown computed from one page and
 * read as a market-wide rate would overstate or understate whatever the sort
 * key happened to bring to the top.
 */
export function summariseActivity(rows: readonly ProjectedActivityRow[]): ActivityBreakdown {
  const byType: Record<string, number> = {};
  let liquidations = 0;
  let withBadDebt = 0;
  for (const row of rows) {
    byType[row.type] = (byType[row.type] ?? 0) + 1;
    if (row.dataShape !== "MarketTransactionLiquidationData") continue;
    liquidations += 1;
    const badDebt = row.amounts["badDebtAssets"];
    if (badDebt !== undefined && badDebt.raw !== "0") withBadDebt += 1;
  }
  return { byType, liquidations, liquidationsWithBadDebt: withBadDebt };
}
