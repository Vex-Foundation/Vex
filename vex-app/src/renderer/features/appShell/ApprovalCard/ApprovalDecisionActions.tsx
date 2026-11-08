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
 *
 * In a chat the parent may draw this same footer in the shell's bottom row
 * instead (`dock`, docs/design/H3-DESKTOP.md sections 1.8 and 4.3): the reason
 * field across the top, then Reject 168 | the gate line | the approve key 200
 * at 1440. Only the layout and the middle cell's words change; every key,
 * label, handler and guard below is the one the card draws inside itself.
 */

import type { JSX, ReactNode, RefObject } from "react";
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
  /**
   * Drawn as the shell's DECISION ROW (docs/design/H3-DESKTOP.md section 1.8)
   * rather than inside the card: the parent portals this footer into the
   * chat's bottom row. The row names itself by the card's title, since it no
   * longer sits inside the card's region, and carries the gate line in its
   * middle cell. Layout and words only: the keys, their handlers and their
   * states are the same as inside the card.
   */
  readonly dock?: { readonly labelledBy: string; readonly gateLine: string } | null;
  /**
   * The decision's own failure (`ApprovalFailureLine`), or `null` while there
   * is none. Given (even `null`), the line is mounted right over the keys:
   * before the footer in the card, and inside the docked row between the
   * reason field and the keys. Omitted, no line is drawn here.
   */
  readonly failure?: string | null;
  /**
   * The clip cue (`ClipCue`, "{n} more lines below"), drawn as the footer's
   * first row while rows of the card are out of view; nothing otherwise.
   */
  readonly cue?: ReactNode;
}

// THE KEYS (section 8.2): 40 high, padding 0 18, 14 / 500 sans, square.
// Reject is the ink outline (the refusing choice) and owns the first focus;
// the action button is the view's one blue fill. Focus is the 2px focus
// outline, 3px out. The ARMED (second click) key turns into an ink outline
// with a 2px ink ring 3px out: the second press is the irreversible one, and
// ink is how this card says weight. A key that cannot act (disabled, while a
// decision runs or after it landed) is HELD, Cloud's look (h3-kit-gaps keys):
// the cell ground, the muted word, the 7% edge, never blue, never dotted and
// never dimmed. The sheet draws it (approval.css, "Held keys") from
// `disabled` alone, so when a key is enabled is exactly as before.
const KEY_BASE =
  "inline-flex h-10 shrink-0 items-center justify-center border px-[18px] font-sans text-[14px] font-medium leading-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus disabled:cursor-not-allowed";
const ARMED_RING = "outline outline-2 outline-offset-[3px] outline-rule-ink";

const REASON_INPUT =
  "h-10 min-w-0 flex-1 border border-rule bg-surface-field px-3 font-sans text-[14px] text-ink-primary caret-accent-primary placeholder:text-ink-tertiary focus-visible:border-accent-primary focus-visible:outline-none disabled:text-ink-tertiary";

/**
 * THE REASON FIELD'S WORDS (docs/design/H3-DESKTOP.md section 4.3 and
 * Appendix A.7). H3 words the field as what it is for: "Tell Vex what to do
 * instead". That is true here because the reason really reaches Vex: the
 * engine sanitises it and renders it into the rejection's tool result, which
 * is model-visible transcript content (`prepareReject`,
 * `src/vex-agent/engine/core/approval-runtime.ts`), so the agent reads it on
 * its next step.
 *
 * It travels with Reject and only with Reject: there is no Enter to send it,
 * no message of its own, and an Approve never carries it. So the placeholder
 * stays H3's words, and the field's accessible name, which a screen reader
 * says with no Reject key beside it, adds how and when it goes: optional, and
 * sent when you reject. Words only; the field behaves as it always has.
 */
export const REJECT_REASON_PLACEHOLDER = "Tell Vex what to do instead";
export const REJECT_REASON_LABEL = "Tell Vex what to do instead (optional, sent when you reject)";

/**
 * THE IN-FLIGHT WORDS (H3-DESKTOP.md Appendix A.7): Cloud's own, "Approving…"
 * and "Rejecting…" (`TakeoverCard.tsx`), wherever no Lighter-specific word
 * applies. Labels only: what the keys do while a decision runs is unchanged.
 */
export const APPROVING_WORD = "Approving…";
export const REJECTING_WORD = "Rejecting…";

/** A key's in-flight word as its accessible name says it, with no ellipsis. */
function spokenWord(word: string): string {
  return word.replace(/…$/, "");
}

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
  if (input.pending) return { text: REJECTING_WORD, aria: `${spokenWord(REJECTING_WORD)}, please wait` };
  if (input.settled === "rejected") return { text: "Rejected", aria: "Rejected" };
  if (input.armed) return { text: "Click again to confirm reject", aria: "Confirm reject" };
  return { text: "Reject", aria: "Reject" };
}

/**
 * THE FAILURE LINE (Cloud's DG5-28, `FooterAlert`): when a decision does not
 * go through, one ink line right over the decision band, one lightness step
 * over the card. It is always mounted and empty until it has words, so its
 * first text is said by the alert it already is; empty, it takes no room
 * (approval.css). No mark and never red: nothing was refused here, the
 * decision did not go through, and the keys are live again.
 *
 * The card draws it right before its footer, in the card or in the chat's
 * dock with the footer (`ApprovalCard`), so a docked card's failure sits
 * over the band, never in the transcript behind it.
 */
export function ApprovalFailureLine({
  error,
  className,
}: {
  readonly error: string | null;
  readonly className?: string;
}): JSX.Element {
  return (
    <div
      role="alert"
      data-vex-area="approval-failure"
      className={className === undefined ? "vex-appr__fail" : `vex-appr__fail ${className}`}
    >
      {error}
    </div>
  );
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
  pendingApproveLabel = APPROVING_WORD,
  approvePending = false,
  rejectPending = false,
  settledDecision = null,
  wrapReasonOnNarrow = false,
  rejectReasonInput = true,
  dock = null,
  failure,
  cue = null,
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
  const failureLine = failure === undefined ? null : <ApprovalFailureLine error={failure} />;
  // THE STATUS (Cloud's `.vx-tk-status`, `role="status"`, present from
  // mount): what the decision is doing, said once as it changes, since the
  // card is no live region of its own. Docked, it is the middle cell, which
  // reads the gate line until a decision runs; in the card, it is unseen.
  const statusWords = approvePending
    ? pendingApproveLabel
    : rejectPending
      ? REJECTING_WORD
      : settledDecision === "approved"
        ? "Approved."
        : settledDecision === "rejected"
          ? "Rejected."
          : null;
  return (
    <>
      {dock === null ? failureLine : null}
      <footer
        data-vex-area="approval-foot"
        // DOCKED (docs/design/H3-DESKTOP.md section 1.8): the shell's bottom
        // row under the chat, a grid of cells (approval.css): the reason field
        // across the top, then Reject | the gate line | the approve key. Out of
        // the card's region, so the group takes the card's title as its name.
        data-docked={dock !== null ? "" : undefined}
        role={dock !== null ? "group" : undefined}
        aria-labelledby={dock?.labelledBy}
        className={`vex-appr__foot${wrapReasonOnNarrow && dock === null ? " @max-[640px]:flex-wrap" : ""}`}
      >
        {/* The clip cue, first: under the card's visible rows and over the
            keys, never over a row. */}
        {cue}
        {dock === null ? (
          <p role="status" data-vex-area="approval-status" className="sr-only">
            {statusWords}
          </p>
        ) : null}
        {rejectReasonInput ? (
          <input
            type="text"
            value={rejectReason}
            onChange={(e) => onRejectReasonChange(e.target.value)}
            disabled={inFlight}
            maxLength={APPROVAL_REJECT_REASON_MAX}
            aria-label={REJECT_REASON_LABEL}
            placeholder={REJECT_REASON_PLACEHOLDER}
            className={`${REASON_INPUT}${wrapReasonOnNarrow ? " @max-[640px]:basis-full" : ""}`}
          />
        ) : null}
        {/* Docked, the failure line is the row's own cell between the reason
            field and the keys (Cloud's dock: the instruction row, the alert,
            the band). */}
        {dock !== null ? failureLine : null}
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
          // Presentation hooks for the docked row's sheet; the classes below
          // keep drawing the key inside the card.
          data-vex-key="reject"
          data-armed={rejectArmed ? "" : undefined}
          className={`${KEY_BASE} border-rule-ink bg-transparent text-ink-primary enabled:hover:bg-rule-ink enabled:hover:text-ink-on-primary${
            rejectArmed ? ` ${ARMED_RING}` : ""
          }`}
        >
          {rejectText}
        </button>
        {/* THE MIDDLE CELL, docked only: the line for the card's gate, where H3
            draws its tick box and key hints (section 4.3), and the card's
            status while a decision runs or has landed. Words, no control. */}
        {dock !== null ? (
          <p role="status" data-vex-area="approval-gate" className="vex-appr__gate">
            {statusWords ?? dock.gateLine}
          </p>
        ) : null}
        {/* THE WORKING KEY. A desk order signs, submits and then waits on the
            sequencer: fifteen-odd seconds in an app that is otherwise instant.
            While its own dispatch runs this button is the only live thing on
            screen, so it keeps its full blue fill and leads its label with the
            ONGOING SWATCH in its own ink (status by fill, the page's one state
            motion), as Cloud's pending key keeps its blue, while the Reject
            beside it is held (the cell ground and the muted word): the action
            you took stays alive, the one you did not recedes.
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
              ? `${spokenWord(pendingApproveLabel)}, please wait`
              : approveIdleAria
          }
          data-vex-approve-working={approvePending ? "" : undefined}
          data-vex-key="approve"
          data-armed={approveArmed ? "" : undefined}
          className={`${KEY_BASE} gap-2 ${
            approveArmed
              ? `border-rule-ink bg-transparent text-ink-primary ${ARMED_RING}`
              : "border-button-accent-edge bg-button-accent text-ink-on-button-accent enabled:hover:bg-button-accent-hover"
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
    </>
  );
}
