/**
 * Shared Zod primitives + throw helper for the pools.fun validators.
 *
 * The tolerant-reader split (rule 90) lives HERE, in the optionality of each
 * primitive: identity and provenance (`address`, `isoTimestamp`, the platform /
 * paired-asset enums) are STRICT and a bad value throws, while every `display*`
 * helper coerces a missing/null field to `null` and never throws. The provider
 * has no schema and no stability promise, so a display field it decides to send
 * as `null` tomorrow must not take a whole page of rows down with it - and a
 * financial identity it sends malformed must never pass.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";

/**
 * Parse `raw` with `schema`, returning the typed value or throwing
 * `VexError(POOLS_INVALID_RESPONSE)` carrying the first Zod issue - the path and
 * message name exactly which field of which row broke.
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
    ErrorCodes.POOLS_INVALID_RESPONSE,
    `Invalid pools.fun response at ${path}: ${message}`,
    "The pools.fun API returned an unexpected response shape.",
  );
}

// -- Strict primitives (identity / provenance - a bad value throws) --

/** EVM address: `0x` + 40 hex. Identity of a token or a pool - must be exact. */
export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, { error: "expected an EVM address" });

/**
 * ISO timestamp. Strict because `deployedAt` is what the age filter and the
 * "fresh launch" reading are computed from; a malformed one would silently
 * become an infinitely old or infinitely new token.
 *
 * `z.iso.datetime()` rather than a `Date.parse` refinement: `Date.parse` accepts
 * a pile of non-ISO shapes (`"March 3 2026"`, and implementation-defined formats
 * besides), so it would have let a value through that the ISO contract does not
 * actually promise. The provider sends `2026-08-11T11:43:19.000Z`.
 */
export const isoTimestamp = z.iso.datetime({ error: "expected an ISO-8601 UTC timestamp" });

/** A finite JS number. Rejects NaN and the infinities. */
export const finiteNumber = z.number().finite();

// -- Display primitives (tolerant - missing/null coerces to null) ----

/** A string that may be absent or null -> `null`. */
export const displayString = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

/** A number that may be absent or null -> `null`; a non-finite value also -> `null`. */
export const displayNumber = z
  .number()
  .nullish()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));

/**
 * `totalSupply` as the wire sends it: a raw integer STRING on sushi rows, null
 * on pools.fun rows. Kept as a string rather than coerced, because the value is
 * raw base units and passing it through `Number` is the precision loss rule 90
 * exists to prevent. Nothing downstream consumes it today.
 */
export const displayRawString = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined ? null : String(v)));
