/**
 * Retrieval metadata for the Morpho MARKET reads - screening Blue lending
 * markets, and reading one in full.
 *
 * Manifests at `morpho/manifests/{markets-discover,market-get}.ts` reference
 * these entries by `toolId`.
 *
 * Passages are deliberately MARKET-shaped, never vault-shaped. The Morpho probe
 * (`agents_dm/morpho-mcp-probe/REPORT.md`) recorded that the vault path and the
 * market path share supply-shaped verbs and collide in retrieval unless they are
 * separated on purpose; the vault tools ship in a later batch and will carry
 * vault vocabulary of their own. Nothing here says "vault" as an intent.
 *
 * Boundary facts sit where an agent would hit them: the permissionless-dust
 * hazard lives in the screening passage, because that is where a yield ranking
 * surfaces it, and bad debt lives in the detail passage, because that is the
 * only call that returns it. Technical vocabulary stays out of these passages
 * and lives in `description` and the param descriptions, which feed the lexical
 * lane.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { MORPHO_CHAINS_FOR_DISCOVERY } from "../../morpho/discovery-text.js";

export const MORPHO_MARKET_READ_DISCOVERY = {
  "morpho.markets.discover": {
    embeddingText: embeddingText(
      `Search Morpho lending markets across nine chains to find where to earn interest on a deposit or borrow ` +
      `against collateral, ranked by deposit size, lending rate or liquidation threshold. ` +
      `Use when the user asks where to lend a stablecoin, what a deposit would earn, where borrowing is cheapest, ` +
      `or which markets accept a given collateral. ` +
      `Returns one row per market with both assets and their scale, deposited and borrowed totals, free liquidity, ` +
      `and the plain rate alongside the rate including incentives. ` +
      `Anyone can create a market here, so uncurated ones are hidden by default. ` +
      `Example queries: best place to lend a stablecoin, cheapest borrow rate, markets taking a collateral.`,
    ),
    aliases: [
      "morpho",
      "morpho markets",
      "lend stablecoins",
      "where to earn interest",
      "borrow against collateral",
      "variable lending rate",
      "supply apy",
    ],
    exampleIntents: [
      "best place to lend stablecoins",
      "cheapest borrow rate",
      "which morpho markets take a given collateral",
      "where can I earn yield on stablecoins",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.market.get": {
    embeddingText: embeddingText(
      `Read one Morpho lending market in full before putting money in, naming the market and its chain. ` +
      `Use when the user has picked a market and asks whether it is safe: how much is deposited and borrowed, ` +
      `how much can still be withdrawn, and what price feed decides liquidations. ` +
      `Returns the full state, losses never recovered, the price collateral is valued at, the managed funds ` +
      `supplying it, and optionally the average rate over a week, month or year. ` +
      `A market nobody curated, a flagged price feed, or past losses each mean depositing is risky. ` +
      `Example queries: is this morpho market safe, how much liquidity is left, average lending rate.`,
    ),
    aliases: [
      "morpho market details",
      "morpho market info",
      "is this lending market safe",
      "morpho bad debt",
      "liquidation threshold",
      "morpho market history",
    ],
    exampleIntents: [
      "is this morpho market safe to deposit into",
      "how much liquidity is left in this market",
      "what has this market averaged over the last month",
      "has this lending market lost money",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(MORPHO_MARKET_READ_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `MORPHO_MARKET_READ_DISCOVERY has ${Object.keys(MORPHO_MARKET_READ_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
