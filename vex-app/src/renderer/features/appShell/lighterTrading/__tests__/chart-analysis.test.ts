import { requireValue } from "../../../../../../../src/__tests__/helpers/require-value.js";
import { describe, expect, it } from "vitest";
import type { CandlestickData, UTCTimestamp } from "lightweight-charts";
import { parseChartPreferences } from "../chart-preferences.js";
import { computeStudies, ema, rsi, sma } from "../chart-indicators.js";
import { drawingHistory, logicalToTime, parseDrawings, timeToLogical, type Drawing, type DrawingHistory } from "../chart-drawings.js";
const candle = (close: number, index: number): CandlestickData<UTCTimestamp> => ({ time: (1_700_006_400 + index * 60) as UTCTimestamp, open: close, close, high: close + 1, low: close - 1 });
const drawing: Drawing = { id: "drawing-1", kind: "trend", a: { time: 100, price: 20 }, b: { time: 200, price: 25 } };
describe("Chart indicator math", () => {
  it("waits for warm-up and seeds EMA with the simple average", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 8], 3)).toEqual([null, null, 2, 5]);
    expect(() => sma([1], 0)).toThrow(RangeError);
  });
  it("uses Wilder RSI smoothing and handles flat/up/down price runs", () => {
    expect(rsi([10, 11, 12, 11, 12, 10], 3)).toEqual([null, null, null, 100 - 100 / 3, 100 - 100 / 4.5, 100 - 100 / (1 + 7 / 11)]);
    expect(rsi(Array(20).fill(10)).at(-1)).toBe(50);
    expect(rsi(Array.from({ length: 20 }, (_, i) => i)).at(-1)).toBe(100);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 20 - i)).at(-1)).toBe(0);
  });
  it("calculates population Bollinger deviation and warm-up boundaries", () => {
    const candles = Array.from({ length: 40 }, (_, i) => candle(i + 1, i));
    const data = computeStudies(candles, new Map());
    expect(requireValue(requireValue(data.sma[0])[0]).value).toBe(10.5);
    expect(requireValue(requireValue(data.bb[1])[0]).value).toBeCloseTo(10.5 + 2 * Math.sqrt(33.25));
    expect(requireValue(requireValue(data.bb[2])[0]).value).toBeCloseTo(10.5 - 2 * Math.sqrt(33.25));
    expect(data.macd[0]).toHaveLength(15);
    expect(data.macd[1]).toHaveLength(7);
    expect(data.macd[2]).toHaveLength(7);
    expect(requireValue(requireValue(data.macd[0]).at(-1)).value).toBeCloseTo(7);
    expect(requireValue(requireValue(data.macd[2]).at(-1)).value).toBeCloseTo(0);
  });
  it("weights VWAP with base volume, skips zero volume and resets by UTC day", () => {
    const candles = [candle(10, 0), candle(20, 1), candle(30, 2), candle(40, 1440)];
    const volumes = new Map(candles.map((c, i) => [Number(c.time), requireValue([1, 3, 0, 2][i])]));
    expect(requireValue(computeStudies(candles, volumes).vwap[0]).map(p => p.value)).toEqual([10, 17.5, 17.5, 40]);
    expect(computeStudies(candles, new Map()).vwap[0]).toEqual([]);
  });
});
describe("Bounded drawing state", () => {
  it("round trips valid shapes and rejects malformed or oversized untrusted storage", () => {
    expect(parseDrawings(JSON.stringify([drawing]))).toEqual([drawing]);
    expect(parseDrawings("not json")).toEqual([]);
    expect(parseDrawings(" ".repeat(32_001))).toEqual([]);
    expect(parseDrawings(JSON.stringify([{ ...drawing, a: { time: -1, price: 3 } }, { ...drawing, kind: "script" }]))).toEqual([]);
    expect(parseDrawings(JSON.stringify([drawing, drawing]))).toEqual([drawing]);
    expect(parseDrawings(JSON.stringify(Array.from({ length: 61 }, (_, i) => ({ ...drawing, id: `d-${i}` }))))).toEqual([]);
  });
  it("undoes edit and delete and invalidates redo after a new operation", () => {
    let state: DrawingHistory = { past: [], present: [], future: [] };
    state = drawingHistory(state, { type: "set", drawings: [drawing] });
    state = drawingHistory(state, { type: "set", drawings: [{ ...drawing, b: { ...drawing.b, price: 40 } }] });
    state = drawingHistory(state, { type: "set", drawings: [] });
    state = drawingHistory(state, { type: "undo" });
    expect(requireValue(state.present[0]).b.price).toBe(40);
    state = drawingHistory(state, { type: "undo" });
    expect(state.present).toEqual([drawing]);
    state = drawingHistory(state, { type: "redo" });
    expect(requireValue(state.present[0]).b.price).toBe(40);
    state = drawingHistory(state, { type: "set", drawings: [] });
    expect(state.future).toEqual([]);
    for (let i = 0; i < 40; i++) state = drawingHistory(state, { type: "set", drawings: [drawing] });
    expect(state.past).toHaveLength(30);
  });
  it("retains time anchors across resolutions and extrapolates chart margins", () => {
    const times = [100, 160, 220, 280];
    expect(logicalToTime(1.5, times)).toBe(190);
    expect(timeToLogical(190, times)).toBe(1.5);
    expect(timeToLogical(190, [100, 280, 460])).toBe(.5);
    expect(logicalToTime(-1, times)).toBe(40);
    expect(timeToLogical(340, times)).toBe(4);
    expect(logicalToTime(0, [100])).toBeNull();
  });
});

describe("Bounded chart preference parsing", () => {
  it("accepts known settings, deduplicates studies and rejects malformed data", () => {
    expect(parseChartPreferences(JSON.stringify({ studies: ["ema", "ema", "rsi"], volume: false, chartType: "line" }))).toEqual({ studies: ["ema", "rsi"], volume: false, chartType: "line" });
    const defaults = { studies: [], volume: true, chartType: "candles" };
    for (const raw of [null, "{", " ".repeat(1025), JSON.stringify({ studies: ["unknown"], volume: false, chartType: "line" }), JSON.stringify({ studies: Array(7).fill("ema"), volume: true, chartType: "candles" }), JSON.stringify({ studies: [], volume: "false", chartType: "line" })]) expect(parseChartPreferences(raw)).toEqual(defaults);
  });
});
