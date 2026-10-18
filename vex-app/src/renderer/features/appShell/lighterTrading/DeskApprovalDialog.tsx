import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { ApprovalActionResult, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { ApprovalCard } from "../ApprovalCard.js";
import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { isDeskFullCloseApproval } from "./desk-approvals.js";
import { setDeskReviewShowing, useDeskReviewSlot } from "./desk-review-slot.js";

function approvalToolId(summary: ApprovalSummaryDto): string | null {
  const preview = summary.preview;
  if (preview?.namespace === "lighter") return `lighter.${preview.toolName}`;
  const toolId = preview?.criticalArgs.toolId;
  return typeof toolId === "string" ? toolId : null;
}

function approvalTitle(approvals: ReadonlyArray<ApprovalSummaryDto>): string {
  const kinds = new Set(approvals.map(approvalToolId));
  if (kinds.size !== 1) return "Review mixed actions";
  switch ([...kinds][0]) {
    case "lighter.order.create": return "Review order";
    case "lighter.position.close": return "Review close";
    case "lighter.order.cancel": return "Review cancellation";
    case "lighter.order.cancelAll": return "Review account-wide cancellation";
    case "lighter.position.protect": return "Review protection";
    default: return "Review action";
  }
}

/**
 * Where focus lands when the review appears: the safe choice. The Reject key
 * of the card the desk asked to focus, else of the first card (each card's
 * Reject carries the `autofocus` content attribute, the one name every
 * approval surface gives its initial focus), else the review itself.
 */
function focusSafeChoice(root: HTMLElement | null, focusApprovalId: string | null): void {
  if (root === null) return;
  const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-approval-id]"));
  const card = cards.find((node) => node.dataset.approvalId === focusApprovalId) ?? cards[0];
  const reject = card?.querySelector<HTMLElement>('[data-vex-area="approval-foot"] [autofocus]') ?? null;
  (reject ?? root).focus({ preventScroll: true });
}

/**
 * The desk's own approval cards, inline in the ticket's place
 * (docs/design/R3-MINIMAL.md section 8.6).
 *
 * A card with `origin: "desk"` is the user's click (Close, Cancel, the
 * ticket's Long/Short) turned into a proposal by main: no model behind it,
 * nothing for a chat to show. "Review order" replaces the ticket in its
 * column, the same R3 approval card the transcript shows, narrower; the
 * agent's proposals stay in the chat. No modal and no veil: the desk stays
 * live around the review.
 *
 * The review renders into the slot the ticket keeps beside its form
 * (`desk-review-slot.ts`) and tells the ticket to step aside while it shows.
 * Without a slot (no ticket mounted) it renders where the desk mounts it.
 * It stays mounted while hidden, so a card keeps its armed key and an
 * approval already sending keeps its outcome on the way back.
 *
 * Escape hides the review until another card arrives; the card itself stays
 * pending in "Needs you" and behind the ticket's "Review pending approval"
 * until it expires. Reject has the first focus each time the review appears.
 * The safety flow is the card's own and unchanged: REAL FUNDS, the 4 s second
 * press for high risk, the click lock, "Signing and sending".
 *
 * A full Market close card also offers "Don't ask again": ticking it makes
 * the desk approve later full closes itself. Partial closes always confirm.
 */
export function DeskApprovalDialog({ approvals, sessionId, focusApprovalId, onResolved, skipCloseConfirm, onSkipCloseConfirm, reopenSignal = 0 }: {
  readonly approvals: ReadonlyArray<ApprovalSummaryDto>;
  readonly sessionId: string;
  readonly focusApprovalId: string | null;
  readonly onResolved: (decision: "approved" | "rejected", result: ApprovalActionResult) => void;
  readonly skipCloseConfirm: boolean;
  readonly onSkipCloseConfirm: (next: boolean) => void;
  /** Changes when the ticket asks to reopen approvals dismissed with Escape. */
  readonly reopenSignal?: number;
}): JSX.Element {
  const theme = useUiStore((state) => state.theme);
  const environment = useLighterAnalysisStore((state) => state.desk.environment);
  const slot = useDeskReviewSlot();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setDismissed(new Set()); }, [reopenSignal]);
  const open = approvals.some((summary) => !dismissed.has(summary.id));
  const showsClose = approvals.some(isDeskFullCloseApproval);
  const inTicket = slot !== null;
  const titleId = useId();
  const noteId = useId();
  const rootRef = useRef<HTMLDialogElement | null>(null);

  // Before paint, so the ticket and its review never draw in one frame.
  useLayoutEffect(() => { setDeskReviewShowing(open && inTicket); }, [open, inTicket]);
  useLayoutEffect(() => () => { setDeskReviewShowing(false); }, []);

  // The safe choice takes focus each time the review appears, as the modal's
  // own initial focus did; a refetch that keeps it open never refocuses.
  const focusRef = useRef(focusApprovalId);
  focusRef.current = focusApprovalId;
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) focusSafeChoice(rootRef.current, focusRef.current);
    wasOpen.current = open;
  }, [open]);

  const dismiss = (): void => { setDismissed(new Set(approvals.map((summary) => summary.id))); };

  const review = (
    <dialog
      ref={rootRef}
      open={open}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-describedby={noteId}
      data-vex-area="lighter-desk-approval"
      data-lighter-theme={theme}
      data-lighter-environment={environment}
      data-placement={inTicket ? "ticket" : "desk"}
      className="lit-order-review"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
    >
      <header className="lit-order-review-head">
        <h2 id={titleId}>{approvalTitle(approvals)}</h2>
        <p id={noteId}>Nothing signs until you confirm.</p>
      </header>
      {approvals.map((summary) => (
        <ApprovalCard
          key={summary.id}
          summary={summary}
          sessionId={sessionId}
          focusOnMount={summary.id === focusApprovalId}
          idVariant="lighter-desk"
          onResolved={onResolved}
        />
      ))}
      {showsClose ? (
        <label className="lit-desk-skip-confirm">
          <input
            type="checkbox"
            checked={skipCloseConfirm}
            onChange={(event) => onSkipCloseConfirm(event.target.checked)}
          />
          Don't ask again for 100% Market close
        </label>
      ) : null}
    </dialog>
  );
  return slot === null ? review : createPortal(review, slot);
}
