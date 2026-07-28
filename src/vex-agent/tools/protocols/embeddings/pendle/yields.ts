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
      `Screen Pendle fixed-yield markets across all eleven chains — ethereum, optimism, bsc, monad, sonic, hyperevm, arbitrum, plasma, mantle, base and berachain — some of which may list no active markets. ` +
      `Use when the user wants to find, rank or compare Pendle opportunities: the best fixed rate, the deepest markets, the nearest maturities, or ones that are not points farms. ` +
      `Filter by chain, liquidity, implied APY, expiry window, days to maturity, underlying asset, category, and new or prime status, then page explicitly — nothing is trimmed silently. Matured markets are included on request. ` +
      `Example queries: best pendle fixed yield, deepest pendle markets, PT maturing soon on arbitrum.`,
    ),
    aliases: ["pendle yields", "fixed yield markets", "pendle PT list", "pendle fixed rate", "screen pendle markets"],
    exampleIntents: ["best pendle fixed yield", "list pendle markets", "highest implied apy pendle", "pendle markets expiring soon"],
    chains: PENDLE_CHAINS,
  },

  "pendle.position.value": {
    embeddingText: embeddingText(
      `Value every Pendle position the session wallet holds — principal tokens, yield tokens, liquidity positions and standardised yield holdings — on every Pendle chain. ` +
      `Use when the user asks what their Pendle holdings are worth, which have matured, or what is ready to redeem or remove. ` +
      `Each leg reports one state: earning, matured and redeemable, matured and removable, or expired worthless — with accrued unclaimed interest and rewards, the staked share of a liquidity position, and how old Pendle's numbers are. ` +
      `A matured principal token is valued at face, never underlying spot. ` +
      `Example queries: what are my pendle positions worth, which pendle positions can I redeem, my YT holdings.`,
    ),
    aliases: ["pendle positions", "pendle portfolio value", "my PT holdings", "my YT holdings", "redeemable pendle", "pendle LP value"],
    exampleIntents: ["what are my pendle positions worth", "which PTs can I redeem", "pendle holdings value", "what pendle yield have I accrued"],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(PENDLE_YIELDS_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_YIELDS_DISCOVERY has ${Object.keys(PENDLE_YIELDS_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
