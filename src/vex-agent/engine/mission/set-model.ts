/**
 * `mission.setModel` - the HOST writer for the mission contract's model
 * (F06), used by the contract card in the app. The ONLY writer: the agent's
 * `MissionDraftUpdate` cannot set it (owner decision 2026-10-23), so a model
 * cannot pick a more expensive model for a run the user then accepts.
 *
 * The same two rules as `set-reasoning-effort.ts`:
 *
 * 1. **Writing it INVALIDATES acceptance.** The model is contract-hash
 *    material from v10, so the mission goes back through Accept before it can
 *    start and the user re-reads what they are authorizing.
 * 2. **Only an editable mission may be edited.** A started run reads its
 *    model from its own frozen contract snapshot; a late write would change
 *    what the card shows without changing what the run uses. Refuse instead.
 *
 * The host checks the model against the active backend's catalogue before it
 * calls this; this checks the shape. Identity, state and write run in ONE
 * row-locked transaction, serializing against the model's draft merge
 * (`setup.ts`).
 *
 * NEVER starts a run.
 */

import { withTransaction } from "@vex-agent/db/client.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import type { MissionModelChoice } from "../types.js";
import { normalizeMissionModel } from "./model-choice.js";

export interface SetMissionModelInput {
  readonly sessionId: string;
  readonly missionId: string;
  /** The model, or `null` to clear it (the run then uses the default at start). */
  readonly model: MissionModelChoice | null;
}

export type SetMissionModelOutcome =
  | {
    readonly outcome: "updated";
    readonly model: MissionModelChoice | null;
    /** True when a prior acceptance was invalidated by this write. */
    readonly acceptanceCleared: boolean;
  }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "blocked_status"; readonly status: string }
  | { readonly outcome: "invalid"; readonly reason: string };

const EDITABLE_STATUSES = new Set<string>(["draft", "ready"]);

export async function setMissionModel(input: SetMissionModelInput): Promise<SetMissionModelOutcome> {
  const model = input.model === null ? null : normalizeMissionModel(input.model);
  if (input.model !== null && model === null) {
    return { outcome: "invalid", reason: "Unknown model." };
  }

  return withTransaction(async (client) => {
    // A cross-session id collapses to `not_found` (no existence leak), the
    // same shape `setMissionReasoningEffort` uses.
    const mission = await missionsRepo.getMissionForUpdate(client, input.missionId);
    if (!mission || mission.rootSessionId !== input.sessionId) {
      return { outcome: "not_found" };
    }
    if (!EDITABLE_STATUSES.has(mission.status)) {
      return { outcome: "blocked_status", status: mission.status };
    }

    await missionsRepo.mergeConstraintModel(client, input.missionId, model);

    const acceptanceCleared = mission.acceptedContractHash !== null;
    if (acceptanceCleared) {
      await missionsRepo.clearAcceptance(client, input.missionId);
    }

    return { outcome: "updated", model, acceptanceCleared };
  });
}
