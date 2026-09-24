/**
 * Whether one risk-increasing Lighter order can pass Lighter's OWN post-trade
 * margin check, and the largest size that would.
 *
 * Lighter checks every match against account health: after the trade the
 * account's value (collateral, minus fees, plus unrealized PnL at the MARK
 * price) must still cover the initial margin of its positions at the mark
 * price (Lighter docs: "Order Types & Matching", Order Margin; "Multi-Asset
 * Margin", Health Checks). A match that fails is cancelled as
 * `canceled-margin-not-allowed`, with no fill.
 *
 * So an order that matches now needs, out of the available balance:
 * - initial margin on the new exposure at the mark price,
 * - the fee on what it trades, at the larger of the market's fee and THIS
 *   account's exchange tier, plus Vex's integrator fee, and
 * - the gap between its average fill and the mark, which the exchange books as
 *   an immediate loss (a buy filling at the ask while the mark sits below it).
 * The tier and the gap were both missing on 2026-09-24, when every ETH order
 * sized at the ticket's 100% on account 31824 was cancelled with no fill: the
 * market's `taker_fee` read 0 while the account's Premium tier charged 0.035%.
 *
 * A resting order is margined at its own price, which is where it fills.
 *
 * An order that first closes an opposite position frees that position's
 * initial margin in the same trade, while it pays fees and books the fill gap
 * on everything it trades. Counting only the new exposure against the
 * available balance refused flips Lighter accepts.
 */

import { LIGHTER_CAPITAL_UNITS_DECIMALS } from "./capital-share.js";
import { LIGHTER_MARGIN_FRACTION_TICK } from "./margin-fraction.js";

/**
 * Exchange fee ticks assumed when the account's own tier cannot be read. They
 * sit above every tier Vex moves an account onto (FEE_LAUNCH.md: Robinhood
 * Chain Premium is up to 0.0120% maker / 0.0350% taker, Core Plus is 0.005%),
 * so an unread tier over-reserves instead of falling back to the market's
 * published fee.
 */
export const LIGHTER_UNREAD_EXCHANGE_FEE_TICKS = { maker: 200, taker: 500 } as const;

/** Fee ticks are hundredths of a basis point: `fee = notional * ticks / 1_000_000`. */
const FEE_TICK_DENOMINATOR = 1_000_000n;

export interface LighterBookLevelInteger {
  readonly priceInteger: string;
  readonly sizeInteger: string;
}

export interface LighterOrderMarginFitInput {
  readonly side: "buy" | "sell";
  /** Base units that ADD exposure: the order size minus any opposite position it closes first. */
  readonly increasingBaseInteger: string;
  /** Base units of an opposite position this order closes before adding exposure; "0" when none. */
  readonly closingBaseInteger?: string;
  /** The approved price at the market's price decimals: a limit price or a market order's bound. */
  readonly approvedPriceInteger: string;
  /**
   * True when the order matches now (a market order, or a limit that crosses
   * the book). Null when that is unknown, which is priced as matching now.
   */
  readonly takesLiquidity: boolean | null;
  /**
   * The levels it would match against, best first: asks for a buy, bids for a
   * sell. Size past the listed depth, or with no book at all, fills at the
   * order's own bound.
   */
  readonly bookLevels: readonly LighterBookLevelInteger[] | null;
  /** The market's mark price as a decimal string, or null when it was not reported. */
  readonly markPrice: string | null;
  readonly sizeDecimals: number;
  readonly priceDecimals: number;
  /** On Lighter's 10000 scale. */
  readonly initialMarginFraction: number;
  /** The market's own `taker_fee` percent string. */
  readonly exchangeTakerFeePercent: string;
  /** This account's `current_taker_fee_tick`, or {@link LIGHTER_UNREAD_EXCHANGE_FEE_TICKS}. */
  readonly exchangeAccountTakerFeeTicks: number;
  readonly vexIntegratorTakerFeeTicks: number | null;
  /** The account's `available_balance` decimal string. */
  readonly availableBalance: string;
}

/** Every figure in settlement units (6 decimals) as an integer string. */
export interface LighterOrderMarginFit {
  readonly fits: boolean;
  readonly requiredUnits: string;
  readonly initialMarginUnits: string;
  readonly feeUnits: string;
  readonly markGapUnits: string;
  /** Initial margin the closed opposite position frees in the same trade. */
  readonly releasedMarginUnits: string;
  readonly availableUnits: string;
  /** Largest increasing base that fits, in base units; "0" when none does. */
  readonly maxIncreasingBaseInteger: string;
}

interface Requirement {
  readonly total: bigint;
  readonly initialMargin: bigint;
  readonly fees: bigint;
  readonly markGap: bigint;
  readonly released: bigint;
}

interface Terms {
  readonly side: "buy" | "sell";
  readonly closing: bigint;
  readonly bound: bigint;
  readonly matchesNow: boolean;
  readonly levels: readonly { readonly price: bigint; readonly size: bigint }[];
  readonly markUp: bigint | null;
  readonly markDown: bigint | null;
  readonly quoteDecimals: number;
  readonly imf: bigint;
  readonly feeTicks: bigint;
}

export function assessLighterOrderMarginFit(input: LighterOrderMarginFitInput): LighterOrderMarginFit {
  const terms = resolveTerms(input);
  const base = parseUnsignedInteger(input.increasingBaseInteger, "increasingBaseInteger");
  const available = availableUnits(input.availableBalance);
  const requirement = requirementFor(terms, base);
  const fits = requirement.total <= available;
  return {
    fits,
    requiredUnits: requirement.total.toString(),
    initialMarginUnits: requirement.initialMargin.toString(),
    feeUnits: requirement.fees.toString(),
    markGapUnits: requirement.markGap.toString(),
    releasedMarginUnits: requirement.released.toString(),
    availableUnits: available.toString(),
    maxIncreasingBaseInteger: (fits ? base : largestFittingBase(terms, base, available)).toString(),
  };
}

function resolveTerms(input: LighterOrderMarginFitInput): Terms {
  const imf = input.initialMarginFraction;
  if (!Number.isInteger(imf) || imf <= 0 || imf > LIGHTER_MARGIN_FRACTION_TICK) {
    throw new RangeError(`initialMarginFraction ${String(imf)} is not on Lighter's 1..${LIGHTER_MARGIN_FRACTION_TICK} scale.`);
  }
  for (const [name, ticks] of [
    ["exchangeAccountTakerFeeTicks", input.exchangeAccountTakerFeeTicks],
    ["vexIntegratorTakerFeeTicks", input.vexIntegratorTakerFeeTicks ?? 0],
  ] as const) {
    if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 1_000_000) {
      throw new RangeError(`${name} ${String(ticks)} is outside Lighter's fee-tick range.`);
    }
  }
  const marketTicks = decimalToScaled(input.exchangeTakerFeePercent, 4, "ceil");
  if (marketTicks === null || marketTicks < 0n) {
    throw new RangeError(`market taker_fee "${input.exchangeTakerFeePercent}" is not a fee percent.`);
  }
  const accountTicks = BigInt(input.exchangeAccountTakerFeeTicks);
  const bound = parseUnsignedInteger(input.approvedPriceInteger, "approvedPriceInteger");
  // Only levels the order's own bound lets it reach.
  const levels = (input.bookLevels ?? [])
    .map((level) => ({
      price: parseUnsignedInteger(level.priceInteger, "book price"),
      size: parseUnsignedInteger(level.sizeInteger, "book size"),
    }))
    .filter((level) => level.size > 0n && (input.side === "buy" ? level.price <= bound : level.price >= bound));
  return {
    side: input.side,
    closing: parseUnsignedInteger(input.closingBaseInteger ?? "0", "closingBaseInteger"),
    bound,
    matchesNow: input.takesLiquidity ?? true,
    levels,
    markUp: input.markPrice === null ? null : decimalToScaled(input.markPrice, input.priceDecimals, "ceil"),
    markDown: input.markPrice === null ? null : decimalToScaled(input.markPrice, input.priceDecimals, "floor"),
    quoteDecimals: input.sizeDecimals + input.priceDecimals,
    imf: BigInt(imf),
    feeTicks: (accountTicks > marketTicks ? accountTicks : marketTicks) + BigInt(input.vexIntegratorTakerFeeTicks ?? 0),
  };
}

function requirementFor(terms: Terms, base: bigint): Requirement {
  if (base === 0n) return { total: 0n, initialMargin: 0n, fees: 0n, markGap: 0n, released: 0n };
  // Everything the order trades, closing part included, at the market's quote scale.
  const tradedBase = terms.closing + base;
  const traded = terms.matchesNow ? fillNotional(terms, tradedBase) : tradedBase * terms.bound;
  // Initial margin follows the mark once the order has matched. Without a mark
  // a buy is priced at its bound, the most it can pay, and a sell at its
  // average fill, since its own price is only a floor.
  const marginPrice = !terms.matchesNow
    ? terms.bound
    : terms.markUp ?? (terms.side === "buy" ? terms.bound : ceilDiv(traded, tradedBase));
  let gap = 0n;
  if (terms.matchesNow && terms.markUp !== null && terms.markDown !== null) {
    gap = terms.side === "buy" ? traded - tradedBase * terms.markDown : tradedBase * terms.markUp - traded;
    if (gap < 0n) gap = 0n;
  }
  const initialMargin = toUnitsUp(ceilDiv(base * marginPrice * terms.imf, BigInt(LIGHTER_MARGIN_FRACTION_TICK)), terms.quoteDecimals);
  const fees = toUnitsUp(ceilDiv(traded * terms.feeTicks, FEE_TICK_DENOMINATOR), terms.quoteDecimals);
  const markGap = toUnitsUp(gap, terms.quoteDecimals);
  // The closed position's margin at the mark, rounded DOWN; unknown without a mark.
  const released = terms.closing === 0n || terms.markDown === null
    ? 0n
    : toUnitsDown((terms.closing * terms.markDown * terms.imf) / BigInt(LIGHTER_MARGIN_FRACTION_TICK), terms.quoteDecimals);
  const owed = initialMargin + fees + markGap - released;
  return { total: owed > 0n ? owed : 0n, initialMargin, fees, markGap, released };
}

/** Walk the reachable levels; whatever the listed depth cannot fill is priced at the bound. */
function fillNotional(terms: Terms, base: bigint): bigint {
  let remaining = base;
  let notional = 0n;
  for (const level of terms.levels) {
    if (remaining === 0n) break;
    const take = level.size < remaining ? level.size : remaining;
    notional += take * level.price;
    remaining -= take;
  }
  return notional + remaining * terms.bound;
}

/** Every term grows with size, so the largest fitting size is a binary search below the refused one. */
function largestFittingBase(terms: Terms, refused: bigint, available: bigint): bigint {
  let low = 0n;
  let high = refused - 1n;
  while (low < high) {
    const middle = (low + high + 1n) / 2n;
    if (requirementFor(terms, middle).total <= available) low = middle;
    else high = middle - 1n;
  }
  return low;
}

/** A negative or unreadable balance leaves nothing to spend. */
function availableUnits(value: string): bigint {
  const units = decimalToScaled(value, LIGHTER_CAPITAL_UNITS_DECIMALS, "floor");
  return units === null || units < 0n ? 0n : units;
}

function toUnitsUp(value: bigint, quoteDecimals: number): bigint {
  if (value <= 0n) return 0n;
  if (quoteDecimals <= LIGHTER_CAPITAL_UNITS_DECIMALS) {
    return value * 10n ** BigInt(LIGHTER_CAPITAL_UNITS_DECIMALS - quoteDecimals);
  }
  return ceilDiv(value, 10n ** BigInt(quoteDecimals - LIGHTER_CAPITAL_UNITS_DECIMALS));
}

function toUnitsDown(value: bigint, quoteDecimals: number): bigint {
  if (value <= 0n) return 0n;
  if (quoteDecimals <= LIGHTER_CAPITAL_UNITS_DECIMALS) {
    return value * 10n ** BigInt(LIGHTER_CAPITAL_UNITS_DECIMALS - quoteDecimals);
  }
  return value / 10n ** BigInt(quoteDecimals - LIGHTER_CAPITAL_UNITS_DECIMALS);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator <= 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function parseUnsignedInteger(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError(`${name} ("${value}") is not a non-negative integer.`);
  }
  return BigInt(value);
}

/** A signed decimal string at `decimals`, rounded in the stated direction; null when unreadable. */
function decimalToScaled(value: string, decimals: number, rounding: "floor" | "ceil"): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (match === null) return null;
  const [, sign, whole, fraction = ""] = match;
  const kept = BigInt(`${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}`);
  const dropped = /[1-9]/.test(fraction.slice(decimals));
  const magnitudeUp = rounding === (sign === "-" ? "floor" : "ceil");
  const magnitude = dropped && magnitudeUp ? kept + 1n : kept;
  return sign === "-" ? -magnitude : magnitude;
}
