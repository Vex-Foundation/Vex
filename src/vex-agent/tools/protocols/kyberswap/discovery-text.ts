/**
 * KyberSwap retrieval-only chain enumerations.
 *
 * These arrays feed the structured `chains` field on each manifest's
 * `discovery` metadata. They are NOT interpolated into `embeddingText` —
 * the agent-style passages name only the top 5–8 chains by name; the full
 * enumeration lives here so the lexical scorer can recall rare chain
 * names (Plasma, Etherlink, Berachain, Sei, Sonic, Monad, etc.) when an
 * agent queries by chain.
 *
 * The legacy `kyberEmbeddingText` helper is re-exported as a thin wrapper
 * over the shared `embeddingText` so existing manifest imports keep working
 * without churn during the agent-style passage refactor.
 */

import { embeddingText } from "../_embedding-text.js";

export const KYBER_SWAP_CHAINS: readonly string[] = [
  "Ethereum", "BNB Chain", "BSC", "Binance Smart Chain",
  "Arbitrum", "Polygon POS", "Matic", "Optimism", "Avalanche",
  "Base", "Linea", "Mantle", "Sonic", "Berachain", "Ronin",
  "Unichain", "HyperEVM", "Plasma", "Etherlink", "Monad", "MegaETH",
  // Aggregator-only, provisional (see tools/kyberswap/chains.ts). Not in the
  // limit-order or zap recall lists — 4663 supports neither.
  "Robinhood", "Robinhood Chain",
];

export const KYBER_LIMIT_ORDER_CHAINS: readonly string[] = [
  "Ethereum", "BNB Chain", "BSC", "Binance Smart Chain",
  "Arbitrum", "Polygon POS", "Matic", "Optimism", "Avalanche",
  "Base", "Linea", "Mantle", "Sonic", "Berachain", "Ronin",
  "Unichain", "HyperEVM", "Monad", "MegaETH",
];

export const KYBER_ZAP_CHAINS: readonly string[] = [
  "Ethereum", "BNB Chain", "BSC", "Binance Smart Chain",
  "Arbitrum", "Polygon POS", "Matic", "Optimism", "Avalanche",
  "Base", "Linea", "Sonic", "Berachain", "Ronin", "Scroll", "zkSync",
];

/** Back-compat re-export — prefer importing `embeddingText` from `_embedding-text.ts` directly in new code. */
export const kyberEmbeddingText = embeddingText;
