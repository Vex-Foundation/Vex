import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_BORROW_EXECUTE_DISCOVERY } from "../../embeddings/morpho/execute-borrow.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";
import {
  MORPHO_HEALTH_FLOOR_SENTENCE,
  MORPHO_MARKET_CHAIN_PARAM,
  MORPHO_MARKET_DRY_RUN_PARAM,
  MORPHO_MARKET_ID_PARAM,
  MORPHO_MARKET_LEDGER_SENTENCE,
  MORPHO_MARKET_QUOTE_FIRST_SENTENCE,
  MORPHO_MARKET_SLIPPAGE_PARAM,
  MORPHO_NO_COMBO_SENTENCE,
  MORPHO_ONE_LEG_SENTENCE,
  MORPHO_ORACLE_VOUCHING_SENTENCE,
  MORPHO_PULLING_CONSENT_SENTENCE,
  MORPHO_RECEIVING_CONSENT_SENTENCE,
} from "./market-execute-shared.js";

/**
 * `morpho.market.supplyCollateral` - move the wallet's own token onto a Blue
 * market as collateral.
 *
 * THE SAFE HALF OF A BORROW, and the description says so plainly: adding
 * collateral can only move a position AWAY from liquidation, which is why it is
 * the one operation of the four whose health-factor projection can never be the
 * reason it is refused. It still spends real funds and it still pulls a token,
 * so it carries the exact-amount approval and the two-transaction consent model.
 *
 * COLLATERAL IS NOT A DEPOSIT and the first sentence exists to stop that
 * conflation: it earns no yield, it is not the vault lane, and a user who wanted
 * to earn on their asset wants `morpho.vault.deposit` instead.
 */
export const MORPHO_MARKET_SUPPLY_COLLATERAL_TOOL: ProtocolToolManifest = {
  toolId: "morpho.market.supplyCollateral",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "SUPPLY COLLATERAL to one Morpho Blue market: move the wallet's own token onto the market to back a loan. This "
    + "SPENDS real funds, signs and broadcasts on-chain transactions from the user's wallet, and cannot be undone. "
    + "COLLATERAL IS NOT A DEPOSIT AND EARNS NOTHING: it sits on the market to support borrowing and to hold the "
    + "position away from liquidation. A user who wants to EARN on an asset wants `morpho.vault.deposit` instead. "
    + "This is the only one of the four market operations that can never make a position less safe, because adding "
    + "collateral only ever raises the health factor. "
    + `${MORPHO_MARKET_QUOTE_FIRST_SENTENCE} `
    + `${MORPHO_PULLING_CONSENT_SENTENCE} `
    + `${MORPHO_ORACLE_VOUCHING_SENTENCE} `
    + `${MORPHO_HEALTH_FLOOR_SENTENCE} `
    + `${MORPHO_NO_COMBO_SENTENCE} `
    + `${MORPHO_ONE_LEG_SENTENCE} `
    + `${MORPHO_MARKET_LEDGER_SENTENCE} `
    + "RETURNS on success the transaction hash and the collateral amount PROVEN from the receipt's own event, at the "
    + "collateral token's own decimals. On any non-success it returns the REAL cause and what to do about it, never a "
    + "generic error.",
  mutating: true,
  actionKind: "user_wallet_broadcast",
  params: [
    {
      key: "marketId",
      type: "string",
      required: true,
      description: MORPHO_MARKET_ID_PARAM,
    },
    {
      key: "chain",
      type: "string",
      required: true,
      description: `${MORPHO_MARKET_CHAIN_PARAM} ${CANONICAL_CHAIN_SENTENCE}`,
    },
    {
      key: "supplyCollateralAmountRaw",
      type: "string",
      required: true,
      description:
        "How much COLLATERAL to supply, in the COLLATERAL token's RAW base units as a whole-number string. THE SCALE "
        + "IS THE COLLATERAL TOKEN'S OWN, which is usually NOT the loan token's: read `collateralAsset.decimals` "
        + "from `morpho.market.get`. A market pairing 8-decimal cbBTC against 6-decimal USDC will silently accept a "
        + "loan-scaled number as a hundredfold wrong amount, so read the scale rather than assuming it. A human "
        + "decimal amount is refused, not rounded. Another operation's amount key is refused by name.",
    },
    {
      key: "slippageBps",
      type: "number",
      unit: "bps",
      description: MORPHO_MARKET_SLIPPAGE_PARAM,
    },
    {
      key: "dryRun",
      type: "boolean",
      description: MORPHO_MARKET_DRY_RUN_PARAM,
    },
  ],
  exampleParams: {
    marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
    chain: "base",
    supplyCollateralAmountRaw: "50000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_BORROW_EXECUTE_DISCOVERY["morpho.market.supplyCollateral"],
};
