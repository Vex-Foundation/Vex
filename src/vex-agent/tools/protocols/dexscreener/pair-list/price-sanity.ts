/**
 * Cross-pool price sanity for the token requested from `tokenPairs`.
 *
 * DexScreener's `priceUsd` always prices the BASE token. The requested token
 * can be on either side of a returned pool, so quote-side pools must first be
 * normalized with `priceUsd / priceNative`. The token-price watch owns that
 * exact-decimal normalization and the shared median/outlier rule; this module
 * only adapts those results to agent pair rows.
 */

import { formatBoundedDecimal } from "@tools/dexscreener/token-watch-price/decimal.js";
import {
  normalizePoolToWatchedToken,
  watchedTokenPoolSide,
  type TokenWatchPoolSide,
  type TokenWatchPriceCandidate,
} from "@tools/dexscreener/token-watch-price/normalize.js";
import {
  MEDIAN_OUTLIER_RATIO,
  assessNormalizedCandidates,
} from "@tools/dexscreener/token-watch-price/outliers.js";

import type { PairRow } from "./pair-metrics.js";

export const PRICE_OUTLIER_RATIO = MEDIAN_OUTLIER_RATIO;

export type PriceSanityVerdict =
  | "ok"
  | "outlier_vs_pool_median"
  | "unknown";

export type RequestedTokenSide = TokenWatchPoolSide | "unknown";

export interface PricePoolOutlier {
  pairAddress: string | null;
  dexId: string;
  /** Exact USD price of the REQUESTED token, normalized for either pool side. */
  requestedTokenPriceUsd: string;
  requestedTokenSide: TokenWatchPoolSide;
  /** This requested-token price divided by the normalized pool median. */
  priceToMedianRatio: number;
  note: string;
}

export interface CrossPoolPriceSanity {
  /** Median exact USD price of the requested token across readable pools. */
  priceUsdMedianAcrossPools: string | null;
  pricePoolOutliers: PricePoolOutlier[];
  verdictByRow: ReadonlyMap<PairRow, PriceSanityVerdict>;
  requestedTokenSideByRow: ReadonlyMap<PairRow, RequestedTokenSide>;
  requestedTokenPriceUsdByRow: ReadonlyMap<PairRow, string | null>;
}

export interface CrossPoolPriceOptions {
  readonly tokenAddress: string;
  /** Solana/base58 identities are case-sensitive; EVM identities are not. */
  readonly caseSensitiveAddress: boolean;
}

interface NormalizedPool {
  readonly row: PairRow;
  readonly candidate: TokenWatchPriceCandidate;
}

function addressMatcher(
  tokenAddress: string,
  caseSensitive: boolean,
): (candidate: string | null | undefined) => boolean {
  const expected = caseSensitive ? tokenAddress : tokenAddress.toLowerCase();
  return (candidate) =>
    typeof candidate === "string"
    && (caseSensitive ? candidate : candidate.toLowerCase()) === expected;
}

function outlierNote(ratio: number): string {
  const direction = ratio >= 1
    ? `${ratio.toFixed(1)}x the`
    : `${(1 / ratio).toFixed(1)}x below the`;
  return (
    `This pool's normalized requested-token price is ${direction} median across the returned pools. `
    + "Its liquidityUsd, fdvUsd and marketCapUsd may inherit the bad pool price. "
    + "Confirm against a fresh executable venue quote before trading."
  );
}

function unknownAssessment(
  rows: readonly PairRow[],
  sideByRow: ReadonlyMap<PairRow, RequestedTokenSide>,
): CrossPoolPriceSanity {
  return {
    priceUsdMedianAcrossPools: null,
    pricePoolOutliers: [],
    verdictByRow: new Map(rows.map((row) => [row, "unknown"] as const)),
    requestedTokenSideByRow: sideByRow,
    requestedTokenPriceUsdByRow: new Map(rows.map((row) => [row, null] as const)),
  };
}

/** Assess the full provider window before caller filters or pagination. */
export function assessCrossPoolPrices(
  rows: readonly PairRow[],
  options: CrossPoolPriceOptions,
): CrossPoolPriceSanity {
  const matches = addressMatcher(options.tokenAddress, options.caseSensitiveAddress);
  const normalized: NormalizedPool[] = [];
  const detectedSideByRow = new Map<PairRow, RequestedTokenSide>();

  for (const row of rows) {
    detectedSideByRow.set(row, watchedTokenPoolSide(row.pair, matches) ?? "unknown");
    const candidate = normalizePoolToWatchedToken(row.pair, matches);
    if (candidate !== null) normalized.push({ row, candidate });
  }

  const candidates = normalized.map(({ candidate }) => candidate);
  const assessment = assessNormalizedCandidates(candidates);
  const medianString = assessment.median === null
    ? null
    : formatBoundedDecimal(assessment.median);

  if (medianString === null) {
    const result = unknownAssessment(rows, detectedSideByRow);
    const sideByRow = new Map(detectedSideByRow);
    const priceByRow = new Map(result.requestedTokenPriceUsdByRow);
    for (const { row, candidate } of normalized) {
      sideByRow.set(row, candidate.side);
      priceByRow.set(row, formatBoundedDecimal(candidate.priceUsd));
    }
    return {
      ...result,
      requestedTokenSideByRow: sideByRow,
      requestedTokenPriceUsdByRow: priceByRow,
    };
  }

  const medianNumber = Number(medianString);
  const verdictByRow = new Map<PairRow, PriceSanityVerdict>();
  const requestedTokenSideByRow = new Map<PairRow, RequestedTokenSide>(detectedSideByRow);
  const requestedTokenPriceUsdByRow = new Map<PairRow, string | null>();
  const normalizedByRow = new Map(normalized.map((pool) => [pool.row, pool.candidate] as const));
  const pricePoolOutliers: PricePoolOutlier[] = [];

  for (const row of rows) {
    const candidate = normalizedByRow.get(row);
    if (candidate === undefined) {
      verdictByRow.set(row, "unknown");
      requestedTokenPriceUsdByRow.set(row, null);
      continue;
    }

    const priceString = formatBoundedDecimal(candidate.priceUsd);
    const ratio = Number(priceString) / medianNumber;
    const isOutlier = assessment.outliers.has(candidate);
    verdictByRow.set(row, isOutlier ? "outlier_vs_pool_median" : "ok");
    requestedTokenSideByRow.set(row, candidate.side);
    requestedTokenPriceUsdByRow.set(row, priceString);

    if (isOutlier) {
      pricePoolOutliers.push({
        pairAddress: typeof row.pair.pairAddress === "string" ? row.pair.pairAddress : null,
        dexId: candidate.dexId,
        requestedTokenPriceUsd: priceString,
        requestedTokenSide: candidate.side,
        priceToMedianRatio: ratio,
        note: outlierNote(ratio),
      });
    }
  }

  return {
    priceUsdMedianAcrossPools: medianString,
    pricePoolOutliers,
    verdictByRow,
    requestedTokenSideByRow,
    requestedTokenPriceUsdByRow,
  };
}
