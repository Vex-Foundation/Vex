/**
 * Renderer-facing mission-update event.
 *
 * Mirrors the engine's `MissionUpdateEvent`
 * (`src/vex-agent/engine/runtime/mission-bus.ts`), which producers emit only
 * AFTER the transaction that created the fetchable row has committed. The
 * renderer treats it purely as an invalidation signal: it never reconstructs a
 * draft, a diff or an approval row from the payload — it refetches through the
 * existing IPC reads, with the DB as source of truth.
 *
 * The payload is bounded to ids, an enum and a timestamp. No draft content, no
 * provider text, no error strings ride this event.
 *
 * This schema and its subscriber are registered in the SAME pass as the engine
 * error channel, deliberately: `channels.ts`, the preload bridge and the
 * renderer test stubs are the three places that drift when a subscriber is
 * added, and touching them twice for two channels is how that drift happens.
 * The EMIT sites live on the engine side and are wired separately.
 */

import { z } from "zod";
import { missionIdField, sessionIdField } from "./mission/_common.js";

/** Literal kept in sync with the engine `MISSION_UPDATE_EVENT_TYPE`. */
export const MISSION_UPDATE_EVENT_TYPE = "engine.mission.update" as const;

/**
 * Why the mission surface changed. The finer grain exists so a consumer that
 * only cares about approvals does not refetch a draft on every model patch.
 */
export const missionUpdateKindSchema = z.enum([
  "draft_updated",
  "readiness_changed",
  "accepted",
  "approval_enqueued",
  /**
   * A mission SETUP turn finished without writing anything to an incomplete
   * draft. The ONLY kind that reports an ABSENCE of change: every other kind
   * means "refetch, the row moved", this one means "the row did NOT move and
   * will not move on its own". `useMissionUpdateLiveSync` therefore does not
   * invalidate on it; `useMissionSetupProgress` records it so the mission
   * surface can escalate from "still drafting" to "drafting stalled".
   */
  "setup_no_progress",
]);
export type MissionUpdateKind = z.infer<typeof missionUpdateKindSchema>;

export const missionUpdateEventSchema = z
  .object({
    type: z.literal(MISSION_UPDATE_EVENT_TYPE),
    sessionId: sessionIdField,
    /**
     * `null` when the producer has no mission in scope (chat-session approval).
     *
     * NOT a UUID — see `mission/_common.ts`. A RENEWED mission carries
     * `mission-<epochMillis>-<hex>`, so a `.uuid()` here validated-then-DROPPED
     * every update for exactly the missions a user renewed, silently returning
     * them to the 60 s polls.
     */
    missionId: missionIdField.nullable(),
    kind: missionUpdateKindSchema,
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MissionUpdateEvent = z.infer<typeof missionUpdateEventSchema>;
