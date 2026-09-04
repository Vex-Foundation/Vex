/**
 * The Vex fee line on an approval card — one owner, one rate table, no guessing.
 *
 * WHY IT EXISTS. Until now the 25 bps Vex fee was itemised in front of a human
 * on exactly two surfaces: the Trench launch form and a Jupiter approval card
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
 *   {@link describeApprovalVexFee} is what is left for the one tool whose fee
 *   cannot exist at quote time, and it reads only the RATE (from the venue's own
 *   product-owner constant `TRENCH_FEE_BPS`, so the card can never state a rate
 *   the executor does not charge) and the AMOUNT param the approval is already
 *   for.
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
 *   - `trench.launch_execute` and `pools.launch_execute` - the launch FORM is
 *     the approval surface and already prints the fee; there is no card.
 *   - Pendle and Morpho - they carry no Vex fee, so they must not grow a line.
 *
 * WHAT IS LEFT HERE. Exactly one tool: `trench.trade_execute`. Its SELL fee is
 * 25 bps of the ETH RECEIVED, which does not exist until the trade settles, so
 * there is no quote-time statement to bind and the honest line is the one that
 * says so.
 */

import { TRENCH_FEE_BPS } from "@tools/trench-express/fee/index.js";
import {
  vexFeeOperationNoun,
  type VexFeePreview,
} from "@vex-agent/tools/protocols/prequote/fee-disclosure.js";

/** Renders "0.25% (25 bps)" from a whole-basis-point rate, without float error. */
function rateLabel(bps: number): string {
  return `${formatDecimal(BigInt(bps), 2)}% (${bps} bps)`;
}

/**
 * Multiply a human decimal amount by a basis-point rate, EXACTLY.
 *
 * `bps/10000` is a shift of four decimal places, so the product's digits are
 * `digits × bps` and its scale is `places + 4`. No division, no rounding, no
 * `Number` — a 78-digit amount is as exact as a 1-digit one. Returns `null` for
 * anything that is not a plain non-negative decimal (scientific notation, a
 * sign, whitespace-only), because a fee derived from an amount we cannot read
 * is a fabricated fee.
 */
function multiplyDecimalByBps(amount: string, bps: number): string | null {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const dot = trimmed.indexOf(".");
  const places = dot === -1 ? 0 : trimmed.length - dot - 1;
  const digits = dot === -1 ? trimmed : trimmed.slice(0, dot) + trimmed.slice(dot + 1);
  return formatDecimal(BigInt(digits) * BigInt(bps), places + 4);
}

/** Render a scaled bigint as a decimal string, trailing zeros trimmed. */
function formatDecimal(scaled: bigint, places: number): string {
  const digits = scaled.toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Read a param that must be a non-empty string, or nothing. */
function readStringParam(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The human unit a fee amount is denominated in. A token ADDRESS is not a unit
 * a person can read, and the card already shows `tokenIn`/`fromToken` on its own
 * line, so an address degrades to the param NAME rather than being repeated.
 */
function unitLabel(token: string | undefined, tokenKey: string): string {
  if (token === undefined) return `of the ${tokenKey} above`;
  const native = token.toUpperCase();
  if (native === "ETH" || native === "NATIVE") return "ETH";
  return `of the ${tokenKey} above`;
}

function describeHumanAmountFee(
  args: Record<string, unknown>,
  spec: { bps: number; amountKey: string; tokenKey: string; tail: string },
): string | undefined {
  const amount = readStringParam(args, spec.amountKey);
  if (amount === undefined) return undefined;
  const fee = multiplyDecimalByBps(amount, spec.bps);
  if (fee === null) return undefined;
  const unit = unitLabel(readStringParam(args, spec.tokenKey), spec.tokenKey);
  return `${rateLabel(spec.bps)}: ${fee} ${unit}. ${spec.tail}`;
}

/**
 * A Trench curve trade is asymmetric and the asymmetry is user-visible money.
 * A BUY's base is the ETH spent, known exactly before signing. A SELL's base is
 * the ETH RECEIVED, which does not exist until the trade settles — and if the
 * proceeds cannot be decoded Vex takes no fee at all. Claiming a sell number
 * here would put 25 bps of an estimate in front of a human as if it were fact.
 */
function describeTrenchTradeFee(args: Record<string, unknown>): string | undefined {
  const isBuy = readStringParam(args, "tokenIn")?.toUpperCase() === "ETH";
  if (!isBuy) {
    return `${rateLabel(TRENCH_FEE_BPS)} on the ETH you receive, charged as a separate transfer `
      + "after the sale settles. The exact amount is not known until then, and if the ETH "
      + "proceeds cannot be decoded Vex takes no fee at all.";
  }
  return describeHumanAmountFee(args, {
    bps: TRENCH_FEE_BPS,
    amountKey: "amountIn",
    tokenKey: "tokenIn",
    tail: "Charged as a separate transfer that runs only after the trade confirms, so a trade "
      + "that does not happen is never charged; the curve is quoted for the remainder. This is "
      + "Vex's fee only; Trench's own 1% curve fee is separate and already inside the quote.",
  });
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

/**
 * The Vex fee line for a tool whose fee cannot be stated at quote time, or
 * `undefined` when this tool carries no such fee.
 *
 * Tolerant reader by contract: absent means NO line - never a "0". Every venue
 * whose quote CAN state its fee is served by {@link describeBoundVexFee}
 * instead, and is deliberately absent from this switch so one card can never
 * carry two derivations of one number.
 */
export function describeApprovalVexFee(
  toolId: string,
  args: Record<string, unknown>,
): string | undefined {
  switch (toolId) {
    case "trench.trade_execute":
      return describeTrenchTradeFee(args);
    default:
      return undefined;
  }
}
