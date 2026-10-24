import type { CandlestickData, LineData, UTCTimestamp } from "lightweight-charts";
import { bollinger, ema, macd, rsi, sma } from "@vex-lib/indicators/index.js";
// The math is shared with the engine's technical analysis; the desk keeps its
// old import names so its callers and tests did not move.
export { ema, rsi, sma };
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
export function computeStudies(candles: readonly CandlestickData<UTCTimestamp>[], volumes: ReadonlyMap<number, number>, periods: StudyPeriods = DEFAULT_STUDY_PERIODS): Record<Study, Point[][]> {
  const closes = candles.map(c => c.close);
  const points = (values: readonly (number | null)[]): Point[] => values.flatMap((value, i) => value === null || !Number.isFinite(value) ? [] : [{ time: candles[i]!.time, value }]);
  const bands = bollinger(closes, periods.bb, 2);
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
  const lines = macd(closes, 12, 26, 9);
  return {
    sma: [points(sma(closes, periods.sma))],
    ema: [points(ema(closes, periods.ema))],
    bb: [points(bands.middle), points(bands.upper), points(bands.lower)],
    vwap: [points(vwap)],
    rsi: [points(rsi(closes, periods.rsi))],
    macd: [points(lines.macd), points(lines.signal), points(lines.histogram)]
  };
}
