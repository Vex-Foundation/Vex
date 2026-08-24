import type { LighterTradingSnapshot } from "@shared/schemas/lighter-trading.js";
import type {
  CandlestickData,
  HistogramData,
  UTCTimestamp,
} from "lightweight-charts";

function toUnixSeconds(timestamp: number): UTCTimestamp {
  const seconds = timestamp >= 1_000_000_000_000
    ? Math.floor(timestamp / 1_000)
    : Math.floor(timestamp);
  return seconds as UTCTimestamp;
}

export function toChartCandles(
  rows: LighterTradingSnapshot["candles"],
): CandlestickData<UTCTimestamp>[] {
  const byTime = new Map<number, CandlestickData<UTCTimestamp>>();
  for (const row of rows) {
    const time = toUnixSeconds(row.timestamp);
    const values = [row.open, row.high, row.low, row.close];
    if (
      !values.every(Number.isFinite)
      || row.high < Math.max(row.open, row.close, row.low)
      || row.low > Math.min(row.open, row.close, row.high)
    ) continue;
    byTime.set(time, {
      time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    });
  }
  return [...byTime.values()].sort((left, right) => Number(left.time) - Number(right.time));
}

export function toChartVolume(
  rows: LighterTradingSnapshot["candles"],
  upColor: string,
  downColor: string,
): HistogramData<UTCTimestamp>[] {
  const byTime = new Map<number, HistogramData<UTCTimestamp>>();
  for (const row of rows) {
    if (!Number.isFinite(row.volumeBase) || row.volumeBase < 0) continue;
    const time = toUnixSeconds(row.timestamp);
    byTime.set(time, {
      time,
      value: row.volumeBase,
      color: row.close >= row.open ? upColor : downColor,
    });
  }
  return [...byTime.values()].sort((left, right) => Number(left.time) - Number(right.time));
}
