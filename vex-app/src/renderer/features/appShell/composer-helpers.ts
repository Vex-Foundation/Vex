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
import type { RuntimeStateDto } from "@shared/schemas/runtime.js";
import type {
  MissionRunStatus,
  SessionListItem,
} from "@shared/schemas/sessions.js";

export const FREE_TEXT_DISALLOWED: ReadonlySet<MissionRunStatus> = new Set([
  "running",
  "paused_approval",
  "paused_user",
  "paused_wake",
  "paused_error",
  "paused_plan_acceptance",
]);

export function readRunStatus(
  data: Result<RuntimeStateDto> | undefined,
): MissionRunStatus | null {
  if (!data || !data.ok) return null;
  return data.data.status;
}

export function gatedReason(status: MissionRunStatus | null): string {
  switch (status) {
    case "running":
      return "Mission is running. Use the Stop button first, or wait for the next paused state.";
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
export function submitSuccessText(data: ChatSubmitResult): string | null {
  if (data.stopReason === "user_stopped") return "Stopped.";
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
