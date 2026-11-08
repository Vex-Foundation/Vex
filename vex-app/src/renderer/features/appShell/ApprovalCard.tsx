/**
 * Inline approval card (F3, restricted-mode unblock).
 *
 * Shown by `ApprovalsRegion` between the transcript and the composer when the
 * agent's mutating tool call paused the run at `paused_approval` and the
 * backend enqueued an approval, and by the Needs you page. Backend is live
 * (puzzle-5 phase-3): `useApprove`/`useReject` to
 * `window.vex.approvals.{approve,reject}` to `prepareApprove`/`prepareReject`
 * to the background `runResumeAfterDecision`.
 *
 * THE H3 FRAME (docs/design/H3-DESKTOP.md sections 1.7 and 4.2). The card is
 * a square cell bounded by 1px rules, a stack of cells inside: the head (the
 * act as the eyebrow, "Confirm this swap"; MAINNET and the REAL FUNDS stamp at
 * the right; the plain sentence; the consequence line), the money rows, the
 * risk sentences and "All signed fields". Every desktop wallet is a real
 * wallet, so every card that can move funds carries MAINNET and the stamp,
 * the ink fill with its hatch glyph (approval.css). Ink, never red and never
 * blue: the stamp is a fact about the money, not a status colour. No veil.
 * The section keeps the `vex-real-funds` class and the `data-vex-real-funds`
 * hook every full card has carried; R3's 1.5px ink frame and 10px hatch band
 * that hung on them retired with H3, whose card is a plain ruled cell.
 *
 * THIS SLICE CHANGES HOW THE CARD LOOKS, NEVER HOW IT DECIDES. What Approve
 * and Reject do, the two-step confirm below, the fields shown as signed and
 * every IPC call are exactly as they were (section 4.3).
 *
 * The action button is named by tool family from the one action-word table
 * (`approvalActionWord`): "Approve bridge", "Approve order", "Approve swap",
 * "Approve transfer", else "Approve". The Lighter deposit and fee
 * authorization keep their own words; the armed second press of every other
 * card reads "Click again to confirm approve" (section 8.4).
 *
 * UX (per vex-ui-ux-quality + vex-provider-hot-wallet skills):
 *   - Default focus on Reject (least destructive) when this card is the
 *     FIRST newly-appearing one (parent decides via `focusOnMount`).
 *   - Two-step confirm for high-risk: `riskLevel ∈ {high,critical}` OR
 *     `actionKind ∈ {destructive,user_wallet_broadcast}`. First click arms,
 *     second click within CONFIRM_RESET_MS fires; timeout resets.
 *   - On success: invalidate pending / history (prefix) / messages
 *     (transcript) / runtime: the engine resume can flip status + write
 *     new transcript rows. The refresh runs in the background: the outcome
 *     (`onResolved`, the settled key) is shown the moment the reply lands,
 *     never after five refetches.
 *   - A click locks both keys in the same event, before the mutation's own
 *     pending state reaches a render, so a fast double click cannot send a
 *     second decision. A failure unlocks them exactly as before.
 *   - `useApprove`/`useReject` already use `retry: false`; we DO NOT auto-
 *     retry a dangerous action.
 *   - `Result.ok === false` surfaces as an inline error (TanStack `isError`
 *     does not catch application-level `Result` failures: Codex F3 #1).
 *   - `aria-live="polite"` so screen readers announce the card without
 *     stealing focus from existing content.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { ApprovalActionResult, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { useApprove, useReject } from "../../lib/api/approvals.js";
import { approvalActionWord } from "../vex/needs-you.js";
import { invalidateOnApprovalResolve } from "./approvals/invalidate-on-resolve.js";
import { isHighRisk as classifyHighRisk } from "./ApprovalCard/risk.js";
import { approvalGateLine, approvalReviewWord } from "./ApprovalCard/approval-sentence.js";
import { ApprovalDetails } from "./ApprovalCard/ApprovalDetails.js";
import { APPROVING_WORD, ApprovalDecisionActions } from "./ApprovalCard/ApprovalDecisionActions.js";
import { ApprovalRow } from "./ApprovalCard/ApprovalRow.js";

const CONFIRM_RESET_MS = 4_000;

function isLighterOrderCreateApproval(summary: ApprovalSummaryDto): boolean {
  return (
    summary.preview?.namespace === "lighter" &&
    summary.preview.toolName === "order.create"
  ) || summary.preview?.criticalArgs.toolId === "lighter.order.create";
}

function isLighterDepositApproval(summary: ApprovalSummaryDto): boolean {
  return (
    summary.preview?.namespace === "lighter" &&
    summary.preview.toolName === "deposit"
  ) || summary.preview?.criticalArgs.toolId === "lighter.deposit";
}

/**
 * The action button's word (section 8.2): the tool family's word from the one
 * table, except the two Lighter cards that already name their act.
 */
function approveLabelFor(summary: ApprovalSummaryDto): string {
  if (summary.preview?.criticalArgs.toolId === "lighter.fees.approve") {
    return summary.preview.criticalArgs.revoke === true ? "Revoke trading fees" : "Approve trading fees";
  }
  if (isLighterDepositApproval(summary)) return "Approve and deposit";
  return approvalActionWord(summary);
}

/**
 * What the key says WHILE the dispatch runs.
 *
 * A Lighter order create signs, submits and then waits on the sequencer's
 * answer, which is fifteen-odd seconds of an app that is otherwise instant. A
 * key that only dims for that long reads as a click that did not land, so it
 * names the step it is on instead, and the name has to stay true for the
 * whole window, which rules out a phase the card cannot actually observe.
 * Every other card says Cloud's word for the same moment, "Approving…"
 * (H3-DESKTOP.md Appendix A.7).
 */
function pendingApproveLabelFor(summary: ApprovalSummaryDto): string {
  if (isLighterOrderCreateApproval(summary)) return "Signing and sending";
  if (isLighterDepositApproval(summary)) return "Signing and depositing";
  if (summary.preview?.criticalArgs.toolId === "lighter.fees.approve") {
    return summary.preview.criticalArgs.revoke === true ? "Revoking" : "Authorizing";
  }
  return APPROVING_WORD;
}

function confirmApproveLabelFor(summary: ApprovalSummaryDto): string {
  if (summary.preview?.criticalArgs.toolId === "lighter.fees.approve") {
    return summary.preview.criticalArgs.revoke === true
      ? "Click again to revoke trading fees" : "Click again to approve trading fees";
  }
  if (isLighterDepositApproval(summary)) {
    return "Click again to approve and deposit";
  }
  return "Click again to confirm approve";
}

export interface ApprovalCardProps {
  readonly summary: ApprovalSummaryDto;
  readonly sessionId: string;
  /**
   * When true on initial mount, focus the Reject button. Parent computes this
   * for the FIRST newly-appearing card to honour the UX skill's "default focus
   * on least destructive" without stealing focus on every refetch.
   */
  readonly focusOnMount: boolean;
  /**
   * A3: when the SAME approval renders both inline (active session) and in the
   * global header panel, the panel instance passes a variant so its
   * `approval-card-<id>-title` element id stays unique (duplicate DOM ids break
   * `aria-labelledby`). Omit for the canonical inline card.
   */
  readonly idVariant?: string;
  /**
   * The joined Studio project name from the app-wide read
   * (`ApprovalPendingGlobalDto.projectName`), when the caller has one. Display
   * only; `summary.projectId` is the identity and is already on the summary.
   */
  readonly projectName?: string | null;
  /**
   * Fires as soon as a decision has landed; the query refresh runs after it in
   * the background. The Lighter desk uses it to show the tool's outcome under
   * the ticket, which has no transcript to read it from.
   */
  readonly onResolved?: (decision: "approved" | "rejected", result: ApprovalActionResult) => void;
  /**
   * `row` folds the card to one line for the Needs you page (section 8.5):
   * the sentence, the meta line, Reject and "Review {action}". The decision
   * state lives in THIS component either way, so switching a card between its
   * row and its full form never drops an armed key or an in-flight decision.
   */
  readonly layout?: "card" | "row";
  /** The row's Review key: open this decision as the full card. */
  readonly onReview?: () => void;
  /**
   * The chat's bottom-row seat (docs/design/H3-DESKTOP.md section 1.8,
   * `ApprovalCard/approval-dock.tsx`). Given one, the full card draws its
   * decision footer there as the decision row: the reason field, Reject, the
   * gate line and the approve key. It is the same footer with the same
   * handlers and the same state, only drawn elsewhere; `null` or absent keeps
   * it inside the card, as on every other surface.
   */
  readonly decisionDock?: HTMLElement | null;
}

/**
 * The card's own view of its decision, set synchronously on click. TanStack
 * publishes `isPending` through its notify scheduler, so between the click and
 * that render the keys would otherwise still be live.
 */
type CardDecision = "approving" | "rejecting" | "approved" | "rejected";

export function ApprovalCard({
  summary,
  sessionId,
  focusOnMount,
  idVariant,
  projectName = null,
  onResolved,
  layout = "card",
  onReview,
  decisionDock = null,
}: ApprovalCardProps): JSX.Element {
  const queryClient = useQueryClient();
  const approve = useApprove();
  const reject = useReject();
  const rejectRef = useRef<HTMLButtonElement | null>(null);

  const isHighRisk = useMemo(
    () => classifyHighRisk(summary),
    // Same inputs as the original inline classifier: recompute only when the
    // risk-bearing fields change, not on every `summary` identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary.riskLevel, summary.actionKind],
  );

  // Two-step confirm for high-risk. First click arms; second within
  // CONFIRM_RESET_MS fires. Switching buttons (or timeout) resets.
  const [armedAction, setArmedAction] = useState<"approve" | "reject" | null>(
    null,
  );
  useEffect(() => {
    if (armedAction === null) return;
    const t = setTimeout(() => setArmedAction(null), CONFIRM_RESET_MS);
    return () => clearTimeout(t);
  }, [armedAction]);

  // Focus Reject only ONCE per Codex constraint #3: empty deps so a refetch
  // that rerenders this card never refocuses (other components may have stolen
  // focus deliberately, e.g. user is typing in the composer).
  useEffect(() => {
    if (focusOnMount) rejectRef.current?.focus();
    // Intentionally empty deps: first-mount focus only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [inlineError, setInlineError] = useState<string | null>(null);
  // Operator note sent with a rejection. Local to the card and cleared on a
  // successful decision so it can never ride along to a later approval.
  const [rejectReason, setRejectReason] = useState("");
  // S5 signed glint: set in the approve success handler BEFORE invalidation
  // so the one-shot light renders before the refetch unmounts the card. If
  // the unmount wins the race that is acceptable: the light is a grace note,
  // not a contract. Reject never lights (one-light rule).
  const [signedGlint, setSignedGlint] = useState(false);
  const [decision, setDecision] = useState<CardDecision | null>(null);
  const decisionRef = useRef<CardDecision | null>(null);
  const markDecision = (next: CardDecision | null): void => {
    decisionRef.current = next;
    setDecision(next);
  };
  const inFlight = approve.isPending || reject.isPending || decision !== null;

  const invalidateOnResolve = (): Promise<void> => invalidateOnApprovalResolve(queryClient, sessionId);

  const fireApprove = (): void => {
    setInlineError(null);
    markDecision("approving");
    approve.mutate(
      { id: summary.id },
      {
        onSuccess: (result) => {
          if (result.ok) {
            setArmedAction(null);
            setSignedGlint(true);
            markDecision("approved");
            onResolved?.("approved", result.data);
            void invalidateOnResolve();
          } else {
            markDecision(null);
            setInlineError(result.error.message);
            void invalidateOnResolve();
          }
        },
        onError: (e) => {
          markDecision(null);
          setInlineError(e.message);
        },
      },
    );
  };

  const fireReject = (): void => {
    setInlineError(null);
    markDecision("rejecting");
    const trimmed = rejectReason.trim();
    reject.mutate(
      // Omit the key entirely when empty: `approvalActionInputSchema` is
      // `.strict()` and treats `reason` as optional, and the engine's default
      // ("No reason provided") is the right transcript text for a bare refusal.
      { id: summary.id, ...(trimmed.length > 0 ? { reason: trimmed } : {}) },
      {
        onSuccess: (result) => {
          if (result.ok) {
            setArmedAction(null);
            setRejectReason("");
            markDecision("rejected");
            onResolved?.("rejected", result.data);
            void invalidateOnResolve();
          } else {
            markDecision(null);
            setInlineError(result.error.message);
            void invalidateOnResolve();
          }
        },
        onError: (e) => {
          markDecision(null);
          setInlineError(e.message);
        },
      },
    );
  };

  const onApproveClick = (): void => {
    if (inFlight || decisionRef.current !== null) return;
    if (isHighRisk && armedAction !== "approve") {
      setArmedAction("approve");
      return;
    }
    fireApprove();
  };
  const onRejectClick = (): void => {
    if (inFlight || decisionRef.current !== null) return;
    if (isHighRisk && armedAction !== "reject") {
      setArmedAction("reject");
      return;
    }
    fireReject();
  };

  const titleId = `approval-card-${summary.id}${
    idVariant ? `-${idVariant}` : ""
  }-title`;
  const previewTool = summary.preview?.toolName ?? null;
  const namespace = summary.preview?.namespace ?? null;
  const toolName = previewTool ?? summary.toolName ?? "(unknown tool)";
  const criticalArgs = summary.preview?.criticalArgs ?? null;
  const approveLabel = approveLabelFor(summary);
  const confirmApproveLabel = confirmApproveLabelFor(summary);
  const pendingApproveLabel = pendingApproveLabelFor(summary);

  const settledDecision = decision === "approved" || decision === "rejected" ? decision : null;
  const rejectPending = reject.isPending || decision === "rejecting";

  if (layout === "row") {
    return (
      <section
        role="region"
        aria-labelledby={titleId}
        aria-live="polite"
        data-vex-area="approval-card"
        data-vex-approval-layout="row"
        data-approval-id={summary.id}
        tabIndex={-1}
        className="vex-appr-row-frame focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus"
      >
        <ApprovalRow
          summary={summary}
          titleId={titleId}
          projectName={projectName}
          rejectRef={rejectRef}
          onReject={onRejectClick}
          onReview={() => onReview?.()}
          reviewLabel={approvalReviewWord(summary)}
          rejectArmed={isHighRisk && armedAction === "reject"}
          inFlight={inFlight}
          rejectPending={rejectPending}
          settledDecision={settledDecision}
          inlineError={inlineError}
        />
      </section>
    );
  }

  // THE DECISION FOOTER, built once. Inside the card on every surface, or,
  // given the chat's dock, drawn into the shell's bottom row as H3's
  // decision row (section 1.8). Both are this one element: the same props,
  // the same handlers, the same state, so the two-step confirm, the
  // two-press Reject, the click lock and the reason that travels with Reject
  // are exactly the card's either way. Docked, it names itself by the card's
  // title and adds the gate line in its middle cell (Appendix A.7).
  const docked = decisionDock !== null;
  // The failure line rides with the footer (Cloud's `FooterAlert`, DG5-28):
  // right over the keys wherever they are drawn, so a docked card's failure
  // is said over the bottom row, not in the transcript behind it.
  const decisionActions = (
    <ApprovalDecisionActions
      isHighRisk={isHighRisk}
      armedAction={armedAction}
      inFlight={inFlight}
      rejectRef={rejectRef}
      onReject={onRejectClick}
      onApprove={onApproveClick}
      rejectReason={rejectReason}
      onRejectReasonChange={setRejectReason}
      approveLabel={approveLabel}
      confirmApproveLabel={confirmApproveLabel}
      pendingApproveLabel={pendingApproveLabel}
      approvePending={approve.isPending || decision === "approving"}
      rejectPending={rejectPending}
      settledDecision={settledDecision}
      wrapReasonOnNarrow={criticalArgs?.toolId === "lighter.fees.approve"}
      rejectReasonInput={summary.origin !== "desk"}
      failure={inlineError}
      dock={docked ? { labelledBy: titleId, gateLine: approvalGateLine(isHighRisk, CONFIRM_RESET_MS) } : null}
    />
  );

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      aria-live="polite"
      data-vex-area="approval-card"
      data-vex-approval-layout="card"
      // Where this card's decision row is drawn: in the shell's bottom row,
      // or (absent) in its own footer.
      data-vex-decision-docked={docked ? "" : undefined}
      data-approval-id={summary.id}
      // S5: the act ledger's "Awaiting signature" stamp-links jump here and
      // call focus(); tabIndex={-1} makes the region programmatically
      // focusable without entering the tab order.
      tabIndex={-1}
      // REAL FUNDS (module note): the hook every full card carries; the
      // head's MAINNET and stamp are how the card shows it.
      data-vex-real-funds=""
      // NOT `overflow-hidden`: any `overflow` other than `visible` becomes the
      // containing scrollport for a `position: sticky` descendant (CSS
      // Positioned Layout section 4.2), and this section never scrolls itself;
      // only its scrolling ancestor does (`ApprovalsRegion`'s bounded region,
      // the Needs you page). A clip here would resolve the sticky footer
      // against this non-scrolling box instead, making it a no-op.
      className={`vex-real-funds vex-appr focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus${criticalArgs?.toolId === "lighter.fees.approve" ? " @container" : ""}`}
    >
      <div className="vex-appr__in">
        <ApprovalDetails
          summary={summary}
          titleId={titleId}
          namespace={namespace}
          toolName={toolName}
          criticalArgs={criticalArgs}
          projectName={projectName}
          signedGlint={signedGlint}
          busy={approve.isPending || reject.isPending || decision === "approving" || decision === "rejecting"}
        />
        {decisionDock === null ? decisionActions : createPortal(decisionActions, decisionDock)}
      </div>
    </section>
  );
}
