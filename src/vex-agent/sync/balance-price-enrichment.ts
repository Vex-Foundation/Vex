/**
 * Independent USD-price enrichment for Khalani balance rows.
 *
 * Khalani is authoritative for held quantities, not valuation. Its live
 * balance response may contain only `extensions.balance`, so missing prices
 * are filled from family-specific, address-bound feeds before projection:
 * DexScreener for EVM and Jupiter Price V3 for Solana. Existing valid Khalani
 * prices are preserved.
 */

import { fetchEvmTokenPricesByAddress } from "@tools/evm-chains/token-prices.js";
import { chainIdToSlug } from "@tools/kyberswap/chains.js";
import { getKyberWrappedNativeAddress } from "@tools/kyberswap/wrapped-native.js";
import { isKhalaniNativeAlias } from "@tools/khalani/native-token-identity.js";
import type { ChainFamily, KhalaniToken } from "@tools/khalani/types.js";
import { getJupiterPricesByMint } from "@tools/solana-ecosystem/jupiter/jupiter-prices/service.js";
import logger from "@utils/logger.js";

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const JUPITER_PRICE_BATCH = 50;

function existingUsdPrice(token: KhalaniToken): number | null {
  const raw = token.extensions?.price?.usd;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function withUsdPrice(token: KhalaniToken, priceUsd: number): KhalaniToken {
  return {
    ...token,
    extensions: {
      ...token.extensions,
      price: {
        ...token.extensions?.price,
        usd: String(priceUsd),
      },
    },
  };
}

interface EvmLookup {
  readonly tokenIndex: number;
  readonly address: string;
}

async function enrichEvmPrices(
  tokens: readonly KhalaniToken[],
): Promise<KhalaniToken[]> {
  const enriched = [...tokens];
  const lookupsBySlug = new Map<string, EvmLookup[]>();

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex]!;
    if (existingUsdPrice(token) !== null) continue;

    const slug = chainIdToSlug(token.chainId);
    if (slug === undefined) continue;

    let lookupAddress: string;
    if (isKhalaniNativeAlias(token.address)) {
      try {
        lookupAddress = getKyberWrappedNativeAddress(slug);
      } catch {
        continue;
      }
    } else {
      if (!EVM_ADDRESS_PATTERN.test(token.address)) continue;
      lookupAddress = token.address;
    }

    const existing = lookupsBySlug.get(slug) ?? [];
    existing.push({ tokenIndex, address: lookupAddress });
    lookupsBySlug.set(slug, existing);
  }

  for (const [chainSlug, lookups] of lookupsBySlug) {
    const prices = await fetchEvmTokenPricesByAddress({
      chainSlug,
      tokenAddresses: lookups.map((lookup) => lookup.address),
    });
    for (const lookup of lookups) {
      const price = prices.get(lookup.address.toLowerCase());
      if (price !== undefined) {
        enriched[lookup.tokenIndex] = withUsdPrice(
          enriched[lookup.tokenIndex]!,
          price,
        );
      }
    }
  }

  return enriched;
}

async function enrichSolanaPrices(
  tokens: readonly KhalaniToken[],
): Promise<KhalaniToken[]> {
  const enriched = [...tokens];
  const missing = tokens
    .map((token, tokenIndex) => ({ token, tokenIndex }))
    .filter(
      ({ token }) =>
        existingUsdPrice(token) === null &&
        SOLANA_ADDRESS_PATTERN.test(token.address),
    );

  for (let i = 0; i < missing.length; i += JUPITER_PRICE_BATCH) {
    const batch = missing.slice(i, i + JUPITER_PRICE_BATCH);
    try {
      const prices = await getJupiterPricesByMint(
        batch.map(({ token }) => token.address),
      );
      for (const { token, tokenIndex } of batch) {
        const price = prices[token.address]?.usdPrice;
        if (typeof price === "number" && Number.isFinite(price) && price > 0) {
          enriched[tokenIndex] = withUsdPrice(enriched[tokenIndex]!, price);
        }
      }
    } catch (error) {
      logger.debug("sync.balance.solana_price_batch_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return enriched;
}

/** Fill missing token prices without changing balance quantities or identity. */
export async function enrichKhalaniBalancePrices(
  family: ChainFamily,
  tokens: readonly KhalaniToken[],
): Promise<KhalaniToken[]> {
  if (tokens.length === 0 || tokens.every((token) => existingUsdPrice(token) !== null)) {
    return [...tokens];
  }
  return family === "eip155"
    ? enrichEvmPrices(tokens)
    : enrichSolanaPrices(tokens);
}
