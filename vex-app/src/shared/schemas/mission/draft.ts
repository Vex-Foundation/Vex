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

/**
 * Upper bound on the C6b launch-count ceiling.
 *
 * Not a policy limit — the real gate is the number the user authors — but a
 * bound on what the field may hold at all, so a typo like a pasted wei amount
 * cannot become a cap that means "unbounded in practice". 1000 tokens is far
 * beyond any real mission and still comfortably an integer.
 */
export const MISSION_MAX_LAUNCH_COUNT = 1000;

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
    /**
     * C6 — the enforceable ceiling on an autonomous token launch, as a RAW
     * integer amount string paired with its decimals. Kept as a string because
     * a wei ceiling exceeds `Number.MAX_SAFE_INTEGER`, and the two keys are
     * meaningless apart — render them only when BOTH are present.
     *
     * READ-ONLY on this DTO. The host authors both ceilings through
     * `mission.setLaunchCeilings`, which is the only write path; the renderer
     * never converts units and never enforces anything.
     */
    maxLaunchValueRaw: z.string().max(80).nullable().optional(),
    maxLaunchValueDecimals: z.number().int().min(0).max(36).nullable().optional(),
    /**
     * C6b — how many tokens the mission may create. Independent of the value
     * pair; an autonomous launch requires BOTH, and absent means zero
     * authority (see `engine/mission/launch-ceiling.ts`).
     */
    maxLaunchCount: z.number().int().min(0).max(MISSION_MAX_LAUNCH_COUNT).nullable().optional(),
  })
  .strict();
export type MissionConstraints = z.infer<typeof missionConstraintsSchema>;

export const missionListEntrySchema = z
  .string()
  .trim()
  .min(1)
  .max(MISSION_DRAFT_LIST_ITEM_MAX);

/**
 * Renderer-safe mirror of the accepted mission-only Hyperliquid risk
 * envelope. HISTORICAL ONLY (Hyperliquid removed, Agent Scan Phase 3): a
 * mission accepted while `CONTRACT_HASH_VERSION` was 2 may still carry this
 * in its `constraints_json.hyperliquidRisk` (see
 * `engine/mission/contract-hash-legacy-v2.ts` — a frozen, standalone copy of
 * the same shape used for hash reproduction on the root side). New missions
 * can never populate it again; keep this schema for reading OLD rows, never
 * as a live write path.
 */
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
    /**
     * HISTORICAL ONLY: present only for a mission accepted under the frozen
     * v2 contract shape while Hyperliquid mutations were live. Omitted for
     * v1/v3 mission DTOs (v3 is current post-removal).
     */
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
