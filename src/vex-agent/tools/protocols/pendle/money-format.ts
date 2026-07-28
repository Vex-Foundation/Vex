/**
 * Money formatting for Pendle READ output.
 *
 * Two rules from `rules/90` drive every function here, and both were learned
 * from live defects rather than from taste:
 *
 * 1. **A raw amount must travel with the decimals needed to read it.**
 *    `"1047061"` next to a bare mint is 1.05 at 6 decimals and 0.00105 at 9 — a
 *    thousandfold error for the agent that guesses. So every balance leaves here
 *    as a TRIPLET: the raw base units, the decimals used, and the exact human
 *    string. When decimals are unknown the human string is `null`, never a guess.
 *
 * 2. **`Number()` must never touch a u256.** The previous projectors did
 *    `Number(balanceWei) / 10 ** decimals`, which silently loses precision above
 *    2^53 — an 18-decimal balance passes that line at ~9 tokens. Everything here
 *    is BigInt and string arithmetic.
 *
 * USD is the one place a float legitimately arrives: the provider sends
 * `valuation` as a JSON number. It is converted ONCE, at a fixed scale, into a
 * decimal string, and every sum afterwards is integer arithmetic on those scaled
 * units — so a portfolio total can never drift the way repeated float addition
 * does.
 */

/** Fixed scale for USD arithmetic: micro-dollars. Six places is below any dust. */
const USD_SCALE_DECIMALS = 6;
const USD_SCALE = 10n ** BigInt(USD_SCALE_DECIMALS);

/** Upper bound on decimals we will format. ERC-20 allows 255; nothing real exceeds this. */
const MAX_DECIMALS = 36;

/**
 * A base-unit amount and everything needed to read it.
 *
 * `exact` is `null` ONLY when `decimals` could not be resolved from the chain's
 * asset catalogue. That is a real state — an asset Pendle does not list — and it
 * is reported rather than papered over with an assumed 18.
 */
export interface PendleAmount {
  /** Base units, decimal digits only, exactly as the provider sent them. */
  raw: string;
  /** Decimals used to produce `exact`; null when the catalogue did not carry the asset. */
  decimals: number | null;
  /** Human-readable amount as an exact decimal string; null when `decimals` is null. */
  exact: string | null;
}

function isDigits(raw: string): boolean {
  return raw.length > 0 && /^\d+$/.test(raw);
}

/**
 * Exact base-units → decimal string. Pure BigInt: no float ever sees the value.
 * Trailing fractional zeros are trimmed, so 1.500000 reads as "1.5" and a whole
 * amount reads as "1".
 */
export function formatBaseUnits(raw: string, decimals: number): string | null {
  if (!isDigits(raw)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) return null;
  if (decimals === 0) return raw.replace(/^0+(?=\d)/, "");

  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** Build the raw/decimals/exact triplet for a base-unit balance. */
export function amountTriplet(raw: string, decimals: number | null): PendleAmount {
  if (decimals === null) return { raw, decimals: null, exact: null };
  return { raw, decimals, exact: formatBaseUnits(raw, decimals) };
}

/**
 * A provider USD float → an exact decimal string at a fixed scale.
 *
 * `toFixed` is the correctly-rounded double→decimal conversion, and it never
 * emits exponent notation below 1e21; values are bounded before they reach here.
 * Returns null for a non-finite or out-of-range input rather than "NaN".
 */
export function usdString(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) return null;
  return trimUsd(value.toFixed(USD_SCALE_DECIMALS));
}

/** Trim a fixed-scale USD string to at most 6 places, keeping at least 2. */
function trimUsd(fixed: string): string {
  const [whole = "0", fraction = ""] = fixed.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const padded = trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed;
  return `${whole}.${padded}`;
}

/** A USD decimal string → scaled integer micro-dollars, for exact summation. */
function usdToScaled(value: string): bigint | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return null;
  const [, sign = "", whole = "0", fraction = ""] = match;
  const scaledFraction = fraction.slice(0, USD_SCALE_DECIMALS).padEnd(USD_SCALE_DECIMALS, "0");
  const magnitude = BigInt(whole) * USD_SCALE + BigInt(scaledFraction.length === 0 ? "0" : scaledFraction);
  return sign === "-" ? -magnitude : magnitude;
}

/** Scaled micro-dollars → decimal string. */
function scaledToUsd(scaled: bigint): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / USD_SCALE;
  const fraction = (magnitude % USD_SCALE).toString().padStart(USD_SCALE_DECIMALS, "0");
  return `${negative ? "-" : ""}${trimUsd(`${whole}.${fraction}`)}`;
}

/**
 * Exact sum of USD decimal strings.
 *
 * Integer arithmetic on scaled units, so a hundred positions cannot accumulate
 * the drift repeated float addition would. Unreadable entries are SKIPPED and
 * counted, because a total that silently absorbed an unpriceable position as $0
 * would be the lie `valuationBasis: "unknown"` exists to prevent.
 */
export function sumUsdStrings(values: readonly (string | null)[]): {
  total: string;
  counted: number;
  skipped: number;
} {
  let scaled = 0n;
  let counted = 0;
  let skipped = 0;
  for (const value of values) {
    if (value === null) {
      skipped += 1;
      continue;
    }
    const parsed = usdToScaled(value);
    if (parsed === null) {
      skipped += 1;
      continue;
    }
    scaled += parsed;
    counted += 1;
  }
  return { total: scaledToUsd(scaled), counted, skipped };
}

/**
 * A decimal-fraction rate → a percent STRING.
 *
 * Pendle returns every APY as a decimal fraction (0.0228 = 2.28%) and says so in
 * its own conventions. A bare 0.0228 in agent-facing output is a unit trap; the
 * field NAME carries the unit (`impliedApyPercent`) and the value is the percent.
 */
export function percentString(fraction: number | null | undefined, places = 2): string | null {
  if (fraction === null || fraction === undefined) return null;
  if (!Number.isFinite(fraction) || Math.abs(fraction) >= 1e9) return null;
  return (fraction * 100).toFixed(places);
}

/**
 * A decimal-fraction fee rate → BASIS POINTS as a string. Same reasoning as
 * `percentString`: the unit lives in the field name (`swapFeeRateBps`).
 */
export function bpsString(fraction: number | null | undefined, places = 2): string | null {
  if (fraction === null || fraction === undefined) return null;
  if (!Number.isFinite(fraction) || Math.abs(fraction) >= 1e9) return null;
  return (fraction * 10_000).toFixed(places);
}

/**
 * Whole days from `now` until an ISO expiry — negative once matured, null when
 * the expiry cannot be read. Days, not milliseconds, because "how long is this
 * locked for" is the question an agent actually asks.
 */
export function daysUntil(isoExpiry: string | null, nowMs: number): number | null {
  if (isoExpiry === null) return null;
  const expiryMs = Date.parse(isoExpiry);
  if (Number.isNaN(expiryMs)) return null;
  return Math.floor((expiryMs - nowMs) / 86_400_000);
}
