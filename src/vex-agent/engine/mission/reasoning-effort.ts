/**
 * Mission reasoning effort (Kairos E-1, owner decision 2026-09-29).
 *
 * A mission's effort is part of its CONTRACT, not a per-turn composer pick:
 *
 *   - stored in `constraints_json.reasoningEffort`, written by
 *     `MissionDraftUpdate` or the host contract card (both clear acceptance);
 *   - hashed from contract hash v8, so an accepted effort cannot move without
 *     dirtying acceptance. Unset means {@link MISSION_DEFAULT_REASONING_EFFORT}
 *     (`high`) for a v9+ contract, and {@link LEGACY_MISSION_DEFAULT_REASONING_EFFORT}
 *     (`medium`) for a v8 or older one, the value that user accepted;
 *   - FROZEN for the run: the start writes the effective value into the run's
 *     contract snapshot (`frozenMission.draft.reasoningEffort`) and the run
 *     reads it from there, never from the live row;
 *   - applied by the engine to every inference call of the run, RAISED to what
 *     the model supports (nearest higher supported effort, never lower), so a
 *     model that lacks the chosen level can never make a mission think less.
 *
 * The composer's per-turn pick on a mission session stays stripped
 * (`vex-app/src/main/ipc/chat.ts`); this is the only effort a mission sends.
 */

import type { InferenceConfig } from "@vex-agent/inference/types.js";
import { raiseReasoningEffort } from "@vex-agent/inference/reasoning-effort.js";
import {
  LEGACY_MISSION_DEFAULT_REASONING_EFFORT,
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

/**
 * The unset default a contract accepted under hash `version` was bound to:
 * `medium` through v8 (what v8 hashed an unset effort as), `high` from v9. An
 * unknown or missing version (a draft not yet accepted) gets the current one.
 */
export function missionDefaultReasoningEffortFor(version: number | null | undefined): MissionReasoningEffort {
  return typeof version === "number" && version <= 8
    ? LEGACY_MISSION_DEFAULT_REASONING_EFFORT
    : MISSION_DEFAULT_REASONING_EFFORT;
}

/** The effort a contract value means: the value itself, or `fallback` when not set. */
export function effectiveMissionReasoningEffort(
  value: unknown,
  fallback: MissionReasoningEffort = MISSION_DEFAULT_REASONING_EFFORT,
): MissionReasoningEffort {
  return normalizeMissionReasoningEffort(value) ?? fallback;
}

/**
 * The effort frozen in a run's contract snapshot
 * (`frozenMission.draft.reasoningEffort`). The start writes the effective value
 * there, so an unset one only exists in a snapshot frozen before that (E-1's
 * first cut, or pre-E-1): those runs were accepted when the default was
 * `medium`, so they run at {@link LEGACY_MISSION_DEFAULT_REASONING_EFFORT}.
 */
export function frozenMissionReasoningEffort(snapshot: unknown): MissionReasoningEffort {
  const legacy = LEGACY_MISSION_DEFAULT_REASONING_EFFORT;
  if (snapshot === null || typeof snapshot !== "object") return legacy;
  const frozen = (snapshot as Record<string, unknown>).frozenMission;
  if (frozen === null || typeof frozen !== "object") return legacy;
  const draft = (frozen as Record<string, unknown>).draft;
  if (draft === null || typeof draft !== "object") return legacy;
  return effectiveMissionReasoningEffort((draft as Record<string, unknown>).reasoningEffort, legacy);
}

/**
 * A copy of `config` carrying the mission's effort, raised to a level the
 * model supports (never lowered).
 * Any effort already on the config is replaced: a mission never runs at a
 * composer pick. Whether it reaches the wire is still decided by
 * `buildOpenRouterParams` (only when the model advertises the parameter).
 */
export function withMissionReasoningEffort(
  config: InferenceConfig,
  effort: MissionReasoningEffort,
): InferenceConfig {
  return { ...config, reasoningEffort: raiseReasoningEffort(effort, config.reasoningSupport) };
}
