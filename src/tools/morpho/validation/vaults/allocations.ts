/**
 * How a vault's money is actually deployed, for both generations.
 *
 * Split out of `../vaults.ts` because it moves for its own reason: V1 reports
 * allocations as `state.allocation[]` with a per-market supply cap, while V2
 * reports a `caps[]` UNION whose market-bearing member is `MarketV1CapData` and
 * whose adapter and timelock tables have no V1 equivalent at all. Nothing here is
 * needed to read a vault's identity, size or APY.
 */

import type {
  MorphoVaultAdapter,
  MorphoVaultAllocation,
  MorphoVaultTimelock,
} from "../../types.js";
import {
  isRecord,
  readArray,
  readAsset,
  readDisplayBigIntString,
  readDisplayBool,
  readDisplayNumber,
  readDisplayString,
  readRecord,
  requireAddress,
  requireBigIntString,
  requireMarketIdField,
} from "../_shared.js";

// -- Allocations ----------------------------------------------------

/** Fields a market carries wherever it appears inside a vault's allocation view. */
function readAllocationMarket(raw: unknown): Pick<
  MorphoVaultAllocation,
  "marketId" | "lltv" | "marketListed" | "loanAsset" | "collateralAsset"
  | "marketSupplyApy" | "marketNetSupplyApy" | "marketUtilization"
> | null {
  if (!isRecord(raw)) return null;
  const marketId = requireMarketIdField(raw["marketId"]);
  const lltv = requireBigIntString(raw["lltv"]);
  if (marketId === null || lltv === null) return null;
  const state = readRecord(raw, "state");
  return {
    marketId,
    lltv,
    marketListed: readDisplayBool(raw["listed"]),
    loanAsset: readAsset(raw["loanAsset"]),
    collateralAsset: readAsset(raw["collateralAsset"]),
    marketSupplyApy: state === null ? null : readDisplayNumber(state["supplyApy"]),
    marketNetSupplyApy: state === null ? null : readDisplayNumber(state["netSupplyApy"]),
    marketUtilization: state === null ? null : readDisplayNumber(state["utilization"]),
  };
}

/**
 * V1 `state.allocation[]`.
 *
 * Amounts are denominated in the MARKET's loan asset, which for a well-formed
 * vault is the vault's own asset - but the market's own decimals are used rather
 * than the vault's, because a mismatch is a defect to surface and not one to
 * paper over with the wrong scale.
 */
export function readV1Allocations(raw: unknown[]): MorphoVaultAllocation[] {
  const allocations: MorphoVaultAllocation[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const market = readAllocationMarket(entry["market"]);
    if (market === null) continue;
    allocations.push({
      ...market,
      suppliedRaw: readDisplayBigIntString(entry["supplyAssets"]),
      suppliedUsd: readDisplayNumber(entry["supplyAssetsUsd"]),
      capRaw: readDisplayBigIntString(entry["supplyCap"]),
      capUsd: readDisplayNumber(entry["supplyCapUsd"]),
      pendingCapRaw: readDisplayBigIntString(entry["pendingSupplyCap"]),
      pendingCapValidAt: readDisplayNumber(entry["pendingSupplyCapValidAt"]),
      relativeCapWad: null,
      supplyQueueIndex: readDisplayNumber(entry["supplyQueueIndex"]),
      withdrawQueueIndex: readDisplayNumber(entry["withdrawQueueIndex"]),
      removableAt: readDisplayNumber(entry["removableAt"]),
    });
  }
  return allocations;
}

/**
 * V2 `caps[]`, restricted to the members that name a market.
 *
 * `VaultV2CapData` is a UNION. `CollateralCapData` and `AdapterCapData` carry no
 * market at all, so they are skipped rather than rendered as allocations with
 * empty market fields: a cap on "everything routed through an adapter" is a
 * different object from "this vault supplies market X", and merging the two
 * would overstate how many markets the vault is actually exposed to.
 */
export function readV2Allocations(raw: unknown[]): MorphoVaultAllocation[] {
  const allocations: MorphoVaultAllocation[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const data = readRecord(entry, "data");
    if (data === null || data["__typename"] !== "MarketV1CapData") continue;
    const market = readAllocationMarket(data["market"]);
    if (market === null) continue;
    allocations.push({
      ...market,
      suppliedRaw: readDisplayBigIntString(entry["allocation"]),
      suppliedUsd: null,
      capRaw: readDisplayBigIntString(entry["absoluteCap"]),
      capUsd: null,
      pendingCapRaw: null,
      pendingCapValidAt: null,
      relativeCapWad: readDisplayBigIntString(entry["relativeCap"]),
      supplyQueueIndex: null,
      withdrawQueueIndex: null,
      removableAt: null,
    });
  }
  return allocations;
}

export function readAdapters(raw: unknown[]): MorphoVaultAdapter[] {
  const adapters: MorphoVaultAdapter[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const address = requireAddress(entry["address"]);
    if (address === null) continue;
    adapters.push({
      address,
      type: readDisplayString(entry["type"]),
      assetsRaw: readDisplayBigIntString(entry["assets"]),
      assetsUsd: readDisplayNumber(entry["assetsUsd"]),
      forceDeallocatePenaltyWad: readDisplayBigIntString(entry["forceDeallocatePenalty"]),
    });
  }
  return adapters;
}

export function readTimelocks(raw: unknown[]): MorphoVaultTimelock[] {
  const timelocks: MorphoVaultTimelock[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const functionName = readDisplayString(entry["functionName"]);
    if (functionName === null) continue;
    timelocks.push({
      functionName,
      durationSeconds: readDisplayNumber(entry["duration"]),
      abdicatedAt: readDisplayNumber(entry["abdicatedAt"]),
    });
  }
  return timelocks;
}

/** `pageInfo.countTotal` on a paginated sub-field, or 0. Never the item list. */
export function readPaginatedCount(source: Record<string, unknown>, key: string): number {
  const block = readRecord(source, key);
  const pageInfo = block === null ? null : readRecord(block, "pageInfo");
  return pageInfo === null ? 0 : (readDisplayNumber(pageInfo["countTotal"]) ?? 0);
}
