/**
 * Model prices per one million tokens as EXACT decimal text.
 *
 * Providers publish prices as decimal strings in USD per token (OpenRouter
 * and the Vex Inference `/v1/models` alike, measured 2026-10-22: plain
 * decimals with up to 11 fractional digits, `-1` for a router with no fixed
 * price). For Vex Inference those are the prices actually charged, margin
 * included, so the picker must never round them down: "0.00000014375" per
 * token is "$0.14375" per 1M, never "$0.14". Per million is a shift of the
 * decimal point by six places, done on the text itself, never through a
 * float.
 */

/** A plain non-negative USD decimal as the per-1M fields carry it ("0.14375", "11.5", "0"). */
export const USD_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{0,23}[1-9])?$/;

/** At most this many digits on each side of a per-token price we accept. */
const PER_TOKEN_PATTERN = /^([0-9]{1,12})(?:\.([0-9]{1,24}))?$/;

/** Leading zeros of the whole part and trailing zeros of the fraction removed. */
function canonicalDecimal(whole: string, fraction: string): string {
  const w = whole.replace(/^0+(?=[0-9])/, "");
  const f = fraction.replace(/0+$/, "");
  return f.length === 0 ? w : `${w}.${f}`;
}

/**
 * USD per token (provider text) -> USD per one million tokens, exact, with
 * trailing zeros trimmed: "0.000000575" -> "0.575", "0.0000115" -> "11.5",
 * "0" -> "0". Null for anything that is not a plain non-negative decimal
 * (a negative sentinel, an exponent, an empty or oversized value), so a
 * price that cannot be stated exactly is never stated at all.
 */
export function usdPerMillionFromPerToken(perTokenText: unknown): string | null {
  if (typeof perTokenText !== "string") return null;
  const match = PER_TOKEN_PATTERN.exec(perTokenText.trim());
  if (match === null) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return canonicalDecimal(whole + fraction.slice(0, 6), fraction.slice(6));
}

/**
 * A per-1M price that already crossed as a JS number (the OpenRouter
 * endpoint list, whose wire contract is numeric) -> decimal text with
 * twelve fractional digits, trailing zeros trimmed. The provider's text has
 * at most eleven fractional digits per token (five per 1M), so twelve keep
 * every published digit and drop only the float noise of the earlier
 * multiplication (0.14375000000000002 -> "0.14375"). Null for a negative
 * or non-finite value.
 */
export function usdDecimalFromNumber(value: number): string | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const text = value.toFixed(12);
  const [whole = "0", fraction = ""] = text.split(".");
  return canonicalDecimal(whole, fraction);
}
