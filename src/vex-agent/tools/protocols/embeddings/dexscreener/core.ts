/**
 * Retrieval metadata for DexScreener core tools.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `dexscreener/manifests/core.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { DEXSCREENER_CHAINS } from "../../dexscreener/discovery-text.js";

export const DEXSCREENER_CORE_DISCOVERY = {
  "dexscreener.search": {
    embeddingText: embeddingText(
      `Search trading pairs and tokens by name, symbol, or contract address across every chain — Ethereum, Solana, BNB, Base, Arbitrum, Polygon, Avalanche, Robinhood and others. ` +
      `Use this when the user names a coin or pair (PEPE, BONK, a new memecoin) and wants to find it without knowing the chain, or wants to compare pairs across chains. ` +
      `Optional filters narrow by chains (chainIds), minimum liquidity, and result count; results come back in provider order, not ranked by liquidity. Follow with dexscreener.tokenPairs to pick the deepest pool. ` +
      `Example queries: find pepe pair, search bonk, lookup this contract, where is shib trading on base, find a token on robinhood, search dex pairs.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.pairs": {
    embeddingText: embeddingText(
      `Full analytics for one specific DEX trading pair by pool address — price, volume, liquidity, buys and sells, transactions, FDV, market cap, pair age, boosts. ` +
      `Use this when the user has a specific pool address and wants the deep stats, market metrics, or recent activity on that single pair. ` +
      `Example queries: pair details for this pool, give me stats for this pair on base, volume and liquidity for this dex pair, full analytics for this pool, single pool stats.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.tokens": {
    embeddingText: embeddingText(
      `Get DEX market data for up to 30 token contract addresses at once on a chain — prices, pairs, liquidity, volume, market cap. ` +
      `Use this when the user has a portfolio of tokens and wants batch pricing, monitoring multiple coins at once, or comparing several tokens on one chain. ` +
      `Example queries: batch lookup these tokens, prices for my portfolio coins, market data for these contracts, compare these tokens on base, batch token stats.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.tokenPairs": {
    embeddingText: embeddingText(
      `Find every pool and trading pair for a single token across all DEXes on a chain. ` +
      `Use this when the user wants to compare where a token has the most liquidity, find the best pool to trade in, see all markets for a coin, or pick which DEX has the deepest liquidity for a token. ` +
      `Example queries: find best pool for pepe on solana, where is most liquidity for this coin, all pools for usdc on base, compare dexes for this token, deepest pool for sol/usdc, best market for this memecoin.`,
    ),
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 4;
if (Object.keys(DEXSCREENER_CORE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_CORE_DISCOVERY has ${Object.keys(DEXSCREENER_CORE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
