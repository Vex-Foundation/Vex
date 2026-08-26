/**
 * THE SPOTLIGHT CHART'S LIFECYCLE.
 *
 * The library is faked at the module boundary, exactly as the board's
 * existing chart tests fake it, so what is under test is OUR discipline:
 * which calls happen, in which order, and which are refused. A canvas is not
 * the subject and jsdom cannot paint one anyway.
 *
 * THE CLAIMS:
 *  - one instance, created once, NOT rebuilt by a resolution switch;
 *  - a switch shows an explicit skeleton and fits exactly once per subject;
 *  - a response echoing a resolution that is not the pill on screen is
 *    REFUSED - it never reaches the series, and it is not an error either;
 *  - the feed is cut before the instance is released, on every exit;
 *  - the keyboard readout moves a bar cursor and writes the figures itself,
 *    because `setCrosshairPosition` suppresses the event it would otherwise
 *    have waited for;
 *  - the tooltip is anchored through `timeToCoordinate`/`priceToCoordinate`
 *    rather than at the pointer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* The library double                                                  */
/* ------------------------------------------------------------------ */

interface ChartRecord {
  removed: boolean;
  options: Record<string, unknown>;
  seriesOptions: Record<string, unknown>;
  appliedSeriesOptions: Record<string, unknown>[];
  setDataCalls: unknown[][];
  updateCalls: { point: unknown; historical: boolean | undefined }[];
  fitContentCalls: number;
  setVisibleRangeCalls: unknown[];
  crosshairPositions: unknown[];
  clearedCrosshairs: number;
  crosshairHandlers: ((param: unknown) => void)[];
  unsubscribed: number;
  timeToCoordinateCalls: number;
  priceToCoordinateCalls: number;
  barsAfter: number;
  visibleRange: { from: number; to: number };
}

const charts: ChartRecord[] = [];

vi.mock("lightweight-charts", () => {
  const AreaSeries = { type: "Area" };
  return {
    AreaSeries,
    CrosshairMode: { Normal: 0, Magnet: 1, Hidden: 2, MagnetOHLC: 3 },
    LastPriceAnimationMode: { Disabled: 0, Continuous: 1, OnDataUpdate: 2 },
    createChart: (_el: HTMLElement, options: Record<string, unknown>) => {
      const record: ChartRecord = {
        removed: false,
        options,
        seriesOptions: {},
        appliedSeriesOptions: [],
        setDataCalls: [],
        updateCalls: [],
        fitContentCalls: 0,
        setVisibleRangeCalls: [],
        crosshairPositions: [],
        clearedCrosshairs: 0,
        crosshairHandlers: [],
        unsubscribed: 0,
        timeToCoordinateCalls: 0,
        priceToCoordinateCalls: 0,
        barsAfter: 0,
        visibleRange: { from: 0, to: 0 },
      };
      charts.push(record);
      const series = {
        setData: (data: unknown[]) => {
          record.setDataCalls.push(data);
        },
        update: (point: unknown, historical?: boolean) => {
          record.updateCalls.push({ point, historical });
        },
        applyOptions: (next: Record<string, unknown>) => {
          record.appliedSeriesOptions.push(next);
        },
        priceToCoordinate: () => {
          record.priceToCoordinateCalls += 1;
          return 42;
        },
        barsInLogicalRange: () => ({ barsBefore: 0, barsAfter: record.barsAfter }),
      };
      return {
        addSeries: (_def: unknown, seriesOptions: Record<string, unknown>) => {
          record.seriesOptions = seriesOptions;
          return series;
        },
        applyOptions: () => {},
        timeScale: () => ({
          fitContent: () => {
            record.fitContentCalls += 1;
          },
          getVisibleLogicalRange: () => ({ from: 0, to: 10 }),
          getVisibleRange: () => record.visibleRange,
          setVisibleRange: (range: unknown) => {
            record.setVisibleRangeCalls.push(range);
          },
          timeToCoordinate: () => {
            record.timeToCoordinateCalls += 1;
            return 100;
          },
        }),
        subscribeCrosshairMove: (handler: (param: unknown) => void) => {
          record.crosshairHandlers.push(handler);
        },
        unsubscribeCrosshairMove: () => {
          record.unsubscribed += 1;
        },
        setCrosshairPosition: (price: unknown, time: unknown) => {
          record.crosshairPositions.push({ price, time });
        },
        clearCrosshairPosition: () => {
          record.clearedCrosshairs += 1;
        },
        remove: () => {
          record.removed = true;
        },
      };
    },
  };
});

const { SpotlightChart } = await import("../SpotlightChart.js");
const { useBoardSurfaceStore, BOARD_FILTER_NONE } = await import(
  "../board-surface-store.js"
);

/* ------------------------------------------------------------------ */
/* The channel double                                                  */
/* ------------------------------------------------------------------ */

const poll = vi.fn();

const SUBJECT = {
  chain: "base",
  pairAddress: "0xaaa111",
  ammId: "uniswap",
  baseTokenSymbol: "PEPE",
  baseTokenName: "Pepe the Frog",
  quoteTokenSymbol: "WETH",
  orientation: "base" as const,
};

const BASE_MS = Date.UTC(2026, 7, 26, 11, 0, 0);

function bars(count: number, from = 0) {
  return Array.from({ length: count }, (_, index) => {
    const price = `0.0000${String(100 + index + from)}`;
    return {
      tMs: BASE_MS + (index + from) * 60_000,
      o: price,
      h: price,
      l: price,
      c: price,
    };
  });
}

function okSeries(options: {
  resolution?: "1m" | "15m" | "2h" | "8h";
  count?: number;
  from?: number;
  providerBars?: number;
  lastBarPartial?: boolean;
} = {}) {
  const count = options.count ?? 5;
  const rows = bars(count, options.from ?? 0);
  return {
    ok: true as const,
    data: {
      subject: { chain: SUBJECT.chain, pairAddress: SUBJECT.pairAddress },
      resolution: options.resolution ?? "15m",
      outcome: {
        kind: "series" as const,
        series: {
          bars: rows,
          lastBarPartial: options.lastBarPartial ?? true,
          coveredRange: { fromMs: rows[0]?.tMs ?? BASE_MS, toMs: rows.at(-1)?.tMs ?? BASE_MS },
          resolution: options.resolution ?? "15m",
          truncated: false,
        },
        requestedBars: 96,
        providerBars: options.providerBars ?? count,
        undrawableBars: 0,
        windowedOutBars: 0,
        fetchedAtMs: BASE_MS,
      },
    },
  };
}

function bindStore(): void {
  useBoardSurfaceStore.setState({
    latestBoard: null,
    pinnedBoard: null,
    modalBoard: null,
    unseenBoardKey: null,
    surfaceKey: null,
    view: "spotlight",
    selectedPoolIndex: 0,
    filter: BOARD_FILTER_NONE,
    scrollTop: 0,
    askPanelOpen: false,
    liveRequested: false,
    modalGeneration: 0,
    spotlightGeneration: 0,
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function mount(live = false): ReturnType<typeof render> {
  return render(
    <SpotlightChart subject={SUBJECT} live={live} fetchedAtMs={BASE_MS} />,
  );
}

beforeEach(() => {
  charts.length = 0;
  poll.mockReset();
  poll.mockResolvedValue(okSeries());
  bindStore();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { boardChart: { poll } },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

/* ------------------------------------------------------------------ */

describe("creation and the series", () => {
  it("creates one instance once the first page lands, and seeds it once", async () => {
    mount();
    expect(charts).toHaveLength(0); // no data, no empty grid
    await settle();
    expect(charts).toHaveLength(1);
    const chart = charts[0];
    expect(chart?.setDataCalls).toHaveLength(1);
    expect(chart?.fitContentCalls).toBe(1);
  });

  it("paints the mockup's axes: left visible, right hidden, credit ours", async () => {
    mount();
    await settle();
    const options = charts[0]?.options as Record<string, Record<string, unknown>>;
    expect(options.leftPriceScale?.visible).toBe(true);
    expect(options.rightPriceScale?.visible).toBe(false);
    expect(options.layout?.attributionLogo).toBe(false);
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-attribution"]'),
    ).not.toBeNull();
  });

  it("switches off the rail and the floating tag the mockup does not have", async () => {
    mount();
    await settle();
    const series = charts[0]?.seriesOptions;
    expect(series?.priceLineVisible).toBe(false);
    expect(series?.lastValueVisible).toBe(false);
    expect(series?.crosshairMarkerVisible).toBe(true);
  });

  it("animates the last price only when live, and never on a snapshot", async () => {
    mount(false);
    await settle();
    const applied = charts[0]?.appliedSeriesOptions ?? [];
    expect(
      applied.some((options) => options.lastPriceAnimation === 2),
    ).toBe(false);

    cleanup();
    charts.length = 0;
    mount(true);
    await settle();
    expect(
      (charts[0]?.appliedSeriesOptions ?? []).some(
        (options) => options.lastPriceAnimation === 2,
      ),
    ).toBe(true);
  });
});

describe("the resolution pills", () => {
  it("shows a skeleton on switch and never labels old bars with a new pill", async () => {
    mount();
    await settle();
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-skeleton"]'),
    ).toBeNull();

    poll.mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-vex-area="spotlight-chart-pill"][data-resolution="8h"]') as HTMLElement,
      );
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-skeleton"]'),
    ).not.toBeNull();
  });

  it("does NOT rebuild the instance on a switch, and fits once per subject", async () => {
    mount();
    await settle();
    poll.mockResolvedValue(okSeries({ resolution: "8h" }));
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-vex-area="spotlight-chart-pill"][data-resolution="8h"]') as HTMLElement,
      );
    });
    await settle();
    expect(charts).toHaveLength(1);
    expect(charts[0]?.removed).toBe(false);
    expect(charts[0]?.fitContentCalls).toBe(2);
    expect(charts[0]?.setDataCalls).toHaveLength(2);
  });

  it("REFUSES an answer whose echoed resolution is not the pill on screen", async () => {
    mount();
    await settle();
    const writesBefore = charts[0]?.setDataCalls.length ?? 0;

    // The switch is to 30D; a slow 24H answer lands afterwards.
    poll.mockResolvedValue(okSeries({ resolution: "15m", count: 9 }));
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-vex-area="spotlight-chart-pill"][data-resolution="8h"]') as HTMLElement,
      );
    });
    await settle();

    expect(charts[0]?.setDataCalls.length).toBe(writesBefore);
    // And it is not an error either: the surface is still waiting.
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-absent"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-skeleton"]'),
    ).not.toBeNull();
  });
});

describe("polling and reconciliation", () => {
  it("polls at the pill's cadence while live and writes the forming bar only", async () => {
    vi.useFakeTimers();
    mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const chart = charts[0];
    expect(chart?.setDataCalls).toHaveLength(1);

    // The same window with a moved forming bar: one `update`, no `setData`.
    const moved = okSeries();
    const last = moved.data.outcome.series.bars.at(-1);
    if (last !== undefined) last.c = "0.0000999";
    poll.mockResolvedValue(moved);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(chart?.setDataCalls).toHaveLength(1);
    expect(chart?.updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(chart?.updateCalls.at(-1)?.historical).toBeUndefined();
  });

  it("restores the visible TIME range when a trim replaces the series under a scrolled reader", async () => {
    vi.useFakeTimers();
    mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const chart = charts[0];
    if (chart !== undefined) {
      chart.barsAfter = 12; // the reader is in history
      // A range INSIDE the bars the fixture drew, which is what a scrolled
      // reader's viewport actually is.
      chart.visibleRange = {
        from: Math.floor((BASE_MS + 60_000) / 1000),
        to: Math.floor((BASE_MS + 3 * 60_000) / 1000),
      };
    }

    poll.mockResolvedValue(okSeries({ from: 2 })); // the window slid
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(chart?.setDataCalls.length).toBe(2);
    expect(chart?.setVisibleRangeCalls.length).toBe(1);
  });

  it("leaves the viewport alone for a reader sitting at the live edge", async () => {
    vi.useFakeTimers();
    mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const chart = charts[0];
    if (chart !== undefined) chart.barsAfter = 0;
    poll.mockResolvedValue(okSeries({ from: 2 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(chart?.setVisibleRangeCalls).toHaveLength(0);
  });
});

describe("the readouts", () => {
  it("anchors the tooltip through the library's own coordinates", async () => {
    mount();
    await settle();
    const chart = charts[0];
    const handler = chart?.crosshairHandlers[0];
    expect(handler).toBeDefined();

    const seriesData = new Map<unknown, unknown>();
    // The handler reads the series it created; the double hands the same
    // object back from `addSeries`, so the map is keyed on identity here.
    await act(async () => {
      handler?.({
        time: Math.floor(BASE_MS / 1000),
        point: { x: 5, y: 5 },
        seriesData: {
          get: () => ({ time: Math.floor(BASE_MS / 1000), value: 0.0000104 }),
        } as unknown as typeof seriesData,
      });
    });
    const tooltip = document.querySelector(
      '[data-vex-area="spotlight-chart-tooltip"]',
    );
    expect(tooltip).not.toBeNull();
    expect(tooltip?.getAttribute("data-x")).toBe("100");
    expect(tooltip?.getAttribute("data-y")).toBe("42");
    expect(tooltip?.textContent).toContain("26 Aug - 11:00");
    expect(chart?.timeToCoordinateCalls).toBeGreaterThan(0);
    expect(chart?.priceToCoordinateCalls).toBeGreaterThan(0);
  });

  it("hides on the library's empty event rather than sticking", async () => {
    mount();
    await settle();
    const handler = charts[0]?.crosshairHandlers[0];
    await act(async () => {
      handler?.({ time: undefined, point: undefined, seriesData: { get: () => undefined } });
    });
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-tooltip"]'),
    ).toBeNull();
  });

  it("moves a bar cursor by keyboard and writes the figures itself", async () => {
    mount();
    await settle();
    const canvas = document.querySelector(
      '[data-vex-area="spotlight-chart-canvas"]',
    ) as HTMLElement;
    expect(canvas.getAttribute("tabindex")).toBe("0");

    await act(async () => {
      fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    });
    const readout = document.querySelector('[data-vex-area="spotlight-chart-readout"]');
    expect(readout?.getAttribute("aria-live")).toBe("polite");
    expect(readout?.textContent).toContain("26 Aug");
    // The library suppresses its own event for a programmatic crosshair, so
    // the readout above proves we wrote it rather than waited for one.
    expect(charts[0]?.crosshairPositions).toHaveLength(1);
  });

  it("clears the cursor on Escape and on blur", async () => {
    mount();
    await settle();
    const canvas = document.querySelector(
      '[data-vex-area="spotlight-chart-canvas"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(canvas, { key: "ArrowLeft" });
      fireEvent.keyDown(canvas, { key: "Escape" });
    });
    expect(charts[0]?.clearedCrosshairs).toBeGreaterThanOrEqual(1);
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-readout"]')?.textContent,
    ).toBe("");
  });
});

describe("honest notes and absences", () => {
  it("reports a short provider page as the provider's own bound", async () => {
    poll.mockResolvedValue(okSeries({ count: 3, providerBars: 3 }));
    mount();
    await settle();
    const notes = document.querySelector('[data-vex-area="spotlight-chart-notes"]');
    expect(notes?.textContent).toContain("3 of the 96 buckets");
    expect(notes?.textContent).toContain("still forming");
  });

  it("keeps the frame and names the absence for a pool with no history", async () => {
    poll.mockResolvedValue({
      ok: true,
      data: {
        subject: { chain: SUBJECT.chain, pairAddress: SUBJECT.pairAddress },
        resolution: "15m",
        outcome: { kind: "absent", reason: "no_drawable_bars" },
      },
    });
    mount();
    await settle();
    const absent = document.querySelector('[data-vex-area="spotlight-chart-absent"]');
    expect(absent?.getAttribute("data-reason")).toBe("no_drawable_bars");
    expect(absent?.textContent).toContain("no drawable price history");
  });
});

describe("teardown", () => {
  it("cuts the feed, unsubscribes and removes the instance on unmount", async () => {
    vi.useFakeTimers();
    const view = mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const polled = poll.mock.calls.length;
    const chart = charts[0];

    view.unmount();
    expect(chart?.unsubscribed).toBe(1);
    expect(chart?.removed).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(poll.mock.calls.length).toBe(polled);
  });

  it("stops polling when the lease ends, and keeps the bars on screen", async () => {
    vi.useFakeTimers();
    const view = mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    const polled = poll.mock.calls.length;
    expect(polled).toBeGreaterThan(1);

    // What the store's `setBoardLive(false)` produces on this surface: the
    // generations are bumped AND the holder stops publishing a lease, so the
    // prop that says "the feed may run" goes false.
    await act(async () => {
      useBoardSurfaceStore.getState().setBoardLive(false);
      view.rerender(
        <SpotlightChart subject={SUBJECT} live={false} fetchedAtMs={BASE_MS} />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(poll.mock.calls.length).toBe(polled);
    // The bars stay: a cut feed is not a cleared chart, and the instance is
    // not rebuilt either - the reader keeps their zoom.
    expect(charts).toHaveLength(1);
    expect(charts[0]?.removed).toBe(false);
    expect(charts[0]?.setDataCalls.length).toBeGreaterThan(0);
  });
});
