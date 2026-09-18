/**
 * Desk recovery owns only durable states. It may dispatch an approved row that
 * still proves `not_started`, and it may retry the terminal WRITE for a call
 * that already ran. It never replays a `dispatching` tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listUnstartedDeskApprovals = vi.fn();
const markAbandonedDeskDispatchesIndeterminate = vi.fn();
const commitDeskSettlementWith = vi.fn();
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  listUnstartedDeskApprovals: (...args: unknown[]) =>
    listUnstartedDeskApprovals(...args),
  markAbandonedDeskDispatchesIndeterminate: (...args: unknown[]) =>
    markAbandonedDeskDispatchesIndeterminate(...args),
  commitDeskSettlementWith: (...args: unknown[]) =>
    commitDeskSettlementWith(...args),
}));

const lockAndLoadSnapshot = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/snapshot/compare.js",
  () => ({ lockAndLoadSnapshot: (...args: unknown[]) => lockAndLoadSnapshot(...args) }),
);

const applyDeskApproveSideEffects = vi.fn();
vi.mock(
  "@vex-agent/engine/core/approval-runtime/post-tx/dispatch-approved/desk.js",
  () => ({
    applyDeskApproveSideEffects: (...args: unknown[]) =>
      applyDeskApproveSideEffects(...args),
  }),
);

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
}));
vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  registerDeskSettlementRepair,
  resetDeskSettlementRepairsForTests,
  deskSettlementRepairCount,
} = await import(
  "@vex-agent/engine/core/approval-runtime/desk/repair-registry.js"
);
const { reconcileDeskApprovalLifecycle } = await import(
  "@vex-agent/engine/core/approval-runtime/desk/reconcile.js"
);

const CUTOFF = new Date("2026-09-18T00:00:00.000Z");

function snapshot() {
  return {
    approval_id: "desk-unstarted",
    origin: "desk",
    decision: "approved",
    execution_status: "not_started",
    queue_resolved_at: CUTOFF,
    session_id: "session-1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDeskSettlementRepairsForTests();
  listUnstartedDeskApprovals.mockResolvedValue([]);
  markAbandonedDeskDispatchesIndeterminate.mockResolvedValue([]);
  commitDeskSettlementWith.mockResolvedValue(true);
  lockAndLoadSnapshot.mockResolvedValue(snapshot());
  applyDeskApproveSideEffects.mockResolvedValue({
    kind: "dispatched",
    executionStatus: "succeeded",
  });
});

describe("desk approval lifecycle recovery", () => {
  it("uses the process-start cutoff when terminalizing abandoned dispatches", async () => {
    markAbandonedDeskDispatchesIndeterminate.mockResolvedValue(["desk-old"]);

    const result = await reconcileDeskApprovalLifecycle({ abandonedBefore: CUTOFF });

    expect(markAbandonedDeskDispatchesIndeterminate).toHaveBeenCalledWith(CUTOFF);
    expect(result.abandoned).toBe(1);
  });

  it("dispatches an approved not_started row through the ordinary slot CAS path", async () => {
    listUnstartedDeskApprovals.mockResolvedValue(["desk-unstarted"]);

    const result = await reconcileDeskApprovalLifecycle();

    expect(lockAndLoadSnapshot).toHaveBeenCalledWith({}, "desk-unstarted");
    expect(applyDeskApproveSideEffects).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(1);
  });

  it("treats a slot-race loss as superseded and never starts a second dispatch", async () => {
    listUnstartedDeskApprovals.mockResolvedValue(["desk-unstarted"]);
    applyDeskApproveSideEffects.mockResolvedValue({
      kind: "cached_approved",
      executionStatus: "dispatching",
    });

    const result = await reconcileDeskApprovalLifecycle();

    expect(result.dispatched).toBe(0);
    expect(result.superseded).toBe(1);
  });

  it("keeps retrying only the settlement write until the database accepts it", async () => {
    commitDeskSettlementWith
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(true);
    registerDeskSettlementRepair({ approvalId: "desk-stuck", resultHash: "hash-1" });

    const failed = await reconcileDeskApprovalLifecycle();
    expect(failed.errored).toBe(1);
    expect(deskSettlementRepairCount()).toBe(1);

    const repaired = await reconcileDeskApprovalLifecycle();
    expect(repaired.repaired).toBe(1);
    expect(deskSettlementRepairCount()).toBe(0);
    expect(commitDeskSettlementWith).toHaveBeenCalledTimes(2);
    expect(applyDeskApproveSideEffects).not.toHaveBeenCalled();
  });
});
