/**
 * Contract surface commands — `acceptContract`, `getDiff`,
 * `updateDraft`. Each command pair (input + result) maps 1:1 against
 * the engine outcome literal so the renderer's mutation hook can
 * `switch` on `outcome` to drive UI state.
 */

import { z } from "zod";
import { sessionIdField, missionIdField } from "./_common.js";

// ── acceptContract ──────────────────────────────────────────────

export const missionAcceptContractInputSchema = z
  .object({
    sessionId: sessionIdField,
    missionId: missionIdField,
    /** Hash the renderer computed + showed to the user (sha-256 hex). */
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
    /**
     * Optimistic-concurrency guard for the reviewed action plan (plan-mode
     * only). The renderer echoes the plan row's `updatedAt` from the same
     * `plan.get` read that rendered the plan for review — NOT plan content
     * (trust boundary: the engine accepts the locked row's own `planMd`).
     * Optional so plan-mode-OFF payloads (the default) and old builds still
     * validate; the engine requires it only when an enabled, non-empty,
     * unaccepted plan exists (else `plan_stale`).
     */
    planUpdatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type MissionAcceptContractInput = z.infer<
  typeof missionAcceptContractInputSchema
>;

export const missionAcceptContractResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("accepted"),
        missionId: z.string(),
        acceptedContractHash: z.string(),
        acceptedAt: z.string().datetime({ offset: true }),
        acceptedBy: z.string(),
        contractHashVersion: z.number().int().min(1),
        /**
         * ISO acceptance timestamp of the co-accepted action plan, present
         * only when plan-mode was on and a plan was accepted in the same TX.
         * Absent when no plan branch ran (plan-mode off / no enabled-unaccepted
         * plan) — optional/nullable so the default path is unchanged.
         */
        planAcceptedAt: z
          .string()
          .datetime({ offset: true })
          .nullable()
          .optional(),
      })
      .strict(),
    z.object({ outcome: z.literal("mission_not_found") }).strict(),
    /**
     * Plan-mode is on but the enabled plan body is empty — nothing was
     * authored to accept. The host must author a plan (`plan_write`) first.
     */
    z.object({ outcome: z.literal("plan_missing") }).strict(),
    /**
     * The reviewed plan changed (or `planUpdatedAt` was absent/mismatched)
     * between review and accept. The whole TX rolled back — neither contract
     * nor plan was accepted; the host must re-review the current plan.
     */
    z.object({ outcome: z.literal("plan_stale") }).strict(),
    z
      .object({
        outcome: z.literal("session_mismatch"),
        expectedSessionId: z.string(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("hash_mismatch"),
        providedHash: z.string(),
        currentHash: z.string(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("status_blocked"),
        currentStatus: z.string(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("run_active"),
        missionRunId: z.string(),
        runStatus: z.string(),
      })
      .strict(),
  ],
);
export type MissionAcceptContractResult = z.infer<
  typeof missionAcceptContractResultSchema
>;

// ── getDiff ─────────────────────────────────────────────────────

export const missionGetDiffInputSchema = z
  .object({
    sessionId: sessionIdField,
    missionId: missionIdField,
  })
  .strict();
export type MissionGetDiffInput = z.infer<typeof missionGetDiffInputSchema>;

export const missionGetDiffResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ready"),
      missionId: z.string(),
      sessionId: z.string(),
      currentHash: z.string(),
      contractHashVersion: z.number().int().min(1),
      acceptedHash: z.string().nullable(),
      acceptedAt: z.string().datetime({ offset: true }).nullable(),
      acceptedBy: z.string().nullable(),
      acceptedContractHashVersion: z.number().int().min(1).nullable(),
      isAccepted: z.boolean(),
      isDirty: z.boolean(),
    })
    .strict(),
  z.object({ outcome: z.literal("mission_not_found") }).strict(),
  z
    .object({
      outcome: z.literal("session_mismatch"),
      expectedSessionId: z.string(),
    })
    .strict(),
]);
export type MissionGetDiffResult = z.infer<typeof missionGetDiffResultSchema>;

// ── updateDraft (fail-closed in phase 6) ─────────────────────────

export const missionUpdateDraftInputSchema = z
  .object({
    sessionId: sessionIdField,
  })
  .strict();
export type MissionUpdateDraftInput = z.infer<
  typeof missionUpdateDraftInputSchema
>;

/**
 * Phase 6 leaves the host-side updateDraft path fail-closed because
 * no UI calls it yet (the structured setup form lands in phase 7+).
 * The model-driven `mission_draft_update` tool path is unaffected.
 *
 * The result schema keeps the same `outcome` discriminator shape as
 * the live commands so the renderer can switch identically once the
 * handler ships.
 */
export const missionUpdateDraftResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("unavailable") }).strict(),
]);
export type MissionUpdateDraftResult = z.infer<
  typeof missionUpdateDraftResultSchema
>;

// ── setAutoRetry (phase 4d-5) ────────────────────────────────────

export const missionSetAutoRetryInputSchema = z
  .object({
    sessionId: sessionIdField,
    missionId: missionIdField,
    enabled: z.boolean(),
  })
  .strict();
export type MissionSetAutoRetryInput = z.infer<
  typeof missionSetAutoRetryInputSchema
>;

/**
 * Host-only auto-retry opt-in (phase 4d-5). Authority is server-side:
 * the engine refuses non-full sessions (`blocked_permission`) and any
 * mission past the editable draft/ready window (`blocked_status`); a
 * cross-session / missing id collapses to `not_found` (no existence
 * leak). The renderer hides the toggle for non-full sessions, but that
 * is UX only — the engine is the gate. `autoRetryEnabled` is NOT part
 * of the contract hash, so toggling never dirties an accepted contract.
 */
export const missionSetAutoRetryResultSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({ outcome: z.literal("updated"), enabled: z.boolean() }).strict(),
    z.object({ outcome: z.literal("not_found") }).strict(),
    z.object({ outcome: z.literal("blocked_permission") }).strict(),
    z
      .object({ outcome: z.literal("blocked_status"), status: z.string() })
      .strict(),
  ],
);
export type MissionSetAutoRetryResult = z.infer<
  typeof missionSetAutoRetryResultSchema
>;
