/**
 * Wallet intent shapes — puzzle 5 phase 4 (DB-backed durable intents).
 *
 * Mirrors the `wallet_intents` CHECK enum through migration 093. Ambiguous
 * broadcast, proven non-inclusion and legacy review remain distinct from a
 * definitive failure so the renderer never implies that retry is safe.
 */

import { z } from "zod";

export const walletIntentNetworkSchema = z.enum(["eip155", "solana"]);
export type WalletIntentNetwork = z.infer<typeof walletIntentNetworkSchema>;

export const walletIntentStatusSchema = z.enum([
  "pending",
  "consuming",
  "broadcast_unconfirmed",
  "executed",
  "failed",
  "superseded_unproven",
  "review_required",
  "audit_failed",
  "cancelled",
  "expired",
]);
export type WalletIntentStatus = z.infer<typeof walletIntentStatusSchema>;

/**
 * Allow-listed structured preview from `wallet_intents.preview_json`. The
 * main-side mapper Zod-safeparses incoming JSONB and drops malformed shapes
 * to null — raw blob never reaches the renderer.
 */
export const walletIntentPreviewSchema = z
  .object({
    label: z.string().max(200),
    criticalArgs: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
  })
  .strict();
export type WalletIntentPreview = z.infer<typeof walletIntentPreviewSchema>;

/**
 * Renderer-facing intent DTO. `failure_reason` is intentionally NOT
 * surfaced (defense-in-depth — structural labels can still carry hashes
 * the renderer doesn't need; phase 7 audit UI can decide what to expose).
 */
export const preparedIntentDtoSchema = z
  .object({
    intentId: z.string().min(1),
    sessionId: z.string().uuid(),
    walletAddress: z.string().min(1),
    network: walletIntentNetworkSchema,
    chain: z.string().nullable(),
    to: z.string().min(1),
    amount: z.string().min(1),
    token: z.string().nullable(),
    status: walletIntentStatusSchema,
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    consumedAt: z.string().datetime({ offset: true }).nullable(),
    cancelledAt: z.string().datetime({ offset: true }).nullable(),
    txHash: z.string().nullable(),
    preview: walletIntentPreviewSchema.nullable(),
  })
  .strict();
export type PreparedIntentDto = z.infer<typeof preparedIntentDtoSchema>;

/**
 * `sessionId` is REQUIRED on get + cancel inputs (Codex puzzle-5 phase-4
 * review point 3 — cross-session lookup MUST miss). The DB CAS includes
 * `WHERE session_id = $2`; engine confirm validates `intent.sessionId ===
 * context.sessionId`.
 */
export const walletsGetPreparedIntentInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    intentId: z.string().min(1),
  })
  .strict();
export type WalletsGetPreparedIntentInput = z.infer<
  typeof walletsGetPreparedIntentInputSchema
>;

export const walletsCancelPreparedIntentInputSchema =
  walletsGetPreparedIntentInputSchema;
export type WalletsCancelPreparedIntentInput = z.infer<
  typeof walletsCancelPreparedIntentInputSchema
>;

/**
 * `'cancelled'` joins the enum in phase 4 — cancel CAS won. Cross-session
 * cancel also maps to `'already_terminal'` (don't expose existence).
 * `'queued'` reserved for future async cancel paths; `'unavailable'` is
 * the legacy fail-closed status retained for back-compat.
 */
export const walletsActionResultSchema = z
  .object({
    intentId: z.string().min(1),
    status: z.enum([
      "queued",
      "cancelled",
      "already_terminal",
      "unavailable",
    ]),
    message: z.string(),
  })
  .strict();
export type WalletsActionResult = z.infer<typeof walletsActionResultSchema>;
