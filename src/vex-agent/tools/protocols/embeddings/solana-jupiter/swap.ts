/**
 * Retrieval metadata for Solana / Jupiter swap tools.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `solana-jupiter/manifests/swap.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { SOLANA_CHAINS } from "../../solana-jupiter/discovery-text.js";

export const SOLANA_SWAP_DISCOVERY = {
  "solana.swap.quote": {
    canonicalSummary:
      "Preview a Jupiter Solana SPL token swap — output amount, route, price impact, slippage. Read-only.",
    embeddingText: embeddingText(
      `Preview a Solana SPL token swap — get the output amount, route, price impact, and slippage before executing. ` +
      `Use this when the user wants to know the best price for a sol swap, simulate a trade, check the rate before swapping, or compare swap output. ` +
      `Example queries: how much usdc for 1 sol, preview swap on sol, best route for bonk to usdc, check rate before swapping spl, simulate solana trade. ` +
      `Read-only — does not execute.`,
    ),
    aliases: ["solana swap quote", "spl swap quote", "jupiter quote", "preview sol swap", "swap on solana preview"],
    exampleIntents: ["preview a swap on solana", "quote spl token swap", "rate for sol to usdc swap"],
    preferredFor: ["preview swap on solana", "quote solana swap", "simulate spl swap"],
    chains: SOLANA_CHAINS,
  },

  "solana.swap.execute": {
    canonicalSummary:
      "Execute a Jupiter Solana SPL token swap across 400+ DEXes. Mutating.",
    embeddingText: embeddingText(
      // No "MEV protection" claim and no router names (Metis/JupiterZ/Dflow/
      // OKX): nothing in this repo selects, requests, or verifies either — Vex
      // posts to Jupiter's `/build` and lands the signed bytes itself, so the
      // router choice is Jupiter's and is never echoed back to us. Advertising
      // a safety property we do not implement is the claim rule 90 forbids.
      `Swap any SPL token on Solana — SOL, USDC, JUP, BONK, memecoins or any mint — using Jupiter's aggregator across 400+ DEXes. ` +
      `Use this when the user wants to swap on solana, buy a sol memecoin, sell an spl token, trade sol to usdc, ape into a solana coin, or get the best route on solana. ` +
      `Example queries: swap sol to usdc, buy bonk with sol, sell jup, ape into this sol memecoin, trade spl tokens, best swap on sol.`,
    ),
    aliases: [
      "solana swap", "spl swap", "swap on solana", "jupiter swap",
      "sol to usdc", "ape solana", "buy sol memecoin", "sell spl",
      "swap spl tokens", "trade on sol",
    ],
    exampleIntents: [
      "swap on solana", "swap sol to usdc", "ape into a solana memecoin",
      "trade spl tokens via jupiter", "best swap route on solana",
    ],
    preferredFor: ["swap on solana", "solana swap", "spl swap", "jupiter swap"],
    chains: SOLANA_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(SOLANA_SWAP_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `SOLANA_SWAP_DISCOVERY has ${Object.keys(SOLANA_SWAP_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
