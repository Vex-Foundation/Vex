/**
 * Retrieval metadata for Pendle PT trade tools (quote + buy/sell/redeem).
 * Manifest at `pendle/manifests/pt.ts` references entries by `toolId`.
 * Mutating passages open with an action verb (Buy / Sell / Redeem) per lint.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_PT_DISCOVERY = {
  "pendle.pt.quote": {
    embeddingText: embeddingText(
      `Preview a Pendle PT trade before executing — quote buying a PT with a payment token, selling a PT early, or redeeming a matured PT, with the output amount, price impact, aggregator, and market liquidity, on any of Pendle's 11 chains. ` +
      `Use when the user wants the price, rate, or route for a fixed-yield PT position before committing funds. ` +
      `It also records the safety preview that the Pendle buy, sell, and redeem tools require before they may broadcast. ` +
      `Example queries: quote a pendle PT buy, preview selling my PT early, what will I get redeeming pendle, pendle fixed yield price. Read-only.`,
    ),
    aliases: ["pendle quote", "pendle PT price", "preview pendle trade", "pendle rate"],
    exampleIntents: ["quote a pendle PT buy", "preview selling my PT", "pendle redeem preview"],
    chains: PENDLE_CHAINS,
  },

  "pendle.pt.buy": {
    embeddingText: embeddingText(
      `Buy a Pendle principal token (PT) with a payment token, locking a fixed yield until the market's expiry date, on any of Pendle's 11 chains. ` +
      `Use when the user wants to enter a fixed-rate position on Ethereum, Arbitrum, Base, BSC or another Pendle chain after previewing it with a Pendle quote. ` +
      `Requires a fresh matching pendle.pt.quote first; the trade is approval-gated and pins the canonical Pendle Router. ` +
      `Funds stay committed until maturity — an early exit is priced at the current market and can realize a loss. ` +
      `Example queries: buy pendle PT with USDC, lock a fixed yield on arbitrum, enter a pendle fixed-rate position, buy PT to expiry.`,
    ),
    aliases: ["pendle buy", "buy PT", "lock fixed yield", "enter pendle position"],
    exampleIntents: ["buy pendle PT with USDC", "lock a fixed yield", "enter a fixed-rate position"],
    chains: PENDLE_CHAINS,
  },

  "pendle.pt.sell": {
    embeddingText: embeddingText(
      `Sell a Pendle principal token (PT) back to a payment token before its expiry — an early exit priced at the current market rate, on any of Pendle's 11 chains. ` +
      `Use when the user wants to exit a fixed-yield position ahead of maturity and accept the market price, which can be below the locked rate. ` +
      `Requires a fresh matching pendle.pt.quote first; the trade is approval-gated and pins the canonical Pendle Router. ` +
      `Example queries: sell my pendle PT early, exit a fixed yield before expiry, unwind a pendle position, sell PT for USDC.`,
    ),
    aliases: ["pendle sell", "sell PT", "exit fixed yield early", "unwind pendle"],
    exampleIntents: ["sell my pendle PT early", "exit a fixed yield before expiry", "unwind pendle position"],
    chains: PENDLE_CHAINS,
  },

  "pendle.pt.redeem": {
    embeddingText: embeddingText(
      `Redeem a matured Pendle principal token (PT) for its accounting asset at roughly one to one, after the market's expiry date has passed, on any of Pendle's 11 chains. ` +
      `Use when the user holds an expired PT on Ethereum, Arbitrum, Base or another Pendle chain and wants to claim the principal back. ` +
      `Requires a fresh matching pendle.pt.quote first; the redemption is approval-gated, pins the canonical Pendle Router, and falls back to a direct on-chain exit when the pricing service is unavailable. ` +
      `Example queries: redeem my matured pendle PT, claim principal from an expired PT, cash out a matured fixed yield, redeem pendle after expiry.`,
    ),
    aliases: ["pendle redeem", "redeem PT", "claim matured pendle", "cash out pendle"],
    exampleIntents: ["redeem my matured pendle PT", "claim principal from expired PT", "cash out matured PT"],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 4;
if (Object.keys(PENDLE_PT_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_PT_DISCOVERY has ${Object.keys(PENDLE_PT_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
