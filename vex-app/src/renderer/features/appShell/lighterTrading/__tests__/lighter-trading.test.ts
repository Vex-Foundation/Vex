import { render } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LighterTradingMarket,
  LighterTradingSnapshot,
} from "@shared/schemas/lighter-trading.js";
import { toChartCandles, toChartVolume } from "../chart-adapter.js";
import { MarketChart } from "../MarketChart.js";
import { bestBookPrice, OrderBook } from "../OrderBook.js";
import { buildLighterReviewMessage } from "../TradeTicket.js";

const chartHarness = vi.hoisted(() => {
  const candlestickToken = Symbol("CandlestickSeries");
  const histogramToken = Symbol("HistogramSeries");
  const candleSetData = vi.fn();
  const volumeSetData = vi.fn();
  const fitContent = vi.fn();
  const remove = vi.fn();
  const volumeApplyOptions = vi.fn();
  const createChart = vi.fn(() => ({
    addSeries: vi.fn((definition: symbol) => definition === candlestickToken
      ? { setData: candleSetData }
      : {
          setData: volumeSetData,
          priceScale: () => ({ applyOptions: volumeApplyOptions }),
        }),
    remove,
    timeScale: () => ({ fitContent }),
  }));
  return {
    candlestickToken,
    histogramToken,
    candleSetData,
    volumeSetData,
    fitContent,
    remove,
    createChart,
  };
});

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: chartHarness.candlestickToken,
  HistogramSeries: chartHarness.histogramToken,
  ColorType: { Solid: "solid" },
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
  });

  it("sorts, de-duplicates, and converts provider millisecond candles", () => {
    const rows = [
      candle({ timestamp: 1_720_000_060_000, open: 101, close: 102, high: 103, low: 100 }),
      candle({ timestamp: 1_720_000_000_000, open: 99, close: 101, high: 102, low: 98 }),
      candle({ timestamp: 1_720_000_060_000, open: 101, close: 104, high: 105, low: 100 }),
    ];

    const chartRows = toChartCandles(rows);
    expect(chartRows).toHaveLength(2);
    expect(Number(chartRows[0]?.time)).toBe(1_720_000_000);
    expect(chartRows[1]).toMatchObject({ close: 104, high: 105 });
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
      createElement(MarketChart, { candles: [], symbol: "ETH", theme: "chronos" }),
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
    }));

    expect(chartHarness.createChart).toHaveBeenCalledTimes(1);
    expect(chartHarness.candleSetData).toHaveBeenLastCalledWith([
      expect.objectContaining({ time: 1_720_000_000, close: 102 }),
    ]);
    expect(chartHarness.fitContent).toHaveBeenCalledTimes(1);
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
