/**
 * Uniswap protocol manifest — swap module (quote + sell + buy).
 *
 * Keyless on-chain V2/V3 routing. An all-EVM fallback venue (incl. Robinhood
 * Chain 4663) for KyberSwap, which stays primary wherever it is supported. No
 * LP / positions / V4 surfaces.
 */

import type { ProtocolToolManifest } from "../types.js";
import { UNISWAP_SWAP_TOOLS } from "./manifests/swap.js";

export const UNISWAP_TOOLS: readonly ProtocolToolManifest[] = [...UNISWAP_SWAP_TOOLS];
