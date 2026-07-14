import { describe, expect, it, vi } from "vitest";

import {
  createHyperliquidMarketAnalysisHandlers,
  MAX_HYPERLIQUID_CANDLE_WATCHES,
} from "@vex-agent/tools/protocols/hyperliquid/market-analysis-handlers.js";

const now = 1_800_000_000_000;
const snapshot = [
  { t: now - 3_600_000, o: "100", h: "110", l: "90", c: "105", v: "12" },
  { t: now, o: "105", h: "120", l: "100", c: "115", v: "20" },
];

function handlers(overrides: Record<string, unknown> = {}) {
  const candleSnapshot = vi.fn(async () => snapshot);
  const repo = {
    setHyperliquidCandleWatch: vi.fn(async ({ coin, interval, enabled }) => ({ coin, interval, enabled, updatedAt: "2026-07-12T00:00:00.000Z" })),
    getHyperliquidCandleWatch: vi.fn(async () => null),
    countEnabledHyperliquidCandleWatches: vi.fn(async () => 0),
    upsertHyperliquidCandles: vi.fn(async () => undefined),
    readHyperliquidCandles: vi.fn(async () => []),
    ...overrides,
  };
  return {
    repo,
    candleSnapshot,
    handlers: createHyperliquidMarketAnalysisHandlers({
      createInfoClient: () => ({ candleSnapshot }) as never,
      repo: repo as never,
      now: () => now,
    }),
  };
}

describe("Hyperliquid candle tool handlers", () => {
  it("backfills before persisting an enabled watch, disables without deleting rows, and applies the cap", async () => {
    const setup = handlers();
    const enable = await setup.handlers["hyperliquid.market.watchCandles"]?.({ coin: "btc", interval: "1h", enabled: true }, {} as never);
    expect(enable?.success).toBe(true);
    expect(setup.repo.upsertHyperliquidCandles).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ coin: "BTC", interval: "1h" })]));
    expect(setup.candleSnapshot).toHaveBeenCalledWith({
      coin: "BTC", interval: "1h", startTime: now - 7 * 24 * 60 * 60 * 1_000, endTime: now,
    });
    expect(setup.repo.setHyperliquidCandleWatch).toHaveBeenCalledWith({ coin: "BTC", interval: "1h", enabled: true });

    const disable = await setup.handlers["hyperliquid.market.watchCandles"]?.({ coin: "BTC", interval: "1h", enabled: false }, {} as never);
    expect(disable?.success).toBe(true);
    expect(setup.repo.setHyperliquidCandleWatch).toHaveBeenLastCalledWith({ coin: "BTC", interval: "1h", enabled: false });

    const capped = handlers({ countEnabledHyperliquidCandleWatches: vi.fn(async () => MAX_HYPERLIQUID_CANDLE_WATCHES) });
    const rejected = await capped.handlers["hyperliquid.market.watchCandles"]?.({ coin: "ETH", interval: "1h", enabled: true }, {} as never);
    expect(rejected).toMatchObject({ success: false, output: expect.stringContaining("limit reached") });
  });

  it("serves watched rows with live coverage and uses an unsaved one-shot snapshot when unwatched", async () => {
    const watchedRows = snapshot.map((row) => ({
      coin: "BTC", interval: "1h" as const, openTimeMs: row.t, open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v, updatedAt: "2026-07-12T00:00:00.000Z",
    })).reverse();
    const watched = handlers({
      getHyperliquidCandleWatch: vi.fn(async () => ({ coin: "BTC", interval: "1h", enabled: true, updatedAt: "2026-07-12T00:00:00.000Z" })),
      readHyperliquidCandles: vi.fn(async () => watchedRows),
    });
    const stored = await watched.handlers["hyperliquid.market.candles"]?.({ coin: "BTC", interval: "1h", limit: 500 }, {} as never);
    expect(JSON.parse(stored?.output ?? "{}")).toMatchObject({ source: "store", coverage: { from: now - 3_600_000, to: now, live: true } });

    const oneShot = handlers();
    const remote = await oneShot.handlers["hyperliquid.market.candles"]?.({ coin: "BTC", interval: "1h", limit: 2 }, {} as never);
    expect(JSON.parse(remote?.output ?? "{}")).toMatchObject({ source: "snapshot", coverage: { live: false } });
    expect(oneShot.repo.upsertHyperliquidCandles).not.toHaveBeenCalled();
  });

  it("returns compact scan verdicts rather than candle rows", async () => {
    const setup = handlers();
    const result = await setup.handlers["hyperliquid.market.scan"]?.({
      coin: "BTC", interval: "1h", filters: { pctChange: { window: 2 }, rangeStats: { window: 2 } },
    }, {} as never);
    const body = JSON.parse(result?.output ?? "{}");
    expect(body).toMatchObject({ source: "snapshot", candlesUsed: 2, verdicts: { pctChange: { window: 2 } } });
    expect(body).not.toHaveProperty("candles");
  });
});
