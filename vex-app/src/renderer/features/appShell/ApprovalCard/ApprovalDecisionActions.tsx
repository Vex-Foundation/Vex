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
import { DIALOG_INITIAL_FOCUS } from "../../../components/ui/dialog.js";

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
  /** What the approve key says while its own dispatch is in flight. */
  readonly pendingApproveLabel?: string;
  /**
   * APPROVE specifically is in flight - not merely `inFlight`, which a running
   * rejection also sets. The working arc marks the key the user actually
   * pressed, so a rejection must never light the one they did not.
   */
  readonly approvePending?: boolean;
  readonly wrapReasonOnNarrow?: boolean;
  /**
   * The reason input exists to reach the model as transcript content. A card
   * with no model behind it (a desk click) has nobody to read it, so the
   * parent turns the input off rather than collecting words that go nowhere.
   */
  readonly rejectReasonInput?: boolean;
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
  pendingApproveLabel = "Working",
  approvePending = false,
  wrapReasonOnNarrow = false,
  rejectReasonInput = true,
}: ApprovalDecisionActionsProps): JSX.Element {
  const rejectArmed = isHighRisk && armedAction === "reject";
  const approveArmed = isHighRisk && armedAction === "approve";
  return (
    <footer className={`flex items-center justify-end gap-2 border-t border-[var(--vex-line)] px-4 py-3${wrapReasonOnNarrow ? " @max-[640px]:flex-wrap" : ""}`}>
      {rejectReasonInput ? (
        <input
          type="text"
          value={rejectReason}
          onChange={(e) => onRejectReasonChange(e.target.value)}
          disabled={inFlight}
          maxLength={APPROVAL_REJECT_REASON_MAX}
          aria-label="Reason for rejecting (optional)"
          placeholder="Reason (optional)"
          className={`${REASON_INPUT}${wrapReasonOnNarrow ? " @max-[640px]:basis-full" : ""}`}
        />
      ) : null}
      {/* REJECT IS THE NAMED INITIAL FOCUS, and it is first in the footer.
          The safer action owns both, and it owns them through the same
          `autofocus` content attribute every dialog in this app names its
          initial focus with (`components/ui/dialog.tsx`), so a card mounted
          inside a dialog and a card mounted inside the global approvals panel
          resolve to the SAME element by one rule rather than two. Measured
          defect this closes: the panel moved focus to its own container, so a
          keyboard user landed on nothing and the "least destructive default"
          existed only in the inline card's mount effect. */}
      <button
        ref={rejectRef}
        type="button"
        onClick={onReject}
        disabled={inFlight}
        {...DIALOG_INITIAL_FOCUS}
        aria-label={rejectArmed ? "Confirm reject" : "Reject"}
        className={`${KEY_BASE} text-[var(--vex-text-2)] hover:bg-interactive-hover hover:text-foreground ${
          rejectArmed ? ARMED_BORDER : "border-[var(--vex-line-strong)]"
        }`}
      >
        {rejectArmed ? "Click again to confirm reject" : "Reject"}
      </button>
      {/* THE WORKING KEY. A desk order signs, submits and then waits on the
          sequencer - fifteen-odd seconds in an app that is otherwise instant.
          While its own dispatch runs this button is the only live thing on
          screen, so it keeps full opacity and wears the house's travelling
          lane (`global-css/pending-ring.css`) while the dimmed Reject beside
          it goes inert: the action you took stays alive, the one you did not
          recedes. `--vex-ring-ink` hands the lane this key's own ink, so an
          amber band can never sit invisibly on an amber fill. `aria-busy` and
          the swapped label carry the same fact without the motion, which is
          what a screen reader and a reduced-motion viewer each get. */}
      <button
        type="button"
        onClick={onApprove}
        disabled={inFlight}
        aria-busy={approvePending}
        aria-label={
          approvePending
            ? `${pendingApproveLabel}, please wait`
            : approveArmed ? "Confirm approve" : approveLabel
        }
        className={`${KEY_BASE} bg-[var(--vex-pin)] font-medium text-[var(--vex-surface-0)] hover:bg-[var(--vex-pin-hover)] ${
          approvePending
            ? "vex-ring-working [--vex-ring-ink:var(--vex-surface-0)] border-transparent disabled:opacity-100"
            : approveArmed ? ARMED_BORDER : "border-transparent"
        }`}
      >
        {approvePending ? <span aria-hidden className="vex-ring-runner" /> : null}
        {/* ONE WIDTH, TWO LABELS. Both sit in the same grid cell, so the key
            is always sized to the longer of them and the swap crossfades in
            place instead of snapping the footer narrower under the pointer
            that just pressed it. The resting width is unchanged: the idle
            label is the longer one. The button's `aria-label` is what names
            it, so the faded copy is never announced twice. */}
        <span className="grid grid-cols-1 grid-rows-1 place-items-center">
          <span
            className={`col-start-1 row-start-1 transition-opacity ${approvePending ? "opacity-100" : "opacity-0"}`}
          >
            {pendingApproveLabel}
          </span>
          <span
            className={`col-start-1 row-start-1 transition-opacity ${approvePending ? "opacity-0" : "opacity-100"}`}
          >
            {approveArmed ? confirmApproveLabel : approveLabel}
          </span>
        </span>
      </button>
    </footer>
  );
}
