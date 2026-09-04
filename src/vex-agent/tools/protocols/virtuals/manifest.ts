/**
 * Virtuals Protocol manifest - agent-token intelligence module.
 *
 * Discovery surface for Virtuals agent tokens (Base, Robinhood, Solana,
 * Ethereum): screen, detail, graduations, the genesis calendar, the
 * bonding-curve trade tape and pool candles - plus the two BONDING-CURVE TRADE
 * tools (PR-C2), which are the only mutating members of the namespace.
 *
 * A GRADUATED agent still trades through the venue namespace named by its
 * `tradingRoute` hint: the curve tools refuse it by name and say which AMM tool
 * to use, because BondingV5 would revert against a graduated token.
 */

import type { ProtocolToolManifest } from "../types.js";
import { VIRTUALS_AGENTS_TOOLS } from "./manifests/agents.js";
import { VIRTUALS_MARKET_TOOLS } from "./manifests/market.js";
import { VIRTUALS_TRADE_TOOLS } from "./manifests/trade.js";

export const VIRTUALS_TOOLS: readonly ProtocolToolManifest[] = [
  ...VIRTUALS_AGENTS_TOOLS,
  ...VIRTUALS_MARKET_TOOLS,
  ...VIRTUALS_TRADE_TOOLS,
];
