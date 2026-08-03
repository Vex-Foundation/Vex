/**
 * Tool-batch outcome contract — the discriminated union the orchestrator
 * returns to `turn-loop.ts`, plus the per-batch turn-result input shape.
 *
 * Extracted verbatim from `turn-loop-tool-batch.ts`. `StopPayload` and
 * `ToolBatchOutcome` are re-exported by the façade as the public surface;
 * `BatchTurnResult` is the orchestrator's private input interface.
 */

import type { StopReason } from "../../types.js";
import type {
  ParsedToolCall,
} from "@vex-agent/inference/types.js";

export interface BatchTurnResult {
  readonly content: string | null;
  readonly toolCalls: ParsedToolCall[];
  /** Provider reasoning trace for this turn; persisted on the assistant row. */
  readonly reasoning: string | null;
}

export interface StopPayload {
  readonly summary?: string;
  readonly evidence?: Record<string, unknown>;
}

export type ToolBatchOutcome =
  | {
      readonly kind: "approval_break";
      readonly pendingApprovalId: string;
      readonly toolCallsExecuted: number;
      readonly lastText: string | null;
    }
  /**
   * §C3b: the turn stopped on a launch form awaiting the human. The stopped call
   * has NO transcript result — `resumeAgentAfterUserForm` appends the only one
   * when the user deploys, dismisses, or the window expires.
   */
  | {
      readonly kind: "user_form_pause";
      readonly intentId: string;
      readonly toolCallsExecuted: number;
      readonly lastText: string | null;
    }
  | {
      readonly kind: "waiting_for_wake";
      readonly text: string | null;
      readonly stopPayload: StopPayload;
      readonly toolCallsExecuted: number;
      readonly lastText: string | null;
    }
  | {
      readonly kind: "plan_acceptance_pause";
      readonly text: string | null;
      readonly stopPayload: StopPayload;
      readonly toolCallsExecuted: number;
      readonly lastText: string | null;
    }
  | {
      readonly kind: "engine_stop";
      readonly stopReason: StopReason;
      readonly text: string | null;
      readonly stopPayload?: StopPayload;
      readonly toolCallsExecuted: number;
      readonly lastText: string | null;
    }
  | {
      readonly kind: "compact_committed";
      readonly toolCallsExecuted: number;
      readonly lastText: string | null;
    }
  | {
      readonly kind: "normal_complete";
      readonly toolCallsExecuted: number;
      readonly lastText: string | null;
    };
