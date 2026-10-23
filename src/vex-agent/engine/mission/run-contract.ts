/**
 * Mission run contract snapshots.
 *
 * The mission row can move back to draft/edit after a run fails. Each run
 * therefore stores the exact prompt contract it executed under so recovery can
 * start a new run from the same accepted contract without mutating audit rows.
 */

import { z } from "zod";
import type { Mission } from "@vex-agent/db/repos/missions.js";
import { draftToPromptContext, freezeDraft } from "./mapper.js";
import {
  effectiveMissionReasoningEffort,
  missionDefaultReasoningEffortFor,
} from "./reasoning-effort.js";
import type { MissionModelChoice } from "../types.js";

const ContractSnapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string(),
  missionPromptContext: z.string(),
  frozenMission: z.unknown().optional(),
});

export type MissionRunContractSnapshot = z.infer<typeof ContractSnapshotSchema>;

export function buildMissionRunContractSnapshot(
  mission: Mission,
  /**
   * The default model (`AGENT_MODEL` on the active backend) at the moment of
   * start (F06), frozen when the contract names none. `null` freezes no model,
   * and the run then runs on whatever the default is at each slice.
   */
  defaultModel: MissionModelChoice | null = null,
): MissionRunContractSnapshot {
  const frozen = freezeDraft(mission);
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    missionPromptContext: draftToPromptContext(mission),
    // Kairos E-1: freeze the EFFECTIVE effort, resolved against the default the
    // acceptance was bound to (by its hash version), so the run never depends
    // on whatever the unset default is when it later resumes.
    frozenMission: {
      ...frozen,
      draft: {
        ...frozen.draft,
        reasoningEffort: effectiveMissionReasoningEffort(
          frozen.draft.reasoningEffort,
          missionDefaultReasoningEffortFor(mission.contractHashVersion),
        ),
        // F06: freeze the EFFECTIVE model, the contract's own or the default
        // at start, so a later change of the default never moves the run.
        model: frozen.draft.model ?? defaultModel,
      },
    },
  };
}

export function resolveMissionPromptContext(input: {
  snapshot: Record<string, unknown> | null;
  fallbackMission: Mission;
}): string {
  const parsed = ContractSnapshotSchema.safeParse(input.snapshot);
  if (parsed.success) return parsed.data.missionPromptContext;
  return draftToPromptContext(input.fallbackMission);
}

export function requireMissionPromptContextFromSnapshot(
  snapshot: Record<string, unknown> | null,
): string {
  const parsed = ContractSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    throw new Error(
      "Failed mission run has no recoverable contract snapshot. Use the Edit button and start a fresh run.",
    );
  }
  return parsed.data.missionPromptContext;
}
