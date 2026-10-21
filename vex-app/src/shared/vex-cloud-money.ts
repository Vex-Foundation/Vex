/**
 * Vex Cloud money arithmetic, ONE owner for main and the renderer.
 *
 * Main decides with these functions (the minimum a deposit or a withdrawal
 * must reach at the backend's current rate) and the renderer displays with
 * the very same ones (the USD estimate under a typed amount), so the screen
 * and the gate can never round apart. Pure and integer only (rule 90: no
 * floating point for token amounts): VEX in wei with 18 decimals, USD in
 * integer micro-USD, the rate as the backend's `vex_wei_per_micro_usd`
 * decimal string scaled by 10^18 (the backend's own `weiPerMicroUsdX18`,
 * `VexVirtualsCompute/src/money/rate.ts`).
 *
 * Rounding is always against the user's surprise: a USD estimate rounds
 * DOWN (the screen never promises more than the amount is worth), a minimum
 * in wei rounds UP (an amount that passes here also passes the backend).
 */

/** VEX on Robinhood Chain (plan 15.5, measured). */
export const VEX_CLOUD_CHAIN_ID = 4663;
export const VEX_TOKEN_ADDRESS = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";
export const VEX_DECIMALS = 18;
export const VEX_SYMBOL = "VEX";

const WEI_PER_VEX = 10n ** BigInt(VEX_DECIMALS);
const RATE_SCALE = 10n ** 18n;

/** The largest whole-VEX part a typed amount may carry (far above the total supply). */
const MAX_WHOLE_DIGITS = 12;

export type VexAmountParse =
  | { readonly ok: true; readonly wei: bigint }
  | { readonly ok: false; readonly reason: "empty" | "format" | "too_precise" | "zero" };

/**
 * A typed VEX amount (text, as the user entered it) -> wei. Accepts digits
 * with at most one point and at most 18 decimals ("125", "0.5", "12.",
 * "1,000" is refused: a thousands separator is ambiguous across locales).
 * Never goes through a float.
 */
export function parseVexAmountText(text: string): VexAmountParse {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  const match = /^([0-9]*)(?:\.([0-9]*))?$/.exec(trimmed);
  if (match === null) return { ok: false, reason: "format" };
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole.length === 0 && fraction.length === 0) return { ok: false, reason: "format" };
  if (whole.replace(/^0+/, "").length > MAX_WHOLE_DIGITS) return { ok: false, reason: "format" };
  if (fraction.length > VEX_DECIMALS) return { ok: false, reason: "too_precise" };
  const wei = BigInt(whole.length === 0 ? "0" : whole) * WEI_PER_VEX + BigInt(fraction.padEnd(VEX_DECIMALS, "0"));
  if (wei === 0n) return { ok: false, reason: "zero" };
  return { ok: true, wei };
}

/**
 * Wei -> the EXACT decimal VEX amount, trailing zeros removed
 * (`1500000000000000000` -> `1.5`). Used where the user consents to an
 * amount: an approval shows every digit that will be signed.
 */
export function formatVexExact(wei: bigint): string {
  return formatUnitsExact(wei, VEX_DECIMALS);
}

/** A raw integer in base units -> its exact decimal, thousands grouped, trailing zeros removed. */
export function formatUnitsExact(raw: bigint, decimals: number): string {
  if (raw < 0n) throw new RangeError("formatUnitsExact expects a non-negative amount");
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const fraction = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction.length === 0 ? grouped : `${grouped}.${fraction}`;
}

/**
 * The backend's `vex_wei_per_micro_usd` decimal string -> the rate scaled by
 * 10^18, or `null` when it is not a positive decimal with at most 18
 * fractional digits (the backend formats exactly that, `formatScaled`).
 */
export function parseRateX18(decimal: string): bigint | null {
  const match = /^([0-9]{1,60})(?:\.([0-9]{1,18}))?$/.exec(decimal);
  if (match === null) return null;
  const scaled = BigInt(match[1] ?? "0") * RATE_SCALE + BigInt((match[2] ?? "").padEnd(18, "0"));
  return scaled > 0n ? scaled : null;
}

/** Wei -> integer micro-USD at the rate, rounded down. */
export function weiToMicroUsdFloor(wei: bigint, rateX18: bigint): bigint {
  if (rateX18 <= 0n) throw new RangeError("rate must be positive");
  return (wei * RATE_SCALE) / rateX18;
}

/** Integer micro-USD -> the wei that is worth at least that much at the rate, rounded up. */
export function microUsdToWeiCeil(microUsd: bigint, rateX18: bigint): bigint {
  if (rateX18 <= 0n) throw new RangeError("rate must be positive");
  const numerator = microUsd * rateX18;
  return (numerator + RATE_SCALE - 1n) / RATE_SCALE;
}

/** Integer micro-USD -> `$12.34`, rounded down; a positive amount under a cent reads `less than $0.01`. */
export function formatMicroUsd(microUsd: bigint): string {
  const cents = microUsd / 10_000n;
  if (microUsd > 0n && cents === 0n) return "less than $0.01";
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${dollars}.${(cents % 100n).toString().padStart(2, "0")}`;
}
