/**
 * The ONE extra read a caller may spend when the representative pool list left
 * a token unpriced.
 *
 * `/tokens/v1/{chain}/{a,b,c}` answers roughly ONE pool per address, chosen by
 * the provider (see `price-read.ts`). The provider chooses it by its own
 * `liquidity.usd`, which is denominated in the quote asset's USD price - so
 * for a token whose deepest pool is quoted in an asset the provider itself
 * misprices, the representative pool is exactly the tier-2 pool the quote rule
 * refuses to price from. MEASURED 2026-08-26, both live:
 *
 *  - `tokens/v1/solana/JUP...` -> one JUP/MET pool (tier 2, $1136.11 fiction);
 *    `token-pairs/v1` for the same mint carries JUP/USDC at $0.2170 (tier 0).
 *  - `tokens/v1/robinhood/0x8Ff9...` (VEX) -> one VEX/VIRTUAL pool (tier 2);
 *    `token-pairs/v1` carries VEX/USDG at $0.002747 (tier 0).
 *
 * Without this second read both tokens would go from a wrong number to a null,
 * which is honest but worse than the right number that one request away.
 *
 * ## The bound, stated rather than hidden
 *
 * One request per still-unpriced address, issued SEQUENTIALLY (a wallet read
 * is not worth fanning out on a shared public budget), and never more than
 * {@link UNPRICED_POOL_FALLBACK_MAX_ADDRESSES} of them in one pass. A wallet
 * holding hundreds of tier-2-only dust tokens must not turn one valuation into
 * hundreds of requests. Addresses beyond the cap are REPORTED as `skipped` and
 * simply stay unpriced; nothing is silently dropped. Requests share the seam's
 * throttle, cache and in-flight dedupe like every other read here.
 *
 * Failures are fail-soft per address: a provider error leaves that address
 * unpriced and is counted, never thrown at the valuation.
 */

import type { BestLiquidityPriceAccumulator } from "./best-liquidity-price.js";
import { readTokenPools } from "./price-read.js";

/**
 * Requests one valuation pass may spend on this fallback.
 *
 * 12 covers every wallet shape measured so far (the probed Solana wallet had
 * 12 token accounts in total) while capping the worst case at 12 sequential
 * reads. Raising it costs provider budget linearly.
 */
export const UNPRICED_POOL_FALLBACK_MAX_ADDRESSES = 12;

export interface UnpricedPoolFallbackOptions {
  readonly accumulator: BestLiquidityPriceAccumulator;
  /** DexScreener chain slug, e.g. "solana", "robinhood", "base". */
  readonly chainSlug: string;
  /** Provider-form addresses to re-read. Already normalized keys are fine too. */
  readonly addresses: readonly string[];
}

/** What the pass actually spent, so the caller can log it truthfully. */
export interface UnpricedPoolFallbackOutcome {
  /** Addresses that were still unpriced when the pass began. */
  readonly unpricedBefore: number;
  /** Addresses actually re-read. */
  readonly attempted: number;
  /** Addresses left unread because the cap was reached. */
  readonly skipped: number;
  /** Re-reads the provider failed. Those addresses stay unpriced. */
  readonly failed: number;
}

/**
 * Re-read the FULL pool list for the accumulator's still-unpriced addresses and
 * fold it back in. The accumulator keeps its own selection, so a trusted pool
 * found here competes with (and, being deeper or the only one, usually beats)
 * whatever the first pass had.
 *
 * The caller supplies `addresses` in PROVIDER form (what goes in the URL); the
 * accumulator's `unpricedAddresses()` is in NORMALIZED form, so the two are
 * matched through the caller's own normalization by comparing the normalized
 * set. Never throws.
 */
export async function addPoolListsForUnpricedAddresses(
  options: UnpricedPoolFallbackOptions,
  normalizeAddress: (address: string) => string,
  onError: (address: string, error: unknown) => void,
): Promise<UnpricedPoolFallbackOutcome> {
  const stillUnpriced = new Set(options.accumulator.unpricedAddresses());
  const targets = options.addresses.filter((address) =>
    stillUnpriced.has(normalizeAddress(address)),
  );

  const attempted = targets.slice(0, UNPRICED_POOL_FALLBACK_MAX_ADDRESSES);
  let failed = 0;
  for (const address of attempted) {
    try {
      options.accumulator.addPairs(await readTokenPools(options.chainSlug, address));
    } catch (err) {
      failed += 1;
      onError(address, err);
    }
  }

  return {
    unpricedBefore: targets.length,
    attempted: attempted.length,
    skipped: targets.length - attempted.length,
    failed,
  };
}
