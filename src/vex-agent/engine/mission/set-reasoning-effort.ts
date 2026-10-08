/**
 * `mission.setReasoningEffort` - the HOST writer for the mission contract's
 * reasoning effort (Kairos E-1), used by the contract card in the app.
 *
 * Unlike the launch ceilings this field is also model-writable
 * (`MissionDraftUpdate`): it is a runtime setting, not a fee, limit or
 * destination. Either way the same two rules hold, enforced below exactly as
 * `set-launch-ceilings.ts` enforces them:
 *
 * 1. **Writing it INVALIDATES acceptance.** The effort is contract-hash
 *    material from v8, so the mission goes back through Accept before it can
 *    start and the user re-reads what they are authorizing.
 * 2. **Only an editable mission may be edited.** A started run reads its
 *    effort from its own frozen contract snapshot; a late write would change
 *    what the card shows without changing what the run uses. Refuse instead.
 *
 * Identity, state and write run in ONE row-locked transaction, serializing
 * against the model's `MissionDraftUpdate` merge (`setup.ts`).
 *
 * NEVER starts a run.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import type { MissionReasoningEffort } from "../types.js";
import { isMissionReasoningEffort } from "./reasoning-effort.js";

export interface SetMissionReasoningEffortInput {
  readonly sessionId: string;
  readonly missionId: string;
  /** The effort, or `null` to clear it (the run then uses medium). */
  readonly reasoningEffort: MissionReasoningEffort | null;
}

export type SetMissionReasoningEffortOutcome =
  | {
    readonly outcome: "updated";
    readonly reasoningEffort: MissionReasoningEffort | null;
    /** True when a prior acceptance was invalidated by this write. */
    readonly acceptanceCleared: boolean;
  }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "blocked_status"; readonly status: string }
  | { readonly outcome: "invalid"; readonly reason: string };

const EDITABLE_STATUSES = new Set<string>(["draft", "ready"]);

export async function setMissionReasoningEffort(
  input: SetMissionReasoningEffortInput,
): Promise<SetMissionReasoningEffortOutcome> {
  if (input.reasoningEffort !== null && !isMissionReasoningEffort(input.reasoningEffort)) {
    return { outcome: "invalid", reason: "Unknown reasoning effort." };
  }

  return withTransaction(async (client) => {
    // A cross-session id collapses to `not_found` (no existence leak), the
    // same shape `setMissionLaunchCeilings` uses.
    const mission = await missionsRepo.getMissionForUpdate(client, input.missionId);
    if (!mission || mission.rootSessionId !== input.sessionId) {
      return { outcome: "not_found" };
    }
    if (!EDITABLE_STATUSES.has(mission.status)) {
      return { outcome: "blocked_status", status: mission.status };
    }

    await missionsRepo.mergeConstraintReasoningEffort(client, input.missionId, input.reasoningEffort);

    const acceptanceCleared = mission.acceptedContractHash !== null;
    if (acceptanceCleared) {
      await missionsRepo.clearAcceptance(client, input.missionId);
    }

    return { outcome: "updated", reasoningEffort: input.reasoningEffort, acceptanceCleared };
  });
}
