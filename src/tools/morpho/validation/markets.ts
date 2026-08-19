/**
 * Validators for the two market reads.
 *
 * The tolerant/strict split from `./_shared.ts` decides what a row costs. A
 * missing symbol or an unpriced asset is a display gap and the row survives with
 * a null. A missing market id, chain id, loan-asset address or loan-asset
 * DECIMALS is fatal to that row: an amount whose scale is unknown cannot be
 * shown to an agent that may size a position against it, so the row is dropped
 * and COUNTED. A page where every row drops raises rather than returning an
 * empty result that reads as "no markets matched".
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import type {
  MorphoApyWindow,
  MorphoMarket,
  MorphoMarketApy,
  MorphoMarketDetail,
  MorphoMarketPage,
  MorphoMarketReward,
  MorphoMarketState,
  MorphoOracleInfo,
  MorphoRawAmount,
  MorphoSharedLiquidity,
  MorphoSupplyingVault,
} from "../types.js";
import { MORPHO_LOOKBACKS, type MorphoLookback } from "../request.js";
import {
  isRecord,
  readArray,
  readAsset,
  readWarnings,
  readDisplayBigIntString,
  readDisplayBool,
  readDisplayNumber,
  readDisplayString,
  readRecord,
  requireAddress,
  requireBigIntString,
  requireChainId,
  requireMarketIdField,
  sumRawAmounts,
} from "./_shared.js";

/** Raise when the whole response is unusable. Never raised for a single bad row. */
/**
 * "No such market on that chain", as a named domain refusal.
 *
 * Reached two ways that must produce the SAME error. Morpho normally answers a
 * nonexistent market id with HTTP 200, `data: null` and `errors[NOT_FOUND]`,
 * which the client's `notFound` hook maps here; a body that instead carries a
 * null `marketById` under a present `data` reaches it from the validator below.
 * A market id is chain-scoped, so the remediation names the chain as a suspect
 * alongside the id itself.
 */
export function morphoMarketNotFound(): VexError {
  return new VexError(
    ErrorCodes.MORPHO_MARKET_NOT_FOUND,
    "Morpho has no market with that id on that chain.",
    "Market ids are chain-scoped - confirm both with morpho.markets.discover before reading one.",
  );
}

export function morphoInvalidResponse(detail: string): VexError {
  return new VexError(
    ErrorCodes.MORPHO_INVALID_RESPONSE,
    `Morpho returned a response Vex could not read: ${detail}`,
    "Morpho publishes no SLA and deprecates GraphQL fields on a live schedule. "
    + "Report the failure rather than retrying unchanged - the same query returns the same shape.",
  );
}

// -- Leaf readers ---------------------------------------------------

function readRewards(raw: unknown[]): MorphoMarketReward[] {
  const rewards: MorphoMarketReward[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const asset = readAsset(entry["asset"]);
    // A reward whose token cannot be identified is dropped rather than reported
    // as an unattributed APR: "1% extra" with no token name is not information
    // an agent can act on, and the two APRs are in DIFFERENT tokens.
    if (asset === null) continue;
    rewards.push({
      asset,
      supplyApr: readDisplayNumber(entry["supplyApr"]),
      borrowApr: readDisplayNumber(entry["borrowApr"]),
    });
  }
  return rewards;
}

function readOracle(raw: unknown): MorphoOracleInfo | null {
  if (!isRecord(raw)) return null;
  const address = requireAddress(raw["address"]);
  if (address === null) return null;
  return { address, type: readDisplayString(raw["type"]) };
}

/**
 * A raw amount plus its decimals and USD mark. `decimals` comes from the ASSET
 * the amount is denominated in, never from the amount's own field - that pairing
 * is the whole point of the shape.
 */
function readAmount(
  state: Record<string, unknown>,
  rawKey: string,
  usdKey: string,
  decimals: number,
): MorphoRawAmount | null {
  const raw = requireBigIntString(state[rawKey]);
  if (raw === null) return null;
  return { raw, decimals, usd: readDisplayNumber(state[usdKey]) };
}

function readApy(state: Record<string, unknown>): MorphoMarketApy {
  return {
    supplyApy: readDisplayNumber(state["supplyApy"]),
    netSupplyApy: readDisplayNumber(state["netSupplyApy"]),
    borrowApy: readDisplayNumber(state["borrowApy"]),
    netBorrowApy: readDisplayNumber(state["netBorrowApy"]),
    apyAtTarget: readDisplayNumber(state["apyAtTarget"]),
    rewards: readRewards(readArray(state, "rewards")),
  };
}

/**
 * Market state. Returns `null` (state absent) rather than dropping the market:
 * a market with no state row is still a real market with a real oracle, LLTV and
 * asset pair, and the caller reports the missing state honestly.
 */
function readState(raw: unknown, loanDecimals: number, collateralDecimals: number | null): MorphoMarketState | null {
  if (!isRecord(raw)) return null;
  const supply = readAmount(raw, "supplyAssets", "supplyAssetsUsd", loanDecimals);
  const borrow = readAmount(raw, "borrowAssets", "borrowAssetsUsd", loanDecimals);
  const liquidity = readAmount(raw, "liquidityAssets", "liquidityAssetsUsd", loanDecimals);
  if (supply === null || borrow === null || liquidity === null) return null;
  return {
    timestamp: readDisplayNumber(raw["timestamp"]),
    blockNumber: readDisplayBigIntString(raw["blockNumber"]),
    supply,
    borrow,
    // Collateral is denominated in the COLLATERAL asset; an idle market has none.
    collateral:
      collateralDecimals === null ? null : readAmount(raw, "collateralAssets", "collateralAssetsUsd", collateralDecimals),
    liquidity,
    utilization: readDisplayNumber(raw["utilization"]),
    fee: readDisplayNumber(raw["fee"]),
    apy: readApy(raw),
  };
}

// -- Market rows ----------------------------------------------------

/** One market row, or `null` when an identity or scale field is unusable. */
export function readMarket(raw: unknown): MorphoMarket | null {
  if (!isRecord(raw)) return null;
  const marketId = requireMarketIdField(raw["marketId"]);
  const chain = readRecord(raw, "chain");
  const chainId = chain === null ? null : requireChainId(chain["id"]);
  const lltv = requireBigIntString(raw["lltv"]);
  const irmAddress = requireAddress(raw["irmAddress"]);
  const loanAsset = readAsset(raw["loanAsset"]);
  if (marketId === null || chainId === null || lltv === null || irmAddress === null || loanAsset === null) {
    return null;
  }
  const collateralAsset = readAsset(raw["collateralAsset"]);
  return {
    marketId,
    chainId,
    lltv,
    listed: readDisplayBool(raw["listed"]),
    irmAddress,
    creationTimestamp: readDisplayNumber(raw["creationTimestamp"]),
    loanAsset,
    collateralAsset,
    oracle: readOracle(raw["oracle"]),
    warnings: readWarnings(readArray(raw, "warnings")),
    reallocatableLiquidityRaw: readDisplayBigIntString(raw["reallocatableLiquidityAssets"]),
    state: readState(raw["state"], loanAsset.decimals, collateralAsset?.decimals ?? null),
  };
}

/** `markets` -> a validated page, with the dropped-row count carried, never hidden. */
export function validateMorphoMarketPage(body: unknown): MorphoMarketPage {
  const data = isRecord(body) ? readRecord(body, "data") : null;
  const markets = data === null ? null : readRecord(data, "markets");
  if (markets === null) return emptyPageOrRaise(body);

  const items = readArray(markets, "items");
  const rows: MorphoMarket[] = [];
  let dropped = 0;
  for (const item of items) {
    const market = readMarket(item);
    if (market === null) dropped += 1;
    else rows.push(market);
  }
  if (items.length > 0 && rows.length === 0) {
    throw morphoInvalidResponse(`all ${items.length} market rows failed identity or decimals validation.`);
  }

  const pageInfo = readRecord(markets, "pageInfo");
  return {
    markets: rows,
    countTotal: pageInfo === null ? rows.length : (readDisplayNumber(pageInfo["countTotal"]) ?? rows.length),
    count: pageInfo === null ? rows.length : (readDisplayNumber(pageInfo["count"]) ?? rows.length),
    limit: pageInfo === null ? rows.length : (readDisplayNumber(pageInfo["limit"]) ?? rows.length),
    skip: pageInfo === null ? 0 : (readDisplayNumber(pageInfo["skip"]) ?? 0),
    droppedRows: dropped,
  };
}

/**
 * A body with no `data.markets` is only usable when GraphQL said WHY. The
 * provider's own message survives to the error rather than being replaced by a
 * guess about what went wrong.
 */
function emptyPageOrRaise(body: unknown): never {
  throw morphoInvalidResponse(`${describeGraphqlErrors(body) ?? "the response carried no `data.markets` block"}.`);
}

/** Join GraphQL `errors[].message`, bounded, for the error path only. */
export function describeGraphqlErrors(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const errors = readArray(body, "errors");
  const messages: string[] = [];
  for (const entry of errors) {
    if (!isRecord(entry)) continue;
    const message = readDisplayString(entry["message"]);
    if (message !== null) messages.push(message);
  }
  return messages.length > 0 ? messages.join("; ") : null;
}

// -- Market detail --------------------------------------------------

/**
 * Morpho Blue scales an oracle price by `36 + loanDecimals - collateralDecimals`.
 * Returned alongside the raw price so it is readable, in keeping with the rule
 * that a raw number travels with the scale needed to read it.
 */
function oracleScaleDecimals(loanDecimals: number, collateralDecimals: number | null): number | null {
  if (collateralDecimals === null) return null;
  return 36 + loanDecimals - collateralDecimals;
}

/**
 * `publicAllocatorSharedLiquidity` lists ONE ROW PER withdraw-market pair, so a
 * single vault appears many times - eight rows for one Steakhouse vault in the
 * 2026-08-14 fixture. Summing per vault is the only reading that answers the
 * agent's actual question ("how much could each vault reallocate in"); reporting
 * the rows verbatim would invite double counting.
 */
function readSharedLiquidity(raw: unknown[]): MorphoSharedLiquidity[] {
  const byVault = new Map<string, { name: string | null; amounts: string[] }>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const assets = requireBigIntString(entry["assets"]);
    const vault = readRecord(entry, "vault");
    const address = vault === null ? null : requireAddress(vault["address"]);
    if (assets === null || address === null) continue;
    const existing = byVault.get(address);
    if (existing) existing.amounts.push(assets);
    else byVault.set(address, { name: readDisplayString(vault?.["name"]), amounts: [assets] });
  }
  return [...byVault.entries()].map(([vaultAddress, { name, amounts }]) => ({
    vaultAddress,
    vaultName: name,
    assetsRaw: sumRawAmounts(amounts),
  }));
}

function readSupplyingVaults(raw: unknown[]): MorphoSupplyingVault[] {
  const vaults: MorphoSupplyingVault[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const address = requireAddress(entry["address"]);
    if (address === null) continue;
    const state = readRecord(entry, "state");
    vaults.push({
      address,
      name: readDisplayString(entry["name"]),
      netApy: state === null ? null : readDisplayNumber(state["netApy"]),
    });
  }
  return vaults;
}

/** Pull one averaging window out of the fixed per-window field names. */
function readApyWindow(state: Record<string, unknown>, lookback: MorphoLookback): MorphoApyWindow {
  const prefix = MORPHO_LOOKBACKS[lookback];
  const capital = (suffix: string): string => `${prefix}${suffix}`;
  return {
    supplyApy: readDisplayNumber(state[capital("SupplyApy")]),
    netSupplyApy: readDisplayNumber(state[capital("NetSupplyApy")]),
    borrowApy: readDisplayNumber(state[capital("BorrowApy")]),
    netBorrowApy: readDisplayNumber(state[capital("NetBorrowApy")]),
  };
}

export interface MorphoMarketDetailOptions {
  includeHistory: boolean;
  lookback: MorphoLookback;
  includeSupplyingVaults: boolean;
}

/** `marketById` -> a validated detail row, or a named refusal. */
export function validateMorphoMarketDetail(body: unknown, options: MorphoMarketDetailOptions): MorphoMarketDetail {
  const data = isRecord(body) ? readRecord(body, "data") : null;
  const raw = data === null ? null : data["marketById"];
  if (raw === null || raw === undefined) {
    const errors = describeGraphqlErrors(body);
    if (errors !== null) throw morphoInvalidResponse(errors);
    throw morphoMarketNotFound();
  }

  const market = readMarket(raw);
  if (market === null || !isRecord(raw)) {
    throw morphoInvalidResponse("the market row failed identity or decimals validation.");
  }

  const badDebt = readRecord(raw, "badDebt");
  const realized = readRecord(raw, "realizedBadDebt");
  const state = readRecord(raw, "state");
  const collateralDecimals = market.collateralAsset?.decimals ?? null;

  return {
    ...market,
    badDebtRaw: badDebt === null ? null : readDisplayBigIntString(badDebt["underlying"]),
    badDebtUsd: badDebt === null ? null : readDisplayNumber(badDebt["usd"]),
    realizedBadDebtRaw: realized === null ? null : readDisplayBigIntString(realized["underlying"]),
    realizedBadDebtUsd: realized === null ? null : readDisplayNumber(realized["usd"]),
    oraclePriceRaw: state === null ? null : readDisplayBigIntString(state["price"]),
    oraclePriceScaleDecimals: oracleScaleDecimals(market.loanAsset.decimals, collateralDecimals),
    totalLiquidity:
      state === null
        ? null
        : readAmount(state, "totalLiquidity", "totalLiquidityUsd", market.loanAsset.decimals),
    sharedLiquidity: readSharedLiquidity(readArray(raw, "publicAllocatorSharedLiquidity")),
    supplyingVaults: options.includeSupplyingVaults ? readSupplyingVaults(readArray(raw, "supplyingVaults")) : null,
    apyWindow: options.includeHistory && state !== null ? readApyWindow(state, options.lookback) : null,
  };
}
