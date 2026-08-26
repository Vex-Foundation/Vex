/**
 * CHARACTERIZATION of the VEX pair projection (S11b).
 *
 * Written against the OLD `@tools/dexscreener/client.js` read, run green there
 * first (7 of 7), then carried across the swap to the shared price-read seam
 * with every ASSERTION and every fixture value unchanged - only the faked
 * module id and the call spelling moved, because the seam serves the provider's
 * own pair response. Its whole purpose is that the widget's observable contract
 * (`VexPairData`'s field set, its null-not-zero rule, and the throw that makes
 * the poller keep last-good data) is proven identical on both data paths.
 *
 * The projection is a trust boundary: `priceUsd` arrives as an arbitrary
 * provider string and every other field as an unbounded number, so the pins
 * below are about what CANNOT reach the renderer, not only about the happy row.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const readPair = vi.fn();

vi.mock("@tools/dexscreener/price-read.js", () => ({
  readPair: (...args: unknown[]) => readPair(...args),
}));

const { fetchVexPair, VEX_PAIR_SUBJECT } = await import("../dexscreener-pair.js");

/**
 * A full, healthy provider row. Every value is the one the live probe of
 * 2026-08-25 recorded for this pool.
 *
 * The seam re-homes the provider's OWN pair response onto the registered
 * transport, so this fixture is the same shape the old client returned. That is
 * why the assertions below did not move: the swap changed which transport
 * carries the bytes, not what the bytes say.
 */
function pair(overrides: Record<string, unknown> = {}): unknown {
  return {
    chainId: "robinhood",
    pairAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
    priceUsd: "0.002573",
    priceChange: { h1: 4.85, h24: -10.88 },
    marketCap: 2573248,
    fdv: 2573248,
    liquidity: { usd: 279587.37 },
    volume: { h24: 244144.5 },
    txns: { h24: { buys: 545, sells: 336 } },
    ...overrides,
  };
}

beforeEach(() => {
  readPair.mockReset();
});

describe("fetchVexPair", () => {
  it("projects a healthy pair into the widget's field set", async () => {
    readPair.mockResolvedValue({ pairs: [pair()] });

    const data = await fetchVexPair();

    expect(data).toEqual({
      priceUsd: 0.002573,
      priceChange: { h1: 4.85, h24: -10.88 },
      marketCap: 2573248,
      fdv: 2573248,
      liquidityUsd: 279587.37,
      volumeH24: 244144.5,
      txnsH24: { buys: 545, sells: 336 },
    });
    // The exact field set the shared snapshot schema accepts, no more.
    expect(Object.keys(data).sort()).toEqual([
      "fdv",
      "liquidityUsd",
      "marketCap",
      "priceChange",
      "priceUsd",
      "txnsH24",
      "volumeH24",
    ]);
  });

  it("reads the ONE VEX pool and never a caller-chosen subject", async () => {
    readPair.mockResolvedValue({ pairs: [pair()] });

    await fetchVexPair();

    // The pool identity is a module constant on a money-adjacent display path;
    // a resolver that could pick another pool is exactly what must not appear.
    // The checksum spelling is load-bearing: the provider answers the
    // lowercased address with zero rows.
    expect(readPair).toHaveBeenCalledTimes(1);
    expect(readPair.mock.calls[0]?.slice(0, 2)).toEqual([
      "robinhood",
      "0x817f16F5D8da83d1B089B082c0172af3923618dA",
    ]);
    expect(VEX_PAIR_SUBJECT).toEqual({
      chainId: "robinhood",
      pairAddress: "0x817f16F5D8da83d1B089B082c0172af3923618dA",
    });
  });

  it("nulls every absent field rather than fabricating a zero", async () => {
    readPair.mockResolvedValue({
      pairs: [
        pair({
          priceUsd: null,
          priceChange: undefined,
          marketCap: undefined,
          fdv: undefined,
          liquidity: undefined,
          volume: undefined,
          txns: undefined,
        }),
      ],
    });

    const data = await fetchVexPair();

    expect(data).toEqual({
      priceUsd: null,
      priceChange: { h1: null, h24: null },
      marketCap: null,
      fdv: null,
      liquidityUsd: null,
      volumeH24: null,
      txnsH24: null,
    });
  });

  it("nulls a non-finite or unparseable value instead of passing it through", async () => {
    readPair.mockResolvedValue({
      pairs: [
        pair({
          priceUsd: "not-a-price",
          priceChange: { h1: Number.NaN, h24: Number.POSITIVE_INFINITY },
          marketCap: Number.NaN,
          liquidity: { usd: Number.NEGATIVE_INFINITY },
          volume: { h24: Number.NaN },
        }),
      ],
    });

    const data = await fetchVexPair();

    expect(data.priceUsd).toBeNull();
    expect(data.priceChange).toEqual({ h1: null, h24: null });
    expect(data.marketCap).toBeNull();
    expect(data.liquidityUsd).toBeNull();
    expect(data.volumeH24).toBeNull();
  });

  it("keeps txn counts whole and non-negative, or drops the pair of them", async () => {
    readPair.mockResolvedValue({
      pairs: [pair({ txns: { h24: { buys: 545.9, sells: -3 } } })],
    });
    expect((await fetchVexPair()).txnsH24).toEqual({ buys: 545, sells: 0 });

    // One side missing makes the PAIR null: a buy count beside a fabricated
    // zero sell count would read as a one-sided market that does not exist.
    readPair.mockResolvedValue({
      pairs: [pair({ txns: { h24: { buys: 545, sells: null } } })],
    });
    expect((await fetchVexPair()).txnsH24).toBeNull();
  });

  it("throws when the provider has no VEX pair, so the poller keeps last-good", async () => {
    readPair.mockResolvedValue({ pairs: [] });

    await expect(fetchVexPair()).rejects.toThrow(/VEX pair/i);
  });

  it("lets a transport failure propagate to the poller's backoff", async () => {
    readPair.mockRejectedValue(new Error("HTTP 429"));

    await expect(fetchVexPair()).rejects.toThrow("HTTP 429");
  });
});
