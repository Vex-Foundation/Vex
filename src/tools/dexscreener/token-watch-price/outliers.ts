/**
 * Cross-pool outlier assessment over candidates ALREADY NORMALIZED to the
 * watched token.
 *
 * The protocol layer owns the agent-facing version of this rule
 * (`tools/protocols/dexscreener/pair-list/price-sanity.ts`), and it assesses the
 * provider's raw BASE-token `priceUsd` over its own row shape. That is the wrong
 * population for a watch: a quote-side pool must be normalized FIRST, otherwise
 * the median is computed over prices of different assets. This module is that
 * same fixed-order-of-magnitude rule restated over the normalized population,
 * and it lives in `src/tools` so the low-level client layer does not have to
 * import a `vex-agent` protocol module.
 *
 * The threshold is a FIXED order of magnitude, not a percentage of the sample:
 * a band that widened with the spread would be widest exactly when the data is
 * worst. Genuine pools of one token sit within a few percent of each other.
 */

import {
  compareBoundedDecimals,
  multiplyDecimalByInteger,
  type BoundedDecimal,
} from "./decimal.js";
import type { TokenWatchPriceCandidate } from "./normalize.js";

export const WATCH_PRICE_OUTLIER_RATIO = 10;

/**
 * Below this many priced pools there is no population to be an outlier FROM:
 * one pool cannot disagree with itself and two have no majority. Matching the
 * protocol assessor's own minimum keeps the two rules from disagreeing about
 * the same token.
 */
const MIN_POOLS_FOR_MEDIAN = 3;

export interface OutlierAssessment {
  /** The median candidate's own exact price, or `null` when there is no median. */
  readonly median: BoundedDecimal | null;
  /** Candidates an order of magnitude off the median. Never the whole set. */
  readonly outliers: ReadonlySet<TokenWatchPriceCandidate>;
}

/**
 * Flag, never drop. With fewer than {@link MIN_POOLS_FOR_MEDIAN} candidates the
 * assessment is EMPTY rather than hostile: a thin token with one honest pool
 * must still be watchable, and the caller is told the population size so it can
 * say so.
 */
export function assessNormalizedCandidates(
  candidates: readonly TokenWatchPriceCandidate[],
): OutlierAssessment {
  if (candidates.length < MIN_POOLS_FOR_MEDIAN) {
    return { median: null, outliers: new Set() };
  }

  const ordered = [...candidates].sort((a, b) =>
    compareBoundedDecimals(a.priceUsd, b.priceUsd));
  const median = ordered[Math.floor((ordered.length - 1) / 2)]?.priceUsd ?? null;
  if (median === null || median.units === 0n) {
    return { median: null, outliers: new Set() };
  }

  const outliers = new Set<TokenWatchPriceCandidate>();
  const upperBound = multiplyDecimalByInteger(median, WATCH_PRICE_OUTLIER_RATIO);
  for (const candidate of candidates) {
    const scaledCandidate = multiplyDecimalByInteger(candidate.priceUsd, WATCH_PRICE_OUTLIER_RATIO);
    const tooHigh = compareBoundedDecimals(candidate.priceUsd, upperBound) >= 0;
    const tooLow = compareBoundedDecimals(scaledCandidate, median) <= 0;
    if (tooHigh || tooLow) outliers.add(candidate);
  }
  return { median, outliers };
}
