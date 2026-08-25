/**
 * VEX market poller tests (T1).
 *
 * Deps are injected, so this exercises the compose + last-good + staleness +
 * lifecycle logic without electron, the DB, or a real network. Heavy imports
 * reached transitively (snapshot-cache → broadcast → electron, logger, the
 * fetch clients) are mocked; the injected fetchers/publish stand in for them.
 *
 * Pins: a healthy poll composes a full snapshot; a failed newest price poll
 * re-broadcasts last-good data marked `stale`; supplementary feeds (sparkline /
 * holders) failing still yield a usable price snapshot with nulls; `stop()`
 * clears every timer, is idempotent, and no poll fires after it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VexPairData } from "../dexscreener-pair.js";

vi.mock("../snapshot-cache.js", () => ({
  publishSnapshot: vi.fn(),
  getCurrentSnapshot: vi.fn(() => null),
}));
vi.mock("../dexscreener-pair.js", () => ({ fetchVexPair: vi.fn() }));
vi.mock("../vex-candles.js", () => ({ fetchVexSparkline: vi.fn() }));
vi.mock("../virtuals-client.js", () => ({ fetchVexHolderCount: vi.fn() }));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { setupVexMarketService } = await import("../vex-market-service.js");

const PAIR: VexPairData = {
  priceUsd: 0.000543,
  priceChange: { h1: -1.73, h24: 113 },
  marketCap: 543068,
  fdv: 543068,
  liquidityUsd: 75189.01,
  volumeH24: 464284.04,
  txnsH24: { buys: 1235, sells: 856 },
};

const SPARK: Array<[number, number]> = [
  [1783166400, 0.000527],
  [1783170000, 0.00055],
];

// Intervals kept far apart so a single `advanceTimersByTimeAsync` isolates the
// loop under test.
const BASE = {
  now: () => 1_000,
  priceIntervalMs: 10_000,
  sparklineIntervalMs: 500_000,
  holderIntervalMs: 900_000,
  jitterMs: () => 0,
} as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("setupVexMarketService", () => {
  it("composes a full snapshot on a healthy poll", async () => {
    const publish = vi.fn();
    const stop = setupVexMarketService({
      ...BASE,
      fetchPair: vi.fn().mockResolvedValue(PAIR),
      fetchSparkline: vi.fn().mockResolvedValue(SPARK),
      fetchHolderCount: vi.fn().mockResolvedValue(354),
      publish,
    });

    await vi.advanceTimersByTimeAsync(0); // immediate first tick of each loop

    const last = publish.mock.calls.at(-1)?.[0];
    expect(last).toBeDefined();
    expect(last.priceUsd).toBe(PAIR.priceUsd);
    expect(last.priceChange).toEqual(PAIR.priceChange);
    expect(last.txnsH24).toEqual(PAIR.txnsH24);
    expect(last.sparkline).toEqual(SPARK);
    expect(last.holderCount).toBe(354);
    expect(last.stale).toBe(false);
    await stop();
  });

  it("marks last-good data stale when the newest price poll fails (429)", async () => {
    const fetchPair = vi
      .fn()
      .mockResolvedValueOnce(PAIR)
      .mockRejectedValue(new Error("HTTP 429"));
    const publish = vi.fn();
    const stop = setupVexMarketService({
      ...BASE,
      fetchPair,
      fetchSparkline: vi.fn().mockResolvedValue([]),
      fetchHolderCount: vi.fn().mockResolvedValue(null),
      publish,
    });

    await vi.advanceTimersByTimeAsync(0); // first price tick OK
    const fresh = publish.mock.calls.at(-1)?.[0];
    expect(fresh.priceUsd).toBe(PAIR.priceUsd);
    expect(fresh.stale).toBe(false);

    publish.mockClear();
    await vi.advanceTimersByTimeAsync(BASE.priceIntervalMs); // second price tick fails

    const stalePublish = publish.mock.calls.at(-1)?.[0];
    expect(stalePublish).toBeDefined();
    // Last-good price is preserved; only the freshness flag flips.
    expect(stalePublish.priceUsd).toBe(PAIR.priceUsd);
    expect(stalePublish.stale).toBe(true);
    await stop();
  });

  it("yields a usable price snapshot when sparkline + holders fail", async () => {
    const publish = vi.fn();
    const stop = setupVexMarketService({
      ...BASE,
      fetchPair: vi.fn().mockResolvedValue(PAIR),
      fetchSparkline: vi.fn().mockRejectedValue(new Error("candles unavailable")),
      fetchHolderCount: vi.fn().mockRejectedValue(new Error("virtuals down")),
      publish,
    });

    await vi.advanceTimersByTimeAsync(0);

    const last = publish.mock.calls.at(-1)?.[0];
    expect(last).toBeDefined();
    expect(last.priceUsd).toBe(PAIR.priceUsd);
    expect(last.sparkline).toEqual([]); // supplementary feed down → empty
    expect(last.holderCount).toBeNull();
    expect(last.stale).toBe(false); // price is fresh; supplementary failures don't stale it
    await stop();
  });

  it("keeps last-good holderCount when a later holder poll returns null", async () => {
    const publish = vi.fn();
    const stop = setupVexMarketService({
      ...BASE,
      holderIntervalMs: 10_000,
      fetchPair: vi.fn().mockResolvedValue(PAIR),
      fetchSparkline: vi.fn().mockResolvedValue(SPARK),
      fetchHolderCount: vi.fn().mockResolvedValueOnce(354).mockResolvedValue(null),
      publish,
    });

    await vi.advanceTimersByTimeAsync(0); // first holder poll → 354
    await vi.advanceTimersByTimeAsync(10_000); // second holder poll → null (ignored)

    const last = publish.mock.calls.at(-1)?.[0];
    expect(last.holderCount).toBe(354);
    await stop();
  });

  it("stop() clears timers, is idempotent, and no poll fires afterwards", async () => {
    const fetchPair = vi.fn().mockResolvedValue(PAIR);
    const stop = setupVexMarketService({
      ...BASE,
      fetchPair,
      fetchSparkline: vi.fn().mockResolvedValue(SPARK),
      fetchHolderCount: vi.fn().mockResolvedValue(354),
      publish: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(0);
    const callsBefore = fetchPair.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    await stop();
    await stop(); // idempotent - no throw, no double teardown

    await vi.advanceTimersByTimeAsync(1_000_000); // well past every interval
    expect(fetchPair.mock.calls.length).toBe(callsBefore);
  });
});
