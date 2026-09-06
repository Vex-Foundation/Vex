import type { CandlestickData, LineData, UTCTimestamp } from "lightweight-charts";
export type Study = "sma" | "ema" | "bb" | "vwap" | "rsi" | "macd";
export const STUDIES: readonly {
  id: Study;
  label: string;
  description: string;
}[] = [
    {
      id: "sma",
      label: "SMA 20",
      description: "Simple moving average · 20 bars"
    },
    {
      id: "ema",
      label: "EMA 20",
      description: "Exponential moving average · 20 bars"
    },
    {
      id: "bb",
      label: "Bollinger bands",
      description: "20 bars · 2 standard deviations"
    },
    {
      id: "vwap",
      label: "Session VWAP",
      description: "Volume weighted typical price · resets at 00:00 UTC"
    },
    {
      id: "rsi",
      label: "RSI 14",
      description: "Wilder relative strength · 14 bars"
    },
    {
      id: "macd",
      label: "MACD",
      description: "12 / 26 EMA · 9 signal"
    },
  ];
type Point = LineData<UTCTimestamp>;
export function sma(values: readonly number[], period: number): (number | null)[] {
  if (!Number.isInteger(period) || period < 1)
    throw new RangeError("Invalid period");
  let sum = 0;
  return values.map((value, i) => {
    sum += value;
    if (i >= period)
      sum -= values[i - period]!;
    return i >= period - 1 ? sum / period : null;
  });
}
export function ema(values: readonly number[], period: number): (number | null)[] {
  const seeds = sma(values, period);
  let previous: number | null = null;
  return values.map((value, i) => {
    if (i < period - 1)
      return null;
    previous = previous === null ? seeds[i]! : value * (2 / (period + 1)) + previous * (1 - 2 / (period + 1));
    return previous;
  });
}
export function rsi(values: readonly number[], period = 14): (number | null)[] {
  if (!Number.isInteger(period) || period < 1)
    throw new RangeError("Invalid period");
  let gain = 0;
  let loss = 0;
  return values.map((value, i) => {
    if (i === 0)
      return null;
    const change = value - values[i - 1]!;
    if (i <= period) {
      gain += Math.max(0, change) / period;
      loss += Math.max(0, -change) / period;
    }
    else {
      gain = (gain * (period - 1) + Math.max(0, change)) / period;
      loss = (loss * (period - 1) + Math.max(0, -change)) / period;
    }
    return i < period ? null : loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss);
  });
}
export function computeStudies(candles: readonly CandlestickData<UTCTimestamp>[], volumes: ReadonlyMap<number, number>): Record<Study, Point[][]> {
  const closes = candles.map(c => c.close);
  const points = (values: readonly (number | null)[]): Point[] => values.flatMap((value, i) => value === null || !Number.isFinite(value) ? [] : [{ time: candles[i]!.time, value }]);
  const mean = sma(closes, 20);
  const deviations = mean.map((value, i) => value === null ? null : Math.sqrt(closes.slice(i - 19, i + 1).reduce((sum, close) => sum + (close - value) ** 2, 0) / 20));
  let day = -1;
  let total = 0;
  let volume = 0;
  const vwap = candles.map(c => {
    const nextDay = Math.floor(Number(c.time) / 86400);
    if (day !== nextDay) {
      day = nextDay;
      total = 0;
      volume = 0;
    }
    const weight = volumes.get(Number(c.time)) ?? 0;
    if (Number.isFinite(weight) && weight > 0) {
      total += ((c.high + c.low + c.close) / 3) * weight;
      volume += weight;
    }
    return volume > 0 ? total / volume : null;
  });
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const macd = fast.map((value, i) => value === null || slow[i] === null ? null : value - slow[i]!);
  const compactSignal = ema(macd.filter((value): value is number => value !== null), 9);
  let signalIndex = 0;
  const signal = macd.map(value => value === null ? null : compactSignal[signalIndex++]!);
  return {
    sma: [points(mean)],
    ema: [points(ema(closes, 20))],
    bb: [points(mean), points(mean.map((v, i) => v === null ? null : v + 2 * deviations[i]!)), points(mean.map((v, i) => v === null ? null : v - 2 * deviations[i]!))],
    vwap: [points(vwap)],
    rsi: [points(rsi(closes))],
    macd: [points(macd), points(signal), points(macd.map((v, i) => v === null || signal[i] === null ? null : v - signal[i]!))]
  };
}
