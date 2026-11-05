/**
 * The closed confirmation's words (`ApprovalCard/closed-approval.ts`;
 * docs/design/H3-DESKTOP.md section 4.3; Cloud's EC-09, the money gaps
 * sheet's group 07).
 *
 * Pins that a closed card says only what the attempt recorded:
 *   - Expired only with the sweep's own reason AND a resolution at or after
 *     the row's own deadline, and only when nothing ran;
 *   - Rejected whenever the row is rejected and nothing ran, and "You chose
 *     to reject." / "You rejected it, ..." only for a rejection made here;
 *   - Result uncertain only for an approve the engine could not prove;
 *   - nothing at all for an approve that settled, a row still waiting, or no
 *     record, and never a network, a stamp or "Not submitted".
 */

import { describe, expect, it } from "vitest";
import type { ApprovalActionResult, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import {
  CLOSED_WORDS,
  EXPIRED_DECISION_REASON,
  closedApprovalOutcome,
  closedApprovalStillSettling,
  type DecidedHere,
} from "../ApprovalCard/closed-approval.js";

function record(over: Partial<ApprovalSummaryDto> = {}): ApprovalSummaryDto {
  return {
    id: "appr-1",
    sessionId: "00000000-0000-4000-8000-00000000aa01",
    toolCallId: "call-1",
    toolName: "WalletSendConfirm",
    status: "rejected",
    permissionAtEnqueue: "restricted",
    createdAt: "2026-11-05T10:00:00.000Z",
    resolvedAt: "2026-11-05T10:02:00.000Z",
    reasoningPreview: "",
    actionKind: "user_wallet_broadcast",
    riskLevel: "high",
    preview: null,
    expiresAt: "2026-11-05T10:05:00.000Z",
    decision: "rejected",
    decisionReason: "No reason provided",
    executionStatus: null,
    origin: "agent",
    projectId: null,
    requestedByClient: null,
    ...over,
  };
}

function reply(over: Partial<ApprovalActionResult> = {}): ApprovalActionResult {
  return {
    id: "appr-1",
    status: "rejected",
    resolvedAt: "2026-11-05T10:02:00.000Z",
    runtimeOutcome: "resumed",
    executionStatus: null,
    missionRunId: null,
    cached: false,
    message: "Rejected.",
    ...over,
  };
}

const rejectedHere: DecidedHere = { decision: "rejected", result: reply() };

describe("closedApprovalOutcome", () => {
  it("says Expired. Nothing was run. only with the sweep's reason and a resolution at or after the deadline", () => {
    const expired = record({
      decisionReason: EXPIRED_DECISION_REASON,
      expiresAt: "2026-11-05T10:05:00.000Z",
      resolvedAt: "2026-11-05T10:05:00.500Z",
    });
    expect(closedApprovalOutcome(expired, null)).toEqual({
      kind: "expired",
      title: "Expired. Nothing was run.",
      answer: null,
      alert: "This confirmation expired before it was answered.",
      openAgentScan: false,
    });
    // The reason alone is no proof: resolved before its deadline, it is a rejection.
    const early = record({ decisionReason: EXPIRED_DECISION_REASON, resolvedAt: "2026-11-05T10:01:00.000Z" });
    expect(closedApprovalOutcome(early, null)?.kind).toBe("rejected");
    // Nor is a deadline alone.
    const noReason = record({ resolvedAt: "2026-11-05T10:06:00.000Z" });
    expect(closedApprovalOutcome(noReason, null)?.kind).toBe("rejected");
    // A row with no deadline never expired.
    expect(closedApprovalOutcome(record({ decisionReason: EXPIRED_DECISION_REASON, expiresAt: null }), null)?.kind)
      .toBe("rejected");
  });

  it("says who rejected only when the person rejected on this card", () => {
    expect(closedApprovalOutcome(record(), rejectedHere)).toEqual({
      kind: "rejected",
      title: "Rejected. Nothing was run.",
      answer: "You chose to reject.",
      alert: "You rejected it, so nothing from this confirmation ran.",
      openAgentScan: false,
    });
    // Rejected elsewhere, or by the engine: the record proves the rejection, not the person.
    expect(closedApprovalOutcome(record({ decision: "rejected_stop", decisionReason: "wallet_removed" }), null)).toEqual({
      kind: "rejected",
      title: "Rejected. Nothing was run.",
      answer: null,
      alert: null,
      openAgentScan: false,
    });
    // An approve the engine refused (the live policy drifted) is a rejection
    // the person did not choose.
    const refused: DecidedHere = { decision: "approved", result: reply({ status: "rejected" }) };
    expect(closedApprovalOutcome(record({ decisionReason: "policy_drift_blocked" }), refused)?.answer).toBeNull();
  });

  it("never says Nothing was run. when the record shows the tool ran", () => {
    for (const executionStatus of ["dispatching", "succeeded", "failed", "indeterminate"] as const) {
      expect(closedApprovalOutcome(record({ executionStatus }), rejectedHere)).toBeNull();
    }
    expect(closedApprovalOutcome(record({ executionStatus: "not_started" }), null)?.kind).toBe("rejected");
  });

  it("says Result uncertain for an approve the engine could not prove, with Agent Scan next", () => {
    const uncertain = record({ status: "approved", decision: "approved", decisionReason: null, executionStatus: "indeterminate" });
    expect(closedApprovalOutcome(uncertain, null)).toEqual({
      kind: "uncertain",
      title: "Result uncertain",
      answer: null,
      alert: "The result is uncertain. Check Agent Scan before trying again.",
      openAgentScan: true,
    });
    const approvedHere: DecidedHere = {
      decision: "approved",
      result: reply({ status: "approved", executionStatus: "indeterminate" }),
    };
    expect(closedApprovalOutcome(uncertain, approvedHere)?.answer).toBe("You chose to approve.");
  });

  it("draws nothing for a settled approve: the transcript tells that", () => {
    for (const executionStatus of ["succeeded", "failed", "dispatching", "not_started", null] as const) {
      expect(closedApprovalOutcome(record({ status: "approved", decision: "approved", executionStatus }), null)).toBeNull();
    }
  });

  it("reads the reply until the row is read, and the row once it is", () => {
    expect(closedApprovalOutcome(null, rejectedHere)?.kind).toBe("rejected");
    expect(closedApprovalOutcome(record({ status: "pending", decision: null, resolvedAt: null }), rejectedHere)?.kind)
      .toBe("rejected");
    const approvedHere: DecidedHere = { decision: "approved", result: reply({ status: "approved", executionStatus: "succeeded" }) };
    expect(closedApprovalOutcome(null, approvedHere)).toBeNull();
    // The row wins over the reply.
    const settledLater = record({ status: "approved", decision: "approved", executionStatus: "indeterminate" });
    expect(closedApprovalOutcome(settledLater, { decision: "approved", result: reply({ status: "approved", executionStatus: "dispatching" }) })?.kind)
      .toBe("uncertain");
    expect(closedApprovalOutcome(null, null)).toBeNull();
  });

  it("names no network, no stamp, and never says Not submitted", () => {
    const words = Object.values(CLOSED_WORDS).join(" ");
    expect(words).not.toMatch(/mainnet|testnet|real funds|not submitted|reload/i);
  });
});

describe("closedApprovalStillSettling", () => {
  it("holds while the row waits or its tool is still being dispatched", () => {
    expect(closedApprovalStillSettling(null)).toBe(false);
    expect(closedApprovalStillSettling(record({ status: "pending" }))).toBe(true);
    expect(closedApprovalStillSettling(record({ status: "approved", executionStatus: "dispatching" }))).toBe(true);
    expect(closedApprovalStillSettling(record({ status: "approved", executionStatus: "succeeded" }))).toBe(false);
    expect(closedApprovalStillSettling(record())).toBe(false);
  });
});
