/**
 * VEX sparkline candles (S11b), the module that replaced the GeckoTerminal
 * OHLCV client.
 *
 * Pinned here: the observable shape the old client produced (ascending
 * `[unixSeconds, closeUsd]` pairs) is unchanged, a bucket the provider priced
 * with nothing is DROPPED rather than drawn as a zero, the resolved pool is
 * reused across polls instead of re-resolved every minute, and a failure clears
 * that cache so the next poll starts clean.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const readRecentCandles = vi.fn();

vi.mock("@tools/dexscreener/candles-read.js", () => ({
  readRecentCandles: (...args: unknown[]) => readRecentCandles(...args),
}));

const { fetchVexSparkline, resetVexPairSubjectCache } = await import(
  "../vex-candles.js"
);

const SUBJECT = {
  chainId: "robinhood",
  pairAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
  ammId: "uniswap",
  quoteTokenAddress: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
};

function result(candles: Array<{ timestampMs: number; closeUsd: string | null }>) {
  return {
    candles: candles.map((candle) => ({
      timestampMs: candle.timestampMs,
      openUsd: "0.0025",
      highUsd: "0.0026",
      lowUsd: "0.0024",
      closeUsd: candle.closeUsd,
    })),
    resolution: "1h",
    lastBarPartial: candles.length > 0,
    subject: SUBJECT,
    fetchedAtMs: 1_787_680_000_000,
  };
}

beforeEach(() => {
  readRecentCandles.mockReset();
  resetVexPairSubjectCache();
});

describe("fetchVexSparkline", () => {
  it("projects the hourly closes into ascending [seconds, close] pairs", async () => {
    // Values from the live probe of 2026-08-25 on this pool.
    readRecentCandles.mockResolvedValue(
      result([
        { timestampMs: 1_787_594_400_000, closeUsd: "0.002573" },
        { timestampMs: 1_787_590_800_000, closeUsd: "0.002819" },
      ]),
    );

    const points = await fetchVexSparkline();

    expect(points).toEqual([
      [1_787_590_800, 0.002819],
      [1_787_594_400, 0.002573],
    ]);
  });

  it("asks for the 24 hourly buckets the widget draws", async () => {
    readRecentCandles.mockResolvedValue(result([]));

    await fetchVexSparkline();

    expect(readRecentCandles.mock.calls[0]?.[0]).toMatchObject({
      subject: {
        chainId: "robinhood",
        pairAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
      },
      resolution: "1h",
      limit: 24,
    });
  });

  it("drops a bucket the provider priced with nothing", async () => {
    readRecentCandles.mockResolvedValue(
      result([
        { timestampMs: 1_787_590_800_000, closeUsd: "0.002819" },
        { timestampMs: 1_787_594_400_000, closeUsd: null },
        { timestampMs: 1_787_598_000_000, closeUsd: "not-a-price" },
      ]),
    );

    // A zero here would draw a crash to nothing that never happened.
    expect(await fetchVexSparkline()).toEqual([[1_787_590_800, 0.002819]]);
  });

  it("reuses the resolved pool on the next poll instead of re-resolving", async () => {
    readRecentCandles.mockResolvedValue(
      result([{ timestampMs: 1_787_590_800_000, closeUsd: "0.002819" }]),
    );

    await fetchVexSparkline();
    expect(readRecentCandles.mock.calls[0]?.[0].resolvedSubject).toBeUndefined();

    await fetchVexSparkline();
    expect(readRecentCandles.mock.calls[1]?.[0].resolvedSubject).toBe(SUBJECT);
  });

  it("clears the cached pool on failure and rethrows for the poller's backoff", async () => {
    readRecentCandles.mockResolvedValue(
      result([{ timestampMs: 1_787_590_800_000, closeUsd: "0.002819" }]),
    );
    await fetchVexSparkline();

    readRecentCandles.mockRejectedValue(new Error("site transport unavailable"));
    await expect(fetchVexSparkline()).rejects.toThrow("site transport unavailable");

    readRecentCandles.mockResolvedValue(
      result([{ timestampMs: 1_787_590_800_000, closeUsd: "0.002819" }]),
    );
    await fetchVexSparkline();
    // The next poll resolves again rather than retrying against a half-state.
    expect(readRecentCandles.mock.calls[2]?.[0].resolvedSubject).toBeUndefined();
  });
});
