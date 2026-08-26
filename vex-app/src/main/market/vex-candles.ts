/**
 * VEX sparkline candles - the trailing hourly closes under the price widget.
 *
 * S11b. REPLACES the GeckoTerminal OHLCV client. DexScreener's own chart
 * channel serves candles, so the widget no longer depends on a second provider
 * for a series it can read from the one it already trusts for the price.
 * Measured 2026-08-25 against both endpoints on this exact pool: 24 of 24
 * hourly buckets aligned on the same unix timestamps, closes agreeing to within
 * 2.1 percent, which is the ordinary difference between two providers'
 * last-trade-in-bucket rather than a units or orientation problem.
 *
 * This module owns only the VEX-specific part: the pool identity, the window
 * the widget draws, and the projection to the `[unixSeconds, closeUsd]` pairs
 * `vexMarketSnapshotSchema` accepts. The provider composition lives in the
 * shared `@tools/dexscreener/candles-read.js` seam.
 *
 * THE RESOLVED SUBJECT IS CACHED FOR THE PROCESS. `ammId` and the pool's own
 * quote token do not change for the life of a pool, and re-resolving them every
 * minute would double this poll's provider traffic for a constant. A failure
 * clears the cache so the next poll resolves again rather than retrying against
 * a half-state.
 */

import {
  readRecentCandles,
  type CandleSubject,
} from "@tools/dexscreener/candles-read.js";
import type { PairSubject } from "@tools/dexscreener/endpoints/pair-subject.js";
import { VEX_PAIR_SUBJECT } from "./dexscreener-pair.js";

/** Hourly buckets the sparkline draws. The GeckoTerminal feed asked for 24 too. */
const SPARKLINE_BARS = 24;

let cachedSubject: PairSubject | null = null;

/**
 * Fetch the trailing hourly closes as `[unixSeconds, closeUsd]`, oldest first.
 *
 * Throwing is the contract on failure: the poller keeps the last-good series,
 * does NOT mark the snapshot stale (staleness tracks price freshness only), and
 * the widget degrades to a priceless sparkline. A headless caller, whose
 * degraded transport cannot reach the site chart route, lands on that same path.
 *
 * A bucket whose USD close the provider did not report is DROPPED rather than
 * carried as a zero: a zero on a price series draws a crash that did not happen.
 */
export async function fetchVexSparkline(
  signal?: AbortSignal,
): Promise<Array<[number, number]>> {
  const subject: CandleSubject = VEX_PAIR_SUBJECT;
  let result;
  try {
    result = await readRecentCandles({
      subject,
      resolution: "1h",
      limit: SPARKLINE_BARS,
      ...(cachedSubject === null ? {} : { resolvedSubject: cachedSubject }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    cachedSubject = null;
    throw error;
  }
  cachedSubject = result.subject;

  const points: Array<[number, number]> = [];
  for (const candle of result.candles) {
    const close = candle.closeUsd === null ? Number.NaN : Number(candle.closeUsd);
    const seconds = Math.round(candle.timestampMs / 1000);
    if (Number.isFinite(close) && Number.isFinite(seconds)) {
      points.push([seconds, close]);
    }
  }
  points.sort((left, right) => left[0] - right[0]);
  return points;
}

/** Test seam: forget the resolved pool so the next call resolves again. */
export function resetVexPairSubjectCache(): void {
  cachedSubject = null;
}
