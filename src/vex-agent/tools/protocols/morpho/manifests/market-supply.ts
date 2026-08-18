import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_BORROW_EXECUTE_DISCOVERY } from "../../embeddings/morpho/execute-borrow.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "../../slippage-policy.js";
import {
  MORPHO_LENDER_CHOICE_SENTENCE,
  MORPHO_LENDER_NO_HEALTH_SENTENCE,
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
} from "./market-execute-shared.js";

/**
 * `morpho.market.supply` - lend the loan asset into ONE Blue market, directly.
 *
 * THE LENDER'S SIDE, AND THE ONE PEOPLE CONFUSE WITH TWO OTHER TOOLS. It is not
 * `morpho.market.supplyCollateral`, which posts the OTHER token to back a loan
 * and earns nothing; and it is not `morpho.vault.deposit`, which hands the
 * market selection to a curator. The description separates all three by name,
 * because sending a lender's money into a collateral slot earns zero and sending
 * it to a vault pays a fee the direct route does not charge.
 *
 * THE ECONOMICS ARE STATED FROM MEASUREMENT, not from a preference. The curated
 * vaults on Base earn the same gross rate as this market because they allocate
 * INTO markets like it, and only the curator fee separates them; what the direct
 * route gives up is diversification and somebody watching the market for you.
 * Both halves are in the description so the agent can present a real choice.
 *
 * IT PULLS A TOKEN, so it carries the exact-amount approval and the
 * two-transaction consent model, exactly like a collateral supply.
 */
export const MORPHO_MARKET_SUPPLY_TOOL: ProtocolToolManifest = {
  toolId: "morpho.market.supply",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "SUPPLY the loan asset to one Morpho Blue market to EARN that market's own borrow rate, lending directly instead "
    + "of through a curated vault. This SPENDS real funds, signs and broadcasts on-chain transactions from the "
    + "user's wallet, and cannot be undone. THIS IS THE LENDER'S SIDE AND IT IS NOT COLLATERAL: it earns interest, "
    + "it backs nobody's loan, and it is a different token from the one "
    + "`morpho.market.supplyCollateral` moves. It is also NOT `morpho.vault.deposit`: a vault spreads the same money "
    + "over several markets under a curator who reallocates it, and charges a performance fee for doing so. "
    + `${MORPHO_LENDER_CHOICE_SENTENCE} `
    + `${MORPHO_LENDER_NO_HEALTH_SENTENCE} `
    + "WHAT THE POSITION ACTUALLY IS: supplied assets are accounted in SUPPLY SHARES, not an ERC-20 token, so nothing "
    + "is minted to the wallet and nothing shows up in a token balance. Read the position back with "
    + "`morpho.positions.get`. Interest accrues into the share price, so the amount withdrawable grows without any "
    + "further transaction. "
    + `${MORPHO_MARKET_QUOTE_FIRST_SENTENCE} `
    + `${MORPHO_PULLING_CONSENT_SENTENCE} `
    + `${MORPHO_ORACLE_VOUCHING_SENTENCE} `
    + "THE MARKET'S OWN RISK IS NOT DIVERSIFIED AWAY HERE: if this market's collateral collapses faster than "
    + "liquidators can act, the shortfall falls on the suppliers of THIS market, and there is no curator to move the "
    + "money out first. "
    + `${MORPHO_NO_COMBO_SENTENCE} `
    + `${MORPHO_ONE_LEG_SENTENCE} `
    + `${MORPHO_MARKET_LEDGER_SENTENCE} `
    + "RETURNS on success the transaction hash and the supplied amount PROVEN from the receipt's own event, at the "
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
      key: "supplyAmountRaw",
      type: "string",
      required: true,
      description:
        "How much of the LOAN asset to lend, in the LOAN token's RAW base units as a whole-number string. THE SCALE "
        + "IS THE LOAN TOKEN'S OWN, which is usually NOT the collateral token's: read `loanAsset.decimals` from "
        + "`morpho.market.get`. A human decimal amount is refused, not rounded. `supplyCollateralAmountRaw` is a "
        + "DIFFERENT operation on a DIFFERENT token and is refused by name rather than accepted here.",
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
    supplyAmountRaw: "1000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_BORROW_EXECUTE_DISCOVERY["morpho.market.supply"],
};
