/**
 * The SAME-PROCESS REPAIR OWNER for failed Studio terminal writes.
 *
 * The defect it closes: a terminal write that THREW used to give up, naming a
 * floor that does not exist for an APPROVED row. The expiry sweep scans
 * `decision IS NULL` only and the agent lifecycle scans exclude Studio rows, so
 * such a row stayed `approved/not_started` - still eligible for the
 * dispatch-slot CAS, so still able to RUN behind a caller already told it had
 * not - or `approved/dispatching` until the process restarted, with the blocked
 * MCP call waiting the whole time.
 *
 * The properties pinned here, each of which goes red if the owner is removed:
 *
 *   - a pre-dispatch refusal whose CAS throws EVERY time is retried until it
 *     commits, and the waiter-visible bus event fires ONLY after that commit;
 *   - the same for an exhausted `dispatching -> indeterminate` write;
 *   - an entry stops on a CAS that matched zero rows, and on a row that already
 *     reads terminal;
 *   - NOTHING in the owner dispatches: the tool admission is mocked and must
 *     never be called;
 *   - SINGLE-FLIGHT: a write that never settles leaves exactly one pass in
 *     flight, however long the clock runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const casRefuseStudioBeforeDispatchWith = vi.fn();
const casMarkIndeterminateWithSettlementWith = vi.fn();
const getStudioSettlementByApprovalId = vi.fn();
const admitStudioCall = vi.fn();

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  casRefuseStudioBeforeDispatchWith,
  casMarkIndeterminateWithSettlementWith,
  getStudioSettlementByApprovalId,
}));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
}));
// Mocked ONLY so the assertions can prove the repair owner never reaches a
// tool. An approved money-path call is never re-run to discover its outcome.
vi.mock("@vex-agent/mcp/admission.js", () => ({ admitStudioCall }));

const {
  registerStudioWriteRepair,
  studioWriteRepairCount,
  disposeStudioWriteRepair,
  resetStudioWriteRepairForTests,
  STUDIO_REPAIR_CAP,
  STUDIO_REPAIR_INTERVAL_MS,
} = await import(
  "@vex-agent/engine/core/approval-runtime/studio/write-repair.js"
);
const { studioSettlementBus } = await import(
  "@vex-agent/engine/runtime/studio-settlement-bus.js"
);

const APPROVAL_ID = "approval-1";

/** A row that is NOT terminal: approved, and nothing has settled it. */
function unsettledRow(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: APPROVAL_ID,
    projectId: "p-1",
    decision: "approved",
    decisionReason: null,
    refusalReason: null,
    executionStatus: "not_started",
    settlement: null,
    settlementBytes: null,
    expiresAt: null,
    ...overrides,
  };
}

function refusalEntry(approvalId = APPROVAL_ID) {
  return {
    write: "refusal" as const,
    approvalId,
    refusalReason: "generation_superseded" as const,
    settlementJson: '{"v":1,"result":{"success":false,"output":"refused"}}',
    settlementBytes: 52,
    resultHash: "hash-1",
  };
}

function indeterminateEntry(approvalId = APPROVAL_ID) {
  return {
    write: "indeterminate" as const,
    approvalId,
    settlementJson: '{"v":1,"result":{"success":false,"output":"unprovable"}}',
    settlementBytes: 55,
    resultHash: "hash-2",
  };
}

/** Run exactly `passes` repair passes on the fake clock. */
async function advancePasses(passes: number): Promise<void> {
  for (let i = 0; i < passes; i++) {
    await vi.advanceTimersByTimeAsync(STUDIO_REPAIR_INTERVAL_MS);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetStudioWriteRepairForTests();
  getStudioSettlementByApprovalId.mockResolvedValue(unsettledRow());
  casRefuseStudioBeforeDispatchWith.mockResolvedValue(true);
  casMarkIndeterminateWithSettlementWith.mockResolvedValue(true);
});

afterEach(() => {
  resetStudioWriteRepairForTests();
  vi.useRealTimers();
});

describe("the repair owner retries the WRITE until it commits", () => {
  it("retries a pre-dispatch refusal that throws every time, then announces", async () => {
    const events: string[] = [];
    const off = studioSettlementBus.subscribe((event) => {
      events.push(event.outcome);
    });
    try {
      // Throws on the first two passes, commits on the third.
      casRefuseStudioBeforeDispatchWith
        .mockRejectedValueOnce(new Error("connection terminated"))
        .mockRejectedValueOnce(new Error("connection terminated"))
        .mockResolvedValueOnce(true);

      registerStudioWriteRepair(refusalEntry());
      expect(studioWriteRepairCount()).toBe(1);

      await advancePasses(2);
      // Two failed passes: still owed, and NOTHING has been announced. A bus
      // event here would release the blocked agent from a state that does not
      // exist in the database.
      expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledTimes(2);
      expect(studioWriteRepairCount()).toBe(1);
      expect(events).toEqual([]);

      await advancePasses(1);
      expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledTimes(3);
      // Committed: the entry is done and the waiter is released, in that order.
      expect(studioWriteRepairCount()).toBe(0);
      expect(events).toEqual(["rejected"]);

      // The body is replayed byte-for-byte, and it is the SAME CAS.
      const written = casRefuseStudioBeforeDispatchWith.mock.calls[0]?.[1] as {
        approvalId: string;
        refusalReason: string;
        settlementJson: string;
      };
      expect(written.approvalId).toBe(APPROVAL_ID);
      expect(written.refusalReason).toBe("generation_superseded");
      expect(written.settlementJson).toBe(refusalEntry().settlementJson);
      // And nothing was dispatched, at any point.
      expect(admitStudioCall).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("retries an exhausted indeterminate write, then announces `indeterminate`", async () => {
    const events: string[] = [];
    const off = studioSettlementBus.subscribe((event) => {
      events.push(event.outcome);
    });
    try {
      getStudioSettlementByApprovalId.mockResolvedValue(
        unsettledRow({ executionStatus: "dispatching" }),
      );
      casMarkIndeterminateWithSettlementWith
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce(true);

      registerStudioWriteRepair(indeterminateEntry());
      await advancePasses(1);
      expect(events).toEqual([]);

      await advancePasses(1);
      expect(studioWriteRepairCount()).toBe(0);
      // `indeterminate`, never `settled` and never `rejected`: the dispatch may
      // have taken effect, and any other enum would invite a retry.
      expect(events).toEqual(["indeterminate"]);
      expect(admitStudioCall).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});

describe("the repair owner stops when somebody else owns the row", () => {
  it("stops on a CAS that matched zero rows, and never retries it", async () => {
    casRefuseStudioBeforeDispatchWith.mockResolvedValue(false);
    // The re-read after the lost CAS: a durable winner, terminal.
    getStudioSettlementByApprovalId
      .mockResolvedValueOnce(unsettledRow())
      .mockResolvedValue(
        unsettledRow({ executionStatus: "failed", refusalReason: "stopped" }),
      );

    const events: string[] = [];
    const off = studioSettlementBus.subscribe((e) => events.push(e.outcome));
    try {
      registerStudioWriteRepair(refusalEntry());
      await advancePasses(1);
      expect(studioWriteRepairCount()).toBe(0);
      expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledTimes(1);
      // The waiter is still released, from the winner's committed state.
      expect(events).toEqual(["rejected"]);

      // Many more ticks: the entry is gone, so the CAS is never attempted again.
      await advancePasses(5);
      expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("stops without writing at all when the row already reads terminal", async () => {
    getStudioSettlementByApprovalId.mockResolvedValue(
      unsettledRow({ executionStatus: "indeterminate" }),
    );
    const events: string[] = [];
    const off = studioSettlementBus.subscribe((e) => events.push(e.outcome));
    try {
      registerStudioWriteRepair(indeterminateEntry());
      await advancePasses(1);
      // NO write: a terminal row is somebody's committed answer and must not be
      // overwritten by a replayed body.
      expect(casMarkIndeterminateWithSettlementWith).not.toHaveBeenCalled();
      expect(studioWriteRepairCount()).toBe(0);
      expect(events).toEqual(["indeterminate"]);
    } finally {
      off();
    }
  });

  it("keeps the entry when the ROW READ throws, because that proves nothing", async () => {
    getStudioSettlementByApprovalId.mockRejectedValue(new Error("db down"));
    registerStudioWriteRepair(refusalEntry());
    await advancePasses(3);
    expect(casRefuseStudioBeforeDispatchWith).not.toHaveBeenCalled();
    expect(studioWriteRepairCount()).toBe(1);
  });
});

describe("the owner is single-flight and bounded", () => {
  it("leaves at most ONE pass in flight under a write that never settles", async () => {
    getStudioSettlementByApprovalId.mockResolvedValue(unsettledRow());
    // A write that hangs for ever, exactly like a wedged connection.
    casRefuseStudioBeforeDispatchWith.mockImplementation(
      () => new Promise<boolean>(() => {}),
    );

    registerStudioWriteRepair(refusalEntry());
    await advancePasses(10);

    // An interval would have stacked ten passes, each holding a connection, on
    // the very database that is already failing to answer.
    expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledTimes(1);
    expect(studioWriteRepairCount()).toBe(1);
  });

  it("drops a registration above the cap instead of growing without limit", async () => {
    for (let i = 0; i < STUDIO_REPAIR_CAP; i++) {
      registerStudioWriteRepair(refusalEntry(`approval-${String(i)}`));
    }
    expect(studioWriteRepairCount()).toBe(STUDIO_REPAIR_CAP);
    registerStudioWriteRepair(refusalEntry("one-too-many"));
    expect(studioWriteRepairCount()).toBe(STUDIO_REPAIR_CAP);
    // Re-registering an id already held is an UPDATE, never a new place.
    registerStudioWriteRepair(refusalEntry("approval-0"));
    expect(studioWriteRepairCount()).toBe(STUDIO_REPAIR_CAP);
  });

  it("disposal cancels the timer, drops the entries, and refuses new ones", async () => {
    registerStudioWriteRepair(refusalEntry());
    disposeStudioWriteRepair();
    expect(studioWriteRepairCount()).toBe(0);

    registerStudioWriteRepair(refusalEntry());
    expect(studioWriteRepairCount()).toBe(0);
    await advancePasses(5);
    // Nothing runs after teardown: no read, no write.
    expect(getStudioSettlementByApprovalId).not.toHaveBeenCalled();
    expect(casRefuseStudioBeforeDispatchWith).not.toHaveBeenCalled();

    // Idempotent.
    disposeStudioWriteRepair();
    expect(studioWriteRepairCount()).toBe(0);
  });
});
