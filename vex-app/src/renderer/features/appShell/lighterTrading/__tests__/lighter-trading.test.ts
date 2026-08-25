import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LighterTradingMarket,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import {
  compareCandleTradeIds,
  toChartCandles,
  toChartVolume,
  upsertChartCandles,
} from "../chart-adapter.js";
import { formatLocalChartTick, MarketChart } from "../MarketChart.js";
import { bestBookPrice, OrderBook } from "../OrderBook.js";
import { buildLighterReviewMessage } from "../TradeTicket.js";

const chartHarness = vi.hoisted(() => {
  const candlestickToken = Symbol("CandlestickSeries");
  const histogramToken = Symbol("HistogramSeries");
  const candleSetData = vi.fn();
  const volumeSetData = vi.fn();
  const candleUpdate = vi.fn();
  const volumeUpdate = vi.fn();
  const candleApplyOptions = vi.fn();
  const chartApplyOptions = vi.fn();
  const setVisibleLogicalRange = vi.fn();
  const getVisibleLogicalRange = vi.fn();
  const remove = vi.fn();
  const volumeApplyOptions = vi.fn();
  const subscribeCrosshairMove = vi.fn();
  const unsubscribeCrosshairMove = vi.fn();
  const candleSeries = {
    setData: candleSetData,
    update: candleUpdate,
    applyOptions: candleApplyOptions,
  };
  const volumeSeries = {
    setData: volumeSetData,
    update: volumeUpdate,
    applyOptions: vi.fn(),
    priceScale: () => ({ applyOptions: volumeApplyOptions }),
  };
  const createChart = vi.fn(() => ({
    addSeries: vi.fn((definition: symbol) => definition === candlestickToken
      ? candleSeries
      : volumeSeries),
    applyOptions: chartApplyOptions,
    remove,
    subscribeCrosshairMove,
    unsubscribeCrosshairMove,
    timeScale: () => ({ getVisibleLogicalRange, setVisibleLogicalRange }),
  }));
  return {
    candlestickToken,
    histogramToken,
    candleSetData,
    volumeSetData,
    candleUpdate,
    volumeUpdate,
    candleSeries,
    volumeSeries,
    candleApplyOptions,
    chartApplyOptions,
    setVisibleLogicalRange,
    getVisibleLogicalRange,
    remove,
    createChart,
    subscribeCrosshairMove,
    unsubscribeCrosshairMove,
  };
});

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: chartHarness.candlestickToken,
  HistogramSeries: chartHarness.histogramToken,
  ColorType: { Solid: "solid" },
  LineStyle: { Dotted: 1 },
  TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 },
  createChart: chartHarness.createChart,
}));

const MARKET: LighterTradingMarket = {
  marketId: 7,
  symbol: "ETH",
  marketType: "perp",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 3,
  minBaseAmount: "0.001",
  minQuoteAmount: "10",
  orderQuoteLimit: "100000",
  decimals: { size: 4, price: 2, quote: 6 },
  fees: { maker: "0", taker: "0.0003" },
};

describe("Light it up deterministic review handoff", () => {
  it("names the exact preview-only IOC inputs and never claims execution", () => {
    const message = buildLighterReviewMessage({
      environment: "rhc",
      market: MARKET,
      draft: {
        side: "buy",
        baseAmount: "0.02",
        worstPrice: "3210.50",
        reduceOnly: false,
      },
    });

    expect(message).toContain("preview only");
    expect(message).toContain("environment=rhc");
    expect(message).toContain("marketId=7");
    expect(message).toContain("marketSymbol=ETH");
    expect(message).toContain("side=buy");
    expect(message).toContain("baseAmountIn=0.02");
    expect(message).toContain("price=3210.50");
    expect(message).toContain("orderType=market");
    expect(message).toContain("timeInForce=immediate-or-cancel");
    expect(message).toContain("orderExpiryOffsetMinutes=30");
    expect(message).toContain("Nothing may execute without the separate approval card");
    expect(message).not.toMatch(/order (?:was|is) (?:placed|submitted|filled)/i);
  });
});

describe("Light it up chart adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chartHarness.getVisibleLogicalRange.mockReturnValue(null);
  });

  it("sorts, de-duplicates, and converts provider millisecond candles", () => {
    const rows = [
      { ...candle({ timestamp: 1_720_000_060_000, open: 101, close: 102, high: 103, low: 100 }), lastTradeId: "2" },
      candle({ timestamp: 1_720_000_000_000, open: 99, close: 101, high: 102, low: 98 }),
      { ...candle({ timestamp: 1_720_000_060_000, open: 101, close: 104, high: 105, low: 100 }), lastTradeId: "3" },
    ];

    const chartRows = toChartCandles(rows);
    expect(chartRows).toHaveLength(2);
    expect(Number(chartRows[0]?.time)).toBe(1_720_000_000);
    expect(chartRows[1]).toMatchObject({ close: 104, high: 105 });
  });

  it("uses compact native-style intraday ticks instead of repeating full dates", () => {
    const time = 1_720_000_000 as Parameters<typeof formatLocalChartTick>[0];
    expect(formatLocalChartTick(time, 3)).toMatch(/^\d{2}:\d{2}$/);
    expect(formatLocalChartTick(time, 2)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it("upserts equal-time candles with lossless provider ids and rejects stale echoes", () => {
    const enormous = "90071992547409931234567890";
    expect(compareCandleTradeIds(enormous, "90071992547409931234567889")).toBe(1);

    const rest = {
      ...candle({ close: 105, high: 106 }),
      lastTradeId: enormous,
      source: "rest_snapshot" as const,
    };
    const staleStream = {
      ...candle({ close: 103, high: 104 }),
      lastTradeId: "90071992547409931234567889",
      source: "websocket_update" as const,
    };
    const equalStream = {
      ...candle({ close: 104, high: 105 }),
      lastTradeId: enormous,
      source: "websocket_update" as const,
    };

    expect(upsertChartCandles([rest], [staleStream, equalStream])).toEqual([rest]);
    expect(upsertChartCandles([equalStream], [rest])).toEqual([rest]);
  });

  it("uses provider volume and directional colors", () => {
    const rows = [
      candle({ timestamp: 1_720_000_000, open: 10, close: 12, high: 12, low: 9, volumeBase: 4 }),
      candle({ timestamp: 1_720_000_060, open: 12, close: 11, high: 13, low: 10, volumeBase: 7 }),
    ];
    expect(toChartVolume(rows, "up", "down")).toEqual([
      { time: 1_720_000_000, value: 4, color: "up" },
      { time: 1_720_000_060, value: 7, color: "down" },
    ]);
  });

  it("keeps a real chart host mounted when history is initially empty", () => {
    const { rerender } = render(
      createElement(MarketChart, {
        candles: [],
        symbol: "ETH",
        theme: "chronos",
        environment: "core",
        marketId: 7,
        resolution: "1h",
      }),
    );

    expect(chartHarness.createChart).toHaveBeenCalledTimes(1);
    expect(chartHarness.createChart).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        layout: expect.objectContaining({ fontSize: 13 }),
      }),
    );
    expect(chartHarness.candleSetData).toHaveBeenLastCalledWith([]);

    const liveCandles = [candle({ timestamp: 1_720_000_000, close: 102 })];
    rerender(createElement(MarketChart, {
      candles: liveCandles,
      symbol: "ETH",
      theme: "chronos",
      environment: "core",
      marketId: 7,
      resolution: "1h",
    }));

    expect(chartHarness.createChart).toHaveBeenCalledTimes(1);
    expect(chartHarness.candleSetData).toHaveBeenCalledTimes(1);
    expect(chartHarness.candleUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 1_720_000_000, close: 102 }),
      false,
    );
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 7 });
  });

  it("shows the latest 100 bars once and follows only an already-live range", () => {
    const initial = Array.from({ length: 120 }, (_, index) => candle({
      timestamp: 1_720_000_000_000 + index * 60_000,
      open: 100 + index,
      close: 101 + index,
      high: 102 + index,
      low: 99 + index,
    }));
    const { rerender } = render(createElement(MarketChart, {
      candles: initial,
      symbol: "ETH",
      theme: "chronos",
      environment: "core",
      marketId: 7,
      resolution: "1m",
    }));

    expect(chartHarness.candleSetData).toHaveBeenCalledTimes(1);
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 20, to: 126 });

    chartHarness.getVisibleLogicalRange.mockReturnValue({ from: 20, to: 126 });
    const next = candle({
      timestamp: 1_720_000_000_000 + 120 * 60_000,
      open: 220,
      close: 221,
      high: 222,
      low: 219,
    });
    rerender(createElement(MarketChart, {
      candles: [...initial, next],
      symbol: "ETH",
      theme: "chronos",
      environment: "core",
      marketId: 7,
      resolution: "1m",
    }));

    expect(chartHarness.candleSetData).toHaveBeenCalledTimes(1);
    expect(chartHarness.candleUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ time: 1_720_007_200, close: 221 }),
      false,
    );
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 21, to: 127 });

    chartHarness.getVisibleLogicalRange.mockReturnValue({ from: 4, to: 45 });
    const later = candle({
      timestamp: 1_720_000_000_000 + 121 * 60_000,
      open: 221,
      close: 222,
      high: 223,
      low: 220,
    });
    rerender(createElement(MarketChart, {
      candles: [...initial, next, later],
      symbol: "ETH",
      theme: "chronos",
      environment: "core",
      marketId: 7,
      resolution: "1m",
    }));
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 4, to: 45 });
  });

  it("preserves range through theme updates and resets it on an explicit resolution change", () => {
    const rows = [candle()];
    const { rerender } = render(createElement(MarketChart, {
      candles: rows,
      symbol: "ETH",
      theme: "chronos",
      environment: "core",
      marketId: 7,
      resolution: "1h",
      pricePrecision: 3,
      priceMinMove: 0.001,
    }));
    const createdChart = chartHarness.createChart.mock.results[0]?.value;
    expect(chartHarness.createChart).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        localization: expect.objectContaining({ timeFormatter: expect.any(Function) }),
        timeScale: expect.objectContaining({
          rightOffset: 7,
          tickMarkFormatter: expect.any(Function),
        }),
      }),
    );
    expect(createdChart?.addSeries).toHaveBeenNthCalledWith(
      1,
      chartHarness.candlestickToken,
      expect.objectContaining({
        priceFormat: { type: "price", precision: 3, minMove: 0.001 },
        priceLineVisible: true,
        priceLineStyle: 1,
      }),
    );
    expect(createdChart?.addSeries).toHaveBeenNthCalledWith(
      2,
      chartHarness.histogramToken,
      expect.objectContaining({ lastValueVisible: true }),
    );
    chartHarness.getVisibleLogicalRange.mockReturnValue({ from: -3, to: 7 });

    rerender(createElement(MarketChart, {
      candles: rows,
      symbol: "ETH",
      theme: "celeris",
      environment: "core",
      marketId: 7,
      resolution: "1h",
      pricePrecision: 3,
      priceMinMove: 0.001,
    }));
    expect(chartHarness.createChart).toHaveBeenCalledTimes(1);
    expect(chartHarness.candleSetData).toHaveBeenCalledTimes(1);
    expect(chartHarness.chartApplyOptions).toHaveBeenCalled();
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: -3, to: 7 });

    rerender(createElement(MarketChart, {
      candles: rows,
      symbol: "ETH",
      theme: "celeris",
      environment: "core",
      marketId: 7,
      resolution: "4h",
      pricePrecision: 3,
      priceMinMove: 0.001,
    }));
    expect(chartHarness.candleSetData).toHaveBeenCalledTimes(2);
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 7 });
  });

  it("provides working zoom and return-to-live chart controls", () => {
    const rows = Array.from({ length: 120 }, (_, index) => candle({
      timestamp: 1_720_000_000_000 + index * 60_000,
    }));
    chartHarness.getVisibleLogicalRange.mockReturnValue({ from: 20, to: 120 });
    render(createElement(MarketChart, {
      candles: rows,
      symbol: "ETH",
      theme: "chronos",
      environment: "core",
      marketId: 7,
      resolution: "1m",
    }));

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 32.5, to: 107.5 });

    fireEvent.click(screen.getByRole("button", { name: "Return to live candles" }));
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 20, to: 126 });
  });

  it("renders a DOM OHLC and volume legend from crosshair data with latest fallback", () => {
    render(createElement(MarketChart, {
      candles: [candle({ open: 100, high: 104, low: 98, close: 103, volumeBase: 12 })],
      symbol: "ETH",
      theme: "chronos",
      pricePrecision: 2,
    }));
    expect(screen.getByLabelText("ETH chart values").textContent).toContain("O 100.00");
    expect(screen.getByLabelText("ETH chart values").textContent).toContain("H 104.00");
    expect(screen.getByLabelText("ETH chart values").textContent).toContain("Vol 12");

    const handler = chartHarness.subscribeCrosshairMove.mock.calls[0]?.[0];
    act(() => {
      handler?.({
        point: { x: 10, y: 10 },
        seriesData: new Map([
          [chartHarness.candleSeries, {
            time: 1_720_000_000,
            open: 90,
            high: 95,
            low: 89,
            close: 94,
          }],
          [chartHarness.volumeSeries, { time: 1_720_000_000, value: 42 }],
        ]),
      });
    });
    expect(screen.getByLabelText("ETH chart values").textContent).toContain("O 90.00");
    expect(screen.getByLabelText("ETH chart values").textContent).toContain("C 94.00");
    expect(screen.getByLabelText("ETH chart values").textContent).toContain("Vol 42");

    act(() => handler?.({ point: undefined, seriesData: new Map() }));
    expect(screen.getByLabelText("ETH chart values").textContent).toContain("C 103.00");
  });
});

describe("Light it up order book", () => {
  it("places the best ask next to the spread while preserving best-price selection", () => {
    const asks = [
      { orderId: "a1", price: "101", size: "2" },
      { orderId: "a2", price: "103", size: "4" },
      { orderId: "a3", price: "102", size: "3" },
    ];
    const { container } = render(createElement(OrderBook, {
      book: {
        asks,
        bids: [{ orderId: "b1", price: "100", size: "5" }],
      },
    }));

    expect(bestBookPrice(asks, "ask")).toBe("101");
    expect(Array.from(container.querySelectorAll('[data-side="ask"] .lit-book-price'))
      .map((node) => node.textContent)).toEqual(["103", "102", "101"]);
  });
});

function candle(
  overrides: Partial<LighterTradingSnapshot["candles"][number]> = {},
): LighterTradingSnapshot["candles"][number] {
  return {
    timestamp: 1_720_000_000_000,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volumeBase: 3,
    volumeQuote: 300,
    ...overrides,
  };
}
