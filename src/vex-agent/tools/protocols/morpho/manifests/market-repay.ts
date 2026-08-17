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
 * `morpho.market.repay` - pay debt down, partly or all the way to zero.
 *
 * THE ONE MANIFEST WITH TWO GENUINELY DIFFERENT MODES, and conflating them is
 * the money bug this description exists to prevent. An ASSETS repayment repays
 * the amount it names and CANNOT close a debt: interest accrues between the
 * block the amount was computed and the block the transaction lands, so a
 * residue of dust survives, keeps accruing, and keeps the collateral locked. The
 * fork proved it to the unit on 2026-08-17: borrowing exactly 500,000,000 raw
 * USDC produced a debt of 500,000,001. Only a SHARES repayment, which
 * `repayFullDebt` routes to, burns the exact share count and lands at zero.
 *
 * THE SWEEP IS STATED, NOT HIDDEN. A shares repayment cannot know its asset cost
 * in advance, so the bundle pulls slightly more than the debt and returns the
 * residual in the same transaction. An agent that did not know that would report
 * the pull as the cost.
 */
export const MORPHO_MARKET_REPAY_TOOL: ProtocolToolManifest = {
  toolId: "morpho.market.repay",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "REPAY debt on one Morpho Blue market, partly or completely. This SPENDS real funds, signs and broadcasts "
    + "on-chain transactions from the user's wallet, and cannot be undone. Repaying RAISES the health factor and "
    + "moves the position away from liquidation. TWO MODES AND THEY ARE NOT INTERCHANGEABLE: `repayFullDebt: true` "
    + "closes the debt COMPLETELY by burning the position's exact borrow shares, which is the ONLY way to reach "
    + "zero; naming `repayAmountRaw` repays exactly that much and LEAVES THE POSITION OPEN. An amount can never "
    + "close a debt, because interest accrues between the block it is computed and the block it lands, leaving dust "
    + "that keeps accruing and keeps the collateral locked. An amount large enough to cover the whole debt is "
    + "REFUSED BY NAME rather than silently leaving that dust behind. "
    + "THE FULL-DEBT MODE SWEEPS: because the assets those shares cost accrue, the bundle pulls slightly MORE than "
    + "the debt and returns the residual to the wallet in the same transaction, and the approval is sized to the "
    + "ceiling those shares can cost at the approved slippage rather than to one build's transfer amount. Report the "
    + "PROVEN settled amount, never the pull. "
    + `${MORPHO_MARKET_QUOTE_FIRST_SENTENCE} `
    + `${MORPHO_PULLING_CONSENT_SENTENCE} `
    + `${MORPHO_ORACLE_VOUCHING_SENTENCE} `
    + `${MORPHO_HEALTH_FLOOR_SENTENCE} `
    + `${MORPHO_NO_COMBO_SENTENCE} `
    + `${MORPHO_ONE_LEG_SENTENCE} `
    + `${MORPHO_MARKET_LEDGER_SENTENCE} `
    + "RETURNS on success the transaction hash and the amount that actually left the wallet, PROVEN from the "
    + "receipt's own event at the loan token's own decimals. On any non-success it returns the REAL cause and what "
    + "to do about it, never a generic error.",
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
      key: "repayAmountRaw",
      type: "string",
      description:
        "How much debt to repay, in the LOAN token's RAW base units as a whole-number string. Read "
        + "`loanAsset.decimals` from `morpho.market.get` for the scale. Required UNLESS `repayFullDebt` is true, and "
        + "supplying BOTH is refused because they disagree about how much debt to clear. A human decimal amount is "
        + "refused, not rounded. An amount at or above the current debt is refused by name: use `repayFullDebt` "
        + "instead, because an assets repayment cannot reach zero.",
    },
    {
      key: "repayFullDebt",
      type: "boolean",
      description:
        "Set true to close the debt COMPLETELY. It routes the repayment through borrow SHARES, reading the "
        + "position's own share count from the chain and burning exactly that, which is the only denomination that "
        + "lands at zero. Do not combine it with `repayAmountRaw`. The wallet must hold enough of the loan token to "
        + "cover the ceiling those shares can cost; the excess is swept back in the same transaction.",
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
    repayFullDebt: true,
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_BORROW_EXECUTE_DISCOVERY["morpho.market.repay"],
};
