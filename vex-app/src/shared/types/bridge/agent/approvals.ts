import type { Result } from "../../../ipc/result.js";
import type {
  ApprovalActionInput,
  ApprovalActionResult,
  ApprovalDispatchEvent,
  ApprovalGetHistoryInput,
  ApprovalGetInput,
  ApprovalListPendingAllInput,
  ApprovalListPendingInput,
  ApprovalPendingGlobalDto,
  ApprovalSummaryDto,
} from "../../../schemas/approvals.js";

/**
 * Approval queue browsing + decisions. Read-only handlers extract
 * an allow-listed summary from `approval_queue.tool_call` JSONB —
 * raw payload never reaches the renderer. approve/reject run the
 * durable decision tx + background runtime continuation (puzzle 05
 * phase 3); non-actionable states surface `approvals.*` codes.
 */
export interface ApprovalsBridge {
  readonly listPending: (
    input: ApprovalListPendingInput
  ) => Promise<Result<ReadonlyArray<ApprovalSummaryDto>>>;
  /**
   * App-wide pending approvals for the DESK RULE global inbox — no
   * sessionId. Each row is the sanitized summary plus the joined session
   * title (nullable for session-less / deleted-session approvals).
   */
  readonly listPendingAll: (
    input: ApprovalListPendingAllInput
  ) => Promise<Result<ReadonlyArray<ApprovalPendingGlobalDto>>>;
  readonly get: (
    input: ApprovalGetInput
  ) => Promise<Result<ApprovalSummaryDto | null>>;
  readonly approve: (
    input: ApprovalActionInput
  ) => Promise<Result<ApprovalActionResult>>;
  readonly reject: (
    input: ApprovalActionInput
  ) => Promise<Result<ApprovalActionResult>>;
  readonly getHistory: (
    input: ApprovalGetHistoryInput
  ) => Promise<Result<ReadonlyArray<ApprovalSummaryDto>>>;
  /**
   * Background approve progress and outcome (`EV.approvals.dispatch`, Kairos
   * K-2 B2). Silent while `APPROVAL_DISPATCH_BACKGROUND` is off. Returns the
   * unsubscribe.
   */
  readonly onDispatchEvent: (
    callback: (event: ApprovalDispatchEvent) => void
  ) => () => void;
}
