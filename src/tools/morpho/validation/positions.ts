/**
 * Validators for the three position reads: Blue market positions, V1 vault
 * positions, and one V2 vault position.
 *
 * The tolerant/strict split from `./_shared.ts` applies unchanged, with ONE
 * addition this lane forced and one asymmetry it must encode.
 *
 * SIGNED AMOUNTS. `margin`, `borrowPnl` and vault `pnl` are `BigInt` scalars
 * that go negative on a losing position (measured 2026-08-14:
 * `margin: -23633633`, `borrowPnl: -24648763` on a live Ethereum row).
 * {@link readSignedBigIntString} accepts the sign; the unsigned money reader
 * still refuses it, so a balance field can never absorb a negative by accident.
 *
 * THE HEALTH-FACTOR ASYMMETRY. Morpho returns `healthFactor: null` on every
 * supply-only row, because a position with no debt has nothing to liquidate.
 * That null is CORRECT and the row survives. A row that HAS borrow shares and
 * still reports no health factor is a different animal: the one number that
 * decides whether the position is about to be taken is missing, so the row is
 * dropped and counted rather than shown as if the risk were unknowable. The two
 * cases look identical in the JSON and must not be handled identically.
 */

import type {
  MorphoMarketPosition,
  MorphoMarketPositionPage,
  MorphoPositionMarketRef,
  MorphoRawAmount,
  MorphoSignedAmount,
  MorphoVaultPosition,
  MorphoVaultPositionPage,
} from "../types.js";
import {
  isRecord,
  readArray,
  readAsset,
  readDisplayBool,
  readDisplayNumber,
  readDisplayString,
  readRecord,
  readWarnings,
  requireAddress,
  requireBigIntString,
  requireChainId,
  requireMarketIdField,
} from "./_shared.js";
import { describeGraphqlErrors, morphoInvalidResponse } from "./markets.js";

const SIGNED_DIGITS_PATTERN = /^-?\d+$/;

/**
 * Strict SIGNED `BigInt` scalar, normalised to a decimal string.
 *
 * Accepts the two forms Morpho emits for a signed field - a digits string with
 * an optional `-`, and a safe-integer number of either sign - and nothing else.
 * A number past `Number.MAX_SAFE_INTEGER` has already lost precision before it
 * reached us, so it is refused rather than laundered into a PnL figure.
 */
export function readSignedBigIntString(v: unknown): string | null {
  if (typeof v === "string") return SIGNED_DIGITS_PATTERN.test(v) ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) ? String(v) : null;
  return null;
}

function readSignedAmount(
  state: Record<string, unknown>,
  rawKey: string,
  usdKey: string,
  decimals: number,
): MorphoSignedAmount | null {
  const raw = readSignedBigIntString(state[rawKey]);
  if (raw === null) return null;
  return { raw, decimals, usd: readDisplayNumber(state[usdKey]) };
}

/** An unsigned balance. A wrong value here is worse than no value, so it drops to null. */
function readBalance(
  state: Record<string, unknown>,
  rawKey: string,
  usdKey: string,
  decimals: number,
): MorphoRawAmount | null {
  const raw = requireBigIntString(state[rawKey]);
  if (raw === null) return null;
  return { raw, decimals, usd: readDisplayNumber(state[usdKey]) };
}

/** The market reference carried on a position row. Strict on everything an amount needs. */
function readPositionMarket(raw: unknown): MorphoPositionMarketRef | null {
  if (!isRecord(raw)) return null;
  const marketId = requireMarketIdField(raw["marketId"]);
  const loanAsset = readAsset(raw["loanAsset"]);
  const chain = readRecord(raw, "chain");
  const chainId = chain === null ? null : requireChainId(chain["id"]);
  const lltv = requireBigIntString(raw["lltv"]);
  if (marketId === null || loanAsset === null || chainId === null || lltv === null) return null;
  return {
    marketId,
    chainId,
    chainName: chain === null ? null : readDisplayString(chain["network"]),
    lltv,
    listed: readDisplayBool(raw["listed"]),
    loanAsset,
    collateralAsset: readAsset(raw["collateralAsset"]),
    warnings: readWarnings(readArray(raw, "warnings")),
  };
}

/**
 * One `MarketPosition`, or `null` for the caller to drop and count.
 *
 * A row is dropped when its identity, its market, or the decimals any amount
 * needs cannot be read - and when it carries debt without a health factor, per
 * the asymmetry described at the top of this file.
 */
export function readMarketPosition(raw: unknown): MorphoMarketPosition | null {
  if (!isRecord(raw)) return null;
  const id = readDisplayString(raw["id"]);
  const user = readRecord(raw, "user");
  const userAddress = user === null ? null : requireAddress(user["address"]);
  const market = readPositionMarket(raw["market"]);
  const state = readRecord(raw, "state");
  if (id === null || userAddress === null || market === null || state === null) return null;

  const loanDecimals = market.loanAsset.decimals;
  const supply = readBalance(state, "supplyAssets", "supplyAssetsUsd", loanDecimals);
  const borrow = readBalance(state, "borrowAssets", "borrowAssetsUsd", loanDecimals);
  if (supply === null || borrow === null) return null;

  const borrowShares = requireBigIntString(state["borrowShares"]);
  const healthFactor = readDisplayNumber(raw["healthFactor"]);
  const hasDebt = borrowShares !== null && borrowShares !== "0";
  if (hasDebt && healthFactor === null) return null;

  const collateralDecimals = market.collateralAsset?.decimals ?? null;
  return {
    id,
    userAddress,
    market,
    healthFactor,
    priceVariationToLiquidationPrice: readDisplayNumber(raw["priceVariationToLiquidationPrice"]),
    marketListed: market.listed,
    timestamp: readDisplayNumber(state["timestamp"]),
    collateral:
      collateralDecimals === null ? null : readBalance(state, "collateral", "collateralUsd", collateralDecimals),
    supply,
    borrow,
    supplyShares: requireBigIntString(state["supplyShares"]),
    borrowShares,
    margin: readSignedAmount(state, "margin", "marginUsd", loanDecimals),
    borrowPnl: readSignedAmount(state, "borrowPnl", "borrowPnlUsd", loanDecimals),
    borrowRoe: readDisplayNumber(state["borrowRoe"]),
  };
}

export function validateMorphoMarketPositionPage(body: unknown): MorphoMarketPositionPage {
  const data = isRecord(body) ? readRecord(body, "data") : null;
  const page = data === null ? null : readRecord(data, "marketPositions");
  if (page === null) {
    throw morphoInvalidResponse(
      `${describeGraphqlErrors(body) ?? "the response carried no \`data.marketPositions\` block"}.`,
    );
  }

  const items = readArray(page, "items");
  const rows: MorphoMarketPosition[] = [];
  let dropped = 0;
  for (const item of items) {
    const row = readMarketPosition(item);
    if (row === null) dropped += 1;
    else rows.push(row);
  }
  if (items.length > 0 && rows.length === 0) {
    throw morphoInvalidResponse(
      `all ${items.length} market position rows failed identity, decimals or health-factor validation.`,
    );
  }
  return { positions: rows, ...readPageInfo(page, rows.length), droppedRows: dropped };
}

// -- Vault positions ------------------------------------------------

/** One V1 `VaultPosition`. The vault's own asset supplies every decimals value. */
export function readVaultPositionV1(raw: unknown): MorphoVaultPosition | null {
  if (!isRecord(raw)) return null;
  const vault = readRecord(raw, "vault");
  const state = readRecord(raw, "state");
  if (vault === null || state === null) return null;
  const chain = readRecord(vault, "chain");
  const vaultState = readRecord(vault, "state");
  return buildVaultPosition({
    id: readDisplayString(raw["id"]),
    userRecord: readRecord(raw, "user"),
    vaultAddress: requireAddress(vault["address"]),
    vaultName: readDisplayString(vault["name"]),
    vaultSymbol: readDisplayString(vault["symbol"]),
    vaultListed: readDisplayBool(vault["listed"]),
    version: "v1",
    chainId: chain === null ? null : requireChainId(chain["id"]),
    chainName: chain === null ? null : readDisplayString(chain["network"]),
    asset: readAsset(vault["asset"]),
    amounts: state,
    timestamp: readDisplayNumber(state["timestamp"]),
    apy: vaultState === null ? null : readDisplayNumber(vaultState["apy"]),
    netApy: vaultState === null ? null : readDisplayNumber(vaultState["netApy"]),
  });
}

/**
 * One `VaultV2Position`. Same product to a depositor, different JSON: V2 puts
 * the amounts on the position itself rather than under `state`, and the APYs on
 * the vault rather than under `vault.state`.
 */
export function readVaultPositionV2(raw: unknown): MorphoVaultPosition | null {
  if (!isRecord(raw)) return null;
  const vault = readRecord(raw, "vault");
  if (vault === null) return null;
  const chain = readRecord(raw, "chain");
  return buildVaultPosition({
    id: readDisplayString(raw["id"]),
    userRecord: readRecord(raw, "user"),
    vaultAddress: requireAddress(vault["address"]),
    vaultName: readDisplayString(vault["name"]),
    vaultSymbol: readDisplayString(vault["symbol"]),
    vaultListed: readDisplayBool(vault["listed"]),
    version: "v2",
    chainId: chain === null ? null : requireChainId(chain["id"]),
    chainName: chain === null ? null : readDisplayString(chain["network"]),
    asset: readAsset(vault["asset"]),
    amounts: raw,
    timestamp: null,
    apy: readDisplayNumber(vault["apy"]),
    netApy: readDisplayNumber(vault["netApy"]),
  });
}

interface VaultPositionParts {
  id: string | null;
  userRecord: Record<string, unknown> | null;
  vaultAddress: string | null;
  vaultName: string | null;
  vaultSymbol: string | null;
  vaultListed: boolean;
  version: "v1" | "v2";
  chainId: number | null;
  chainName: string | null;
  asset: ReturnType<typeof readAsset>;
  /** The record carrying `assets`, `shares` and `pnl` in this generation's shape. */
  amounts: Record<string, unknown>;
  timestamp: number | null;
  apy: number | null;
  netApy: number | null;
}

function buildVaultPosition(parts: VaultPositionParts): MorphoVaultPosition | null {
  const userAddress = parts.userRecord === null ? null : requireAddress(parts.userRecord["address"]);
  if (
    parts.id === null
    || userAddress === null
    || parts.vaultAddress === null
    || parts.chainId === null
    || parts.asset === null
  ) {
    return null;
  }
  const assets = readBalance(parts.amounts, "assets", "assetsUsd", parts.asset.decimals);
  if (assets === null) return null;
  return {
    id: parts.id,
    userAddress,
    vaultAddress: parts.vaultAddress,
    vaultName: parts.vaultName,
    vaultSymbol: parts.vaultSymbol,
    vaultListed: parts.vaultListed,
    vaultVersion: parts.version,
    chainId: parts.chainId,
    chainName: parts.chainName,
    asset: parts.asset,
    timestamp: parts.timestamp,
    assets,
    shares: requireBigIntString(parts.amounts["shares"]),
    pnl: readSignedAmount(parts.amounts, "pnl", "pnlUsd", parts.asset.decimals),
    roe: readDisplayNumber(parts.amounts["roe"]),
    apy: parts.apy,
    netApy: parts.netApy,
  };
}

export function validateMorphoVaultPositionPage(body: unknown): MorphoVaultPositionPage {
  const data = isRecord(body) ? readRecord(body, "data") : null;
  const page = data === null ? null : readRecord(data, "vaultPositions");
  if (page === null) {
    throw morphoInvalidResponse(
      `${describeGraphqlErrors(body) ?? "the response carried no \`data.vaultPositions\` block"}.`,
    );
  }

  const items = readArray(page, "items");
  const rows: MorphoVaultPosition[] = [];
  let dropped = 0;
  for (const item of items) {
    const row = readVaultPositionV1(item);
    if (row === null) dropped += 1;
    else rows.push(row);
  }
  if (items.length > 0 && rows.length === 0) {
    throw morphoInvalidResponse(`all ${items.length} vault position rows failed identity or decimals validation.`);
  }
  return { positions: rows, ...readPageInfo(page, rows.length), droppedRows: dropped };
}

/**
 * One V2 position, or `null` when the wallet holds nothing in that vault.
 *
 * Null is a legitimate ANSWER here rather than a failure: the lane asks about
 * vaults the wallet once transacted with, and a fully exited position resolves
 * to `null` on a query that is otherwise perfectly valid.
 */
export function validateMorphoVaultV2Position(body: unknown): MorphoVaultPosition | null {
  const data = isRecord(body) ? readRecord(body, "data") : null;
  if (data === null) {
    throw morphoInvalidResponse(`${describeGraphqlErrors(body) ?? "the response carried no `data` block"}.`);
  }
  const raw = data["vaultV2PositionByAddress"];
  if (raw === null || raw === undefined) return null;
  const position = readVaultPositionV2(raw);
  if (position === null) {
    throw morphoInvalidResponse("the V2 vault position failed identity or decimals validation.");
  }
  return position;
}

/**
 * Distinct `(vaultAddress, chainId)` pairs a wallet has transacted with, newest
 * first, plus how much of its history was actually scanned.
 */
export function validateMorphoVaultV2UserVaults(body: unknown): {
  vaults: { address: string; chainId: number }[];
  scanned: number;
  total: number;
} {
  const data = isRecord(body) ? readRecord(body, "data") : null;
  const page = data === null ? null : readRecord(data, "vaultV2transactions");
  if (page === null) {
    throw morphoInvalidResponse(
      `${describeGraphqlErrors(body) ?? "the response carried no \`data.vaultV2transactions\` block"}.`,
    );
  }
  const items = readArray(page, "items");
  const seen = new Set<string>();
  const vaults: { address: string; chainId: number }[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const vault = readRecord(item, "vault");
    if (vault === null) continue;
    const address = requireAddress(vault["address"]);
    const chain = readRecord(vault, "chain");
    const chainId = chain === null ? null : requireChainId(chain["id"]);
    if (address === null || chainId === null) continue;
    const key = `${chainId}:${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    vaults.push({ address, chainId });
  }
  const pageInfo = readPageInfo(page, items.length);
  return { vaults, scanned: items.length, total: pageInfo.countTotal };
}

/** `pageInfo`, with the returned-row count as the fallback for every field. */
function readPageInfo(
  page: Record<string, unknown>,
  fallback: number,
): { countTotal: number; count: number; limit: number; skip: number } {
  const info = readRecord(page, "pageInfo");
  if (info === null) return { countTotal: fallback, count: fallback, limit: fallback, skip: 0 };
  return {
    countTotal: readDisplayNumber(info["countTotal"]) ?? fallback,
    count: readDisplayNumber(info["count"]) ?? fallback,
    limit: readDisplayNumber(info["limit"]) ?? fallback,
    skip: readDisplayNumber(info["skip"]) ?? 0,
  };
}
