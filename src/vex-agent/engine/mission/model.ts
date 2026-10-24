/**
 * Mission model (F06, owner decision 2026-10-23).
 *
 * A mission's model is part of its CONTRACT, like its reasoning effort, and
 * unlike a chat session's pick:
 *
 *   - stored in `constraints_json.model` as `{ provider, modelId }`, written
 *     ONLY by the host contract card (`mission.setModel`), never by the
 *     agent's `MissionDraftUpdate` (`patch-parser.ts` does not accept it), so
 *     the agent cannot move a run onto a more expensive model;
 *   - hashed from contract hash v10 as the stored value or `null`, so an
 *     accepted model cannot change without dirtying acceptance;
 *   - FROZEN for the run: the start writes the EFFECTIVE model into the run's
 *     contract snapshot (`frozenMission.draft.model`): the contract's own, or
 *     the default (`AGENT_MODEL` on the active backend) at that moment;
 *   - a run NEVER runs on another model: a frozen model the active backend no
 *     longer lists, or one frozen under the other backend, ends the slice in
 *     `paused_error` naming the model (`SessionModelUnavailableError`).
 *
 * A snapshot frozen before v10 carries no model, and its run keeps running on
 * the current default, exactly as before this feature.
 */

import type { InferenceConfig } from "@vex-agent/inference/types.js";
import {
  clampToSummarizerWindow,
  SessionModelUnavailableError,
  type SessionModelProvider,
} from "../core/runner/session-model.js";
import { frozenMissionModel } from "./model-choice.js";

export { frozenMissionModel, normalizeMissionModel } from "./model-choice.js";

/**
 * The config a mission slice runs with. `defaultConfig` is what the runner
 * already loaded (the default model, also its provider gate); the frozen
 * model replaces it when it names another model. Throws
 * {@link SessionModelUnavailableError} rather than ever running a different
 * model than the accepted one; the run's protected try parks it in
 * `paused_error` with that reason.
 */
export async function loadMissionInferenceConfig(
  provider: SessionModelProvider,
  defaultConfig: InferenceConfig,
  snapshot: unknown,
  sessionId: string,
): Promise<InferenceConfig> {
  const frozen = frozenMissionModel(snapshot);
  if (frozen === null) return defaultConfig;
  if (frozen.provider !== provider.id) {
    throw new SessionModelUnavailableError(frozen.modelId, provider.id, "backend_changed");
  }
  if (frozen.modelId === defaultConfig.model) return defaultConfig;
  const config = await provider.loadConfig({ model: frozen.modelId });
  if (!config) throw new SessionModelUnavailableError(frozen.modelId, provider.id, "delisted");
  return clampToSummarizerWindow(provider, sessionId, config);
}
