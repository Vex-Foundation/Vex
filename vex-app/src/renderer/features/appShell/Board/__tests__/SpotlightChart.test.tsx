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
import type { UTCTimestamp } from "lightweight-charts";

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
  appliedChartOptions: Record<string, unknown>[];
  /** What the library says is on screen, in bar indices. */
  visibleLogicalRange: { from: number; to: number } | null;
  setVisibleLogicalRangeCalls: { from: number; to: number }[];
  /**
   * The library returns null from `timeToCoordinate` for a time outside the
   * visible range. The double flips this off when the range is moved, which
   * is what "bring the bar into view first" has to achieve.
   */
  offscreen: boolean;
  tickMarkFormatter: ((time: unknown, type: number) => string) | null;
  /** The volume histogram's own writes and options. */
  volumeOptions: Record<string, unknown>;
  volumeSetDataCalls: unknown[][];
  volumeUpdateCalls: { point: unknown; historical: boolean | undefined }[];
  appliedVolumeOptions: Record<string, unknown>[];
  /** `chart.priceScale(id).applyOptions(...)`, by id. */
  priceScaleOptions: Record<string, Record<string, unknown>[]>;
  /** What was released, in order, so the teardown order is an assertion. */
  disposeOrder: string[];
  markersCreatedOn: "candle" | "volume" | null;
}

const charts: ChartRecord[] = [];
/** Which record a series object belongs to, for the markers plugin. */
const seriesOwner = new Map<unknown, { record: ChartRecord; kind: "candle" | "volume" }>();

vi.mock("lightweight-charts", () => {
  const CandlestickSeries = { type: "Candlestick" };
  const HistogramSeries = { type: "Histogram" };
  return {
    CandlestickSeries,
    HistogramSeries,
    CrosshairMode: { Normal: 0, Magnet: 1, Hidden: 2, MagnetOHLC: 3 },
    // The real enum's members, by value (typings.d.ts:167).
    TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 },
    createSeriesMarkers: (series: unknown, markers?: unknown[]) => {
      const owner = seriesOwner.get(series);
      if (owner !== undefined) owner.record.markersCreatedOn = owner.kind;
      return {
        setMarkers: () => undefined,
        markers: () => markers ?? [],
        detach: () => {
          owner?.record.disposeOrder.push("markers");
        },
      };
    },
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
        appliedChartOptions: [],
        visibleLogicalRange: { from: 0, to: 10 },
        setVisibleLogicalRangeCalls: [],
        offscreen: false,
        tickMarkFormatter:
          (options.timeScale as { tickMarkFormatter?: (time: unknown, type: number) => string } | undefined)
            ?.tickMarkFormatter ?? null,
        volumeOptions: {},
        volumeSetDataCalls: [],
        volumeUpdateCalls: [],
        appliedVolumeOptions: [],
        priceScaleOptions: {},
        disposeOrder: [],
        markersCreatedOn: null,
      };
      charts.push(record);
      const makeSeries = (kind: "candle" | "volume") => {
        const series = {
          setData: (data: unknown[]) => {
            (kind === "candle" ? record.setDataCalls : record.volumeSetDataCalls).push(data);
          },
          update: (point: unknown, historical?: boolean) => {
            (kind === "candle" ? record.updateCalls : record.volumeUpdateCalls).push({
              point,
              historical,
            });
          },
          applyOptions: (next: Record<string, unknown>) => {
            (kind === "candle" ? record.appliedSeriesOptions : record.appliedVolumeOptions).push(
              next,
            );
          },
          priceToCoordinate: () => {
            record.priceToCoordinateCalls += 1;
            return 42;
          },
          barsInLogicalRange: () => ({ barsBefore: 0, barsAfter: record.barsAfter }),
        };
        seriesOwner.set(series, { record, kind });
        return series;
      };
      const candle = makeSeries("candle");
      const volume = makeSeries("volume");
      return {
        addSeries: (def: { type: string }, seriesOptions: Record<string, unknown>) => {
          if (def.type === "Histogram") {
            record.volumeOptions = seriesOptions;
            return volume;
          }
          record.seriesOptions = seriesOptions;
          return candle;
        },
        priceScale: (id: string) => ({
          applyOptions: (next: Record<string, unknown>) => {
            const list = record.priceScaleOptions[id] ?? [];
            list.push(next);
            record.priceScaleOptions[id] = list;
          },
        }),
        applyOptions: (next: Record<string, unknown>) => {
          record.appliedChartOptions.push(next);
        },
        timeScale: () => ({
          fitContent: () => {
            record.fitContentCalls += 1;
          },
          getVisibleLogicalRange: () => record.visibleLogicalRange,
          getVisibleRange: () => record.visibleRange,
          setVisibleRange: (range: unknown) => {
            record.setVisibleRangeCalls.push(range);
          },
          setVisibleLogicalRange: (range: { from: number; to: number }) => {
            record.setVisibleLogicalRangeCalls.push(range);
            record.visibleLogicalRange = range;
            record.offscreen = false;
          },
          timeToCoordinate: () => {
            record.timeToCoordinateCalls += 1;
            return record.offscreen ? null : 100;
          },
        }),
        subscribeCrosshairMove: (handler: (param: unknown) => void) => {
          record.crosshairHandlers.push(handler);
        },
        unsubscribeCrosshairMove: () => {
          record.unsubscribed += 1;
          record.disposeOrder.push("unsubscribe");
        },
        setCrosshairPosition: (price: unknown, time: unknown) => {
          record.crosshairPositions.push({ price, time });
        },
        clearCrosshairPosition: () => {
          record.clearedCrosshairs += 1;
        },
        remove: () => {
          record.removed = true;
          record.disposeOrder.push("remove");
        },
      };
    },
  };
});

const { SpotlightChart } = await import("../SpotlightChart.js");
const { utcTickMarkFormatter, utcTickMarkFormatterFor, utcTimeFormatter, tooltipStamp, tooltipStampUtc } =
  await import("../spotlightChartTime.js");
const { spotlightChartNotes } = await import("../SpotlightChartCaption.js");
const { placeSpotlightTooltip } = await import(
  "../spotlightChartTooltipPlacement.js"
);
const { spotlightChartSurfaceState } = await import("../spotlightChartState.js");
const { CHART_ATTRIBUTION_LABEL, CHART_ATTRIBUTION_URL } = await import(
  "@shared/chart-attribution.js"
);
const { useBoardSurfaceStore, BOARD_FILTER_NONE } = await import(
  "../board-surface-store.js"
);

/* ------------------------------------------------------------------ */
/* The channel double                                                  */
/* ------------------------------------------------------------------ */

const poll = vi.fn();
/** Every read the channel asked main to cancel. */
const cancels: unknown[] = [];

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
  /** Positional volumes; defaults to a decimal per bar. */
  volumes?: (string | null)[];
} = {}) {
  const count = options.count ?? 5;
  const rows = bars(count, options.from ?? 0);
  const volumes = options.volumes ?? rows.map((_row, index) => `${String(1000 + index)}.25`);
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
        volumes,
        volumelessBars: volumes.filter((volume) => volume === null).length,
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
  // Several event-loop turns, not two: the channel's call now goes through a
  // cancellation wrapper, so the answer lands a couple of microtasks deeper
  // than it used to. This yields until the queue is quiet rather than
  // counting turns by hand.
  await act(async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  });
}

function mount(live = false): ReturnType<typeof render> {
  return render(
    <SpotlightChart subject={SUBJECT} live={live} fetchedAtMs={BASE_MS} />,
  );
}

beforeEach(() => {
  charts.length = 0;
  seriesOwner.clear();
  poll.mockReset();
  poll.mockResolvedValue(okSeries());
  bindStore();
  cancels.length = 0;
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    // THE BRIDGE HANDS BACK A CANCELLABLE INVOCATION, not a bare promise:
    // the channel wires `cancel` to its own abort so a cut stops main's read
    // rather than merely ignoring the answer. `poll` still resolves the
    // payload, so every fixture below reads the same.
    value: {
      boardChart: {
        poll: (args: unknown) => ({
          promise: poll(args) as Promise<unknown>,
          cancel: () => {
            cancels.push(args);
          },
        }),
      },
    },
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
    expect(charts[0]?.volumeOptions.priceLineVisible).toBe(false);
    expect(charts[0]?.volumeOptions.lastValueVisible).toBe(false);
  });

  /** Brief D3: a REAL candlestick series on the left scale, palette colours only. */
  it("draws CANDLES on the left scale with the palette's six colours and a custom price format", async () => {
    mount();
    await settle();
    const series = charts[0]?.seriesOptions ?? {};
    expect(series.priceScaleId).toBe("left");
    expect(series.borderVisible).toBe(true);
    expect(series.wickVisible).toBe(true);
    // jsdom resolves no tokens, so the bridge's neutral fallbacks are what
    // the palette IS here; the claim is that every colour came from it.
    expect(series.upColor).toBe("rgba(31, 185, 84, 1)");
    expect(series.downColor).toBe("rgba(242, 109, 109, 1)");
    expect(series.borderUpColor).toBe(series.upColor);
    expect(series.borderDownColor).toBe(series.downColor);
    expect(series.wickUpColor).toBe(series.upColor);
    expect(series.wickDownColor).toBe(series.downColor);
    const priceFormat = series.priceFormat as Record<string, unknown>;
    expect(priceFormat.type).toBe("custom");
    expect(typeof priceFormat.formatter).toBe("function");
    expect(priceFormat.minMove).toBeGreaterThan(0);
    // And no library animation exists on a candlestick: nothing ever asks for one.
    expect(
      (charts[0]?.appliedSeriesOptions ?? []).some((o) => "lastPriceAnimation" in o),
    ).toBe(false);
    expect("lastPriceAnimation" in series).toBe(false);
  });

  /** Brief D3: the volume is an OVERLAY histogram, not a second pane. */
  it("draws the VOLUME as a histogram overlay on its own invisible scale, under the candles", async () => {
    mount();
    await settle();
    const chart = charts[0];
    expect(chart?.volumeOptions.priceScaleId).toBe("spotlight-volume");
    expect(chart?.volumeOptions.base).toBe(0);
    expect(chart?.priceScaleOptions["spotlight-volume"]).toEqual([
      { scaleMargins: { top: 0.78, bottom: 0 } },
    ]);
    expect(chart?.priceScaleOptions.left).toEqual([
      { scaleMargins: { top: 0.08, bottom: 0.28 } },
    ]);
    // Still one axis: the right scale is hidden and the overlay has no rail.
    const options = chart?.options as Record<string, Record<string, unknown>>;
    expect(options.rightPriceScale?.visible).toBe(false);
    // Seeded in lockstep with the candles.
    expect(chart?.volumeSetDataCalls).toHaveLength(1);
    const volumes = chart?.volumeSetDataCalls[0] as Record<string, unknown>[];
    expect(volumes).toHaveLength(5);
    expect(volumes.every((v) => "value" in v && typeof v.color === "string")).toBe(true);
  });

  /** Brief D1: a null volume is WHITESPACE in the histogram, never a zero bar. */
  it("leaves a whitespace slot in the histogram for a bar with no reported volume", async () => {
    poll.mockResolvedValue(okSeries({ volumes: ["1.5", null, "2.5", null, "3.5"] }));
    mount();
    await settle();
    const volumes = charts[0]?.volumeSetDataCalls[0] as Record<string, unknown>[];
    expect(volumes.map((v) => "value" in v)).toEqual([true, false, true, false, true]);
    expect(volumes.some((v) => v.value === 0)).toBe(false);
    // The candles are all still drawn.
    const candles = charts[0]?.setDataCalls[0] as Record<string, unknown>[];
    expect(candles.every((c) => "open" in c)).toBe(true);
  });

  /** Brief D6: the forming bar is visible AS forming, on the candle itself. */
  it("tints the newest bar while forming and draws it fully once closed", async () => {
    poll.mockResolvedValue(okSeries({ lastBarPartial: true }));
    mount();
    await settle();
    const forming = charts[0]?.setDataCalls[0] as Record<string, unknown>[];
    expect(forming.slice(0, -1).every((c) => !("color" in c))).toBe(true);
    const newest = forming.at(-1) ?? {};
    expect(newest.color).toBe("rgba(31, 185, 84, 0.55)");
    expect(newest.borderColor).toBe(newest.color);
    expect(newest.wickColor).toBe(newest.color);
    expect("open" in newest).toBe(true);

    cleanup();
    charts.length = 0;
    poll.mockResolvedValue(okSeries({ lastBarPartial: false }));
    mount();
    await settle();
    const closed = charts[0]?.setDataCalls[0] as Record<string, unknown>[];
    expect(closed.every((c) => !("color" in c))).toBe(true);
  });

  it("wires the markers seam to the CANDLE series only", async () => {
    mount();
    await settle();
    expect(charts[0]?.markersCreatedOn).toBe("candle");
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

  /** Brief D5: the axis vocabulary follows the pill, through applyOptions. */
  it("re-applies the pill's own tick vocabulary on a switch, without a rebuild", async () => {
    mount();
    await settle();
    poll.mockResolvedValue(okSeries({ resolution: "8h" }));
    await act(async () => {
      fireEvent.click(
        document.querySelector('[data-vex-area="spotlight-chart-pill"][data-resolution="8h"]') as HTMLElement,
      );
    });
    await settle();
    const applied = charts[0]?.appliedChartOptions ?? [];
    const withFormatter = applied
      .map((o) => (o.timeScale as { tickMarkFormatter?: (t: unknown, k: number) => string } | undefined)?.tickMarkFormatter)
      .filter((f): f is (t: unknown, k: number) => string => typeof f === "function");
    expect(withFormatter.length).toBeGreaterThan(0);
    const latest = withFormatter.at(-1);
    // A time-of-day tick on the 30D pill reads by DAY.
    expect(latest?.(Math.floor(BASE_MS / 1000), 3)).toBe("26 Aug");
    expect(charts).toHaveLength(1);
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
    // The histogram moves in lockstep: one series never holds a bar the
    // other does not.
    expect(chart?.volumeSetDataCalls).toHaveLength(1);
    expect(chart?.volumeUpdateCalls.length).toBe(chart?.updateCalls.length);
  });

  /** Brief D7: a poll that only moved a PAST bar's high is a correction, not "unchanged". */
  it("applies a high-only move on a past bar as a historical update", async () => {
    vi.useFakeTimers();
    mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const chart = charts[0];
    const moved = okSeries();
    const past = moved.data.outcome.series.bars[1];
    if (past !== undefined) past.h = "0.0009999";
    poll.mockResolvedValue(moved);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(chart?.setDataCalls).toHaveLength(1);
    const historical = chart?.updateCalls.filter((call) => call.historical === true) ?? [];
    expect(historical).toHaveLength(1);
    expect((historical[0]?.point as { high: number }).high).toBe(0.0009999);
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

    // The double's handler takes `unknown`: the map-like `seriesData` only
    // needs the `get` the component reads for the series it created.
    await act(async () => {
      handler?.({
        time: Math.floor(BASE_MS / 1000),
        point: { x: 5, y: 5 },
        seriesData: {
          get: () => ({
            time: Math.floor(BASE_MS / 1000),
            open: 0.0000100,
            high: 0.0000100,
            low: 0.0000100,
            close: 0.0000100,
          }),
        },
      });
    });
    const tooltip = document.querySelector(
      '[data-vex-area="spotlight-chart-tooltip"]',
    );
    expect(tooltip).not.toBeNull();
    expect(tooltip?.getAttribute("data-x")).toBe("100");
    expect(tooltip?.getAttribute("data-y")).toBe("42");
    expect(tooltip?.textContent).toContain("26 Aug - 11:00 UTC");
    expect(chart?.timeToCoordinateCalls).toBeGreaterThan(0);
    expect(chart?.priceToCoordinateCalls).toBeGreaterThan(0);
  });

  /** Brief D8: four lines, prices through the axis formatter, volume through the board's. */
  it("shows O, H / L, C, Vol and the UTC stamp, with the close coloured by direction", async () => {
    poll.mockResolvedValue(okSeries({ volumes: ["1234567.5", "2", "3", "4", "5"] }));
    mount();
    await settle();
    const handler = charts[0]?.crosshairHandlers[0];
    const t = Math.floor(BASE_MS / 1000);
    await act(async () => {
      handler?.({
        time: t,
        point: { x: 5, y: 5 },
        seriesData: {
          get: () => ({ time: t, open: 0.00001, high: 0.00001, low: 0.00001, close: 0.00001, value: 1234567.5 }),
        },
      });
    });
    const text = (selector: string): string | null | undefined =>
      document.querySelector(`[data-vex-area="spotlight-chart-tooltip-${selector}"]`)?.textContent;
    expect(text("open")).toBe("O 0.0000100");
    expect(text("range")).toBe("H 0.0000100 / L 0.0000100");
    expect(text("close")).toBe("C 0.0000100");
    expect(text("volume")).toBe("Vol $1.2M");
    expect(text("time")).toBe("26 Aug - 11:00 UTC");
    // A flat bar reads as up.
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-tooltip-close"]')?.getAttribute("data-direction"),
    ).toBe("up");
  });

  it("says when the bar under the cursor carried no volume", async () => {
    poll.mockResolvedValue(okSeries({ volumes: [null, "2", "3", "4", "5"] }));
    mount();
    await settle();
    const handler = charts[0]?.crosshairHandlers[0];
    const t = Math.floor(BASE_MS / 1000);
    await act(async () => {
      handler?.({
        time: t,
        point: { x: 5, y: 5 },
        // The histogram item at that time is WHITESPACE: no `value`.
        seriesData: { get: () => ({ time: t, open: 1, high: 1, low: 1, close: 1 }) },
      });
    });
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-tooltip-volume"]')?.textContent,
    ).toBe("Vol no volume reported");
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
    // Brief D8: the readout speaks open, high, low, close, volume, at UTC.
    expect(readout?.textContent).toMatch(
      /^open .+, high .+, low .+, close .+, volume \$.+, at 26 Aug - \d\d:\d\d UTC$/,
    );
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

  /** Brief D11: the two notes candles owe that the area line did not. */
  it("discloses volumeless buckets and derived extremes, with their counts", async () => {
    const answer = okSeries({ volumes: ["1", null, "3", null, "5"] });
    // Bar 2's close sits above its reported high: the candle draws the true extreme.
    const bar2 = answer.data.outcome.series.bars[2];
    if (bar2 !== undefined) bar2.c = "0.0009000";
    poll.mockResolvedValue(answer);
    mount();
    await settle();
    const notes = document.querySelector('[data-vex-area="spotlight-chart-notes"]');
    expect(notes?.textContent).toContain("2 of the 5 drawn buckets carried no reported volume.");
    expect(notes?.textContent).toContain(
      "1 buckets reported a high or low that did not span their own open and close; the chart drew the true extremes.",
    );
    expect(notes?.className).toBe("flex flex-col gap-0.5");
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-caption"]')?.className,
    ).toContain("text-[12px] leading-[16px]");
  });

  it("lists the notes as a table, in reading order", () => {
    const page = { ...okSeries({ count: 3, providerBars: 3 }).data.outcome, forResolution: "15m" as const };
    expect(
      spotlightChartNotes(page, { hiddenOlder: 0, incoherentCount: 2, volumelessCount: 1 }, "15m"),
    ).toEqual([
      "The provider had 3 of the 96 buckets this range asks for.",
      "1 of the 3 drawn buckets carried no reported volume.",
      "2 buckets reported a high or low that did not span their own open and close; the chart drew the true extremes.",
      "The newest 24H bucket is still forming.",
    ]);
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
    // The sentence sits centred inside a box that never collapses.
    expect(absent?.className).toContain("text-[13px] leading-[18px] text-ink-tertiary");
    expect(absent?.parentElement?.className).toContain("h-[280px]");
  });

  /**
   * THE CANCELLED-PILL DEFECT, at the surface. A cancelled first read is a
   * skeleton that gets asked again, never "This read was cancelled." as the
   * terminal state of the default pill.
   */
  it("never shows a cancelled read as a settled absence", async () => {
    poll
      .mockResolvedValueOnce({
        ok: true,
        data: {
          subject: { chain: SUBJECT.chain, pairAddress: SUBJECT.pairAddress },
          resolution: "15m",
          outcome: { kind: "unavailable", reason: "cancelled" },
        },
      })
      .mockResolvedValue(okSeries());
    mount();
    await settle();
    expect(document.querySelector('[data-vex-area="spotlight-chart-absent"]')).toBeNull();
    expect(document.body.textContent).not.toContain("This read was cancelled");
    expect(charts).toHaveLength(1);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("styles the selected pill as a wash with a ring, not a solid fill", async () => {
    mount();
    await settle();
    const selected = document.querySelector(
      '[data-vex-area="spotlight-chart-pill"][data-selected="true"]',
    );
    expect(selected?.className).toContain("bg-accent-wash text-accent-primary ring-1 ring-inset ring-accent-primary/40");
    expect(selected?.className).not.toContain("bg-accent-primary ");
    const unselected = document.querySelector(
      '[data-vex-area="spotlight-chart-pill"][data-selected="false"]',
    );
    expect(unselected?.className).toContain("text-ink-tertiary hover:bg-interactive-hover");
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
    // Brief D10: subscription, then the markers plugin, then the instance.
    expect(chart?.disposeOrder).toEqual(["unsubscribe", "markers", "remove"]);

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

/* ------------------------------------------------------------------ */
/* F4a: the axis is UTC, not the viewer's timezone                     */
/* ------------------------------------------------------------------ */

describe("the UTC axis", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // A NON-UTC ZONE ON PURPOSE. Every one of these assertions passes by
    // accident on a UTC CI box, which is exactly how an axis nine hours off
    // the tooltip beside it shipped behind a green suite.
    process.env.TZ = "Asia/Tokyo";
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  // 26 Aug 2026 22:00:07 UTC is 27 Aug 07:00 in Tokyo: every field below
  // differs between the two, so a local-time formatter cannot pass.
  /**
   * `UTCTimestamp` is the library's NOMINAL brand over `number`, and the
   * library exports no constructor for it. One documented cast in one helper
   * is the whole surface of that fact in this file; the alternative is the
   * same cast repeated at eight call sites.
   */
  const utcSec = (seconds: number): UTCTimestamp => seconds as UTCTimestamp;

  const CROSS_MIDNIGHT = utcSec(Math.floor(Date.UTC(2026, 7, 26, 22, 0, 7) / 1000));
  // 31 Dec 2026 22:00 UTC is 1 Jan 2027 in Tokyo.
  const CROSS_YEAR = utcSec(Math.floor(Date.UTC(2026, 11, 31, 22, 0, 0) / 1000));

  it("formats every TickMarkType in UTC", () => {
    expect(new Date().getTimezoneOffset()).not.toBe(0); // the zone really applied

    expect(utcTickMarkFormatter(CROSS_MIDNIGHT, 3)).toBe("22:00");
    expect(utcTickMarkFormatter(CROSS_MIDNIGHT, 4)).toBe("22:00:07");
    expect(utcTickMarkFormatter(CROSS_MIDNIGHT, 2)).toBe("26 Aug");
    expect(utcTickMarkFormatter(CROSS_YEAR, 1)).toBe("Dec");
    expect(utcTickMarkFormatter(CROSS_YEAR, 0)).toBe("2026");
  });

  /** Brief D5: one vocabulary per pill, branched in the time module only. */
  it("reads a time-of-day tick in each pill's own vocabulary", () => {
    expect(utcTickMarkFormatterFor("1m")(CROSS_MIDNIGHT, 3)).toBe("22:00");
    expect(utcTickMarkFormatterFor("15m")(CROSS_MIDNIGHT, 3)).toBe("22:00");
    expect(utcTickMarkFormatterFor("2h")(CROSS_MIDNIGHT, 3)).toBe("26 Aug 22:00");
    expect(utcTickMarkFormatterFor("8h")(CROSS_MIDNIGHT, 3)).toBe("26 Aug");
    // Coarser ticks read the same on every pill.
    for (const pill of ["1m", "15m", "2h", "8h"] as const) {
      expect(utcTickMarkFormatterFor(pill)(CROSS_MIDNIGHT, 2)).toBe("26 Aug");
      expect(utcTickMarkFormatterFor(pill)(CROSS_YEAR, 1)).toBe("Dec");
      expect(utcTickMarkFormatterFor(pill)(CROSS_YEAR, 0)).toBe("2026");
    }
    expect(tooltipStampUtc(CROSS_MIDNIGHT)).toBe("26 Aug - 22:00 UTC");
    expect(tooltipStampUtc(utcSec(Number.NaN))).toBe("unknown time");
  });

  it("agrees with the crosshair label and the tooltip stamp", () => {
    expect(utcTimeFormatter(CROSS_MIDNIGHT)).toBe("22:00");
    expect(tooltipStamp(CROSS_MIDNIGHT)).toBe("26 Aug - 22:00");
    expect(utcTickMarkFormatter(CROSS_MIDNIGHT, 3)).toBe(
      utcTimeFormatter(CROSS_MIDNIGHT),
    );
  });

  it("reports an unusable time rather than printing 1970", () => {
    expect(utcTickMarkFormatter(utcSec(Number.NaN), 3)).toBe("");
    expect(utcTimeFormatter(utcSec(Number.NaN))).toBe("");
    expect(tooltipStamp(utcSec(Number.NaN))).toBe("unknown time");
  });

  it("installs the tick formatter on the instance it creates", async () => {
    mount();
    await settle();
    const formatter = charts[0]?.tickMarkFormatter;
    expect(formatter).not.toBeNull();
    expect(formatter?.(CROSS_MIDNIGHT, 2)).toBe("26 Aug");
  });
});

/* ------------------------------------------------------------------ */
/* F4b: a failed refresh keeps the last good bars                      */
/* ------------------------------------------------------------------ */

describe("a failed refresh over good bars", () => {
  it("keeps the bars, says the refresh failed, and shows the LAST GOOD clock", async () => {
    vi.useFakeTimers();
    mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const chart = charts[0];
    expect(chart?.setDataCalls.length).toBeGreaterThan(0);
    const stampWhenGood = document.querySelector(
      '[data-vex-area="spotlight-chart-status"]',
    )?.textContent;

    // The next poll fails outright.
    poll.mockResolvedValue({ ok: false, error: { code: "transport" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // The bars stay: nothing cleared the series, and the instance is intact.
    expect(charts).toHaveLength(1);
    expect(chart?.removed).toBe(false);
    // And no absence panel is covering them.
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-absent"]'),
    ).toBeNull();

    const figure = document.querySelector('[data-vex-area="spotlight-chart"]');
    expect(figure?.getAttribute("data-state")).toBe("degraded");

    // Announced, not merely coloured.
    const degraded = document.querySelector(
      '[data-vex-area="spotlight-chart-degraded"]',
    );
    expect(degraded?.getAttribute("aria-live")).toBe("polite");
    expect(degraded?.textContent).toContain("Refresh failed");
    expect(degraded?.textContent).toContain("last good read");

    // The clock is the clock OF THESE BARS, not of the attempt that failed.
    const status = document.querySelector(
      '[data-vex-area="spotlight-chart-status"]',
    );
    expect(status?.textContent).toBe(stampWhenGood);
    expect(status?.getAttribute("data-degraded")).toBe("true");
    // And the surface does not claim to be streaming while degraded.
    expect(status?.getAttribute("data-live")).toBe("false");
  });

  it("shows the absence panel when the failure has nothing good behind it", async () => {
    poll.mockResolvedValue({ ok: false, error: { code: "transport" } });
    mount();
    await settle();
    const absent = document.querySelector('[data-vex-area="spotlight-chart-absent"]');
    expect(absent).not.toBeNull();
    expect(absent?.getAttribute("data-reason")).toBe("transport");
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-degraded"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-vex-area="spotlight-chart"]')?.getAttribute("data-state"),
    ).toBe("absent");
  });
});

/* ------------------------------------------------------------------ */
/* F4b + F4d: the surface state machine, as a table                    */
/* ------------------------------------------------------------------ */

describe("the surface state", () => {
  function page(resolution: "1m" | "15m" | "2h" | "8h", fetchedAtMs = BASE_MS) {
    return {
      kind: "series" as const,
      fetchedAtMs,
      forResolution: resolution,
      series: {
        bars: bars(3),
        lastBarPartial: false,
        coveredRange: { fromMs: BASE_MS, toMs: BASE_MS },
        resolution,
        truncated: false,
      },
      requestedBars: 96,
      providerBars: 3,
      undrawableBars: 0,
      windowedOutBars: 0,
      volumes: ["1", "2", "3"],
      volumelessBars: 0,
    };
  }

  it("is a skeleton while pending", () => {
    expect(
      spotlightChartSurfaceState({ read: { status: "pending" }, resolution: "15m" }).kind,
    ).toBe("skeleton");
  });

  it("is a SKELETON for a page of another pill, never ready", () => {
    // The one frame a pill click can produce. Deriving from `read.status`
    // alone made this "ready", which is old bars under a new pill.
    const state = spotlightChartSurfaceState({
      read: { status: "ready", value: page("15m"), fetchedAtMs: BASE_MS },
      resolution: "8h",
    });
    expect(state.kind).toBe("skeleton");
  });

  it("is degraded when a failure carries last-good bars of this pill", () => {
    const state = spotlightChartSurfaceState({
      read: {
        status: "unavailable",
        reason: "transport",
        lastGood: { value: page("15m", BASE_MS - 60_000), fetchedAtMs: BASE_MS - 60_000 },
      },
      resolution: "15m",
    });
    expect(state.kind).toBe("degraded");
    if (state.kind === "degraded") {
      expect(state.fetchedAtMs).toBe(BASE_MS - 60_000);
      expect(state.reason).toBe("transport");
    }
  });

  it("is a SKELETON, never absent, for a cancellation with nothing behind it", () => {
    expect(
      spotlightChartSurfaceState({
        read: { status: "unavailable", reason: "cancelled", lastGood: null },
        resolution: "15m",
      }).kind,
    ).toBe("skeleton");
    // With last-good bars of this pill it is the ordinary degraded arm.
    expect(
      spotlightChartSurfaceState({
        read: {
          status: "unavailable",
          reason: "cancelled",
          lastGood: { value: page("15m"), fetchedAtMs: BASE_MS },
        },
        resolution: "15m",
      }).kind,
    ).toBe("degraded");
  });

  it("is absent when the failure carries nothing, or last-good of another pill", () => {
    expect(
      spotlightChartSurfaceState({
        read: { status: "unavailable", reason: "unknown_pair", lastGood: null },
        resolution: "15m",
      }).kind,
    ).toBe("absent");
    expect(
      spotlightChartSurfaceState({
        read: {
          status: "unavailable",
          reason: "transport",
          lastGood: { value: page("1m"), fetchedAtMs: BASE_MS },
        },
        resolution: "8h",
      }).kind,
    ).toBe("absent");
  });
});

/* ------------------------------------------------------------------ */
/* F4c: the licence notice is not conditional                          */
/* ------------------------------------------------------------------ */

describe("the TradingView attribution", () => {
  function anchor(): HTMLAnchorElement | null {
    return document.querySelector(
      '[data-vex-area="spotlight-chart-attribution"] a',
    );
  }

  it("renders on a COMPLETE AND CLOSED chart with nothing to caveat", async () => {
    poll.mockResolvedValue(
      okSeries({ count: 96, providerBars: 96, lastBarPartial: false }),
    );
    mount();
    await settle();
    // Nothing to say: no notes element at all, and the credit is still there.
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-notes"]'),
    ).toBeNull();
    const link = anchor();
    expect(link?.getAttribute("href")).toBe(CHART_ATTRIBUTION_URL);
    expect(link?.getAttribute("href")).toContain("tradingview.com");
    expect(link?.textContent).toBe(CHART_ATTRIBUTION_LABEL);
    expect(link?.textContent).toBe("TradingView Lightweight Charts");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("renders while pending, while degraded, and while absent", async () => {
    poll.mockReturnValue(new Promise(() => undefined));
    const pendingView = mount();
    await settle();
    expect(anchor()).not.toBeNull();
    pendingView.unmount();

    poll.mockResolvedValue({ ok: false, error: { code: "transport" } });
    const absentView = mount();
    await settle();
    expect(anchor()).not.toBeNull();
    absentView.unmount();

    vi.useFakeTimers();
    poll.mockResolvedValue(okSeries());
    mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    poll.mockResolvedValue({ ok: false, error: { code: "transport" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-degraded"]'),
    ).not.toBeNull();
    expect(anchor()).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* F4d: no frame of the old series under the new pill                  */
/* ------------------------------------------------------------------ */

describe("the resolution transition", () => {
  it("covers the canvas and writes nothing of the old page under the new pill", async () => {
    mount();
    await settle();
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-skeleton"]'),
    ).toBeNull();

    poll.mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      fireEvent.click(
        document.querySelector(
          '[data-vex-area="spotlight-chart-pill"][data-resolution="8h"]',
        ) as HTMLElement,
      );
    });

    expect(
      document
        .querySelector('[data-vex-area="spotlight-chart-pill"][data-resolution="8h"]')
        ?.getAttribute("data-selected"),
    ).toBe("true");
    expect(
      document.querySelector('[data-vex-area="spotlight-chart"]')?.getAttribute("data-state"),
    ).toBe("skeleton");
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-skeleton"]'),
    ).not.toBeNull();
    // Nothing of the old page was written into the series for the new pill.
    expect(charts[0]?.setDataCalls).toHaveLength(1);
    // NOTE: React commits inside `act`, so the single frame between the click
    // and the channel's reset is not observable from here. The claim that no
    // such frame can render old bars is carried by the state table above
    // ("is a SKELETON for a page of another pill"), which is the derivation
    // this surface actually renders from.
  });
});

/* ------------------------------------------------------------------ */
/* Known issue 1: a theme flip keeps the instance and the viewport     */
/* ------------------------------------------------------------------ */

describe("a theme change", () => {
  it("repaints the LIVE instance and never rebuilds it", async () => {
    vi.useFakeTimers();
    mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const chart = charts[0];
    const fitsBefore = chart?.fitContentCalls;
    const rangeCallsBefore = chart?.setVisibleRangeCalls.length;
    const seriesAppliesBefore = chart?.appliedSeriesOptions.length ?? 0;

    await act(async () => {
      document.documentElement.setAttribute("data-vex-theme", "light");
      await Promise.resolve();
    });

    // The reader's chart is the same chart, with the same viewport.
    expect(charts).toHaveLength(1);
    expect(chart?.removed).toBe(false);
    expect(chart?.fitContentCalls).toBe(fitsBefore);
    expect(chart?.setVisibleRangeCalls.length).toBe(rangeCallsBefore);
    expect(chart?.setDataCalls).toHaveLength(1);

    // The palette reached it through applyOptions instead.
    const applied = chart?.appliedChartOptions ?? [];
    expect(
      applied.some((options) => "layout" in options || "grid" in options),
    ).toBe(true);
    expect(chart?.appliedSeriesOptions.length ?? 0).toBeGreaterThan(
      seriesAppliesBefore,
    );
    // Brief D10: six candle colours plus the volume tint, via applyOptions.
    const last = chart?.appliedSeriesOptions.at(-1) ?? {};
    expect(Object.keys(last).sort()).toEqual(
      ["borderDownColor", "borderUpColor", "downColor", "upColor", "wickDownColor", "wickUpColor"],
    );
    expect(chart?.appliedVolumeOptions.at(-1)).toEqual({ color: "rgba(31, 185, 84, 0.35)" });
    document.documentElement.removeAttribute("data-vex-theme");
  });
});

/* ------------------------------------------------------------------ */
/* Known issue 2: the tooltip stays inside the chart                   */
/* ------------------------------------------------------------------ */

describe("the tooltip's placement", () => {
  const CONTAINER = { width: 600, height: 300 };
  const CARD = { width: 120, height: 48 };
  const GEOMETRY = { container: CONTAINER, tooltip: CARD, gap: 14, margin: 8 };

  function inside(place: { left: number; top: number }): boolean {
    return (
      place.left >= 8 &&
      place.top >= 8 &&
      place.left + CARD.width <= CONTAINER.width - 8 &&
      place.top + CARD.height <= CONTAINER.height - 8
    );
  }

  it("centres on the anchor when there is room", () => {
    const place = placeSpotlightTooltip({
      ...GEOMETRY,
      anchor: { x: 300, y: 200 },
    });
    expect(place.left).toBe(240);
    expect(place.top).toBe(200 - 14 - 48);
    expect(place.clampedX).toBe(false);
    expect(place.flippedY).toBe(false);
    expect(inside(place)).toBe(true);
  });

  it("clamps at the LEFT edge instead of hanging outside", () => {
    const place = placeSpotlightTooltip({ ...GEOMETRY, anchor: { x: 4, y: 200 } });
    expect(place.left).toBe(8);
    expect(place.clampedX).toBe(true);
    expect(inside(place)).toBe(true);
  });

  it("clamps at the RIGHT edge, which is where the newest bar sits", () => {
    const place = placeSpotlightTooltip({ ...GEOMETRY, anchor: { x: 598, y: 200 } });
    expect(place.left).toBe(CONTAINER.width - CARD.width - 8);
    expect(place.clampedX).toBe(true);
    expect(inside(place)).toBe(true);
  });

  it("FLIPS below the crosshair at the top of the range", () => {
    const place = placeSpotlightTooltip({ ...GEOMETRY, anchor: { x: 300, y: 10 } });
    expect(place.flippedY).toBe(true);
    expect(place.top).toBe(24);
    expect(inside(place)).toBe(true);
  });

  it("stays inside at the bottom of the range too", () => {
    const place = placeSpotlightTooltip({ ...GEOMETRY, anchor: { x: 300, y: 298 } });
    expect(inside(place)).toBe(true);
  });

  it("writes the placement onto the card the crosshair raised", async () => {
    mount();
    await settle();
    const handler = charts[0]?.crosshairHandlers[0];
    await act(async () => {
      handler?.({
        time: Math.floor(BASE_MS / 1000),
        point: { x: 5, y: 5 },
        seriesData: {
          get: () => ({ time: Math.floor(BASE_MS / 1000), open: 1, high: 1, low: 1, close: 1 }),
        },
      });
    });
    const tooltip = document.querySelector(
      '[data-vex-area="spotlight-chart-tooltip"]',
    ) as HTMLElement | null;
    expect(tooltip).not.toBeNull();
    // jsdom measures every box as zero, so the value is not the subject here;
    // that the card is POSITIONED BY THE SOLVER rather than by a transform is.
    expect(tooltip?.dataset.side).toBeDefined();
    expect(tooltip?.style.left).not.toBe("");
    expect(tooltip?.className).not.toContain("-translate-x-1/2");
  });
});

/* ------------------------------------------------------------------ */
/* Known issue 3: the keyboard cursor on an offscreen bar              */
/* ------------------------------------------------------------------ */

describe("the keyboard cursor off screen", () => {
  it("brings the bar into view and reads THAT bar, not a blank", async () => {
    mount();
    await settle();
    const chart = charts[0];
    if (chart !== undefined) {
      // The reader has scrolled to the newest bars; `Home` is off screen.
      chart.visibleLogicalRange = { from: 3, to: 4 };
      chart.offscreen = true;
    }
    const canvas = document.querySelector(
      '[data-vex-area="spotlight-chart-canvas"]',
    ) as HTMLElement;

    await act(async () => {
      fireEvent.keyDown(canvas, { key: "Home" });
    });

    // The window moved to include bar 0, keeping its width.
    expect(chart?.setVisibleLogicalRangeCalls).toHaveLength(1);
    expect(chart?.setVisibleLogicalRangeCalls[0]).toEqual({ from: 0, to: 1 });
    // And the readout describes the OLDEST bar, at its own stamp.
    const readout = document.querySelector(
      '[data-vex-area="spotlight-chart-readout"]',
    );
    expect(readout?.textContent).toContain(
      `26 Aug - ${new Date(BASE_MS).getUTCHours() < 10 ? "0" : ""}${String(new Date(BASE_MS).getUTCHours())}:00`,
    );
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-tooltip"]'),
    ).not.toBeNull();
  });

  it("never parks the card at 0,0 when the pane has no coordinate", async () => {
    mount();
    await settle();
    const chart = charts[0];
    if (chart !== undefined) {
      // Off screen AND the range cannot be moved to help: the library still
      // refuses a coordinate.
      chart.visibleLogicalRange = null;
      chart.offscreen = true;
    }
    const canvas = document.querySelector(
      '[data-vex-area="spotlight-chart-canvas"]',
    ) as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(canvas, { key: "End" });
    });
    // No card, because a card at 0,0 would describe the wrong bar - but the
    // readout is still right, because it comes from the held bar.
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-tooltip"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-vex-area="spotlight-chart-readout"]')?.textContent,
    ).toContain("26 Aug");
  });
});
