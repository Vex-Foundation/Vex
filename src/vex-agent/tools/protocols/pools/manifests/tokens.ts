import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_TOKENS_DISCOVERY } from "../../embeddings/pools/tokens.js";
import { POOLS_TOKENS_PARAMS, POOLS_UNSUPPORTED_PARAMS } from "./tokens-params.js";

// pools.fun token browser - READ-ONLY. Every filter is server-side, so an empty
// result is the provider's answer about the market and not a page Vex filtered
// away; the reply echoes the active filters either way.

export const POOLS_TOKENS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.tokens",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Browse and screen pools.fun launchpad tokens on Robinhood Chain (4663). Use when the task is finding or ranking tokens on this launchpad: what launched in the last few hours, what is trading heaviest right now, everything one wallet deployed, or a market-cap band. Returns rows carrying token address, name, symbol, the Sushi V3 pool address, the paired asset (weth, usdg or a tokenised stock), display-grade price in USD and ETH, market cap, volume over five windows, 24h trade count, price change over five windows, launch and last-trade times, age in hours, deployer and fee recipient (with their X handles when known), and image, website and tweet links - plus a filter echo, a row count and a nextCursor for the following page. pools.fun has NO bonding curve and NO graduation: a token trades in a real SushiSwap V3 pool from its first block, every pool charges a 1 percent fee, and total supply is always one billion. Two launchers share this chain and the platform parameter selects between them. Identity is the token ADDRESS - symbols are not unique and copycats are routinely live. Every price and volume here is display-grade; quote and trade these tokens with kyberswap, which routes them, and research their pools with dexscreener. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [...POOLS_TOKENS_PARAMS],
    rejectedParams: POOLS_UNSUPPORTED_PARAMS,
    exampleParams: { platform: "poolsfun", sortBy: "deployedAt", maxAgeHours: 6, limit: 20 },
    discovery: POOLS_TOKENS_DISCOVERY["pools.tokens"],
  },
];
