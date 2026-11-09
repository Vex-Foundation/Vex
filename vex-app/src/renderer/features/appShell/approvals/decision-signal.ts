/**
 * THE DECISION SIGNAL: a display-only, renderer-side note that a decision on
 * a money card has landed, for Kimm's mood clock (`features/vex/kimm-mood.ts`,
 * its `approved` and `outcome` options; VEX Cloud's event clock,
 * `use-kimm-events.ts`). The chat's approvals stack (`ApprovalsRegion`)
 * publishes it when one of its cards hears back; the Vex column may read it
 * to show her offer while an approved call runs, and signed or refused after.
 *
 * PUBLISH ONLY, AND NEVER PART OF A DECISION. It is written after the card's
 * own reply has been handled, from what that reply already said, and nothing
 * on the decision path reads it: no key, no gate, no IPC. A listener that
 * throws is dropped silently, so a reader can never break the card that
 * published. It holds the last signal in memory only; nothing is stored.
 *
 * WHAT IT SAYS, from the approvals API's own answer (`ApprovalActionResult`):
 *   approved  an approve landed and its tool was dispatched: running
 *             (`executionStatus` null, `not_started` or `dispatching`), done
 *             (`succeeded`) or unproven (`indeterminate`). `executionStatus`
 *             rides along, so a reader can tell a fill from a call still
 *             running, and never claims a fill it was not told of.
 *   rejected  a reject landed.
 *   failed    a decision did not go through (the reply was a failure, or the
 *             call never answered), or an approve's dispatch failed
 *             (`executionStatus` `failed`).
 */

import { useSyncExternalStore } from "react";
import type { ApprovalActionResult, ApprovalExecutionStatus } from "@shared/schemas/approvals.js";

export type ApprovalDecisionSignalKind = "approved" | "rejected" | "failed";

export interface ApprovalDecisionSignal {
  readonly kind: ApprovalDecisionSignalKind;
  /** The decision the person made on the card. */
  readonly decision: "approve" | "reject";
  readonly approvalId: string;
  readonly sessionId: string;
  /** The tool's dispatch state as the reply said it; null where the reply had none. */
  readonly executionStatus: ApprovalExecutionStatus | null;
  /** When it was published (`Date.now()`), so a reader can let it age out. */
  readonly at: number;
}

type Listener = () => void;

let last: ApprovalDecisionSignal | null = null;
const listeners = new Set<Listener>();

/** Publish a signal. Never throws: a reader's failure stays the reader's. */
export function publishApprovalDecision(signal: ApprovalDecisionSignal): void {
  last = signal;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A display reader must never reach back into the card that published.
    }
  }
}

/** The signal for a decision that landed, from the approvals API's own reply. */
export function decisionLanded(input: {
  readonly decision: "approved" | "rejected";
  readonly result: ApprovalActionResult;
  readonly approvalId: string;
  readonly sessionId: string;
  readonly at?: number;
}): ApprovalDecisionSignal {
  const executionStatus = input.result.executionStatus;
  const kind: ApprovalDecisionSignalKind =
    input.decision === "rejected" ? "rejected" : executionStatus === "failed" ? "failed" : "approved";
  return {
    kind,
    decision: input.decision === "approved" ? "approve" : "reject",
    approvalId: input.approvalId,
    sessionId: input.sessionId,
    executionStatus,
    at: input.at ?? Date.now(),
  };
}

/** The signal for a decision that did not go through. */
export function decisionFailed(input: {
  readonly decision: "approve" | "reject";
  readonly approvalId: string;
  readonly sessionId: string;
  readonly at?: number;
}): ApprovalDecisionSignal {
  return {
    kind: "failed",
    decision: input.decision,
    approvalId: input.approvalId,
    sessionId: input.sessionId,
    executionStatus: null,
    at: input.at ?? Date.now(),
  };
}

/** Listen for the next signal; returns the unsubscribe. */
export function subscribeApprovalDecisions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The last signal published, or null. */
export function lastApprovalDecision(): ApprovalDecisionSignal | null {
  return last;
}

/**
 * The last signal, for React: re-renders when a new one is published. Given a
 * session, only that chat's signal (null for any other's).
 */
export function useApprovalDecisionSignal(sessionId: string | null = null): ApprovalDecisionSignal | null {
  const signal = useSyncExternalStore(subscribeApprovalDecisions, lastApprovalDecision, lastApprovalDecision);
  if (signal === null) return null;
  return sessionId === null || signal.sessionId === sessionId ? signal : null;
}

/** Tests only: forget the last signal and every listener. */
export function resetApprovalDecisionSignalForTests(): void {
  last = null;
  listeners.clear();
}
