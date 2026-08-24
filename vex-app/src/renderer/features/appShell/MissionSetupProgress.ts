/**
 * MISSION SETUP LIVENESS - is the contract still being drafted, or has drafting
 * stalled?
 *
 * MISSION PREPARING is not self-advancing. Only the agent can fill a mission
 * contract (`mission.updateDraft` is a deliberate stub), so when a setup turn
 * ends without writing anything, NOTHING will change until the user speaks
 * again. Before this hook that state was indistinguishable from progress: the
 * engine's `applyMissionPatch` emits `mission_update` only when something
 * changed, so "the model produced nothing" was completely silent and the header
 * spun on PREPARING forever.
 *
 * `core/runner/setup-turn.ts` now emits `setup_no_progress` for exactly that
 * case. This hook turns that event into the host-visible `stalled` flag.
 *
 * THRESHOLD, NOT A SPINNER. Modelled on VS Code's `DISCONNECT_PROMPT_TIME`
 * (`contrib/remote/browser/remote.ts`), where an indefinite external wait
 * escalates its UI after a measured delay rather than animating forever. A
 * no-progress turn is often just the agent asking a clarifying question, and
 * the user is usually already typing the answer - so the escalation waits
 * {@link MISSION_SETUP_STALL_PROMPT_MS} and is cancelled outright by any real
 * mission update. Only a wait that outlives the threshold is called stalled.
 */

import { useEffect, useState } from "react";

/**
 * How long a no-progress setup turn must go unanswered before the mission
 * surface escalates from "still drafting" to "drafting stalled".
 *
 * 45s: long enough for a user to read the agent's clarifying question and start
 * typing (so the ordinary Q-and-A rhythm never trips it), short enough that a
 * genuinely dead draft is named while the user is still looking at it.
 * Exported for tests.
 */
export const MISSION_SETUP_STALL_PROMPT_MS = 45_000;

export interface MissionSetupProgress {
  /**
   * The last setup turn wrote nothing and the threshold has elapsed with no
   * mission update since. Nothing will move until the user replies.
   */
  readonly stalled: boolean;
}

/**
 * Subscribe a mission session's setup liveness.
 *
 * Owner: this hook. It owns the subscription AND the escalation timer, and
 * clears both on unmount, on session change, and on every real mission update -
 * so a stall flag can never outlive the state that justified it.
 */
export function useMissionSetupProgress(
  sessionId: string | null,
): MissionSetupProgress {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (sessionId === null || sessionId.length === 0) return;
    // A fresh session starts un-stalled regardless of what the previous one did.
    setStalled(false);

    let timer: number | null = null;
    const clearTimer = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const off = window.vex.engine.onMissionUpdate((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.kind === "setup_no_progress") {
        // Arm the escalation. A second no-progress turn restarts the wait
        // rather than stacking a second timer.
        clearTimer();
        timer = window.setTimeout(
          () => setStalled(true),
          MISSION_SETUP_STALL_PROMPT_MS,
        );
        return;
      }
      // Any other kind reports a committed change: drafting is moving again.
      clearTimer();
      setStalled(false);
    });

    return () => {
      off();
      clearTimer();
    };
  }, [sessionId]);

  return { stalled };
}
