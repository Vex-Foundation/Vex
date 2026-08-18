/**
 * Zod runtime validators for KyberSwap Token API responses.
 *
 * codex-002 Phase 2 (full uniformity): these gate the SHAPE of token-search and
 * honeypot/FOT responses at the HTTP boundary before the values feed swap/quote
 * UI and bot decisions. This file is MIXED:
 *
 *   - `parseToken` / `validateTokenSearchResponse` are STRICT at the field level
 *     — a malformed required token field throws
 *     `VexError(KYBER_TOKEN_SEARCH_FAILED)` with the original field-path message
 *     (`asString`/`asNumber` semantics) — but the ROOT-type guards throw a plain
 *     `Error` with the original message, exactly as the hand-written code did.
 *   - `validateHoneypotFotResponse` is LENIENT-DEFAULTING — every field falls
 *     back to its original default and only a non-record root throws a plain
 *     `Error`.
 *
 * The schemas are intentionally NOT the type source of truth — the wire
 * interfaces in `types.ts` remain canonical, and each exported validator keeps
 * its declared return type so `tsc` verifies the inferred schema output is
 * assignable to that interface. The exported function API (names, signatures,
 * return types) is preserved so `client.ts` call sites stay unchanged.
 *
 * Behaviour-preservation notes:
 *   - `decimals`/`marketCap` use the shared number guard (accepts ±Infinity,
 *     rejects NaN), NOT `z.number()` which would wrongly reject Infinity.
 *   - `tax` mirrors `typeof x === "number" ? x : 0`, which ACCEPTS NaN, so it
 *     uses a local lenient transform, not the strict number guard.
 *   - `tokens` is element-wise mapped via `parseToken` (which itself throws on a
 *     non-record element); a non-array `tokens` collapses to `[]`.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import {
  zNumberField,
  zStringField,
  zOptionalNumber,
} from "../../../utils/zod-validation-helpers.js";
import type { KyberToken, KyberTokenSearchResponse, HoneypotFotInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Throw helper — reproduces the original VexError(KYBER_TOKEN_SEARCH_FAILED, ...).
// ---------------------------------------------------------------------------

/**
 * Parse `raw` with `schema`, returning the typed value or throwing the SAME
 * `VexError(KYBER_TOKEN_SEARCH_FAILED, msg)` the hand-written field validators
 * would have. Every required-field rule below carries the original field-path
 * message, so the surfaced message is equivalent to the original throw.
 */
function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new VexError(ErrorCodes.KYBER_TOKEN_SEARCH_FAILED, issue.message);
}

// ---------------------------------------------------------------------------
// Field primitives — mirror createFieldValidators(KYBER_TOKEN_SEARCH_FAILED,
// "KyberSwap Token API").
// ---------------------------------------------------------------------------

/** Mirrors `asString(value, field)`: non-empty string, else `missing <field>`. */
function asString(field: string): z.ZodType<string> {
  return zStringField(`Invalid KyberSwap Token API response: missing ${field}`);
}

/** Mirrors `asNumber(value, field)`: any non-NaN number (incl. ±Infinity), else `missing <field>`. */
function asNumber(field: string): z.ZodType<number> {
  return zNumberField(`Invalid KyberSwap Token API response: missing ${field}`);
}

/** Mirrors `typeof v === "boolean" ? v : undefined` (never throws). */
const optionalBoolean: z.ZodType<boolean | undefined> = z
  .unknown()
  .optional()
  .transform((v) => (typeof v === "boolean" ? v : undefined));

// ---------------------------------------------------------------------------
// Token (field-level strict; element root is a plain Error)
// ---------------------------------------------------------------------------

/**
 * Field-level shape of a token. `asString`/`asNumber` rules throw the original
 * `VexError(KYBER_TOKEN_SEARCH_FAILED)` field-path messages via `parseOrThrow`.
 * The non-record root short-circuit stays a plain `Error` (see `parseToken`).
 */
const tokenFieldsSchema = z.object({
  address: asString("token.address"),
  symbol: asString("token.symbol"),
  name: asString("token.name"),
  decimals: asNumber("token.decimals"),
  marketCap: zOptionalNumber,
  isVerified: optionalBoolean,
  isWhitelisted: optionalBoolean,
  isStable: optionalBoolean,
});

function parseToken(raw: unknown): KyberToken {
  // Original short-circuit: non-record → plain Error (NOT VexError).
  if (!isRecord(raw)) {
    throw new Error("token must be an object");
  }
  return parseOrThrow(tokenFieldsSchema, raw);
}

// ---------------------------------------------------------------------------
// Token search response (plain-Error root; strict tokens; computed defaults)
// ---------------------------------------------------------------------------

export function validateTokenSearchResponse(raw: unknown): KyberTokenSearchResponse {
  // Original short-circuit: non-record root OR non-record `data` → plain Error.
  if (!isRecord(raw) || !isRecord(raw.data)) {
    throw new Error("Expected Token API search response with data wrapper");
  }
  const data = raw.data;
  // Non-array tokens → []; array → element-wise parseToken (throws per element).
  const tokens = Array.isArray(data.tokens) ? data.tokens.map(parseToken) : [];
  const pagination = isRecord(data.pagination) ? data.pagination : {};

  return {
    data: {
      tokens,
      pagination: {
        totalItems:
          typeof pagination.totalItems === "number" ? pagination.totalItems : tokens.length,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Honeypot / FOT (lenient: defaults every field; plain Error only on bad root)
// ---------------------------------------------------------------------------

const honeypotFotFieldsSchema = z.object({
  // `typeof v === "boolean" ? v : false`
  isHoneypot: z.unknown().optional().transform((v) => (typeof v === "boolean" ? v : false)),
  isFOT: z.unknown().optional().transform((v) => (typeof v === "boolean" ? v : false)),
  // `typeof v === "number" ? v : 0` — ACCEPTS NaN (typeof NaN === "number"), so
  // this is NOT the strict number guard.
  tax: z.unknown().optional().transform((v) => (typeof v === "number" ? v : 0)),
});

export function validateHoneypotFotResponse(raw: unknown): HoneypotFotInfo {
  // Original short-circuit: non-record root → plain Error.
  if (!isRecord(raw)) {
    throw new Error("Expected honeypot/FOT response object");
  }
  // The field schema never throws (all transforms default), so safeParse cannot
  // fail here; parse directly to keep the lenient never-throw guarantee.
  return honeypotFotFieldsSchema.parse(raw);
}
