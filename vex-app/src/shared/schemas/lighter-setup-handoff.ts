/**
 * Engine -> renderer signal for the deterministic Lighter account-setup modal.
 *
 * The event carries only routing metadata. It never includes a wallet address,
 * credential, amount, approval or model-authored text. The renderer accepts it
 * only for the currently active session and opens the existing setup workflow
 * over that session without changing workspaces.
 */

import { z } from "zod";

export const lighterSetupHandoffEventSchema = z
  .object({
    type: z.literal("engine.lighter.setup"),
    sessionId: z.string().uuid(),
    intentId: z.string().uuid(),
    environment: z.enum(["core", "rhc"]),
    kind: z.literal("requested"),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type LighterSetupHandoffEvent = z.infer<
  typeof lighterSetupHandoffEventSchema
>;

export const lighterSetupPendingInputSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();

export const lighterSetupPendingSchema = z.object({
  interaction: z.object({
    intentId: z.string().uuid(),
    sessionId: z.string().uuid(),
    environment: z.enum(["core", "rhc"]),
    status: z.literal("pending"),
    createdAt: z.string().datetime({ offset: true }),
  }).strict().nullable(),
}).strict();

export const lighterSetupSettleInputSchema = z.object({
  sessionId: z.string().uuid(),
  intentId: z.string().uuid(),
  outcome: z.enum(["completed", "cancelled"]),
  /**
   * The deployment the modal actually finished, when it differs from the one
   * the agent opened it with. The modal's environment toggle is the user's to
   * move, so a setup that started as RHC can legitimately complete as Core;
   * main verifies THIS environment and records it, rather than checking the
   * agent's opening guess. Omitted keeps the recorded one.
   */
  environment: z.enum(["core", "rhc"]).optional(),
}).strict();

export const lighterSetupSettleResultSchema = z.object({
  settled: z.boolean(),
  resumedAgentTurn: z.boolean(),
}).strict();

export type LighterSetupPendingInput = z.infer<typeof lighterSetupPendingInputSchema>;
export type LighterSetupPending = z.infer<typeof lighterSetupPendingSchema>;
export type LighterSetupSettleInput = z.infer<typeof lighterSetupSettleInputSchema>;
export type LighterSetupSettleResult = z.infer<typeof lighterSetupSettleResultSchema>;
