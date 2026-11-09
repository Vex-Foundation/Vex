/**
 * HER MOOD IN THE SHELL, FROM THE PERSON'S LAST MONEY DECISION
 * (docs/design/H3-DESKTOP.md section 1.6; `kimm-mood.ts`, `useKimmMood.ts`).
 *
 * The chat's approvals stack publishes a display-only signal when a decision
 * lands (`features/appShell/approvals/decision-signal.ts`). This reads it for
 * the chat on screen and turns it into her mood clock's options:
 *
 *   approved, its call not yet settled   `approved`: offer while Thinking or Working
 *   approved, the call succeeded         `outcome: "filled"`: signed at Done, held 2.8 s
 *   rejected                             `outcome: "refused"`: refused at Done or Error, held 3.4 s
 *   failed                               `outcome: "failed"`: refused at Done or Error, held 3.4 s
 *   approved, the result unproven        nothing: she claims no fill she cannot show
 *
 * A decision belongs to the turn it was made in: once Vex is idle again (Ready,
 * Sleeping, Waking), every decision made before that moment is spent, so an old
 * one never colours a later, unrelated Done. Studio and a shell with no chat on
 * screen read no decision. Display only: nothing here reaches the decision path.
 */

import { useEffect, useState } from "react";
import type { KimmMood } from "../../components/vex/kimm/kimm-assets.js";
import { useUiStore } from "../../stores/uiStore.js";
import {
  useApprovalDecisionSignal,
  type ApprovalDecisionSignal,
} from "../appShell/approvals/decision-signal.js";
import type { KimmMoodOptions } from "./kimm-mood.js";
import { useKimmMood } from "./useKimmMood.js";
import type { VexState } from "./vex-state.js";

const IDLE: ReadonlySet<VexState> = new Set<VexState>(["ready", "sleeping", "waking"]);

const RUNNING_STATUSES: ReadonlySet<string> = new Set(["not_started", "dispatching"]);

/** Her mood clock's options for one decision signal. Pure. */
export function kimmOptionsOfDecision(signal: ApprovalDecisionSignal | null): KimmMoodOptions {
  if (signal === null) return {};
  switch (signal.kind) {
    case "approved": {
      const status = signal.executionStatus;
      if (status === null || RUNNING_STATUSES.has(status)) return { approved: true };
      if (status === "succeeded") return { outcome: "filled" };
      return {};
    }
    case "rejected":
      return { outcome: "refused" };
    case "failed":
      return { outcome: "failed" };
  }
}

/**
 * The last decision for the chat on screen, or null once it is spent (made
 * before Vex was last idle) or when no chat is on screen.
 */
export function useLiveDecision(state: VexState): ApprovalDecisionSignal | null {
  const runtimeMode = useUiStore((s) => s.runtimeMode);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const sessionId = runtimeMode === "studio" ? null : activeSessionId;
  const signal = useApprovalDecisionSignal(sessionId ?? "");
  const [idleAt, setIdleAt] = useState(0);
  const idle = IDLE.has(state);
  useEffect(() => {
    if (idle) setIdleAt(Date.now());
  }, [idle]);
  if (sessionId === null || signal === null) return null;
  return signal.at > idleAt ? signal : null;
}

/** Her mood in the shell: Vex's state, read with the person's live decision. */
export function useKimmShellMood(state: VexState): KimmMood {
  const decision = useLiveDecision(state);
  return useKimmMood(state, kimmOptionsOfDecision(decision));
}
