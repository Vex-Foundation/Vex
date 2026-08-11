/**
 * `selectTokenWatchPrice` - the ONE canonical USD price of a watched token,
 * derived from the full pool list `/token-pairs/v1` returns for it.
 *
 * WHY ONE HELPER. The `token_price` wake watch decides the SAME question twice:
 * once at validation (is the threshold already crossed, so the model should act
 * now instead of sleeping) and once per poll tick (has it just crossed). If the
 * two used different rules they could disagree, and the disagreement would show
 * up as a watch that fires forever or never. They call this function.
 *
 * THE RULE, in order:
 *   1. keep only pools on the requested chain that actually hold the token;
 *   2. normalize EVERY pool to the watched token (`normalize.ts`) - a quote-side
 *      pool prices someone else until it is;
 *   3. assess outliers over those NORMALIZED prices (`outliers.ts`);
 *   4. take the deepest-liquidity candidate that is not an outlier.
 *
 * Step 4 is where the incident lives: `liquidity.usd` is DERIVED from
 * `priceUsd`, so a mispriced pool wins a naive depth tiebreak with a fabricated
 * number. Sorting by depth without step 3 would hand the watch the one pool that
 * lies.
 *
 * `null` means "this token has no price we are willing to act on right now" -
 * no pool, no priced pool, or every priced pool flagged. Callers treat it as
 * "skip", never as "the price is zero".
 */

import type { DexPair } from "./types.js";
import { formatBoundedDecimal, type BoundedDecimal } from "./token-watch-price/decimal.js";
import {
  normalizePoolToWatchedToken,
  type TokenWatchPoolSide,
  type TokenWatchPriceCandidate,
} from "./token-watch-price/normalize.js";
import { assessNormalizedCandidates } from "./token-watch-price/outliers.js";

export {
  compareBoundedDecimals,
  formatBoundedDecimal,
  isPositiveDecimal,
  parseBoundedDecimal,
  type BoundedDecimal,
} from "./token-watch-price/decimal.js";
export { WATCH_PRICE_OUTLIER_RATIO } from "./token-watch-price/outliers.js";
export type { TokenWatchPoolSide, TokenWatchPriceCandidate } from "./token-watch-price/normalize.js";

export interface TokenWatchPriceQuery {
  /** DexScreener chain slug the pools were requested for. */
  readonly chainSlug: string;
  /** The watched token's address. */
  readonly tokenAddress: string;
  /**
   * Compare the address EXACTLY instead of case-insensitively.
   *
   * Defaults to `false`, which is the EVM rule and what every existing caller
   * gets. Base58 chains must pass `true`: an EVM address's mixed case is a
   * checksum, but a base58 mint's case IS its identity, so folding it could
   * match a different asset. The FAMILY is the caller's knowledge, so the
   * decision is the caller's rather than a slug test hidden in here.
   */
  readonly caseSensitiveAddress?: boolean;
}

export interface TokenWatchPriceSelection {
  /** Exact decimal string, plain notation - the value agents and banners read. */
  readonly priceUsd: string;
  /** Same value, for comparison against a threshold without re-parsing. */
  readonly price: BoundedDecimal;
  readonly pairAddress: string;
  readonly dexId: string;
  readonly side: TokenWatchPoolSide;
  readonly liquidityUsd: number;
  /** Pools the provider returned for this token on this chain. */
  readonly poolCount: number;
  /** Pools that produced a usable normalized price. */
  readonly candidateCount: number;
  /** Candidates flagged an order of magnitude off the median. */
  readonly outlierCount: number;
}

export function selectTokenWatchPrice(
  pairs: readonly DexPair[],
  query: TokenWatchPriceQuery,
): TokenWatchPriceSelection | null {
  const wanted = query.tokenAddress.trim();
  const wantedLower = wanted.toLowerCase();
  const matchesWatchedToken = query.caseSensitiveAddress === true
    ? (candidate: string | null | undefined): boolean => candidate === wanted
    : (candidate: string | null | undefined): boolean => candidate?.toLowerCase() === wantedLower;
  const chainSlugLower = query.chainSlug.trim().toLowerCase();

  const onChain = pairs.filter(
    (pair) => typeof pair.chainId === "string" && pair.chainId.toLowerCase() === chainSlugLower,
  );

  const candidates: TokenWatchPriceCandidate[] = [];
  for (const pair of onChain) {
    const candidate = normalizePoolToWatchedToken(pair, matchesWatchedToken);
    if (candidate !== null) candidates.push(candidate);
  }
  if (candidates.length === 0) return null;

  const { outliers } = assessNormalizedCandidates(candidates);
  const usable = candidates.filter((candidate) => !outliers.has(candidate));
  if (usable.length === 0) return null;

  const chosen = usable.reduce((best, candidate) =>
    candidate.liquidityUsd > best.liquidityUsd ? candidate : best);

  return {
    priceUsd: formatBoundedDecimal(chosen.priceUsd),
    price: chosen.priceUsd,
    pairAddress: chosen.pairAddress,
    dexId: chosen.dexId,
    side: chosen.side,
    liquidityUsd: chosen.liquidityUsd,
    poolCount: onChain.length,
    candidateCount: candidates.length,
    outlierCount: outliers.size,
  };
}
