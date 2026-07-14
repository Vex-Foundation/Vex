import { describe, expect, it, vi } from "vitest";

vi.mock("lightweight-charts", () => ({
  CandlestickSeries: {}, HistogramSeries: {}, LineStyle: { Solid: 0, Dashed: 1, Dotted: 2 }, createChart: vi.fn(),
}));
vi.mock("../../../../lib/api/hyperliquid.js", () => ({ useHyperliquidCandles: vi.fn() }));

const { deriveCandleChartState } = await import("../HyperliquidPositionChart.js");

describe("HyperliquidPositionChart states", () => {
  it("distinguishes loading, unavailable, empty, and candle-ready states", () => {
    expect(deriveCandleChartState(true, false, undefined)).toBe("loading");
    expect(deriveCandleChartState(false, true, undefined)).toBe("error");
    expect(deriveCandleChartState(false, false, { ok: false })).toBe("error");
    expect(deriveCandleChartState(false, false, { ok: true, data: { candles: [] } })).toBe("empty");
    expect(deriveCandleChartState(false, false, { ok: true, data: { candles: [{}] } })).toBe("ready");
  });
});
