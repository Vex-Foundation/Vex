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

const ContractSnapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string(),
  missionPromptContext: z.string(),
  frozenMission: z.unknown().optional(),
});

export type MissionRunContractSnapshot = z.infer<typeof ContractSnapshotSchema>;

export function buildMissionRunContractSnapshot(mission: Mission): MissionRunContractSnapshot {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    missionPromptContext: draftToPromptContext(mission),
    frozenMission: freezeDraft(mission),
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
