/** W15: chart ownership, viewport, live-data, and overlay regression pins. */

import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HyperliquidCandleDto, HyperliquidPositionDto } from "@shared/schemas/hyperliquid.js";

const spies = vi.hoisted(() => ({
  createChart: vi.fn(),
  fitContent: vi.fn(),
  getVisibleRange: vi.fn(),
  setVisibleRange: vi.fn(),
  scrollPosition: vi.fn(),
  scrollToRealTime: vi.fn(),
  chartRemove: vi.fn(),
  chartApplyOptions: vi.fn(),
  candleSetData: vi.fn(),
  volumeSetData: vi.fn(),
  candleUpdate: vi.fn(),
  volumeUpdate: vi.fn(),
  createPriceLine: vi.fn(),
  removePriceLine: vi.fn(),
}));

let rangeCallback: ((range: { from: number; to: number } | null) => void) | null = null;
let resizeCallback: ((entries: Array<{ contentRect: { width: number; height: number } }>) => void) | null = null;
const lines = new Map<string, { applyOptions: ReturnType<typeof vi.fn> }>();

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: {},
  HistogramSeries: {},
  LineStyle: { Solid: 0, Dashed: 1 },
  createChart: spies.createChart,
}));

const { HyperliquidPositionChart } = await import("../HyperliquidPositionChart.js");

function position(overrides: Partial<HyperliquidPositionDto> = {}): HyperliquidPositionDto {
  return {
    coin: "BTC", side: "long", size: "1", entryPx: "100", markPx: "100",
    leverage: "3", marginMode: "isolated", liquidationPx: "80",
    unrealizedPnl: "0", fundingAccrued: "0", slPrice: "90", tpPrice: "110",
    protectionState: "PROTECTED", confirmedAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z", ...overrides,
  };
}

function candles(overrides: Partial<HyperliquidCandleDto> = {}): readonly HyperliquidCandleDto[] {
  return [{ openTimeMs: 1_700_000_000_000, open: "1", high: "2", low: "0.5", close: "1.5", volume: "10", ...overrides }];
}

function chart(props: Partial<ComponentProps<typeof HyperliquidPositionChart>> = {}) {
  return <HyperliquidPositionChart coin="BTC" interval="1h" candles={candles()} state="ready" position={position()} fill {...props} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  rangeCallback = null;
  resizeCallback = null;
  lines.clear();
  spies.getVisibleRange.mockReturnValue(null);
  spies.scrollPosition.mockReturnValue(0);
  spies.createPriceLine.mockImplementation((options: { title: string }) => {
    const handle = { applyOptions: vi.fn() };
    lines.set(options.title, handle);
    return handle;
  });
  const candleSeries = {
    setData: spies.candleSetData,
    update: spies.candleUpdate,
    createPriceLine: spies.createPriceLine,
    removePriceLine: spies.removePriceLine,
  };
  const volumeSeries = {
    setData: spies.volumeSetData,
    update: spies.volumeUpdate,
    priceScale: () => ({ applyOptions: vi.fn() }),
  };
  spies.createChart.mockReturnValue({
    addSeries: vi.fn().mockReturnValueOnce(candleSeries).mockReturnValueOnce(volumeSeries),
    timeScale: () => ({
      fitContent: spies.fitContent,
      getVisibleRange: spies.getVisibleRange,
      setVisibleRange: spies.setVisibleRange,
      scrollPosition: spies.scrollPosition,
      scrollToRealTime: spies.scrollToRealTime,
      subscribeVisibleTimeRangeChange: (callback: typeof rangeCallback) => { rangeCallback = callback; },
    }),
    applyOptions: spies.chartApplyOptions,
    remove: spies.chartRemove,
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: typeof resizeCallback) { resizeCallback = callback; }
    observe(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("vex", { hyperliquid: { onCandleUpdate: vi.fn(() => () => {}) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HyperliquidPositionChart W15 lifecycle", () => {
  it("does not recreate, reset data, or refit for a mark/uPnL-only position push", () => {
    const view = render(chart());
    spies.createChart.mockClear(); spies.chartRemove.mockClear(); spies.candleSetData.mockClear(); spies.fitContent.mockClear();
    view.rerender(chart({ position: position({ markPx: "101", unrealizedPnl: "5", updatedAt: "2026-07-14T00:00:00.000Z" }) }));
    expect(spies.createChart).not.toHaveBeenCalled();
    expect(spies.chartRemove).not.toHaveBeenCalled();
    expect(spies.candleSetData).not.toHaveBeenCalled();
    expect(spies.fitContent).not.toHaveBeenCalled();
  });

  it("moves only the SL price-line handle when the stop changes", () => {
    const view = render(chart());
    const entry = lines.get("ENTRY");
    const sl = lines.get("SL");
    const tp = lines.get("TP");
    const liq = lines.get("LIQ");
    spies.createPriceLine.mockClear(); spies.removePriceLine.mockClear();
    view.rerender(chart({ position: position({ slPrice: "91" }) }));
    expect(spies.createPriceLine).not.toHaveBeenCalled();
    expect(spies.removePriceLine).not.toHaveBeenCalled();
    expect(sl?.applyOptions).toHaveBeenCalledWith({ price: 91 });
    expect(entry?.applyOptions).not.toHaveBeenCalled();
    expect(tp?.applyOptions).not.toHaveBeenCalled();
    expect(liq?.applyOptions).not.toHaveBeenCalled();
  });

  it("restores a panned same-market viewport by TIME range", () => {
    const view = render(chart());
    rangeCallback?.({ from: 1_699_999_000 as never, to: 1_700_000_000 as never });
    spies.scrollPosition.mockReturnValue(2);
    spies.candleSetData.mockClear(); spies.setVisibleRange.mockClear();
    view.rerender(chart({ candles: candles({ close: "1.6" }) }));
    expect(spies.candleSetData).toHaveBeenCalled();
    expect(spies.setVisibleRange).toHaveBeenCalledWith({ from: 1_699_999_000, to: 1_700_000_000 });
  });

  it("follows realtime only at the live edge; a panned view is restored", () => {
    const view = render(chart());
    spies.scrollPosition.mockReturnValue(0);
    view.rerender(chart({ candles: candles({ close: "1.6" }) }));
    expect(spies.scrollToRealTime).toHaveBeenCalledTimes(1);
    spies.scrollToRealTime.mockClear(); spies.setVisibleRange.mockClear();
    rangeCallback?.({ from: 1_699_999_000 as never, to: 1_700_000_000 as never });
    spies.scrollPosition.mockReturnValue(2);
    view.rerender(chart({ candles: candles({ close: "1.7" }) }));
    expect(spies.scrollToRealTime).not.toHaveBeenCalled();
    expect(spies.setVisibleRange).toHaveBeenCalledTimes(1);
  });

  it("does not set data for an identical candle payload with a new query object", () => {
    const view = render(chart());
    spies.candleSetData.mockClear();
    view.rerender(chart({ candles: candles() }));
    expect(spies.candleSetData).not.toHaveBeenCalled();
  });

  it("sets data and fits exactly once for a coin or interval change", () => {
    const view = render(chart());
    spies.candleSetData.mockClear(); spies.fitContent.mockClear();
    view.rerender(chart({ coin: "ETH", interval: "5m", candles: candles({ close: "2" }) }));
    expect(spies.candleSetData).toHaveBeenCalledTimes(1);
    expect(spies.fitContent).toHaveBeenCalledTimes(1);
  });

  it("resizes without recreating the chart or changing the saved time range", () => {
    render(chart());
    rangeCallback?.({ from: 1_699_999_000 as never, to: 1_700_000_000 as never });
    spies.createChart.mockClear(); spies.fitContent.mockClear(); spies.setVisibleRange.mockClear();
    resizeCallback?.([{ contentRect: { width: 640, height: 360 } }]);
    expect(spies.chartApplyOptions).toHaveBeenCalledWith({ width: 640, height: 360 });
    expect(spies.createChart).not.toHaveBeenCalled();
    expect(spies.fitContent).not.toHaveBeenCalled();
    expect(spies.setVisibleRange).not.toHaveBeenCalled();
  });
});
