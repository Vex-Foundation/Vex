/**
 * The cross-pool median/order-of-magnitude outlier rule, and the watch's
 * adapter onto it.
 *
 * OWNERSHIP. This module OWNS the rule. `assessMedianOutliers` is the generic
 * primitive: minimum population, median-as-ELEMENT, and a fixed ratio in both
 * directions. Two populations consume it and neither restates it:
 *
 *   - `assessNormalizedCandidates` (below) over watch candidates already
 *     normalized to the watched token, in exact decimal arithmetic;
 *   - `vex-agent/tools/protocols/dexscreener/pair-list/price-sanity.ts`, which
 *     first reuses the same watched-token normalization and then adapts the
 *     exact-decimal median, per-row verdicts, side, and price into pair rows.
 *
 * The rule lives here, in `src/tools`, so the low-level client layer does not
 * have to import a `vex-agent` protocol module: `vex-agent` may import
 * `src/tools`, never the reverse.
 *
 * WHY THE VALUE TYPE IS A PARAMETER. The two populations are not comparable in
 * the same arithmetic. The watch compares exact decimals because a money
 * threshold must not round, and the pair-list assessor now uses that same exact
 * arithmetic. The generic primitive remains parameterized for other populations.
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

export const MEDIAN_OUTLIER_RATIO = 10;

/**
 * Below this many priced pools there is no population to be an outlier FROM:
 * one pool cannot disagree with itself and two have no majority.
 */
export const MIN_POOLS_FOR_MEDIAN = 3;

/**
 * The value algebra for one population. Each predicate is asked about values the
 * caller extracted, never about the items themselves.
 */
export interface MedianOutlierRule<TValue> {
  /** Ascending order: negative, zero, positive, as an `Array#sort` comparator. */
  readonly compare: (left: TValue, right: TValue) => number;
  /** A median we are willing to divide by or compare against. */
  readonly isUsableMedian: (median: TValue) => boolean;
  /** An order of magnitude off the median, in either direction. */
  readonly isOutlierAgainstMedian: (value: TValue, median: TValue) => boolean;
}

/**
 * Why the assessment did or did not produce a median. The two empty cases are
 * kept apart because callers report them differently: a thin token is normal,
 * an unusable median means the population itself was not readable.
 */
export type MedianOutlierPopulation = "too_small" | "unusable_median" | "assessed";

export interface MedianOutlierAssessment<TItem, TValue> {
  readonly population: MedianOutlierPopulation;
  /** The median ELEMENT, so a caller can read its exact original value. */
  readonly medianItem: TItem | null;
  readonly medianValue: TValue | null;
  /** Items an order of magnitude off the median. Never the whole set. */
  readonly outliers: ReadonlySet<TItem>;
}

function emptyAssessment<TItem, TValue>(
  population: MedianOutlierPopulation,
): MedianOutlierAssessment<TItem, TValue> {
  return { population, medianItem: null, medianValue: null, outliers: new Set() };
}

/**
 * Flag, never drop. Below {@link MIN_POOLS_FOR_MEDIAN} items the assessment is
 * EMPTY rather than hostile: a thin token with one honest pool must still be
 * usable, and the caller is told the population size so it can say so.
 *
 * The median is chosen as an ELEMENT rather than averaged: averaging would
 * invent a value no source ever reported, which the exact-decimal rule forbids
 * for a money value the agent reads. For an even count this is the lower-middle
 * element.
 */
export function assessMedianOutliers<TItem, TValue>(
  items: readonly TItem[],
  valueOf: (item: TItem) => TValue,
  rule: MedianOutlierRule<TValue>,
): MedianOutlierAssessment<TItem, TValue> {
  if (items.length < MIN_POOLS_FOR_MEDIAN) return emptyAssessment("too_small");

  const ordered = [...items].sort((left, right) => rule.compare(valueOf(left), valueOf(right)));
  const medianItem = ordered[Math.floor((ordered.length - 1) / 2)] ?? null;
  if (medianItem === null) return emptyAssessment("unusable_median");

  const medianValue = valueOf(medianItem);
  if (!rule.isUsableMedian(medianValue)) return emptyAssessment("unusable_median");

  const outliers = new Set<TItem>();
  for (const item of items) {
    if (rule.isOutlierAgainstMedian(valueOf(item), medianValue)) outliers.add(item);
  }
  return { population: "assessed", medianItem, medianValue, outliers };
}

export interface OutlierAssessment {
  /** The median candidate's own exact price, or `null` when there is no median. */
  readonly median: BoundedDecimal | null;
  /** Candidates an order of magnitude off the median. Never the whole set. */
  readonly outliers: ReadonlySet<TokenWatchPriceCandidate>;
}

const normalizedCandidateRule: MedianOutlierRule<BoundedDecimal> = {
  compare: compareBoundedDecimals,
  isUsableMedian: (median) => median.units !== 0n,
  isOutlierAgainstMedian: (value, median) => {
    const tooHigh = compareBoundedDecimals(
      value,
      multiplyDecimalByInteger(median, MEDIAN_OUTLIER_RATIO),
    ) >= 0;
    const tooLow = compareBoundedDecimals(
      multiplyDecimalByInteger(value, MEDIAN_OUTLIER_RATIO),
      median,
    ) <= 0;
    return tooHigh || tooLow;
  },
};

/** The rule over candidates ALREADY NORMALIZED to the watched token. */
export function assessNormalizedCandidates(
  candidates: readonly TokenWatchPriceCandidate[],
): OutlierAssessment {
  const assessment = assessMedianOutliers(
    candidates,
    (candidate) => candidate.priceUsd,
    normalizedCandidateRule,
  );
  return { median: assessment.medianValue, outliers: assessment.outliers };
}
