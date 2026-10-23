/**
 * `dexscreener.technicalAnalysis` through its registered handler, with the
 * candle loader replaced so nothing reaches the network. The loader's own
 * mapping and refusals are pinned in `dexscreener-loader.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

import type { CandleLoadRequest } from "../../../vex-agent/market-analysis/bars.js";
import { dexscreenerAnalysisResultSchema } from "../../../lib/market-analysis/result-schema.js";

const HOUR = 3_600_000;
const loaderCalls: { target: unknown; request: CandleLoadRequest }[] = [];
let refusal: { reason: string; detail: string } | null = null;

vi.mock("@vex-agent/market-analysis/dexscreener-loader.js", () => ({
  createDexscreenerCandleLoader: (target: unknown) => async (request: CandleLoadRequest) => {
    loaderCalls.push({ target, request });
    if (refusal !== null) return { ok: false, ...refusal };
    const now = Date.now();
    const lastOpen = Math.floor(now / HOUR) * HOUR;
    return {
      ok: true,
      market: {
        venue: "dexscreener",
        chain: "ethereum",
        pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
        pairLabel: "PEPE/WETH",
        transport: "site_bridge",
      },
      bars: Array.from({ length: 221 }, (_, i) => ({
        openTime: lastOpen - (220 - i) * HOUR,
        closeTime: lastOpen - (219 - i) * HOUR,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100 + i,
        volume: null,
      })),
      fetchedAtMs: now,
      unpriced: 0,
      source: "dexscreener_site_bars",
    };
  },
}));

const { DEXSCREENER_HANDLERS } = await import("@vex-agent/tools/protocols/dexscreener/handlers.js");
const { makeProtocolContext } = await import("../tools/_test-context.js");

async function call(params: Record<string, unknown>) {
  const handler = DEXSCREENER_HANDLERS["dexscreener.technicalAnalysis"];
  if (handler === undefined) throw new Error("handler not registered");
  return handler(params, makeProtocolContext());
}

describe("dexscreener.technicalAnalysis", () => {
  it("analyses the named pool and returns the shared result contract", async () => {
    refusal = null;
    const result = await call({
      chain: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
      interval: "1h",
    });
    expect(result.success, result.output).toBe(true);
    const data = JSON.parse(result.output) as Record<string, unknown>;
    expect(dexscreenerAnalysisResultSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({ venue: "dexscreener", pairLabel: "PEPE/WETH", interval: "1h", bars: 100, price: 319 });
    expect(data).not.toHaveProperty("transport");
    expect(loaderCalls.at(-1)?.request).toEqual({ interval: "1h", count: 220, untilMs: null });
  });

  it("refuses with a sentence carrying the loader's code", async () => {
    refusal = { reason: "no_candle_source", detail: "the site bridge is not mounted." };
    const result = await call({ chain: "ethereum", pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f", interval: "4h" });
    expect(result.success).toBe(false);
    expect(result.output).toBe(
      "DexScreener technical analysis unavailable (no_candle_source): the site bridge is not mounted.",
    );
    refusal = null;
  });

  it("refuses a missing pool, a missing or unknown interval, and an out-of-range bar count by name", async () => {
    const before = loaderCalls.length;
    expect((await call({ chain: "ethereum", interval: "1h" })).output).toContain("\"pairAddress\" are both required");
    expect((await call({ chain: "ethereum", pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f" })).output)
      .toContain("\"interval\" is required");
    expect((await call({ chain: "ethereum", pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f", interval: "2h" })).output)
      .toContain("\"interval\" must be one of");
    expect((await call({ chain: "ethereum", pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f", interval: "1h", bars: 500 })).output)
      .toContain("\"bars\" must be a whole number from 30 to 200");
    expect(loaderCalls.length).toBe(before);
  });
});
