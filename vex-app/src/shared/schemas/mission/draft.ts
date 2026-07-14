/**
 * Mission draft DTO — the read-only contract surface returned by
 * `mission.getDraft` and embedded in `getDiff` / start outcomes.
 *
 * Puzzle 04 phase 6 additions:
 *   - `acceptance` — non-null block when the host accepted the
 *     current contract. The four columns from mig 023 collapse to a
 *     single object so partial states (CHECK-rejected) never reach
 *     the renderer.
 *   - `renewedFromMissionId` — lineage anchor for `/mission-renew`.
 */

import { z } from "zod";

export const MISSION_DRAFT_TITLE_MAX = 200;
export const MISSION_DRAFT_GOAL_MAX = 4000;
export const MISSION_DRAFT_LIST_MAX = 32;
export const MISSION_DRAFT_LIST_ITEM_MAX = 500;

export const missionStatusSchema = z.enum([
  "draft",
  "ready",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type MissionStatus = z.infer<typeof missionStatusSchema>;

export const missionConstraintsSchema = z
  .object({
    maxSpendUsd: z.number().nullable().optional(),
    maxLossUsd: z.number().nullable().optional(),
    maxIterations: z.number().int().min(0).nullable().optional(),
    deadlineAt: z.string().datetime({ offset: true }).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    /**
     * Phase 4d opt-in: when true AND the session is autonomous-full, the engine
     * auto-retries a paused_error run after a transient provider/runtime error
     * (<=5x, backoff), never after the run touched a side effect. Default off.
     */
    autoRetryEnabled: z.boolean().nullable().optional(),
  })
  .strict();
export type MissionConstraints = z.infer<typeof missionConstraintsSchema>;

export const missionListEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(MISSION_DRAFT_LIST_ITEM_MAX);

/** Renderer-safe mirror of the accepted mission-only HL risk envelope. */
export const hyperliquidMissionRiskTransportSchema = z.object({
  leverageCap: z.number().int().min(1),
  perOrderNotionalPct: z.number().min(1).max(50),
  totalNotionalPct: z.number().min(10).max(200),
  marketAllowlist: z.array(z.string().trim().min(1).max(64)).min(1).max(100).optional(),
}).strict();
export type HyperliquidMissionRiskTransport = z.infer<typeof hyperliquidMissionRiskTransportSchema>;

/**
 * Acceptance four-tuple as a single object. The mapper builds this
 * iff ALL four columns are non-null (mig 023 CHECK constraint), so
 * partial states (`hash` set but `at` null, etc.) never reach the
 * renderer. Phase 6 codex review #4.
 */
export const missionAcceptanceSchema = z
  .object({
    contractHash: z.string().min(1),
    acceptedAt: z.string().datetime({ offset: true }),
    acceptedBy: z.string().min(1),
    contractHashVersion: z.number().int().min(1),
  })
  .strict();
export type MissionAcceptance = z.infer<typeof missionAcceptanceSchema>;

export const missionDraftDtoSchema = z
  .object({
    missionId: z.string(),
    sessionId: z.string().uuid(),
    status: missionStatusSchema,
    title: z.string().max(MISSION_DRAFT_TITLE_MAX).nullable(),
    goal: z.string().max(MISSION_DRAFT_GOAL_MAX).nullable(),
    constraints: missionConstraintsSchema,
    /** Optional accepted v2 overlay. Omitted for legacy v1 mission DTOs. */
    hyperliquidRisk: hyperliquidMissionRiskTransportSchema.nullable().optional(),
    successCriteria: z.array(missionListEntrySchema).max(MISSION_DRAFT_LIST_MAX),
    stopConditions: z.array(missionListEntrySchema).max(MISSION_DRAFT_LIST_MAX),
    riskProfile: z.string().max(64).nullable(),
    allowedChains: z.array(z.string().max(64)).max(MISSION_DRAFT_LIST_MAX),
    allowedProtocols: z.array(z.string().max(64)).max(MISSION_DRAFT_LIST_MAX),
    allowedWallets: z.array(z.string().max(128)).max(MISSION_DRAFT_LIST_MAX),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    approvedAt: z.string().datetime({ offset: true }).nullable(),
    /** Null when unaccepted; non-null block when host-accepted. */
    acceptance: missionAcceptanceSchema.nullable(),
    /** `/mission-renew` lineage — id of the mission this one was renewed from. */
    renewedFromMissionId: z.string().nullable(),
  })
  .strict();
export type MissionDraftDto = z.infer<typeof missionDraftDtoSchema>;

export const missionGetDraftInputSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();
export type MissionGetDraftInput = z.infer<typeof missionGetDraftInputSchema>;

export const missionGetDraftResultSchema = missionDraftDtoSchema.nullable();
export type MissionGetDraftResult = z.infer<typeof missionGetDraftResultSchema>;
