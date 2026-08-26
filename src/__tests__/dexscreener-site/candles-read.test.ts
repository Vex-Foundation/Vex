/**
 * The non-agent candles seam (S11b).
 *
 * The composition this module owns is small and every part of it is a place a
 * chart can go silently wrong, so each is pinned: the orientation keys are
 * forwarded VERBATIM from the resolved subject and never re-cased or
 * reconstructed, a caller-supplied resolved subject skips the resolve exchange
 * without changing the answer, the answer is the NEWEST `limit` buckets, and
 * the forming bucket is declared rather than assumed final.
 *
 * The two provider endpoints are the faked boundary. Everything between them
 * and the caller is the real module.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

import type { PairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";

const resolvePairSubject = vi.fn();
const walkBars = vi.fn();
const getDexScreenerTransport = vi.fn();

vi.mock("../../tools/dexscreener/endpoints/pair-subject.js", () => ({
  resolvePairSubject: (...args: unknown[]) => resolvePairSubject(...args),
}));
vi.mock("../../tools/dexscreener/endpoints/bars.js", () => ({
  walkBars: (...args: unknown[]) => walkBars(...args),
}));
vi.mock("../../tools/dexscreener/transport.js", () => ({
  getDexScreenerTransport: () => getDexScreenerTransport(),
}));

const { readRecentCandles, RECENT_CANDLES_MAX } = await import(
  "../../tools/dexscreener/candles-read.js"
);

const TRANSPORT = { name: "site_bridge" };

/**
 * The subject the live probe of 2026-08-25 resolved for the VEX pool. The
 * quote token's MIXED CASE is the point of the fixture, not decoration.
 *
 * Annotated with the REAL contract, so a field the resolver starts returning
 * (or stops) breaks this fixture at compile time instead of being cast past
 * the parameter it is handed to.
 */
const SUBJECT: PairSubject = {
  chainId: "robinhood",
  pairAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
  ammId: "uniswap",
  quoteTokenAddress: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
  quoteTokenSymbol: "VIRTUAL",
  dexId: "uniswap",
  labels: [],
  baseTokenAddress: "0x0000000000000000000000000000000000000001",
  baseTokenSymbol: "VEX",
  priceUsd: "0.002573",
  liquidityUsd: 279587.37,
  pairCreatedAtMs: 1_783_000_000_000,
  resolutionBasis: "explicit_pair_address",
  resolvedFromToken: null,
  searchWindowSize: null,
  fetchedAtMs: 1_787_680_000_000,
};

function bar(timestampMs: number, close: string | null) {
  return {
    timestampMs,
    openNative: "1",
    highNative: "1",
    lowNative: "1",
    closeNative: "1",
    openUsd: "0.0025",
    highUsd: "0.0026",
    lowUsd: "0.0024",
    closeUsd: close,
    volumeUsd: "100",
    minBlockNumber: 10,
    maxBlockNumber: 20,
  };
}

beforeEach(() => {
  resolvePairSubject.mockReset();
  walkBars.mockReset();
  getDexScreenerTransport.mockReset();
  getDexScreenerTransport.mockReturnValue(TRANSPORT);
  resolvePairSubject.mockResolvedValue(SUBJECT);
  walkBars.mockResolvedValue({
    bars: [
      bar(1_787_590_800_000, "0.002819"),
      bar(1_787_594_400_000, "0.002573"),
    ],
    transport: "http",
    pagesWalked: 1,
    bytes: 1024,
    stopReason: "satisfied",
    nextBeforeBlock: null,
    fetchedAtMs: 1_787_680_000_000,
  });
});

describe("readRecentCandles", () => {
  it("forwards the resolved orientation keys verbatim to the chart read", async () => {
    await readRecentCandles({
      subject: { chainId: "robinhood", pairAddress: SUBJECT.pairAddress },
      resolution: "1h",
      limit: 24,
    });

    const options = walkBars.mock.calls[0]?.[0];
    // A re-cased or reconstructed quote token is answered HTTP 200 with a
    // silently INVERTED series, so identity is asserted, not merely presence.
    expect(options.quoteTokenAddress).toBe(SUBJECT.quoteTokenAddress);
    expect(options.ammId).toBe(SUBJECT.ammId);
    expect(options.pairAddress).toBe(SUBJECT.pairAddress);
    expect(options.chainId).toBe(SUBJECT.chainId);
    expect(options.inverted).toBe(false);
    expect(options.series).toBe("price");
    expect(options.transport).toBe(TRANSPORT);
  });

  it("returns the buckets oldest first and declares the forming one", async () => {
    const result = await readRecentCandles({
      subject: { chainId: "robinhood", pairAddress: SUBJECT.pairAddress },
      resolution: "1h",
      limit: 24,
    });

    expect(result.candles.map((candle) => candle.timestampMs)).toEqual([
      1_787_590_800_000, 1_787_594_400_000,
    ]);
    // Prices stay decimal strings: this seam never round-trips them through
    // binary floating point.
    expect(result.candles[1]?.closeUsd).toBe("0.002573");
    expect(result.lastBarPartial).toBe(true);
    expect(result.resolution).toBe("1h");
    expect(result.subject).toBe(SUBJECT);
  });

  it("keeps the NEWEST buckets when the provider returns more than asked", async () => {
    walkBars.mockResolvedValue({
      bars: [
        bar(1, "0.1"),
        bar(2, "0.2"),
        bar(3, "0.3"),
      ],
      transport: "http",
      pagesWalked: 1,
      bytes: 10,
      stopReason: "satisfied",
      nextBeforeBlock: null,
      fetchedAtMs: 5,
    });

    const result = await readRecentCandles({
      subject: { chainId: "robinhood", pairAddress: SUBJECT.pairAddress },
      resolution: "1h",
      limit: 2,
    });

    expect(result.candles.map((candle) => candle.timestampMs)).toEqual([2, 3]);
  });

  it("skips the resolve exchange when the caller already holds the subject", async () => {
    const result = await readRecentCandles({
      subject: { chainId: "robinhood", pairAddress: SUBJECT.pairAddress },
      resolution: "1h",
      limit: 24,
      resolvedSubject: SUBJECT,
    });

    expect(resolvePairSubject).not.toHaveBeenCalled();
    expect(result.subject).toBe(SUBJECT);
    expect(walkBars.mock.calls[0]?.[0].quoteTokenAddress).toBe(
      SUBJECT.quoteTokenAddress,
    );
  });

  it("reports an empty series as empty and not as a forming bucket", async () => {
    walkBars.mockResolvedValue({
      bars: [],
      transport: "http",
      pagesWalked: 1,
      bytes: 8,
      // The provider's empty page cannot separate "no history" from "no such
      // pool", so the seam reports what it got and resolves nothing.
      stopReason: "provider_exhausted",
      nextBeforeBlock: null,
      fetchedAtMs: 5,
    });

    const result = await readRecentCandles({
      subject: { chainId: "robinhood", pairAddress: SUBJECT.pairAddress },
      resolution: "1h",
      limit: 24,
    });

    expect(result.candles).toEqual([]);
    expect(result.lastBarPartial).toBe(false);
  });

  it("refuses a limit outside 1..999 before any provider call", async () => {
    for (const limit of [0, -1, 1.5, RECENT_CANDLES_MAX + 1]) {
      await expect(
        readRecentCandles({
          subject: { chainId: "robinhood", pairAddress: SUBJECT.pairAddress },
          resolution: "1h",
          limit,
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(resolvePairSubject).not.toHaveBeenCalled();
    expect(walkBars).not.toHaveBeenCalled();
  });

  it("lets a transport refusal propagate instead of returning an empty series", async () => {
    resolvePairSubject.mockRejectedValue(new Error("site transport unavailable"));

    await expect(
      readRecentCandles({
        subject: { chainId: "robinhood", pairAddress: SUBJECT.pairAddress },
        resolution: "1h",
        limit: 24,
      }),
    ).rejects.toThrow("site transport unavailable");
  });
});
