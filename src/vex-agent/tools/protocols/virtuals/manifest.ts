/**
 * Virtuals Protocol manifest - agent-token intelligence module.
 *
 * Read-only discovery surface for Virtuals agent tokens (Base, Robinhood,
 * Solana, Ethereum): screen, detail, graduations, the genesis calendar, the
 * bonding-curve trade tape and pool candles, plus the creator-fee status read.
 * No mutating tools: trades execute through the venue namespace named by each
 * result's `tradingRoute` hint, and the one payout this namespace can see -
 * the agent creator's trading tax - is executed by Virtuals' own backend under
 * `SWAP_ROLE`, so the creator-fee tool reports it and refuses the claim with
 * that measurement rather than offering a transaction that cannot exist.
 */

import type { ProtocolToolManifest } from "../types.js";
import { VIRTUALS_AGENTS_TOOLS } from "./manifests/agents.js";
import { VIRTUALS_CREATOR_FEES_TOOLS } from "./manifests/creator-fees.js";
import { VIRTUALS_MARKET_TOOLS } from "./manifests/market.js";

export const VIRTUALS_TOOLS: readonly ProtocolToolManifest[] = [
  ...VIRTUALS_AGENTS_TOOLS,
  ...VIRTUALS_MARKET_TOOLS,
  ...VIRTUALS_CREATOR_FEES_TOOLS,
];
