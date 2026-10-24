/**
 * The bar and loader contract the analysis engine runs on.
 *
 * Times are epoch milliseconds. `closeTime` is EXCLUSIVE: a bar covers
 * `[openTime, closeTime)` and `closeTime = openTime + intervalMs`, so a bar
 * whose `closeTime` equals the cut-off has closed and one a millisecond later
 * has not.
 *
 * A loader adapts one venue's candle seam to this shape. It never applies the
 * closed-candle rule itself (`closed.ts` does, once, for every venue) and it
 * never fills a missing bucket.
 */

import type {
  AnalysisInterval,
  AnalysisRefusalReason,
} from "../../lib/market-analysis/result-schema.js";

export interface AnalysisBar {
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** Quote volume when the venue reports it; DexScreener's seam carries none. */
  readonly volume: number | null;
}

export interface CandleLoadRequest {
  readonly interval: AnalysisInterval;
  /** Bars to read, warm-up included. */
  readonly count: number;
  /** Read up to this time instead of now (the card re-drawing a past reply). */
  readonly untilMs: number | null;
}

export type LoadedCandles<M> =
  | {
      readonly ok: true;
      readonly market: M;
      /** Provider rows mapped to bars, oldest first, forming bar included. */
      readonly bars: readonly AnalysisBar[];
      /** When the provider answered: the closed-candle cut-off. */
      readonly fetchedAtMs: number;
      /** Rows the loader dropped for a missing or non-numeric price. */
      readonly unpriced: number;
      /** The provenance label the result carries as `source`. */
      readonly source: string;
    }
  | {
      readonly ok: false;
      readonly reason: AnalysisRefusalReason;
      /** A sentence for the model, or the failure the handler describes. */
      readonly detail: string | null;
      readonly cause?: unknown;
    };

export type LoadCandles<M> = (request: CandleLoadRequest) => Promise<LoadedCandles<M>>;
