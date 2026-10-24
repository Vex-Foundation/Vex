/**
 * The DexScreener candle loader against injected fakes: the request it makes,
 * the decimal-string edge, and how each typed site refusal is answered. The
 * real read needs the desktop app's site bridge, so it is a declared
 * desktop-session gate, not a test here.
 */

import { describe, expect, it, vi } from "vitest";
import { requireValue } from "../../helpers/require-value.js";

import { DexScreenerSiteErrorCodes, siteError } from "@tools/dexscreener/site-errors.js";
import type { RecentCandles } from "@tools/dexscreener/candles-read.js";
import {
  createDexscreenerCandleLoader,
  type DexscreenerLoaderDeps,
} from "../../../vex-agent/market-analysis/dexscreener-loader.js";
import { runTechnicalAnalysis } from "../../../vex-agent/market-analysis/run.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12, 30);
const PAIR = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";

function series(n: number, newestOpen: number): RecentCandles["candles"] {
  return Array.from({ length: n }, (_, i) => {
    const close = String(100 + i);
    return {
      timestampMs: newestOpen - (n - 1 - i) * HOUR,
      openUsd: close,
      highUsd: String(101 + i),
      lowUsd: String(99 + i),
      closeUsd: close,
    };
  });
}

function deps(candles: RecentCandles["candles"]): DexscreenerLoaderDeps & {
  readonly readCandles: ReturnType<typeof vi.fn>;
} {
  const readCandles = vi.fn(async () => ({
    candles,
    resolution: "1h" as const,
    lastBarPartial: candles.length > 0,
    subject: {
      chainId: "ethereum",
      pairAddress: PAIR,
      baseTokenSymbol: "PEPE",
      quoteTokenSymbol: "WETH",
    } as RecentCandles["subject"],
    fetchedAtMs: NOW,
  }));
  return { resolveChain: async (chain) => chain, readCandles, now: () => NOW };
}

describe("createDexscreenerCandleLoader", () => {
  it("reads count + 1 newest buckets of the named pool and ignores lastBarPartial", async () => {
    const fake = deps(series(221, Math.floor(NOW / HOUR) * HOUR));
    const load = createDexscreenerCandleLoader({ chain: "ethereum", pairAddress: PAIR }, undefined, fake);
    const outcome = await runTechnicalAnalysis(load, { interval: "1h" });
    expect(fake.readCandles).toHaveBeenCalledWith({
      subject: { chainId: "ethereum", pairAddress: PAIR },
      resolution: "1h",
      limit: 221,
    });
    if (!outcome.ok) throw new Error("expected an analysis");
    expect(outcome.market).toMatchObject({ venue: "dexscreener", chain: "ethereum", pairAddress: PAIR, pairLabel: "PEPE/WETH" });
    // The newest bucket opened this hour and is still forming: dropped by time.
    expect(outcome.analysis.closedCandles.droppedForming).toBe(1);
    expect(outcome.analysis.price).toBe(319);
    expect(outcome.analysis.source).toBe("dexscreener_site_bars");
  });

  it("reads further back when the analysis ends in the past, within one page", async () => {
    const fake = deps(series(250, NOW - 10 * HOUR));
    const load = createDexscreenerCandleLoader({ chain: "ethereum", pairAddress: PAIR }, undefined, fake);
    await load({ interval: "1h", count: 220, untilMs: NOW - 10 * HOUR });
    expect(fake.readCandles.mock.calls[0]?.[0]).toMatchObject({ limit: 231 });
    await load({ interval: "1h", count: 220, untilMs: NOW - 5_000 * HOUR });
    expect(fake.readCandles.mock.calls[1]?.[0]).toMatchObject({ limit: 999 });
  });

  it("drops and counts a bar with a missing or non-numeric USD price, and carries no volume", async () => {
    const candles = series(3, NOW - 2 * HOUR);
    const broken = [
      { ...requireValue(candles[0]), closeUsd: null },
      { ...requireValue(candles[1]), highUsd: "not a number" },
      requireValue(candles[2]),
    ];
    const load = createDexscreenerCandleLoader({ chain: "ethereum", pairAddress: PAIR }, undefined, deps(broken));
    const loaded = await load({ interval: "1h", count: 220, untilMs: null });
    if (!loaded.ok) throw new Error("expected candles");
    expect(loaded.unpriced).toBe(2);
    expect(loaded.bars).toEqual([
      { openTime: NOW - 2 * HOUR, closeTime: NOW - HOUR, open: 102, high: 103, low: 101, close: 102, volume: null },
    ]);
  });

  it("answers the degraded transport's refusal as no_candle_source in its own words", async () => {
    const fake = deps([]);
    fake.readCandles.mockRejectedValueOnce(
      siteError(DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE, "the site bridge is not mounted", "Run inside the desktop app."),
    );
    const load = createDexscreenerCandleLoader({ chain: "ethereum", pairAddress: PAIR }, undefined, fake);
    expect(await load({ interval: "1h", count: 220, untilMs: null })).toEqual({
      ok: false,
      reason: "no_candle_source",
      detail: "the site bridge is not mounted. Run inside the desktop app.",
    });
  });

  it("answers an unknown chain or pool as market_not_found, and other site failures as source_unavailable", async () => {
    const unknown = deps([]);
    const load = createDexscreenerCandleLoader({ chain: "nowhere", pairAddress: PAIR }, undefined, {
      ...unknown,
      resolveChain: async () => {
        throw siteError(DexScreenerSiteErrorCodes.CHAIN_SLUG_UNKNOWN, "\"nowhere\" did not resolve");
      },
    });
    expect(await load({ interval: "1h", count: 220, untilMs: null })).toMatchObject({
      ok: false,
      reason: "market_not_found",
    });

    const timeout = deps([]);
    timeout.readCandles.mockRejectedValueOnce(siteError(DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT, "timed out"));
    const slow = createDexscreenerCandleLoader({ chain: "ethereum", pairAddress: PAIR }, undefined, timeout);
    expect(await slow({ interval: "1h", count: 220, untilMs: null })).toMatchObject({
      ok: false,
      reason: "source_unavailable",
      detail: "timed out.",
    });
  });

  it("lets an untyped failure propagate, so a defect stays visible", async () => {
    const fake = deps([]);
    fake.readCandles.mockRejectedValueOnce(new TypeError("bug"));
    const load = createDexscreenerCandleLoader({ chain: "ethereum", pairAddress: PAIR }, undefined, fake);
    await expect(load({ interval: "1h", count: 220, untilMs: null })).rejects.toThrow("bug");
  });
});
