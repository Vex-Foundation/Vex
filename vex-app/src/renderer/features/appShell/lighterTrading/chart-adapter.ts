import type { LighterTradingCandle } from "@shared/schemas/lighter-trading.js";
import type {
  CandlestickData,
  HistogramData,
  UTCTimestamp,
} from "lightweight-charts";

export type ChartCandleRow = LighterTradingCandle & {
  /** Lossless provider candle sequence/trade id (the provider's `i` field). */
  readonly lastTradeId?: string;
  readonly source?: string;
};

const MAX_CHART_CANDLES = 500;

function toUnixSeconds(timestamp: number): UTCTimestamp {
  const seconds = timestamp >= 1_000_000_000_000
    ? Math.floor(timestamp / 1_000)
    : Math.floor(timestamp);
  return seconds as UTCTimestamp;
}

function normalizeDecimalId(value: string | undefined): string | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  return value.replace(/^0+(?=\d)/, "");
}

/** Compares decimal identifiers without ever coercing them through Number. */
export function compareCandleTradeIds(
  left: string | undefined,
  right: string | undefined,
): number {
  const normalizedLeft = normalizeDecimalId(left);
  const normalizedRight = normalizeDecimalId(right);
  if (normalizedLeft === null) return normalizedRight === null ? 0 : -1;
  if (normalizedRight === null) return 1;
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function isRestSource(source: string | undefined): boolean {
  return source === "rest_snapshot";
}

function preferIncomingCandle(existing: ChartCandleRow, incoming: ChartCandleRow): boolean {
  const existingSequence = normalizeDecimalId(existing.lastTradeId);
  const incomingSequence = normalizeDecimalId(incoming.lastTradeId);
  const sequenceOrder = compareCandleTradeIds(
    incoming.lastTradeId,
    existing.lastTradeId,
  );
  if (sequenceOrder !== 0) return sequenceOrder > 0;

  // Old snapshots do not carry the provider sequence. Preserve their former
  // last-write behavior so the current REST candle can still advance.
  if (existingSequence === null && incomingSequence === null) {
    return isRestSource(incoming.source) || !isRestSource(existing.source);
  }

  // A REST reconciliation is authoritative over an equal-id stream echo. In
  // every other tie the already-applied point wins, preventing event order
  // from making an equal provider id oscillate on screen.
  return isRestSource(incoming.source) && !isRestSource(existing.source);
}

function isUsableCandle(row: ChartCandleRow): boolean {
  const values = [row.timestamp, row.open, row.high, row.low, row.close];
  return (
    values.every(Number.isFinite)
    && row.timestamp >= 0
    && row.high >= Math.max(row.open, row.close, row.low)
    && row.low <= Math.min(row.open, row.close, row.high)
  );
}

/**
 * Deterministically merges candle rows by normalized timestamp and lossless
 * provider sequence id. Existing rows survive stale/equal WebSocket echoes.
 */
export function upsertChartCandles(
  existing: readonly ChartCandleRow[],
  incoming: readonly ChartCandleRow[],
): ChartCandleRow[] {
  const byTime = new Map<number, ChartCandleRow>();

  for (const row of [...existing, ...incoming]) {
    if (!isUsableCandle(row)) continue;
    const time = Number(toUnixSeconds(row.timestamp));
    const current = byTime.get(time);
    if (current === undefined || preferIncomingCandle(current, row)) {
      byTime.set(time, row);
    }
  }

  return [...byTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, row]) => row)
    .slice(-MAX_CHART_CANDLES);
}

export function toChartCandles(
  rows: readonly ChartCandleRow[],
): CandlestickData<UTCTimestamp>[] {
  return upsertChartCandles([], rows).map((row) => ({
    time: toUnixSeconds(row.timestamp),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }));
}

export function toChartVolume(
  rows: readonly ChartCandleRow[],
  upColor: string,
  downColor: string,
): HistogramData<UTCTimestamp>[] {
  return upsertChartCandles([], rows)
    .filter((row) => Number.isFinite(row.volumeBase) && row.volumeBase >= 0)
    .map((row) => ({
      time: toUnixSeconds(row.timestamp),
      value: row.volumeBase,
      color: row.close >= row.open ? upColor : downColor,
    }));
}
