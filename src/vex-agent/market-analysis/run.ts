/**
 * One technical analysis: the protocol tools' handlers and the analysis card's
 * re-read both call this, with the same loaders, so the chat and the card see
 * the same numbers for a market and interval.
 *
 * Bounded: at most `ANALYSIS_BARS_MAX` bars shown, read with
 * `max(bars + ANALYSIS_WARMUP_BARS, ANALYSIS_READ_MIN)` so EMA 200 is warm at
 * the default bar count. Fewer than `ANALYSIS_BARS_MIN` closed bars is a
 * refusal, never a thin answer.
 */

import {
  ANALYSIS_BARS_DEFAULT,
  ANALYSIS_BARS_MAX,
  ANALYSIS_BARS_MIN,
  ANALYSIS_INTERVAL_MS,
  ANALYSIS_READ_MIN,
  ANALYSIS_WARMUP_BARS,
  type AnalysisClosedCandles,
  type AnalysisInterval,
  type AnalysisRefusalReason,
} from "../../lib/market-analysis/result-schema.js";

import { analyze, type AnalysisBundle } from "./analyze.js";
import type { AnalysisBar, LoadCandles } from "./bars.js";
import { closedBars } from "./closed.js";

export interface TechnicalAnalysisInput {
  readonly interval: AnalysisInterval;
  /** Closed bars the price facts cover, `ANALYSIS_BARS_MIN..ANALYSIS_BARS_MAX`. */
  readonly bars?: number;
  /** Analyse up to this time instead of now. */
  readonly untilMs?: number | null;
}

export interface TechnicalAnalysisCore extends AnalysisBundle {
  readonly ok: true;
  readonly interval: AnalysisInterval;
  readonly asOf: string;
  readonly fetchedAt: string;
  readonly bars: number;
  readonly closedCandles: AnalysisClosedCandles;
  readonly source: string;
}

export type TechnicalAnalysisOutcome<M> =
  | {
      readonly ok: true;
      readonly market: M;
      readonly analysis: TechnicalAnalysisCore;
      /** Every closed bar read, oldest first: the card's chart, never the model's. */
      readonly closed: readonly AnalysisBar[];
    }
  | {
      readonly ok: false;
      readonly reason: AnalysisRefusalReason;
      readonly detail: string | null;
      readonly cause?: unknown;
    };

/** Bars a request reads, warm-up included. */
export function barsToRead(bars: number): number {
  return Math.max(bars + ANALYSIS_WARMUP_BARS, ANALYSIS_READ_MIN);
}

export function isAnalysisBarCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= ANALYSIS_BARS_MIN &&
    value <= ANALYSIS_BARS_MAX
  );
}

export async function runTechnicalAnalysis<M>(
  load: LoadCandles<M>,
  input: TechnicalAnalysisInput,
): Promise<TechnicalAnalysisOutcome<M>> {
  const shown = input.bars ?? ANALYSIS_BARS_DEFAULT;
  if (!isAnalysisBarCount(shown)) {
    throw new RangeError(`bars must be an integer from ${ANALYSIS_BARS_MIN} to ${ANALYSIS_BARS_MAX}`);
  }
  const untilMs = input.untilMs ?? null;
  const loaded = await load({ interval: input.interval, count: barsToRead(shown), untilMs });
  if (!loaded.ok) return loaded;
  if (loaded.bars.length === 0) {
    return { ok: false, reason: "no_candles", detail: null };
  }

  const intervalMs = ANALYSIS_INTERVAL_MS[input.interval];
  const cutoffMs = untilMs === null ? loaded.fetchedAtMs : Math.min(untilMs, loaded.fetchedAtMs);
  const closed = closedBars(loaded.bars, cutoffMs, intervalMs);
  if (closed.bars.length < ANALYSIS_BARS_MIN) {
    return {
      ok: false,
      reason: "not_enough_history",
      detail: `${closed.bars.length} closed ${input.interval} bars, at least ${ANALYSIS_BARS_MIN} needed`,
    };
  }

  const used = Math.min(shown, closed.bars.length);
  const newest = closed.bars[closed.bars.length - 1]!;
  const windowBuckets = closed.bars.length + closed.gaps;
  return {
    ok: true,
    market: loaded.market,
    closed: closed.bars,
    analysis: {
      ok: true,
      interval: input.interval,
      asOf: new Date(newest.closeTime).toISOString(),
      fetchedAt: new Date(loaded.fetchedAtMs).toISOString(),
      bars: used,
      ...analyze(closed.bars, used),
      closedCandles: {
        droppedForming: closed.droppedForming,
        gaps: closed.gaps,
        normalized: closed.normalized,
        unpriced: loaded.unpriced,
        sparse: closed.gaps > windowBuckets / 10,
      },
      source: loaded.source,
    },
  };
}
