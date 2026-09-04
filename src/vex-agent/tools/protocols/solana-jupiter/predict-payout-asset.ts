/**
 * The ONE place the prediction PAYOUT asset is stated for the handler layer
 * (phase-3 W2, live-gate DEFECT 7) - the `agent_activity` out-leg identity and
 * the agent-facing sentence that goes with it.
 *
 * It exists because three call sites needed the same three facts and had all
 * three wrong in the same way: `predict-execute.ts`'s sell and claim, and
 * `predict-execute-close-all.ts`'s close and claim items, each hardcoded
 * `USDC / 6 / EPjFWdd5…` for a leg the protocol pays in JupUSD. One constant
 * cannot drift out of sync with itself.
 *
 * NO AMOUNT LIVES HERE, DELIBERATELY. What the provider's order preview
 * returns (`newPayoutUsd`, `payoutAmountUsd`) is a USD-DENOMINATED ESTIMATE,
 * not a chain-proven atomic quantity. It was previously written verbatim into
 * `amountRaw`, which only ever looked right because JupUSD happens to be
 * 6-decimal and dollar-pegged - a coincidence, not a proof. Until the phase-4
 * keeper/order-status lane can read the real settled quantity, the row carries
 * the payout ASSET plus the USD estimate in `usd_out_est` (which is honestly
 * labelled as an estimate) and NO raw/human token amount at all. An absent
 * amount reads as "not known yet"; a fabricated one reads as settlement.
 */

import {
  JUPITER_PREDICTION_PAYOUT_DECIMALS,
  JUPITER_PREDICTION_PAYOUT_MINT,
  JUPITER_PREDICTION_PAYOUT_SYMBOL,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";

/**
 * The out-leg token IDENTITY for every prediction payout row. Amount fields
 * are intentionally absent - see the module doc.
 */
export const PREDICTION_PAYOUT_LEG = {
  tokenAddress: JUPITER_PREDICTION_PAYOUT_MINT,
  tokenSymbol: JUPITER_PREDICTION_PAYOUT_SYMBOL,
  tokenDecimals: JUPITER_PREDICTION_PAYOUT_DECIMALS,
} as const;

/** Machine-readable payout-asset identity for a tool result's `data`, so the agent does not have to parse prose. */
export const PREDICTION_PAYOUT_ASSET = {
  mint: JUPITER_PREDICTION_PAYOUT_MINT,
  symbol: JUPITER_PREDICTION_PAYOUT_SYMBOL,
  decimals: JUPITER_PREDICTION_PAYOUT_DECIMALS,
} as const;

/**
 * The agent-facing settlement sentence appended to every payout broadcast.
 *
 * Written for an autonomous agent mid-mission with nobody to ask, so it states
 * three things it can act on: which asset actually arrives, that the amount is
 * not knowable from this transaction (so a missing amount is not a bug to
 * retry), and the concrete next tool call if USDC is what the mission needs.
 */
export const PREDICTION_PAYOUT_SETTLEMENT_NOTE =
  `Payout settles in ${JUPITER_PREDICTION_PAYOUT_SYMBOL} `
  + `(mint ${JUPITER_PREDICTION_PAYOUT_MINT}, ${JUPITER_PREDICTION_PAYOUT_DECIMALS} decimals), `
  + "not USDC, and it arrives in a later keeper transaction rather than this one - "
  + "the settled amount is unknown until it lands, so no payout amount is recorded yet. "
  + `Use solana__swap_execute to convert ${JUPITER_PREDICTION_PAYOUT_SYMBOL} to USDC once it arrives.`;
