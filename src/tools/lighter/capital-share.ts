/**
 * The agent's capital share on a Lighter account: PURE integer arithmetic.
 *
 * The user sets one number in Settings -> Lighter -> Trading setup: the percent
 * of that Lighter account's collateral the agent may commit. This module owns
 * the whole arithmetic of that ceiling and NOTHING else - no database, no
 * provider, no policy resolution (those live one layer up in
 * `vex-agent/tools/protocols/lighter/capital-share-policy.ts`). It is the
 * `launch-ceiling.ts` template applied to Lighter margin, and it keeps that
 * module's three rules:
 *
 * 1. **Decimals are asserted, never rescaled silently.** A market's quote
 *    notional arrives on `supported_quote_decimals`; the ceiling is compared in
 *    USDC/USDG 6. The rescale happens here, once, under an assertion that names
 *    the market's own scale. A silent 10^n slip is the thousandfold error the
 *    rule exists to prevent.
 * 2. **Exceeding refuses with BOTH numbers, never resizes.** Silently shrinking
 *    an order would hide from the user that the agent tried to commit more than
 *    they authorized. The remedy names Settings, because that is the only place
 *    the number can change.
 * 3. **No share ⇒ no ceiling.** `null` is "the user has not set one" and trades
 *    as today (owner withdrew the strict option, plan section 10). This is the
 *    OPPOSITE of the launch ceiling's fail-closed default, and deliberately so:
 *    a launch ceiling guards an autonomous mission, while this guards an
 *    approval-gated order the user still sees on a card.
 *
 * ROUNDING, and why the two directions differ: budgets round DOWN and
 * obligations round UP. Every rounding error therefore tightens the ceiling. A
 * budget that rounded up, or a requirement that rounded down, would let the
 * agent commit one unit more than the user authorized.
 *
 * `committed` is a CONSERVATIVE SUPERSET (plan section 10, Codex turn 2): the
 * provider's own cross initial-margin requirement, plus isolated allocated
 * margin, plus margin reserved by resting orders, plus Vex intents that are
 * live but which the provider may not reflect yet. Whether the provider's IMR
 * already counts resting orders is measured by the live harness (step e2); until
 * it is, double counting is the safe direction and is named here rather than
 * hidden.
 */

import {
  LIGHTER_MARGIN_FRACTION_TICK,
  positionInitialMarginFractionToProviderScale,
} from "./margin-fraction.js";
import { ErrorCodes, VexError } from "../../errors.js";
import type { LighterAccountPosition, LighterMarketDetail } from "./types.js";

/**
 * The scale every capital number in this module is expressed in: Lighter's
 * settlement asset decimals (USDC on Core, USDG on Robinhood Chain, both 6).
 * The ledger, the budget and the commitment rows all speak this scale, so a
 * value that has not been rescaled to it never reaches a comparison.
 */
export const LIGHTER_CAPITAL_UNITS_DECIMALS = 6;

/**
 * Fee ticks are hundredths of a basis point: a percent with four decimals, so
 * `fee = notional * ticks / 1_000_000`. Matches `order-fee-terms.ts`
 * (`lighterFeePercent` renders ticks at 4 decimals and `estimateLighterOrderFee`
 * scales the product by `decimals + 6`).
 */
export const LIGHTER_FEE_TICK_DENOMINATOR = 1_000_000n;

/** The share as the user authored it, or `null` when they never set one. */
export type LighterAgentCapitalSharePercent = number | null;

/** How the account's spendable ceiling decomposes. All USDC-6 integer strings. */
export interface LighterCapitalBudget {
  readonly agentCapitalSharePercent: number;
  readonly collateralUnits: string;
  readonly budgetUnits: string;
  readonly committedUnits: string;
  readonly remainingUnits: string;
  /** Each addend, so a refusal can say WHICH commitment consumed the budget. */
  readonly committedBreakdown: {
    readonly providerCrossInitialMarginUnits: string;
    readonly isolatedAllocatedMarginUnits: string;
    readonly restingOrderReservedMarginUnits: string;
    readonly vexLiveIntentUnits: string;
  };
}

export interface LighterCapitalBudgetInput {
  readonly agentCapitalSharePercent: number;
  /** `collateral` from the live account row, a decimal string in settlement units. */
  readonly collateral: string;
  /** `cross_initial_margin_requirement` from the live account row. */
  readonly crossInitialMarginRequirement: string;
  /** `allocated_margin` of every isolated position row on the account. */
  readonly isolatedAllocatedMargins: readonly string[];
  /** Margin reserved by authenticated resting orders, already in USDC-6 units. */
  readonly restingOrderReservedMarginUnits: readonly string[];
  /** Required margin of Vex intents that are live but perhaps not yet visible to the provider. */
  readonly vexLiveIntentUnits: readonly string[];
}

/**
 * Resolve the account's budget, what is already committed against it, and what
 * is left.
 *
 * Every input is REQUIRED and strictly parsed: a missing or malformed financial
 * field refuses by name rather than defaulting to zero, because a zero here
 * silently WIDENS the ceiling.
 */
export function computeLighterCapitalBudget(
  input: LighterCapitalBudgetInput,
): LighterCapitalBudget {
  const percent = input.agentCapitalSharePercent;
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw invalidCapitalInput(
      `agentCapitalSharePercent is ${String(percent)}, which is not a whole percent between 1 and 100. It is NOT coerced.`,
    );
  }
  const collateralUnits = decimalToCapitalUnits(input.collateral, "collateral");
  const providerCross = decimalToCapitalUnits(
    input.crossInitialMarginRequirement,
    "cross_initial_margin_requirement",
  );
  const isolated = sumUnits(
    input.isolatedAllocatedMargins.map((value, index) =>
      decimalToCapitalUnits(value, `positions[${index}].allocated_margin`),
    ),
  );
  const resting = sumUnits(
    input.restingOrderReservedMarginUnits.map((value, index) =>
      integerUnits(value, `restingOrderReservedMarginUnits[${index}]`),
    ),
  );
  const vexLive = sumUnits(
    input.vexLiveIntentUnits.map((value, index) =>
      integerUnits(value, `vexLiveIntentUnits[${index}]`),
    ),
  );

  // Budget rounds DOWN: the user authorized "at most this share".
  const budget = (collateralUnits * BigInt(percent)) / 100n;
  const committed = providerCross + isolated + resting + vexLive;
  const remaining = committed >= budget ? 0n : budget - committed;

  return {
    agentCapitalSharePercent: percent,
    collateralUnits: collateralUnits.toString(),
    budgetUnits: budget.toString(),
    committedUnits: committed.toString(),
    remainingUnits: remaining.toString(),
    committedBreakdown: {
      providerCrossInitialMarginUnits: providerCross.toString(),
      isolatedAllocatedMarginUnits: isolated.toString(),
      restingOrderReservedMarginUnits: resting.toString(),
      vexLiveIntentUnits: vexLive.toString(),
    },
  };
}

/**
 * Which price the requirement is computed at.
 *
 * `approved_execution_bound` and `approved_limit_price` are both HARD ceilings
 * the user approved and `pre-submit-revalidation.ts` enforces; `mark_price` only
 * ever raises a sell's exposure above its own submitted price.
 */
export type LighterCapitalRiskPriceBasis =
  | "approved_limit_price"
  | "approved_execution_bound"
  | "mark_price";

export type LighterCapitalRiskPrice =
  | { readonly ok: true; readonly priceInteger: string; readonly basis: LighterCapitalRiskPriceBasis }
  | { readonly ok: false; readonly reason: string };

export interface LighterCapitalRiskPriceInput {
  readonly side: "buy" | "sell";
  /** The approved price integer at the market's price decimals, from the preview. */
  readonly approvedPriceInteger: string;
  /** What that price MEANS on the preview: a resting limit, or a hard bound. */
  readonly approvedPriceRole: "limit_price" | "worst_acceptable_price" | "trigger_execution_bound";
  readonly priceDecimals: number;
  /** `mark_price` from the live market detail; only a sell consults it. */
  readonly markPrice: string | null | undefined;
}

/**
 * The APPROVED WORST CASE, never the current best quote (Codex turn 3).
 *
 * A BUY can execute at any price up to its approved bound, so that bound is the
 * exposure the user authorized; pricing it at the live best ask would understate
 * a market order whose slippage bound sits well above the book.
 *
 * A SELL's submitted price is a MINIMUM it will accept, not a bound on how much
 * margin the resulting short needs. The short's margin follows the market, so
 * the risk price is `max(limit price, mark price)`.
 */
export function resolveLighterCapitalRiskPriceInteger(
  input: LighterCapitalRiskPriceInput,
): LighterCapitalRiskPrice {
  const approved = parseNonNegativeInteger(input.approvedPriceInteger);
  if (approved === null || approved <= 0n) {
    return {
      ok: false,
      reason:
        "This Lighter order carries no approved price bound, so the capital it would commit cannot be bounded. "
        + "An order with an open-ended execution price is not admitted under a capital share.",
    };
  }
  const basis: LighterCapitalRiskPriceBasis = input.approvedPriceRole === "limit_price"
    ? "approved_limit_price"
    : "approved_execution_bound";
  if (input.side === "buy") {
    return { ok: true, priceInteger: approved.toString(), basis };
  }

  if (input.markPrice === null || input.markPrice === undefined) {
    return {
      ok: false,
      reason:
        "This Lighter market reported no mark price, so a sell's margin exposure cannot be bounded above its own "
        + "limit price. The order is not admitted under a capital share.",
    };
  }
  let mark: bigint;
  try {
    mark = decimalToScaledInteger(input.markPrice, input.priceDecimals, "mark_price");
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return mark > approved
    ? { ok: true, priceInteger: mark.toString(), basis: "mark_price" }
    : { ok: true, priceInteger: approved.toString(), basis };
}

/** The margin plus fees one order obligates, in USDC-6 units. */
export interface LighterOrderRequiredCapital {
  readonly requiredUnits: string;
  readonly notionalUnits: string;
  readonly initialMarginUnits: string;
  readonly exchangeTakerFeeUnits: string;
  readonly vexIntegratorFeeUnits: string;
  readonly initialMarginFraction: number;
  readonly riskPriceInteger: string;
  readonly riskPriceBasis: LighterCapitalRiskPriceBasis;
}

export interface LighterOrderRequiredCapitalInput {
  readonly baseAmountInteger: string;
  readonly riskPriceInteger: string;
  readonly riskPriceBasis: LighterCapitalRiskPriceBasis;
  readonly sizeDecimals: number;
  readonly priceDecimals: number;
  readonly quoteDecimals: number;
  readonly initialMarginFraction: number;
  /** The market's own `taker_fee`, a percent decimal string such as "0.0000". */
  readonly exchangeTakerFeePercent: string;
  /**
   * THIS ACCOUNT's exchange taker-fee tier, `current_taker_fee_tick` from the
   * authenticated `accountLimits` read, in the same hundredths-of-a-bp ticks as
   * the market percent.
   *
   * REQUIRED, never optional: an absent tier would silently price the order at
   * the market's own fee, and a market fee of zero with a nonzero account tier
   * is exactly the shape that admits an order at the ceiling without reserving
   * what it will actually be charged. The caller reads it or refuses.
   */
  readonly exchangeAccountTakerFeeTicks: number;
  /** VEX's integrator taker fee in ticks, or `null` when no fee policy applies. */
  readonly vexIntegratorTakerFeeTicks: number | null;
}

/**
 * `required = ceil(base x riskPrice x imf / 10000) + exchangeTakerFee + vexIntegratorFee`,
 * where `exchangeTakerFee` is charged at `max(market taker_fee, this account's
 * exchange fee tier)`.
 *
 * The taker fee is used for BOTH fee legs even when the order may rest and pay
 * the maker fee instead: taker is the larger obligation, and this is a ceiling.
 */
export function computeLighterOrderRequiredCapital(
  input: LighterOrderRequiredCapitalInput,
): LighterOrderRequiredCapital {
  const base = parseNonNegativeInteger(input.baseAmountInteger);
  if (base === null || base <= 0n) {
    throw invalidCapitalInput("baseAmountInteger must be a positive integer of base units.");
  }
  const price = parseNonNegativeInteger(input.riskPriceInteger);
  if (price === null || price <= 0n) {
    throw invalidCapitalInput("riskPriceInteger must be a positive integer at the market's price decimals.");
  }
  assertScale(input.sizeDecimals, "supported_size_decimals");
  assertScale(input.priceDecimals, "supported_price_decimals");
  assertScale(input.quoteDecimals, "supported_quote_decimals");
  // The market's own documented identity. `order-preview.ts` asserts the same
  // relation before it builds a preview; asserting it again here means this
  // module can never be handed a product whose scale it guessed.
  if (input.quoteDecimals !== input.sizeDecimals + input.priceDecimals) {
    throw invalidCapitalInput(
      `market quote scale ${input.quoteDecimals} is not supported_size_decimals ${input.sizeDecimals} `
      + `plus supported_price_decimals ${input.priceDecimals}. The notional is NOT rescaled from a scale it cannot verify.`,
    );
  }
  const imf = input.initialMarginFraction;
  if (!Number.isInteger(imf) || imf <= 0 || imf > LIGHTER_MARGIN_FRACTION_TICK) {
    throw invalidCapitalInput(
      `initialMarginFraction is ${String(imf)}, which is not an integer on Lighter's 1..${LIGHTER_MARGIN_FRACTION_TICK} scale.`,
    );
  }

  const notionalAtMarketScale = base * price;
  const notionalUnits = rescaleToCapitalUnits(
    notionalAtMarketScale,
    input.quoteDecimals,
  );
  // Obligations round UP, always.
  const marginUnits = ceilDiv(notionalUnits * BigInt(imf), BigInt(LIGHTER_MARGIN_FRACTION_TICK));
  // THE LARGER OF THE TWO EXCHANGE FEES, which is the rule the order preview
  // already applies to its own taker-fee estimate (`order-preview.ts`: it
  // replaces the market-percent figure with the account-tier one whenever the
  // account tier charges more). The account's tier is what the exchange will
  // actually take, and a fee setup can move it, so a ceiling built on
  // `market.taker_fee` alone under-reserves for exactly the accounts that pay
  // most. Both figures are hundredths of a basis point, so they compare
  // directly.
  const marketTicks = feePercentToTicks(input.exchangeTakerFeePercent, "market taker_fee");
  const accountTicks = accountFeeTicks(input.exchangeAccountTakerFeeTicks);
  const exchangeTicks = accountTicks > marketTicks ? accountTicks : marketTicks;
  const exchangeFeeUnits = ceilDiv(notionalUnits * exchangeTicks, LIGHTER_FEE_TICK_DENOMINATOR);
  const vexTicks = input.vexIntegratorTakerFeeTicks === null
    ? 0n
    : integratorTicks(input.vexIntegratorTakerFeeTicks);
  const vexFeeUnits = ceilDiv(notionalUnits * vexTicks, LIGHTER_FEE_TICK_DENOMINATOR);

  return {
    requiredUnits: (marginUnits + exchangeFeeUnits + vexFeeUnits).toString(),
    notionalUnits: notionalUnits.toString(),
    initialMarginUnits: marginUnits.toString(),
    exchangeTakerFeeUnits: exchangeFeeUnits.toString(),
    vexIntegratorFeeUnits: vexFeeUnits.toString(),
    initialMarginFraction: imf,
    riskPriceInteger: price.toString(),
    riskPriceBasis: input.riskPriceBasis,
  };
}

/**
 * Which initial-margin fraction this account uses on this market, and where it
 * came from.
 *
 * The position row is authority when it exists; a market the account has never
 * traded has no row, so the market's OWN default applies (Core's default differs
 * from Robinhood Chain's, so a hardcoded 2x would be wrong on one of them). The
 * REST row reports a PERCENT STRING ("50.00"), and
 * {@link positionInitialMarginFractionToProviderScale} is the only parser of it
 * anywhere in Vex.
 */
export function resolveLighterInitialMarginFraction(input: {
  readonly positionRow: Pick<LighterAccountPosition, "initial_margin_fraction"> | null | undefined;
  readonly market: Pick<LighterMarketDetail, "default_initial_margin_fraction">;
}): { readonly initialMarginFraction: number; readonly source: "position_row" | "market_default" } {
  const raw = input.positionRow?.initial_margin_fraction;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return {
      initialMarginFraction: positionInitialMarginFractionToProviderScale(raw),
      source: "position_row",
    };
  }
  const fallback = input.market.default_initial_margin_fraction;
  if (!Number.isInteger(fallback) || (fallback as number) <= 0) {
    throw invalidCapitalInput(
      "this Lighter market reported no default_initial_margin_fraction, so the margin this order requires cannot be computed.",
    );
  }
  return { initialMarginFraction: fallback as number, source: "market_default" };
}

/** The advisory a preview carries and the refusal a prepare throws. */
export interface LighterCapitalShareAssessment {
  readonly kind: "lighter_capital_share";
  readonly agentCapitalSharePercent: number;
  readonly source: "user_settings";
  readonly changeableBy: "user_only";
  readonly howToChange: string;
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly passes: boolean;
  readonly budgetUnits: string;
  readonly committedUnits: string;
  readonly remainingUnits: string;
  readonly requiredUnits: string;
  readonly decimals: number;
  readonly budgetDisplay: string;
  readonly remainingDisplay: string;
  readonly requiredDisplay: string;
  readonly initialMarginFraction: number;
  readonly initialMarginFractionSource: "position_row" | "market_default";
  readonly riskPriceBasis: LighterCapitalRiskPriceBasis;
  readonly note: string;
}

/** Why no ceiling applies to this order, when one does not. */
export type LighterCapitalShareExemption =
  | "no_share_configured"
  | "reduce_only"
  | "spot_sell";

export type LighterCapitalShareOutcome =
  | { readonly applies: false; readonly exemption: LighterCapitalShareExemption }
  | { readonly applies: true; readonly assessment: LighterCapitalShareAssessment }
  | { readonly applies: true; readonly refusal: string };

export interface LighterCapitalShareInput {
  readonly agentCapitalSharePercent: LighterAgentCapitalSharePercent;
  readonly walletAddress: string;
  readonly accountIndex: number;
  readonly marketType: string;
  readonly side: "buy" | "sell";
  readonly reduceOnly: boolean;
  readonly budget: LighterCapitalBudget | null;
  readonly required: LighterOrderRequiredCapital | null;
  readonly initialMarginFractionSource: "position_row" | "market_default";
  /** A refusal produced before the arithmetic could run (no bound, no mark price). */
  readonly unbounded?: string;
}

export const LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE = "Settings -> Lighter -> Trading setup";

/**
 * Decide whether this order fits the share, WITHOUT throwing.
 *
 * `null`-shaped outcomes are not errors: a reduce-only order shrinks exposure,
 * a spot sell reduces inventory, and an unset share is the user declining to
 * set a ceiling. Each is named so the caller can say WHY nothing was checked.
 */
export function assessLighterOrderCapitalShare(
  input: LighterCapitalShareInput,
): LighterCapitalShareOutcome {
  if (input.agentCapitalSharePercent === null) {
    return { applies: false, exemption: "no_share_configured" };
  }
  // Proven against the live position at preview time (`order-preview.ts`
  // refuses an unverifiable reduce-only), so this exemption rests on evidence,
  // not on the model's word.
  if (input.reduceOnly) {
    return { applies: false, exemption: "reduce_only" };
  }
  if (input.marketType === "spot") {
    if (input.side === "sell") {
      return { applies: false, exemption: "spot_sell" };
    }
    // A spot BUY settles into inventory that leaves `committed` entirely, so
    // repeated buys could walk past the share while every single one passed.
    // Refused until an inventory ledger with verified exits exists (named
    // omission in `Lighter.md`).
    return {
      applies: true,
      refusal:
        `This Lighter spot buy is refused while an agent capital share of ${input.agentCapitalSharePercent}% is set. `
        + "The share governs perpetual margin, and spot purchases settle into inventory that the share cannot account for. "
        + `Trade the perpetual market instead, or clear the share in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE} to trade spot as before.`,
    };
  }
  if (input.unbounded !== undefined) {
    return { applies: true, refusal: input.unbounded };
  }
  if (input.budget === null || input.required === null) {
    return {
      applies: true,
      refusal:
        "The live Lighter account or market numbers this capital share depends on were not available, so the order "
        + "was not admitted. Nothing was signed or submitted.",
    };
  }

  const remaining = BigInt(input.budget.remainingUnits);
  const required = BigInt(input.required.requiredUnits);
  return {
    applies: true,
    assessment: {
      kind: "lighter_capital_share",
      agentCapitalSharePercent: input.agentCapitalSharePercent,
      source: "user_settings",
      changeableBy: "user_only",
      howToChange: LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE,
      walletAddress: input.walletAddress,
      accountIndex: input.accountIndex,
      // The boundary is INCLUSIVE: a requirement exactly equal to what remains
      // still fits the share the user authorized.
      passes: required <= remaining,
      budgetUnits: input.budget.budgetUnits,
      committedUnits: input.budget.committedUnits,
      remainingUnits: input.budget.remainingUnits,
      requiredUnits: input.required.requiredUnits,
      decimals: LIGHTER_CAPITAL_UNITS_DECIMALS,
      budgetDisplay: formatCapitalUnits(input.budget.budgetUnits),
      remainingDisplay: formatCapitalUnits(input.budget.remainingUnits),
      requiredDisplay: formatCapitalUnits(input.required.requiredUnits),
      initialMarginFraction: input.required.initialMarginFraction,
      initialMarginFractionSource: input.initialMarginFractionSource,
      riskPriceBasis: input.required.riskPriceBasis,
      note:
        `The agent may commit ${input.agentCapitalSharePercent}% of this Lighter account's collateral. `
        + `The user sets that percent in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}; Vex exposes no tool to change it.`,
    },
  };
}

/**
 * ENFORCE the share: the same decision as {@link assessLighterOrderCapitalShare},
 * but a breach throws `LIGHTER_CAPITAL_SHARE_EXCEEDED` naming both numbers.
 *
 * The order is NEVER resized to fit. The user raises the share, or asks for a
 * smaller order.
 */
export function assertLighterOrderCapitalShare(
  input: LighterCapitalShareInput,
): LighterCapitalShareOutcome {
  const outcome = assessLighterOrderCapitalShare(input);
  if (outcome.applies && "refusal" in outcome) {
    throw new VexError(ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED, outcome.refusal);
  }
  if (outcome.applies && "assessment" in outcome && !outcome.assessment.passes) {
    throw new VexError(
      ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED,
      describeLighterCapitalShareBreach(outcome.assessment),
    );
  }
  return outcome;
}

/** The refusal text, with both numbers and the one place the ceiling can move. */
export function describeLighterCapitalShareBreach(
  assessment: LighterCapitalShareAssessment,
): string {
  return (
    `Refusing this Lighter order: it would commit ${assessment.requiredDisplay} of margin and fees, which exceeds the `
    + `${assessment.remainingDisplay} still available under the agent's ${assessment.agentCapitalSharePercent}% capital share `
    + `for account ${assessment.accountIndex} (share budget ${assessment.budgetDisplay}, already committed `
    + `${formatCapitalUnits(assessment.committedUnits)}). The order is NOT resized. `
    + `Raise the share in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}, or ask for a smaller order.`
  );
}

/** Render USDC-6 units as a settlement-asset decimal string. */
export function formatCapitalUnits(units: string): string {
  const value = parseNonNegativeInteger(units);
  if (value === null) return units;
  const raw = value.toString().padStart(LIGHTER_CAPITAL_UNITS_DECIMALS + 1, "0");
  return `${raw.slice(0, -LIGHTER_CAPITAL_UNITS_DECIMALS)}.${raw.slice(-LIGHTER_CAPITAL_UNITS_DECIMALS)}`;
}

// ── strict parsing ───────────────────────────────────────────────────────────

function invalidCapitalInput(detail: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter capital-share arithmetic refused: ${detail}`,
  );
}

function assertScale(decimals: number, name: string): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw invalidCapitalInput(`${name} is ${String(decimals)}, which is not a usable decimal scale.`);
  }
}

function parseNonNegativeInteger(value: string): bigint | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value.trim())) return null;
  return BigInt(value.trim());
}

function integerUnits(value: string, name: string): bigint {
  const parsed = parseNonNegativeInteger(value);
  if (parsed === null) {
    throw invalidCapitalInput(`${name} ("${String(value)}") is not a non-negative integer of settlement units.`);
  }
  return parsed;
}

function sumUnits(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

/** Parse a provider decimal string into settlement units, refusing by name. */
export function decimalToCapitalUnits(value: string, name: string): bigint {
  return decimalToScaledInteger(value, LIGHTER_CAPITAL_UNITS_DECIMALS, name);
}

function decimalToScaledInteger(value: string, decimals: number, name: string): bigint {
  if (typeof value !== "string") {
    throw invalidCapitalInput(`${name} is missing; every financial field this ceiling reads is required.`);
  }
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (match === null) {
    throw invalidCapitalInput(`${name} ("${trimmed}") is not a decimal number.`);
  }
  const [, sign, whole, fractionRaw = ""] = match;
  if (sign === "-" && /[1-9]/.test(`${whole}${fractionRaw}`)) {
    throw invalidCapitalInput(`${name} ("${trimmed}") is negative; a negative capital figure is never assumed to be zero.`);
  }
  if (fractionRaw.length > decimals) {
    // Truncating here would round an obligation DOWN, so it is refused instead.
    throw invalidCapitalInput(
      `${name} ("${trimmed}") carries more than ${decimals} decimals and is NOT truncated to fit the settlement scale.`,
    );
  }
  return BigInt(`${whole}${fractionRaw.padEnd(decimals, "0")}`);
}

/**
 * Bring a notional from the market's quote scale to the settlement scale under
 * an explicit assertion, rounding UP so a rescale never understates an
 * obligation.
 */
function rescaleToCapitalUnits(value: bigint, quoteDecimals: number): bigint {
  if (quoteDecimals === LIGHTER_CAPITAL_UNITS_DECIMALS) return value;
  if (quoteDecimals > LIGHTER_CAPITAL_UNITS_DECIMALS) {
    return ceilDiv(value, 10n ** BigInt(quoteDecimals - LIGHTER_CAPITAL_UNITS_DECIMALS));
  }
  return value * 10n ** BigInt(LIGHTER_CAPITAL_UNITS_DECIMALS - quoteDecimals);
}

/** A percent string with at most four decimals ("0.0000", "1.0000") to ticks. */
function feePercentToTicks(value: string, name: string): bigint {
  return decimalToScaledInteger(value, 4, name);
}

/** The account's own exchange tier, on the same tick scale as a market percent. */
function accountFeeTicks(ticks: number): bigint {
  if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 1_000_000) {
    throw invalidCapitalInput(
      `exchangeAccountTakerFeeTicks is ${String(ticks)}, which is outside Lighter's fee-tick range. `
      + "It is NOT treated as zero: an unknown exchange fee would under-reserve every order at the ceiling.",
    );
  }
  return BigInt(ticks);
}

function integratorTicks(ticks: number): bigint {
  if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks > 1_000_000) {
    throw invalidCapitalInput(`vexIntegratorTakerFeeTicks is ${String(ticks)}, which is outside Lighter's fee-tick range.`);
  }
  return BigInt(ticks);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw invalidCapitalInput("a fee or margin denominator was not positive.");
  if (numerator <= 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}
