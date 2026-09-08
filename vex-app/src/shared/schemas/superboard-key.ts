import { z } from "zod";

export const superboardKeyStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not_ready") }).strict(),
  z.object({ kind: z.literal("missing") }).strict(),
  z
    .object({
      kind: z.literal("pending"),
      shareToken: z.string(),
      lastError: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("registered"),
      shareToken: z.string(),
    })
    .strict(),
]);

export type SuperboardKeyStatus = z.infer<typeof superboardKeyStatusSchema>;
