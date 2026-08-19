/**
 * Validators for the vault reads, both generations.
 *
 * The tolerant/strict split from `./_shared.ts` decides what a row costs, on the
 * same rule the market lane uses: a missing name, an unpriced asset or an absent
 * APY is a display gap and the row survives with a null, while a missing vault
 * address, chain id, asset address, asset DECIMALS or total-assets figure is
 * fatal to that row. A vault whose asset scale is unknown cannot have its TVL
 * shown to an agent that may size a deposit against it.
 *
 * TWO shapes are read into ONE type here, and the differences are structural
 * rather than cosmetic:
 *
 *   V1 (`Vault` / MetaMorpho) nests every number and every role under `state`,
 *   has a single global `timelock`, has no gating mechanism at all, and reports
 *   its allocations as `state.allocation[]` with a per-market supply cap.
 *
 *   V2 (`VaultV2`) is FLAT, splits its fee into `performanceFee` and
 *   `managementFee`, carries a per-function `timelocks[]` table instead of one
 *   number, exposes four transfer GATES that can block a deposit or a
 *   withdrawal, and reports allocations through a `caps[]` union whose
 *   market-bearing member is `MarketV1CapData`.
 *
 * The unified {@link MorphoVault} keeps `version` on every row so nothing
 * downstream has to infer which shape it is looking at, and every field a
 * generation genuinely does not have is `null` rather than a plausible default.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import type {
  MorphoAsset,
  MorphoRawAmount,
  MorphoVault,
  MorphoVaultAdapter,
  MorphoVaultAllocation,
  MorphoVaultApy,
  MorphoVaultCurator,
  MorphoVaultDetail,
  MorphoVaultFees,
  MorphoVaultGate,
  MorphoVaultGating,
  MorphoVaultPage,
  MorphoVaultReward,
  MorphoVaultTimelock,
} from "../types.js";
import {
  isRecord,
  readArray,
  readAsset,
  readDisplayBigIntString,
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
import { morphoInvalidResponse } from "./markets.js";

/** The four V2 transfer gates, and which side of the flow each one blocks. */
const V2_GATES = [
  { key: "receiveSharesGate", name: "receiveShares", side: "deposit" },
  { key: "sendAssetsGate", name: "sendAssets", side: "deposit" },
  { key: "sendSharesGate", name: "sendShares", side: "withdrawal" },
  { key: "receiveAssetsGate", name: "receiveAssets", side: "withdrawal" },
] as const;

/** Raised when the caller named a vault Morpho does not have on that chain. */
export function morphoVaultNotFound(detail: string): VexError {
  return new VexError(
    ErrorCodes.MORPHO_VAULT_NOT_FOUND,
    `Morpho has no vault at that address on that chain: ${detail}`,
    "Vault addresses are chain-scoped, and a V1 vault address is not readable as a V2 vault or the reverse. "
    + "Confirm both the address and the chain with morpho.vaults.discover before reading one.",
  );
}

// -- Leaf readers ---------------------------------------------------

function readRewards(raw: unknown[]): MorphoVaultReward[] {
  const rewards: MorphoVaultReward[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const asset = readAsset(entry["asset"]);
    // An APR with no identifiable token is not information an agent can act on:
    // it is denominated in something, and "something" is not a currency.
    if (asset === null) continue;
    rewards.push({ asset, supplyApr: readDisplayNumber(entry["supplyApr"]) });
  }
  return rewards;
}

function readCurators(raw: unknown[]): MorphoVaultCurator[] {
  const curators: MorphoVaultCurator[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = readDisplayString(entry["id"]);
    const name = readDisplayString(entry["name"]);
    if (id === null && name === null) continue;
    curators.push({ id, name, verified: readDisplayBool(entry["verified"]) });
  }
  return curators;
}

/** An address nested one level down, as V2 wraps every role in an `Account`. */
function readNestedAddress(source: Record<string, unknown>, key: string): string | null {
  const nested = readRecord(source, key);
  return nested === null ? null : requireAddress(nested["address"]);
}

function amount(raw: string | null, decimals: number, usd: number | null): MorphoRawAmount | null {
  return raw === null ? null : { raw, decimals, usd };
}

function readApy(source: Record<string, unknown>): MorphoVaultApy {
  return {
    apy: readDisplayNumber(source["apy"]),
    netApy: readDisplayNumber(source["netApy"]),
    netApyExcludingRewards: readDisplayNumber(source["netApyExcludingRewards"]),
    avgNetApy: readDisplayNumber(source["avgNetApy"]),
    avgNetApyExcludingRewards: readDisplayNumber(source["avgNetApyExcludingRewards"]),
    rewards: [],
  };
}

/**
 * V2 gating.
 *
 * A gate with a non-null `address` routes that transfer through a contract that
 * can refuse it. `abdicated` is the opposite assurance: the curator permanently
 * gave up the right to ever install one. Both travel to the agent, because
 * "currently open" and "can never be closed" are different promises.
 */
function readGating(raw: unknown): MorphoVaultGating | null {
  if (!isRecord(raw)) return null;
  const gates: MorphoVaultGate[] = [];
  let depositGated = false;
  let withdrawalGated = false;
  for (const { key, name, side } of V2_GATES) {
    const config = readRecord(raw, key);
    const address = config === null ? null : requireAddress(config["address"]);
    gates.push({ name, address, abdicated: config !== null && readDisplayBool(config["abdicated"]) });
    if (address === null) continue;
    if (side === "deposit") depositGated = true;
    else withdrawalGated = true;
  }
  return { gated: depositGated || withdrawalGated, depositGated, withdrawalGated, gates };
}

// -- Rows -----------------------------------------------------------

/** One V1 vault row, or `null` when an identity or scale field is unusable. */
export function readVaultV1(raw: unknown): MorphoVault | null {
  if (!isRecord(raw)) return null;
  const address = requireAddress(raw["address"]);
  const chain = readRecord(raw, "chain");
  const chainId = chain === null ? null : requireChainId(chain["id"]);
  const asset = readAsset(raw["asset"]);
  const state = readRecord(raw, "state");
  if (address === null || chainId === null || asset === null || state === null) return null;
  const totalAssetsRaw = requireBigIntString(state["totalAssets"]);
  if (totalAssetsRaw === null) return null;

  const apy = readApy(state);
  apy.rewards = readRewards(readArray(state, "allRewards"));
  const fees: MorphoVaultFees = {
    performance: readDisplayNumber(state["fee"]),
    management: null,
    performanceRecipient: requireAddress(state["feeRecipient"]),
    managementRecipient: null,
  };

  return {
    address,
    version: "v1",
    chainId,
    name: readDisplayString(raw["name"]),
    symbol: readDisplayString(raw["symbol"]),
    listed: readDisplayBool(raw["listed"]),
    creationTimestamp: readDisplayNumber(raw["creationTimestamp"]),
    asset,
    totalAssets: {
      raw: totalAssetsRaw,
      decimals: asset.decimals,
      usd: readDisplayNumber(state["totalAssetsUsd"]),
    },
    totalSupplyRaw: readDisplayBigIntString(state["totalSupply"]),
    // V1 exposes withdrawable liquidity only on the detail read, never on a list
    // row. Reporting the vault's total assets here instead would be a claim that
    // all of it can be withdrawn, which is exactly what it is not.
    liquidity: readV1Liquidity(raw, asset),
    sharePrice: readDisplayNumber(state["sharePriceNumber"]),
    apy,
    fees,
    curatorAddress: requireAddress(state["curator"]),
    curators: readCurators(readArray(state, "curators")),
    ownerAddress: requireAddress(state["owner"]),
    timelockSeconds: readDisplayNumber(state["timelock"]),
    gating: null,
    vaultType: null,
    warnings: readWarnings(readArray(raw, "warnings")),
  };
}

function readV1Liquidity(raw: Record<string, unknown>, asset: MorphoAsset): MorphoRawAmount | null {
  const liquidity = readRecord(raw, "liquidity");
  if (liquidity === null) return null;
  return amount(
    readDisplayBigIntString(liquidity["underlying"]),
    asset.decimals,
    readDisplayNumber(liquidity["usd"]),
  );
}

/** One V2 vault row, or `null` when an identity or scale field is unusable. */
export function readVaultV2(raw: unknown): MorphoVault | null {
  if (!isRecord(raw)) return null;
  const address = requireAddress(raw["address"]);
  const chain = readRecord(raw, "chain");
  const chainId = chain === null ? null : requireChainId(chain["id"]);
  const asset = readAsset(raw["asset"]);
  if (address === null || chainId === null || asset === null) return null;
  const totalAssetsRaw = requireBigIntString(raw["totalAssets"]);
  if (totalAssetsRaw === null) return null;

  const apy = readApy(raw);
  apy.rewards = readRewards(readArray(raw, "rewards"));
  const curatorList = readRecord(raw, "curators");

  return {
    address,
    version: "v2",
    chainId,
    name: readDisplayString(raw["name"]),
    symbol: readDisplayString(raw["symbol"]),
    listed: readDisplayBool(raw["listed"]),
    creationTimestamp: readDisplayNumber(raw["creationTimestamp"]),
    asset,
    totalAssets: {
      raw: totalAssetsRaw,
      decimals: asset.decimals,
      usd: readDisplayNumber(raw["totalAssetsUsd"]),
    },
    totalSupplyRaw: readDisplayBigIntString(raw["totalSupply"]),
    liquidity: amount(
      readDisplayBigIntString(raw["liquidity"]),
      asset.decimals,
      readDisplayNumber(raw["liquidityUsd"]),
    ),
    sharePrice: readDisplayNumber(raw["sharePrice"]),
    apy,
    fees: {
      performance: readDisplayNumber(raw["performanceFee"]),
      management: readDisplayNumber(raw["managementFee"]),
      performanceRecipient: requireAddress(raw["performanceFeeRecipient"]),
      managementRecipient: requireAddress(raw["managementFeeRecipient"]),
    },
    curatorAddress: readNestedAddress(raw, "curator"),
    curators: readCurators(curatorList === null ? [] : readArray(curatorList, "items")),
    ownerAddress: readNestedAddress(raw, "owner"),
    // V2 has NO single timelock. Its per-function table is on the detail read.
    timelockSeconds: null,
    gating: readGating(raw["gatesConfig"]),
    vaultType: readDisplayString(raw["type"]),
    warnings: readWarnings(readArray(raw, "warnings")),
  };
}

/** `vaults` / `vaultV2s` -> a validated page, dropped rows carried, never hidden. */
export function validateMorphoVaultPage(body: unknown, version: "v1" | "v2"): MorphoVaultPage {
  const rootKey = version === "v1" ? "vaults" : "vaultV2s";
  const data = isRecord(body) ? readRecord(body, "data") : null;
  const root = data === null ? null : readRecord(data, rootKey);
  if (root === null) {
    throw morphoInvalidResponse(`the response carried no \`data.${rootKey}\` block.`);
  }

  const items = readArray(root, "items");
  const read = version === "v1" ? readVaultV1 : readVaultV2;
  const rows: MorphoVault[] = [];
  let dropped = 0;
  for (const item of items) {
    const vault = read(item);
    if (vault === null) dropped += 1;
    else rows.push(vault);
  }
  if (items.length > 0 && rows.length === 0) {
    throw morphoInvalidResponse(`all ${items.length} ${rootKey} rows failed identity or decimals validation.`);
  }

  const pageInfo = readRecord(root, "pageInfo");
  return {
    vaults: rows,
    countTotal: pageInfo === null ? rows.length : (readDisplayNumber(pageInfo["countTotal"]) ?? rows.length),
    droppedRows: dropped,
  };
}

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
function readV1Allocations(raw: unknown[]): MorphoVaultAllocation[] {
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
function readV2Allocations(raw: unknown[]): MorphoVaultAllocation[] {
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

function readAdapters(raw: unknown[]): MorphoVaultAdapter[] {
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

function readTimelocks(raw: unknown[]): MorphoVaultTimelock[] {
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
function readPaginatedCount(source: Record<string, unknown>, key: string): number {
  const block = readRecord(source, key);
  const pageInfo = block === null ? null : readRecord(block, "pageInfo");
  return pageInfo === null ? 0 : (readDisplayNumber(pageInfo["countTotal"]) ?? 0);
}

// -- Detail ---------------------------------------------------------

export interface MorphoVaultDetailOptions {
  includeAllocations: boolean;
}

/** `vaultByAddress` -> a validated V1 detail, or a named refusal. */
export function validateMorphoVaultV1Detail(body: unknown, options: MorphoVaultDetailOptions): MorphoVaultDetail {
  const raw = readDetailRoot(body, "vaultByAddress");
  const base = readVaultV1(raw);
  if (base === null) throw morphoInvalidResponse("the V1 vault row failed identity or decimals validation.");
  const state = readRecord(raw, "state") ?? {};

  return {
    ...base,
    guardianAddress: requireAddress(state["guardian"]),
    pendingOwnerAddress: requireAddress(state["pendingOwner"]),
    allocatorAddresses: readAddressList(readArray(raw, "allocators"), "address"),
    sentinelAddresses: [],
    skimRecipient: requireAddress(state["skimRecipient"]),
    timelocks: [],
    pendingConfigCount: readPaginatedCount(state, "pendingConfigs"),
    allocations: options.includeAllocations ? readV1Allocations(readArray(state, "allocation")) : null,
    adapters: [],
    idleAssets: null,
    forceDeallocatableLiquidityRaw: null,
    maxApy: null,
  };
}

/** `vaultV2ByAddress` -> a validated V2 detail, or a named refusal. */
export function validateMorphoVaultV2Detail(body: unknown, options: MorphoVaultDetailOptions): MorphoVaultDetail {
  const raw = readDetailRoot(body, "vaultV2ByAddress");
  const base = readVaultV2(raw);
  if (base === null) throw morphoInvalidResponse("the V2 vault row failed identity or decimals validation.");
  const caps = readRecord(raw, "caps");
  const adapters = readRecord(raw, "adapters");

  return {
    ...base,
    // V2 replaces the single guardian with a list of sentinels.
    guardianAddress: null,
    pendingOwnerAddress: null,
    allocatorAddresses: readNestedAddressList(readArray(raw, "allocators"), "allocator"),
    sentinelAddresses: readNestedAddressList(readArray(raw, "sentinels"), "sentinel"),
    skimRecipient: null,
    timelocks: readTimelocks(readArray(raw, "timelocks")),
    pendingConfigCount: readPaginatedCount(raw, "pendingConfigs"),
    allocations: options.includeAllocations
      ? readV2Allocations(caps === null ? [] : readArray(caps, "items"))
      : null,
    adapters: readAdapters(adapters === null ? [] : readArray(adapters, "items")),
    idleAssets: amount(
      readDisplayBigIntString(raw["idleAssets"]),
      base.asset.decimals,
      readDisplayNumber(raw["idleAssetsUsd"]),
    ),
    forceDeallocatableLiquidityRaw: readDisplayBigIntString(raw["forceDeallocatableLiquidity"]),
    maxApy: readDisplayNumber(raw["maxApy"]),
  };
}

/**
 * Pull the detail object out of the body.
 *
 * Morpho answers an unknown vault with HTTP 200, `data: null`, and an
 * `errors[]` entry whose `status` is `NOT_FOUND` (measured 2026-08-14). The
 * client routes that shape here rather than to the generic GraphQL-refusal
 * mapping, so "no such vault" never reaches the agent dressed as a schema break.
 */
function readDetailRoot(body: unknown, key: string): Record<string, unknown> {
  const data = isRecord(body) ? readRecord(body, "data") : null;
  const raw = data === null ? null : data[key];
  if (!isRecord(raw)) {
    throw morphoInvalidResponse(`the response carried no readable \`data.${key}\` object.`);
  }
  return raw;
}

function readAddressList(raw: unknown[], key: string): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const address = requireAddress(entry[key]);
    if (address !== null && !out.includes(address)) out.push(address);
  }
  return out;
}

function readNestedAddressList(raw: unknown[], key: string): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const address = readNestedAddress(entry, key);
    if (address !== null && !out.includes(address)) out.push(address);
  }
  return out;
}
