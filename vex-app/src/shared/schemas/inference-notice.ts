/**
 * `EV.engine.inferenceNotice` - a request that succeeded, but not quite as
 * asked, which the user must be told about (never silently).
 *
 * One kind today: Vex Cloud lowered `max_tokens` (owner decision D16). The
 * gateway disclosed it in the `x-vex-max-tokens` response header; the engine
 * read it (`inference/openrouter/round-fetch.ts`) and the main-side bridge
 * forwards it here. `balance` means the VEX balance covers no more; a
 * `model_limit` means the request asked above the model's ceiling.
 *
 * Bounded codes and integers only. Not model-visible: it describes the
 * transport, not the conversation.
 */

import { z } from "zod";

export const INFERENCE_NOTICE_EVENT_TYPE = "engine.inference.notice" as const;

/** A token count no model comes near; mirrors the engine parser's bound. */
const tokenCountSchema = z.number().int().min(1).max(10_000_000);

export const inferenceNoticeEventSchema = z
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

export type InferenceNoticeEvent = z.infer<typeof inferenceNoticeEventSchema>;
