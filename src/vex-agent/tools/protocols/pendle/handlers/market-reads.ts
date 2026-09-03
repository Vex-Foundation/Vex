/**
 * Pendle MARKET-DATA read handler map - the six per-market / per-asset reads,
 * and the one place their asset-decimals dependency is chosen.
 *
 * WHY THE WIRING LIVES HERE. Order-book sizes, merkle reward amounts and a
 * market's leg identity all arrive as raw base units with NO decimals: neither
 * the documented market catalogue nor those endpoints publish them. The handlers
 * therefore take the lookup as a REQUIRED argument (`asset-decimals.ts`), so the
 * choice cannot be made by accident - and this module makes it: the catalogue
 * behind `buildAssetMap`, the same source `pendle.position.value` reads for the
 * same reason.
 *
 * `buildAssetMap` is IMPORTED, never modified. It belongs to the frozen money
 * path, and this direction - a read handler consuming a shared resolver - is the
 * one that already exists in this tree. Nothing here can widen it: the adapter
 * below narrows each asset to a symbol and a decimals count and drops the price
 * fields that back valuation and sizing.
 *
 * When the catalogue read FAILS, `resolveAssetFacts` hands the handler the
 * failure instead of an empty map, and the affected amounts ship raw and flagged
 * `unreadable` with the reason named - never at an assumed 18 decimals.
 */

import type { ProtocolHandler } from "../../types.js";
import { buildAssetMap } from "../market-lookup.js";
import type { PendleReadAssetFacts, PendleReadAssetFactsLookup } from "../asset-decimals.js";
import { pendleMarketGet } from "./market-get.js";
import { pendleMarketHistory } from "./market-history.js";
import { pendleMarketCandles } from "./market-candles.js";
import { pendleOrderbook } from "./orderbook.js";
import { pendleRewardsMerkle } from "./rewards-merkle.js";
import { pendleAssetPrices } from "./asset-prices.js";

/**
 * The chain's Pendle asset catalogue, narrowed to what a READ needs.
 *
 * Deliberately drops `priceUsd` / `priceAcc` / `baseType`: those are the fields
 * that value and size a trade, and nothing in the read lane may consume them.
 */
const pendleCatalogAssetFacts: PendleReadAssetFactsLookup = async (chainId) => {
  const assets = await buildAssetMap(chainId);
  const facts = new Map<string, PendleReadAssetFacts>();
  for (const [address, asset] of assets) {
    facts.set(address, { symbol: asset.symbol, decimals: asset.decimals });
  }
  return facts;
};

export const PENDLE_MARKET_READ_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.market.get": (p) => pendleMarketGet(p, pendleCatalogAssetFacts),
  "pendle.market.history": (p) => pendleMarketHistory(p),
  "pendle.market.candles": (p) => pendleMarketCandles(p),
  "pendle.orderbook": (p) => pendleOrderbook(p, pendleCatalogAssetFacts),
  "pendle.rewards.merkle": (p, ctx) => pendleRewardsMerkle(p, ctx, pendleCatalogAssetFacts),
  "pendle.prices.assets": (p) => pendleAssetPrices(p),
};
