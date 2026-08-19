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
      `Search DexScreener-indexed trading pairs by name, symbol, or contract address across supported chains. ` +
      `Use this when the user supplies a name or symbol instead of a trusted contract address, or wants candidates across chains; do not use it when exact identity is already known. A ticker match is not token identity: select an exact chain and contract address from the result, then call dexscreener.tokenPairs. ` +
      `Filters narrow by chainIds, liquidity, and count; results stay in provider order. DexScreener covers indexed AMM pairs, not every possible market. ` +
      `Example queries: find pepe pair, search bonk, lookup this contract, where is shib trading on base, find a token on robinhood, search dex pairs.`,
    ),
    // The namespace resolver's identity, stated at summary weight (2026-08-19):
    // shared navigation-facet prose bleeds routing tokens into every tool it
    // covers, which had left this tool's canonical query a one-point win over
    // `tokenPairs`. Its own curated fields, not the shared prose, are what a
    // resolver's dominance on "find a token by name or symbol" should rest on.
    canonicalSummary: "Find a token by name or symbol and resolve it to an exact chain and contract address.",
    aliases: ["find token by name or symbol", "resolve ticker to token address", "token name lookup"],
    exampleIntents: [
      "find a token by name or symbol",
      "resolve this ticker to exact chain and contract address",
    ],
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.pairs": {
    embeddingText: embeddingText(
      `Full analytics for one specific DEX trading pair by pool address — price, volume, liquidity, buys and sells, transactions, FDV, market cap, pair age, boosts. ` +
      `Use this when the user already has the exact chain and pool address and wants market metrics for that indexed pool. These observations are research data, not a contract-safety verdict or executable quote. ` +
      `Example queries: pair details for this pool, give me stats for this pair on base, volume and liquidity for this dex pair, full analytics for this pool, single pool stats.`,
    ),
    aliases: ["inspect known pool address", "pair liquidity analytics", "known pool analytics", "pool address stats"],
    exampleIntents: [
      "inspect liquidity for an exact pool address",
      "show analytics for this known dex pair",
    ],
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.tokens": {
    embeddingText: embeddingText(
      `Batch pricing and DEX market data for up to 60 token contract addresses on one chain — Vex splits them into 30-address DexScreener requests and merges prices, pairs, liquidity, volume, and market cap observations. ` +
      `Use this when the user already has multiple exact token addresses on one chain and wants batch market observations. Always inspect unresolvedAddresses. Do not use it to resolve names or symbols, and do not treat missing rows as proof that a market does not exist. ` +
      `Example queries: batch lookup these tokens, prices for my portfolio coins, market data for these contracts, compare these tokens on base, batch token stats.`,
    ),
    aliases: ["batch exact token addresses", "multiple exact token addresses", "portfolio address pricing"],
    exampleIntents: [
      "batch market data for multiple exact token addresses",
      "price this list of contract addresses on one chain",
    ],
    chains: DEXSCREENER_CHAINS,
  },
  "dexscreener.tokenPairs": {
    embeddingText: embeddingText(
      `Find the pools and trading pairs DexScreener indexes for a single token across DEXes on a chain. ` +
      `Use this when the exact token address and chain are already known, including immediately after dexscreener.search resolves a name/symbol candidate. Compare only the AMM pools DexScreener indexes; shortlist liquidity here, then obtain a fresh executable quote from the actual venue before trading. ` +
      `Example queries: find best pool for pepe on solana, where is most liquidity for this coin, all pools for usdc on base, compare dexes for this token, deepest pool for sol/usdc, best market for this memecoin.`,
    ),
    // Curated routing signal, added 2026-08-19: the params-dedupe rescore
    // (morpho audit) removed the repeated-param-token edge this tool relied on,
    // and its canonical query started losing to `dexscreener.tokens`, whose
    // entry already carries aliases and intents. One token address -> pools is
    // THIS tool's identity, so it states that in its own curated fields
    // instead of leaning on parameter surface area.
    exampleIntents: [
      "compare indexed pools for one exact token address on a chain",
    ],
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 4;
if (Object.keys(DEXSCREENER_CORE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_CORE_DISCOVERY has ${Object.keys(DEXSCREENER_CORE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
