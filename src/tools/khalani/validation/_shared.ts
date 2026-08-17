/**
 * Shared PRIVATE Zod primitives + throw helper for the Khalani validators.
 *
 * Extracted verbatim from the original `validation.ts` god-file so every
 * resource module reuses exactly ONE definition (no duplication). Nothing here
 * is re-exported from the public barrel — these mirror the hand-written
 * `createFieldValidators(KHALANI_API_ERROR, "Khalani")` helpers and the local
 * `isRecord`, with identical messages, coercions, and never-throw transforms.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { zNumberField } from "../../../utils/zod-validation-helpers.js";

// ---------------------------------------------------------------------------
// Throw helper — reproduces the original VexError(KHALANI_API_ERROR, "...").
// ---------------------------------------------------------------------------

/**
 * Parse `raw` with `schema`, returning the typed value or throwing the SAME
 * `VexError(KHALANI_API_ERROR, msg)` the hand-written validator would have.
 * The thrown message is the first Zod issue's message; every required-field
 * rule below carries the original field-path message, and `superRefine`
 * branches set the original discriminator messages, so the surfaced message is
 * equivalent to the original short-circuit throw.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new VexError(ErrorCodes.KHALANI_API_ERROR, issue.message);
}

// ---------------------------------------------------------------------------
// Field primitives — mirror createFieldValidators(KHALANI_API_ERROR, "Khalani").
// ---------------------------------------------------------------------------

/** Mirrors `asString(value, field)`: non-empty string, else `missing <field>`. */
export function asString(field: string): z.ZodType<string> {
  return z
    .string({ message: `Invalid Khalani response: missing ${field}` })
    .min(1, `Invalid Khalani response: missing ${field}`);
}

/** Mirrors `asNumber(value, field)`: any non-NaN number (incl. ±Infinity), else `missing <field>`. */
export function asNumber(field: string): z.ZodType<number> {
  // Shared primitive — guards `typeof v === "number" && !Number.isNaN(v)`
  // (accepts Infinity, which Zod 4 `z.number()` would wrongly reject).
  return zNumberField(`Invalid Khalani response: missing ${field}`);
}

/**
 * Mirrors `asOptionalString`: returns the string only when it is a non-empty
 * string, otherwise `undefined`. Never throws on bad input.
 */
export const asOptionalString: z.ZodType<string | undefined> = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "string" && v.length > 0 ? v : undefined));

/**
 * Mirrors `asStringArray`: non-array → `[]`; array → keep only string elements.
 * Element-wise filter (NOT whole-array drop).
 */
export const asStringArray: z.ZodType<string[]> = z
  .unknown()
  .optional()
  .transform((v) =>
    Array.isArray(v) ? v.filter((entry): entry is string => typeof entry === "string") : [],
  );

/**
 * A raw record subtree preserved verbatim when present, else `undefined`.
 * Mirrors `isRecord(x) ? x as ... : undefined`.
 */
export const optionalRecord: z.ZodType<Record<string, unknown> | undefined> = z
  .unknown()
  .optional()
  .transform((v) => (isRecordValue(v) ? v : undefined));

/** Local `isRecord` (non-null, non-array object) used inside transforms. */
export function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
