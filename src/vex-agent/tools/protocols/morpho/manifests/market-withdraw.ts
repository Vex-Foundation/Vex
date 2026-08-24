import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_BORROW_EXECUTE_DISCOVERY } from "../../embeddings/morpho/execute-borrow.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";
import {
  MORPHO_LENDER_NO_HEALTH_SENTENCE,
  MORPHO_LENDER_WITHDRAW_BOUNDS_SENTENCE,
  MORPHO_MARKET_CHAIN_PARAM,
  MORPHO_MARKET_DRY_RUN_PARAM,
  MORPHO_MARKET_ID_PARAM,
  MORPHO_MARKET_LEDGER_SENTENCE,
  MORPHO_MARKET_QUOTE_FIRST_SENTENCE,
  MORPHO_MARKET_SLIPPAGE_PARAM,
  MORPHO_NO_COMBO_SENTENCE,
  MORPHO_ONE_LEG_SENTENCE,
  MORPHO_ORACLE_VOUCHING_SENTENCE,
  MORPHO_RECEIVING_CONSENT_SENTENCE,
} from "./market-execute-shared.js";

/**
 * `morpho.market.withdraw` - take lent assets back out of ONE Blue market.
 *
 * THE MIRROR OF `morpho.market.supply`, and the operation with a limit the vault
 * lane rarely shows: a direct supplier's money can be BORROWED, and borrowed
 * money is not available to withdraw. The description names that bound and the
 * position bound separately, because they fail for different reasons and the
 * remedy differs (wait for a repayment, versus you simply do not have that much).
 *
 * IT PULLS NOTHING FROM THE WALLET, so it is a single direct Morpho Blue call
 * with no approval and no standing allowance, exactly like a collateral
 * withdrawal.
 *
 * IT DELIBERATELY DOES NOT CARRY `MORPHO_LENDER_CHOICE_SENTENCE` (Batch 3, D8).
 * The measured direct-versus-curated fee table is the copy that decides where to
 * PUT money, and it already ships on the three surfaces where that decision is
 * live: `morpho.market.supply`, `morpho.vaults.discover`, and the Morpho
 * doctrine in the system prompt. On the EXIT the choice has already been made,
 * so ~610 bytes of it were persuading the model to re-litigate a decision the
 * user is walking away from.
 */
export const MORPHO_MARKET_WITHDRAW_TOOL: ProtocolToolManifest = {
  toolId: "morpho.market.withdraw",
  publicName: "morpho__market_withdraw",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "WITHDRAW assets previously SUPPLIED to one Morpho Blue market back into the wallet, ending or reducing the "
    + "lender position. This SPENDS gas and moves real funds: it signs and broadcasts an on-chain transaction from "
    + "the user's wallet and cannot be undone. THIS IS THE LENDER'S SIDE: it withdraws the LOAN asset that was lent "
    + "to earn interest, NOT the collateral backing a loan, which is `morpho__market_withdraw_collateral` on a "
    + "different token. It is also not `morpho__vault_withdraw`, which redeems from a curated vault. "
    + `${MORPHO_LENDER_NO_HEALTH_SENTENCE} `
    + `${MORPHO_LENDER_WITHDRAW_BOUNDS_SENTENCE} `
    + "The amount withdrawable is the supplied principal PLUS the interest accrued into the share price, so it is "
    + "normally larger than what was supplied; read it from `morpho__positions_get` rather than from memory of the "
    + "deposit. "
    + `${MORPHO_MARKET_QUOTE_FIRST_SENTENCE} `
    + `${MORPHO_RECEIVING_CONSENT_SENTENCE} `
    + `${MORPHO_ORACLE_VOUCHING_SENTENCE} `
    + `${MORPHO_NO_COMBO_SENTENCE} `
    + `${MORPHO_ONE_LEG_SENTENCE} `
    + `${MORPHO_MARKET_LEDGER_SENTENCE} `
    + "RETURNS on success the transaction hash and the withdrawn amount PROVEN from the receipt's own event, at the "
    + "loan token's own decimals. On any non-success it returns the REAL cause and what to do about it, never a "
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
      key: "withdrawAmountRaw",
      type: "string",
      required: true,
      description:
        "How much of the LOAN asset to withdraw, in the LOAN token's RAW base units as a whole-number string. THE "
        + "SCALE IS THE LOAN TOKEN'S OWN: read `loanAsset.decimals` from `morpho__market_get`. A human decimal amount "
        + "is refused, not rounded. `withdrawCollateralAmountRaw` is a DIFFERENT operation on a DIFFERENT token and "
        + "is refused by name. An amount above the supplied position, or above the market's free liquidity, is "
        + "refused by name rather than reduced to what would fit.",
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
    withdrawAmountRaw: "1000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_BORROW_EXECUTE_DISCOVERY["morpho.market.withdraw"],
};
