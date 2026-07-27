/**
 * Retrieval metadata for Pendle discovery + valuation reads.
 * Manifest at `pendle/manifests/read.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_YIELDS_DISCOVERY = {
  "pendle.yields": {
    embeddingText: embeddingText(
      `Browse active Pendle fixed-yield markets across 11 chains including Ethereum, Arbitrum, Base and BSC — each principal token (PT) locks a fixed rate until its expiry date, ranked by liquidity or implied APY. ` +
      `Use when the user wants to find, screen, or compare Pendle PT opportunities: the best fixed yield, the deepest markets, or the nearest maturities. ` +
      `Each row carries the PT, YT and SY addresses, the chain, expiry, liquidity, implied APY, and a warning when a market pays speculative points rather than a real yield. ` +
      `Example queries: best pendle fixed yield, pendle markets by liquidity, highest implied apy pendle, find a PT maturing soon on arbitrum. Read-only.`,
    ),
    aliases: ["pendle yields", "fixed yield markets", "pendle PT list", "pendle fixed rate"],
    exampleIntents: ["best pendle fixed yield", "list pendle markets", "highest implied apy pendle"],
    chains: PENDLE_CHAINS,
  },

  "pendle.position.value": {
    embeddingText: embeddingText(
      `Value the session wallet's open Pendle PT positions across every Pendle chain — balance, chain, market, expiry, and USD value, marking each position as redeemable once it has matured. ` +
      `Use when the user asks what their Pendle positions are worth, which ones have expired, or what is ready to redeem, on any chain. ` +
      `A matured PT is valued at its face or accounting value, never the underlying spot price, so the number reflects redemption value rather than a speculative mark. ` +
      `Example queries: what are my pendle positions worth, show my PT holdings, which pendle PTs can I redeem, pendle portfolio value. Read-only.`,
    ),
    aliases: ["pendle positions", "pendle portfolio value", "my PT holdings", "redeemable pendle"],
    exampleIntents: ["what are my pendle positions worth", "which PTs can I redeem", "pendle holdings value"],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(PENDLE_YIELDS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_YIELDS_DISCOVERY has ${Object.keys(PENDLE_YIELDS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
