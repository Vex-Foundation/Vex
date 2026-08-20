/**
 * Renderer-facing stream-delta event (Stage 9-2).
 *
 * The engine (9-1) emits `StreamDeltaEvent` on its in-process `streamDeltaBus`
 * — one per provider chunk during a turn. The main-process `stream-bridge`
 * MAPS + SANITIZES each engine event into THIS shape and broadcasts it on
 * `EV.engine.streamDelta` as an EPHEMERAL preview.
 *
 * Sanitization contract (enforced by the bridge + this schema):
 *  - `tool_call` deltas carry NO raw argument fragments. Incremental JSON
 *    args cannot be safely redacted mid-stream (a secret split across deltas
 *    evades regex), so the renderer-facing payload simply has no field for
 *    them — the canonical, redacted args arrive later via the persisted
 *    `tool_call` message DTO.
 *  - `error` deltas carry the SANITIZED provider message (the bridge runs the
 *    raw string through `sanitizeEngineErrorDetail`, owner decree 2026-08-02),
 *    plus the numeric `code` and the bounded `errorType` enum label. The label
 *    still lets consumers classify without parsing prose.
 *  - every object is `.strict()` so any drift in the engine payload is
 *    dropped at the boundary rather than forwarded.
 *
 * The DB transcript stays the source of truth; these deltas are preview only.
 */

import { z } from "zod";

/** Literal kept in sync with the engine `STREAM_DELTA_EVENT_TYPE`. */
export const STREAM_DELTA_EVENT_TYPE = "engine.stream.delta" as const;

export const streamDeltaTypeSchema = z.enum([
  "text",
  "tool_call",
  "reasoning",
  "usage",
  "done",
  "error",
  "aborted",
]);
export type StreamDeltaType = z.infer<typeof streamDeltaTypeSchema>;

const streamUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export type StreamUsageDto = z.infer<typeof streamUsageSchema>;

/**
 * Discriminated delta payload. `tool_call` deliberately omits any argument
 * field; `error.message` is sanitized prose set by the bridge.
 */
export const streamDeltaPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      kind: z.literal("tool_call"),
      toolCallIndex: z.number().int().nonnegative(),
      toolCallId: z.string().nullable(),
      toolCallName: z.string().nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("reasoning"), text: z.string() }).strict(),
  z.object({ kind: z.literal("usage"), usage: streamUsageSchema }).strict(),
  z.object({ kind: z.literal("done") }).strict(),
  /**
   * Terminal signal for a turn that ended by ABORT (user stop, or a deadline).
   * No assistant row is ever persisted for such a stream, so the
   * `transcriptAppend` that normally retires the live preview never arrives.
   *
   * A `leaseActive:false` control event is NOT a substitute — it fires on
   * every normal chat completion too, so clearing on it erases a live preview
   * before the assistant row has been refetched.
   *
   * Correlated by the event's `streamId`, so a consumer clears exactly the
   * stream that ended and never a newer one that started in between. Bounded
   * to the discriminant alone: no reason string, no provider text.
   */
  z.object({ kind: z.literal("aborted") }).strict(),
  z
    .object({
      kind: z.literal("error"),
      message: z.string(),
      code: z.number().nullable(),
      /**
       * OpenRouter's canonical `ApiErrorType` from the chunk's
       * `error.metadata.errorType`. The engine bus carries it; before this it
       * was dropped AGAIN at the main bridge, so the preview could only ever
       * render the literal "Stream error" — the message field is a safe
       * generic by design, which left nothing to say WHY.
       *
       * OPEN enum, carried verbatim and bounded by shape/length. Consumers map
       * it through `classifyEngineFailure`, which has a total default; nothing
       * may switch on it directly. `.optional()` so an older/other producer
       * that omits it still validates.
       */
      errorType: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z][a-z0-9_]*$/)
        .nullable()
        .optional(),
    })
    .strict(),
]);
export type StreamDeltaPayload = z.infer<typeof streamDeltaPayloadSchema>;

export const streamDeltaEventSchema = z
  .object({
    type: z.literal(STREAM_DELTA_EVENT_TYPE),
    sessionId: z.string().uuid(),
    /** Per-turn correlation token minted by the engine (opaque). */
    streamId: z.string().min(1),
    /** Monotonic per-stream counter, starting at 0. */
    sequence: z.number().int().nonnegative(),
    /** Top-level discriminator; must equal `delta.kind` (refined below). */
    deltaType: streamDeltaTypeSchema,
    delta: streamDeltaPayloadSchema,
    createdAt: z.string().datetime({ offset: true }),
    correlationId: z.string().nullable(),
  })
  .strict()
  .refine((event) => event.deltaType === event.delta.kind, {
    message: "deltaType must equal delta.kind",
    path: ["deltaType"],
  });
export type StreamDeltaEvent = z.infer<typeof streamDeltaEventSchema>;
