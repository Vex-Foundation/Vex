/**
 * Cross-pool price sanity for one token's pools.
 *
 * WHY THIS EXISTS
 *
 * `dexscreener.tokenPairs` sorts a token's pools by `liquidity.usd` descending
 * and its manifest calls itself the resolver for "which pool should I trade".
 * Measured 2026-07-26 on BONK, and independently ~24 h earlier: rank 1 was a
 * Meteora pool priced **4,892× the median** of the token's other 29 pools,
 * carrying a `marketCap` of $1.33 trillion — while DexScreener's own
 * `/tokens/v1` returned the correct price for the same mint in the same minute.
 * Re-measured 2026-07-27 the worst outlier on the same mint was 13.8×, so the
 * magnitude moves; the mechanism does not.
 *
 * `liquidity.usd`, `fdv` and `marketCap` are all derived from `priceUsd`, so a
 * mispriced pool wins the depth tiebreak with a fabricated number and drags
 * three other fabricated numbers along with it. Per `rules/90-vex-project.md`, a
 * provider's number is a hint: we compute our own reference and flag deviation.
 *
 * FLAG, NEVER DROP. Suppressing an outlier row would be truncation of
 * agent-facing output. The agent gets every pool, the median, and a per-row
 * verdict, and decides.
 */

import type { PairRow } from "./pair-metrics.js";

/**
 * Deviation at which a pool's price stops being a rounding difference and starts
 * being a different claim about the asset.
 *
 * A FIXED order of magnitude, not a percentage of anything and not adaptive to
 * the sample: a band that widens with the spread would be widest exactly when
 * the data is worst. Genuine pools of one token sit within a few percent of each
 * other; nothing legitimate is 10× off its siblings.
 */
export const PRICE_OUTLIER_RATIO = 10;

export type PriceSanityVerdict =
  /** Within the band of the median across this token's returned pools. */
  | "ok"
  /** Beyond {@link PRICE_OUTLIER_RATIO} from that median, in either direction. */
  | "outlier_vs_pool_median"
  /** No usable `priceUsd` on this row, or no median to compare against. */
  | "unknown";

export interface PricePoolOutlier {
  pairAddress: string | null;
  dexId: string;
  /** The pool's own exact-decimal price string, unmodified. */
  priceUsd: string | null;
  /** This pool's price ÷ the median across the token's returned pools. */
  priceToMedianRatio: number;
  note: string;
}

export interface CrossPoolPriceSanity {
  /**
   * The median pool's own `priceUsd` STRING, chosen as an element rather than
   * averaged: averaging would introduce a float we would then have to render,
   * and the exact-decimal rule says the money value the agent reads must be one
   * the provider actually sent. For an even number of pools this is the
   * lower-middle element.
   */
  priceUsdMedianAcrossPools: string | null;
  pricePoolOutliers: PricePoolOutlier[];
  /** Per-row verdict, keyed by pair address. */
  verdictByPairAddress: ReadonlyMap<string, PriceSanityVerdict>;
}

function outlierNote(ratio: number): string {
  const direction = ratio >= 1 ? `${ratio.toFixed(1)}x the` : `${(1 / ratio).toFixed(1)}x below the`;
  return (
    `This pool's priceUsd is ${direction} median priceUsd across this token's returned pools. `
    + "Its liquidityUsd, fdvUsd and marketCapUsd are all derived from that price and are not "
    + "credible. Confirm against a router quote before trading it."
  );
}

/**
 * Assess every pool the provider returned for one token.
 *
 * Runs over the FULL provider window, before any Vex filter: a median computed
 * over a filtered subset would move with the caller's filters and stop being a
 * property of the token.
 */
export function assessCrossPoolPrices(rows: readonly PairRow[]): CrossPoolPriceSanity {
  const priced = rows.filter((row) => row.metrics.priceUsdNumeric !== null);
  const verdictByPairAddress = new Map<string, PriceSanityVerdict>();

  // One pool cannot disagree with itself, and two have no majority — a median
  // is only evidence once there is a population to be an outlier from.
  if (priced.length < 3) {
    for (const row of rows) {
      if (typeof row.pair.pairAddress === "string") {
        verdictByPairAddress.set(row.pair.pairAddress, "unknown");
      }
    }
    return {
      priceUsdMedianAcrossPools: null,
      pricePoolOutliers: [],
      verdictByPairAddress,
    };
  }

  const ordered = [...priced].sort((a, b) => {
    const left = a.metrics.priceUsdNumeric ?? 0;
    const right = b.metrics.priceUsdNumeric ?? 0;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
  const medianRow = ordered[Math.floor((ordered.length - 1) / 2)];
  const medianPrice = medianRow?.metrics.priceUsdNumeric ?? null;
  const medianString = typeof medianRow?.pair.priceUsd === "string" ? medianRow.pair.priceUsd : null;

  if (medianPrice === null || medianPrice <= 0) {
    return { priceUsdMedianAcrossPools: null, pricePoolOutliers: [], verdictByPairAddress };
  }

  const pricePoolOutliers: PricePoolOutlier[] = [];
  for (const row of rows) {
    const price = row.metrics.priceUsdNumeric;
    const pairAddress = typeof row.pair.pairAddress === "string" ? row.pair.pairAddress : null;
    if (price === null) {
      if (pairAddress !== null) verdictByPairAddress.set(pairAddress, "unknown");
      continue;
    }
    const ratio = price / medianPrice;
    const isOutlier = ratio >= PRICE_OUTLIER_RATIO || ratio <= 1 / PRICE_OUTLIER_RATIO;
    if (pairAddress !== null) {
      verdictByPairAddress.set(pairAddress, isOutlier ? "outlier_vs_pool_median" : "ok");
    }
    if (isOutlier) {
      pricePoolOutliers.push({
        pairAddress,
        dexId: typeof row.pair.dexId === "string" ? row.pair.dexId : "",
        priceUsd: typeof row.pair.priceUsd === "string" ? row.pair.priceUsd : null,
        priceToMedianRatio: ratio,
        note: outlierNote(ratio),
      });
    }
  }

  return {
    priceUsdMedianAcrossPools: medianString,
    pricePoolOutliers,
    verdictByPairAddress,
  };
}
