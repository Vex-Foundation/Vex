/**
 * The two market-history readers, driven over the REAL captured bytes.
 *
 * Nothing is mocked below the `fetch` seam: the fixtures are the exact bodies
 * the providers returned on 2026-09-04, including the three GeckoTerminal 400s
 * whose text is where the tool's allowed-value lists come from, and the 404 for
 * a Base bonding-curve pair.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readVpApiTrades } from "@tools/virtuals/trades/vp-api.js";
import {
  readGeckoTerminalCandles,
  geckoTerminalAggregatesFor,
  GECKOTERMINAL_AGGREGATES_BY_TIMEFRAME,
  GECKOTERMINAL_TIMEFRAMES,
} from "@tools/virtuals/candles/geckoterminal.js";
import { ErrorCodes, VexError } from "../../../../../errors.js";
import TRADES from "../../../../virtuals/fixtures/vp-api-trades-bonding-base.json" with { type: "json" };
import TRADES_EMPTY from "../../../../virtuals/fixtures/vp-api-trades-empty.json" with { type: "json" };
import KLINES_EMPTY from "../../../../virtuals/fixtures/vp-api-klines-empty.json" with { type: "json" };
import OHLCV from "../../../../virtuals/fixtures/geckoterminal-ohlcv-hour.json" with { type: "json" };
import REJECTIONS from "../../../../virtuals/fixtures/geckoterminal-rejections.json" with { type: "json" };

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let fetchSpy: ReturnType<typeof vi.spyOn>;

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  fetchSpy.mockRestore();
});

/** A unique address per test: the readers cache on the request URL. */
let counter = 0;
function uniqueEvmAddress(): string {
  counter += 1;
  return `0x${counter.toString(16).padStart(40, "0")}`;
}

describe("the bonding-curve trade tape", () => {
  it("parses the captured tape, keeping amounts as decimal strings", async () => {
    fetchSpy.mockResolvedValue(respond(200, TRADES));
    const result = await readVpApiTrades({
      chain: "BASE",
      tokenAddress: uniqueEvmAddress(),
      limit: 5,
    });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.chainId).toBe(0);
    expect(result.trades.length).toBeGreaterThan(0);
    const first = result.trades[0]!;
    expect(typeof first.agentTokenAmount).toBe("string");
    expect(typeof first.virtualTokenAmount).toBe("string");
    expect(typeof first.price).toBe("string");
    expect(first.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Number.isInteger(first.timestampSeconds)).toBe(true);
  });

  it("sends the provider's own chainID and tradeSideOption numbers", async () => {
    fetchSpy.mockResolvedValue(respond(200, TRADES));
    await readVpApiTrades({ chain: "SOLANA", tokenAddress: uniqueEvmAddress(), limit: 3, side: "sells" });
    const url = new URL(fetchSpy.mock.calls.at(-1)![0] as string);
    expect(url.pathname).toBe("/vp-api/trades");
    expect(url.searchParams.get("chainID")).toBe("1");
    expect(url.searchParams.get("tradeSideOption")).toBe("2");
    expect(url.searchParams.get("limit")).toBe("3");
  });

  it.each(["ROBINHOOD", "ETH"] as const)(
    "REFUSES %s by name instead of returning an empty tape",
    async (chain) => {
      const result = await readVpApiTrades({ chain, tokenAddress: uniqueEvmAddress(), limit: 5 });
      expect(result.supported).toBe(false);
      if (result.supported) return;
      expect(result.reason).toMatch(/no chain id/);
      expect(result.reason).toMatch(/BASE = 0 and SOLANA = 1/);
      // The refusal must cost no provider call at all.
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("returns an EMPTY supported tape for a graduated agent - the measured state", async () => {
    fetchSpy.mockResolvedValue(respond(200, TRADES_EMPTY));
    const result = await readVpApiTrades({ chain: "BASE", tokenAddress: uniqueEvmAddress(), limit: 5 });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.trades).toEqual([]);
  });

  it("the klines fixture is empty, which is why no reader is built on it", () => {
    expect(KLINES_EMPTY.data.Klines).toEqual([]);
  });
});

describe("pool candles", () => {
  it("parses the captured OHLCV into oldest-first decimal-string candles", async () => {
    fetchSpy.mockResolvedValue(respond(200, OHLCV));
    const result = await readGeckoTerminalCandles({
      chain: "ROBINHOOD",
      poolAddress: uniqueEvmAddress(),
      timeframe: "hour",
      aggregate: 1,
      limit: 5,
    });
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.network).toBe("robinhood");
    expect(result.candles.length).toBeGreaterThan(0);
    const [first, second] = result.candles;
    // The provider sends newest-first; we hand back oldest-first.
    expect(first!.timestampSeconds).toBeLessThan(second!.timestampSeconds);
    for (const field of ["open", "high", "low", "close", "volume"] as const) {
      expect(typeof first![field]).toBe("string");
    }
  });

  it("builds the address-keyed public URL, not the app's internal id route", async () => {
    fetchSpy.mockResolvedValue(respond(200, OHLCV));
    const pool = uniqueEvmAddress();
    await readGeckoTerminalCandles({
      chain: "BASE",
      poolAddress: pool,
      timeframe: "day",
      aggregate: 4,
      limit: 7,
      beforeTimestampSeconds: 1_788_000_000,
      currency: "token",
    });
    const url = new URL(fetchSpy.mock.calls.at(-1)![0] as string);
    expect(url.host).toBe("api.geckoterminal.com");
    expect(url.pathname).toBe(`/api/v2/networks/base/pools/${pool}/ohlcv/day`);
    expect(url.searchParams.get("aggregate")).toBe("4");
    expect(url.searchParams.get("limit")).toBe("7");
    expect(url.searchParams.get("currency")).toBe("token");
    expect(url.searchParams.get("before_timestamp")).toBe("1788000000");
  });

  it("reports a 404 as 'not indexed', naming the bonding curve as the usual cause", async () => {
    fetchSpy.mockResolvedValue(respond(404, REJECTIONS.pool_not_indexed_404));
    const result = await readGeckoTerminalCandles({
      chain: "BASE",
      poolAddress: uniqueEvmAddress(),
      timeframe: "hour",
      aggregate: 1,
      limit: 5,
    });
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toMatch(/does not index pool/);
    expect(result.reason).toMatch(/bonding-curve pair/);
    expect(result.reason).toMatch(/virtuals__agent_trades_list/);
  });

  it("raises a RETRYABLE error on 429 rather than answering 'no candles'", async () => {
    fetchSpy.mockResolvedValue(respond(429, { status: { error_code: 429, error_message: "rate limit" } }));
    const call = readGeckoTerminalCandles({
      chain: "ROBINHOOD",
      poolAddress: uniqueEvmAddress(),
      timeframe: "hour",
      aggregate: 1,
      limit: 5,
    });
    await expect(call).rejects.toBeInstanceOf(VexError);
    await call.catch((err: VexError) => {
      expect(err.code).toBe(ErrorCodes.VIRTUALS_RATE_LIMITED);
      expect(err.retryable).toBe(true);
    });
  });

  it("declares the aggregate set PER TIMEFRAME, as the provider does", () => {
    // The defect this pins: a single global set accepted `day` + aggregate 4,
    // which the first live handler run answered with a 400. Each row below is
    // the provider's own sentence for that timeframe.
    expect(GECKOTERMINAL_AGGREGATES_BY_TIMEFRAME).toEqual({
      minute: [1, 5, 15],
      hour: [1, 4, 12],
      day: [1],
    });
    expect(REJECTIONS.aggregate_4_on_day.errors[0].title).toBe(
      "Invalid aggregate. Allowed values: 1",
    );
    expect(REJECTIONS.aggregate_4_on_minute.errors[0].title).toBe(
      "Invalid aggregate. Allowed values: 1, 5, 15",
    );
    expect(REJECTIONS.aggregate_7.errors[0].title).toBe("Invalid aggregate. Allowed values: 1, 4, 12");
    for (const timeframe of GECKOTERMINAL_TIMEFRAMES) {
      expect(geckoTerminalAggregatesFor(timeframe)).toEqual(
        GECKOTERMINAL_AGGREGATES_BY_TIMEFRAME[timeframe],
      );
    }
  });

  it("the declared vocabularies are the ones the provider states in its 400s", () => {
    expect(REJECTIONS.timeframe_week.errors[0].title).toBe(
      "Invalid timeframe. Allowed values: day, hour, minute, second",
    );
    expect(REJECTIONS.limit_2000.errors[0].title).toBe(
      "Invalid limit. must be positive integer less than or equal to 1000",
    );
    expect(REJECTIONS.aggregate_7.errors[0].title).toBe("Invalid aggregate. Allowed values: 1, 4, 12");
  });
});
