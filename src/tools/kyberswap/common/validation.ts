/**
 * Zod response schemas + validators for the KyberSwap Common Service
 * (codex-002 Phase 2, full uniformity).
 *
 * This endpoint feeds dynamic chain discovery (supported-chains), which gates
 * which chains the KyberSwap aggregator client will operate on. The original
 * used the STRICT field pattern: a malformed required field
 * (chainId/chainName/displayName/state) throws
 * `VexError(KYBER_API_ERROR, "Invalid KyberSwap Common Service response: missing <field>")`,
 * while the two ROOT-shape guards (chain-info-not-object, response-without-data-array)
 * throw a PLAIN `Error` with their exact original messages.
 *
 * The schemas are intentionally NOT the type source of truth — `types.ts`
 * (`KyberChainInfo`) remains canonical, and each exported validator keeps its
 * declared return type so `tsc` verifies the inferred schema output is
 * assignable to that interface. The exported function API (name, signature,
 * return type) is preserved so `client.ts` call sites stay unchanged.
 *
 * Behaviour-preservation notes:
 *  - `asNumber`/`asString` are mirrored via the shared zod helpers
 *    (`zNumberField` accepts ±Infinity, which Zod 4 `z.number()` would wrongly
 *    reject; the original `asNumber` accepted it).
 *  - The original computes `state` via `asString` (so a missing/non-string
 *    `state` throws the VexError) BEFORE mapping it; only a PRESENT non-empty
 *    string that is not one of {active,inactive,new} maps to "inactive".
 *  - Element-wise: `raw.data.map(parseChainInfo)` validates every element
 *    strictly (one bad element throws); it does NOT filter — replicated by
 *    mapping each element through the strict schema.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { zNumberField, zStringField } from "../../../utils/zod-validation-helpers.js";
import type { KyberChainInfo } from "../types.js";

const PREFIX = "KyberSwap Common Service";

/**
 * Parse `raw` with `schema`, returning the typed value or throwing the SAME
 * `VexError(KYBER_API_ERROR, msg)` the hand-written `createFieldValidators`
 * helpers would have. Every required-field rule below carries the original
 * `Invalid <prefix> response: missing <field>` message, so the surfaced first
 * issue is equivalent to the original short-circuit throw.
 */
function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new VexError(ErrorCodes.KYBER_API_ERROR, issue.message);
}

/** Mirrors `asString(value, field)`: non-empty string, else `missing <field>`. */
function asString(field: string): z.ZodType<string> {
  return zStringField(`Invalid ${PREFIX} response: missing ${field}`);
}

/** Mirrors `asNumber(value, field)`: any non-NaN number (incl. ±Infinity), else `missing <field>`. */
function asNumber(field: string): z.ZodType<number> {
  return zNumberField(`Invalid ${PREFIX} response: missing ${field}`);
}

/** Local `isRecord` (non-null, non-array object) — mirrors validation-helpers.isRecord. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Chain info
// ---------------------------------------------------------------------------

/**
 * Mirrors `parseChainInfo`. Field order matches the original: `state` is
 * validated via `asString` first (so a missing/non-string `state` throws before
 * any mapping), then chainId/chainName/displayName in the return literal's order.
 * A present non-empty `state` that is not in {active,inactive,new} maps to
 * "inactive".
 */
const chainInfoSchema: z.ZodType<KyberChainInfo> = z
  .object({
    state: asString("chain.state"),
    chainId: asNumber("chain.chainId"),
    chainName: asString("chain.chainName"),
    displayName: asString("chain.displayName"),
  })
  .transform((c) => ({
    chainId: c.chainId,
    chainName: c.chainName,
    displayName: c.displayName,
    state:
      c.state === "active" || c.state === "inactive" || c.state === "new"
        ? c.state
        : ("inactive" as const),
  }));

function parseChainInfo(raw: unknown): KyberChainInfo {
  if (!isRecordValue(raw)) {
    // PLAIN Error in the original (NOT VexError) — preserved exactly.
    throw new Error("chain info must be an object");
  }
  return parseOrThrow(chainInfoSchema, raw);
}

// ---------------------------------------------------------------------------
// Exported validator
// ---------------------------------------------------------------------------

export function validateSupportedChainsResponse(raw: unknown): KyberChainInfo[] {
  if (!isRecordValue(raw) || !Array.isArray(raw.data)) {
    // PLAIN Error in the original (NOT VexError) — preserved exactly.
    throw new Error("Expected supported chains response with data array");
  }
  return raw.data.map(parseChainInfo);
}
