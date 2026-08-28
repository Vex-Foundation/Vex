/**
 * The cold sparkline pipeline, driven through its real queue over a scripted
 * provider.
 *
 * WHAT IS FAKED AND WHY THAT IS THE RIGHT SEAM. Two provider calls: the pair
 * subject resolution and the bars page. Both are the process boundary, and both
 * are what probe P5 was timing. Everything above them is the shipped code - the
 * width-2 queue, the board-wide deadline, the abort chaining, the drop-and-
 * report projection and the per-pool outcome vocabulary. `barStepMs` is the
 * REAL one, because the partial-bar flag is arithmetic over the provider's own
 * resolution table and a faked step would prove nothing about it.
 *
 * THE NUMBERS UNDER TEST ARE THE MEASURED ONES (probe P5, 8 pools, 15m, 50
 * bars): sequential 18.24 s, width 2 11.50 s, per-call mean 2.28 s. The
 * deadline and the width below are the parameters those numbers bought, and the
 * cases assert the behaviour at their edges rather than the numbers themselves.
 *
 * Race-table rows covered here: R18, R25.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const resolvePairSubject = vi.fn();
const fetchBarsPage = vi.fn();

vi.mock("@tools/dexscreener/endpoints/pair-subject.js", () => ({
  resolvePairSubject: (...args: unknown[]): unknown => resolvePairSubject(...args),
}));

vi.mock("@tools/dexscreener/endpoints/bars.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@tools/dexscreener/endpoints/bars.js")
  >();
  return {
    ...actual,
    fetchBarsPage: (...args: unknown[]): unknown => fetchBarsPage(...args),
  };
});

const { createBoardSparklineService } = await import(
  "../board-sparkline-service.js"
);
const { DexScreenerSiteErrorCodes } = await import(
  "@tools/dexscreener/site-errors.js"
);

type Subject = { chain: string; pairAddress: string };

const POOLS: readonly Subject[] = [
  { chain: "ethereum", pairAddress: "0xPairAAA" },
  { chain: "solana", pairAddress: "PairBBB" },
  { chain: "base", pairAddress: "0xPairCCC" },
  { chain: "robinhood", pairAddress: "0xPairDDD" },
];

/** The subject fields the bars route is addressed by. */
function pairSubject(subject: Subject): Record<string, unknown> {
  return {
    chainId: subject.chain,
    pairAddress: subject.pairAddress,
    ammId: "uniswap",
    // The pair's OWN quote token, provider-spelled. A lower-cased or absent
    // value returns HTTP 200 with a SILENTLY INVERTED series, which is why the
    // service resolves it rather than assembling it.
    quoteTokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    quoteTokenSymbol: "WETH",
    baseTokenAddress: "0xBase",
    baseTokenSymbol: "AAA",
  };
}

/** One provider bar. Prices are decimal STRINGS all the way to the canvas. */
function bar(timestampMs: number, close = "0.00000123"): Record<string, unknown> {
  return {
    timestampMs,
    openNative: null,
    highNative: null,
    lowNative: null,
    closeNative: null,
    openUsd: close,
    highUsd: close,
    lowUsd: close,
    closeUsd: close,
    volumeUsd: "12.5",
    minBlockNumber: null,
    maxBlockNumber: null,
  };
}

function barsPage(
  bars: readonly Record<string, unknown>[],
  fetchedAtMs = 1_756_000_000_000,
): Record<string, unknown> {
  return { bars, transport: "http", url: "https://io.dexscreener.com/x", bytes: 1, fetchedAtMs };
}

/** A promise whose settlement this test owns. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resolvePairSubject.mockReset();
  fetchBarsPage.mockReset();
  resolvePairSubject.mockImplementation((options: { chainId: string; pairAddress: string }) =>
    Promise.resolve(pairSubject({ chain: options.chainId, pairAddress: options.pairAddress })),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the happy path", () => {
  it("draws a line for every pool, keyed by identity", async () => {
    fetchBarsPage.mockResolvedValue(
      barsPage([bar(1_755_999_000_000), bar(1_755_999_900_000)]),
    );
    const service = createBoardSparklineService();
    const result = await service.hydrate({ pools: POOLS, resolution: "15m" });

    expect(result.entries).toHaveLength(POOLS.length);
    expect(result.deadlineHit).toBe(false);
    for (const entry of result.entries) {
      expect(entry.outcome.kind).toBe("series");
    }
    // Keyed by identity AND ordered, so a reordering can never draw one pool's
    // line on another pool's card.
    expect(result.entries.map((entry) => entry.key)).toEqual([
      "ethereum:0xpairaaa",
      "solana:pairbbb",
      "base:0xpairccc",
      "robinhood:0xpairddd",
    ]);
  });

  it("resolves the pair subject before the bars, never assembling the quote token", async () => {
    // The bars route answers HTTP 200 with a SILENTLY INVERTED series for a
    // quote token that is wrong or merely lower-cased, and the inverted answer
    // is indistinguishable at the row level.
    fetchBarsPage.mockResolvedValue(barsPage([bar(1_755_999_000_000)]));
    const service = createBoardSparklineService({ queueWidth: 1 });
    await service.hydrate({ pools: [POOLS[0] as Subject], resolution: "15m" });

    expect(resolvePairSubject).toHaveBeenCalledTimes(1);
    const passed = fetchBarsPage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(passed["quoteTokenAddress"]).toBe(
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    );
    expect(passed["ammId"]).toBe("uniswap");
    expect(passed["countBack"]).toBe(50);
  });

  it("runs the queue two wide and no wider", async () => {
    // Width 2 is the measured optimum (P5: 18.24 s sequential against 11.50 s)
    // AND the board's whole share of a transport the agent also uses. Width 3
    // was never measured and is not adopted.
    let concurrent = 0;
    let peak = 0;
    const gates = POOLS.map(() => deferred());
    let index = 0;
    fetchBarsPage.mockImplementation(async () => {
      const gate = gates[index];
      index += 1;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await gate?.promise;
      concurrent -= 1;
      return barsPage([bar(1_755_999_000_000)]);
    });

    const service = createBoardSparklineService();
    const running = service.hydrate({ pools: POOLS, resolution: "15m" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    for (const gate of gates) gate.resolve(undefined);
    await running;

    expect(peak).toBe(2);
  });
});

describe("absences and failures are per pool", () => {
  it("a pool with no drawable bars is an ABSENCE, not a failure", async () => {
    // A pool minutes old genuinely has no line. A card that said "could not
    // load" about it would describe a provider problem that did not happen.
    fetchBarsPage.mockResolvedValue(barsPage([]));
    const service = createBoardSparklineService();
    const result = await service.hydrate({
      pools: [POOLS[0] as Subject],
      resolution: "15m",
    });
    expect(result.entries[0]?.outcome).toEqual({
      kind: "absent",
      reason: "no_drawable_bars",
    });
  });

  it("drops a bar with no USD price and REPORTS the drop as truncation", async () => {
    // A dropped bar left as a gap reads to a human as a flat candle, which is
    // a claim about the price that nobody made.
    const noPrice = { ...bar(1_755_999_000_000), closeUsd: null };
    fetchBarsPage.mockResolvedValue(
      barsPage([bar(1_755_998_100_000), noPrice, bar(1_755_999_900_000)]),
    );
    const service = createBoardSparklineService();
    const result = await service.hydrate({
      pools: [POOLS[0] as Subject],
      resolution: "15m",
    });
    const outcome = result.entries[0]?.outcome;
    expect(outcome?.kind).toBe("series");
    if (outcome?.kind !== "series") return;
    expect(outcome.series.bars).toHaveLength(2);
    expect(outcome.series.truncated).toBe(true);
  });

  it("one pool failing leaves every other pool's line intact", async () => {
    let call = 0;
    fetchBarsPage.mockImplementation(() => {
      call += 1;
      if (call === 2) return Promise.reject(new Error("provider refused"));
      return Promise.resolve(barsPage([bar(1_755_999_000_000)]));
    });
    const service = createBoardSparklineService();
    const result = await service.hydrate({ pools: POOLS, resolution: "15m" });

    const kinds = result.entries.map((entry) => entry.outcome.kind);
    expect(kinds.filter((kind) => kind === "series")).toHaveLength(3);
    expect(kinds.filter((kind) => kind === "unavailable")).toHaveLength(1);
  });

  it("tells an unknown pair (settled) apart from a transport failure (unknown)", async () => {
    const unknownPair = Object.assign(new Error("no such pair"), {
      code: DexScreenerSiteErrorCodes.PAIR_DETAILS_UNKNOWN,
    });
    const timeout = Object.assign(new Error("timed out"), {
      code: DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT,
    });
    let call = 0;
    resolvePairSubject.mockImplementation(() => {
      call += 1;
      return call === 1 ? Promise.reject(unknownPair) : Promise.reject(timeout);
    });

    const service = createBoardSparklineService({ queueWidth: 1 });
    const result = await service.hydrate({
      pools: POOLS.slice(0, 2),
      resolution: "15m",
    });
    expect(result.entries[0]?.outcome).toEqual({
      kind: "absent",
      reason: "unknown_pair",
    });
    expect(result.entries[1]?.outcome).toEqual({
      kind: "unavailable",
      reason: "transport",
    });
  });
});

describe("the board-wide deadline", () => {
  it("R25: returns the pools that landed rather than failing the board", () => {
    // The whole reason the queue records results AS THEY SETTLE. A deadline
    // that expires after the first pools must not discard their real lines.
    //
    // The clock is DRIVEN rather than slept on: the first two reads complete
    // at t=0 and the second one moves the clock past the budget, which is the
    // exact shape of a real expiry with none of the flakiness of a real wait.
    let clock = 0;
    let call = 0;
    fetchBarsPage.mockImplementation(() => {
      call += 1;
      if (call === 2) clock = 5_000;
      return Promise.resolve(barsPage([bar(1_755_999_000_000)]));
    });

    const service = createBoardSparklineService({
      queueWidth: 1,
      deadlineMs: 1_000,
      now: () => clock,
    });
    return service.hydrate({ pools: POOLS, resolution: "15m" }).then((result) => {
      expect(result.deadlineHit).toBe(true);
      // The lines that landed are KEPT. Nothing waits for the slowest pool and
      // no pool's answer is discarded because another pool was slow.
      const drawn = result.entries.filter((entry) => entry.outcome.kind === "series");
      expect(drawn).toHaveLength(2);
      // Every pool still has an entry, and the ones never reached say why, so a
      // caller can ask again for exactly those.
      expect(result.entries).toHaveLength(POOLS.length);
      const notReached = result.entries.filter(
        (entry) =>
          entry.outcome.kind === "unavailable" && entry.outcome.reason === "deadline",
      );
      expect(notReached).toHaveLength(2);
    });
  });
});

describe("cancellation", () => {
  it("R18: closing the modal mid-batch cancels every read and stops the queue", async () => {
    // The reader closed the board. Nothing may keep reading for a surface that
    // is gone, and the pools that were never asked about are reported as the
    // reader's own cancellation rather than a provider problem.
    const controller = new AbortController();
    const gate = deferred();
    const signals: AbortSignal[] = [];
    let started = 0;

    fetchBarsPage.mockImplementation(async (options: { signal?: AbortSignal }) => {
      started += 1;
      if (options.signal !== undefined) signals.push(options.signal);
      await gate.promise;
      return barsPage([bar(1_755_999_000_000)]);
    });

    const service = createBoardSparklineService();
    const running = service.hydrate({
      pools: POOLS,
      resolution: "15m",
      signal: controller.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toBe(2);

    controller.abort();
    gate.resolve(undefined);
    const result = await running;

    // The signal handed to the provider is aborted: cancellation is propagated,
    // not simulated.
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    // The queue stopped admitting: the last two pools were never asked about.
    expect(started).toBe(2);
    const cancelled = result.entries.filter(
      (entry) =>
        entry.outcome.kind === "unavailable" && entry.outcome.reason === "cancelled",
    );
    expect(cancelled.length).toBe(2);
  });

  it("an already-aborted signal reads nothing at all", async () => {
    fetchBarsPage.mockResolvedValue(barsPage([bar(1_755_999_000_000)]));
    const controller = new AbortController();
    controller.abort();

    const service = createBoardSparklineService();
    const result = await service.hydrate({
      pools: POOLS,
      resolution: "15m",
      signal: controller.signal,
    });

    expect(fetchBarsPage).not.toHaveBeenCalled();
    expect(resolvePairSubject).not.toHaveBeenCalled();
    for (const entry of result.entries) {
      expect(entry.outcome).toEqual({ kind: "unavailable", reason: "cancelled" });
    }
  });
});
