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
  fees: { maker: "0", taker: "0.0003", makerEnabled: false, takerEnabled: true },
  activity24h: { tradesCount: 120, quoteVolume: 1_600_000 },
};

describe("Light it up deterministic review handoff", () => {
  it("names the exact preview-only IOC inputs and never claims execution", () => {
    const message = buildLighterReviewMessage({
      environment: "rhc",
      market: MARKET,
      draft: {
        mode: "market",
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
    expect(message).toContain("display the approval card directly");
    expect(message).toContain("Nothing may execute without the user's explicit approval");
    expect(message).not.toMatch(/order (?:was|is) (?:placed|submitted|filled)/i);
  });

  it("binds a standalone stop loss to its trigger, hard bound, and reduce-only policy", () => {
    const message = buildLighterReviewMessage({
      environment: "core",
      market: MARKET,
      draft: {
        mode: "stop-loss",
        side: "sell",
        baseAmount: "0.1",
        triggerPrice: "2900",
        worstPrice: "2850",
        reduceOnly: true,
      },
    });

    expect(message).toContain("marketType=perp");
    expect(message).toContain("orderType=stop-loss");
    expect(message).toContain("triggerPrice=2900");
    expect(message).toContain("price=2850");
    expect(message).toContain("reduceOnly=true");
    expect(message).toContain("orderExpiryOffsetMinutes=1440");
    expect(message).toContain("preview only");
  });

  it("binds a standalone take profit to its trigger and hard execution bound", () => {
    const message = buildLighterReviewMessage({
      environment: "rhc",
      market: MARKET,
      draft: {
        mode: "take-profit",
        side: "sell",
        baseAmount: "0.1",
        triggerPrice: "3300",
        worstPrice: "3250",
        reduceOnly: true,
      },
    });

    expect(message).toContain("orderType=take-profit");
    expect(message).toContain("triggerPrice=3300");
    expect(message).toContain("price=3250");
    expect(message).toContain("reduceOnly=true");
    expect(message).toContain("approval card directly");
  });

  it.each([
    ["immediate-or-cancel", 30, "Immediate only"],
    ["good-till-time", 240, "Keep open"],
    ["post-only", 1_440, "Maker only"],
  ] as const)("binds a plain limit order to exact %s semantics", (timeInForce, orderExpiryOffsetMinutes, behaviorLabel) => {
    const message = buildLighterReviewMessage({
      environment: "rhc",
      market: MARKET,
      draft: {
        mode: "limit",
        side: "buy",
        baseAmount: "0.2",
        limitPrice: "3190.25",
        timeInForce,
        orderExpiryOffsetMinutes,
        reduceOnly: false,
      },
    });

    expect(message).toContain("plain Lighter limit order");
    expect(message).toContain("price=3190.25");
    expect(message).toContain("orderType=limit");
    expect(message).toContain(`timeInForce=${timeInForce}`);
    expect(message).toContain(`Order behavior is ${behaviorLabel}`);
    expect(message).toContain(`orderExpiryOffsetMinutes=${orderExpiryOffsetMinutes}`);
    expect(message).toContain("exact limit price, not a market-order execution bound");
    expect(message).toContain("preview only");
    expect(message).not.toMatch(/order (?:was|is) (?:placed|submitted|filled)/i);
  });

  it.each([
    ["stop-loss-limit", "2900", "2875"],
    ["take-profit-limit", "3300", "3275"],
  ] as const)("binds native %s to its trigger, limit price, exact TIF, and expiry", (mode, triggerPrice, limitPrice) => {
    for (const timeInForce of ["immediate-or-cancel", "good-till-time", "post-only"] as const) {
      const message = buildLighterReviewMessage({
        environment: "core",
        market: MARKET,
        draft: {
          mode,
          side: "sell",
          baseAmount: "0.1",
          triggerPrice,
          limitPrice,
          timeInForce,
          orderExpiryOffsetMinutes: 240,
          reduceOnly: true,
        },
      });

      expect(message).toContain(`native Lighter ${mode}`);
      expect(message).toContain(`orderType=${mode}`);
      expect(message).toContain(`triggerPrice=${triggerPrice}`);
      expect(message).toContain(`price=${limitPrice}`);
      expect(message).toContain(`timeInForce=${timeInForce}`);
      expect(message).toContain("orderExpiryOffsetMinutes=240");
      expect(message).toContain("limit price that becomes active after the trigger");
      expect(message).toContain("Nothing may execute without the user's explicit approval");
    }
  });

  it("binds both protection legs into one native OCO review request", () => {
    const message = buildLighterReviewMessage({
      environment: "rhc",
      market: MARKET,
      draft: {
        mode: "oco",
        side: "sell",
        baseAmount: "0.1",
        stopLossTriggerPrice: "2900",
        stopLossPrice: "2850",
        takeProfitTriggerPrice: "3300",
        takeProfitPrice: "3250",
      },
    });

    expect(message).toContain("native Lighter stop-loss plus take-profit protection");
    expect(message).toContain("stopLossTriggerPrice=2900");
    expect(message).toContain("stopLossPrice=2850");
    expect(message).toContain("takeProfitTriggerPrice=3300");
    expect(message).toContain("takeProfitPrice=3250");
    expect(message).toContain("exactly one native OCO group");
    expect(message).toContain("two same-size reduce-only children");
    expect(message).toContain("one approval card");
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

  it("bounds long-running chart history to the newest 500 provider candles", () => {
    const rows = Array.from({ length: 520 }, (_, index) => candle({
      timestamp: 1_720_000_000 + index * 60,
      close: 100 + index,
      high: 101 + index,
    }));
    const merged = upsertChartCandles([], rows);
    expect(merged).toHaveLength(500);
    expect(merged[0]?.timestamp).toBe(rows[20]?.timestamp);
    expect(merged.at(-1)?.timestamp).toBe(rows.at(-1)?.timestamp);
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
        status: "connecting",
        symbol: "ETH",
        theme: "chronos",
        environment: "core",
        marketId: 7,
        resolution: "1h",
      }),
    );

    expect(screen.getByRole("status", { name: "Building ETH candle chart" })).toBeTruthy();
    expect(screen.getByText("Loading ETH market")).toBeTruthy();
    expect(screen.getByText("Pulling in the latest chart, prices, and order book.")).toBeTruthy();
    expect(screen.queryByText("No candle history is available for ETH.")).toBeNull();
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
      status: "live",
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
    expect(screen.queryByRole("status", { name: "Building ETH candle chart" })).toBeNull();
    expect(chartHarness.setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: 0, to: 7 });
  });

  it("shows a genuine no-data state only after candle loading becomes unavailable", () => {
    const onChooseMarket = vi.fn();
    render(createElement(MarketChart, {
      candles: [],
      status: "unavailable",
      symbol: "ETH",
      theme: "chronos",
      environment: "core",
      marketId: 7,
      resolution: "1h",
      onChooseMarket,
    }));

    expect(screen.queryByRole("status", { name: "Building ETH candle chart" })).toBeNull();
    expect(screen.getByText("No live data for ETH")).toBeTruthy();
    expect(screen.getByText("Choose another market to continue.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose another market" }));
    expect(onChooseMarket).toHaveBeenCalledTimes(1);
  });

  it("offers retry after the snapshot and candle feed both fail", () => {
    const onRetry = vi.fn();
    render(createElement(MarketChart, {
      candles: [],
      status: "unavailable",
      symbol: "ETH",
      theme: "chronos",
      environment: "core",
      marketId: 7,
      resolution: "1h",
      snapshotFailed: true,
      onRetry,
    }));

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Couldn’t load ETH")).toBeTruthy();
    expect(screen.getByText("The market feed didn’t respond.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
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

  it("renders cumulative totals from the inside market outward", () => {
    const { container } = render(createElement(OrderBook, {
      symbol: "BTC",
      book: {
        asks: [
          { orderId: "a1", price: "101", size: "2" },
          { orderId: "a2", price: "102", size: "3" },
          { orderId: "a3", price: "103", size: "4" },
        ],
        bids: [
          { orderId: "b1", price: "100", size: "5" },
          { orderId: "b2", price: "99", size: "6" },
        ],
      },
    }));

    // Asks read far → best; totals accumulate from the best ask outward.
    expect(Array.from(container.querySelectorAll('[data-side="ask"] .lit-book-total'))
      .map((node) => node.textContent)).toEqual(["9", "5", "2"]);
    // Bids read best → far; totals accumulate downward.
    expect(Array.from(container.querySelectorAll('[data-side="bid"] .lit-book-total'))
      .map((node) => node.textContent)).toEqual(["5", "11"]);
    expect(container.querySelector(".lit-book-columns")?.textContent).toContain("Size BTC");
  });

  it("renders far more than ten levels per side to fill the depth rail", () => {
    const asks = Array.from({ length: 30 }, (_, index) => ({
      orderId: `a${index}`,
      price: String(200 + index),
      size: "1",
    }));
    const { container } = render(createElement(OrderBook, {
      book: { asks, bids: [{ orderId: "b1", price: "199", size: "1" }] },
    }));

    // Capped at the 24-level depth limit, well above the previous 10.
    expect(container.querySelectorAll('[data-side="ask"] .lit-book-row').length).toBe(24);
  });

  it("aggregates duplicate REST prices without coercing provider decimals", () => {
    const { container } = render(createElement(OrderBook, {
      book: {
        asks: [
          { orderId: "a1", price: "9007199254740993.10", size: "0.1" },
          { orderId: "a2", price: "9007199254740993.10", size: "0.2" },
        ],
        bids: [{ orderId: "b1", price: "9007199254740993.00", size: "1" }],
      },
    }));

    expect(container.querySelectorAll('[data-side="ask"] .lit-book-row')).toHaveLength(1);
    expect(container.querySelector('[data-side="ask"] .lit-book-price')?.textContent)
      .toBe("9,007,199,254,740,993.10");
    expect(container.querySelector('[data-side="ask"] .lit-book-size')?.textContent).toBe("0.3");
    expect(container.querySelector(".lit-book-spread strong")?.textContent).toBe("0.1");
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
