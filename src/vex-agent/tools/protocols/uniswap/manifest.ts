/**
 * Uniswap protocol manifest - swap module (quote + sell + buy).
 *
 * Keyless on-chain V2/V3 routing: one of Vex's two EVM swap venues, covering
 * every chain with a verified Vex deployment (incl. Robinhood Chain 4663). The
 * standing between it and KyberSwap is owned by
 * `registry/swap-venue-guidance.ts`. No LP / positions / V4 surfaces.
 */

import type { ProtocolToolManifest } from "../types.js";
import { UNISWAP_SWAP_TOOLS } from "./manifests/swap.js";

export const UNISWAP_TOOLS: readonly ProtocolToolManifest[] = [...UNISWAP_SWAP_TOOLS];
