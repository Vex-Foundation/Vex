/**
 * A CLOSED CONFIRMATION in a chat (docs/design/H3-DESKTOP.md section 4.3 and
 * Appendix A.7; Cloud's EC-09, the money gaps sheet's group 07): once a card
 * stops waiting, this stands in its place and says only what the attempt
 * recorded (`closed-approval.ts`): the strip with its square and its words
 * ("Rejected. Nothing was run."), the card's own sentence, what the person
 * chose when they chose it here, the line under it, and the next key.
 *
 * DISPLAY ONLY. It reads the approval's row through the existing approvals
 * read (`useApproval`, `approvals.get`) and decides nothing: no approve, no
 * reject, no IPC of its own. Its keys move the view: Dismiss takes it away,
 * Open Agent Scan opens the session's activity, where an uncertain result is
 * checked. Nothing on it names a network or carries the REAL FUNDS stamp:
 * no money is decided here (EC-09).
 */

import { useEffect, type JSX } from "react";
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

// The keys are the card footer's own: 40 high, padding 0 18, 14 / 500 sans,
// the ink outline, focus the 2px outline 3px out. None is blue: the composer
// is back under a closed card and holds the view's one blue.
const CLOSED_KEY =
  "inline-flex h-10 shrink-0 items-center justify-center border border-rule-ink bg-transparent px-[18px] font-sans text-[14px] font-medium leading-none text-ink-primary transition-colors hover:bg-rule-ink hover:text-ink-on-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-focus";

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
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-vex-area="approval-closed"
      data-vex-closed={outcome.kind}
      data-approval-id={summary.id}
      className="vex-appr vex-appr--closed"
    >
      <div className="vex-appr__in">
        <div className="vex-appr__head">
          <header className="vex-appr__top">
            <span aria-hidden className="vex-appr__closed-sq" data-vex-closed-sq={outcome.kind}>
              <Swatch state={outcome.kind === "uncertain" ? "awaiting" : "idle"} size={8} />
            </span>
            <h3 id={titleId} className="vex-appr__closed-title">
              {outcome.title}
            </h3>
          </header>
          <p className="vex-appr__title">{approvalSentence(summary)}</p>
        </div>
        {outcome.answer !== null ? (
          <dl className="vex-appr__dl">
            <div className="contents">
              <dt className="vex-field-label">{approvalEyebrowWord(summary)}</dt>
              <dd>{outcome.answer}</dd>
            </div>
          </dl>
        ) : null}
        {outcome.alert !== null ? (
          <p role="alert" className="vex-appr__closed-alert">
            {outcome.alert}
          </p>
        ) : null}
        <footer data-vex-area="approval-closed-foot" className="vex-appr__foot">
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
