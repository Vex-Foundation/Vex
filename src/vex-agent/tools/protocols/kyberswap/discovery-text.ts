/**
 * KyberSwap retrieval-only chain enumeration.
 *
 * Feeds the structured `chains` field on each manifest's `discovery`
 * metadata. It is NOT interpolated into `embeddingText` — the agent-style
 * passages name only the top 5–8 chains by name; the full enumeration lives
 * here so the lexical scorer can recall rare chain names (Plasma, Etherlink,
 * Berachain, Sonic, Monad, etc.) when an agent queries by chain.
 *
 * Limit-order + zap tooling were deleted (Agent Scan plan §4.2/§1.4-5), so
 * the former `KYBER_LIMIT_ORDER_CHAINS`/`KYBER_ZAP_CHAINS` recall lists went
 * with them — `KYBER_SWAP_CHAINS` is the only surviving KyberSwap surface.
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
  // Aggregator-only, provisional (see tools/kyberswap/chains.ts).
  "Robinhood", "Robinhood Chain",
];

/** Back-compat re-export — prefer importing `embeddingText` from `_embedding-text.ts` directly in new code. */
export const kyberEmbeddingText = embeddingText;
