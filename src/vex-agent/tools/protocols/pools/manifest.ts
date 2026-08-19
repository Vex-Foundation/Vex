/**
 * pools.fun manifest - no-curve launchpad on Robinhood Chain (4663).
 *
 * Read surface plus the advisory launch surface: browse and screen tokens,
 * resolve one by name, read a token's candles, deep-read one token against the
 * chain, list the session wallet's own launches, PRICE a launch, and ask the
 * user to confirm one in the app's form. TRADING IS NOT IN THIS NAMESPACE and never will be:
 * pools.fun tokens live in ordinary SushiSwap V3 pools that the existing
 * kyberswap venue already routes, so a swap tool here would be a second, worse
 * copy of one that exists. The launch family lands in a later phase behind its
 * own approval gates.
 */

import type { ProtocolToolManifest } from "../types.js";
import { POOLS_TOKENS_TOOLS } from "./manifests/tokens.js";
import { POOLS_SEARCH_TOOLS } from "./manifests/search.js";
import { POOLS_CANDLES_TOOLS } from "./manifests/candles.js";
import { POOLS_TOKEN_TOOLS } from "./manifests/token.js";
import { POOLS_MY_LAUNCHES_TOOLS } from "./manifests/my-launches.js";
import { POOLS_LAUNCH_TOOLS } from "./manifests/launch.js";
import { POOLS_CLAIM_TOOLS } from "./manifests/claim.js";

export const POOLS_TOOLS: readonly ProtocolToolManifest[] = [
  ...POOLS_TOKENS_TOOLS,
  ...POOLS_SEARCH_TOOLS,
  ...POOLS_CANDLES_TOOLS,
  ...POOLS_TOKEN_TOOLS,
  ...POOLS_MY_LAUNCHES_TOOLS,
  ...POOLS_LAUNCH_TOOLS,
  ...POOLS_CLAIM_TOOLS,
];
