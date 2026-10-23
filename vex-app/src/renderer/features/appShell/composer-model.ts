/**
 * Composer model resolution (F06): which model the composer shows, and which
 * pick its next send carries.
 *
 * The model is, in order: the PENDING pick from the composer's model menu
 * (`uiStore.modelPickBySession`, carried by the next send and cleared after
 * it succeeds), the session's own model (`sessions.getModel`, `source:
 * "session"`), or the configured default (`isDefault` in the models list).
 * The welcome stage has no session to pick for, so it shows the default.
 *
 * `canPick` is true only for a resolved AGENT session: a mission's model is
 * its accepted contract's, so a mission session shows the name and no menu,
 * and main strips a pick for one regardless.
 */

import { useCallback } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { ModelOptionDto, SessionModelPick } from "@shared/schemas/models.js";
import { useSessionModel } from "../../lib/api/sessions.js";
import { useAvailableModels } from "../../lib/api/models.js";
import { defaultModelOption, findModelOption } from "../../lib/model-options.js";
import { useUiStore } from "../../stores/uiStore.js";

export interface ComposerModel {
  /** The model the next turn runs on, as far as the renderer knows. */
  readonly modelId: string | null;
  /** Its catalogue row (window, prices, reasoning), when the list has it. */
  readonly option: ModelOptionDto | null;
  /** The configured default's row. */
  readonly defaultOption: ModelOptionDto | null;
  /** Every pickable row, default first; empty until the list resolves. */
  readonly options: readonly ModelOptionDto[];
  /** The menu's pick waiting for the next send, or `null`. */
  readonly pendingPick: SessionModelPick | null;
  /** A resolved agent session: the menu may open. */
  readonly canPick: boolean;
  readonly pick: (option: ModelOptionDto) => void;
}

export function useComposerModel(
  sessionId: string | null,
  activeSession: SessionListItem | null,
): ComposerModel {
  const modelsQuery = useAvailableModels();
  const sessionModelQuery = useSessionModel(sessionId);
  const pendingPick = useUiStore((s) =>
    sessionId === null ? null : (s.modelPickBySession[sessionId] ?? null),
  );
  const setSessionModelPick = useUiStore((s) => s.setSessionModelPick);
  const clearSessionModelPick = useUiStore((s) => s.clearSessionModelPick);

  const defaultOption = defaultModelOption(modelsQuery.data);
  const sessionModel =
    sessionId !== null && sessionModelQuery.data?.ok === true
      ? sessionModelQuery.data.data
      : null;
  const sessionModelId =
    sessionModel !== null && sessionModel.source === "session" ? sessionModel.modelId : null;
  const modelId = pendingPick?.modelId ?? sessionModelId ?? defaultOption?.modelId ?? null;
  const option = findModelOption(modelsQuery.data, modelId);
  const options = modelsQuery.data?.ok === true ? modelsQuery.data.data.models : [];
  const canPick = sessionId !== null && activeSession?.mode === "agent" && options.length > 0;

  const pick = useCallback(
    (next: ModelOptionDto): void => {
      if (sessionId === null) return;
      // Picking the model the session already runs drops the pending pick
      // instead of re-sending it.
      if (next.modelId === (sessionModelId ?? defaultOption?.modelId ?? null)) {
        clearSessionModelPick(sessionId);
        return;
      }
      const parsed = parseBackend(next.providerId);
      if (parsed === null) return;
      setSessionModelPick(sessionId, { provider: parsed, modelId: next.modelId });
    },
    [sessionId, sessionModelId, defaultOption, setSessionModelPick, clearSessionModelPick],
  );

  return { modelId, option, defaultOption, options, pendingPick, canPick, pick };
}

/** A row's backend as a pick names it; anything else is not pickable. */
function parseBackend(providerId: string): SessionModelPick["provider"] | null {
  return providerId === "openrouter" || providerId === "vexcloud" ? providerId : null;
}
