/**
 * KyberSwap protocol manifest — aggregates all module manifests.
 *
 * 3 modules: chains, tokens, swap. All EVM-only — 19 aggregator chains, 400+
 * DEXs. Limit-order + zap tooling were deleted (Agent Scan plan §4.2/§1.4-5).
 */

import type { ProtocolToolManifest } from "../types.js";
import { CHAINS_TOOLS } from "./manifests/chains.js";
import { TOKENS_TOOLS } from "./manifests/tokens.js";
import { SWAP_TOOLS } from "./manifests/swap.js";

export const KYBERSWAP_TOOLS: readonly ProtocolToolManifest[] = [
  ...CHAINS_TOOLS,
  ...TOKENS_TOOLS,
  ...SWAP_TOOLS,
];
