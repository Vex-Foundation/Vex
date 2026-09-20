/**
 * Engine -> renderer signal for the deterministic Lighter account-setup modal.
 *
 * The event carries only routing metadata. It never includes a wallet address,
 * credential, amount, approval or model-authored text. The renderer accepts it
 * only for the currently active session, switches to the fixed environment and
 * lets the existing Lighter setup workflow perform its own live reads.
 */

import { z } from "zod";

export const lighterSetupHandoffEventSchema = z
  .object({
    type: z.literal("engine.lighter.setup"),
    sessionId: z.string().uuid(),
    environment: z.enum(["core", "rhc"]),
    kind: z.literal("requested"),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type LighterSetupHandoffEvent = z.infer<
  typeof lighterSetupHandoffEventSchema
>;
