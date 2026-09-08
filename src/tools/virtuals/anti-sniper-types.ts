/**
 * The anti-sniper tax TYPE TABLE, transcribed from `BondingConfig.sol`.
 *
 * ONE OWNER, TWO CONSUMERS. The launch lane needs it to describe the CHOICE a
 * creator makes (`preLaunch(..., antiSniperTaxType_, ...)`), and the read lane
 * needs it to ESTIMATE the window on an agent that already exists. Those are
 * different jobs with different authorities, but the durations and the sides
 * each type taxes are ONE invariant of the contract, so they live here - in the
 * venue layer, which the vex-agent layer may import and which may import nothing
 * from it.
 *
 * The source, member for member (`BondingConfig.sol:30-35`,
 * `getAntiSniperDuration` :412-429, `appliesAntiSniperOnBuy` :386-394,
 * `appliesAntiSniperOnSell` :399-405):
 *
 *   type 0 ANTI_SNIPER_NONE      duration 0 s      neither side
 *   type 1 ANTI_SNIPER_60S       duration 60 s     buy only   (launch default)
 *   type 2 ANTI_SNIPER_98M       duration 5880 s   buy only
 *   type 3 ANTI_SNIPER_98M_SELL  duration 5880 s   sell only
 *   type 4 ANTI_SNIPER_98M_BOTH  duration 5880 s   buy AND sell
 *   type 5 ANTI_SNIPER_10M       duration 600 s    buy only
 *
 * `isValidAntiSniperType` on the contract admits exactly these six and reverts
 * with `InvalidAntiSniperType` on anything else, so a launch that names a
 * seventh is refused locally rather than by a wasted gas estimate.
 */

/** One contract type: how long it lasts and which sides it taxes. */
export interface AntiSniperTypeSpec {
  readonly durationSeconds: number;
  readonly appliesOnBuy: boolean;
  readonly appliesOnSell: boolean;
  /** The contract's own constant name, echoed so the model can cite it. */
  readonly name: string;
}

export const ANTI_SNIPER_TYPES: Readonly<Record<number, AntiSniperTypeSpec>> = {
  0: { durationSeconds: 0, appliesOnBuy: false, appliesOnSell: false, name: "ANTI_SNIPER_NONE" },
  1: { durationSeconds: 60, appliesOnBuy: true, appliesOnSell: false, name: "ANTI_SNIPER_60S" },
  2: { durationSeconds: 5880, appliesOnBuy: true, appliesOnSell: false, name: "ANTI_SNIPER_98M" },
  3: { durationSeconds: 5880, appliesOnBuy: false, appliesOnSell: true, name: "ANTI_SNIPER_98M_SELL" },
  4: { durationSeconds: 5880, appliesOnBuy: true, appliesOnSell: true, name: "ANTI_SNIPER_98M_BOTH" },
  5: { durationSeconds: 600, appliesOnBuy: true, appliesOnSell: false, name: "ANTI_SNIPER_10M" },
};

/** The six types the contract admits, ascending. The launch param's domain. */
export const ANTI_SNIPER_TYPE_VALUES: readonly number[] = [0, 1, 2, 3, 4, 5];

/**
 * The type `preLaunch` gets when the caller names none.
 *
 * `ANTI_SNIPER_60S` is what the Virtuals app itself sends and what both of the
 * launches on disk carried (2026-09-04). It is also the only type the contract
 * accepts for the privileged X/ACP modes, which is corroborating evidence that
 * it is the venue's own normal.
 */
export const DEFAULT_ANTI_SNIPER_TYPE = 1;

/** `factory.antiSniperBuyTaxStartValue()` - 99 percent at the window's start. */
export const ANTI_SNIPER_START_TAX_PCT = 99;

/** `FFactoryV2.buyTax` / `.sellTax`, measured 1 on Base and Robinhood. */
export const FLAT_CURVE_TAX_PCT = 1;

/** True when `value` is one of the six types `isValidAntiSniperType` admits. */
export function isValidAntiSniperType(value: number): boolean {
  return Number.isInteger(value) && ANTI_SNIPER_TYPES[value] !== undefined;
}
