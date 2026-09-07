/**
 * The Vex fee line on an approval card — one owner, one rate table, no guessing.
 *
 * WHY IT EXISTS. Until now the 25 bps Vex fee was itemised in front of a human
 * on exactly two surfaces: the launch form and a Jupiter approval card
 * (which carries its own richer `feeDisclosure` from the persisted prequote).
 * On an EVM swap or a bridge the fee sat INSIDE `amountIn`/`amountRaw` and the
 * approval card's allow-listed `criticalArgs` had no fee key at all — so a user
 * signed a fee they were never shown as a number. This module is the fee's
 * approval-card owner.
 *
 * TWO LINES, TWO SOURCES, AND THE SPLIT IS THE POINT.
 *
 *   {@link describeBoundVexFee} states what the MATCHED QUOTE committed to. The
 *   block reaches it on the typed `prequote.vexFee` channel, validated by the
 *   recorder, persisted on the quote row and covered by the row-disclosure
 *   digest. It derives no amount at all; it renders figures.
 *
 *   There is no second, args-derived path any more. It existed for exactly one
 *   retired launchpad tool whose SELL fee could not be stated at quote time
 *   (migration 108), and the derivation was deleted with it. Every remaining
 *   venue states its fee on the quote, so one card can never carry two
 *   derivations of one number.
 *
 * Neither reads a `fee` / `feeBps` / `feeReceiver` / `feeAmount` param. The
 * standing decree is that a model-chosen fee is an overcharge vector; the venues
 * already REJECT such a param by name, and this disclosure must not become the
 * one place a spoofed rate could appear in front of a human.
 *
 * DISPLAY ONLY. Nothing here computes, charges, orders, or authorizes a fee -
 * the venue writers own that, unchanged. The one arithmetic guarantee the
 * args-derived path makes is that it never lies by rounding:
 * `multiplyDecimalByBps` shifts the decimal point by exactly four places, so
 * `1.5` at 25 bps is exactly `0.00375`.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER, and why the list is now short:
 *   - every fee-bearing GATED venue - both bridges, both EVM swaps - states its
 *     fee ON ITS QUOTE now. That statement is validated, persisted in the
 *     prequote row, covered by the row-disclosure digest and carried to the card
 *     on the typed `prequote.vexFee` channel; {@link describeBoundVexFee}
 *     renders it. Recomputing those lines here would be a SECOND derivation of
 *     one money figure, which is the defect this split exists to remove: the
 *     args-derived Uniswap line multiplied a human decimal without the token's
 *     decimals, and no card ever expressed the executor's dust / fee-on-transfer
 *     / honeypot skip at all. Being name-independent, the channel also fixes the
 *     `SwapExecute` alias card, which carried no fee line whatsoever.
 *   - `solana.swap.execute` - Jupiter's own `feePreview` rides the same typed
 *     prequote channel and renders a richer disclosure (fee + tip + ATA rent).
 *   - `pools.launch_execute` - the launch FORM is
 *     the approval surface and already prints the fee; there is no card.
 *   - Pendle and Morpho - they carry no Vex fee, so they must not grow a line.
 *
 * WHAT IS LEFT HERE. One function: the quote-bound renderer. A venue that
 * cannot state its fee on the quote does not get an approval fee line invented
 * for it here.
 */

import {
  vexFeeOperationNoun,
  type VexFeePreview,
} from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

/** Renders "0.25% (25 bps)" from a whole-basis-point rate, without float error. */
function rateLabel(bps: number): string {
  return `${formatDecimal(BigInt(bps), 2)}% (${bps} bps)`;
}

/** Render a scaled bigint as a decimal string, trailing zeros trimmed. */
function formatDecimal(scaled: bigint, places: number): string {
  const digits = scaled.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/**
 * The Vex fee line for an approval card, rendered FROM THE MATCHED QUOTE's own
 * statement.
 *
 * This is the fee a person consents to and the fee the executor is held to,
 * because both read the same persisted block. Nothing here derives an amount: it
 * states the figures the quote committed to, and a figure the venue could not
 * state stays `null` and is described in words rather than guessed.
 *
 * The operation noun comes from the EXECUTE TOOL ID, never from the payload, so
 * an alias card says "swap" or "bridge" for the venue the router actually
 * picked. A tool id this build does not know still gets its full disclosure,
 * with the neutral noun - a fee statement is never dropped for want of a label.
 */
export function describeBoundVexFee(toolId: string, fee: VexFeePreview): string {
  const noun = vexFeeOperationNoun(toolId) ?? "transaction";
  const moved = noun === "bridge" ? "bridged" : noun === "swap" ? "swapped" : "sent";
  if (!fee.charged) {
    return `Vex fee: none on this ${noun} (${fee.reason}); `
      + `the full ${fee.totalDebitedRaw} raw units are ${moved}.`;
  }
  const collection = fee.collection === "inside_route"
    ? "inside this transaction"
    : `as a separate transfer after the ${noun} confirms`;
  // Units always beside raw numbers (rule 90). The human amount appears only
  // when the venue stated BOTH the decimal and the decimals it was computed at;
  // a symbol the venue could not state degrades to the token address rather
  // than leaving a bare number with nothing to read it by.
  const amount = fee.feeAmountDecimal !== null && fee.tokenDecimals !== null
    ? `${fee.feeAmountDecimal} ${fee.tokenSymbol ?? fee.tokenAddress} | ${fee.feeAmountRaw} raw units | ${fee.tokenDecimals} decimals`
    : `${fee.feeAmountRaw} raw units | human amount unavailable`;
  return `Vex fee ${rateLabel(fee.bps)}: ${amount}, taken on the input token ${collection}; `
    + `${fee.netAmountRaw} raw units are ${moved}; paid to ${fee.receiver}; `
    + "stated by the matched quote and re-checked before signing.";
}
