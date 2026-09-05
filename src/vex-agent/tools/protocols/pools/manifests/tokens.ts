import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_TOKENS_DISCOVERY } from "../../embeddings/pools/tokens.js";
import { POOLS_TOKENS_PARAMS, POOLS_UNSUPPORTED_PARAMS } from "./tokens-params.js";

// pools.fun token browser - READ-ONLY. Every filter is server-side, so an empty
// result is the provider's answer about the market and not a page Vex filtered
// away; the reply echoes the active filters either way.

export const POOLS_TOKENS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.tokens",
    publicName: "pools__tokens_discover",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Browse and screen pools.fun launchpad tokens on Robinhood Chain (4663). Use when the task is finding or ranking tokens on this launchpad: what launched in the last few hours, what is trading heaviest right now, everything one wallet deployed, or a market-cap band. Returns rows carrying token address, name, symbol, the Sushi V3 pool address, the paired asset (weth, usdg or a tokenised stock), display-grade price in USD and ETH, market cap, volume over five windows, 24h trade count, price change over five windows, launch and last-trade times, age in hours, deployer and fee recipient (with their X handles when known), and image, website and tweet links, plus isOwnLaunch when it can be determined (true means the SESSION's own wallet deployed that token, false a different known deployer, and an ABSENT field means undetermined, never not-yours) - plus a filter echo, a row count and a nextCursor for the following page. Rows also carry the launchpad's own badges when it sets them, and each is PRESENT ONLY WHEN IT APPLIES so an absent field means the launchpad claims nothing rather than claiming no: vexAttested (this launch carries a Vex attestation), holderRewardsMode (token, paired or both - which fee legs stream to holders) with holderRewardsDistributor (the contract that streams them), poolsFunBrand (the launchpad flags the name as a brand collision and shows it as Not official), and pairedStockIlliquid (the tokenised stock this token pairs against is illiquid; display only, and its absence is NOT a liquidity promise). Every one of those five is the launchpad's claim about its own index. The holder-rewards pair is proven against the chain by pools__holder_rewards_get, which reads the distributor the suite's deployer actually emitted. Filter on the last two badges with vexAttested and holderRewards, which are opt-in switches: only true is accepted, and the tokens WITHOUT the badge cannot be requested. There is no hasMore field: a nextCursor is the only continuation signal, and its absence is the end. pools.fun has NO bonding curve and NO graduation: a token trades in a real SushiSwap V3 pool from its first block, every pool charges a 1 percent fee, and total supply is always one billion. Two launchers share this chain and the platform parameter selects between them. Identity is the token ADDRESS - symbols are not unique and copycats are routinely live. Every price and volume here is display-grade; quote and trade these tokens with kyberswap, which routes them, and research their pools with dexscreener. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [...POOLS_TOKENS_PARAMS],
    rejectedParams: POOLS_UNSUPPORTED_PARAMS,
    exampleParams: { platform: "poolsfun", sortBy: "deployedAt", maxAgeHours: 6, limit: 20 },
    discovery: POOLS_TOKENS_DISCOVERY["pools.tokens"],
  },
];
