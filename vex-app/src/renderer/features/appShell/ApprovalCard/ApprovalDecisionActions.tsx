/**
 * Presentational decision footer (Reject / Approve) for `ApprovalCard` (F3 —
 * SECURITY-relevant).
 *
 * This component ONLY renders the two buttons and forwards their clicks. The
 * security-critical logic stays in `ApprovalCard`:
 *   - `onReject` / `onApprove` are the parent's `onRejectClick` / `onApproveClick`
 *     handlers, which own the two-step confirm gate (first click arms, second
 *     fires) and the in-flight guard.
 *   - `armedAction` and `isHighRisk` are passed in so the label/aria swap to the
 *     "Click again to confirm" copy is byte-identical to the original.
 *   - `rejectRef` is forwarded so the parent's first-mount focus-on-Reject
 *     default (least-destructive) still lands on this button.
 *
 * No state, no effects, no decision logic here — moving this JSX must not, and
 * does not, weaken any confirm gate.
 */

import type { JSX, RefObject } from "react";
import { APPROVAL_REJECT_REASON_MAX } from "@shared/schemas/approvals.js";

export interface ApprovalDecisionActionsProps {
  readonly isHighRisk: boolean;
  readonly armedAction: "approve" | "reject" | null;
  readonly inFlight: boolean;
  readonly rejectRef: RefObject<HTMLButtonElement | null>;
  readonly onReject: () => void;
  readonly onApprove: () => void;
  /**
   * Optional operator note sent with a rejection. The engine already accepted a
   * reason; nothing ever supplied one, so every refusal reached the model as
   * "No reason provided" and the agent had nothing to adapt to.
   *
   * Bounded here as well as at both Zod gates — this text becomes model-visible
   * transcript content, so the UI should not let a user paste an essay into the
   * agent's context by accident.
   */
  readonly rejectReason: string;
  readonly onRejectReasonChange: (value: string) => void;
  readonly approveLabel?: string;
  readonly confirmApproveLabel?: string;
}

// Shared key shape — the landing's mono-uppercase pill. Tone classes below
// pick the quiet ghost (Reject) vs the FILLED amber primary (Approve — the
// landing .ws-alert review key: solid --vex-pin with ink text). The ARMED
// (confirm) state swaps the border to the danger mix on that button only —
// the second click is the irreversible one.
const KEY_BASE =
  "rounded-full border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:opacity-50";
const ARMED_BORDER =
  "border-[color-mix(in_oklab,var(--color-destructive)_40%,transparent)]";

const REASON_INPUT =
  "min-w-0 flex-1 rounded-full border border-[var(--vex-line)] bg-transparent px-3 py-1.5 text-[12px] text-foreground placeholder:text-[var(--vex-text-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)] disabled:opacity-50";

export function ApprovalDecisionActions({
  isHighRisk,
  armedAction,
  inFlight,
  rejectRef,
  onReject,
  onApprove,
  rejectReason,
  onRejectReasonChange,
  approveLabel = "Approve",
  confirmApproveLabel = "Click again to confirm approve",
}: ApprovalDecisionActionsProps): JSX.Element {
  const rejectArmed = isHighRisk && armedAction === "reject";
  const approveArmed = isHighRisk && armedAction === "approve";
  return (
    <footer className="flex items-center justify-end gap-2 border-t border-[var(--vex-line)] px-4 py-3">
      <input
        type="text"
        value={rejectReason}
        onChange={(e) => onRejectReasonChange(e.target.value)}
        disabled={inFlight}
        maxLength={APPROVAL_REJECT_REASON_MAX}
        aria-label="Reason for rejecting (optional)"
        placeholder="Reason (optional)"
        className={REASON_INPUT}
      />
      <button
        ref={rejectRef}
        type="button"
        onClick={onReject}
        disabled={inFlight}
        aria-label={rejectArmed ? "Confirm reject" : "Reject"}
        className={`${KEY_BASE} text-[var(--vex-text-2)] hover:bg-interactive-hover hover:text-foreground ${
          rejectArmed ? ARMED_BORDER : "border-[var(--vex-line-strong)]"
        }`}
      >
        {rejectArmed ? "Click again to confirm reject" : "Reject"}
      </button>
      <button
        type="button"
        onClick={onApprove}
        disabled={inFlight}
        aria-label={approveArmed ? "Confirm approve" : approveLabel}
        className={`${KEY_BASE} bg-[var(--vex-pin)] font-medium text-[var(--vex-surface-0)] hover:bg-[color-mix(in_oklab,var(--vex-pin)_85%,white)] ${
          approveArmed ? ARMED_BORDER : "border-transparent"
        }`}
      >
        {approveArmed ? confirmApproveLabel : approveLabel}
      </button>
    </footer>
  );
}
