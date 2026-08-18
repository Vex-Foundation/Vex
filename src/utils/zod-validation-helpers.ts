/**
 * Zod equivalents of the hand-written `createFieldValidators` primitives
 * (codex-002 Phase 2 — converting API-response validators to Zod). Behavior
 * MUST match `validation-helpers.ts` exactly so the conversion is
 * behavior-preserving.
 *
 * CRITICAL (Zod 4 gotcha): `z.number()` REJECTS `Infinity`/`-Infinity`, but the
 * original `asNumber` accepted any `typeof v === "number" && !Number.isNaN(v)`
 * — which INCLUDES ±Infinity. So number validation uses a custom guard, NOT
 * `z.number()`. Do not "simplify" these to `z.number()`; that silently changes
 * accept/reject behavior on numeric fields.
 */

import { z } from "zod";

/** `asNumber(value, field)`: any non-NaN number (incl. ±Infinity); throws `message` otherwise. */
export function zNumberField(message: string): z.ZodType<number> {
  return z.custom<number>(
    (v) => typeof v === "number" && !Number.isNaN(v),
    { error: message },
  );
}

/** `asString(value, field)`: a non-empty string; throws `message` otherwise. */
export function zStringField(message: string): z.ZodType<string> {
  return z.string({ error: message }).min(1, { error: message });
}

/** `asOptionalString`: a non-empty string, else `undefined` (never throws). */
export const zOptionalString: z.ZodType<string | undefined> = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "string" && v.length > 0 ? v : undefined));

/** `asOptionalNumber`: a non-NaN number, else `undefined` (never throws). */
export const zOptionalNumber: z.ZodType<number | undefined> = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "number" && !Number.isNaN(v) ? v : undefined));

/** `asStringArray`: an array filtered to its string elements, else `[]` (never throws). */
export const zStringArray: z.ZodType<string[]> = z
  .unknown()
  .optional()
  .transform((v) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [],
  );
