/**
 * THE CLOSED CONFIRMATION (docs/design/H3-DESKTOP.md section 4.3 and
 * Appendix A.7; Cloud's EC-09 and the money gaps sheet's group 07): what a
 * chat says in a card's place once the card stops waiting, read only from
 * what the attempt recorded.
 *
 * WHAT IT READS. Two records desktop already holds, and nothing else:
 *   - the approval's own row from the approvals API (`approvals.get`): its
 *     status, how its tool ran (`executionStatus`), why it was rejected
 *     (`decisionReason`), when it was resolved and when it would have
 *     expired;
 *   - the reply this chat's own card received when the person pressed a key
 *     here (`DecidedHere`), the approvals API's answer to that decision.
 * The row wins when it is read; the reply stands in until it is.
 *
 * WHAT IT SAYS, Cloud's words, each only where the record proves it:
 *   - "Expired. Nothing was run.": the row was rejected by the expiry sweep
 *     (its reason is the engine's `expired_ttl`, and it was resolved at or
 *     after its own expiry), and its tool never ran;
 *   - "Rejected. Nothing was run.": any other rejection whose tool never ran.
 *     "You chose to reject." and "You rejected it, so nothing from this
 *     confirmation ran." only when the person rejected from this card: a
 *     rejection made elsewhere, or by the engine itself, names no one;
 *   - "Result uncertain": the person's approve ran the tool and the engine
 *     could not prove the outcome (`indeterminate`); "Check Agent Scan before
 *     trying again." (desktop's name for Cloud's Activity).
 * Everything else draws no closed card: an approve that ran and settled is
 * the transcript's to tell (the act row, the receipt), and an attempt the
 * record does not describe is never guessed at. No closed card names a
 * network or carries the REAL FUNDS stamp, and none says "Not submitted":
 * nothing on it is decided (EC-09).
 *
 * Pure: no React, no IO.
 */

import type {
  ApprovalActionResult,
  ApprovalExecutionStatus,
  ApprovalSummaryDto,
} from "@shared/schemas/approvals.js";

/** The reason the engine's expiry sweep writes on the row it rejects (`TOOL_RESULT_EXPIRED_REASON`). */
export const EXPIRED_DECISION_REASON = "expired_ttl";

/** What this chat's own card landed, as the approvals API answered the press. */
export interface DecidedHere {
  readonly decision: "approved" | "rejected";
  readonly result: ApprovalActionResult;
}

export type ClosedApprovalKind = "expired" | "rejected" | "uncertain";

export interface ClosedApprovalOutcome {
  readonly kind: ClosedApprovalKind;
  /** The strip's words, sentence case; the sheet sets the caps. */
  readonly title: string;
  /** What the person chose, only when they chose it on this card. */
  readonly answer: string | null;
  /** The line under it (`role="alert"`), or `null` where nothing more is proven. */
  readonly alert: string | null;
  /** Whether the next key is Agent Scan, where an uncertain result is checked. */
  readonly openAgentScan: boolean;
}

/** Cloud's words for the closed cards (RefusalCard.tsx; DG-5 `SEAT`). */
export const CLOSED_WORDS = {
  expiredTitle: "Expired. Nothing was run.",
  expiredAlert: "This confirmation expired before it was answered.",
  rejectedTitle: "Rejected. Nothing was run.",
  rejectedAnswer: "You chose to reject.",
  rejectedAlert: "You rejected it, so nothing from this confirmation ran.",
  uncertainTitle: "Result uncertain",
  uncertainAnswer: "You chose to approve.",
  uncertainAlert: "The result is uncertain. Check Agent Scan before trying again.",
  openAgentScan: "Open Agent Scan",
  dismiss: "Dismiss",
} as const;

/** A tool that never left the gate: no execution recorded, or one that never started. */
function nothingRan(executionStatus: ApprovalExecutionStatus | null): boolean {
  return executionStatus === null || executionStatus === "not_started";
}

/** Proof of an expiry: the sweep's own reason, resolved at or after the row's own deadline. */
function expiredByRecord(record: ApprovalSummaryDto): boolean {
  if (record.decisionReason !== EXPIRED_DECISION_REASON) return false;
  if (record.expiresAt === null || record.resolvedAt === null) return false;
  const expires = Date.parse(record.expiresAt);
  const resolved = Date.parse(record.resolvedAt);
  return Number.isFinite(expires) && Number.isFinite(resolved) && resolved >= expires;
}

/**
 * The closed card for an approval that has left this chat's waiting list, or
 * `null` when the record proves none of Cloud's closed states.
 */
export function closedApprovalOutcome(
  record: ApprovalSummaryDto | null,
  here: DecidedHere | null,
): ClosedApprovalOutcome | null {
  const settledRecord = record !== null && record.status !== "pending" ? record : null;
  const status = settledRecord?.status ?? here?.result.status ?? null;
  const executionStatus = settledRecord !== null ? settledRecord.executionStatus : here?.result.executionStatus ?? null;
  if (status === null || status === "pending") return null;

  if (status === "rejected") {
    if (!nothingRan(executionStatus)) return null;
    if (settledRecord !== null && expiredByRecord(settledRecord)) {
      return {
        kind: "expired",
        title: CLOSED_WORDS.expiredTitle,
        answer: null,
        alert: CLOSED_WORDS.expiredAlert,
        openAgentScan: false,
      };
    }
    const rejectedHere = here !== null && here.decision === "rejected";
    return {
      kind: "rejected",
      title: CLOSED_WORDS.rejectedTitle,
      answer: rejectedHere ? CLOSED_WORDS.rejectedAnswer : null,
      alert: rejectedHere ? CLOSED_WORDS.rejectedAlert : null,
      openAgentScan: false,
    };
  }

  if (executionStatus === "indeterminate") {
    return {
      kind: "uncertain",
      title: CLOSED_WORDS.uncertainTitle,
      answer: here !== null && here.decision === "approved" ? CLOSED_WORDS.uncertainAnswer : null,
      alert: CLOSED_WORDS.uncertainAlert,
      openAgentScan: true,
    };
  }
  return null;
}

/**
 * Whether the record may still change into a closed state: an approve whose
 * tool is still being dispatched can end `indeterminate`. The card reads the
 * row again while this holds.
 */
export function closedApprovalStillSettling(record: ApprovalSummaryDto | null): boolean {
  return record !== null && (record.status === "pending" || record.executionStatus === "dispatching");
}
