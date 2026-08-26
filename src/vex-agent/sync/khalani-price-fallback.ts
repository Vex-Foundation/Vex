/**
 * DexScreener price fallback for Khalani balance rows that arrive WITHOUT a
 * price.
 *
 * ## Why this exists (measured, not anticipated)
 *
 * 2026-08-26 11:25Z: Khalani's balance scan stopped populating
 * `extensions.price.usd`. Base and Arbitrum rows for ETH and USDC came back
 * with `priceUsd` null, and the owner's portfolio dropped $23.71 for that
 * reason alone - the balances were right, only the prices were gone.
 *
 * ## Ownership, and what this must never do
 *
 * Khalani is the BALANCE source and remains the PREFERRED price source: a row
 * that already carries a Khalani price is returned untouched, byte for byte.
 * This module only fills a null. It never reads a balance, never adds or drops
 * a row, and never changes a chain id, an address or a raw amount.
 *
 * The price itself comes from the same quote-tiered rule every other Vex
 * pricing path uses (`tools/dexscreener/best-liquidity-price.ts`): only a pool
 * quoted in a stablecoin we recognise or in the chain's wrapped native, above
 * the shared liquidity floor, may price a token, and the deepest such pool
 * wins. A chain absent from `evm-chain-quote-policy.ts` gets NO
 * fallback and its rows stay unpriced, because guessing a slug would price a
 * token off another chain's identically-addressed contract.
 *
 * Native rows (`0xEeee…`, `0x0`, `native` - the closed alias set owned by
 * `tools/khalani/native-token-identity.ts`) have no pair of their own, so they
 * are looked up under the chain's WRAPPED native and take that chain's
 * `nativeUsd`.
 *
 * ## Bounds
 *
 * One batched `tokens/v1` read per chain per cycle, 30 addresses per request
 * (the provider's cap), issued sequentially. Fail-soft per chain: a provider
 * error leaves that chain's rows exactly as Khalani sent them. DECLARED
 * OMISSION: no per-token `token-pairs/v1` second pass here (the wallet reads in
 * the per-chain wallet readers do have one). A Khalani scan can span many
 * chains in one
 * cycle, and a per-token second read would multiply that cost; a token whose
 * representative pool is tier-2 stays unpriced and is counted.
 */

import {
  createBestLiquidityPriceAccumulator,
  summarizeUnpricedReasons,
  type PriceDecision,
} from "@tools/dexscreener/best-liquidity-price.js";
import { getEvmChainQuotePolicy } from "@tools/dexscreener/evm-chain-quote-policy.js";
import { readTokensPairs } from "@tools/dexscreener/price-read.js";
import { isKhalaniNativeAlias } from "@tools/khalani/native-token-identity.js";
import type { BalanceRow } from "@vex-agent/db/repos/balances.js";
import logger from "@utils/logger.js";

/** The provider's own cap for `tokens/v1`. */
const DEXSCREENER_TOKENS_BATCH = 30;

/**
 * USD value of a raw token amount at a USD price, or null when either is absent.
 *
 * MOVED VERBATIM from `balance-sync.ts`'s `mapTokenToBalance` so the fallback
 * and the Khalani-priced path compute `balanceUsd` the same way. The float math
 * is the pre-existing display boundary for this column and is deliberately
 * unchanged here: the raw amount stays a string, and only the USD DISPLAY value
 * is a float.
 *
 * `decimals` is nullable on a persisted `BalanceRow`. Without it a raw amount
 * has no human value at all, so the answer is null - never a raw integer
 * multiplied by a price.
 */
export function computeBalanceUsd(
  balanceRaw: string,
  decimals: number | null,
  priceUsd: number | null,
): number | null {
  if (priceUsd === null || decimals === null || balanceRaw === "0") return null;
  try {
    const balanceHuman = Number(BigInt(balanceRaw)) / Math.pow(10, decimals);
    return balanceHuman * priceUsd;
  } catch {
    // BigInt parse failure - no USD value, never a guessed one.
    return null;
  }
}

/** Per-chain census, logged so a portfolio number can be traced to its source. */
export interface KhalaniPriceFallbackCounts {
  readonly chainId: number;
  /** Rows Khalani itself priced. Never touched here. */
  readonly khalaniPriced: number;
  /** Rows this module priced from DexScreener. */
  readonly dexscreenerPriced: number;
  /** Rows still without a price after both. */
  readonly unpriced: number;
}

/**
 * Fill null prices in one chain's Khalani rows from DexScreener.
 *
 * Returns a NEW row array in the SAME order; rows that already had a price, and
 * rows the fallback could not price, are returned unchanged. Never throws.
 */
async function fillChainPrices(
  chainId: number,
  rows: readonly BalanceRow[],
): Promise<{ rows: BalanceRow[]; counts: KhalaniPriceFallbackCounts }> {
  const khalaniPriced = rows.filter((row) => row.priceUsd !== null).length;
  const chain = getEvmChainQuotePolicy(chainId);
  const needPricing = rows.filter((row) => row.priceUsd === null);

  if (chain === undefined || needPricing.length === 0) {
    return {
      rows: [...rows],
      counts: {
        chainId,
        khalaniPriced,
        dexscreenerPriced: 0,
        unpriced: needPricing.length,
      },
    };
  }

  // A native row has no pair of its own; it is priced as the wrapped native.
  const lookupFor = (row: BalanceRow): string =>
    isKhalaniNativeAlias(row.tokenAddress)
      ? chain.policy.wrappedNative
      : row.tokenAddress.toLowerCase();

  const wanted = [...new Set(needPricing.map(lookupFor))];
  const accumulator = createBestLiquidityPriceAccumulator({
    wanted,
    normalizeAddress: (address) => address.toLowerCase(),
    quotePolicy: chain.policy,
  });

  for (let i = 0; i < wanted.length; i += DEXSCREENER_TOKENS_BATCH) {
    const batch = wanted.slice(i, i + DEXSCREENER_TOKENS_BATCH);
    try {
      accumulator.addPairs(await readTokensPairs(chain.slug, batch.join(",")));
    } catch (err) {
      logger.debug("sync.balance.price_fallback_batch_failed", {
        chainId,
        slug: chain.slug,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  const prices = accumulator.toPriceMap();
  const decisions = accumulator.toDecisionMap();
  let dexscreenerPriced = 0;
  let unpriced = 0;

  const filled = rows.map((row) => {
    if (row.priceUsd !== null) return row;
    const lookup = lookupFor(row);
    const priceUsd = prices.get(lookup);
    if (priceUsd === undefined) {
      unpriced += 1;
      return row;
    }
    dexscreenerPriced += 1;
    logFilledRow(chainId, row, priceUsd, decisions.get(lookup));
    return {
      ...row,
      priceUsd,
      balanceUsd: computeBalanceUsd(row.balanceRaw, row.decimals, priceUsd),
    };
  });

  if (unpriced > 0) {
    logger.debug("sync.balance.price_fallback_unpriced_reasons", {
      chainId,
      slug: chain.slug,
      ...summarizeUnpricedReasons(accumulator),
    });
  }

  return {
    rows: filled,
    counts: { chainId, khalaniPriced, dexscreenerPriced, unpriced },
  };
}

/** One line per filled row saying WHICH pool and WHICH tier produced the price. */
function logFilledRow(
  chainId: number,
  row: BalanceRow,
  priceUsd: number,
  decision: PriceDecision | undefined,
): void {
  logger.debug("sync.balance.price_fallback_row", {
    chainId,
    token: row.tokenSymbol,
    tokenAddress: row.tokenAddress,
    priceUsd,
    tier: decision?.tier ?? null,
    basis: decision?.basis ?? null,
    pairAddress: decision?.pairAddress ?? null,
    quoteSymbol: decision?.quoteSymbol ?? null,
    liquidityUsd: decision?.liquidityUsd ?? null,
  });
}

/**
 * Fill null prices across every chain of one Khalani scan, in place on the
 * grouping map the caller is about to write.
 *
 * Chains are processed SEQUENTIALLY: one wallet's sync is not worth fanning out
 * on a shared provider budget. Never throws - a chain that cannot be priced
 * keeps exactly the rows Khalani produced.
 */
export async function fillMissingKhalaniPrices(
  rowsByChain: Map<number, BalanceRow[]>,
): Promise<void> {
  for (const [chainId, rows] of rowsByChain) {
    const filled = await fillChainPrices(chainId, rows);
    if (filled.counts.dexscreenerPriced > 0 || filled.counts.unpriced > 0) {
      logger.info("sync.balance.price_fallback", filled.counts);
    }
    if (filled.counts.dexscreenerPriced > 0) rowsByChain.set(chainId, filled.rows);
  }
}
