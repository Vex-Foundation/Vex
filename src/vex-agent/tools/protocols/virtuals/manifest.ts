/**
 * Virtuals Protocol manifest - agent-token intelligence module.
 *
 * Discovery surface for Virtuals agent tokens (Base, Robinhood, Solana,
 * Ethereum): screen, detail, graduations, the genesis calendar, the
 * bonding-curve trade tape, pool candles and the creator-fee status read -
 * plus the two BONDING-CURVE TRADE tools (PR-C2) and the four AGENT-LAUNCH
 * tools (PR-C3), which are the mutating members of the namespace.
 *
 * THE LAUNCH FAMILY IS FOUR TOOLS RATHER THAN TWO because a Virtuals launch
 * takes two transactions and only the first is Vex's: `preLaunch` creates the
 * agent, the VIRTUALS KEEPER's `launch()` makes it tradable and listed, and the
 * state in between has its own question (`status`) and its own remedy
 * (`cancel`).
 *
 * A GRADUATED agent still trades through the venue namespace named by its
 * `tradingRoute` hint: the curve tools refuse it by name and say which AMM tool
 * to use, because BondingV5 would revert against a graduated token.
 *
 * The one payout this namespace can see - the agent creator's trading tax - is
 * executed by Virtuals' own backend under `SWAP_ROLE`, so the creator-fee tool
 * reports it and refuses the claim with that measurement rather than offering a
 * transaction that cannot exist.
 */

import type { ProtocolToolManifest } from "../types.js";
import { VIRTUALS_AGENTS_TOOLS } from "./manifests/agents.js";
import { VIRTUALS_CREATOR_FEES_TOOLS } from "./manifests/creator-fees.js";
import { VIRTUALS_LAUNCH_TOOLS } from "./manifests/launch.js";
import { VIRTUALS_MARKET_TOOLS } from "./manifests/market.js";
import { VIRTUALS_TRADE_TOOLS } from "./manifests/trade.js";

export const VIRTUALS_TOOLS: readonly ProtocolToolManifest[] = [
  ...VIRTUALS_AGENTS_TOOLS,
  ...VIRTUALS_MARKET_TOOLS,
  ...VIRTUALS_CREATOR_FEES_TOOLS,
  ...VIRTUALS_TRADE_TOOLS,
  ...VIRTUALS_LAUNCH_TOOLS,
];
