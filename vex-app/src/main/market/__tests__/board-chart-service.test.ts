/**
 * The spotlight chart's candle poll, driven through its real code over a
 * scripted provider.
 *
 * WHAT IS FAKED AND WHY THAT IS THE RIGHT SEAM. Two provider calls: the pair
 * subject resolution and the bars page. Both are the process boundary.
 * Everything above them is the shipped code - the window table, the
 * drop-and-report projection, the single-flight, the no-positive-cache policy,
 * the abort handling and the awaited drain. `barStepMs` and `barTransportFor`
 * are the REAL ones, because the partial-bar flag and the transport claim in
 * the service head are arithmetic over the provider's own resolution table and
 * a faked table would prove nothing about either.
 *
 * THE DEFAULT DEPS ARE UNDER TEST, not a hand-injected substitute, so the
 * arguments this service hands the bars endpoint - the resolved `ammId` and the
 * pair's OWN quote address, verbatim - are asserted rather than assumed. That
 * one is not a detail: the endpoint answers HTTP 200 with the series SILENTLY
 * INVERTED for a quote address that is merely lower-cased.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectedBar } from "@tools/dexscreener/endpoints/bars.js";

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

vi.mock("@tools/dexscreener/transport.js", () => ({
  getDexScreenerTransport: () => ({ name: "test" }),
}));

const { barTransportFor } = await import("@tools/dexscreener/endpoints/bars.js");
const { DexScreenerSiteErrorCodes, siteError } = await import(
  "@tools/dexscreener/site-errors.js"
);
const { BOARD_MAX_CANDLES } = await import("@vex-lib/board/index.js");
const { BOARD_CHART_PILL_RESOLUTIONS } = await import(
  "@shared/schemas/board-chart.js"
);
const {
  BOARD_CHART_BAR_COUNTS,
  createBoardChartService,
  getBoardChartService,
  mountBoardChartService,
  __resetBoardChartServiceForTests,
} = await import("../board-chart-service.js");

const SUBJECT = {
  chain: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
};

const PAIR = {
  chainId: "solana",
  pairAddress: "22CfmLna8Bsh7xrbyvGSs6NdD31iFj1UFVnwB7EberWU",
  ammId: "pumpfundex",
  // MIXED CASE ON PURPOSE. The lower-cased spelling of this same address is a
  // silently inverted series, so the test asserts it is forwarded verbatim.
  quoteTokenAddress: "So11111111111111111111111111111111111111112",
};

const NOW = 1_787_741_000_000;

/** `count` drawable one-minute bars ending `endsAtMs`, oldest first. */
function bars(count: number, endsAtMs = NOW - 60_000, stepMs = 60_000): ProjectedBar[] {
  return Array.from({ length: count }, (_unused, index) => ({
    timestampMs: endsAtMs - (count - 1 - index) * stepMs,
    openUsd: "1.5",
    highUsd: "1.9",
    lowUsd: "1.4",
    closeUsd: "1.8",
    openNative: null,
    highNative: null,
    lowNative: null,
    closeNative: null,
    volumeUsd: null,
    minBlockNumber: null,
    maxBlockNumber: null,
  }));
}

function page(rows: ReturnType<typeof bars>, fetchedAtMs = NOW) {
  return { bars: rows, transport: "http", url: "", bytes: 0, fetchedAtMs };
}

beforeEach(() => {
  resolvePairSubject.mockResolvedValue(PAIR);
  fetchBarsPage.mockResolvedValue(page(bars(3)));
});

afterEach(() => {
  __resetBoardChartServiceForTests();
  vi.clearAllMocks();
});

// ── The window table ─────────────────────────────────────────────────────

describe("the bar-count table is the pill's own span and fits the board's ceiling", () => {
  it.each([
    ["1m", 60, 60 * 60_000],
    ["15m", 96, 24 * 3_600_000],
    ["2h", 84, 7 * 86_400_000],
    ["8h", 90, 30 * 86_400_000],
  ] as const)("%s covers its span in %i bars", (resolution, count, spanMs) => {
    const stepMs = { "1m": 60_000, "15m": 900_000, "2h": 7_200_000, "8h": 28_800_000 }[
      resolution
    ];
    expect(BOARD_CHART_BAR_COUNTS[resolution]).toBe(count);
    expect(count * stepMs).toBe(spanMs);
  });

  it.each(BOARD_CHART_PILL_RESOLUTIONS)(
    "%s asks for no more bars than the board's own series may carry",
    (resolution) => {
      expect(BOARD_CHART_BAR_COUNTS[resolution]).toBeLessThanOrEqual(BOARD_MAX_CANDLES);
    },
  );

  it.each(BOARD_CHART_PILL_RESOLUTIONS)(
    "%s is served over plain HTTP, so no bridge coalescence can join it",
    (resolution) => {
      // The service head claims this. If a pill ever moved to the socket
      // transport, its reads WOULD be coalescable with an agent's and the
      // isolation argument would need a `coalesceScope` instead of a comment.
      expect(barTransportFor(resolution)).toBe("http");
    },
  );

  it.each(BOARD_CHART_PILL_RESOLUTIONS)(
    "asks the provider for exactly the %s window",
    async (resolution) => {
      const service = createBoardChartService({ now: () => NOW });
      await service.poll({ subject: SUBJECT, resolution });
      expect(fetchBarsPage).toHaveBeenCalledWith(
        expect.objectContaining({
          resolution,
          countBack: BOARD_CHART_BAR_COUNTS[resolution],
          series: "price",
          inverted: false,
        }),
      );
      await service.dispose();
    },
  );
});

// ── The read ─────────────────────────────────────────────────────────────

describe("one poll", () => {
  it("forwards the RESOLVED amm and quote address verbatim", async () => {
    const service = createBoardChartService({ now: () => NOW });
    await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(fetchBarsPage).toHaveBeenCalledWith(
      expect.objectContaining({
        ammId: PAIR.ammId,
        quoteTokenAddress: PAIR.quoteTokenAddress,
      }),
    );
    await service.dispose();
  });

  it("projects the bars, covers the range and marks a forming last bar", async () => {
    fetchBarsPage.mockResolvedValue(page(bars(3, NOW)));
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(outcome.kind).toBe("series");
    if (outcome.kind !== "series") return;
    expect(outcome.series.bars).toHaveLength(3);
    expect(outcome.series.coveredRange).toEqual({
      fromMs: NOW - 120_000,
      toMs: NOW,
    });
    // The newest bar opened at `NOW` and its minute has not closed.
    expect(outcome.series.lastBarPartial).toBe(true);
    expect(outcome.series.truncated).toBe(false);
    expect(outcome.providerBars).toBe(3);
    expect(outcome.requestedBars).toBe(60);
    await service.dispose();
  });

  it("marks a CLOSED last bar as settled", async () => {
    fetchBarsPage.mockResolvedValue(page(bars(2, NOW - 120_000)));
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(outcome.kind === "series" && outcome.series.lastBarPartial).toBe(false);
    await service.dispose();
  });

  it("DROPS an undrawable bar and COUNTS it rather than drawing a flat candle", async () => {
    const rows = bars(3, NOW);
    const undrawable = { ...rows[2], closeUsd: null as string | null };
    fetchBarsPage.mockResolvedValue({
      bars: [...rows.slice(0, 2), undrawable],
      transport: "http",
      url: "",
      bytes: 0,
      fetchedAtMs: NOW,
    });
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(outcome.kind).toBe("series");
    if (outcome.kind !== "series") return;
    expect(outcome.series.bars).toHaveLength(2);
    expect(outcome.undrawableBars).toBe(1);
    expect(outcome.providerBars).toBe(3);
    expect(outcome.series.truncated).toBe(true);
    await service.dispose();
  });

  it("windows a provider page longer than the pill and REPORTS the cut", async () => {
    fetchBarsPage.mockResolvedValue(page(bars(62, NOW)));
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(outcome.kind).toBe("series");
    if (outcome.kind !== "series") return;
    expect(outcome.series.bars).toHaveLength(60);
    expect(outcome.windowedOutBars).toBe(2);
    expect(outcome.series.truncated).toBe(true);
    // The NEWEST bars are the ones kept: a chart trimmed from the wrong end
    // would show the reader a window that ended before the price they see.
    expect(outcome.series.coveredRange.toMs).toBe(NOW);
    await service.dispose();
  });

  it("calls an empty page an ABSENCE, not a failure to apologise for", async () => {
    fetchBarsPage.mockResolvedValue(page([]));
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "15m" });
    expect(outcome).toEqual({ kind: "absent", reason: "no_drawable_bars" });
    await service.dispose();
  });

  it("calls a pair the provider does not know an ABSENCE", async () => {
    resolvePairSubject.mockRejectedValue(
      siteError(DexScreenerSiteErrorCodes.PAIR_DETAILS_UNKNOWN, "unknown"),
    );
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(outcome).toEqual({ kind: "absent", reason: "unknown_pair" });
    await service.dispose();
  });

  it.each([
    [DexScreenerSiteErrorCodes.TRANSPORT_TIMEOUT, "transport"],
    [DexScreenerSiteErrorCodes.SITE_TRANSPORT_UNAVAILABLE, "not_mounted"],
  ])("keeps %s UNAVAILABLE, because nothing was learned", async (code, reason) => {
    fetchBarsPage.mockRejectedValue(siteError(code, "nope"));
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(outcome).toEqual({ kind: "unavailable", reason });
    await service.dispose();
  });
});

// ── Single-flight, and the deliberate absence of a positive cache ─────────

describe("single-flight without a positive cache", () => {
  it("joins two concurrent polls for the same pool and pill onto one exchange", async () => {
    let release = (): void => undefined;
    let started = (): void => undefined;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchBarsPage.mockImplementation(
      async () =>
        new Promise((resolve) => {
          started();
          release = (): void => {
            resolve(page(bars(3, NOW)));
          };
        }),
    );
    const service = createBoardChartService({ now: () => NOW });
    const both = Promise.all([
      service.poll({ subject: SUBJECT, resolution: "1m" }),
      service.poll({ subject: SUBJECT, resolution: "1m" }),
    ]);
    await startedAt;
    release();
    const [first, second] = await both;
    expect(fetchBarsPage).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    await service.dispose();
  });

  it("does NOT join two different pills of the same pool", async () => {
    const service = createBoardChartService({ now: () => NOW });
    await Promise.all([
      service.poll({ subject: SUBJECT, resolution: "1m" }),
      service.poll({ subject: SUBJECT, resolution: "15m" }),
    ]);
    expect(fetchBarsPage).toHaveBeenCalledTimes(2);
    await service.dispose();
  });

  it("READS AGAIN on the next poll: a forming bar is the reason it polls", async () => {
    const service = createBoardChartService({ now: () => NOW });
    await service.poll({ subject: SUBJECT, resolution: "1m" });
    await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(fetchBarsPage).toHaveBeenCalledTimes(2);
    await service.dispose();
  });
});

// ── Volume rides beside the candle, positionally ─────────────────────────

describe("volume", () => {
  it("carries each drawn bar's volume at the same index, and counts the volumeless", async () => {
    const rows = bars(4, NOW - 60_000);
    const withVolume = rows.map((row, index) => ({
      ...row,
      volumeUsd: index === 1 ? null : `${String(100 + index)}.5`,
      // The third bar has no close: undrawable, so it drops out of BOTH
      // arrays together and the alignment survives.
      closeUsd: index === 2 ? null : row.closeUsd,
    }));
    fetchBarsPage.mockResolvedValue(page(withVolume));
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(outcome.kind).toBe("series");
    if (outcome.kind !== "series") return;
    expect(outcome.series.bars).toHaveLength(3);
    expect(outcome.volumes).toEqual(["100.5", null, "103.5"]);
    expect(outcome.volumelessBars).toBe(1);
    expect(outcome.undrawableBars).toBe(1);
    // The durable candle is untouched: no volume key on it.
    expect(Object.keys(outcome.series.bars[0] ?? {})).toEqual(["tMs", "o", "h", "l", "c"]);
    await service.dispose();
  });

  it("keeps volumes aligned with the WINDOWED bars, not the provider page", async () => {
    const rows = bars(62, NOW - 60_000).map((row, index) => ({
      ...row,
      volumeUsd: String(index),
    }));
    fetchBarsPage.mockResolvedValue(page(rows));
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    if (outcome.kind !== "series") throw new Error("expected series");
    expect(outcome.series.bars).toHaveLength(60);
    expect(outcome.windowedOutBars).toBe(2);
    expect(outcome.volumes).toHaveLength(60);
    expect(outcome.volumes[0]).toBe("2");
    expect(outcome.volumes[59]).toBe("61");
    expect(outcome.volumelessBars).toBe(0);
    await service.dispose();
  });

  it("refuses a volume that is not the provider's decimal grammar rather than guessing", async () => {
    const rows = bars(2, NOW - 60_000).map((row, index) => ({
      ...row,
      volumeUsd: index === 0 ? "1e5" : "",
    }));
    fetchBarsPage.mockResolvedValue(page(rows));
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    if (outcome.kind !== "series") throw new Error("expected series");
    expect(outcome.volumes).toEqual([null, null]);
    expect(outcome.volumelessBars).toBe(2);
    await service.dispose();
  });
});

// ── Cancellation and teardown ────────────────────────────────────────────

describe("cancellation", () => {
  it("refuses before any provider call when the caller is already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = createBoardChartService({ now: () => NOW });
    const outcome = await service.poll({
      subject: SUBJECT,
      resolution: "1m",
      signal: controller.signal,
    });
    expect(outcome).toEqual({ kind: "unavailable", reason: "cancelled" });
    expect(resolvePairSubject).not.toHaveBeenCalled();
    await service.dispose();
  });

  it("ABORTS the in-flight provider read when the last caller's signal fires", async () => {
    const controller = new AbortController();
    let aborted = false;
    let started = (): void => undefined;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchBarsPage.mockImplementation(
      async (args: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          started();
          args.signal.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const service = createBoardChartService({ now: () => NOW });
    const running = service.poll({
      subject: SUBJECT,
      resolution: "1m",
      signal: controller.signal,
    });
    await startedAt;
    controller.abort();
    expect(await running).toEqual({ kind: "unavailable", reason: "cancelled" });
    // The provider call itself was cut, not merely stopped being waited on.
    expect(aborted).toBe(true);
    await service.dispose();
  });

  it("keeps a JOINED caller's answer when the other caller leaves", async () => {
    // The departing reader must not take the answer away from the surface that
    // is still on screen, which is why the flight counts its waiters.
    const leaving = new AbortController();
    let release = (): void => undefined;
    let started = (): void => undefined;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchBarsPage.mockImplementation(
      async () =>
        new Promise((resolve) => {
          started();
          release = (): void => {
            resolve(page(bars(3, NOW)));
          };
        }),
    );
    const service = createBoardChartService({ now: () => NOW });
    const stayingResult = service.poll({ subject: SUBJECT, resolution: "1m" });
    const leavingResult = service.poll({
      subject: SUBJECT,
      resolution: "1m",
      signal: leaving.signal,
    });
    await startedAt;
    leaving.abort();
    expect(await leavingResult).toEqual({ kind: "unavailable", reason: "cancelled" });
    release();
    expect((await stayingResult).kind).toBe("series");
    expect(fetchBarsPage).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  /**
   * THE CANCELLED-PILL DEFECT. Two single-flight owners disagreed about when
   * an aborted flight stops being joinable: the service deleted its flight at
   * abort time, the cache deleted its record only when the aborted load
   * SETTLED. A caller arriving in that window joined a corpse and was told
   * "cancelled" about a read it never asked to cancel - which the renderer
   * then drew as "This read was cancelled." on the default pill.
   */
  it("a caller that arrives AFTER the last caller left does not inherit its cancellation", async () => {
    const first = new AbortController();
    const releases: (() => void)[] = [];
    let started = (): void => undefined;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchBarsPage.mockImplementation(
      async (args: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          releases.push(() => {
            resolve(page(bars(3, NOW)));
          });
          args.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
          started();
        }),
    );
    const service = createBoardChartService({ now: () => NOW });
    const departing = service.poll({
      subject: SUBJECT,
      resolution: "15m",
      signal: first.signal,
    });
    await startedAt;
    first.abort();
    // The next caller arrives in the SAME turn: the aborted read has not
    // settled yet, which is exactly the window the defect lived in.
    const fresh = new AbortController();
    const arriving = service.poll({
      subject: SUBJECT,
      resolution: "15m",
      signal: fresh.signal,
    });
    expect(await departing).toEqual({ kind: "unavailable", reason: "cancelled" });
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    for (const release of releases) release();
    expect((await arriving).kind).toBe("series");
    // A fresh read for the fresh caller, not the corpse of the first one.
    expect(fetchBarsPage).toHaveBeenCalledTimes(2);
    await service.dispose();
  });
});

describe("teardown", () => {
  it("DRAINS the read in flight rather than abandoning it", async () => {
    let settled = false;
    let started = (): void => undefined;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchBarsPage.mockImplementation(
      async (args: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          started();
          args.signal.addEventListener("abort", () => {
            // The endpoint finishing its own unwinding AFTER the abort is the
            // whole hazard: a dropped teardown promise lets this land on a
            // transport that has already been disposed.
            setTimeout(() => {
              settled = true;
              resolve(page([]));
            }, 5);
          });
        }),
    );
    const service = createBoardChartService({ now: () => NOW });
    const running = service.poll({ subject: SUBJECT, resolution: "1m" });
    await startedAt;
    await service.dispose();
    expect(settled).toBe(true);
    await running;
  });

  it("refuses new work after dispose instead of touching the transport", async () => {
    const service = createBoardChartService({ now: () => NOW });
    await service.dispose();
    const outcome = await service.poll({ subject: SUBJECT, resolution: "1m" });
    expect(outcome).toEqual({ kind: "unavailable", reason: "not_mounted" });
    expect(fetchBarsPage).not.toHaveBeenCalled();
  });

  it("is idempotent", async () => {
    const service = createBoardChartService({ now: () => NOW });
    await service.dispose();
    await expect(service.dispose()).resolves.toBeUndefined();
  });
});

describe("the mounted instance", () => {
  it("is null before a mount and released by its AWAITED teardown", async () => {
    expect(getBoardChartService()).toBeNull();
    const unmount = mountBoardChartService({ now: () => NOW });
    expect(getBoardChartService()).not.toBeNull();
    await unmount();
    expect(getBoardChartService()).toBeNull();
  });
});
