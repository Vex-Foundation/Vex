/**
 * Bounded exact-decimal primitives for the `token_price` wake watch.
 *
 * WHY NOT `Number`. The watch compares a provider price against a threshold the
 * model wrote, and `rules/90-vex-project.md` forbids a money comparison that can
 * silently drift: `0.1 + 1e-20 === 0.1` in IEEE-754, so a float comparison
 * cannot tell a crossed threshold from an uncrossed one at the tail of a
 * long price. Every value here is an integer `units` scaled by a power of ten,
 * so a comparison is an integer comparison and cannot round.
 *
 * WHY BOUNDED. The threshold arrives as MODEL INPUT and the price arrives as
 * PROVIDER INPUT; both are untrusted. A digit count cap keeps a hostile string
 * from turning into an unbounded BigInt exponentiation.
 *
 * The domain is deliberately NON-NEGATIVE: prices, liquidity and thresholds are.
 * A leading `-`, an exponent, or any other spelling is rejected by returning
 * `null` rather than guessed at.
 */

/** Value = `units / 10 ** scale`. `units` is always non-negative. */
export interface BoundedDecimal {
  readonly units: bigint;
  readonly scale: number;
}

/** Longest accepted input, whitespace trimmed. Covers any real price string. */
export const DECIMAL_STRING_MAX_CHARS = 64;

/** Digits kept after the point when a division cannot be exact. */
export const DECIMAL_DIVISION_SCALE = 20;

const PLAIN_DECIMAL = /^\d{1,32}(?:\.\d{1,32})?$/;

/** Parse a plain non-negative decimal string, or `null` if it is not one. */
export function parseBoundedDecimal(raw: unknown): BoundedDecimal | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > DECIMAL_STRING_MAX_CHARS) return null;
  if (!PLAIN_DECIMAL.test(trimmed)) return null;

  const pointIndex = trimmed.indexOf(".");
  if (pointIndex === -1) return { units: BigInt(trimmed), scale: 0 };
  const whole = trimmed.slice(0, pointIndex);
  const fraction = trimmed.slice(pointIndex + 1);
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

function alignedUnits(a: BoundedDecimal, b: BoundedDecimal): readonly [bigint, bigint] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.units * 10n ** BigInt(scale - a.scale),
    b.units * 10n ** BigInt(scale - b.scale),
  ];
}

/** `-1` when `a < b`, `0` when equal in value, `1` when `a > b`. Exact. */
export function compareBoundedDecimals(a: BoundedDecimal, b: BoundedDecimal): -1 | 0 | 1 {
  const [left, right] = alignedUnits(a, b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** A price of zero is not a price; callers gate on this before using a value. */
export function isPositiveDecimal(value: BoundedDecimal): boolean {
  return value.units > 0n;
}

/** Multiply by a small non-negative integer, exactly. Used for ratio bounds. */
export function multiplyDecimalByInteger(value: BoundedDecimal, factor: number): BoundedDecimal {
  return { units: value.units * BigInt(Math.trunc(factor)), scale: value.scale };
}

/**
 * `a / b` truncated to {@link DECIMAL_DIVISION_SCALE} fractional digits, or
 * `null` when `b` is zero. Truncation (never rounding) keeps the result a value
 * the divisor could actually produce; 20 digits is far below the precision at
 * which any pool price is meaningful.
 */
export function divideBoundedDecimals(
  a: BoundedDecimal,
  b: BoundedDecimal,
  scale: number = DECIMAL_DIVISION_SCALE,
): BoundedDecimal | null {
  if (b.units === 0n) return null;
  const exponent = b.scale + scale - a.scale;
  const numerator = exponent >= 0 ? a.units * 10n ** BigInt(exponent) : a.units;
  const denominator = exponent >= 0 ? b.units : b.units * 10n ** BigInt(-exponent);
  return { units: numerator / denominator, scale };
}

/**
 * Render as a plain decimal string: no exponent, no trailing fraction zeros.
 * The agent and the wake banner read this value, so it must be the same
 * notation the model wrote its threshold in.
 */
export function formatBoundedDecimal(value: BoundedDecimal): string {
  const digits = value.units.toString();
  if (value.scale === 0) return digits;
  const padded = digits.padStart(value.scale + 1, "0");
  const whole = padded.slice(0, padded.length - value.scale);
  const fraction = padded.slice(padded.length - value.scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}
