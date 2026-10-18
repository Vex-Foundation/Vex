/**
 * Presentational decision footer (Reason, Reject, the action button) for
 * `ApprovalCard` (F3, SECURITY-relevant; docs/design/R3-MINIMAL.md sections
 * 8.1 to 8.4).
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
 * No state, no effects, no decision logic here: moving this JSX must not, and
 * does not, weaken any confirm gate.
 *
 * The footer is sticky at short heights (bottom 0, paper, a quiet rule above),
 * so Reject and the action button stay in view while a long card scrolls.
 */

import type { JSX, RefObject } from "react";
import { APPROVAL_REJECT_REASON_MAX } from "@shared/schemas/approvals.js";
import { useInitialFocusRef } from "../../../components/ui/dialog.js";
import { Swatch } from "../../../components/ui/swatch.js";

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
   * Bounded here as well as at both Zod gates: this text becomes model-visible
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
  /**
   * REJECT specifically is in flight. The key says so the moment it is
   * pressed, for the same reason the approve key does: a dimmed key alone
   * reads as a click that did not land.
   */
  readonly rejectPending?: boolean;
  /**
   * The decision this card already landed. Both keys stay inert from the
   * reply until the refreshed pending list removes the card, and the key that
   * was pressed names the outcome instead of offering itself again.
   */
  readonly settledDecision?: "approved" | "rejected" | null;
  readonly wrapReasonOnNarrow?: boolean;
  /**
   * The reason input exists to reach the model as transcript content. A card
   * with no model behind it (a desk click) has nobody to read it, so the
   * parent turns the input off rather than collecting words that go nowhere.
   */
  readonly rejectReasonInput?: boolean;
}

// THE KEYS (section 8.2): 40 high, padding 0 18, 14 / 500 sans, square.
// Reject is the ink outline (the refusing choice) and owns the first focus;
// the action button is the view's one blue fill. Focus is the 2px focus
// outline, 3px out. The ARMED (second click) key turns into an ink outline
// with a 2px ink ring 3px out: the second press is the irreversible one, and
// ink is how this card says weight.
const KEY_BASE =
  "inline-flex h-10 shrink-0 items-center justify-center border px-[18px] font-sans text-[14px] font-medium leading-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus disabled:cursor-not-allowed";
const ARMED_RING = "outline outline-2 outline-offset-[3px] outline-rule-ink";

const REASON_INPUT =
  "h-10 min-w-0 flex-1 border border-rule bg-surface-field px-3 font-sans text-[14px] text-ink-primary caret-accent-primary placeholder:text-ink-tertiary focus-visible:border-accent-primary focus-visible:outline-none disabled:text-ink-tertiary";

/**
 * What the Reject key says and how it is named, in each of its states. One
 * source for the card's footer and the Needs you row, so the two keys can never
 * word a rejection differently.
 */
export function rejectKeyWords(input: {
  readonly armed: boolean;
  readonly pending: boolean;
  readonly settled: "approved" | "rejected" | null;
}): { readonly text: string; readonly aria: string } {
  if (input.pending) return { text: "Rejecting", aria: "Rejecting, please wait" };
  if (input.settled === "rejected") return { text: "Rejected", aria: "Rejected" };
  if (input.armed) return { text: "Click again to confirm reject", aria: "Confirm reject" };
  return { text: "Reject", aria: "Reject" };
}

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
  rejectPending = false,
  settledDecision = null,
  wrapReasonOnNarrow = false,
  rejectReasonInput = true,
}: ApprovalDecisionActionsProps): JSX.Element {
  // The Reject key keeps its own ref (the card's first-mount focus) and names
  // itself the initial focus: one ref does both, see `useInitialFocusRef`.
  const rejectKeyRef = useInitialFocusRef(rejectRef);
  const rejectArmed = isHighRisk && armedAction === "reject";
  const approveArmed = isHighRisk && armedAction === "approve";
  const { text: rejectText, aria: rejectAria } = rejectKeyWords({
    armed: rejectArmed,
    pending: rejectPending,
    settled: settledDecision,
  });
  const approveIdleText = settledDecision === "approved"
    ? "Approved"
    : approveArmed ? confirmApproveLabel : approveLabel;
  const approveIdleAria = settledDecision === "approved"
    ? "Approved"
    : approveArmed ? "Confirm approve" : approveLabel;
  return (
    <footer
      data-vex-area="approval-foot"
      className={`vex-appr__foot${wrapReasonOnNarrow ? " @max-[640px]:flex-wrap" : ""}`}
    >
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
          resolve to the SAME element by one rule rather than two. The
          attribute is written by the ref, not passed as a prop, because React
          warns on a lowercase `autofocus` prop. Measured
          defect this closes: the panel moved focus to its own container, so a
          keyboard user landed on nothing and the "least destructive default"
          existed only in the inline card's mount effect. */}
      <button
        ref={rejectKeyRef}
        type="button"
        onClick={onReject}
        disabled={inFlight}
        aria-busy={rejectPending}
        aria-label={rejectAria}
        className={`${KEY_BASE} border-rule-ink bg-transparent text-ink-primary enabled:hover:bg-rule-ink enabled:hover:text-ink-on-primary disabled:border-dotted disabled:text-ink-tertiary${
          rejectArmed ? ` ${ARMED_RING}` : ""
        }`}
      >
        {rejectText}
      </button>
      {/* THE WORKING KEY. A desk order signs, submits and then waits on the
          sequencer: fifteen-odd seconds in an app that is otherwise instant.
          While its own dispatch runs this button is the only live thing on
          screen, so it keeps its full blue fill and leads its label with the
          ONGOING SWATCH in its own ink (status by fill, the page's one state
          motion), while the Reject beside it goes inert in a dotted outline:
          the action you took stays alive, the one you did not recedes.
          `aria-busy` and the swapped label carry the same fact without the
          motion, which is what a screen reader and a reduced-motion viewer
          each get. */}
      <button
        type="button"
        onClick={onApprove}
        disabled={inFlight}
        aria-busy={approvePending}
        aria-label={
          approvePending
            ? `${pendingApproveLabel}, please wait`
            : approveIdleAria
        }
        data-vex-approve-working={approvePending ? "" : undefined}
        className={`${KEY_BASE} gap-2 ${
          approveArmed
            ? `border-rule-ink bg-transparent text-ink-primary ${ARMED_RING}`
            : "border-button-accent-edge bg-button-accent text-ink-on-button-accent enabled:hover:bg-button-accent-hover"
        }${
          approvePending
            ? ""
            : " disabled:border-dotted disabled:border-accent-primary disabled:bg-transparent disabled:text-accent-primary"
        }`}
      >
        {approvePending ? (
          <span aria-hidden className="inline-flex shrink-0">
            <Swatch state="ongoing" size={9} />
          </span>
        ) : null}
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
            {approveIdleText}
          </span>
        </span>
      </button>
    </footer>
  );
}
