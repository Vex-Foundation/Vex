import type { CandlestickData, LineData, UTCTimestamp } from "lightweight-charts";
export type Study = "sma" | "ema" | "bb" | "vwap" | "rsi" | "macd";
/** Studies whose look-back the trader can change; MACD keeps its 12 / 26 / 9. */
export type PeriodStudy = "sma" | "ema" | "bb" | "rsi";
export type StudyPeriods = Record<PeriodStudy, number>;
export const DEFAULT_STUDY_PERIODS: StudyPeriods = { sma: 20, ema: 20, bb: 20, rsi: 14 };
export const STUDY_PERIOD_MIN = 1;
export const STUDY_PERIOD_MAX = 500;
export interface StudyDefinition {
  id: Study;
  label: (periods: StudyPeriods) => string;
  description: (periods: StudyPeriods) => string;
}
export const STUDIES: readonly StudyDefinition[] = [
    {
      id: "sma",
      label: p => `SMA ${p.sma}`,
      description: p => `Simple moving average · ${p.sma} bars`
    },
    {
      id: "ema",
      label: p => `EMA ${p.ema}`,
      description: p => `Exponential moving average · ${p.ema} bars`
    },
    {
      id: "bb",
      label: () => "Bollinger bands",
      description: p => `${p.bb} bars · 2 standard deviations`
    },
    {
      id: "vwap",
      label: () => "Session VWAP",
      description: () => "Volume weighted typical price · resets at 00:00 UTC"
    },
    {
      id: "rsi",
      label: p => `RSI ${p.rsi}`,
      description: p => `Wilder relative strength · ${p.rsi} bars`
    },
    {
      id: "macd",
      label: () => "MACD",
      description: () => "12 / 26 EMA · 9 signal"
    },
  ];
export function isPeriodStudy(id: Study): id is PeriodStudy {
  return id in DEFAULT_STUDY_PERIODS;
}
export const STUDY_BY_ID: Record<Study, StudyDefinition> = Object.fromEntries(
  STUDIES.map(study => [study.id, study]),
) as Record<Study, StudyDefinition>;
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
export function computeStudies(candles: readonly CandlestickData<UTCTimestamp>[], volumes: ReadonlyMap<number, number>, periods: StudyPeriods = DEFAULT_STUDY_PERIODS): Record<Study, Point[][]> {
  const closes = candles.map(c => c.close);
  const points = (values: readonly (number | null)[]): Point[] => values.flatMap((value, i) => value === null || !Number.isFinite(value) ? [] : [{ time: candles[i]!.time, value }]);
  const mean = sma(closes, periods.bb);
  const deviations = mean.map((value, i) => value === null ? null : Math.sqrt(closes.slice(i - periods.bb + 1, i + 1).reduce((sum, close) => sum + (close - value) ** 2, 0) / periods.bb));
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
    sma: [points(sma(closes, periods.sma))],
    ema: [points(ema(closes, periods.ema))],
    bb: [points(mean), points(mean.map((v, i) => v === null ? null : v + 2 * deviations[i]!)), points(mean.map((v, i) => v === null ? null : v - 2 * deviations[i]!))],
    vwap: [points(vwap)],
    rsi: [points(rsi(closes, periods.rsi))],
    macd: [points(macd), points(signal), points(macd.map((v, i) => v === null || signal[i] === null ? null : v - signal[i]!))]
  };
}
