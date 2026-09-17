import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });

export const shareTokenFailureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("http"), status: z.number(), code: z.string().nullable() }).strict(),
  z
    .object({
      kind: z.literal("transport"),
      reason: z.enum(["timeout", "network", "redirect", "unknown"]),
    })
    .strict(),
  z.object({ kind: z.literal("malformed_response") }).strict(),
  z.object({ kind: z.literal("conflict") }).strict(),
  z.object({ kind: z.literal("auth_lost") }).strict(),
  z
    .object({
      kind: z.literal("stopped"),
      reason: z.enum(["consent_revoked", "quarantined"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rate_limited"),
      retryAfterSeconds: z.number().nullable(),
    })
    .strict(),
]);

export type ShareTokenFailure = z.infer<typeof shareTokenFailureSchema>;

export const shareTokenAttemptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("failed"),
      at: isoDateTime,
      failure: shareTokenFailureSchema,
      detail: z.string(),
      correlationId: z.string(),
      durationMs: z.number(),
    })
    .strict(),
]);

export type ShareTokenAttempt = z.infer<typeof shareTokenAttemptSchema>;

export const superboardRotationStateSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("unavailable"), reason: z.enum(["server", "unknown"]) })
    .strict(),
  z.object({ kind: z.literal("available") }).strict(),
  z.object({ kind: z.literal("pending"), attempt: shareTokenAttemptSchema }).strict(),
]);

export type SuperboardRotationState = z.infer<typeof superboardRotationStateSchema>;

export const superboardKeyStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_ready") }).strict(),
  z.object({ kind: z.literal("missing") }).strict(),
  z
    .object({
      kind: z.literal("pending"),
      shareToken: z.string(),
      attempt: shareTokenAttemptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("registered"),
      shareToken: z.string(),
      rotation: superboardRotationStateSchema,
      rotatedAt: isoDateTime.nullable(),
    })
    .strict(),
]);

export type SuperboardKeyStatus = z.infer<typeof superboardKeyStatusSchema>;
