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
 * WHAT IT IS ALLOWED TO READ, and nothing else:
 *   - the RATE, imported from each venue's own product-owner constant
 *     (`KYBERSWAP_FEE_BPS`, `UNISWAP_FEE_BPS`, `BRIDGE_FEE_BPS`,
 *     `TRENCH_FEE_BPS`). The card can therefore never state a rate the executor
 *     does not charge — change the constant and this line changes with it.
 *   - the AMOUNT param the approval is already for, under the venue's own key.
 *     That is the same argument the card shows and the executor signs, so the
 *     fee shown is the fee that will be taken.
 * It reads NO `fee` / `feeBps` / `feeReceiver` / `feeAmount` param. The standing
 * decree is that a model-chosen fee is an overcharge vector; the venues already
 * REJECT such a param by name, and this disclosure must not become the one
 * place a spoofed rate could appear in front of a human.
 *
 * DISPLAY ONLY. Nothing here computes, charges, orders, or authorizes a fee —
 * the venue writers own that, unchanged. The one arithmetic guarantee this
 * module makes is that it never lies by rounding: `multiplyDecimalByBps` shifts
 * the decimal point by exactly four places, so `1.5 → 0.00375` is exact, and the
 * raw path reuses `splitAmountForFeeBps`, the single truncating bigint split
 * every venue already charges through.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER:
 *   - `solana.swap.execute` — Jupiter's own `feePreview` rides the typed
 *     prequote channel and already renders a richer disclosure (fee + tip + ATA
 *     rent). A second, poorer line would contradict it.
 *   - `trench.launch_execute` — the launch FORM is the approval surface and
 *     already prints the fee; there is no card.
 *   - Pendle — it carries no Vex fee, so it must not grow a fee line.
 */

import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { UNISWAP_FEE_BPS } from "@tools/uniswap/fee/index.js";
import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/index.js";
import { TRENCH_FEE_BPS } from "@tools/trench-express/fee/index.js";
import { splitAmountForFeeBps } from "@tools/vex-fee/bps-split.js";

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
  return `${rateLabel(spec.bps)} — ${fee} ${unit}. ${spec.tail}`;
}

function describeRawAmountFee(
  args: Record<string, unknown>,
  spec: { bps: number; amountKey: string; tokenKey: string },
): string | undefined {
  const amount = readStringParam(args, spec.amountKey);
  if (amount === undefined) return undefined;
  let split;
  try {
    split = splitAmountForFeeBps(amount, { bps: spec.bps });
  } catch {
    // An unreadable amount is the handler's refusal to make, not ours to
    // paper over with a number — the card simply carries no fee line.
    return undefined;
  }
  if (!split.charged) {
    return `${rateLabel(spec.bps)} on the input token — floors to zero at this size, `
      + "so no fee transfer is made at all.";
  }
  return `${rateLabel(spec.bps)} — ${split.feeRaw} raw units of ${spec.tokenKey}, `
    + `included in the ${spec.amountKey} above (the venue is quoted for the remainder).`;
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
      + "after the sale settles — the exact amount is not known until then, and if the ETH "
      + "proceeds cannot be decoded Vex takes no fee at all.";
  }
  return describeHumanAmountFee(args, {
    bps: TRENCH_FEE_BPS,
    amountKey: "amountIn",
    tokenKey: "tokenIn",
    tail: "Charged as a separate transfer that runs only after the trade confirms, so a trade "
      + "that does not happen is never charged; the curve is quoted for the remainder. This is "
      + "Vex's fee only — Trench's own 1% curve fee is separate and already inside the quote.",
  });
}

/**
 * The Vex fee line for an approval card, or `undefined` when this tool carries
 * no Vex fee, discloses it elsewhere, or its amount cannot be read.
 *
 * Tolerant reader by contract: absent means NO line — never a "0".
 */
export function describeApprovalVexFee(
  toolId: string,
  args: Record<string, unknown>,
): string | undefined {
  switch (toolId) {
    case "kyberswap.swap.execute":
      return describeHumanAmountFee(args, {
        bps: KYBERSWAP_FEE_BPS,
        amountKey: "amountIn",
        tokenKey: "tokenIn",
        tail: "Taken on the input token and included in the amountIn above — the route is "
          + "priced for the remainder, so the quoted output is already net of it.",
      });
    case "uniswap.swap.execute":
      return describeHumanAmountFee(args, {
        bps: UNISWAP_FEE_BPS,
        amountKey: "amountIn",
        tokenKey: "tokenIn",
        tail: "Taken on the input token as a separate transfer signed only after the swap "
          + "confirms, so a swap that fails is never charged; amountIn above is the total debited.",
      });
    case "relay.bridge":
    case "khalani.bridge":
      return describeRawAmountFee(args, {
        bps: BRIDGE_FEE_BPS,
        amountKey: "amountRaw",
        tokenKey: "fromToken",
      });
    case "trench.trade_execute":
      return describeTrenchTradeFee(args);
    default:
      return undefined;
  }
}
