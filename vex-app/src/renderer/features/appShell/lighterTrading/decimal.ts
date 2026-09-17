/**
 * Exact string arithmetic for provider decimals. Prices and sizes stay as the
 * strings Lighter reported so nothing is coerced through a float on the way
 * to a review message.
 */

export const POSITIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UNSIGNED_DECIMAL = /^\d+(?:\.\d+)?$/;

export function isUnsignedDecimal(value: string): boolean {
  return UNSIGNED_DECIMAL.test(value);
}

/** A well-formed decimal strictly greater than zero. */
export function isPositiveDecimal(value: string): boolean {
  return POSITIVE_DECIMAL.test(value) && /[1-9]/.test(value);
}

function decimalParts(value: string): { readonly integer: bigint; readonly scale: number } | null {
  if (!UNSIGNED_DECIMAL.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return { integer: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function fromParts(integer: bigint, scale: number): string {
  const digits = integer.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const whole = digits.slice(0, -scale) || "0";
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/** -1, 0 or 1; null when either side is not an unsigned decimal. */
export function compareDecimalStrings(left: string, right: string): number | null {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (leftParts === null || rightParts === null) return null;
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const leftInteger = leftParts.integer * 10n ** BigInt(scale - leftParts.scale);
  const rightInteger = rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return leftInteger === rightInteger ? 0 : leftInteger < rightInteger ? -1 : 1;
}

/** Same as {@link compareDecimalStrings} for inputs already known to be unsigned decimals. */
export function compareUnsignedDecimals(left: string, right: string): number {
  return compareDecimalStrings(left, right) ?? 0;
}

export function addUnsignedDecimals(left: string, right: string): string {
  const leftParts = decimalParts(left) ?? { integer: 0n, scale: 0 };
  const rightParts = decimalParts(right) ?? { integer: 0n, scale: 0 };
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const sum = leftParts.integer * 10n ** BigInt(scale - leftParts.scale)
    + rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return fromParts(sum, scale);
}

/** `left - right`, or null when the result would be negative. */
export function subtractUnsignedDecimals(left: string, right: string): string | null {
  const leftParts = decimalParts(left);
  const rightParts = decimalParts(right);
  if (leftParts === null || rightParts === null) return null;
  const scale = Math.max(leftParts.scale, rightParts.scale);
  const difference = leftParts.integer * 10n ** BigInt(scale - leftParts.scale)
    - rightParts.integer * 10n ** BigInt(scale - rightParts.scale);
  return difference < 0n ? null : fromParts(difference, scale);
}

/** The decimal as an integer on a fixed scale; null when it carries more decimals than allowed. */
export function scaledInteger(value: string, decimals: number): bigint | null {
  const parts = decimalParts(value);
  if (parts === null || parts.scale > decimals) return null;
  return parts.integer * 10n ** BigInt(decimals - parts.scale);
}

/** Inverse of {@link scaledInteger}; keeps trailing zeros so ticks line up. */
export function fromScaledInteger(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

export function trimDecimal(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed.length === 0 ? "0" : trimmed;
}

/** A positive number as a trimmed decimal string with at most `decimals` places. */
export function toDecimal(value: number, decimals: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return trimDecimal(value.toFixed(decimals));
}
