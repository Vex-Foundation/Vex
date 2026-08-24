/**
 * The Studio CONTINUATION arm and the origin-aware lifecycle predicates.
 *
 * Both exist to keep one thing from happening: an agent turn running on a
 * project's backing session for a tool call the agent never made.
 *
 *   - the continuation's Studio arm takes NO LEASE, runs NO TURN, and does not
 *     touch `resume_consumed_at`. Its only job after a settlement commits is to
 *     tell the blocked MCP call that a durable answer exists;
 *   - the shared lifecycle predicates filter `origin = 'agent'`, so a Studio
 *     row can never enter the reconciler scan, the fast deferred-resume scan,
 *     or the control-state read that decides whether the Stop key is live.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const getStudioSettlementByApprovalId = vi.fn();
const markResumeAttempted = vi.fn();
const casMarkResumeConsumed = vi.fn();
const hasResumeCompleted = vi.fn();

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  getStudioSettlementByApprovalId,
  markResumeAttempted,
  casMarkResumeConsumed,
  hasResumeCompleted,
}));

const { claimResumeContinuation, runResumeAfterDecision, discardContinuation } =
  await import("@vex-agent/engine/core/approval-runtime/continuation.js");
const { studioSettlementBus } = await import(
  "@vex-agent/engine/runtime/studio-settlement-bus.js"
);
const predicates = await import(
  "@vex-agent/db/contracts/approval-lifecycle-predicates.js"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claimResumeContinuation - the Studio arm", () => {
  it("claims without a lease and without a mission run", async () => {
    const claim = await claimResumeContinuation({
      sessionId: "backing-1",
      missionRunId: null,
      approvalId: "approval-1",
      ownerPrefix: "approve-studio",
      origin: "studio_mcp",
      projectId: "project-1",
    });
    expect(claim.outcome).toBe("claimed");
    if (claim.outcome !== "claimed") return;
    expect(claim.continuation).toEqual({
      kind: "studio_mcp",
      approvalId: "approval-1",
      sessionId: "backing-1",
      projectId: "project-1",
    });
    // No `leaseHandle` at all: `deferred_busy` is unreachable for Studio, so an
    // in-app agent turn on the same backing session cannot stall a decision.
    expect("leaseHandle" in claim.continuation).toBe(false);
  });

  it("discards to a no-op, because there is no lease to give back", async () => {
    await expect(
      discardContinuation({
        kind: "studio_mcp",
        approvalId: "approval-1",
        sessionId: "backing-1",
        projectId: "project-1",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("runResumeAfterDecision - the Studio case", () => {
  it("runs no turn, stamps no completion marker, and announces the committed row", async () => {
    getStudioSettlementByApprovalId.mockResolvedValue({
      approvalId: "approval-1",
      projectId: "project-1",
      decision: "approved",
      decisionReason: null,
      refusalReason: null,
      executionStatus: "succeeded",
      settlement: { v: 1, result: { success: true, output: "done" } },
      settlementBytes: 42,
      expiresAt: null,
    });
    const events: Array<Record<string, unknown>> = [];
    const off = studioSettlementBus.subscribe((e) =>
      events.push(e as unknown as Record<string, unknown>),
    );
    let result;
    try {
      result = await runResumeAfterDecision({
        kind: "studio_mcp",
        approvalId: "approval-1",
        sessionId: "backing-1",
        projectId: "project-1",
      });
    } finally {
      off();
    }
    expect(result).toEqual({
      text: null,
      toolCallsMade: 0,
      pendingApprovals: [],
      stopReason: null,
      missionStatus: null,
    });
    // `resume_consumed_at` terminates AGENT resume eligibility. A Studio row is
    // filtered out of every scan that reads it, so writing it would record a
    // resume that never existed.
    expect(casMarkResumeConsumed).not.toHaveBeenCalled();
    expect(markResumeAttempted).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ approvalId: "approval-1", outcome: "settled" });
  });

  it("maps the row's own state to the outcome enum, and stays SILENT on a non-terminal row", async () => {
    // `null` means "emit nothing". The approval commits BEFORE the dispatch, so
    // `approved/not_started` and `approved/dispatching` are rows whose action is
    // still on its way: announcing them would release a blocked external agent
    // with an answer for something that has not finished. The writer that makes
    // the row terminal announces it, and the broker's periodic durable read is
    // the floor under a lost announce.
    const cases: ReadonlyArray<[string | null, string, string | null]> = [
      ["approved", "succeeded", "settled"],
      // A controlled tool failure is a REAL answer the agent must receive.
      ["approved", "failed", "settled"],
      ["approved", "indeterminate", "indeterminate"],
      ["approved", "not_started", null],
      ["approved", "dispatching", null],
      ["rejected", "not_started", "rejected"],
      ["rejected", "dispatching", "rejected"],
      [null, "not_started", null],
      [null, "dispatching", null],
    ];
    for (const [decision, executionStatus, expected] of cases) {
      getStudioSettlementByApprovalId.mockResolvedValue({
        approvalId: "approval-1",
        projectId: "project-1",
        decision,
        decisionReason: null,
        refusalReason: null,
        executionStatus,
        settlement: null,
        settlementBytes: null,
        expiresAt: null,
      });
      const events: Array<Record<string, unknown>> = [];
      const off = studioSettlementBus.subscribe((e) =>
        events.push(e as unknown as Record<string, unknown>),
      );
      try {
        await runResumeAfterDecision({
          kind: "studio_mcp",
          approvalId: "approval-1",
          sessionId: "backing-1",
          projectId: "project-1",
        });
      } finally {
        off();
      }
      const label = `${String(decision)}/${executionStatus}`;
      if (expected === null) {
        expect(events, label).toHaveLength(0);
      } else {
        expect(events, label).toHaveLength(1);
        expect(events[0]?.outcome, label).toBe(expected);
      }
    }
  });

  it("emits nothing for a row that has vanished", async () => {
    getStudioSettlementByApprovalId.mockResolvedValue(null);
    const listener = vi.fn();
    const off = studioSettlementBus.subscribe(listener);
    try {
      await runResumeAfterDecision({
        kind: "studio_mcp",
        approvalId: "approval-1",
        sessionId: "backing-1",
        projectId: "project-1",
      });
    } finally {
      off();
    }
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the shared lifecycle predicates", () => {
  it("filter `origin = 'agent'` in BOTH fragments", () => {
    // One owner, so the reconciler scan, the fast deferred-resume scan, the
    // stop-retention read and the Stop-key aggregate cannot drift apart on
    // which rows still owe work.
    expect(predicates.RESUMABLE_SHAPES_PREDICATE).toContain("origin = 'agent'");
    expect(predicates.INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE).toContain(
      "origin = 'agent'",
    );
  });

  it("keep the agent shapes they always described", () => {
    expect(predicates.RESUMABLE_SHAPES_PREDICATE).toContain(
      "(decision = 'approved' AND execution_status = 'not_started')",
    );
    expect(predicates.RESUMABLE_SHAPES_PREDICATE).toContain(
      "(result_message_id IS NOT NULL AND resume_consumed_at IS NULL)",
    );
    expect(predicates.INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE).toContain(
      "(decision = 'approved' AND execution_status = 'dispatching')",
    );
  });
});
