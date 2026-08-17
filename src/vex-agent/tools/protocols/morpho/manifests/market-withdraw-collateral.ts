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
 * `morpho.market.withdrawCollateral` - pull collateral back off a Blue market.
 *
 * THE OPERATION MOST LIKELY TO BE UNDERESTIMATED. It reads like a withdrawal and
 * feels like taking back something that was always yours, but on a position that
 * still owes anything it REMOVES the support holding that debt away from
 * liquidation. The description leads with that, and the health-factor floor
 * refuses the ones that go too far.
 *
 * It is a DIRECT Morpho Blue call and pulls nothing from the wallet, so it
 * carries no approval and leaves no standing allowance.
 */
export const MORPHO_MARKET_WITHDRAW_COLLATERAL_TOOL: ProtocolToolManifest = {
  toolId: "morpho.market.withdrawCollateral",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "WITHDRAW COLLATERAL from one Morpho Blue market back into the wallet. This SPENDS gas and moves real funds: it "
    + "signs and broadcasts an on-chain transaction from the user's wallet and cannot be undone. IT MAKES A POSITION LESS "
    + "SAFE whenever any debt remains: collateral is what holds the debt away from liquidation, so removing it "
    + "LOWERS the health factor, and on a position with no debt at all it is simply taking the token back. Vex "
    + "refuses any withdrawal that would leave too little support behind. The collateral lands in the SIGNING "
    + "WALLET; there is no recipient parameter. "
    + `${MORPHO_MARKET_QUOTE_FIRST_SENTENCE} `
    + `${MORPHO_RECEIVING_CONSENT_SENTENCE} `
    + `${MORPHO_HEALTH_FLOOR_SENTENCE} `
    + `${MORPHO_ORACLE_VOUCHING_SENTENCE} `
    + `${MORPHO_NO_COMBO_SENTENCE} `
    + "To exit a position entirely, repay the debt to zero FIRST with `morpho.market.repay` and `repayFullDebt`, "
    + "then withdraw the collateral: the two are separate transactions and the repayment must land before the "
    + "withdrawal can take everything. "
    + `${MORPHO_ONE_LEG_SENTENCE} `
    + `${MORPHO_MARKET_LEDGER_SENTENCE} `
    + "RETURNS on success the transaction hash and the collateral amount PROVEN from the receipt's own event, at the "
    + "collateral token's own decimals. On any non-success it returns the REAL cause and what to do about it, never "
    + "a generic error.",
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
      key: "withdrawCollateralAmountRaw",
      type: "string",
      required: true,
      description:
        "How much COLLATERAL to withdraw, in the COLLATERAL token's RAW base units as a whole-number string. THE "
        + "SCALE IS THE COLLATERAL TOKEN'S OWN, not the loan token's: read `collateralAsset.decimals` from "
        + "`morpho.market.get`. A human decimal amount is refused, not rounded. Another operation's amount key is "
        + "refused by name. Quote first: on a position with debt this lowers the health factor.",
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
    withdrawCollateralAmountRaw: "50000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_BORROW_EXECUTE_DISCOVERY["morpho.market.withdrawCollateral"],
};
