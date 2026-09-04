/**
 * Pendle market/asset resolution - the SINGLE deterministic source for
 * PT → market / YT / expiry / liquidity and PT/token → USD price, SCOPED to one
 * chain.
 *
 * Both the prequote redeem identity (record-time AND gate-time) and the handlers
 * resolve YT from a PT through `resolveMarketByPt(chainId, pt)` here, so their
 * redeem identities collide by construction on the same chain. Every lookup is
 * chain-scoped at the SOURCE: both `getActiveMarkets(chainId)` and
 * `getAssetsForChain(chainId)` are per-chain endpoints, so the same bare address
 * on two chains can never collide. Backed by the client's per-URL TTL-caches, so
 * repeated lookups in one flow hit the cache.
 */

import { getPendleClient } from "@tools/pendle/client.js";
import type { PendleAsset, PendleMarket } from "@tools/pendle/types.js";

function eq(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/** Find the active market on `chainId` whose PT equals `ptAddress`. */
export async function resolveMarketByPt(chainId: number, ptAddress: string): Promise<PendleMarket | null> {
  const markets = await getPendleClient().getActiveMarkets(chainId);
  return markets.find((m) => eq(m.pt, ptAddress)) ?? null;
}

/** Find the active market on `chainId` by its market (LP) address. */
export async function resolveMarketByAddress(chainId: number, marketAddress: string): Promise<PendleMarket | null> {
  const markets = await getPendleClient().getActiveMarkets(chainId);
  return markets.find((m) => eq(m.address, marketAddress)) ?? null;
}

/** Find the active market on `chainId` whose YT equals `ytAddress`. */
export async function resolveMarketByYt(chainId: number, ytAddress: string): Promise<PendleMarket | null> {
  const markets = await getPendleClient().getActiveMarkets(chainId);
  return markets.find((m) => eq(m.yt, ytAddress)) ?? null;
}

/** Resolve the canonical YT for a PT on `chainId` (from the active market). */
export async function resolveYtForPt(chainId: number, ptAddress: string): Promise<string | null> {
  return (await resolveMarketByPt(chainId, ptAddress))?.yt ?? null;
}

/**
 * Lowercase address → asset (metadata + price) for ONE chain, from that chain's
 * `/v1/{chainId}/assets/all`. The `chainId` re-check is defence in depth: the
 * endpoint is already scoped, but a foreign row must never leak into this map
 * (the same address on another chain carries different decimals and price).
 * Raises `PENDLE_INVALID_RESPONSE` if the catalogue is unreadable - callers must
 * not mistake that for "this chain has no assets".
 */
export async function buildAssetMap(chainId: number): Promise<Map<string, PendleAsset>> {
  const assets = await getPendleClient().getAssetsForChain(chainId);
  const map = new Map<string, PendleAsset>();
  for (const a of assets) {
    if (a.chainId !== null && a.chainId !== chainId) continue;
    map.set(a.address.toLowerCase(), a);
  }
  return map;
}

/** Spot USD price for a token address from the asset map, or null. */
export function priceUsdFor(assetMap: Map<string, PendleAsset>, address: string): number | null {
  return assetMap.get(address.toLowerCase())?.priceUsd ?? null;
}
