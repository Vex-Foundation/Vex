/**
 * Zod runtime validators for KyberSwap Aggregator API responses
 * (codex-002 Phase 2, full uniformity).
 *
 * FINANCIAL boundary: these gate GET /routes (swap route summary) and
 * POST /route/build (built calldata + transactionValue) responses before the
 * values feed transaction signing — firm amounts, addresses, and calldata. The
 * conversion is BEHAVIOR-PRESERVING with the hand-written validators it
 * replaces; see the per-failure-mode notes below.
 *
 * Pattern: MIXED.
 *   - Structural/root mismatches (non-record response, non-record `data`,
 *     non-record route step / routeSummary) throw a PLAIN `Error` with the
 *     SAME message the original threw (NOT a VexError).
 *   - Required scalar fields use the shared Zod field primitives, which mirror
 *     `createFieldValidators(KYBER_API_ERROR, "KyberSwap Aggregator")` and throw
 *     `VexError(KYBER_API_ERROR, "Invalid KyberSwap Aggregator response: missing
 *     <field>")` on the first bad field.
 *   - `parseExtraFee` is fully lenient (never throws; defaults each field).
 *
 * The wire interfaces in `types.ts` remain the type source of truth; each
 * exported validator keeps its declared return type so `tsc` verifies the
 * parsed shape is assignable. The exported function names, signatures, and
 * return types are preserved so `client.ts` call sites stay unchanged.
 *
 * Field evaluation order is preserved field-by-field (the original evaluated
 * scalars top-to-bottom in object-literal order, so the FIRST bad field's
 * message surfaces). The schemas are applied per-field in that same order so a
 * multi-failure input throws the identical first message.
 *
 * Zod-4 numeric gotcha: `code` was validated with `asNumber`, which accepts any
 * `typeof === "number" && !Number.isNaN` — INCLUDING ±Infinity. We use
 * `zNumberField` (NOT `z.number()`, which rejects Infinity) to match exactly.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import {
  zNumberField,
  zStringField,
  zOptionalString,
} from "../../../utils/zod-validation-helpers.js";
import type {
  SwapRouteResponse,
  SwapRouteSummary,
  SwapRouteStep,
  SwapBuildResponse,
  SwapExtraFee,
} from "./types.js";

const PREFIX = "KyberSwap Aggregator";

// ---------------------------------------------------------------------------
// Field primitives — mirror createFieldValidators(KYBER_API_ERROR, prefix).
// Each throws VexError(KYBER_API_ERROR) with the SAME field-path message.
// ---------------------------------------------------------------------------

/** Mirrors `asString(value, field)`: non-empty string, else `missing <field>`. */
function asString(value: unknown, field: string): string {
  const result = zStringField(`Invalid ${PREFIX} response: missing ${field}`).safeParse(value);
  if (result.success) return result.data;
  throw new VexError(ErrorCodes.KYBER_API_ERROR, result.error.issues[0].message);
}

/** Mirrors `asNumber(value, field)`: non-NaN number (incl. ±Infinity), else `missing <field>`. */
function asNumber(value: unknown, field: string): number {
  const result = zNumberField(`Invalid ${PREFIX} response: missing ${field}`).safeParse(value);
  if (result.success) return result.data;
  throw new VexError(ErrorCodes.KYBER_API_ERROR, result.error.issues[0].message);
}

/** Mirrors `asOptionalString`: non-empty string, else `undefined` (never throws). */
function asOptionalString(value: unknown): string | undefined {
  // zOptionalString's transform never fails, so safeParse always succeeds.
  const result = zOptionalString.safeParse(value);
  return result.success ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// Lenient sub-parser: parseExtraFee (never throws; defaults each field).
// ---------------------------------------------------------------------------

/**
 * Mirrors the original `parseExtraFee`: non-record → `undefined`; otherwise
 * `feeAmount` defaults to `""`, the enum/boolean/string fields default to
 * `undefined`. Modelled lenient — never throws.
 */
const extraFeeSchema: z.ZodType<SwapExtraFee | undefined> = z
  .unknown()
  .optional()
  .transform((v): SwapExtraFee | undefined => {
    if (!isRecord(v)) return undefined;
    return {
      feeAmount: typeof v.feeAmount === "string" ? v.feeAmount : "",
      chargeFeeBy:
        v.chargeFeeBy === "currency_in" || v.chargeFeeBy === "currency_out"
          ? v.chargeFeeBy
          : undefined,
      isInBps: typeof v.isInBps === "boolean" ? v.isInBps : undefined,
      feeReceiver: typeof v.feeReceiver === "string" ? v.feeReceiver : undefined,
    };
  });

function parseExtraFee(raw: unknown): SwapExtraFee | undefined {
  // The transform never fails, so success is always true.
  const result = extraFeeSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// Route step — non-record root throws a PLAIN Error (NOT VexError); required
// scalar fields throw VexError via asString.
// ---------------------------------------------------------------------------

function parseRouteStep(raw: unknown): SwapRouteStep {
  if (!isRecord(raw)) {
    throw new Error("route step must be an object");
  }
  return {
    pool: asString(raw.pool, "route.pool"),
    tokenIn: asString(raw.tokenIn, "route.tokenIn"),
    tokenOut: asString(raw.tokenOut, "route.tokenOut"),
    swapAmount: asString(raw.swapAmount, "route.swapAmount"),
    amountOut: asString(raw.amountOut, "route.amountOut"),
    exchange: asString(raw.exchange, "route.exchange"),
    poolType: asString(raw.poolType, "route.poolType"),
    poolExtra: raw.poolExtra ?? null,
    extra: raw.extra ?? null,
  };
}

// ---------------------------------------------------------------------------
// Route summary — non-record root throws a PLAIN Error; `route` is built with
// the original's nested element-wise mapping (non-array path → []).
// ---------------------------------------------------------------------------

function parseRouteSummary(raw: unknown): SwapRouteSummary {
  if (!isRecord(raw)) {
    throw new Error("routeSummary must be an object");
  }

  const route = Array.isArray(raw.route)
    ? raw.route.map((path) => {
        if (!Array.isArray(path)) return [];
        return path.map(parseRouteStep);
      })
    : [];

  return {
    tokenIn: asString(raw.tokenIn, "routeSummary.tokenIn"),
    amountIn: asString(raw.amountIn, "routeSummary.amountIn"),
    amountInUsd: asString(raw.amountInUsd, "routeSummary.amountInUsd"),
    tokenOut: asString(raw.tokenOut, "routeSummary.tokenOut"),
    amountOut: asString(raw.amountOut, "routeSummary.amountOut"),
    amountOutUsd: asString(raw.amountOutUsd, "routeSummary.amountOutUsd"),
    gas: asString(raw.gas, "routeSummary.gas"),
    gasPrice: asString(raw.gasPrice, "routeSummary.gasPrice"),
    gasUsd: asString(raw.gasUsd, "routeSummary.gasUsd"),
    l1FeeUsd: asOptionalString(raw.l1FeeUsd),
    extraFee: parseExtraFee(raw.extraFee),
    route,
    routeID: asString(raw.routeID, "routeSummary.routeID"),
    checksum: asString(raw.checksum, "routeSummary.checksum"),
    timestamp: asOptionalString(raw.timestamp),
  };
}

// ---------------------------------------------------------------------------
// Exported validators
// ---------------------------------------------------------------------------

export function validateSwapRouteResponse(raw: unknown): SwapRouteResponse {
  if (!isRecord(raw)) {
    throw new Error("Expected KyberSwap route response object");
  }
  const code = asNumber(raw.code, "code");
  const data = raw.data;
  if (!isRecord(data)) {
    throw new Error("Expected KyberSwap route response data");
  }

  return {
    code,
    message: asOptionalString(raw.message),
    data: {
      routeSummary: parseRouteSummary(data.routeSummary),
      // Cast preserved from the original (asString returns string, branded as Address).
      routerAddress: asString(data.routerAddress, "data.routerAddress") as SwapRouteResponse["data"]["routerAddress"],
    },
    requestId: asOptionalString(raw.requestId),
  };
}

export function validateSwapBuildResponse(raw: unknown): SwapBuildResponse {
  if (!isRecord(raw)) {
    throw new Error("Expected KyberSwap build response object");
  }
  const code = asNumber(raw.code, "code");
  const data = raw.data;
  if (!isRecord(data)) {
    throw new Error("Expected KyberSwap build response data");
  }

  return {
    code,
    message: asOptionalString(raw.message),
    data: {
      amountIn: asString(data.amountIn, "data.amountIn"),
      amountInUsd: asString(data.amountInUsd, "data.amountInUsd"),
      amountOut: asString(data.amountOut, "data.amountOut"),
      amountOutUsd: asString(data.amountOutUsd, "data.amountOutUsd"),
      gas: asString(data.gas, "data.gas"),
      gasUsd: asString(data.gasUsd, "data.gasUsd"),
      additionalCostUsd: asOptionalString(data.additionalCostUsd),
      additionalCostMessage: asOptionalString(data.additionalCostMessage),
      data: asString(data.data, "data.data"),
      // Cast preserved from the original (asString returns string, branded as Address).
      routerAddress: asString(data.routerAddress, "data.routerAddress") as SwapBuildResponse["data"]["routerAddress"],
      transactionValue: asString(data.transactionValue, "data.transactionValue"),
    },
    requestId: asOptionalString(raw.requestId),
  };
}
