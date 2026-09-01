/**
 * Pure helpers for `SessionComposer` (puzzle 04 phase 7 extract).
 *
 * Pulled out of `SessionComposer.tsx` so the parent stays under the
 * 350-LOC budget. No React, no hooks — every function is a pure
 * mapper from typed inputs to UI copy (placeholder text, gating
 * reasons, success text).
 */

import type { Result } from "@shared/ipc/result.js";
import type { ChatSubmitResult } from "@shared/schemas/chat.js";
import type {
  RuntimeActivity,
  RuntimeStateDto,
} from "@shared/schemas/runtime.js";
import type {
  MissionRunStatus,
  SessionListItem,
} from "@shared/schemas/sessions.js";

/**
 * Statuses in which free text cannot reach the run.
 *
 * `running` IS DELIBERATELY ABSENT (M6, owner decision). Steering a running
 * mission is the DESIGNED path: `ingress.ts` persists a mid-run user message
 * as an operator instruction that the loop merges at its next tool-step
 * boundary, and the engine acknowledges it with a durable disposition row. The
 * composer gate contradicted the product - it refused the one thing the engine
 * was built to accept, and the operator's only remaining lever over a running
 * mission was Stop. The remaining members are all states where the run is
 * PARKED and free text genuinely cannot answer what it is parked on; each has
 * its own control, named in `gatedReason`.
 */
export const FREE_TEXT_DISALLOWED: ReadonlySet<MissionRunStatus> = new Set([
  "paused_approval",
  "paused_user",
  "paused_wake",
  "paused_error",
  "paused_plan_acceptance",
  // C3b: the run is waiting on a FORM the agent asked for. Free text cannot
  // answer it — the user must submit or dismiss the form — so the composer is
  // gated the same way every other paused state gates it.
  "paused_user_form",
]);

export function readRunStatus(
  data: Result<RuntimeStateDto> | undefined,
): MissionRunStatus | null {
  if (!data || !data.ok) return null;
  return data.data.status;
}

/**
 * The session's activity projection, or `null` when the runtime state has not
 * been read (or failed to read).
 *
 * NULL IS NOT IDLE. A surface that cannot read the state must say nothing
 * rather than assert the session is doing nothing - the same distinction
 * `StopAvailability` draws for the Stop key.
 *
 * The `?? null` is not dead code over a required DTO field: this value crossed
 * the IPC boundary, so what arrived is unknown until checked (rule 04), and the
 * sibling readout draws the same line for the same reason. The cost of being
 * wrong is asymmetric - an absent field must not throw out of the composer and
 * take the surrounding surface down with it, which is what an unguarded read
 * did here.
 */
export function readActivity(
  data: Result<RuntimeStateDto> | undefined,
): RuntimeActivity | null {
  if (!data || !data.ok) return null;
  return data.data.activity ?? null;
}

export function gatedReason(status: MissionRunStatus | null): string {
  switch (status) {
    case "paused_approval":
      return "Mission is paused for approval. Resolve the approval first.";
    case "paused_user":
      return "Mission is paused by you. Use the Continue button to resume.";
    case "paused_wake":
      return "Mission is waiting on a scheduled wake. Use Continue to resume now, or wait.";
    case "paused_error":
      return "Mission is paused after an error. Use the Recover button.";
    case "paused_plan_acceptance":
      return "Mission is paused for plan acceptance. Review and accept the action plan to resume.";
    case "paused_user_form":
      return "Mission is waiting on a form you opened. Submit or dismiss it to resume - dismissing tells the agent you declined.";
    default:
      return "Composer is gated until the mission run reaches a free state.";
  }
}

/**
 * Notice text for a completed chat submit, or `null` when no notice should
 * show. Shared by the composer's own submit path AND the welcome→create
 * hand-off. The two state-changing outcomes still surface — a stopped turn
 * ("Stopped.") and a mission's first goal ("Mission goal received.") — but a
 * plain chat send shows NOTHING: the reply already renders in the transcript,
 * so a redundant "Message sent." line below the input is just noise.
 */
/**
 * Notice text for a turn the user stopped. A shared constant rather than a
 * literal in two places: `PostStopRedirectHint` keys its "say what to do
 * differently" affordance off this exact notice, and a silent copy edit here
 * would make that affordance stop appearing with nothing failing.
 */
export const CHAT_STOPPED_NOTICE_TEXT = "Stopped.";

export function submitSuccessText(data: ChatSubmitResult): string | null {
  if (data.stopReason === "user_stopped") return CHAT_STOPPED_NOTICE_TEXT;
  if (data.treatedAsInitialGoal) return "Mission goal received.";
  return null;
}

/**
 * A chat submit can resolve successfully at the IPC boundary while the agent
 * itself stopped before finishing. These runtime guards are not transport
 * errors, so they arrive in `ChatSubmitResult.stopReason` rather than the
 * `Result` error channel. Translate only the terminal, operator-actionable
 * failure reasons here; approval and mission pause states already have their
 * own dedicated UI.
 */
export interface SubmitFailureNotice {
  readonly text: string;
  readonly retryable: boolean;
}

/**
 * Retry stays gated on the RAW count, never a read-only/mutating split:
 * `ChatSubmitResult` carries no per-tool identity, and the authoritative
 * "is this tool mutating" classification lives in the privileged
 * `src/vex-agent/tools/registry/*` `mutating` flags — untrusted renderer
 * code must not duplicate or guess at that classification (a wrong guess
 * would blindly replay a turn that already took a real action). Any
 * executed tool call, regardless of apparent kind, withholds one-click
 * Retry (see composer-helpers.test.ts for the pinned read-only-vs-mutating
 * case).
 */
function incompleteTurnNotice(
  data: ChatSubmitResult,
  reason: string,
): SubmitFailureNotice {
  if (data.toolCallsMade === 0) {
    return { text: reason, retryable: true };
  }
  return {
    text:
      `${reason} Review the transcript before trying again; ` +
      "earlier steps may have completed.",
    retryable: false,
  };
}

export function submitFailureNotice(
  data: ChatSubmitResult,
): SubmitFailureNotice | null {
  switch (data.stopReason) {
    case "iteration_limit":
      return incompleteTurnNotice(
        data,
        "Vex stopped before completing the task after reaching this turn's action limit.",
      );
    case "no_progress":
      // Routed through `incompleteTurnNotice` like the other incomplete-turn
      // reasons, and for the same reason: the STALL is only the tail of the
      // turn. Rounds before it can have dispatched real tool calls, so retry
      // stays gated on `toolCallsMade` exactly as everywhere else. Only when
      // the count is zero - the reported v0.2.6 shape - is one-click retry
      // offered, and there it is genuinely safe: nothing ran.
      return incompleteTurnNotice(
        data,
        "Vex stopped early because the model returned only empty responses.",
      );
    case "timeout":
      return incompleteTurnNotice(
        data,
        "Vex stopped before completing the task because this turn timed out.",
      );
    case "system_error":
      return incompleteTurnNotice(
        data,
        "Vex stopped before completing the task because of an internal error.",
      );
    case "tool_call_loop":
      // NEVER one-click retryable, and not through `incompleteTurnNotice`:
      // reaching this stop reason MEANS tool calls executed - five identical
      // ones, plus everything before them - so `toolCallsMade === 0` is not a
      // reachable state here and a retry arm gated on it would be dead code
      // pretending to be a safety check. Same policy as the tool-activity arm
      // above, stated unconditionally.
      return {
        text:
          "Vex stopped because it repeated the same tool call without making progress. "
          + "Review the transcript before trying again; earlier steps may have completed.",
        retryable: false,
      };
    case "compact_unable_at_critical":
      return {
        text: "Vex stopped because this conversation ran out of usable context. Start a new session or try a narrower request.",
        retryable: false,
      };
    default:
      return null;
  }
}

export function placeholderFor(session: SessionListItem | null): string {
  if (session?.mode !== "mission") return "What do you want Vex to do?";
  const goal = session.initialGoal?.trim();
  if (goal === undefined || goal.length === 0) {
    return "Describe the mission goal.";
  }
  return "Type a follow-up or refine the mission.";
}
