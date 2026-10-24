/**
 * `EV.engine.inferenceNotice` - a request that succeeded, but not quite as
 * asked, which the user must be told about (never silently).
 *
 * Four kinds. `max_tokens_clamped`: Vex Cloud lowered `max_tokens` (owner decision D16). The
 * gateway disclosed it in the `x-vex-max-tokens` response header; the engine
 * read it (`inference/openrouter/round-fetch.ts`) and the main-side bridge
 * forwards it here. `balance` means the VEX balance covers no more; a
 * `model_limit` means the request asked above the model's ceiling.
 *
 * `vex_inference_balance_low`: the balance crossed below the user's alert
 * percent (the main-process balance watch).
 *
 * `vex_inference_foreign_withdrawal`: a cooling withdrawal on the account
 * whose id this app did not create (one per withdrawal id).
 *
 * `session_model_fallback`: the session's own model (F06) was picked under
 * the other inference backend, so the turn ran on the default model.
 *
 * Bounded codes and integers only. Not model-visible: it describes the
 * transport, not the conversation.
 */

import { z } from "zod";

export const INFERENCE_NOTICE_EVENT_TYPE = "engine.inference.notice" as const;

/** A token count no model comes near; mirrors the engine parser's bound. */
const tokenCountSchema = z.number().int().min(1).max(10_000_000);

const maxTokensClampedNoticeSchema = z
  .object({
    type: z.literal(INFERENCE_NOTICE_EVENT_TYPE),
    kind: z.literal("max_tokens_clamped"),
    sessionId: z.string().min(1).max(128),
    missionRunId: z.string().min(1).max(128).nullable(),
    provider: z.enum(["openrouter", "vexcloud"]),
    model: z.string().min(1).max(200),
    requested: tokenCountSchema,
    effective: tokenCountSchema,
    reason: z.enum(["balance", "model_limit"]),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

const weiSchema = z.string().regex(/^[0-9]{1,78}$/);

/**
 * The Vex Inference balance crossed below the user's alert percent of its
 * reference (the high-water mark since the last credited deposit). One per
 * crossing. Raw wei strings (VEX, 18 decimals) and the percent only.
 */
const vexInferenceBalanceLowNoticeSchema = z
  .object({
    type: z.literal(INFERENCE_NOTICE_EVENT_TYPE),
    kind: z.literal("vex_inference_balance_low"),
    sessionId: z.string().min(1).max(128),
    missionRunId: z.string().min(1).max(128).nullable(),
    provider: z.literal("vexcloud"),
    alertPercent: z.number().int().min(1).max(90),
    balanceWei: weiSchema,
    thresholdWei: weiSchema,
    referenceWei: weiSchema,
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** A cooling withdrawal this app did not start. Raw wei, the address and the release time only. */
const vexInferenceForeignWithdrawalNoticeSchema = z
  .object({
    type: z.literal(INFERENCE_NOTICE_EVENT_TYPE),
    kind: z.literal("vex_inference_foreign_withdrawal"),
    sessionId: z.string().min(1).max(128),
    missionRunId: z.string().min(1).max(128).nullable(),
    provider: z.literal("vexcloud"),
    withdrawalId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    amountWei: weiSchema,
    destination: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    releaseAt: z.string().datetime({ offset: true }),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

/** A catalogue model id, the shape `chat.submit` accepts for a pick. */
const noticeModelIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);

/**
 * F06: the session's own model was picked under the other inference backend,
 * so the turn ran on the default model. Backend names and model ids only.
 */
const sessionModelFallbackNoticeSchema = z
  .object({
    type: z.literal(INFERENCE_NOTICE_EVENT_TYPE),
    kind: z.literal("session_model_fallback"),
    sessionId: z.string().min(1).max(128),
    missionRunId: z.null(),
    provider: z.enum(["openrouter", "vexcloud"]),
    model: noticeModelIdSchema,
    pickedProvider: z.enum(["openrouter", "vexcloud"]),
    pickedModel: noticeModelIdSchema,
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const inferenceNoticeEventSchema = z.discriminatedUnion("kind", [
  maxTokensClampedNoticeSchema,
  vexInferenceBalanceLowNoticeSchema,
  vexInferenceForeignWithdrawalNoticeSchema,
  sessionModelFallbackNoticeSchema,
]);

export type InferenceNoticeEvent = z.infer<typeof inferenceNoticeEventSchema>;
