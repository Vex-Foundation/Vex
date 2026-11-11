/**
 * The decision signal (`approvals/decision-signal.ts`): a display-only note
 * for Kimm's mood clock that a money card's decision landed. Its words come
 * from the approvals API's own reply, never from a guess.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ApprovalActionResult } from "@shared/schemas/approvals.js";
import {
  decisionFailed,
  decisionLanded,
  lastApprovalDecision,
  publishApprovalDecision,
  resetApprovalDecisionSignalForTests,
  subscribeApprovalDecisions,
  useApprovalDecisionSignal,
} from "../approvals/decision-signal.js";

const SESSION = "00000000-0000-4000-8000-00000000aa01";

function result(over: Partial<ApprovalActionResult> = {}): ApprovalActionResult {
  return {
    id: "appr-1",
    status: "approved",
    resolvedAt: "2026-05-28T10:02:00.000Z",
    runtimeOutcome: "resumed",
    executionStatus: "dispatching",
    missionRunId: null,
    cached: false,
    message: "Approved.",
    ...over,
  };
}

afterEach(() => {
  resetApprovalDecisionSignalForTests();
});

describe("decisionLanded", () => {
  const at = 1_000;
  it("says approved while the dispatched call runs, and carries its state", () => {
    for (const executionStatus of [null, "not_started", "dispatching", "succeeded", "indeterminate"] as const) {
      expect(decisionLanded({ decision: "approved", result: result({ executionStatus }), approvalId: "appr-1", sessionId: SESSION, at })).toEqual({
        kind: "approved",
        decision: "approve",
        approvalId: "appr-1",
        sessionId: SESSION,
        executionStatus,
        at,
      });
    }
  });

  it("says failed for an approve whose dispatch failed, and rejected for a rejection", () => {
    expect(
      decisionLanded({ decision: "approved", result: result({ executionStatus: "failed" }), approvalId: "a", sessionId: SESSION }).kind,
    ).toBe("failed");
    expect(
      decisionLanded({ decision: "rejected", result: result({ status: "rejected", executionStatus: null }), approvalId: "a", sessionId: SESSION })
        .kind,
    ).toBe("rejected");
  });

  it("says failed for a decision that did not go through", () => {
    expect(decisionFailed({ decision: "approve", approvalId: "a", sessionId: SESSION, at: 5 })).toEqual({
      kind: "failed",
      decision: "approve",
      approvalId: "a",
      sessionId: SESSION,
      executionStatus: null,
      at: 5,
    });
  });
});

describe("publishApprovalDecision", () => {
  it("keeps the last signal and tells every listener", () => {
    const heard = vi.fn();
    const stop = subscribeApprovalDecisions(heard);
    const signal = decisionFailed({ decision: "reject", approvalId: "a", sessionId: SESSION });
    publishApprovalDecision(signal);
    expect(lastApprovalDecision()).toBe(signal);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    publishApprovalDecision(signal);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("drops a listener's throw: publishing never fails", () => {
    const after = vi.fn();
    subscribeApprovalDecisions(() => {
      throw new Error("broken reader");
    });
    subscribeApprovalDecisions(after);
    expect(() => publishApprovalDecision(decisionFailed({ decision: "approve", approvalId: "a", sessionId: SESSION }))).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("re-renders a reader, and a chat's reader sees only its own chat", () => {
    const mine = renderHook(() => useApprovalDecisionSignal(SESSION));
    const other = renderHook(() => useApprovalDecisionSignal("00000000-0000-4000-8000-00000000aa02"));
    expect(mine.result.current).toBeNull();
    act(() => {
      publishApprovalDecision(decisionLanded({ decision: "approved", result: result(), approvalId: "a", sessionId: SESSION }));
    });
    expect(mine.result.current?.kind).toBe("approved");
    expect(other.result.current).toBeNull();
  });
});
