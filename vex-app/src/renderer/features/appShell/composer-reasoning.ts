/**
 * Composer reasoning-effort resolution (S6/D3-D6, E2/E3 extract).
 *
 * Per-model reasoning capability + the effective per-turn pick, sourced from
 * the composer's model row (F06, `composer-model.ts`: the pending menu pick,
 * else the session's own model, else the default) in the models list
 * (`useAvailableModels`, always-warm single cache key) on BOTH stages: the
 * welcome stage reads the default's row, so it never waits for a session id
 * to exist, and a picked model's effort set is offered the moment it is
 * picked.
 *
 * `reasoningCapability` is the D4-set-normalized FINAL selectable set, or
 * `null` = "no selector" (mission sessions never mount one — their ingress
 * ignores per-turn options). `effectiveReasoningEffort` is non-null exactly
 * when a capability exists: the stored/welcome pick IF the model's final set
 * still contains it, else the shared TESTED preselect
 * (`selectDefaultReasoningEffort` — never re-derived by the caller).
 *
 * Pulled out of `SessionComposer.tsx` so the parent stays under the file-size
 * budget — no JSX, this hook only resolves state.
 */

import { useCallback, useMemo, useState } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import type { ModelOptionDto } from "@shared/schemas/models.js";
import {
  selectDefaultReasoningEffort,
  type ReasoningCapability,
  type ReasoningEffort,
} from "@shared/schemas/reasoning.js";
import { useAvailableModels } from "../../lib/api/models.js";
import { useUiStore } from "../../stores/uiStore.js";

export interface ComposerReasoningEffort {
  readonly reasoningCapability: ReasoningCapability | null;
  /**
   * Only the true WELCOME stage (no session selected at all) or a resolved
   * agent-mode session counts as agent-stage by default — a session that IS
   * selected but whose detail hasn't resolved yet is NOT agent-stage: the
   * model-capability query can resolve before the session detail does, and
   * showing the selector on that race would let a mission session's turn
   * ride a reasoning pick that main/ingress silently drops.
   */
  readonly reasoningStageIsAgent: boolean;
  readonly modelsResolved: boolean;
  readonly effectiveReasoningEffort: ReasoningEffort | null;
  /** Non-null capability in an agent-stage session → the submit ALWAYS carries the effective selection. */
  readonly carryReasoningEffort: boolean;
  readonly handleReasoningPick: (effort: ReasoningEffort) => void;
}

export function useComposerReasoningEffort(
  sessionId: string | null,
  activeSession: SessionListItem | null,
  /** The composer's model row (`useComposerModel`), `null` until known. */
  modelOption: ModelOptionDto | null,
): ComposerReasoningEffort {
  // Per-session reasoning-effort pick (S6/D5) — launch-ephemeral, RAW from
  // the store (undefined = the user never picked).
  const storedReasoningEffort = useUiStore((s) =>
    sessionId === null ? undefined : s.reasoningEffortBySession[sessionId],
  );
  const setSessionReasoningEffort = useUiStore(
    (s) => s.setSessionReasoningEffort,
  );
  // Welcome-stage-only live pick (E3): there is no real session id yet to key
  // `reasoningEffortBySession` on, and this value must survive a cancelled
  // create (the SAME composer instance stays mounted behind the modal —
  // `undefined` = never picked, falls back to the computed default exactly
  // like `storedReasoningEffort` does in-session).
  const [welcomeReasoningEffort, setWelcomeReasoningEffort] = useState<
    ReasoningEffort | undefined
  >(undefined);

  const modelsQuery = useAvailableModels();
  const modelsResolved = modelsQuery.data !== undefined;
  const reasoningCapability = modelOption?.reasoning ?? null;
  const reasoningStageIsAgent =
    sessionId === null || activeSession?.mode === "agent";
  const carryReasoningEffort =
    reasoningCapability !== null && reasoningStageIsAgent;
  const effectiveReasoningEffort = useMemo<ReasoningEffort | null>(() => {
    if (reasoningCapability === null) return null;
    const pick =
      sessionId === null ? welcomeReasoningEffort : storedReasoningEffort;
    if (
      pick !== undefined &&
      reasoningCapability.supportedEfforts.includes(pick)
    ) {
      return pick;
    }
    return selectDefaultReasoningEffort(reasoningCapability);
  }, [reasoningCapability, sessionId, storedReasoningEffort, welcomeReasoningEffort]);

  // A pick writes the launch-ephemeral per-session store when a real session
  // is active, or the local welcome-stage pick (E3) when it is not.
  const handleReasoningPick = useCallback(
    (effort: ReasoningEffort): void => {
      if (sessionId === null) {
        setWelcomeReasoningEffort(effort);
        return;
      }
      setSessionReasoningEffort(sessionId, effort);
    },
    [sessionId, setSessionReasoningEffort],
  );

  return {
    reasoningCapability,
    reasoningStageIsAgent,
    modelsResolved,
    effectiveReasoningEffort,
    carryReasoningEffort,
    handleReasoningPick,
  };
}
