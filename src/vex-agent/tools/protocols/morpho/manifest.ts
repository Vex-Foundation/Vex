/**
 * Morpho protocol manifest - EVM variable-rate lending (Morpho Blue).
 *
 * Four lanes ship today. MARKETS: screening Blue markets and reading one in full,
 * for a user who picks an asset pair themselves. VAULTS: screening curated
 * vaults and reading one in full, for a user who hands the choice to a curator.
 * PORTFOLIO: what one wallet already holds, and the transaction record of the
 * markets themselves. WALLET: the two reads that sit beside the position rather
 * than inside it - the reward campaigns a wallet can claim, and what it holds
 * and has already approved before it acts. PREVIEW: one tool that prices a
 * specific deposit into or withdrawal from a vault, building and decoding the
 * exact transaction without signing or sending it. EXECUTE: the two tools that
 * actually move money, supplying assets to a vault and redeeming them back out.
 * BORROW: one preview and four executes covering the whole Blue market position
 * lifecycle - supplying collateral, borrowing against it, repaying the debt and
 * withdrawing the collateral back out, each a single leg on a market whose
 * oracle Vex vouches for and each gated on a fresh quote of its OWN direction.
 * CLAIM: one tool that sweeps the reward tokens a Morpho position has already
 * earned, out of Merkl's distributor and into the wallet.
 *
 * Ten of the seventeen are read-only; the seven execute tools sign and broadcast
 * real transactions from the user's wallet. Six of the seven are gated on a
 * fresh matching quote. `morpho.rewards.claim` is the exception and the reason
 * is structural rather than an oversight: a claim has no price, no slippage, no
 * counterparty and no size to choose, so there is nothing a quote could bind an
 * approval to. `pendle.claim` is exempt for the same reason and this namespace
 * mirrors it rather than inventing a second convention.
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
import { MORPHO_VAULT_QUOTE_TOOL } from "./manifests/vault-quote.js";
import { MORPHO_VAULT_DEPOSIT_TOOL } from "./manifests/vault-deposit.js";
import { MORPHO_VAULT_WITHDRAW_TOOL } from "./manifests/vault-withdraw.js";
import { MORPHO_MARKET_QUOTE_TOOL } from "./manifests/market-quote.js";
import { MORPHO_MARKET_SUPPLY_COLLATERAL_TOOL } from "./manifests/market-supply-collateral.js";
import { MORPHO_MARKET_WITHDRAW_COLLATERAL_TOOL } from "./manifests/market-withdraw-collateral.js";
import { MORPHO_MARKET_BORROW_TOOL } from "./manifests/market-borrow.js";
import { MORPHO_MARKET_REPAY_TOOL } from "./manifests/market-repay.js";
import { MORPHO_REWARDS_CLAIM_TOOL } from "./manifests/rewards-claim.js";

export const MORPHO_TOOLS: readonly ProtocolToolManifest[] = [
  MORPHO_MARKETS_DISCOVER_TOOL,
  MORPHO_MARKET_GET_TOOL,
  MORPHO_VAULTS_DISCOVER_TOOL,
  MORPHO_VAULT_GET_TOOL,
  MORPHO_POSITIONS_GET_TOOL,
  MORPHO_MARKETS_ACTIVITY_TOOL,
  MORPHO_REWARDS_GET_TOOL,
  MORPHO_WALLET_BALANCE_TOOL,
  MORPHO_VAULT_QUOTE_TOOL,
  MORPHO_VAULT_DEPOSIT_TOOL,
  MORPHO_VAULT_WITHDRAW_TOOL,
  MORPHO_MARKET_QUOTE_TOOL,
  MORPHO_MARKET_SUPPLY_COLLATERAL_TOOL,
  MORPHO_MARKET_WITHDRAW_COLLATERAL_TOOL,
  MORPHO_MARKET_BORROW_TOOL,
  MORPHO_MARKET_REPAY_TOOL,
  MORPHO_REWARDS_CLAIM_TOOL,
];
