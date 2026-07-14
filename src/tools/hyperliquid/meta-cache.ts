import { z } from "zod";

import { HyperliquidClientError } from "./errors.js";
import { HyperliquidInfoClient } from "./info.js";
import type { HyperliquidAssetMetadata, HyperliquidSpotAssetMetadata } from "./types.js";

const perpMetaSchema = z.object({
  universe: z.array(z.object({
    name: z.string().min(1),
    szDecimals: z.number().int().min(0),
    maxLeverage: z.number().int().positive(),
  }).passthrough()),
}).passthrough();

const spotMetaSchema = z.object({
  tokens: z.array(z.object({
    name: z.string().min(1),
    index: z.number().int().nonnegative(),
    szDecimals: z.number().int().min(0),
  }).passthrough()),
  universe: z.array(z.object({
    name: z.string().min(1),
    index: z.number().int().nonnegative(),
    tokens: z.array(z.number().int().nonnegative()).min(1),
  }).passthrough()),
}).passthrough();

export interface HyperliquidMarketMetadata {
  readonly perpsByCoin: ReadonlyMap<string, HyperliquidAssetMetadata>;
  readonly perpsByAsset: ReadonlyMap<number, HyperliquidAssetMetadata>;
  readonly spotByName: ReadonlyMap<string, HyperliquidSpotAssetMetadata>;
}

/** Fetch-once metadata cache; callers explicitly choose when a refresh is needed. */
export class HyperliquidMetaCache {
  private cached: Promise<HyperliquidMarketMetadata> | null = null;

  constructor(private readonly info: HyperliquidInfoClient) {}

  get(): Promise<HyperliquidMarketMetadata> {
    this.cached ??= this.load();
    return this.cached;
  }

  async refresh(): Promise<HyperliquidMarketMetadata> {
    this.cached = this.load();
    return this.cached;
  }

  private async load(): Promise<HyperliquidMarketMetadata> {
    try {
      const [rawPerps, rawSpot] = await Promise.all([this.info.meta(), this.info.spotMeta()]);
      const perps = perpMetaSchema.parse(rawPerps);
      const spot = spotMetaSchema.parse(rawSpot);
      const perpsByCoin = new Map<string, HyperliquidAssetMetadata>();
      const perpsByAsset = new Map<number, HyperliquidAssetMetadata>();
      for (const [asset, item] of perps.universe.entries()) {
        const metadata = { coin: item.name, asset, szDecimals: item.szDecimals, maxLeverage: item.maxLeverage };
        perpsByCoin.set(item.name, metadata);
        perpsByAsset.set(asset, metadata);
      }
      const spotByName = new Map<string, HyperliquidSpotAssetMetadata>();
      const tokenByIndex = new Map(spot.tokens.map((token) => [token.index, token]));
      for (const item of spot.universe) {
        const baseTokenIndex = item.tokens[0];
        const baseToken = baseTokenIndex === undefined ? undefined : tokenByIndex.get(baseTokenIndex);
        if (baseToken === undefined) {
          throw new HyperliquidClientError("response", `Spot market ${item.name} has no base-token precision metadata.`);
        }
        spotByName.set(item.name, { name: item.name, asset: 10_000 + item.index, szDecimals: baseToken.szDecimals });
      }
      return { perpsByCoin, perpsByAsset, spotByName };
    } catch (cause) {
      throw new HyperliquidClientError("response", "Unable to load Hyperliquid market metadata.", { cause });
    }
  }
}
