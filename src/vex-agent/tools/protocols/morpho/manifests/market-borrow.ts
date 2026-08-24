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
 * `morpho.market.borrow` - take a loan against collateral already posted.
 *
 * THE MOST DANGEROUS TOOL IN THE NAMESPACE. It is the only operation that
 * CREATES a liquidation risk that did not exist before, and the description
 * leads with that rather than burying it. Two gates stand in front of it and
 * both are named: the health-factor floor, re-checked immediately before
 * signing, and the market's free liquidity, which no amount of collateral can
 * substitute for.
 *
 * IT IS A DIRECT MORPHO BLUE CALL, not a bundle, and that is a safety property
 * worth stating in an agent-facing description: the bundled borrow would require
 * granting GeneralAdapter1 a standing authorization over the wallet's entire
 * Morpho position on every market on the chain. Vex never grants it, so a borrow
 * carries no approval and leaves no standing allowance behind at all.
 */
export const MORPHO_MARKET_BORROW_TOOL: ProtocolToolManifest = {
  toolId: "morpho.market.borrow",
  publicName: "morpho__market_borrow",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "BORROW the loan token from one Morpho Blue market against collateral the wallet has ALREADY supplied to that "
    + "same market. This SPENDS real funds, signs and broadcasts an on-chain transaction from the user's wallet, and "
    + "cannot be undone. THIS IS THE ONE OPERATION THAT CREATES LIQUIDATION RISK: the position begins owing interest "
    + "immediately, the debt grows every block, and if the collateral's price falls far enough the position is "
    + "liquidated. Say that plainly before running it. The borrowed token lands in the SIGNING WALLET; there is no "
    + "recipient parameter and no way to send it elsewhere. "
    + `${MORPHO_MARKET_QUOTE_FIRST_SENTENCE} `
    + `${MORPHO_RECEIVING_CONSENT_SENTENCE} `
    + `${MORPHO_HEALTH_FLOOR_SENTENCE} `
    + "LIQUIDITY IS A SEPARATE LIMIT: a borrow larger than the market's free liquidity (total supplied minus total "
    + "borrowed, in the loan token) is refused no matter how healthy the position is, and supplying more collateral "
    + "does not help. "
    + `${MORPHO_ORACLE_VOUCHING_SENTENCE} `
    + `${MORPHO_NO_COMBO_SENTENCE} `
    + `${MORPHO_ONE_LEG_SENTENCE} `
    + `${MORPHO_MARKET_LEDGER_SENTENCE} `
    + "RETURNS on success the transaction hash and the borrowed amount PROVEN from the receipt's own event, at the "
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
      key: "borrowAmountRaw",
      type: "string",
      required: true,
      description:
        "How much to borrow, in the LOAN token's RAW base units as a whole-number string. THE SCALE IS THE LOAN "
        + "TOKEN'S OWN, which is usually NOT the collateral token's: read `loanAsset.decimals` from "
        + "`morpho__market_get`. A human decimal amount is refused, not rounded. Another operation's amount key is "
        + "refused by name. Quote first to see where this leaves the health factor before committing to a size.",
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
    borrowAmountRaw: "500000000",
    slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
  },
  discovery: MORPHO_BORROW_EXECUTE_DISCOVERY["morpho.market.borrow"],
};
