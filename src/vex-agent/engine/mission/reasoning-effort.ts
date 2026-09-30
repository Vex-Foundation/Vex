/**
 * Mission reasoning effort (Kairos E-1, owner decision 2026-09-29).
 *
 * A mission's effort is part of its CONTRACT, not a per-turn composer pick:
 *
 *   - stored in `constraints_json.reasoningEffort`, written by
 *     `MissionDraftUpdate` or the host contract card (both clear acceptance);
 *   - hashed from contract hash v8, so an accepted effort cannot move without
 *     dirtying acceptance; a contract accepted under v7 or earlier did not
 *     carry it and runs at {@link MISSION_DEFAULT_REASONING_EFFORT};
 *   - FROZEN for the run: the run reads it from its own contract snapshot
 *     (`frozenMission.draft.reasoningEffort`), never from the live row;
 *   - applied by the engine to every inference call of the run, clamped to
 *     what the model supports (nearest lower supported effort, never higher).
 *
 * The composer's per-turn pick on a mission session stays stripped
 * (`vex-app/src/main/ipc/chat.ts`); this is the only effort a mission sends.
 */

import type { InferenceConfig } from "@vex-agent/inference/types.js";
import { clampReasoningEffort } from "@vex-agent/inference/reasoning-effort.js";
import {
  MISSION_DEFAULT_REASONING_EFFORT,
  MISSION_REASONING_EFFORTS,
  type MissionReasoningEffort,
} from "../types.js";

export function isMissionReasoningEffort(value: unknown): value is MissionReasoningEffort {
  return typeof value === "string" && (MISSION_REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Read a stored or untrusted value: a known effort, else `null` (not set). */
export function normalizeMissionReasoningEffort(value: unknown): MissionReasoningEffort | null {
  return isMissionReasoningEffort(value) ? value : null;
}

/** The effort a contract value means: the value itself, or the default when not set. */
export function effectiveMissionReasoningEffort(value: unknown): MissionReasoningEffort {
  return normalizeMissionReasoningEffort(value) ?? MISSION_DEFAULT_REASONING_EFFORT;
}

/**
 * The effort frozen in a run's contract snapshot
 * (`frozenMission.draft.reasoningEffort`). A snapshot captured before E-1, or
 * a malformed one, runs at the default.
 */
export function frozenMissionReasoningEffort(snapshot: unknown): MissionReasoningEffort {
  if (snapshot === null || typeof snapshot !== "object") return MISSION_DEFAULT_REASONING_EFFORT;
  const frozen = (snapshot as Record<string, unknown>).frozenMission;
  if (frozen === null || typeof frozen !== "object") return MISSION_DEFAULT_REASONING_EFFORT;
  const draft = (frozen as Record<string, unknown>).draft;
  if (draft === null || typeof draft !== "object") return MISSION_DEFAULT_REASONING_EFFORT;
  return effectiveMissionReasoningEffort((draft as Record<string, unknown>).reasoningEffort);
}

/**
 * A copy of `config` carrying the mission's effort, clamped to the model.
 * Any effort already on the config is replaced: a mission never runs at a
 * composer pick. Whether it reaches the wire is still decided by
 * `buildOpenRouterParams` (only when the model advertises the parameter).
 */
export function withMissionReasoningEffort(
  config: InferenceConfig,
  effort: MissionReasoningEffort,
): InferenceConfig {
  return { ...config, reasoningEffort: clampReasoningEffort(effort, config.reasoningSupport) };
}
