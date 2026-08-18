/**
 * Address-bound EVM token pricing through DexScreener.
 *
 * Balance providers are not price providers: Khalani's live balance endpoint
 * currently returns quantities without USD prices. This module is therefore
 * shared by both Khalani-backed portfolio sync and direct-RPC local-chain
 * balance reads.
 *
 * A requested token can appear on either side of a pair. DexScreener reports
 * `priceUsd` for the base token; when the requested token is the quote token,
 * its USD price is `priceUsd / priceNative`. The deepest-liquidity candidate
 * wins. Identity is always `(chain slug, contract address)`, never symbol.
 */

import { getDexScreenerClient } from "../dexscreener/client.js";
import logger from "../../utils/logger.js";

/** DexScreener's tokens/v1 endpoint accepts at most 30 addresses per call. */
const DEXSCREENER_TOKENS_BATCH = 30;

export interface EvmTokenPriceRequest {
  readonly chainSlug: string;
  readonly tokenAddresses: readonly string[];
}

/**
 * Best-liquidity USD price per lowercase token address.
 *
 * Pricing is display/projection enrichment, so provider failures are fail-soft:
 * callers retain the balance with a null valuation and can mark the aggregate
 * as partial. Raw provider errors are never logged.
 */
export async function fetchEvmTokenPricesByAddress(
  request: EvmTokenPriceRequest,
): Promise<Map<string, number>> {
  const priceByLower = new Map<string, number>();
  if (request.tokenAddresses.length === 0) return priceByLower;

  const uniqueAddresses = [
    ...new Map(
      request.tokenAddresses.map((address) => [address.toLowerCase(), address]),
    ).values(),
  ];
  const wanted = new Set(uniqueAddresses.map((address) => address.toLowerCase()));
  const bestLiquidity = new Map<string, number>();

  const consider = (lower: string, price: number, liquidity: number): void => {
    if (!Number.isFinite(price) || price <= 0) return;
    if (
      !priceByLower.has(lower) ||
      liquidity > (bestLiquidity.get(lower) ?? -Infinity)
    ) {
      priceByLower.set(lower, price);
      bestLiquidity.set(lower, liquidity);
    }
  };

  const client = getDexScreenerClient();
  for (let i = 0; i < uniqueAddresses.length; i += DEXSCREENER_TOKENS_BATCH) {
    const batch = uniqueAddresses.slice(i, i + DEXSCREENER_TOKENS_BATCH);
    try {
      const pairs = await client.getTokens(request.chainSlug, batch.join(","));
      for (const pair of pairs) {
        if (pair.priceUsd == null) continue;
        const priceUsd = Number(pair.priceUsd);
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
        const liquidity = pair.liquidity?.usd ?? 0;

        const base = pair.baseToken?.address?.toLowerCase();
        if (base && wanted.has(base)) consider(base, priceUsd, liquidity);

        const quote = pair.quoteToken?.address?.toLowerCase();
        if (quote && wanted.has(quote)) {
          const priceNative = Number(pair.priceNative);
          if (Number.isFinite(priceNative) && priceNative > 0) {
            consider(quote, priceUsd / priceNative, liquidity);
          }
        }
      }
    } catch (error) {
      logger.debug("evm_chains.prices.batch_failed", {
        slug: request.chainSlug,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return priceByLower;
}
