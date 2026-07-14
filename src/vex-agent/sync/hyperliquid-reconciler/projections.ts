import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";

import { normalizeProviderDecimal } from "@tools/hyperliquid/validation.js";
import { parseHyperliquidMarketSnapshot } from "@tools/hyperliquid/market-snapshot.js";
import type { HyperliquidPerpTarget } from "@vex-agent/db/repos/activity.js";
import type { Position } from "@vex-agent/db/repos/open-positions.js";
import type { PositionProtectionSnapshot } from "@vex-agent/tools/protocols/hyperliquid/protection-snapshot.js";

const signedDecimal = z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const unsignedDecimal = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/);

const positionSchema = z.object({
  coin: z.string().min(1),
  szi: signedDecimal,
  entryPx: unsignedDecimal,
  unrealizedPnl: signedDecimal,
  cumFunding: z.object({ sinceOpen: signedDecimal }),
}).passthrough();
const clearinghouseStateSchema = z.object({
  assetPositions: z.array(z.object({ position: positionSchema }).passthrough()),
  marginSummary: z.object({ accountValue: signedDecimal.optional() }).passthrough().optional(),
  crossMarginSummary: z.object({ accountValue: signedDecimal.optional() }).passthrough().optional(),
  withdrawable: unsignedDecimal.optional(),
}).passthrough();
const userFillsSchema = z.array(z.object({ coin: z.string().min(1) }).passthrough());
export type HyperliquidClearinghouseState = z.infer<typeof clearinghouseStateSchema>;
export type HyperliquidUserFills = z.infer<typeof userFillsSchema>;

export function parseHyperliquidClearinghouseState(value: unknown): HyperliquidClearinghouseState {
  return clearinghouseStateSchema.parse(value);
}

export function parseHyperliquidUserFills(value: unknown): HyperliquidUserFills {
  return userFillsSchema.parse(value);
}

export interface OpenCaptureInput {
  readonly walletAddress: string;
  readonly coin: string;
  readonly position: z.infer<typeof positionSchema>;
  readonly markPx: string | undefined;
  readonly account: HyperliquidAccountSnapshot;
  readonly marketWatchlist: readonly HyperliquidMarketWatchlistItem[];
  readonly snapshot: PositionProtectionSnapshot;
  readonly fills: z.infer<typeof userFillsSchema>;
  readonly localPosition: Position | null;
  readonly confirmedAt: string;
  readonly reconcileBucket: number;
}

export function projectOpenCapture(input: OpenCaptureInput): Record<string, unknown> {
  if (input.markPx === undefined) throw new Error(`No mark price for ${input.coin}.`);
  const size = new Decimal(input.position.szi);
  const contracts = size.abs();
  const entryPx = providerUnsigned(input.position.entryPx, `Entry price for ${input.coin}`);
  const markPx = providerUnsigned(input.markPx, `Mark price for ${input.coin}`);
  const currentValueUsd = contracts.mul(markPx).toFixed();
  const unrealizedPnlUsd = new Decimal(input.position.unrealizedPnl)
    .plus(new Decimal(input.position.cumFunding.sinceOpen))
    .toFixed();
  const protectionState = input.snapshot.state;
  const fullPositionStop = input.snapshot.fullPositionStops[0]
    ?? input.snapshot.fixedSizeStops[0];
  const leverage = leverageDetails(input.position);
  const consolidationFailureCount = numericMeta(input.localPosition?.data, "consolidationFailureCount");
  const protectionEscalation = stringMeta(input.localPosition?.data, "protectionEscalation");
  const stableMeta = {
    coin: input.coin,
    contracts: contracts.toFixed(),
    signedSize: size.toFixed(),
    side: size.gt(0) ? "long" : "short",
    entryPx,
    markPx,
    liquidationPx: input.snapshot.liquidationPx,
    ...(fullPositionStop === undefined ? {} : { slPrice: fullPositionStop.triggerPx }),
    ...leverage,
    protectionState,
    cumFundingSinceOpen: input.position.cumFunding.sinceOpen,
    accountEquityUsd: input.account.equityUsd,
    accountWithdrawableUsd: input.account.withdrawableUsd,
    accountTotalUnrealizedPnlUsd: input.account.totalUnrealizedPnlUsd,
    marketWatchlist: input.marketWatchlist,
    reconcileBucket: input.reconcileBucket,
    recentFillCount: input.fills.filter((fill) => fill.coin === input.coin).length,
    ...(consolidationFailureCount > 0 ? { consolidationFailureCount } : {}),
    ...(protectionEscalation === "UNPROTECTED" ? { protectionEscalation } : {}),
  };
  const meta = { ...stableMeta, confirmedAt: input.confirmedAt };
  return {
    type: "perps",
    chain: "hyperliquid",
    status: "open",
    walletAddress: input.walletAddress,
    positionKey: `hyperliquid:perp:${input.coin}:${input.walletAddress}`,
    instrumentKey: `hyperliquid:perp:${input.coin}`,
    inputValueUsd: contracts.mul(entryPx).toFixed(),
    unitPriceUsd: entryPx,
    currentValueUsd,
    unrealizedPnlUsd,
    valuationSource: "hyperliquid_clearinghouse",
    settlementAssetKey: "USDC",
    meta: { ...meta, reconcileVersion: versionFor({ status: "open", currentValueUsd, unrealizedPnlUsd, meta: stableMeta }) },
  };
}

export function projectClosedCapture(
  position: Position,
  coin: string,
  status: "closed" | "liquidated",
): Record<string, unknown> {
  const meta = { coin, contracts: position.contracts ?? "0", protectionState: "FLAT" };
  return {
    type: "perps",
    chain: "hyperliquid",
    status,
    walletAddress: position.walletAddress,
    positionKey: position.positionKey ?? position.externalId ?? `hyperliquid:perp:${coin}:${position.walletAddress}`,
    instrumentKey: position.instrumentKey ?? `hyperliquid:perp:${coin}`,
    valuationSource: "hyperliquid_clearinghouse",
    settlementAssetKey: "USDC",
    meta: { ...meta, reconcileVersion: versionFor({ status, meta }) },
  };
}

export function projectCancelledCapture(
  target: HyperliquidPerpTarget,
  coin: string,
): Record<string, unknown> {
  const meta = { coin, contracts: "0", protectionState: "FLAT" };
  return {
    type: "perps",
    chain: "hyperliquid",
    status: "cancelled",
    walletAddress: target.walletAddress,
    positionKey: target.positionKey,
    instrumentKey: target.instrumentKey ?? `hyperliquid:perp:${coin}`,
    valuationSource: "hyperliquid_clearinghouse",
    settlementAssetKey: "USDC",
    meta: { ...meta, reconcileVersion: versionFor({ status: "cancelled", meta }) },
  };
}


export interface HyperliquidMarketWatchlistItem {
  readonly coin: string;
  readonly midPx: string;
  readonly change24hPct: string | null;
  readonly openInterestUsd: string | null;
}

export interface HyperliquidMarketSnapshot {
  readonly marks: ReadonlyMap<string, string>;
  readonly watchlist: readonly HyperliquidMarketWatchlistItem[];
}

export interface HyperliquidAccountSnapshot {
  readonly equityUsd: string | null;
  readonly withdrawableUsd: string | null;
  readonly totalUnrealizedPnlUsd: string | null;
}

const REQUIRED_WATCHLIST_COINS = new Set(["BTC", "ETH", "SOL", "HYPE"]);
const WATCHLIST_TOP_BY_OPEN_INTEREST = 12;
const WATCHLIST_MAX = 16;

/**
 * Reuse the reconciler's existing metaAndAssetCtxs response for watchlist OI.
 * The main push service supplies fresher mids from allMids; no extra endpoint
 * is added for the renderer. Change is included only when `prevDayPx` is in
 * this already-fetched provider payload.
 */
export function extractMarketSnapshot(response: unknown): HyperliquidMarketSnapshot {
  const markets = parseHyperliquidMarketSnapshot(response);
  const marks = new Map<string, string>();
  const candidates: HyperliquidMarketWatchlistItem[] = [];
  for (const market of markets) {
    marks.set(market.coin, market.markPx);
    candidates.push({
      coin: market.coin,
      midPx: market.markPx,
      change24hPct: market.change24hPct,
      openInterestUsd: market.openInterestUsd,
    });
  }
  candidates.sort((left, right) => {
    const leftOi = left.openInterestUsd === null ? new Decimal(-1) : new Decimal(left.openInterestUsd);
    const rightOi = right.openInterestUsd === null ? new Decimal(-1) : new Decimal(right.openInterestUsd);
    return rightOi.comparedTo(leftOi) || left.coin.localeCompare(right.coin);
  });
  const selected = candidates.slice(0, WATCHLIST_TOP_BY_OPEN_INTEREST);
  const selectedCoins = new Set(selected.map((item) => item.coin));
  for (const requiredCoin of REQUIRED_WATCHLIST_COINS) {
    if (selectedCoins.has(requiredCoin)) continue;
    const required = candidates.find((item) => item.coin === requiredCoin);
    if (required !== undefined) {
      selected.push(required);
      selectedCoins.add(requiredCoin);
    }
  }
  return { marks, watchlist: selected.slice(0, WATCHLIST_MAX) };
}

export function accountSnapshot(
  state: HyperliquidClearinghouseState,
): HyperliquidAccountSnapshot {
  const margin = state.marginSummary ?? state.crossMarginSummary;
  const equityUsd = margin?.accountValue === undefined
    ? null
    : normalizeOptionalProviderDecimal(margin.accountValue) ?? null;
  const withdrawableUsd = state.withdrawable === undefined
    ? null
    : normalizeOptionalProviderDecimal(state.withdrawable) ?? null;
  try {
    const totalUnrealizedPnlUsd = state.assetPositions.reduce(
      (total, item) => total.plus(item.position.unrealizedPnl),
      new Decimal(0),
    ).toFixed();
    return { equityUsd, withdrawableUsd, totalUnrealizedPnlUsd };
  } catch {
    return { equityUsd, withdrawableUsd, totalUnrealizedPnlUsd: null };
  }
}

export function hasOpenOrder(orders: unknown, coin: string): boolean {
  return Array.isArray(orders) && orders.some((order) => {
    const candidate = record(order);
    return candidate?.coin === coin && candidate.reduceOnly !== true;
  });
}
export function coinForPosition(position: Position): string | null {
  const dataCoin = typeof position.data.coin === "string" ? position.data.coin : null;
  if (dataCoin !== null) return dataCoin;
  const match = position.instrumentKey?.match(/^hyperliquid:perp:([^:]+)$/);
  return match?.[1] ?? null;
}
export function coinForTarget(target: HyperliquidPerpTarget): string | null {
  const match = target.instrumentKey?.match(/^hyperliquid:perp:([^:]+)$/);
  return match?.[1] ?? null;
}
function leverageDetails(position: Record<string, unknown>): { readonly leverage?: string; readonly marginMode?: "cross" | "isolated" } {
  const leverage = record(position.leverage);
  const rawValue = leverage?.value;
  const rawType = leverage?.type;
  const value = typeof rawValue === "string"
    ? normalizeOptionalProviderDecimal(rawValue)
    : typeof rawValue === "number" ? normalizeOptionalProviderDecimal(String(rawValue)) : undefined;
  const marginMode = rawType === "cross" ? "cross" : rawType === "isolated" ? "isolated" : undefined;
  return {
    ...(value === undefined ? {} : { leverage: value }),
    ...(marginMode === undefined ? {} : { marginMode }),
  };
}
function normalizeOptionalProviderDecimal(value: string): string | undefined {
  try {
    return normalizeProviderDecimal(value, "Hyperliquid leverage");
  } catch {
    return undefined;
  }
}
function providerUnsigned(value: string, label: string): string { return normalizeProviderDecimal(value, label); }
function versionFor(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function stringMeta(meta: Record<string, unknown> | undefined, key: string): string | undefined { const value = meta?.[key]; return typeof value === "string" ? value : undefined; }
function numericMeta(meta: Record<string, unknown> | undefined, key: string): number { const value = meta?.[key]; return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0; }
function record(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
