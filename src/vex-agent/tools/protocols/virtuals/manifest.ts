/**
 * Virtuals Protocol manifest - agent-token intelligence module.
 *
 * Read-only discovery surface for Virtuals agent tokens (Base, Robinhood,
 * Solana, Ethereum): screen, detail, graduations, the genesis calendar, the
 * bonding-curve trade tape and pool candles. No mutating tools: trades execute
 * through the venue namespace named by each result's `tradingRoute` hint.
 */

import type { ProtocolToolManifest } from "../types.js";
import { VIRTUALS_AGENTS_TOOLS } from "./manifests/agents.js";
import { VIRTUALS_MARKET_TOOLS } from "./manifests/market.js";

export const VIRTUALS_TOOLS: readonly ProtocolToolManifest[] = [
  ...VIRTUALS_AGENTS_TOOLS,
  ...VIRTUALS_MARKET_TOOLS,
];
