/**
 * Best-liquidity USD pricing over DexScreener pair rows - ONE owner for the
 * rule, two address policies.
 *
 * The rule was written for the local-EVM balance valuation
 * (`tools/evm-chains/balances.ts`) and is reused verbatim by the Solana
 * wallet read (`tools/solana-ecosystem/balances/read-wallet-balances.ts`).
 * It has two parts, and both matter on thin venues:
 *
 *  - A wanted token is priced from EITHER pair side. A `baseToken` match uses
 *    `priceUsd` directly; a `quoteToken` match derives USD-per-quote as
 *    `priceUsd / priceNative` (`priceNative` is the base price expressed in
 *    the quote token). On the live robinhood index the wrapped native appears
 *    ONLY as a quote token, so base-only matching left native ETH unpriced.
 *  - Across every pair fed in - including pairs from SEPARATE request batches,
 *    which is why this is an accumulator and not a per-call function - the
 *    deepest `liquidity.usd` wins, regardless of which side matched.
 *
 * ## Address identity is INJECTED, never assumed
 *
 * EVM addresses are case-insensitive, so the EVM caller normalizes to
 * lowercase and reads the map back by lowercase key. Solana mints are base58,
 * where case IS identity (`Es9v...` and `es9v...` are different strings, and
 * the `proj_balances` predicate compares `token_address` with no `LOWER()`),
 * so the Solana caller injects the identity function and DexScreener's echoed
 * `baseToken.address` is used verbatim. A single hardcoded `toLowerCase()`
 * here would silently corrupt every Solana mint key.
 */

import type { DexPair } from "./types.js";

export interface BestLiquidityPriceAccumulatorOptions {
  /** Token addresses to price, in the caller's own address form. */
  readonly wanted: Iterable<string>;
  /**
   * The caller's address-identity policy, applied to BOTH the wanted set and
   * every provider-echoed address before comparison. Lowercase for EVM,
   * identity for Solana base58.
   */
  readonly normalizeAddress: (address: string) => string;
}

export interface BestLiquidityPriceAccumulator {
  /** Fold one batch of provider pair rows into the running best-price map. */
  addPairs(pairs: readonly DexPair[]): void;
  /** Normalized address -> best-liquidity USD price. A fresh map per call. */
  toPriceMap(): Map<string, number>;
}

/**
 * Create an accumulator for one valuation pass. Stateful by design: a caller
 * that batches its addresses (DexScreener's `tokens/v1` caps at 30) must let
 * pairs from a later batch compete with an earlier batch's liquidity.
 */
export function createBestLiquidityPriceAccumulator(
  options: BestLiquidityPriceAccumulatorOptions,
): BestLiquidityPriceAccumulator {
  const { normalizeAddress } = options;
  const wanted = new Set<string>();
  for (const address of options.wanted) wanted.add(normalizeAddress(address));

  const priceByAddress = new Map<string, number>();
  const bestLiquidity = new Map<string, number>();

  const consider = (key: string, price: number, liquidity: number): void => {
    if (!Number.isFinite(price) || price < 0) return;
    if (!priceByAddress.has(key) || liquidity > (bestLiquidity.get(key) ?? -Infinity)) {
      priceByAddress.set(key, price);
      bestLiquidity.set(key, liquidity);
    }
  };

  return {
    addPairs(pairs: readonly DexPair[]): void {
      for (const pair of pairs) {
        if (pair.priceUsd == null) continue;
        const priceUsd = Number(pair.priceUsd);
        if (!Number.isFinite(priceUsd) || priceUsd < 0) continue;
        const liquidity = pair.liquidity?.usd ?? 0;

        const rawBase = pair.baseToken?.address;
        const base = rawBase == null ? undefined : normalizeAddress(rawBase);
        if (base !== undefined && wanted.has(base)) consider(base, priceUsd, liquidity);

        const rawQuote = pair.quoteToken?.address;
        const quote = rawQuote == null ? undefined : normalizeAddress(rawQuote);
        if (quote !== undefined && wanted.has(quote)) {
          const priceNative = Number(pair.priceNative);
          if (Number.isFinite(priceNative) && priceNative > 0) {
            consider(quote, priceUsd / priceNative, liquidity);
          }
        }
      }
    },
    toPriceMap(): Map<string, number> {
      return new Map(priceByAddress);
    },
  };
}
