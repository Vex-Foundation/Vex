/**
 * Zod response schemas for the Jupiter Swap API V2 (/order, /build, /execute).
 *
 * codex-002: these gate the SHAPE of swap responses at the HTTP boundary
 * before the values feed transaction signing (`service.ts` signs
 * `order.transaction`). Financial fields are validated firmly — the signed
 * transaction blob must be base64, amounts/ids must be present — while the
 * objects `.passthrough()` unknown keys so the upstream API can add fields
 * without breaking us (services forward the raw response downstream).
 *
 * Zod gates shape only; it cannot prove a transaction is economically safe.
 * Downstream deserialize/sign checks remain the source of truth for that.
 *
 * The schemas are intentionally NOT the type source of truth — the wire
 * interfaces in `types.ts` remain canonical, and each client function's
 * declared return type makes `tsc` verify the inferred schema output is
 * assignable to that interface.
 */

import { z } from "zod";
import {
  base64String,
  isBase64,
  nonEmptyString,
  solanaInstructionWireSchema,
} from "../../shared/schemas.js";

const swapInstructionSchema = solanaInstructionWireSchema;

const routeSwapInfoSchema = z
  .object({
    ammKey: z.string(),
    label: z.string(),
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: z.string(),
    outAmount: z.string(),
  })
  .passthrough();

const routePlanStepSchema = z
  .object({
    swapInfo: routeSwapInfoSchema,
    percent: z.number(),
    bps: z.number(),
    usdValue: z.number().optional(),
  })
  .passthrough();

const platformFeeSchema = z
  .object({
    // `/swap/v2/order` omits `amount` at quote time (the fee amount is only
    // materialized at execute); on fee-bearing routes it has been observed as
    // both string and number. Accept all three shapes and normalize to string.
    // Verified against the live api.jup.ag/swap/v2/order response.
    amount: z.union([z.string(), z.number()]).transform(String).optional(),
    feeBps: z.number(),
    feeMint: z.string(),
  })
  .passthrough();

/**
 * `/order` — quote + (optionally) the unsigned transaction to sign. The RFQ
 * path can return `transaction: null` (no tx yet), so the financial blob is
 * `base64 | null`, but `requestId` and the core amounts must be present.
 */
export const jupiterSwapOrderResponseSchema = z
  .object({
    mode: z.string(),
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: nonEmptyString,
    outAmount: nonEmptyString,
    inUsdValue: z.number().optional(),
    outUsdValue: z.number().optional(),
    priceImpact: z.number().optional(),
    swapUsdValue: z.number().optional(),
    otherAmountThreshold: nonEmptyString,
    swapMode: z.string().optional(),
    slippageBps: z.number().optional(),
    priceImpactPct: z.string().optional(),
    routePlan: z.array(routePlanStepSchema),
    referralAccount: z.string().optional(),
    feeMint: z.string().optional(),
    feeBps: z.number().optional(),
    platformFee: platformFeeSchema.optional(),
    signatureFeeLamports: z.number().optional(),
    signatureFeePayer: z.string().nullable().optional(),
    prioritizationFeeLamports: z.number().optional(),
    prioritizationFeePayer: z.string().nullable().optional(),
    rentFeeLamports: z.number().optional(),
    rentFeePayer: z.string().nullable().optional(),
    swapType: z
      .enum(["aggregator", "rfq", "aggregator+rfq", "dflow", "okx"])
      .optional(),
    router: z.string().optional(),
    // base64 | null normally; "" is allowed ONLY on Jupiter's 200-level error
    // path (see the refine below), validated there to preserve the service's
    // SOLANA_QUOTE_FAILED mapping.
    transaction: z.string().nullable(),
    lastValidBlockHeight: z.string().optional(),
    gasless: z.boolean().optional(),
    requestId: nonEmptyString,
    totalTime: z.number().optional(),
    taker: z.string().nullable().optional(),
    quoteId: z.string().optional(),
    maker: z.string().optional(),
    expireAt: z.string().optional(),
    errorCode: z.number().optional(),
    errorMessage: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough()
  .refine(
    (r) => {
      const t = r.transaction;
      if (t === null) return true;
      // Jupiter's 200-level quote failure returns transaction:"" with an
      // errorCode/errorMessage/error; the service maps that to a domain
      // SOLANA_QUOTE_FAILED, so we must NOT reject it as a malformed shape.
      if (t === "") {
        return r.errorCode != null || r.errorMessage != null || r.error != null;
      }
      return isBase64(t);
    },
    {
      message: "transaction must be base64, null, or empty only alongside an error field",
      path: ["transaction"],
    },
  );

// DOCS-GAP: the docs (`/docs/swap/build/index.md`) describe an additional
// `fetchedAt: string (ISO8601)` field here, but the live 2026-07-23 fixture
// returns `fetchedAt: { secs_since_epoch: number, nanos_since_epoch: number }`
// instead — the two sources disagree on its shape. Nothing in this module
// consumes `fetchedAt`, so it is deliberately left off `JupiterSwapBuildBlockhashWithMetadata`
// (the canonical type) rather than modeled with an uncertain shape; `.passthrough()`
// still accepts it either way.
const blockhashWithMetadataSchema = z
  .object({
    blockhash: z.array(z.number()),
    lastValidBlockHeight: z.number(),
  })
  .passthrough();

/**
 * `/build` — returns the instruction set to assemble + sign locally. The
 * swap instruction is required; setup/compute/cleanup may be empty/null.
 */
export const jupiterSwapBuildResponseSchema = z
  .object({
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: nonEmptyString,
    outAmount: nonEmptyString,
    otherAmountThreshold: nonEmptyString,
    swapMode: z.string().optional(),
    slippageBps: z.number().optional(),
    // Undocumented on the /build reference page, but the live API returns it
    // (2026-07-23 fixture) — see JupiterSwapBuildResponse.priceImpactPct.
    priceImpactPct: z.string().optional(),
    routePlan: z.array(routePlanStepSchema),
    computeBudgetInstructions: z.array(swapInstructionSchema),
    setupInstructions: z.array(swapInstructionSchema),
    swapInstruction: swapInstructionSchema,
    cleanupInstruction: swapInstructionSchema.nullable(),
    otherInstructions: z.array(swapInstructionSchema),
    // Present (possibly null) only when `tipAmount` was requested; optional
    // here so responses recorded before this field existed still validate.
    tipInstruction: swapInstructionSchema.nullable().optional(),
    addressesByLookupTableAddress: z
      .record(z.string(), z.array(z.string()))
      .nullable()
      .optional(),
    blockhashWithMetadata: blockhashWithMetadataSchema.optional(),
  })
  .passthrough();

/**
 * `/execute` — broadcast result. `signature` must be present on success;
 * a `Failed` body may legitimately carry an empty signature, so the
 * non-empty invariant is enforced only for `status: "Success"` (rejecting an
 * empty signature on failure would turn a clean swap-failure into a
 * validation error).
 */
export const jupiterSwapExecuteResponseSchema = z
  .object({
    status: z.enum(["Success", "Failed"]),
    signature: z.string(),
    code: z.number(),
    inputAmountResult: z.string(),
    outputAmountResult: z.string(),
    error: z.string().optional(),
  })
  .passthrough()
  .refine((r) => r.status !== "Success" || r.signature.length > 0, {
    message: "Success execute response is missing a signature",
    path: ["signature"],
  });

/**
 * `/tx/v1/submit` — self-managed landing pipeline for any signed transaction.
 * Success only ever returns a bare signature; failures come back as a 400
 * with `{ error }`, handled generically by `fetchJson`'s non-2xx path.
 */
export const jupiterSwapSubmitResponseSchema = z
  .object({
    signature: nonEmptyString,
  })
  .passthrough();
