/**
 * A CLOSED CONFIRMATION in a chat (docs/design/H3-DESKTOP.md section 4.3 and
 * Appendix A.7; Cloud's EC-09, the money gaps sheet's group 07, and its
 * `RefusalCard`): once a card stops waiting, this stands in its place and
 * says only what the attempt recorded (`closed-approval.ts`), in Cloud's
 * structure:
 *   - the strip: its square and its words ("Rejected. Nothing was run."),
 *     the card's only heading, 12 caps in ink;
 *   - the body, which describes the card: the answer row (the card's title
 *     in 11 caps muted, its sentence in 14 ink, and "You chose to reject." in
 *     ink 2 only when the person chose here), and for an expiry the line
 *     "This confirmation expired before it was answered." in 15 ink, said as
 *     the card's description, never as an alert;
 *   - the alert over the band, mounted empty: "You rejected it, so nothing
 *     from this confirmation ran." or "The result is uncertain. Check Agent
 *     Scan before trying again.";
 *   - the band: a fill, then the next keys at its end, each a cell at least
 *     160 wide with its left rule, 13 caps, none blue.
 *
 * DISPLAY ONLY. It reads the approval's row through the existing approvals
 * read (`useApproval`, `approvals.get`) and decides nothing: no approve, no
 * reject, no IPC of its own. Its keys move the view: Dismiss takes it away,
 * Open Agent Scan opens the session's activity, where an uncertain result is
 * checked. Nothing on it names a network or carries the REAL FUNDS stamp:
 * no money is decided here (EC-09).
 */

import { useEffect, type JSX } from "react";
import { ApprovalFailureLine } from "./ApprovalDecisionActions.js";
import type { ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { useApproval } from "../../../lib/api/approvals.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { approvalEyebrowWord, approvalSentence } from "./approval-sentence.js";
import {
  CLOSED_WORDS,
  closedApprovalOutcome,
  closedApprovalStillSettling,
  type DecidedHere,
} from "./closed-approval.js";

/** How often a row still being dispatched is read again. */
const SETTLING_REREAD_MS = 5_000;

// The keys are cells of the closed band (approval.css, "A closed
// confirmation"): at least 160 wide, each with its left rule, 13 caps. None
// is blue: the composer is back under a closed card and holds the view's one
// blue.
const CLOSED_KEY = "vex-appr__closed-key";

export interface ClosedApprovalCardProps {
  /** The approval as it last waited here: its sentence and its family. */
  readonly summary: ApprovalSummaryDto;
  readonly sessionId: string;
  /** What this chat's card landed, when the person decided here. */
  readonly decidedHere: DecidedHere | null;
  /** Take the closed card away (Dismiss, or nothing the record proves). */
  readonly onDismiss: () => void;
}

export function ClosedApprovalCard({
  summary,
  sessionId,
  decidedHere,
  onDismiss,
}: ClosedApprovalCardProps): JSX.Element | null {
  const query = useApproval(summary.id);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const record = query.data?.ok === true ? query.data.data : null;
  const read = query.data !== undefined || query.isError;
  const settling = closedApprovalStillSettling(record);
  const outcome = closedApprovalOutcome(record, decidedHere);

  // A row read while it was still waiting or still dispatching may yet
  // become a closed state: read it again until it settles.
  const { refetch } = query;
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => void refetch(), SETTLING_REREAD_MS);
    return () => clearTimeout(timer);
  }, [settling, refetch, query.dataUpdatedAt]);

  // Read and settled with nothing to say: leave no empty place behind.
  useEffect(() => {
    if (read && !settling && outcome === null) onDismiss();
  }, [read, settling, outcome, onDismiss]);

  if (outcome === null) return null;

  const titleId = `approval-closed-${summary.id}-title`;
  const bodyId = `approval-closed-${summary.id}-body`;
  // The expiry is the card's own description; a rejection's or an uncertain
  // result's line is the alert over the band (Cloud's RefusalCard).
  const bodyLine = outcome.kind === "expired" ? outcome.alert : null;
  const footAlert = outcome.kind === "expired" ? null : outcome.alert;
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-vex-area="approval-closed"
      data-vex-closed={outcome.kind}
      data-approval-id={summary.id}
      className="vex-appr vex-appr--closed"
    >
      <div className="vex-appr__in">
        <header className="vex-appr__top vex-appr__closed-strip">
          <span aria-hidden className="vex-appr__closed-sq" data-vex-closed-sq={outcome.kind}>
            <Swatch state={outcome.kind === "uncertain" ? "awaiting" : "idle"} size={8} />
          </span>
          <h3 id={titleId} className="vex-appr__closed-title">
            {outcome.title}
          </h3>
        </header>
        <div id={bodyId} data-vex-area="approval-closed-body">
          <ul className="vex-appr__answers">
            <li>
              <span className="vex-appr__answer-k">{approvalEyebrowWord(summary)}</span>
              <span className="vex-appr__answer-v">{approvalSentence(summary)}</span>
              {outcome.answer !== null ? <span className="vex-appr__answer-said">{outcome.answer}</span> : null}
            </li>
          </ul>
          {bodyLine !== null ? <p className="vex-appr__closed-alert">{bodyLine}</p> : null}
        </div>
        <ApprovalFailureLine error={footAlert} />
        <footer data-vex-area="approval-closed-foot" data-closed="" className="vex-appr__foot">
          <span aria-hidden className="vex-appr__closed-fill" />
          {outcome.openAgentScan ? (
            <button
              type="button"
              className={CLOSED_KEY}
              onClick={() => setShellRoute({ kind: "agentScan", origin: null, sessionId })}
            >
              {CLOSED_WORDS.openAgentScan}
            </button>
          ) : null}
          <button type="button" className={CLOSED_KEY} onClick={onDismiss}>
            {CLOSED_WORDS.dismiss}
          </button>
        </footer>
      </div>
    </section>
  );
}
