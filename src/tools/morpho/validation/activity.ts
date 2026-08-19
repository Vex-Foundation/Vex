/**
 * Validator for `marketTransactions`.
 *
 * The tolerant/strict split from `./_shared.ts` holds, and this lane adds one
 * rule of its own: AN AMOUNT IS ONLY EMITTED WITH THE ASSET THAT SCALES IT.
 *
 * Which asset that is changes per union branch. A supply, withdraw, borrow or
 * repay moves the LOAN asset. A collateral transfer moves the COLLATERAL asset.
 * A liquidation moves both at once: `repaidAssets` and `badDebtAssets` are loan
 * units, `seizedAssets` is collateral units. Live rows on 2026-08-14 make the
 * hazard concrete - one liquidation carried `repaidAssets: 12004` at 6 decimals
 * next to `seizedAssets: "38708708374333048"` at 18. Read with the wrong scale,
 * a twelve-thousandth of a dollar and four hundredths of a token swap places.
 *
 * So a row whose required asset is missing has that amount OMITTED rather than
 * emitted bare, and a liquidation row that cannot produce its repaid or seized
 * amount is dropped entirely and counted: a liquidation reported without what
 * was taken is worse than a liquidation not reported, because the agent reads
 * the row as a small event.
 *
 * The `__typename` decides the branch, not the row's `type` string. They agree
 * on every observed row; that is an observation, not a contract we may lean on.
 */

import type { MorphoActivityAmount, MorphoActivityPage, MorphoAsset, MorphoMarketTransaction } from "../types.js";
import {
  isRecord,
  readArray,
  readAsset,
  readDisplayBool,
  readDisplayBigIntString,
  readDisplayNumber,
  readDisplayString,
  readRecord,
  requireAddress,
  requireBigIntString,
  requireChainId,
  requireMarketIdField,
} from "./_shared.js";
import { describeGraphqlErrors, morphoInvalidResponse } from "./markets.js";

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** A transaction hash is this row's identity. A row without one cannot be cited. */
function requireTxHash(v: unknown): string | null {
  return typeof v === "string" && TX_HASH_PATTERN.test(v) ? v.toLowerCase() : null;
}

function amountIn(raw: unknown, asset: MorphoAsset | null, leg: "loan" | "collateral"): MorphoActivityAmount | null {
  if (asset === null) return null;
  const value = requireBigIntString(raw);
  if (value === null) return null;
  return { raw: value, decimals: asset.decimals, symbol: asset.symbol, asset: leg };
}

interface TransactionAmounts {
  amounts: Record<string, MorphoActivityAmount>;
  shares: Record<string, string>;
  liquidatorAddress: string | null;
  /** True when a branch could not produce an amount the row is meaningless without. */
  incomplete: boolean;
}

/**
 * Pull the amounts out of whichever union member arrived.
 *
 * An unrecognised `__typename` is not a failure: the row keeps its identity,
 * type and market and reports no amounts, which is honest. A schema that grew a
 * fourth member should degrade to "we saw this happen but cannot size it", not
 * to a hidden row.
 */
function readTransactionAmounts(
  data: Record<string, unknown>,
  loanAsset: MorphoAsset,
  collateralAsset: MorphoAsset | null,
): TransactionAmounts {
  const shape = readDisplayString(data["__typename"]);
  const amounts: Record<string, MorphoActivityAmount> = {};
  const shares: Record<string, string> = {};

  if (shape === "MarketTransactionTransferData") {
    const assets = amountIn(data["assets"], loanAsset, "loan");
    if (assets === null) return { amounts, shares, liquidatorAddress: null, incomplete: true };
    amounts["assets"] = assets;
    const sharesValue = readDisplayBigIntString(data["shares"]);
    if (sharesValue !== null) shares["shares"] = sharesValue;
    return { amounts, shares, liquidatorAddress: null, incomplete: false };
  }

  if (shape === "MarketTransactionCollateralTransferData") {
    const assets = amountIn(data["assets"], collateralAsset, "collateral");
    if (assets === null) return { amounts, shares, liquidatorAddress: null, incomplete: true };
    amounts["assets"] = assets;
    return { amounts, shares, liquidatorAddress: null, incomplete: false };
  }

  if (shape === "MarketTransactionLiquidationData") {
    const repaid = amountIn(data["repaidAssets"], loanAsset, "loan");
    const seized = amountIn(data["seizedAssets"], collateralAsset, "collateral");
    // Both halves are required. "Someone was liquidated" without what was repaid
    // and what was taken is the shape of a risk signal with the risk removed.
    if (repaid === null || seized === null) return { amounts, shares, liquidatorAddress: null, incomplete: true };
    amounts["repaidAssets"] = repaid;
    amounts["seizedAssets"] = seized;
    const badDebt = amountIn(data["badDebtAssets"], loanAsset, "loan");
    if (badDebt !== null) amounts["badDebtAssets"] = badDebt;
    for (const key of ["repaidShares", "badDebtShares"]) {
      const value = readDisplayBigIntString(data[key]);
      if (value !== null) shares[key] = value;
    }
    return {
      amounts,
      shares,
      liquidatorAddress: requireAddress(data["liquidator"]),
      incomplete: false,
    };
  }

  return { amounts, shares, liquidatorAddress: null, incomplete: false };
}

/** One `MarketTransaction`, or `null` for the caller to drop and count. */
export function readMarketTransaction(raw: unknown): MorphoMarketTransaction | null {
  if (!isRecord(raw)) return null;
  const txHash = requireTxHash(raw["txHash"]);
  const type = readDisplayString(raw["type"]);
  const market = readRecord(raw, "market");
  const chain = readRecord(raw, "chain");
  const chainId = chain === null ? null : requireChainId(chain["id"]);
  const user = readRecord(raw, "user");
  const userAddress = user === null ? null : requireAddress(user["address"]);
  if (txHash === null || type === null || market === null || chainId === null || userAddress === null) return null;

  const marketId = requireMarketIdField(market["marketId"]);
  const loanAsset = readAsset(market["loanAsset"]);
  const lltv = requireBigIntString(market["lltv"]);
  if (marketId === null || loanAsset === null || lltv === null) return null;
  const collateralAsset = readAsset(market["collateralAsset"]);

  const data = readRecord(raw, "data");
  const parsed =
    data === null
      ? { amounts: {}, shares: {}, liquidatorAddress: null, incomplete: true }
      : readTransactionAmounts(data, loanAsset, collateralAsset);
  if (parsed.incomplete) return null;

  return {
    txHash,
    chainId,
    chainName: chain === null ? null : readDisplayString(chain["network"]),
    timestamp: readDisplayNumber(raw["timestamp"]),
    blockNumber: readDisplayBigIntString(raw["blockNumber"]),
    txIndex: readDisplayNumber(raw["txIndex"]),
    logIndex: readDisplayNumber(raw["logIndex"]),
    type,
    dataShape: data === null ? "unknown" : (readDisplayString(data["__typename"]) ?? "unknown"),
    userAddress,
    marketId,
    marketListed: readDisplayBool(market["listed"]),
    lltv,
    loanAsset,
    collateralAsset,
    amounts: parsed.amounts,
    shares: parsed.shares,
    liquidatorAddress: parsed.liquidatorAddress,
  };
}

export function validateMorphoActivityPage(body: unknown): MorphoActivityPage {
  const data = isRecord(body) ? readRecord(body, "data") : null;
  const page = data === null ? null : readRecord(data, "marketTransactions");
  if (page === null) {
    throw morphoInvalidResponse(
      `${describeGraphqlErrors(body) ?? "the response carried no \`data.marketTransactions\` block"}.`,
    );
  }

  const items = readArray(page, "items");
  const rows: MorphoMarketTransaction[] = [];
  let dropped = 0;
  for (const item of items) {
    const row = readMarketTransaction(item);
    if (row === null) dropped += 1;
    else rows.push(row);
  }
  if (items.length > 0 && rows.length === 0) {
    throw morphoInvalidResponse(`all ${items.length} transaction rows failed identity or amount validation.`);
  }

  const info = readRecord(page, "pageInfo");
  const fallback = rows.length;
  return {
    transactions: rows,
    countTotal: info === null ? fallback : (readDisplayNumber(info["countTotal"]) ?? fallback),
    count: info === null ? fallback : (readDisplayNumber(info["count"]) ?? fallback),
    limit: info === null ? fallback : (readDisplayNumber(info["limit"]) ?? fallback),
    skip: info === null ? 0 : (readDisplayNumber(info["skip"]) ?? 0),
    droppedRows: dropped,
  };
}
