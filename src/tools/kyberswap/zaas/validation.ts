/**
 * Zod runtime validators for KyberSwap ZaaS (Zap as a Service) API responses
 * (codex-002 Phase 2, full uniformity).
 *
 * These gate the SHAPE of zap route/build responses at the HTTP boundary before
 * the values feed transaction signing (`data.callData` + `data.routerAddress`
 * become the EVM zap transaction). Both validators are MIXED:
 *
 *   - `validateZapRouteResponse` is MIXED: a non-record root throws the plain
 *     `Error("Expected ZaaS route response object")`; `data.route` and
 *     `data.routerAddress` are STRICT required non-empty strings (Etap 4 —
 *     they feed transaction signing: `data.route` is the encoded route replayed
 *     into `route/build`, and `data.routerAddress` is the approval/tx target, so
 *     a missing/blank value must fail closed rather than silently default to
 *     `undefined` and mask shape drift). They throw
 *     `VexError(KYBER_API_ERROR, "Invalid KyberSwap ZaaS response: missing …")`,
 *     identical to the build validator's callData/routerAddress checks. The
 *     handler guards (`if (!routeResp.data.route || !routeResp.data.routerAddress)`)
 *     remain as defense-in-depth. Every OTHER field stays lenient-defaulting
 *     (number→0, string→undefined/raw, sub-records→undefined).
 *   - `validateZapBuildResponse` is MIXED: a non-record root throws the same
 *     plain `Error`, `data.callData`/`data.routerAddress` are STRICT and throw
 *     `VexError(KYBER_API_ERROR, "Invalid KyberSwap ZaaS response: missing …")`
 *     (mirroring `createFieldValidators(KYBER_API_ERROR, "KyberSwap ZaaS")`),
 *     and the remaining fields default.
 *
 * The schemas are intentionally NOT the type source of truth — the wire
 * interfaces in `types.ts` remain canonical, and each exported validator keeps
 * its declared return type so `tsc` verifies the inferred schema output is
 * assignable to that interface. The exported function API (names, signatures,
 * return types) is preserved so `client.ts` call sites stay unchanged.
 *
 * Behaviour-preservation notes:
 *   - `code` used the hand-written `typeof raw.code === "number" ? raw.code : 0`
 *     guard, which has NO NaN check — it accepts NaN AND ±Infinity. So it is
 *     modelled with a lenient `numDefault(0)` (`typeof v === "number" ? v : def`),
 *     NOT `z.number()` (which rejects Infinity) and NOT `zNumberField` (which
 *     rejects NaN).
 *   - `route`/`routerAddress`/`gas`/`gasUsd`/value-style fields used bare
 *     `typeof === "string"` (empty string `""` PASSES), so they use a local
 *     `strOrUndefined`/`strDefault`, NOT `zOptionalString` (which drops "").
 *   - `routeSummary` used `?? undefined`, preserving any non-nullish value
 *     verbatim (numbers, arrays, objects), so it is preserved raw.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import { zOptionalString } from "../../../utils/zod-validation-helpers.js";
import type { ZapRouteResponse, ZapBuildResponse } from "./types.js";

// ---------------------------------------------------------------------------
// Local helpers — mirror the exact hand-written guards used by these responses.
// ---------------------------------------------------------------------------

/** Local `isRecord` (non-null, non-array object), used inside transforms. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mirrors `typeof v === "number" ? v : def` (NO NaN check — accepts NaN AND
 * ±Infinity, exactly like the original `code` guard).
 */
const numDefault = (def: number): z.ZodType<number> =>
  z.unknown().transform((v) => (typeof v === "number" ? v : def));

/**
 * Mirrors bare `typeof v === "string" ? v : undefined` (an EMPTY string passes
 * through — this is NOT `asOptionalString`, which drops "").
 */
const strOrUndefined: z.ZodType<string | undefined> = z
  .unknown()
  .transform((v) => (typeof v === "string" ? v : undefined));

/**
 * Mirrors bare `typeof v === "number" ? v : undefined` (accepts NaN/Infinity;
 * used for poolDetails.fee / positionDetails.tick* which had no NaN check).
 */
const numOrUndefined: z.ZodType<number | undefined> = z
  .unknown()
  .transform((v) => (typeof v === "number" ? v : undefined));

/** Mirrors `typeof v === "string" ? v : def` (empty string passes through). */
const strDefault = (def: string): z.ZodType<string> =>
  z.unknown().transform((v) => (typeof v === "string" ? v : def));

/**
 * Mirrors `createFieldValidators(KYBER_API_ERROR, "KyberSwap ZaaS").asString`:
 * a non-empty string, else throw `VexError(KYBER_API_ERROR, "Invalid KyberSwap
 * ZaaS response: missing <field>")`. Returned typed and thrown identically to
 * the hand-written helper.
 */
function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VexError(
      ErrorCodes.KYBER_API_ERROR,
      `Invalid KyberSwap ZaaS response: missing ${field}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Zap route response (lenient-defaulting)
// ---------------------------------------------------------------------------

/**
 * poolDetails sub-object: ONLY built when the parent is a record, else the
 * whole sub-object is `undefined` (mirrors `isRecord(data.poolDetails) ? {…} :
 * undefined`). Each field is a bare `typeof` guard → undefined on mismatch.
 */
const poolDetailsSchema: z.ZodType<ZapRouteResponse["data"]["poolDetails"]> = z
  .unknown()
  .transform((v) => {
    if (!isRecordValue(v)) return undefined;
    return {
      category: typeof v.category === "string" ? v.category : undefined,
      token0: typeof v.token0 === "string" ? v.token0 : undefined,
      token1: typeof v.token1 === "string" ? v.token1 : undefined,
      fee: typeof v.fee === "number" ? v.fee : undefined,
      address: typeof v.address === "string" ? v.address : undefined,
    };
  });

/**
 * positionDetails sub-object: same record-gated shape as poolDetails.
 */
const positionDetailsSchema: z.ZodType<ZapRouteResponse["data"]["positionDetails"]> = z
  .unknown()
  .transform((v) => {
    if (!isRecordValue(v)) return undefined;
    return {
      tokenId: typeof v.tokenId === "string" ? v.tokenId : undefined,
      tickLower: typeof v.tickLower === "number" ? v.tickLower : undefined,
      tickUpper: typeof v.tickUpper === "number" ? v.tickUpper : undefined,
      liquidity: typeof v.liquidity === "string" ? v.liquidity : undefined,
    };
  });

/**
 * `data` block. Built from `isRecord(raw.data) ? raw.data : {}` (a non-record
 * `data` collapses to an empty object → so a non-record/absent `data` fails the
 * strict `route`/`routerAddress` checks below with the same `missing data.route`
 * VexError). Every field is lenient EXCEPT `route`/`routerAddress`, which are
 * STRICT required non-empty strings (Etap 4).
 */
const routeDataSchema: z.ZodType<ZapRouteResponse["data"]> = z
  .preprocess(
    (v) => (isRecordValue(v) ? v : {}),
    z.object({
      // `data.routeSummary ?? undefined`: any non-nullish value preserved raw.
      routeSummary: z.unknown().transform((v) => v ?? undefined),
      // `isRecord(data.zapDetails) ? data.zapDetails as … : undefined`: raw
      // subtree passthrough — the original cast the raw record to ZapDetails
      // WITHOUT validating its shape, so we preserve that exactly. The cast goes
      // through `unknown` because narrowing `v` to Record<string,unknown> first
      // (via isRecordValue) makes a direct assertion an insufficient-overlap
      // error; validating ZapDetails here would change behavior.
      zapDetails: z
        .unknown()
        .transform((v) =>
          isRecordValue(v)
            ? (v as unknown as ZapRouteResponse["data"]["zapDetails"])
            : undefined,
        ),
      // Etap 4: STRICT required non-empty string (feeds route/build + signing).
      // Throws VexError(KYBER_API_ERROR, "missing data.route") via `asString`,
      // exactly like the build validator's strict fields — a blank/missing route
      // must fail closed, not default to undefined.
      route: z.unknown().transform((v) => asString(v, "data.route")),
      // Etap 4: STRICT required non-empty string — the approval / tx target.
      // Keeps the same `as Address` cast as before (the checksum is verified
      // later by `verifyRouterAddress`); only the string guard becomes
      // fail-closed instead of defaulting to undefined.
      routerAddress: z
        .unknown()
        .transform((v) => asString(v, "data.routerAddress") as ZapRouteResponse["data"]["routerAddress"]),
      poolDetails: poolDetailsSchema,
      positionDetails: positionDetailsSchema,
      gas: strOrUndefined,
      gasUsd: strOrUndefined,
    }),
  )
  .transform((d) => d as ZapRouteResponse["data"]);

const zapRouteEnvelopeSchema: z.ZodType<ZapRouteResponse> = z
  .object({
    code: numDefault(0),
    message: zOptionalString,
    data: routeDataSchema,
    requestId: zOptionalString,
  })
  .transform((r) => r as ZapRouteResponse);

export function validateZapRouteResponse(raw: unknown): ZapRouteResponse {
  if (!isRecordValue(raw)) {
    throw new Error("Expected ZaaS route response object");
  }
  // Etap 4: the schema now REJECTS a record root whose `data.route` or
  // `data.routerAddress` is missing/blank — the strict transforms throw a
  // VexError(KYBER_API_ERROR) that `parse()` propagates verbatim (Zod does not
  // wrap thrown transform errors). Every other field still defaults.
  return zapRouteEnvelopeSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// Zap build response (MIXED: strict required fields + lenient root/extras)
// ---------------------------------------------------------------------------

export function validateZapBuildResponse(raw: unknown): ZapBuildResponse {
  if (!isRecordValue(raw)) {
    throw new Error("Expected ZaaS build response object");
  }
  const data = isRecordValue(raw.data) ? raw.data : {};

  // Lenient extras parsed via Zod; strict required fields use `asString`, which
  // throws VexError(KYBER_API_ERROR) with the original field-path message.
  const extras = z
    .object({
      code: numDefault(0),
      message: zOptionalString,
      value: strDefault("0"),
      requestId: zOptionalString,
    })
    .parse({
      code: raw.code,
      message: raw.message,
      value: data.value,
      requestId: raw.requestId,
    });

  return {
    code: extras.code,
    message: extras.message,
    data: {
      // `?? ` (nullish): empty-string callData does NOT fall through to data.data,
      // it reaches asString and throws — identical to the original.
      callData: asString(data.callData ?? data.data, "data.callData"),
      routerAddress: asString(data.routerAddress, "data.routerAddress") as ZapBuildResponse["data"]["routerAddress"],
      value: extras.value,
    },
    requestId: extras.requestId,
  };
}
