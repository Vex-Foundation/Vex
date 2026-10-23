/**
 * The closed-candle rule, applied once for every venue.
 *
 * A bar is used only when `closeTime <= cutoffMs`: the forming bar never moves
 * a number, whatever the provider says about it. DexScreener marks its newest
 * row partial for ANY non-empty answer (`src/tools/dexscreener/candles-read.ts`),
 * so this module reads the time, not that flag, as the board hydration does
 * (`src/vex-agent/tools/internal/board/hydrate.ts`).
 *
 * Everything this module changes is counted and reported, never hidden:
 * forming rows dropped, buckets the provider did not emit (never filled), and
 * bars whose high or low had to be widened to cover their own open and close
 * (DexScreener's USD columns disagree on the same bar, measured and documented
 * on the `dexscreener.candles` manifest).
 */

import type { AnalysisBar } from "./bars.js";

export interface ClosedBars {
  readonly bars: readonly AnalysisBar[];
  readonly droppedForming: number;
  readonly gaps: number;
  readonly normalized: number;
}

export function closedBars(
  input: readonly AnalysisBar[],
  cutoffMs: number,
  intervalMs: number,
): ClosedBars {
  // Oldest first, one bar per bucket (the later row of a duplicate wins: a
  // provider re-sends a bucket only to correct it).
  const byOpen = new Map<number, AnalysisBar>();
  for (const bar of input) byOpen.set(bar.openTime, bar);
  const ordered = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);

  let droppedForming = 0;
  let normalized = 0;
  const bars: AnalysisBar[] = [];
  for (const bar of ordered) {
    if (bar.closeTime > cutoffMs) {
      droppedForming += 1;
      continue;
    }
    const high = Math.max(bar.high, bar.open, bar.close, bar.low);
    const low = Math.min(bar.low, bar.open, bar.close, bar.high);
    if (high !== bar.high || low !== bar.low) {
      normalized += 1;
      bars.push({ ...bar, high, low });
    } else {
      bars.push(bar);
    }
  }

  const first = bars[0];
  const last = bars[bars.length - 1];
  const expected =
    first === undefined || last === undefined
      ? 0
      : Math.round((last.openTime - first.openTime) / intervalMs) + 1;
  return { bars, droppedForming, gaps: Math.max(0, expected - bars.length), normalized };
}
