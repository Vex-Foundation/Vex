/**
 * The shared indicator math the desk and the engine both read.
 *
 * Every expectation is a published worked example or a series computed by
 * hand from the definition in the module's header, never a value read back
 * from the implementation. The desk's own parity test
 * (`vex-app/.../lighterTrading/__tests__/chart-analysis.test.ts`) proves the
 * desk's numbers did not move when it switched onto this module.
 */

import { describe, expect, it } from "vitest";

import {
  atr,
  bollinger,
  ema,
  lastValue,
  macd,
  rsi,
  sma,
  trueRange,
} from "../../../lib/indicators/index.js";

/** The StockCharts "Moving Averages" worked example: 30 closes, 10-day EMA. */
const STOCKCHARTS_CLOSES = [
  22.27, 22.19, 22.08, 22.17, 22.18, 22.13, 22.23, 22.43, 22.24, 22.29, 22.15, 22.39, 22.38, 22.61,
  23.36, 24.05, 23.75, 23.83, 23.95, 23.63, 23.82, 23.87, 23.65, 23.19, 23.1, 23.33, 22.68, 23.1,
  22.4, 22.17,
];

/**
 * The EMA column of that example as published, to the cent. The sheet chains
 * its own rounded values, so one entry (23.54 against 23.5335) differs from
 * full precision by a little under a cent; the tolerance below is one cent.
 */
const STOCKCHARTS_EMA_10 = [
  22.22, 22.21, 22.24, 22.27, 22.33, 22.52, 22.8, 22.97, 23.13, 23.28, 23.34, 23.43, 23.51, 23.54,
  23.47, 23.4, 23.39, 23.26, 23.23, 23.08, 22.92,
];

function expectWithin(actual: number | null, expected: number, tolerance: number): void {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);
}

describe("moving averages", () => {
  it("matches the StockCharts 10-day EMA worked example", () => {
    const series = ema(STOCKCHARTS_CLOSES, 10);
    expect(series.slice(0, 9)).toEqual(Array(9).fill(null));
    STOCKCHARTS_EMA_10.forEach((expected, i) => expectWithin(series[i + 9]!, expected, 0.01));
  });

  it("seeds the EMA with the simple average at index period - 1", () => {
    const seed = STOCKCHARTS_CLOSES.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    expect(ema(STOCKCHARTS_CLOSES, 10)[9]).toBeCloseTo(seed, 12);
    expect(sma(STOCKCHARTS_CLOSES, 10)[9]).toBeCloseTo(seed, 12);
  });

  it("keeps every series aligned with its input", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 8], 3)).toEqual([null, null, 2, 5]);
    expect(ema([1, 2], 3)).toEqual([null, null]);
    expect(sma([], 3)).toEqual([]);
  });
});

describe("rsi", () => {
  it("is Wilder's, seeded with the simple average of the first changes", () => {
    // Changes +1 +1 -1: gain 2/3, loss 1/3, RS 2 -> 66.67. Then +1: gain
    // (2/3 * 2 + 1) / 3 = 7/9, loss 2/9, RS 3.5 -> 77.78. Then -2: gain
    // 14/27, loss (4/9 + 2) / 3 = 22/27, RS 7/11 -> 38.89.
    const series = rsi([10, 11, 12, 11, 12, 10], 3);
    expect(series.slice(0, 3)).toEqual([null, null, null]);
    expect(series[3]).toBeCloseTo(100 - 100 / 3, 12);
    expect(series[4]).toBeCloseTo(100 - 100 / 4.5, 12);
    expect(series[5]).toBeCloseTo(100 - 100 / (1 + 7 / 11), 12);
  });

  it("reads 50 on a flat series, 100 on a rise and 0 on a fall", () => {
    expect(lastValue(rsi(Array(20).fill(10)))).toBe(50);
    expect(lastValue(rsi(Array.from({ length: 20 }, (_, i) => i)))).toBe(100);
    expect(lastValue(rsi(Array.from({ length: 20 }, (_, i) => 20 - i)))).toBe(0);
  });

  it("warms up for period bars", () => {
    const series = rsi(Array.from({ length: 30 }, (_, i) => 10 + Math.sin(i)), 14);
    expect(series.filter((v) => v === null)).toHaveLength(14);
    expect(series[14]).not.toBeNull();
  });
});

describe("macd", () => {
  it("is the fast EMA minus the slow EMA, with the signal over the compacted line", () => {
    const closes = Array.from({ length: 40 }, (_, i) => i + 1);
    const { macd: line, signal, histogram } = macd(closes, 12, 26, 9);
    // A straight line: each EMA lags the price by (period - 1) / 2, so the
    // MACD is (26 - 1) / 2 - (12 - 1) / 2 = 7 once both are seeded.
    expect(line.filter((v) => v !== null)).toHaveLength(15);
    expect(lastValue(line)).toBeCloseTo(7, 9);
    // The signal's first value is the 9th MACD value, index 25 + 8 = 33.
    expect(signal.slice(0, 33).every((v) => v === null)).toBe(true);
    expect(signal[33]).toBeCloseTo(7, 9);
    expect(signal.filter((v) => v !== null)).toHaveLength(7);
    expect(lastValue(histogram)).toBeCloseTo(0, 9);
    expect(histogram.map((v) => v === null)).toEqual(signal.map((v) => v === null));
  });

  it("refuses a non-integer period", () => {
    expect(() => macd([1, 2, 3], 12.5, 26, 9)).toThrow(RangeError);
    expect(() => macd([1, 2, 3], 12, 26, 0)).toThrow(RangeError);
  });
});

describe("bollinger", () => {
  it("uses the population deviation of the SMA window", () => {
    // Window 1..5: mean 3, squared deviations 4 1 0 1 4, population variance 2.
    const { middle, upper, lower } = bollinger([1, 2, 3, 4, 5], 5, 2);
    expect(middle).toEqual([null, null, null, null, 3]);
    expect(upper[4]).toBeCloseTo(3 + 2 * Math.SQRT2, 12);
    expect(lower[4]).toBeCloseTo(3 - 2 * Math.SQRT2, 12);
    expect(upper.slice(0, 4)).toEqual([null, null, null, null]);
  });

  it("refuses a negative or non-finite multiplier", () => {
    expect(() => bollinger([1, 2, 3], 2, -1)).toThrow(RangeError);
    expect(() => bollinger([1, 2, 3], 2, Number.NaN)).toThrow(RangeError);
  });
});

describe("true range and atr", () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10.5 },
    { high: 12, low: 10, close: 11 },
    { high: 11.5, low: 7, close: 8 },
    { high: 9, low: 8.5, close: 8.8 },
  ];

  it("takes the largest of the range and the gaps from the previous close", () => {
    // Bar 0 has no previous close: 10 - 8. Bar 3: |7 - 11| = 4 loses to 4.5.
    // Bar 4: the gap |9 - 8| = 1 beats the 0.5 range.
    expect(trueRange(bars)).toEqual([2, 2, 2, 4.5, 1]);
  });

  it("is Wilder's smoothing seeded with the simple average of the first ranges", () => {
    const series = atr(bars, 3);
    expect(series.slice(0, 2)).toEqual([null, null]);
    expect(series[2]).toBeCloseTo(2, 12);
    expect(series[3]).toBeCloseTo((2 * 2 + 4.5) / 3, 12);
    expect(series[4]).toBeCloseTo(((2 * 2 + 4.5) / 3 * 2 + 1) / 3, 12);
  });

  it("stays null while there are fewer bars than the period", () => {
    expect(atr(bars.slice(0, 2), 3)).toEqual([null, null]);
  });
});

describe("period validation", () => {
  it("refuses zero, negative and fractional look-backs", () => {
    for (const period of [0, -1, 2.5, Number.NaN]) {
      expect(() => sma([1, 2, 3], period)).toThrow(RangeError);
      expect(() => ema([1, 2, 3], period)).toThrow(RangeError);
      expect(() => rsi([1, 2, 3], period)).toThrow(RangeError);
      expect(() => atr([{ high: 1, low: 0, close: 1 }], period)).toThrow(RangeError);
      expect(() => bollinger([1, 2, 3], period)).toThrow(RangeError);
    }
  });
});
