/**
 * The bonding-curve trade arithmetic, PURE and in bigint.
 *
 * Every formula here is transcribed from `FRouterV3.sol` and `BondingV5.sol`
 * (plan v3 section 10, the arithmetic the coordinator adopted after Codex round
 * 3), and the transcription is deliberate rather than approximate: the contract
 * uses integer division at three separate points and a Vex figure that rounds a
 * different way is a figure the chain will not honour.
 *
 * ## THE AUTHORITY TABLE THIS MODULE IMPLEMENTS
 *
 * | field | authority |
 * |---|---|
 * | `buyTaxPct` / `sellTaxPct` | `FFactoryV2.buyTax()` / `.sellTax()`, integer percent |
 * | raw anti-sniper percent | `FRouterV3._calculateAntiSniperTaxForSide`, integer percent |
 * | effective anti-sniper | `min(raw, 99 - normal)` - the router's own clamp |
 * | `contractMinOut` (buy) | `applySlippage(getAmountsOut(token, VIRTUAL, taxedIn))` |
 * | `contractGrossMin` (sell) | `applySlippage(getAmountsOut(token, 0x0, amountIn))` |
 *
 * ## BUY (`FRouterV3.buy`, :202-230)
 *
 *   normalFee = floor(curveAmount * buyTax / 100)
 *   antiFee   = floor(curveAmount * effectiveAnti / 100)
 *   taxedIn   = curveAmount - normalFee - antiFee
 *
 * The router pulls `taxedIn` to the pair, `normalFee` to the tax vault and
 * `antiFee` to the anti-sniper vault - three `transferFrom` calls that TOGETHER
 * take exactly `curveAmount` from the wallet. That is why the allowance and the
 * balance guard are sized on `curveAmount` and never on `taxedIn`.
 *
 * `BondingV5._buy` then compares the router's output - the tokens the wallet
 * actually receives - against `amountOutMin_` (:728-730), so the buy floor is a
 * floor on DELIVERED tokens.
 *
 * ## SELL (`FRouterV3.sell`, :155-170; `BondingV5.sell`, :687-688)
 *
 * The on-chain comparison is against the router's GROSS output, BEFORE the two
 * taxes are removed. So:
 *
 *   contractGrossMin = floor(quotedGross * (10000 - slippageBps) / 10000)
 *
 * is the ONLY floor the chain enforces, and the amount that reaches the wallet
 * is `gross - floor(sellTax*gross/100) - floor(anti*gross/100)`, computed by the
 * contract on the REALISED gross rather than on our floor. `walletNetMin` below
 * is therefore an ESTIMATE - the net the wallet would see if the fill landed
 * exactly on the enforced floor at the tax read a moment before signing - and it
 * is labelled as one everywhere it is shown. A receipt below it is a settlement
 * discrepancy to REPORT, never a bound the contract prevented.
 *
 * The estimate is honest in the safe direction: between the pre-sign read and
 * inclusion the only tax that can move is the anti-sniper one, which DECAYS
 * monotonically inside its window, so a stale read over-estimates the tax and
 * under-estimates the net.
 */

/** The router's ceiling: the two taxes together may never exceed 99 percent. */
export const MAX_COMBINED_TAX_PCT = 99;

/** Basis-point base for the slippage bound. */
const BPS_DENOMINATOR = 10_000n;

/**
 * The anti-sniper percent that will ACTUALLY be applied, after the router's
 * clamp (`if (normalTax + antiSniperTax > 99) antiSniperTax = 99 - normalTax`).
 *
 * Expressed as `min(raw, 99 - normal)` because the two are identical whenever
 * the clamp can be reached at all, and the `min` form makes the invariant
 * `normal + effective <= 99` readable at a glance.
 *
 * A `normalTaxPct` above 99 cannot be clamped against - the contract would
 * underflow on `99 - normalTax` - so it is refused by the caller rather than
 * folded to zero here.
 */
export function effectiveAntiSniperPct(rawAntiPct: number, normalTaxPct: number): number {
  assertWholePercent(rawAntiPct, "anti-sniper tax");
  assertWholePercent(normalTaxPct, "protocol tax");
  return Math.min(rawAntiPct, MAX_COMBINED_TAX_PCT - normalTaxPct);
}

/** `floor(amount * pct / 100)`, the contract's own `(tax * amount) / 100`. */
export function percentOf(amount: bigint, pct: number): bigint {
  assertWholePercent(pct, "tax");
  return (amount * BigInt(pct)) / 100n;
}

/**
 * `floor(amount * (10000 - bps) / 10000)`.
 *
 * The slippage bound is applied by SUBTRACTION from the quoted figure, exactly
 * as the live harness and every other Vex venue do it, and it floors - a floor
 * rounded UP would be a floor the market can miss by a unit.
 */
export function applySlippageFloor(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`slippageBps must be a whole number of basis points in [0, 10000] (got ${slippageBps}).`);
  }
  return (amount * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

/** The two tax components of one side of a trade, and what they leave behind. */
export interface CurveTaxSplit {
  /** `floor(base * normalTaxPct / 100)`. */
  readonly normalFeeRaw: bigint;
  /** `floor(base * effectiveAntiPct / 100)`. */
  readonly antiSniperFeeRaw: bigint;
  /** `base - normalFeeRaw - antiSniperFeeRaw`. Never negative. */
  readonly netRaw: bigint;
  readonly normalTaxPct: number;
  /** After the router's clamp. */
  readonly effectiveAntiPct: number;
}

/**
 * Split `base` into the protocol tax, the anti-sniper tax and the remainder,
 * exactly as `FRouterV3` does on either side.
 *
 * `netRaw` cannot go negative: `normalTaxPct + effectiveAntiPct <= 99` by
 * construction, and both fees floor.
 */
export function splitCurveTax(base: bigint, normalTaxPct: number, rawAntiPct: number): CurveTaxSplit {
  if (base < 0n) throw new RangeError("A curve tax base cannot be negative.");
  if (normalTaxPct > MAX_COMBINED_TAX_PCT) {
    throw new RangeError(
      `The protocol tax read from the factory is ${normalTaxPct} percent, above the ${MAX_COMBINED_TAX_PCT} percent the router can clamp against.`,
    );
  }
  const effectiveAntiPct = effectiveAntiSniperPct(rawAntiPct, normalTaxPct);
  const normalFeeRaw = percentOf(base, normalTaxPct);
  const antiSniperFeeRaw = percentOf(base, effectiveAntiPct);
  return {
    normalFeeRaw,
    antiSniperFeeRaw,
    netRaw: base - normalFeeRaw - antiSniperFeeRaw,
    normalTaxPct,
    effectiveAntiPct,
  };
}

export interface BuyLegs {
  /** What the wallet commits to the curve call: the `amountIn_` argument. */
  readonly curveAmountRaw: bigint;
  readonly tax: CurveTaxSplit;
  /** `curveAmount - taxes` - what the router swaps and what the quote is taken on. */
  readonly taxedInRaw: bigint;
}

/**
 * The buy legs for a committed VIRTUAL amount. Pure: the caller supplies the
 * taxes it read on chain, and quotes `getAmountsOut(token, VIRTUAL, taxedInRaw)`
 * afterwards.
 */
export function computeBuyLegs(input: {
  readonly curveAmountRaw: bigint;
  readonly buyTaxPct: number;
  readonly rawAntiSniperBuyPct: number;
}): BuyLegs {
  const tax = splitCurveTax(input.curveAmountRaw, input.buyTaxPct, input.rawAntiSniperBuyPct);
  return { curveAmountRaw: input.curveAmountRaw, tax, taxedInRaw: tax.netRaw };
}

export interface SellFloors {
  /** The router's quoted GROSS output, before either tax. */
  readonly quotedGrossRaw: bigint;
  /** The ONLY floor the chain enforces (`BondingV5.sell` compares the gross). */
  readonly contractGrossMinRaw: bigint;
  /** ESTIMATE of the wallet's net at the enforced floor and the pre-sign taxes. */
  readonly walletNetMinRaw: bigint;
  /** ESTIMATE of the wallet's net if the fill lands on the quoted gross. */
  readonly walletNetQuotedRaw: bigint;
  readonly tax: CurveTaxSplit;
}

/**
 * The two sell figures, and which of them the contract actually enforces.
 *
 * `tax` is reported on the QUOTED gross so the disclosed percentages describe
 * the trade the user is looking at; the floor-derived net uses the same
 * percentages against `contractGrossMinRaw`.
 */
export function computeSellFloors(input: {
  readonly quotedGrossRaw: bigint;
  readonly sellTaxPct: number;
  readonly rawAntiSniperSellPct: number;
  readonly slippageBps: number;
}): SellFloors {
  const tax = splitCurveTax(input.quotedGrossRaw, input.sellTaxPct, input.rawAntiSniperSellPct);
  const contractGrossMinRaw = applySlippageFloor(input.quotedGrossRaw, input.slippageBps);
  const floorTax = splitCurveTax(contractGrossMinRaw, input.sellTaxPct, input.rawAntiSniperSellPct);
  return {
    quotedGrossRaw: input.quotedGrossRaw,
    contractGrossMinRaw,
    walletNetMinRaw: floorTax.netRaw,
    walletNetQuotedRaw: tax.netRaw,
    tax,
  };
}

/**
 * The raw anti-sniper percent for one side at `nowSeconds`, transcribed from
 * `FRouterV3._calculateAntiSniperTaxForSide` (:309-355).
 *
 * The `nowSeconds < taxStartTime` arm returns the FULL start tax rather than
 * zero, which the API-row estimator in `protocols/virtuals/anti-sniper.ts`
 * cannot model at all: trading that has not started yet is taxed at the maximum,
 * and a scheduled launch is exactly the case where the two clocks differ.
 */
export function rawAntiSniperPctAt(input: {
  /** Whether this type taxes this side at all (`appliesAntiSniperOnBuy/Sell`). */
  readonly appliesOnThisSide: boolean;
  /** `BondingConfig.getAntiSniperDuration(type)`, seconds. */
  readonly durationSeconds: number;
  /** `pair.taxStartTime()` when non-zero, else `pair.startTime()`. */
  readonly taxStartTimeSeconds: number;
  /** `FFactoryV2.antiSniperBuyTaxStartValue()`, integer percent (99 measured). */
  readonly startTaxPct: number;
  readonly nowSeconds: number;
}): number {
  if (!input.appliesOnThisSide) return 0;
  if (input.durationSeconds <= 0) return 0;
  if (input.nowSeconds < input.taxStartTimeSeconds) return input.startTaxPct;
  const elapsed = input.nowSeconds - input.taxStartTimeSeconds;
  if (elapsed >= input.durationSeconds) return 0;
  return Math.floor((input.startTaxPct * (input.durationSeconds - elapsed)) / input.durationSeconds);
}

function assertWholePercent(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new RangeError(`A ${label} must be a whole percent in [0, 100] (got ${value}).`);
  }
}
