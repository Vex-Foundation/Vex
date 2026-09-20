import { requireValue } from "../../../../../../../src/__tests__/helpers/require-value.js";
import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketChart } from "../MarketChart.js";
import type { LighterTradingCandle } from "@shared/schemas/lighter-trading.js";
const harness = vi.hoisted(() => {
  const makeSeries = () => ({ setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }), createPriceLine: vi.fn((options: { price: number }) => ({ options })), removePriceLine: vi.fn(), priceToCoordinate: (price: number) => 300 - price, coordinateToPrice: (y: number) => 300 - y });
  const candles = makeSeries(); const volume = makeSeries(); const line = makeSeries();
  const range = vi.fn((): { from: number; to: number } | null => ({ from: 400, to: 506 })); const setRange = vi.fn();
  const rangeHandlers: Array<(range: { from: number; to: number } | null) => void> = [];
  const markers = { detach: vi.fn() };
  const createSeriesMarkers = vi.fn(() => markers);
  const priceScale = { applyOptions: vi.fn() };
  return { candles, volume, line, range, setRange, rangeHandlers, markers, createSeriesMarkers, priceScale, chart: { priceScale: () => priceScale, paneSize: () => ({ width: 500, height: 300 }), addSeries: vi.fn((type: string) => type === "candles" ? candles : type === "line" ? line : volume), applyOptions: vi.fn(), subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(), remove: vi.fn(), timeScale: () => ({ getVisibleLogicalRange: range, setVisibleLogicalRange: setRange, subscribeVisibleLogicalRangeChange: (handler: (range: { from: number; to: number } | null) => void) => { rangeHandlers.push(handler); }, unsubscribeVisibleLogicalRangeChange: (handler: (range: { from: number; to: number } | null) => void) => { rangeHandlers.splice(rangeHandlers.indexOf(handler), 1); } }) } };
});
vi.mock("lightweight-charts", () => ({ CandlestickSeries: "candles", HistogramSeries: "volume", LineSeries: "line", ColorType: { Solid: "solid" }, LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 }, TickMarkType: {}, PriceScaleMode: { Normal: 0, Logarithmic: 1 }, createChart: () => harness.chart, createSeriesMarkers: harness.createSeriesMarkers }));
vi.mock("../ChartTools.js", () => ({
  ChartTools: ({ onChartType, onVolume, onFills, onScale }: {
    onChartType: (type: "line" | "candles") => void;
    onVolume: (visible: boolean) => void;
    onFills: (visible: boolean) => void;
    onScale: (scale: "linear" | "log") => void;
  }) => <>
    <button onClick={() => onChartType("line")}>Use line</button>
    <button onClick={() => onChartType("candles")}>Use candles</button>
    <button onClick={() => onVolume(false)}>Hide volume</button>
    <button onClick={() => onFills(false)}>Hide fills</button>
    <button onClick={() => onFills(true)}>Show fills</button>
    <button onClick={() => onScale("log")}>Use log scale</button>
    <button onClick={() => onScale("linear")}>Use linear scale</button>
  </>,
}));
function candles(count: number, start = 1_700_000_000): LighterTradingCandle[] { return Array.from({ length: count }, (_, i) => ({ timestamp: start + i * 60, open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volumeBase: 100, volumeQuote: 1000 })); }
beforeEach(() => { vi.clearAllMocks(); harness.rangeHandlers.length = 0; harness.createSeriesMarkers.mockReturnValue(harness.markers); harness.range.mockReturnValue({ from: 400, to: 506 }); });
afterEach(cleanup);
describe("Chart timeline continuity", () => {
  it("keeps native history beyond 5000 bars and follows a new live bar", () => {
    harness.range.mockReturnValue({ from: 4900, to: 5006 });
    const view = render(<MarketChart candles={candles(5000)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    view.rerender(<MarketChart candles={candles(5001)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    expect(requireValue(harness.candles.setData.mock.lastCall)[0]).toHaveLength(5000);
    expect(harness.candles.update).toHaveBeenLastCalledWith(expect.objectContaining({ time: 1_700_300_000 }), false);
    expect(harness.volume.update).toHaveBeenLastCalledWith(expect.objectContaining({ time: 1_700_300_000 }), false);
    expect(harness.setRange).toHaveBeenLastCalledWith({ from: 4901, to: 5007 });
  });
  it("keeps a historical viewport stable when a live bar is appended", () => {
    const view = render(<MarketChart candles={candles(5000)} symbol="ETH" theme="chronos" />);
    harness.range.mockReturnValue({ from: 50, to: 100 });
    view.rerender(<MarketChart candles={candles(5001)} symbol="ETH" theme="chronos" />);
    expect(harness.setRange).toHaveBeenLastCalledWith({ from: 50, to: 100 });
  });
  it("rebuilds the series and keeps the viewport when older history is prepended", () => {
    const view = render(<MarketChart candles={candles(100)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    harness.range.mockReturnValue({ from: 5, to: 60 });
    view.rerender(<MarketChart candles={[...candles(50, 1_700_000_000 - 50 * 60), ...candles(100)]} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    expect(requireValue(harness.candles.setData.mock.lastCall)[0]).toHaveLength(150);
    expect(requireValue(harness.candles.setData.mock.lastCall)[0][0]).toMatchObject({ time: 1_700_000_000 - 50 * 60 });
    expect(harness.candles.update).not.toHaveBeenCalled();
    expect(harness.setRange).toHaveBeenLastCalledWith({ from: 55, to: 110 });
  });
  it("applies the first history page as one setData when the identity started empty", () => {
    harness.range.mockReturnValue(null);
    const view = render(<MarketChart candles={[]} symbol="BTC" theme="chronos" marketId={1} resolution="1d" />);
    harness.range.mockReturnValue({ from: 481, to: 587 });
    view.rerender(<MarketChart candles={candles(84)} symbol="BTC" theme="chronos" marketId={1} resolution="1d" />);
    expect(requireValue(harness.candles.setData.mock.lastCall)[0]).toHaveLength(84);
    expect(harness.candles.update).not.toHaveBeenCalled();
    expect(harness.setRange).toHaveBeenLastCalledWith({ from: 24, to: 90 });
  });
  it("keeps older daily bars pannable and explains the provider boundary", () => {
    render(<MarketChart candles={candles(87)} symbol="BTC" theme="chronos" marketId={1} resolution="1d" historyStatus="exhausted" />);
    expect(harness.setRange).toHaveBeenLastCalledWith({ from: 27, to: 93 });
    const handler = requireValue(harness.rangeHandlers[0]);
    act(() => handler({ from: 12, to: 72 }));
    expect(screen.getByRole("status").textContent).toMatch(/Earliest Lighter history/);
    act(() => handler({ from: 40, to: 100 }));
    expect(screen.queryByText(/Earliest Lighter history/)).toBeNull();
  });
  it("draws the account's fills on whichever series is showing", () => {
    const fills = [{ tradeId: "t1", orderId: "o1", marketId: 1, symbol: "ETH", side: "buy" as const, role: "taker" as const, type: "trade", size: "2", price: "11", value: null, realizedPnl: null, timestamp: 1_700_000_130_000 }];
    render(<MarketChart candles={candles(40)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" fills={fills} />);
    expect(harness.createSeriesMarkers).toHaveBeenCalledWith(harness.candles, [expect.objectContaining({ time: 1_700_000_120, shape: "arrowUp" })]);
    fireEvent.click(screen.getByRole("button", { name: "Use line" }));
    expect(harness.markers.detach).toHaveBeenCalledTimes(1);
    expect(harness.createSeriesMarkers).toHaveBeenLastCalledWith(harness.line, expect.any(Array));
    // The toolbar's Fills toggle detaches the arrows and brings them back.
    fireEvent.click(screen.getByRole("button", { name: "Hide fills" }));
    expect(harness.markers.detach).toHaveBeenCalledTimes(2);
    expect(harness.createSeriesMarkers).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Show fills" }));
    expect(harness.createSeriesMarkers).toHaveBeenCalledTimes(3);
  });
  it("asks for older history only when the viewport nears the earliest bar", () => {
    const onLoadOlder = vi.fn();
    render(<MarketChart candles={candles(100)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" onLoadOlder={onLoadOlder} />);
    const handler = requireValue(harness.rangeHandlers[0]);
    handler({ from: 40, to: 90 });
    expect(onLoadOlder).not.toHaveBeenCalled();
    handler({ from: 12, to: 62 });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
  it("switches the price scale between linear and logarithmic from the toolbar", () => {
    render(<MarketChart candles={candles(40)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    fireEvent.click(screen.getByRole("button", { name: "Use log scale" }));
    expect(harness.priceScale.applyOptions).toHaveBeenLastCalledWith({ mode: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Use linear scale" }));
    expect(harness.priceScale.applyOptions).toHaveBeenLastCalledWith({ mode: 0 });
  });
  it("synchronizes hidden line data after switching market and resolution", () => {
    const view = render(<MarketChart candles={candles(40)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    fireEvent.click(screen.getByRole("button", { name: "Use line" }));
    expect(requireValue(harness.line.setData.mock.lastCall)[0]).toHaveLength(40);
    fireEvent.click(screen.getByRole("button", { name: "Use candles" }));
    view.rerender(<MarketChart candles={candles(5, 1_600_000_000)} symbol="BTC" theme="chronos" marketId={2} resolution="1d" />);
    expect(requireValue(harness.line.setData.mock.lastCall)[0]).toEqual(candles(5, 1_600_000_000).map(c => ({ time: c.timestamp, value: c.close })));
    expect(harness.line.applyOptions).toHaveBeenLastCalledWith({ visible: false });
    expect(harness.setRange).toHaveBeenLastCalledWith({ from: 0, to: 11 });
  });
  it("shows the drag-to-order handle only when the desk wires a drop target", () => {
    const view = render(<MarketChart candles={candles(40)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" />);
    expect(screen.queryByRole("button", { name: "Drag to place a limit order" })).toBeNull();
    const onDragOrder = vi.fn();
    view.rerender(<MarketChart candles={candles(40)} symbol="ETH" theme="chronos" marketId={1} resolution="1m" onDragOrder={onDragOrder} />);
    expect(screen.getByRole("button", { name: "Drag to place a limit order" })).toBeTruthy();
  });
  it("moves the account's price lines onto whichever series is showing", () => {
    const levels = [{ key: "entry:1", kind: "entry" as const, price: 64_000, title: "Entry", side: "buy" as const }];
    const view = render(<MarketChart candles={candles(40)} symbol="BTC" theme="chronos" marketId={1} resolution="1m" levels={levels} />);
    expect(harness.candles.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 64_000, title: "Entry", lineStyle: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Use line" }));
    expect(harness.candles.removePriceLine).toHaveBeenCalledTimes(1);
    expect(harness.line.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ price: 64_000 }));
    view.rerender(<MarketChart candles={candles(40)} symbol="BTC" theme="chronos" marketId={1} resolution="1m" levels={[]} />);
    expect(harness.line.removePriceLine).toHaveBeenCalledTimes(1);
    expect(harness.line.createPriceLine).toHaveBeenCalledTimes(1);
  });
});
