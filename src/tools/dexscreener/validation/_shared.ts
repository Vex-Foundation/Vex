/**
 * Shared private Zod primitives + throw helper for the DexScreener validators.
 *
 * Single source of truth for `parseOrThrow` (the
 * `VexError(DEXSCREENER_INVALID_RESPONSE)` throw helper), the field primitives
 * (`asString` / `asNumber` / `asOptionalString` / `asOptionalNumber` /
 * `strDefault`), and the `linksSchema` shared by profiles / boosts / community
 * takeovers. Moved VERBATIM from the original `validation.ts`; behavior,
 * messages, refines and transforms are unchanged.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import { zNumberField } from "../../../utils/zod-validation-helpers.js";
import type { DexLink } from "../types.js";

// ---------------------------------------------------------------------------
// Throw helper — reproduces the original VexError(DEXSCREENER_INVALID_RESPONSE).
// ---------------------------------------------------------------------------

/**
 * Parse `raw` with `schema`, returning the typed value or throwing the SAME
 * `VexError(DEXSCREENER_INVALID_RESPONSE, msg)` the hand-written validator would
 * have. The thrown message is the first Zod issue's message; required-field
 * rules below carry the original `expected <type> for <field>` field-path
 * message in the ORIGINAL declaration order, so the surfaced message matches the
 * original short-circuit throw.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new VexError(ErrorCodes.DEXSCREENER_INVALID_RESPONSE, issue.message);
}

// ---------------------------------------------------------------------------
// Field primitives — mirror the original DexScreener helpers EXACTLY.
//
// NOTE: the originals throw the SAME message regardless of which check fails,
// and the optional helpers return `null` (not `undefined`).
// ---------------------------------------------------------------------------

/** `asString(value, field)`: non-empty string, else `expected string for <field>`. */
export function asString(field: string): z.ZodType<string> {
  const message = `Invalid DexScreener response: expected string for ${field}`;
  return z.string({ error: message }).min(1, { error: message });
}

/** `asNumber(value, field)`: any non-NaN number (incl. ±Infinity), else `expected number for <field>`. */
export function asNumber(field: string): z.ZodType<number> {
  // Shared primitive — guards `typeof v === "number" && !Number.isNaN(v)`
  // (accepts Infinity, which Zod 4 `z.number()` would wrongly reject).
  return zNumberField(`Invalid DexScreener response: expected number for ${field}`);
}

/** `asOptionalString`: non-empty string else `null` (never throws). DexScreener returns null. */
export const asOptionalString: z.ZodType<string | null> = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "string" && v.length > 0 ? v : null));

/** `asOptionalNumber`: non-NaN number else `null` (never throws). DexScreener returns null. */
export const asOptionalNumber: z.ZodType<number | null> = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "number" && !Number.isNaN(v) ? v : null));

/** `typeof v === "string" ? v : def` (note: accepts empty string, unlike asString). */
export const strDefault = (def: string): z.ZodType<string> =>
  z.unknown().optional().transform((v) => (typeof v === "string" ? v : def));

// ---------------------------------------------------------------------------
// Links parser (shared by profiles + boosts; LENIENT — element-wise filter).
// ---------------------------------------------------------------------------

/** `parseLinks`: non-array → null; else `filter(isRecord).map(...)`. */
export const linksSchema: z.ZodType<DexLink[] | null> = z.unknown().optional().transform((raw) => {
  if (!Array.isArray(raw)) return null;
  return raw.filter(isRecord).map((item) => ({
    type: typeof item.type === "string" && item.type.length > 0 ? item.type : null,
    label: typeof item.label === "string" && item.label.length > 0 ? item.label : null,
    url: typeof item.url === "string" ? item.url : "",
  }));
});
