/**
 * Shared Zod primitives + throw helper for the Trench Express validators.
 *
 * Tolerant-reader split (rule 90) lives HERE, in the optionality of each
 * primitive: `financialNumber`/`address` are strict (a bad value throws), while
 * the `display*` helpers coerce a missing/null field to a safe default and never
 * throw. Every validator parses raw `unknown` off the wire before any typed
 * value is handed inward (rule 03 boundary).
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";

/**
 * Parse `raw` with `schema`, returning the typed value or throwing
 * `VexError(TRENCH_INVALID_RESPONSE)` carrying the first Zod issue. Malformed or
 * hostile bytes become a non-retryable typed error, never an inward leak.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const path = issue?.path.join(".") || "<root>";
  const message = issue?.message ?? "unknown";
  throw new VexError(
    ErrorCodes.TRENCH_INVALID_RESPONSE,
    `Invalid Trench Express response at ${path}: ${message}`,
    "The launchpad API returned an unexpected response shape.",
  );
}

// ── Strict primitives (financially-relevant — a bad value throws) ────

/** EVM address: `0x` + 40 hex. Identity of a token/pool — must be exact. */
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { error: "expected an EVM address" });

/** Pool id: `0x` + 64 hex. */
export const poolId = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { error: "expected a 32-byte pool id" });

/** A finite JS number. Rejects NaN/±Infinity — a money-adjacent field must be real. */
export const financialNumber = z.number().finite();

// ── Display primitives (tolerant — missing/null coerces to a default) ─

/** A string that may be absent or null → `null`. */
export const displayString = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

/** A number that may be absent or null → `null`; a non-finite value also → `null`. */
export const displayNumber = z
  .number()
  .nullish()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));

/** A boolean that may be absent or null → `null`. */
export const displayBoolean = z
  .boolean()
  .nullish()
  .transform((v) => v ?? null);
