/**
 * `mission.setAutoRetry` — the host-only opt-in toggle that writes
 * `constraints_json.autoRetryEnabled` for a draft/ready mission.
 *
 * The autonomous auto-retry path (phase 4d-4) reads this flag from the
 * FROZEN run snapshot at run start; this is the only writer that turns
 * it on/off before the snapshot freezes.
 *
 * Authority lives HERE, not in the renderer: auto-retry is honoured
 * only for autonomous-full sessions (the claim path requires
 * `permission === "full"`), so anything else is refused server-side.
 * The identity → authorization → state decision and the write run
 * inside ONE row-locked transaction so they're atomic and serialize
 * against the model `MissionDraftUpdate` constraints merge
 * (engine/mission/setup.ts) — neither writer can lose the flag.
 *
 * NEVER starts a run.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import { getSession } from "@vex-agent/db/repos/sessions.js";

export interface SetMissionAutoRetryInput {
  readonly sessionId: string;
  readonly missionId: string;
  readonly enabled: boolean;
}

export type SetMissionAutoRetryOutcome =
  | { readonly outcome: "updated"; readonly enabled: boolean }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "blocked_permission" }
  | { readonly outcome: "blocked_status"; readonly status: string };

export async function setMissionAutoRetry(
  input: SetMissionAutoRetryInput,
): Promise<SetMissionAutoRetryOutcome> {
  return withTransaction(async (client) => {
    // Identity — lock the mission row + verify it belongs to the session.
    // A cross-session id collapses to `not_found` (no existence leak).
    const mission = await missionsRepo.getMissionForUpdate(
      client,
      input.missionId,
    );
    if (!mission || mission.rootSessionId !== input.sessionId) {
      return { outcome: "not_found" };
    }

    // Authorization — only autonomous-full sessions can arm auto-retry.
    // `permission` is immutable per session (mig 001 CHECK), so an
    // unlocked read is safe.
    const session = await getSession(input.sessionId);
    if (!session || session.permission !== "full") {
      return { outcome: "blocked_permission" };
    }

    // State — the flag only takes effect at run start (snapshot freeze),
    // so refuse once the mission has left the editable draft/ready window.
    if (mission.status !== "draft" && mission.status !== "ready") {
      return { outcome: "blocked_status", status: mission.status };
    }

    await missionsRepo.mergeConstraintAutoRetry(
      client,
      input.missionId,
      input.enabled,
    );
    return { outcome: "updated", enabled: input.enabled };
  });
}
