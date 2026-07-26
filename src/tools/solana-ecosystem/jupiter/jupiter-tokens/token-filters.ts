/**
 * Vex-side threshold filters for Jupiter token rows.
 *
 * Jupiter's Tokens API V2 has no server-side numeric/verification filter on
 * any read endpoint (`/search`, `/tag`, `/{category}/{interval}`, `/recent`)
 * — confirmed against the live docs (recon-docs-tokens.md §7, re-verified
 * recon-synth-tokens.md §2.2). This module applies filters Vex controls to
 * the array already fetched from those endpoints, BEFORE the concise
 * projector runs (`projectors.ts`), so the agent gets a genuinely filtered
 * result instead of a coarse tag/category bucket.
 *
 * Reject out-of-range values (never clamp) per the owner's limits rule.
 */

import type { JupiterMintInformation } from "./types.js";

export interface JupiterTokenThresholdFilters {
  /** Keep only tokens with `organicScore >= minOrganicScore` (0-100 scale). */
  minOrganicScore?: number;
  /** Keep only tokens with `isVerified === true`. */
  verifiedOnly?: boolean;
  /** Keep only tokens with `liquidity >= minLiquidity` (USD). */
  minLiquidity?: number;
}

/**
 * Validate threshold filter values. Returns an agent-actionable error message
 * when a value is out of range, or `undefined` when every provided value is
 * valid. Absent (`undefined`) fields are not validated — they simply don't
 * filter.
 */
export function validateJupiterTokenThresholdFilters(
  filters: JupiterTokenThresholdFilters,
): string | undefined {
  const { minOrganicScore, minLiquidity } = filters;

  if (minOrganicScore != null && (!Number.isFinite(minOrganicScore) || minOrganicScore < 0 || minOrganicScore > 100)) {
    return `Invalid minOrganicScore: ${minOrganicScore}. minOrganicScore must be a number between 0 and 100.`;
  }

  if (minLiquidity != null && (!Number.isFinite(minLiquidity) || minLiquidity < 0)) {
    return `Invalid minLiquidity: ${minLiquidity}. minLiquidity must be a non-negative number.`;
  }

  return undefined;
}

/**
 * Keep only tokens that satisfy every requested threshold. A token missing
 * the field a threshold checks (e.g. no `organicScore`/`liquidity` reported)
 * fails that threshold — "at least N" can never be confirmed for an unknown
 * value, so it is excluded rather than assumed to pass.
 */
export function filterJupiterTokensByThreshold(
  tokens: readonly JupiterMintInformation[],
  filters: JupiterTokenThresholdFilters,
): JupiterMintInformation[] {
  const { minOrganicScore, verifiedOnly, minLiquidity } = filters;

  if (minOrganicScore == null && verifiedOnly == null && minLiquidity == null) {
    return tokens.slice();
  }

  return tokens.filter((token) => {
    if (minOrganicScore != null) {
      if (typeof token.organicScore !== "number" || token.organicScore < minOrganicScore) return false;
    }
    if (verifiedOnly === true && token.isVerified !== true) return false;
    if (minLiquidity != null) {
      if (typeof token.liquidity !== "number" || token.liquidity < minLiquidity) return false;
    }
    return true;
  });
}
