/**
 * Shared field readers for the Morpho validators.
 *
 * Same split as Pendle's read lane, and it is a contract rather than a style:
 *
 *   readDisplay*  - TOLERANT. A wrong type or an absent value becomes `null`.
 *                   Names, labels, APYs and USD marks. Strictly typing a display
 *                   field a provider legitimately sends as null caused live
 *                   outages (rules/90).
 *
 *   require*      - STRICT. Identity and raw base-unit amounts, where a wrong
 *                   value is worse than no value. They return `null` so the
 *                   CALLER drops the row; a body where every row drops raises
 *                   `morphoInvalidResponse`.
 *
 * ONE Morpho-specific reader exists because Morpho's serialisation forced it.
 * The GraphQL `BigInt` scalar arrives as a JSON NUMBER when the value fits in a
 * double and as a JSON STRING when it does not - both shapes appear in a single
 * response. The 2026-08-14 fixture has `supplyAssets: 1483215354242158` (number)
 * next to `collateralAssets: "355405952890211270375830324"` (string) in adjacent
 * rows. Pendle's `requireDigitString` rejects the number form on the principle
 * that a stringified number signals a changed contract; here the number form IS
 * the contract, so {@link requireBigIntString} accepts it - but ONLY while it is
 * a safe integer. A JSON number above 2^53 has already lost precision, and
 * accepting it would launder that loss into a money field.
 */

import { isRecord } from "../../../utils/validation-helpers.js";
import type { MorphoAsset, MorphoMarketWarning } from "../types.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const MARKET_ID_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DIGITS_PATTERN = /^\d+$/;

export { isRecord };

/** Tolerant string: a non-empty string, or `null`. */
export function readDisplayString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Tolerant number: a finite number, or `null`. NaN and Infinity read as absent. */
export function readDisplayNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Tolerant boolean: only a literal `true` is true. */
export function readDisplayBool(v: unknown): boolean {
  return v === true;
}

/** Strict address, lowercased so every comparison downstream is case-safe. */
export function requireAddress(v: unknown): string | null {
  return typeof v === "string" && ADDRESS_PATTERN.test(v) ? v.toLowerCase() : null;
}

/** Strict Morpho Blue market id: a 32-byte hash, lowercased. */
export function requireMarketIdField(v: unknown): string | null {
  return typeof v === "string" && MARKET_ID_PATTERN.test(v) ? v.toLowerCase() : null;
}

/** Strict positive-integer chain id. */
export function requireChainId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Strict token decimals. Morpho types this `Float!`, so a whole-valued double
 * is the normal shape; a fractional or out-of-range value is refused because
 * every amount on the row would then be unreadable.
 */
export function requireDecimals(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 36) return null;
  return v;
}

/**
 * Strict `BigInt` scalar, normalised to a decimal string of base units.
 *
 * Accepts the two forms Morpho actually emits and nothing else:
 *   - a digits-only string, returned verbatim;
 *   - a non-negative SAFE integer number, stringified.
 *
 * A number beyond `Number.MAX_SAFE_INTEGER`, a negative, a float, or anything
 * else returns `null` and the caller drops the row. Money is never parsed
 * through `parseFloat` anywhere in this lane.
 */
export function requireBigIntString(v: unknown): string | null {
  if (typeof v === "string") return DIGITS_PATTERN.test(v) ? v : null;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return String(v);
  }
  return null;
}

/** Tolerant `BigInt`: same acceptance as the strict reader, but never drops a row. */
export function readDisplayBigIntString(v: unknown): string | null {
  return requireBigIntString(v);
}

/** Read a nested record, or `null` when the key is absent or not an object. */
export function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

/** Read an array, or an empty array. A non-array is treated as absent, never thrown on. */
export function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

/** Sum a list of decimal base-unit strings exactly, through BigInt. */
export function sumRawAmounts(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) total += BigInt(value);
  return total.toString();
}

/**
 * Morpho's `Asset`, strict on identity and decimals, tolerant on symbol and
 * price. Lives here rather than in a lane validator because every Morpho read -
 * market, vault, allocation, reward - returns the same `Asset` type, and a
 * second copy of this reader is a second place the decimals rule can be relaxed.
 */
export function readAsset(raw: unknown): MorphoAsset | null {
  if (!isRecord(raw)) return null;
  const address = requireAddress(raw["address"]);
  const decimals = requireDecimals(raw["decimals"]);
  if (address === null || decimals === null) return null;
  const price = readRecord(raw, "price");
  return {
    address,
    symbol: readDisplayString(raw["symbol"]),
    decimals,
    priceUsd: price === null ? null : readDisplayNumber(price["usd"]),
  };
}

/**
 * Morpho's own warning list. `Market`, `Vault` and `VaultV2` each declare their
 * own warning TYPE but the two fields this reads (`type`, `level`) are identical
 * across all three, and both are passed through verbatim: a warning Vex does not
 * recognise is still a warning the agent must see.
 */
export function readWarnings(raw: unknown[]): MorphoMarketWarning[] {
  const warnings: MorphoMarketWarning[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const type = readDisplayString(entry["type"]);
    const level = readDisplayString(entry["level"]);
    if (type === null || level === null) continue;
    warnings.push({ type, level });
  }
  return warnings;
}
