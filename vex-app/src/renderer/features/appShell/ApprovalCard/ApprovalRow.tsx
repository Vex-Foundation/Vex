/**
 * An approval folded to one row, as the Needs you page draws every decision
 * but the open one (docs/design/R3-MINIMAL.md section 8.5): the target swatch,
 * the plain sentence, a meta line (the tool, who asked, the expiry) with the
 * REAL FUNDS stamp, and two keys, Reject and "Review {action}".
 *
 * Pure presentation, like the card's footer: Reject is the parent's own
 * `onRejectClick`, so a high-risk rejection still takes its second press here
 * exactly as it does on the open card, and the click lock and the in-flight
 * words are the card's. Review only opens the card; nothing is approved from a
 * row.
 */

import type { JSX, RefObject } from "react";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { Button } from "../../../components/ui/button.js";
import { Stamp } from "../../../components/ui/stamp.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { approvalActorLine } from "../approvals/approvals-copy.js";
import { approvalExpiryWords, approvalSentence, approvalToolTitle, isUserMcpApproval } from "./approval-sentence.js";
import { ApprovalFailureLine, rejectKeyWords } from "./ApprovalDecisionActions.js";

// The row's keys are the kit's keys (`Button`, Cloud's v99 keys: 13 caps at
// 400): Reject the strong `ink` key, Review the framed `ghost` one; neither
// is blue, since nothing is approved from a row. The armed Reject wears the
// 2px ink ring 3px out, as before.
const ARMED_RING = "outline outline-2 outline-offset-[3px] outline-rule-ink";

export interface ApprovalRowProps {
  readonly summary: ApprovalSummaryDto;
  readonly titleId: string;
  readonly projectName: string | null;
  readonly rejectRef: RefObject<HTMLButtonElement | null>;
  readonly onReject: () => void;
  /** Open this decision as the full card. */
  readonly onReview: () => void;
  /** "Review bridge", "Review order", ... */
  readonly reviewLabel: string;
  readonly rejectArmed: boolean;
  readonly inFlight: boolean;
  readonly rejectPending: boolean;
  readonly settledDecision: "approved" | "rejected" | null;
  readonly inlineError: string | null;
}

export function ApprovalRow({
  summary,
  titleId,
  projectName,
  rejectRef,
  onReject,
  onReview,
  reviewLabel,
  rejectArmed,
  inFlight,
  rejectPending,
  settledDecision,
  inlineError,
}: ApprovalRowProps): JSX.Element {
  const reject = rejectKeyWords({ armed: rejectArmed, pending: rejectPending, settled: settledDecision });
  const actor = approvalActorLine({
    origin: summary.origin,
    requestedByClient: summary.requestedByClient,
    projectId: summary.projectId,
    projectName,
  });
  const expiry = summary.expiresAt === null ? null : approvalExpiryWords(summary.expiresAt, Date.now());
  const meta = [
    approvalToolTitle(summary),
    actor === null ? null : `requested by ${actor}`,
    expiry === null ? null : expiry.replace(/^Expires/, "expires"),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  return (
    <div className="vex-appr-row">
      <span aria-hidden className="vex-appr-row__pin">
        <Swatch state="awaiting" size={10} />
      </span>
      <h3 id={titleId} className="vex-appr-row__title">
        {approvalSentence(summary)}
      </h3>
      <span className="vex-appr-row__go">
        <Button
          ref={rejectRef}
          variant="ink"
          onClick={onReject}
          disabled={inFlight}
          aria-busy={rejectPending}
          aria-label={reject.aria}
          className={`shrink-0${rejectArmed ? ` ${ARMED_RING}` : ""}`}
        >
          {reject.text}
        </Button>
        <Button variant="ghost" onClick={onReview} disabled={inFlight} className="shrink-0">
          {reviewLabel}
        </Button>
      </span>
      <p className="vex-appr-row__meta">
        <span>{meta}</span>
        {isUserMcpApproval(summary) ? null : <Stamp data-testid="real-funds-stamp" className="vex-appr-row__stamp" />}
      </p>
      {/* The card's failure line (Cloud's DG5-28): one ink line under the
          row's words, never red; mounted empty so its first text is said. */}
      <ApprovalFailureLine error={inlineError} className="vex-appr-row__fail" />
    </div>
  );
}
