import { Decimal } from "decimal.js";
import { z } from "zod";

import { resolveHyperliquidNetwork } from "@tools/hyperliquid/constants.js";
import { HYPERLIQUID_CANDLE_WINDOWS_MS } from "@tools/hyperliquid/candles.js";
import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import { parseHyperliquidMarketSnapshot } from "@tools/hyperliquid/market-snapshot.js";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  hyperliquidBookDtoSchema,
  hyperliquidBookReadInputSchema,
  hyperliquidCandlesDtoSchema,
  hyperliquidCandlesReadInputSchema,
  hyperliquidMarketsDtoSchema,
  hyperliquidMarketsReadInputSchema,
  type HyperliquidBookDto,
  type HyperliquidCandlesDto,
  type HyperliquidMarketsDto,
} from "@shared/schemas/hyperliquid.js";
import { canonicalCandleDecimal } from "../../hyperliquid/candle-decimal.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { requireExistingHyperliquidSession, unavailable } from "./support.js";

const candleProviderSchema = z.array(z.object({
  t: z.number().int().nonnegative(),
  o: z.string(), h: z.string(), l: z.string(), c: z.string(), v: z.string(),
}).passthrough()).max(1_000);
const CANDLE_CACHE_MS = 30_000;
const candleCache = new Map<string, { readonly expiresAt: number; readonly value: HyperliquidCandlesDto }>();
// The asset-picker metrics feed refreshes every 5s; the cache must not starve
// a renderer polling at that cadence.
const MARKETS_CACHE_MS = 5_000;
const BOOK_CACHE_MS = 2_000;
let marketsCache: { readonly expiresAt: number; readonly value: HyperliquidMarketsDto } | null = null;
const bookCache = new Map<string, { readonly expiresAt: number; readonly value: HyperliquidBookDto }>();

const bookProviderSchema = z.object({
  levels: z.tuple([
    z.array(z.object({ px: z.string(), sz: z.string(), n: z.number().int().nonnegative() }).passthrough()).max(200),
    z.array(z.object({ px: z.string(), sz: z.string(), n: z.number().int().nonnegative() }).passthrough()).max(200),
  ]),
  time: z.number().int().nonnegative(),
}).passthrough();


function registerCandlesHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.getCandles,
    domain: "hyperliquid",
    inputSchema: hyperliquidCandlesReadInputSchema,
    outputSchema: hyperliquidCandlesDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidCandlesDto>> => {
      // Require a real server-resolved session before serving public market data
      // so a hostile renderer cannot use this bridge as a generic network proxy.
      const sessionError = await requireExistingHyperliquidSession(input.sessionId, ctx.requestId);
      if (sessionError !== null) return sessionError;
      const coin = input.coin.trim().toUpperCase();
      const cacheKey = `${coin}\u0000${input.interval}`;
      const cached = candleCache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > Date.now()) return ok(cached.value);
      try {
        const now = Date.now();
        const raw = await new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }).candleSnapshot({
          coin,
          interval: input.interval,
          startTime: now - HYPERLIQUID_CANDLE_WINDOWS_MS[input.interval],
          endTime: now,
        });
        const parsed = candleProviderSchema.safeParse(raw);
        if (!parsed.success) return unavailable("Hyperliquid returned an invalid candle snapshot. Retry shortly.", ctx.requestId);
        const candidate = {
          coin,
          interval: input.interval,
          candles: parsed.data.map((candle) => ({
            openTimeMs: candle.t,
            open: canonicalCandleDecimal(candle.o), high: canonicalCandleDecimal(candle.h),
            low: canonicalCandleDecimal(candle.l), close: canonicalCandleDecimal(candle.c),
            volume: canonicalCandleDecimal(candle.v),
          })),
          fetchedAt: new Date(now).toISOString(),
        };
        const value = hyperliquidCandlesDtoSchema.parse(candidate);
        candleCache.set(cacheKey, { expiresAt: now + CANDLE_CACHE_MS, value });
        return ok(value);
      } catch (cause) {
        log.warn("[ipc:hyperliquid] candle snapshot failed", cause);
        return unavailable("Unable to load Hyperliquid candles. Retry shortly.", ctx.requestId);
      }
    },
  });
}

function canonicalMarketDecimal(value: string): string {
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.isNegative()) {
    throw new Error("invalid market decimal");
  }
  return decimal.toFixed();
}

export function mapHyperliquidMarkets(raw: unknown): HyperliquidMarketsDto {
  return hyperliquidMarketsDtoSchema.parse(
    parseHyperliquidMarketSnapshot(raw).map((market) => ({
      coin: market.coin,
      maxLeverage: market.maxLeverage,
      markPx: market.markPx,
      change24hPct: market.change24hPct,
      openInterestUsd: market.openInterestUsd,
      fundingRate8hPct: market.fundingRate8hPct,
      dayNtlVlmUsd: market.dayNtlVlmUsd,
      szDecimals: market.szDecimals,
    })),
  );
}

function mapHyperliquidBook(raw: unknown): HyperliquidBookDto {
  const parsed = bookProviderSchema.parse(raw);
  const mapLevels = (levels: ReadonlyArray<{ readonly px: string; readonly sz: string; readonly n: number }>) =>
    levels.map((level) => ({
      px: canonicalMarketDecimal(level.px),
      sz: canonicalMarketDecimal(level.sz),
      n: level.n,
    }));
  return hyperliquidBookDtoSchema.parse({
    levels: { bids: mapLevels(parsed.levels[0]), asks: mapLevels(parsed.levels[1]) },
    time: parsed.time,
  });
}

function registerMarketsHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.getMarkets,
    domain: "hyperliquid",
    inputSchema: hyperliquidMarketsReadInputSchema,
    outputSchema: hyperliquidMarketsDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidMarketsDto>> => {
      const sessionError = await requireExistingHyperliquidSession(input.sessionId, ctx.requestId);
      if (sessionError !== null) return sessionError;
      const now = Date.now();
      if (marketsCache !== null && marketsCache.expiresAt > now) return ok(marketsCache.value);
      try {
        const raw = await new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }).metaAndAssetCtxs();
        const value = mapHyperliquidMarkets(raw);
        marketsCache = { expiresAt: now + MARKETS_CACHE_MS, value };
        return ok(value);
      } catch (cause) {
        log.warn("[ipc:hyperliquid] markets read failed", cause);
        return unavailable("Unable to load Hyperliquid markets. Retry shortly.", ctx.requestId);
      }
    },
  });
}

function registerBookHandler(): () => void {
  return registerHandler({
    channel: CH.hyperliquid.getBook,
    domain: "hyperliquid",
    inputSchema: hyperliquidBookReadInputSchema,
    outputSchema: hyperliquidBookDtoSchema,
    handle: async (input, ctx): Promise<Result<HyperliquidBookDto>> => {
      const sessionError = await requireExistingHyperliquidSession(input.sessionId, ctx.requestId);
      if (sessionError !== null) return sessionError;
      const coin = input.coin.trim().toUpperCase();
      const cached = bookCache.get(coin);
      if (cached !== undefined && cached.expiresAt > Date.now()) return ok(cached.value);
      try {
        const raw = await new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() }).l2Book(coin);
        const value = mapHyperliquidBook(raw);
        bookCache.set(coin, { expiresAt: Date.now() + BOOK_CACHE_MS, value });
        return ok(value);
      } catch (cause) {
        log.warn("[ipc:hyperliquid] order-book read failed", cause);
        return unavailable("Unable to load the Hyperliquid order book. Retry shortly.", ctx.requestId);
      }
    },
  });
}


export function registerHyperliquidMarketReadHandlers(): Array<() => void> {
  return [
    registerCandlesHandler(),
    registerMarketsHandler(),
    registerBookHandler(),
  ];
}
