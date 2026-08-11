/**
 * The GENERIC median/order-of-magnitude outlier primitive.
 *
 * The rule used to exist twice: once over the provider's raw base-token prices
 * (`vex-agent/tools/protocols/dexscreener/pair-list/price-sanity.ts`) and once
 * over normalized watch candidates (`tools/dexscreener/token-watch-price`).
 * These tests pin the primitive both sides now consume: the minimum population,
 * the median-as-ELEMENT choice, and the fixed ratio in both directions.
 */

import { describe, it, expect } from "vitest";

import {
  MEDIAN_OUTLIER_RATIO,
  MIN_POOLS_FOR_MEDIAN,
  assessMedianOutliers,
  type MedianOutlierRule,
} from "../../tools/dexscreener/token-watch-price/outliers.js";

interface NumericSample {
  readonly label: string;
  readonly value: number;
}

const numericRule: MedianOutlierRule<number> = {
  compare: (left, right) => (left === right ? 0 : left < right ? -1 : 1),
  isUsableMedian: (value) => value > 0,
  isOutlierAgainstMedian: (value, median) => {
    const ratio = value / median;
    return ratio >= MEDIAN_OUTLIER_RATIO || ratio <= 1 / MEDIAN_OUTLIER_RATIO;
  },
};

function sample(label: string, value: number): NumericSample {
  return { label, value };
}

function assess(items: readonly NumericSample[]) {
  return assessMedianOutliers(items, (item) => item.value, numericRule);
}

describe("assessMedianOutliers", () => {
  it("refuses to judge a population below the minimum", () => {
    const items = [sample("a", 1), sample("b", 1000)];
    expect(items.length).toBeLessThan(MIN_POOLS_FOR_MEDIAN);

    const assessment = assess(items);

    expect(assessment.population).toBe("too_small");
    expect(assessment.medianItem).toBeNull();
    expect(assessment.medianValue).toBeNull();
    expect(assessment.outliers.size).toBe(0);
  });

  it("picks the median as an ELEMENT, lower-middle on an even population", () => {
    const assessment = assess([
      sample("d", 4),
      sample("b", 2),
      sample("a", 1),
      sample("c", 3),
    ]);

    expect(assessment.population).toBe("assessed");
    expect(assessment.medianItem?.label).toBe("b");
    expect(assessment.medianValue).toBe(2);
  });

  it("flags an order of magnitude in EITHER direction and nothing inside it", () => {
    const assessment = assess([
      sample("low", 0.1),
      sample("under", 0.11),
      sample("median", 1),
      sample("over", 9.9),
      sample("high", 10),
    ]);

    expect(assessment.medianValue).toBe(1);
    const flagged = [...assessment.outliers].map((item) => item.label).sort();
    expect(flagged).toEqual(["high", "low"]);
  });

  it("reports an unusable median instead of dividing by it", () => {
    const assessment = assess([sample("a", 0), sample("b", 0), sample("c", 5)]);

    expect(assessment.population).toBe("unusable_median");
    expect(assessment.medianValue).toBeNull();
    expect(assessment.outliers.size).toBe(0);
  });

  it("never flags the whole set: the median itself is always inside the band", () => {
    const assessment = assess([sample("a", 1), sample("b", 1), sample("c", 1)]);

    expect(assessment.outliers.size).toBe(0);
  });
});
