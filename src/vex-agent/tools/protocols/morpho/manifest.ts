/**
 * Morpho protocol manifest - EVM variable-rate lending (Morpho Blue).
 *
 * Four lanes ship today. MARKETS: screening Blue markets and reading one in full,
 * for a user who picks an asset pair themselves. VAULTS: screening curated
 * vaults and reading one in full, for a user who hands the choice to a curator.
 * PORTFOLIO: what one wallet already holds, and the transaction record of the
 * markets themselves. WALLET: the two reads that sit beside the position rather
 * than inside it - the reward campaigns a wallet can claim, and what it holds
 * and has already approved before it acts. All eight are read-only; nothing in
 * this namespace signs or spends today.
 *
 * One module per tool under `./manifests/`, composed here, so a tool's contract
 * and its long description live in a file named after the tool.
 */

import type { ProtocolToolManifest } from "../types.js";
import { MORPHO_MARKETS_DISCOVER_TOOL } from "./manifests/markets-discover.js";
import { MORPHO_MARKET_GET_TOOL } from "./manifests/market-get.js";
import { MORPHO_VAULTS_DISCOVER_TOOL } from "./manifests/vaults-discover.js";
import { MORPHO_VAULT_GET_TOOL } from "./manifests/vault-get.js";
import { MORPHO_POSITIONS_GET_TOOL } from "./manifests/positions-get.js";
import { MORPHO_MARKETS_ACTIVITY_TOOL } from "./manifests/markets-activity.js";
import { MORPHO_REWARDS_GET_TOOL } from "./manifests/rewards-get.js";
import { MORPHO_WALLET_BALANCE_TOOL } from "./manifests/wallet-balance.js";

export const MORPHO_TOOLS: readonly ProtocolToolManifest[] = [
  MORPHO_MARKETS_DISCOVER_TOOL,
  MORPHO_MARKET_GET_TOOL,
  MORPHO_VAULTS_DISCOVER_TOOL,
  MORPHO_VAULT_GET_TOOL,
  MORPHO_POSITIONS_GET_TOOL,
  MORPHO_MARKETS_ACTIVITY_TOOL,
  MORPHO_REWARDS_GET_TOOL,
  MORPHO_WALLET_BALANCE_TOOL,
];
