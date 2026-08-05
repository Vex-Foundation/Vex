/**
 * Shared field readers for the Pendle READ validators.
 *
 * The split these enforce is the card's contract, and it is not stylistic:
 *
 *   readDisplay*  — TOLERANT. Wrong type or absent becomes `null`. Used for
 *                   names, labels, APYs and USD figures. Strictly typing a
 *                   display field a provider legitimately sends as `null` or as
 *                   a number caused three separate live outages (rules/90).
 *
 *   requireAddress / requireDigits / requireFiniteNumber — STRICT. These back
 *                   identity and raw base-unit amounts, where a wrong value is
 *                   worse than no value. They return `null` so the CALLER can
 *                   drop the row; a body where every row drops raises through
 *                   `pendleInvalidResponse`.
 *
 * Nothing here reads free text into a message: upstream strings are data, never
 * error vocabulary.
 */

import { isRecord } from "../../../../utils/validation-helpers.js";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DIGITS_PATTERN = /^\d+$/;

export { isRecord };

/** Tolerant string: non-empty string or `null`. */
export function readDisplayString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Tolerant number: finite number or `null`. NaN/Infinity are treated as absent. */
export function readDisplayNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Tolerant boolean: only a literal `true` is true. */
export function readDisplayBool(v: unknown): boolean {
  return v === true;
}

/**
 * Strict finite number. Returns `null` for anything else, INCLUDING numeric
 * strings — a provider that starts stringifying a number has changed its
 * contract, and coercing it would hide that.
 */
export function requireFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Strict positive integer chain id. */
export function requireChainId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Strict address. Accepts the bare `0x…` form and the `chainId-address`
 * composite Pendle uses on market/asset ids, and returns the bare address
 * LOWERCASED so every comparison in the read lane is case-safe.
 */
export function requireAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const idx = v.indexOf("-");
  const candidate = idx >= 0 ? v.slice(idx + 1) : v;
  return ADDRESS_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

/** Read the chain id out of a `chainId-address` composite id. */
export function chainIdFromCompositeId(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const idx = v.indexOf("-");
  if (idx <= 0) return null;
  const parsed = Number(v.slice(0, idx));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Strict raw base-unit amount: decimal digits only, as a string. Rejects signs,
 * decimal points, exponents and JSON numbers — a u256 that arrived as a number
 * has already lost precision, and accepting it would launder that loss.
 */
export function requireDigitString(v: unknown): string | null {
  return typeof v === "string" && DIGITS_PATTERN.test(v) ? v : null;
}

/** Strict address list: every entry must be a well-formed address, or the list is rejected. */
export function requireAddressList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const entry of v) {
    const address = requireAddress(entry);
    if (address === null) return null;
    out.push(address);
  }
  return out;
}

/**
 * Tolerant string list (category labels and the like). NOT truncated (W9d):
 * this list feeds the `categories` / `excludeCategories` filter, and a cap that
 * dropped the 17th label let an explicitly EXCLUDED market back into the
 * result with nothing said. Entries are narrowed to a bounded token vocabulary
 * downstream (`trusted-fields.ts` `trustedCategoryId`).
 */
export function readDisplayStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
