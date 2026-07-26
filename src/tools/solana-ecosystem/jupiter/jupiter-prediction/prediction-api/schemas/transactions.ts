/**
 * Jupiter Prediction write-response schemas (codex-002) — FINANCIAL.
 *
 * The write endpoints (`/orders`, `DELETE /positions(/:id)`,
 * `/positions/:id/claim`) return a `transaction` blob that `service.ts` hands to
 * `signAndSendVersionedTx`, so the blob is validated FIRMLY as standard base64
 * when present.
 *
 * ERROR-PATH PRESERVATION: the service treats a FALSEY transaction value
 * (`null` or `""`) as a DOMAIN error (`requireTransaction` → HTTP_REQUEST_FAILED,
 * service.ts:79-90, used at :101). The prediction wire carries no `errorCode`/
 * `errorMessage` companion field, so the schema must accept a falsey transaction
 * value UNCONDITIONALLY — it must NOT pre-empt that domain mapping with
 * HTTP_RESPONSE_INVALID. The `transaction` KEY is still required (it is present
 * in every wire response, never absent); only its VALUE may be `""`/`null`.
 * Hence the refine allows `""`/`null` and enforces base64 only for a non-empty
 * string.
 */

import { z } from "zod";
import { isBase64 } from "../../../../shared/schemas.js";
import {
  transactionBlobMessage,
  transactionBlobRefine,
  txMetaFields,
} from "./_shared.js";

// ── Transaction meta & write responses (FINANCIAL) ─────────────────

const createOrderDetailsSchema = z
  .object({
    orderPubkey: z.string().nullable(),
    orderAtaPubkey: z.string().nullable(),
    userPubkey: z.string(),
    marketId: z.string(),
    marketIdHash: z.string(),
    positionPubkey: z.string(),
    isBuy: z.boolean(),
    isYes: z.boolean(),
    contracts: z.string(),
    contractsMicro: z.string().optional(),
    contractsDecimal: z.string().optional(),
    newContracts: z.string(),
    newContractsMicro: z.string().optional(),
    newContractsDecimal: z.string().optional(),
    maxBuyPriceUsd: z.string().nullable(),
    minSellPriceUsd: z.string().nullable(),
    externalOrderId: z.string().nullable(),
    orderCostUsd: z.string(),
    newAvgPriceUsd: z.string(),
    newSizeUsd: z.string(),
    newPayoutUsd: z.string(),
    estimatedProtocolFeeUsd: z.string(),
    estimatedVenueFeeUsd: z.string(),
    estimatedTotalFeeUsd: z.string(),
  })
  .passthrough();

/**
 * `execution` on a build response — the provider's managed-execution routing.
 *
 * CORRECTED 2026-07-25 (live-probed, `agents_dm/verify/probe-predict-execution-
 * lanes.ts`): this was previously documented as present only for
 * `executionModel: "atomic_swap"` (Jupiter Forecast/bisonfi). That is FALSE. A
 * keeper-filled Polymarket order returns `execution` with NO `executionModel`
 * at all:
 *   {"endpoint":"/api/v1/execute","context":{"type":"create_order"}}
 * while a Forecast order returns
 *   {"endpoint":"/api/v1/execute","context":{"type":"bisonfi_swap",...}}
 * with `executionModel: "atomic_swap"`. Presence of `execution` — not
 * `executionModel` — is the routing signal.
 *
 * `context` is opaque (`additionalProperties: true` in the OpenAPI spec) and
 * passed unchanged to the managed execute endpoint, so it is validated only as
 * a plain object. `endpoint` is a provider-supplied PATH and is NEVER used to
 * build a URL directly — see `managed-execution.ts`'s allowlist.
 */
const executionContextSchema = z.object({
  endpoint: z.string(),
  context: z.record(z.string(), z.unknown()),
});

/**
 * `requiredSigners` — "Public keys that must sign the returned transaction"
 * (Jupiter Create Order API reference). Live evidence shows this is the set of
 * signatures still OUTSTANDING, not every signer: a keeper-filled order whose
 * provider slots are already filled returns just `[ourWallet]`, while a
 * Forecast order whose fee-payer slot is still empty returns
 * `[jupiterFeePayer, ourWallet]`. `prepareVersionedTx`'s `coSigned` contract
 * depends on that distinction, so the field is validated here rather than left
 * to survive invisibly through `.passthrough()`.
 */
const requiredSignersSchema = z.array(z.string().min(1)).optional();

export const jupiterPredictionCreateOrderResponseSchema = z
  .object({
    ...txMetaFields,
    // base64 | null normally; "" / null pass for the falsey-tx domain error.
    transaction: z
      .string()
      .nullable()
      .refine(transactionBlobRefine, { message: transactionBlobMessage }),
    externalOrderId: z.string().nullable(),
    order: createOrderDetailsSchema,
    executionModel: z.string().nullable().optional(),
    execution: executionContextSchema.nullable().optional(),
    requiredSigners: requiredSignersSchema,
  })
  .passthrough();

const claimPositionDetailsSchema = z
  .object({
    positionPubkey: z.string(),
    marketPubkey: z.string(),
    userPubkey: z.string(),
    ownerPubkey: z.string(),
    isYes: z.boolean(),
    contracts: z.string(),
    contractsMicro: z.string().optional(),
    contractsDecimal: z.string().optional(),
    payoutAmountUsd: z.string(),
  })
  .passthrough();

export const jupiterPredictionClaimPositionResponseSchema = z
  .object({
    ...txMetaFields,
    // The wire type is `string` (not nullable) but the service still treats ""
    // as the falsey-tx domain error, so "" must pass; non-empty must be base64.
    transaction: z
      .string()
      .refine((t) => t === "" || isBase64(t), { message: transactionBlobMessage }),
    position: claimPositionDetailsSchema,
    // A claim build was NOT observable live (the gate wallet holds no
    // position), so whether a claim carries `execution`/`requiredSigners` is
    // UNVERIFIED. Both are accepted here rather than assumed absent — the
    // routing/signing layers read them if present and fail closed if not.
    execution: executionContextSchema.nullable().optional(),
    requiredSigners: requiredSignersSchema,
  })
  .passthrough();

/**
 * `DELETE /positions` close-all — an array whose items are EITHER a create-order
 * response (`order` field) or a claim response (`position` field). Each item's
 * transaction is executed by the service, so the financial blob is firm per
 * branch; the union mirrors `JupiterPredictionCloseAllPositionsItem`.
 */
export const jupiterPredictionCloseAllPositionsResponseSchema = z
  .object({
    data: z.array(
      z.union([
        jupiterPredictionCreateOrderResponseSchema,
        jupiterPredictionClaimPositionResponseSchema,
      ]),
    ),
  })
  .passthrough();

/**
 * `POST /execute` — managed execution for a Jupiter Forecast (bisonfi)
 * order. `signature` is non-null on `Success`; a `Failed` body may
 * legitimately carry a null signature (mirrors the Swap-domain `/execute`
 * schema's same-shaped invariant in `jupiter-swaps/schemas.ts`).
 */
export const jupiterPredictionExecuteResponseSchema = z
  .object({
    status: z.enum(["Success", "Failed"]),
    signature: z.string().nullable(),
    error: z.string().nullable(),
    requestId: z.string().optional(),
  })
  .passthrough()
  .refine((r) => r.status !== "Success" || !!r.signature, {
    message: "Success execute response is missing a signature",
    path: ["signature"],
  });
