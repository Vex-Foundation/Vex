import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_TOKEN_DISCOVERY } from "../../embeddings/pools/token.js";

// Single-token deep detail - READ-ONLY. Joins the launchpad row with what the
// PartyLocker and the token contract know, and labels every field group with
// where it came from so display-grade numbers are never mistaken for on-chain
// facts.

export const POOLS_TOKEN_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.token",
    publicName: "pools__token_get",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Read everything known about ONE pools.fun token on Robinhood Chain (4663), joining the launchpad's market row with on-chain contract state. Use this before acting on a token: to confirm which pool is its real pool, who created it and who earns its fees, how those fees are split, and what its true decimals are. Returns two labelled groups. The api group carries name, symbol, launcher, paired asset, display-grade price and market cap, volumes, price changes, launch time and social links, plus the launchpad's badges when they apply: vexAttested, holderRewardsMode with holderRewardsDistributor, poolsFunBrand (a Not official brand-collision warning) and pairedStockIlliquid (display only). Those badges are the launchpad's claim; read pools__holder_rewards_get for the distributor and reward mode the chain actually proves. The onchain group carries the canonical pool address from the PartyLocker, the paired asset contract, the creator and fee recipient the locker recorded, the permanently locked liquidity position ids, the fee split in basis points, the token's decimals, and its metadata link - all read at one pinned block, which is reported. Every pools.fun pool charges a 1 percent fee and the creator's share of it is stated in the split. A token launched by the older sushi launcher is NOT in this locker's registry, and that is reported in words rather than as a row of zero addresses. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "tokenAddress",
        type: "string",
        required: true,
        description:
          "Contract address of the token to inspect. Resolve a name to an address with pools__tokens_search first, since symbols repeat across this launchpad.",
      },
    ],
    exampleParams: { tokenAddress: "0x0ab8d01664d4bb625705f9f3c595a8a19b3dcfb0" },
    discovery: POOLS_TOKEN_DISCOVERY["pools.token"],
  },
];
