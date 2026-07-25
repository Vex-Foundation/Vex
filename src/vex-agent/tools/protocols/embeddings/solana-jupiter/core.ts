/**
 * Retrieval metadata for Solana / Jupiter core tools.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `solana-jupiter/manifests/core.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { SOLANA_CHAINS } from "../../solana-jupiter/discovery-text.js";

export const SOLANA_CORE_DISCOVERY = {
  "solana.prices": {
    canonicalSummary:
      "Jupiter price lookup for Solana SPL token mints, returning real-time USD prices.",
    embeddingText: embeddingText(
      `Get real-time USD prices for Solana SPL token mints — SOL, USDC, JUP, BONK, memecoins, LSTs, or any mint. ` +
      `Use this when the user wants the current price of one or more solana tokens, value their portfolio, or monitor price movements on Solana. ` +
      `Accepts either mint addresses or token symbols/names directly (e.g. "SOL,BONK") — no need to look up the mint first. ` +
      `Example queries: what's sol price now, current price of bonk, usd price for these spl mints, value my solana portfolio, price for this memecoin, sol token price.`,
    ),
    aliases: ["jupiter price lookup", "solana price lookup", "token price lookup", "current token price", "price by symbol"],
    exampleIntents: ["jupiter price lookup", "current price of bonk", "usd price for solana mint", "price by token symbol"],
    preferredFor: ["price lookup", "token prices", "current usd price", "price by symbol or name"],
    chains: SOLANA_CHAINS,
  },

  "solana.tokens.search": {
    embeddingText: embeddingText(
      `Look up a Solana SPL token by name, ticker, symbol, or mint address. ` +
      `Use this when the user names a sol coin (BONK, JUP, that new memecoin) and you need the mint address, decimals, or verification status before swapping. ` +
      `Example queries: find bonk on solana, what's the mint for jup, lookup this spl token, search sol token, resolve sol ticker, find sol contract. ` +
      `Returns metadata, organic score, holders, market cap, liquidity.`,
    ),
    chains: SOLANA_CHAINS,
  },

  "solana.tokens.trending": {
    embeddingText: embeddingText(
      `Find trending and popular tokens on Solana — top traded SPL tokens, top trending memes, recently launched solana tokens, popular liquid staking tokens (LSTs), verified tokens with the most attention, or tokenized stocks (e.g. Ondo, Remora). ` +
      `Use this when the user wants to see what's pumping on sol, what's hot on solana, top sol memes, new solana launches, popular spl tokens, or tokenized equities on solana. ` +
      `Example queries: trending tokens on solana, what's hot on sol right now, top sol memes, new solana launches, popular spl tokens, top traded sol coins, tokenized stocks on solana. ` +
      `Filter by 5m, 1h, 6h, 24h windows.`,
    ),
    chains: SOLANA_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 3;
if (Object.keys(SOLANA_CORE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `SOLANA_CORE_DISCOVERY has ${Object.keys(SOLANA_CORE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
