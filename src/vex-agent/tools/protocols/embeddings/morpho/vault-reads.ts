/**
 * Retrieval metadata for the Morpho VAULT reads - screening curated vaults, and
 * reading one in full.
 *
 * Manifests at `morpho/manifests/{vaults-discover,vault-get}.ts` reference these
 * entries by `toolId`.
 *
 * THE VOCABULARY HERE IS DELIBERATELY DISJOINT FROM THE MARKET LANE'S, and that
 * separation is load-bearing rather than tidy. Two independent probes recorded
 * the same collision: a vault and a lending market are both places a user
 * "supplies", "deposits into" and "earns on", so passages written naturally for
 * both end up competing for the same queries and the wrong one wins half the
 * time. The split is by INTENT, not by synonym:
 *
 *   VAULT intent  - hand money to a manager: curated vault, deposit into a
 *                   vault, passive earn, set and forget, curator, TVL, share
 *                   price, one deposit spread across many places.
 *   MARKET intent - pick a venue yourself: lend to a market, borrow, collateral,
 *                   liquidation threshold, utilization, one asset pair.
 *
 * Nothing below uses a market-lane screening phrase. `market-reads.ts` carries
 * the reciprocal constraint and says so.
 *
 * Neither passage enumerates chain slugs: that list has one home in the
 * structured `chains` field, where it recalls at a deliberately low weight, and
 * duplicating it into prose measurably distorted an unrelated eval query during
 * batch 1.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { MORPHO_CHAINS_FOR_DISCOVERY } from "../../morpho/discovery-text.js";

export const MORPHO_VAULT_READ_DISCOVERY = {
  "morpho.vaults.discover": {
    embeddingText: embeddingText(
      `Find curated Morpho vaults to park savings in and leave alone, ranked by size, yield or fee. ` +
      `A manager spreads one deposit across many venues, so the depositor picks a manager rather than a venue. ` +
      `Use when the user wants somewhere passive for an asset, asks which vault pays best, or wants to compare ` +
      `managers and their cut. ` +
      `Returns the manager, total deposits, share price, the yield after the manager's cut, and whether a ` +
      `contract can block money going in or out. Anyone can publish one, so unvetted entries are hidden. ` +
      `Example queries: best vault for my usdc, top curated vaults, which manager charges least.`,
    ),
    aliases: [
      "morpho vaults",
      "curated vault",
      "metamorpho",
      "vault apy",
      "passive earn",
      "managed deposit",
      "vault curator",
      "vault tvl",
    ],
    exampleIntents: [
      "best morpho vault for usdc",
      "which curated vault pays the most",
      "somewhere passive to park my stablecoins",
      "biggest vaults by deposits",
      "compare vault managers and their fees",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },

  "morpho.vault.get": {
    embeddingText: embeddingText(
      `Read one Morpho vault in full before putting savings in, naming its address and chain. ` +
      `Use when the user has picked one and asks who runs it, whether they could get their money back out, ` +
      `where the manager is putting it, or how fast the manager can change that. ` +
      `Returns who owns and steers it, how long a change waits, how many are queued, the share price and ` +
      `deposits, the yield after the manager's cut, every venue the deposit is spread across with its ` +
      `ceiling, and whether a contract can refuse a withdrawal. ` +
      `Example queries: who runs this vault, can I withdraw from this vault, is this vault safe.`,
    ),
    aliases: [
      "vault details",
      "vault allocations",
      "who runs this vault",
      "can I withdraw",
      "gated vault",
      "vault timelock",
      "vault curator details",
      "share price",
    ],
    exampleIntents: [
      "who runs this morpho vault",
      "can I get my money out of this vault",
      "where is this vault putting the deposits",
      "how fast can the manager change this vault",
      "is this vault gated",
    ],
    chains: MORPHO_CHAINS_FOR_DISCOVERY,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 2;
if (Object.keys(MORPHO_VAULT_READ_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `MORPHO_VAULT_READ_DISCOVERY has ${Object.keys(MORPHO_VAULT_READ_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
