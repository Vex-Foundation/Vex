import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketChart } from "../MarketChart.js";
import type { LighterTradingCandle } from "@shared/schemas/lighter-trading.js";
const harness = vi.hoisted(() => {
  const makeSeries = () => ({ setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }) });
  const candles = makeSeries(); const volume = makeSeries(); const line = makeSeries();
  const range = vi.fn(() => ({ from: 400, to: 506 })); const setRange = vi.fn();
  return { candles, volume, line, range, setRange, chart: { addSeries: vi.fn((type: string) => type === "candles" ? candles : type === "line" ? line : volume), applyOptions: vi.fn(), subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), remove: vi.fn(), timeScale: () => ({ getVisibleLogicalRange: range, setVisibleLogicalRange: setRange }) } };
});
vi.mock("lightweight-charts", () => ({ CandlestickSeries: "candles", HistogramSeries: "volume", LineSeries: "line", ColorType: { Solid: "solid" }, LineStyle: { Dotted: 1 }, TickMarkType: {}, createChart: () => harness.chart }));
vi.mock("../ChartTools.js", () => ({ ChartTools: ({ onChartType }: { onChartType: (type: "line" | "candles") => void }) => <><button onClick={() => onChartType("line")}>Use line</button><button onClick={() => onChartType("candles")}>Use candles</button></> }));
function candles(count: number, start = 1_700_000_000): LighterTradingCandle[] { return Array.from({ length: count }, (_, i) => ({ timestamp: start + i * 60, open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volumeBase: 100, volumeQuote: 1000 })); }
beforeEach(() => { vi.clearAllMocks(); harness.range.mockReturnValue({ from: 400, to: 506 }); });
afterEach(cleanup);
describe("Chart timeline continuity", () => {
  it("prunes native candle and volume history at 500 bars without displacing live view", () => {
    const view = render(<MarketChart candles={candles(500)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    view.rerender(<MarketChart candles={candles(501)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    expect(harness.candles.setData).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ time: 1_700_000_060 })]));
    expect(harness.candles.setData.mock.lastCall![0]).toHaveLength(500);
    expect(harness.volume.setData.mock.lastCall![0]).toHaveLength(500);
    expect(harness.setRange).toHaveBeenLastCalledWith({ from: 400, to: 506 });
  });
  it("keeps historical candle timestamps under the same viewport after pruning", () => {
    const view = render(<MarketChart candles={candles(500)} symbol="ETH" theme="chronos" />);
    harness.range.mockReturnValue({ from: 50, to: 100 });
    view.rerender(<MarketChart candles={candles(501)} symbol="ETH" theme="chronos" />);
    expect(harness.setRange).toHaveBeenLastCalledWith({ from: 49, to: 99 });
  });
  it("synchronizes hidden line data after switching market and resolution", () => {
    const view = render(<MarketChart candles={candles(40)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    fireEvent.click(screen.getByRole("button", { name: "Use line" }));
    expect(harness.line.setData.mock.lastCall![0]).toHaveLength(40);
    fireEvent.click(screen.getByRole("button", { name: "Use candles" }));
    view.rerender(<MarketChart candles={candles(5, 1_600_000_000)} symbol="BTC" theme="chronos" marketId={2} resolution="1d" />);
    expect(harness.line.setData.mock.lastCall![0]).toEqual(candles(5, 1_600_000_000).map(c => ({ time: c.timestamp, value: c.close })));
    expect(harness.line.applyOptions).toHaveBeenLastCalledWith({ visible: false });
  });
});
