import { Decimal } from "decimal.js";
import { z } from "zod";

import type { HyperliquidCandleInterval } from "@tools/hyperliquid/candles.js";

export interface StoredHyperliquidCandle {
  readonly coin: string;
  readonly interval: HyperliquidCandleInterval;
  readonly openTimeMs: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly updatedAt: string;
}

const positiveInteger = z.number().int().min(1).max(5_000);
const decimalInput = z.union([z.string().min(1).max(64), z.number().finite()]);

const filterSchema = z.object({
  pctChange: z.object({ window: positiveInteger }).strict().optional(),
  breakout: z.object({ lookback: positiveInteger }).strict().optional(),
  volumeSpike: z.object({ window: positiveInteger, factor: decimalInput }).strict().optional(),
  smaCross: z.object({ fast: positiveInteger, slow: positiveInteger }).strict().optional(),
  emaCross: z.object({ fast: positiveInteger, slow: positiveInteger }).strict().optional(),
  rsi: z.object({ period: positiveInteger }).strict().optional(),
  rangeStats: z.object({ window: positiveInteger }).strict().optional(),
}).strict().refine((filters) => Object.keys(filters).length > 0, "At least one scan filter is required.");

export interface CandleScanFilters {
  readonly pctChange?: { readonly window: number };
  readonly breakout?: { readonly lookback: number };
  readonly volumeSpike?: { readonly window: number; readonly factor: string };
  readonly smaCross?: { readonly fast: number; readonly slow: number };
  readonly emaCross?: { readonly fast: number; readonly slow: number };
  readonly rsi?: { readonly period: number };
  readonly rangeStats?: { readonly window: number };
}

export interface CandleScanResult {
  readonly candlesUsed: number;
  readonly skippedMalformed: number;
  readonly verdicts: Record<string, unknown>;
}

interface ValidCandle {
  readonly row: StoredHyperliquidCandle;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
}

/** Parse agent-provided nested filters at the handler boundary. */
export function parseCandleScanFilters(value: unknown): CandleScanFilters {
  const parsed = filterSchema.parse(value);
  const volumeSpike = parsed.volumeSpike === undefined ? undefined : {
    window: parsed.volumeSpike.window,
    factor: decimal(parsed.volumeSpike.factor, "Volume-spike factor").toFixed(),
  };
  if (volumeSpike !== undefined && new Decimal(volumeSpike.factor).lte(0)) {
    throw new Error("Volume-spike factor must be greater than zero.");
  }
  const crosses = [parsed.smaCross, parsed.emaCross];
  for (const cross of crosses) {
    if (cross !== undefined && cross.fast >= cross.slow) {
      throw new Error("Cross fast period must be smaller than slow period.");
    }
  }
  return {
    ...(parsed.pctChange === undefined ? {} : { pctChange: parsed.pctChange }),
    ...(parsed.breakout === undefined ? {} : { breakout: parsed.breakout }),
    ...(volumeSpike === undefined ? {} : { volumeSpike }),
    ...(parsed.smaCross === undefined ? {} : { smaCross: parsed.smaCross }),
    ...(parsed.emaCross === undefined ? {} : { emaCross: parsed.emaCross }),
    ...(parsed.rsi === undefined ? {} : { rsi: parsed.rsi }),
    ...(parsed.rangeStats === undefined ? {} : { rangeStats: parsed.rangeStats }),
  };
}

/** Pure candle evaluator shared by scanner handlers and future wake conditions. */
export function evaluateCandleScan(rows: readonly StoredHyperliquidCandle[], filters: CandleScanFilters): CandleScanResult {
  const valid: ValidCandle[] = [];
  let skippedMalformed = 0;
  for (const row of rows) {
    try { valid.push(validCandle(row)); } catch { skippedMalformed += 1; }
  }
  valid.sort((left, right) => left.row.openTimeMs - right.row.openTimeMs);
  const verdicts: Record<string, unknown> = {};
  if (filters.pctChange !== undefined) verdicts.pctChange = percentageChange(valid, filters.pctChange.window);
  if (filters.breakout !== undefined) verdicts.breakout = breakout(valid, filters.breakout.lookback);
  if (filters.volumeSpike !== undefined) verdicts.volumeSpike = volumeSpike(valid, filters.volumeSpike.window, filters.volumeSpike.factor);
  if (filters.smaCross !== undefined) verdicts.smaCross = movingAverageCross(valid, filters.smaCross.fast, filters.smaCross.slow, "sma");
  if (filters.emaCross !== undefined) verdicts.emaCross = movingAverageCross(valid, filters.emaCross.fast, filters.emaCross.slow, "ema");
  if (filters.rsi !== undefined) verdicts.rsi = rsi(valid, filters.rsi.period);
  if (filters.rangeStats !== undefined) verdicts.rangeStats = rangeStats(valid, filters.rangeStats.window);
  return { candlesUsed: valid.length, skippedMalformed, verdicts };
}

function validCandle(row: StoredHyperliquidCandle): ValidCandle {
  if (!Number.isSafeInteger(row.openTimeMs) || row.openTimeMs < 0) throw new Error("Invalid candle open time.");
  const open = decimal(row.open, "Candle open");
  const high = decimal(row.high, "Candle high");
  const low = decimal(row.low, "Candle low");
  const close = decimal(row.close, "Candle close");
  const volume = decimal(row.volume, "Candle volume");
  if (open.lte(0) || high.lte(0) || low.lte(0) || close.lte(0) || volume.lt(0) || high.lt(low) || high.lt(open) || high.lt(close) || low.gt(open) || low.gt(close)) {
    throw new Error("Malformed candle OHLCV values.");
  }
  return { row, open, high, low, close, volume };
}

function decimal(value: string | number, label: string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a finite decimal.`);
  }
}

function latest(rows: readonly ValidCandle[], needed: number): readonly ValidCandle[] | null {
  return rows.length < needed ? null : rows.slice(-needed);
}

function percentageChange(rows: readonly ValidCandle[], window: number): Record<string, unknown> | null {
  const selected = latest(rows, window);
  if (selected === null) return null;
  const first = selected[0]; const last = selected.at(-1);
  if (first === undefined || last === undefined || first.close.isZero()) return null;
  return { window, pct: last.close.minus(first.close).div(first.close).mul(100).toFixed() };
}

function breakout(rows: readonly ValidCandle[], lookback: number): Record<string, unknown> | null {
  if (rows.length < lookback + 1) return null;
  const current = rows.at(-1);
  if (current === undefined) return null;
  const previous = rows.slice(-(lookback + 1), -1);
  const high = Decimal.max(...previous.map((row) => row.high));
  const low = Decimal.min(...previous.map((row) => row.low));
  return { lookback, direction: current.close.gte(high) ? "above" : current.close.lte(low) ? "below" : "inside" };
}

function volumeSpike(rows: readonly ValidCandle[], window: number, factor: string): Record<string, unknown> | null {
  if (rows.length < window + 1) return null;
  const current = rows.at(-1);
  if (current === undefined) return null;
  const baseline = rows.slice(-(window + 1), -1);
  const mean = baseline.reduce((total, row) => total.plus(row.volume), new Decimal(0)).div(window);
  return { window, factor, spike: !mean.isZero() && current.volume.gte(mean.mul(factor)) };
}

function movingAverageCross(rows: readonly ValidCandle[], fast: number, slow: number, mode: "sma" | "ema"): Record<string, unknown> | null {
  if (rows.length < slow + 1) return null;
  const averages = mode === "sma" ? simpleAverages(rows, fast, slow) : exponentialAverages(rows, fast, slow);
  const previous = averages.at(-2); const current = averages.at(-1);
  if (previous === undefined || current === undefined) return null;
  const direction = previous.fast.lte(previous.slow) && current.fast.gt(current.slow)
    ? "bullish"
    : previous.fast.gte(previous.slow) && current.fast.lt(current.slow)
      ? "bearish"
      : "none";
  return { fast, slow, direction };
}

function simpleAverages(rows: readonly ValidCandle[], fast: number, slow: number): readonly { readonly fast: Decimal; readonly slow: Decimal }[] {
  const values: { fast: Decimal; slow: Decimal }[] = [];
  for (let index = slow - 1; index < rows.length; index += 1) {
    const slowRows = rows.slice(index - slow + 1, index + 1);
    const fastRows = rows.slice(index - fast + 1, index + 1);
    values.push({
      fast: fastRows.reduce((total, row) => total.plus(row.close), new Decimal(0)).div(fast),
      slow: slowRows.reduce((total, row) => total.plus(row.close), new Decimal(0)).div(slow),
    });
  }
  return values;
}

function exponentialAverages(rows: readonly ValidCandle[], fast: number, slow: number): readonly { readonly fast: Decimal; readonly slow: Decimal }[] {
  const fastAlpha = new Decimal(2).div(fast + 1); const slowAlpha = new Decimal(2).div(slow + 1);
  let fastValue = rows[0]?.close; let slowValue = rows[0]?.close;
  if (fastValue === undefined || slowValue === undefined) return [];
  const values: { fast: Decimal; slow: Decimal }[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const close = rows[index]?.close;
    if (close === undefined) continue;
    fastValue = close.mul(fastAlpha).plus(fastValue.mul(new Decimal(1).minus(fastAlpha)));
    slowValue = close.mul(slowAlpha).plus(slowValue.mul(new Decimal(1).minus(slowAlpha)));
    if (index >= slow - 1) values.push({ fast: fastValue, slow: slowValue });
  }
  return values;
}

function rsi(rows: readonly ValidCandle[], period: number): Record<string, unknown> | null {
  if (rows.length < period + 1) return null;
  const selected = rows.slice(-(period + 1));
  let gains = new Decimal(0); let losses = new Decimal(0);
  for (let index = 1; index < selected.length; index += 1) {
    const previous = selected[index - 1]; const current = selected[index];
    if (previous === undefined || current === undefined) continue;
    const change = current.close.minus(previous.close);
    if (change.gte(0)) gains = gains.plus(change); else losses = losses.plus(change.abs());
  }
  const value = losses.isZero() ? new Decimal(100) : new Decimal(100).minus(new Decimal(100).div(new Decimal(1).plus(gains.div(period).div(losses.div(period)))));
  return { period, value: value.toFixed(), zone: value.gte(70) ? "overbought" : value.lte(30) ? "oversold" : "neutral" };
}

function rangeStats(rows: readonly ValidCandle[], window: number): Record<string, unknown> | null {
  const selected = latest(rows, window);
  if (selected === null) return null;
  const high = Decimal.max(...selected.map((row) => row.high));
  const low = Decimal.min(...selected.map((row) => row.low));
  return { window, high: high.toFixed(), low: low.toFixed(), widthPct: high.minus(low).div(low).mul(100).toFixed() };
}
