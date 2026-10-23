/**
 * Mission model choice (F06): the pure reads of `constraints_json.model` and
 * of the model frozen in a run's contract snapshot. No IO, no provider; the
 * run's config loader lives in `model.ts`.
 */

import { MISSION_MODEL_PROVIDERS, type MissionModelChoice } from "../types.js";

/** The catalogue id shape a pick may carry (the same rule `chat.submit` applies). */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MODEL_ID_MAX = 200;

/** Read a stored or untrusted value: a well-formed choice, else `null` (not set). */
export function normalizeMissionModel(value: unknown): MissionModelChoice | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const provider = rec.provider;
  const modelId = rec.modelId;
  if (typeof provider !== "string" || !(MISSION_MODEL_PROVIDERS as readonly string[]).includes(provider)) {
    return null;
  }
  if (typeof modelId !== "string" || modelId.length === 0 || modelId.length > MODEL_ID_MAX) return null;
  if (!MODEL_ID_PATTERN.test(modelId)) return null;
  return { provider: provider as MissionModelChoice["provider"], modelId };
}

/**
 * The model frozen in a run's contract snapshot
 * (`frozenMission.draft.model`), or `null` for a snapshot frozen before v10
 * (or one whose model is unreadable): that run runs on the current default.
 */
export function frozenMissionModel(snapshot: unknown): MissionModelChoice | null {
  if (snapshot === null || typeof snapshot !== "object") return null;
  const frozen = (snapshot as Record<string, unknown>).frozenMission;
  if (frozen === null || typeof frozen !== "object") return null;
  const draft = (frozen as Record<string, unknown>).draft;
  if (draft === null || typeof draft !== "object") return null;
  return normalizeMissionModel((draft as Record<string, unknown>).model);
}
