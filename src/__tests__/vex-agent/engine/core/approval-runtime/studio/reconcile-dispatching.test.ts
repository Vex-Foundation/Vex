/**
 * The ABANDONED-DISPATCH reconciler.
 *
 * The defect it closes: a Studio row marked `dispatching` whose writer died has
 * NO owner. The agent lifecycle scans exclude Studio rows and the expiry sweep
 * only looks at undecided ones, so before this reconciler existed such a row
 * stayed `dispatching` forever and its blocked caller was never told anything.
 *
 * The properties pinned here:
 *
 *   - every abandoned row becomes `indeterminate`, never `failed`: the dispatch
 *     may have run and an approved money-path call is never re-run to find out;
 *   - the write COMMITS before the announcement, because a subscriber reads the
 *     row by id on that signal;
 *   - one row that cannot be written does not stop the rest;
 *   - the scan is BOUNDED and PAGED, and it moves FORWARD: this reconciler
 *     writes the rows it reads, so a `LIMIT`-only loop would hand an unwritable
 *     row back for ever.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const listDispatchingStudioApprovals = vi.fn();
const listUnstartedStudioApprovals = vi.fn();
const casMarkIndeterminateWithSettlementWith = vi.fn();
const casRefuseStudioBeforeDispatchWith = vi.fn();

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  listDispatchingStudioApprovals,
  listUnstartedStudioApprovals,
  casMarkIndeterminateWithSettlementWith,
  casRefuseStudioBeforeDispatchWith,
}));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
}));

const {
  reconcileAbandonedStudioDispatches,
  announceStudioReconciliations,
  reconcileUnstartedStudioApprovals,
  announceStudioUnstartedRefusals,
} = await import(
  "@vex-agent/engine/core/approval-runtime/studio/reconcile-dispatching.js"
);
const { studioSettlementBus } = await import(
  "@vex-agent/engine/runtime/studio-settlement-bus.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  casMarkIndeterminateWithSettlementWith.mockResolvedValue(true);
  casRefuseStudioBeforeDispatchWith.mockResolvedValue(true);
  listUnstartedStudioApprovals.mockResolvedValue([]);
  listDispatchingStudioApprovals.mockResolvedValue([]);
});

describe("reconcileAbandonedStudioDispatches", () => {
  it("marks every abandoned row `indeterminate`, with the sentence that says why", async () => {
    listDispatchingStudioApprovals.mockResolvedValue([
      { approvalId: "a-1", projectId: "p-1" },
      { approvalId: "a-2", projectId: null },
    ]);
    const reconciled = await reconcileAbandonedStudioDispatches();
    expect(reconciled).toEqual([
      { approvalId: "a-1", projectId: "p-1" },
      { approvalId: "a-2", projectId: null },
    ]);
    const written = casMarkIndeterminateWithSettlementWith.mock.calls[0]?.[1] as {
      settlementJson: string;
      settlementBytes: number;
      resultHash: string | null;
    };
    const body = JSON.parse(written.settlementJson) as {
      result: { success: boolean; output: string };
    };
    expect(body.result.success).toBe(false);
    expect(body.result.output).toMatch(/cannot prove whether it took effect/i);
    expect(body.result.output).toMatch(/NOT retried/i);
    expect(written.settlementBytes).toBe(
      Buffer.byteLength(written.settlementJson, "utf8"),
    );
  });

  it("does nothing at all when no row was left dispatching", async () => {
    listDispatchingStudioApprovals.mockResolvedValue([]);
    expect(await reconcileAbandonedStudioDispatches()).toEqual([]);
    expect(casMarkIndeterminateWithSettlementWith).not.toHaveBeenCalled();
  });

  it("reports only the rows it actually flipped", async () => {
    // A `false` CAS means the row left `dispatching` underneath this pass - a
    // live dispatcher settled it. Announcing it would be a second answer.
    listDispatchingStudioApprovals.mockResolvedValue([
      { approvalId: "a-1", projectId: "p-1" },
      { approvalId: "a-2", projectId: "p-1" },
    ]);
    casMarkIndeterminateWithSettlementWith.mockImplementation(
      async (_client: unknown, input: { approvalId: string }) =>
        input.approvalId === "a-2",
    );
    expect(await reconcileAbandonedStudioDispatches()).toEqual([
      { approvalId: "a-2", projectId: "p-1" },
    ]);
  });

  it("keeps going when one row cannot be written", async () => {
    listDispatchingStudioApprovals.mockResolvedValue([
      { approvalId: "a-1", projectId: "p-1" },
      { approvalId: "a-2", projectId: "p-1" },
    ]);
    casMarkIndeterminateWithSettlementWith.mockImplementation(
      async (_client: unknown, input: { approvalId: string }) => {
        if (input.approvalId === "a-1") throw new Error("db down");
        return true;
      },
    );
    expect(await reconcileAbandonedStudioDispatches()).toEqual([
      { approvalId: "a-2", projectId: "p-1" },
    ]);
  });
});

describe("the scan is paged", () => {
  /** One page-sized batch of rows, each carrying its keyset cursor. */
  function page(from: number, count: number) {
    return Array.from({ length: count }, (_, i) => {
      const n = from + i;
      return {
        approvalId: `a-${String(n)}`,
        projectId: "p-1",
        cursor: {
          createdAt: new Date(1_700_000_000_000 + n).toISOString(),
          approvalId: `a-${String(n)}`,
        },
      };
    });
  }

  it("reconciles EVERY candidate when there are more than one batch holds", async () => {
    const pageSize = 200;
    listDispatchingStudioApprovals.mockImplementation(
      async (input: { limit: number; after: { approvalId: string } | null }) => {
        expect(input.limit).toBe(pageSize);
        if (input.after === null || input.after === undefined) {
          return page(0, pageSize);
        }
        if (input.after.approvalId === `a-${String(pageSize - 1)}`) {
          return page(pageSize, 30);
        }
        return [];
      },
    );
    const reconciled = await reconcileAbandonedStudioDispatches();
    // Nothing dropped at the page boundary, and nothing counted twice.
    expect(reconciled).toHaveLength(pageSize + 30);
    expect(reconciled[0]?.approvalId).toBe("a-0");
    expect(reconciled.at(-1)?.approvalId).toBe(`a-${String(pageSize + 29)}`);
    expect(new Set(reconciled.map((r) => r.approvalId)).size).toBe(pageSize + 30);
    // The second page was requested with the cursor of the last row of the
    // first, never from the top: a re-query from the top would loop for ever on
    // a row this pass could not write.
    const second = listDispatchingStudioApprovals.mock.calls[1]?.[0] as {
      after: { approvalId: string };
    };
    expect(second.after.approvalId).toBe(`a-${String(pageSize - 1)}`);
  });

  it("advances past a row it could not write instead of re-reading it", async () => {
    const pageSize = 200;
    listDispatchingStudioApprovals.mockImplementation(
      async (input: { after: { approvalId: string } | null }) =>
        input.after === null || input.after === undefined
          ? page(0, pageSize)
          : [],
    );
    casMarkIndeterminateWithSettlementWith.mockImplementation(
      async (_client: unknown, input: { approvalId: string }) => {
        if (input.approvalId === "a-0") throw new Error("db down");
        return true;
      },
    );
    const reconciled = await reconcileAbandonedStudioDispatches();
    expect(reconciled).toHaveLength(pageSize - 1);
    expect(reconciled.some((r) => r.approvalId === "a-0")).toBe(false);
    // Two reads total: the full page, then the one that comes back empty.
    expect(listDispatchingStudioApprovals).toHaveBeenCalledTimes(2);
  });
});

describe("announceStudioReconciliations", () => {
  it("emits `indeterminate` per reconciled row, and nothing for an empty pass", () => {
    const listener = vi.fn();
    const off = studioSettlementBus.subscribe(listener);
    try {
      announceStudioReconciliations([]);
      expect(listener).not.toHaveBeenCalled();
      announceStudioReconciliations([{ approvalId: "a-1", projectId: "p-1" }]);
    } finally {
      off();
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      approvalId: "a-1",
      projectId: "p-1",
      // NOT `dispatch_failed`: the call may have taken effect.
      outcome: "indeterminate",
    });
  });
});

describe("reconcileUnstartedStudioApprovals", () => {
  /**
   * The second half of the same premise, and the more dangerous half.
   * `dispatching` means an action MAY have run; `not_started` means it has NOT
   * run and STILL CAN - it is exactly the state `casClaimStudioDispatchSlotWith`
   * accepts. Before this pass existed, an approved row left behind by a dead
   * process, or by a terminal refusal write that failed, stayed dispatchable
   * for ever: nothing else reaches it, because the expiry sweep scans
   * `decision IS NULL` only and the agent lifecycle scans exclude Studio rows.
   */
  it("terminally refuses every approved row that never started", async () => {
    listUnstartedStudioApprovals.mockResolvedValue([
      { approvalId: "a-1", projectId: "p-1", cursor: { createdAt: "t1", approvalId: "a-1" } },
      { approvalId: "a-2", projectId: null, cursor: { createdAt: "t2", approvalId: "a-2" } },
    ]);

    const refused = await reconcileUnstartedStudioApprovals();
    expect(refused).toEqual([
      { approvalId: "a-1", projectId: "p-1" },
      { approvalId: "a-2", projectId: null },
    ]);

    // Through the SAME pre-dispatch CAS every other refusal uses, so it cannot
    // overwrite a row a live dispatcher has already claimed.
    expect(casRefuseStudioBeforeDispatchWith).toHaveBeenCalledTimes(2);
    const written = casRefuseStudioBeforeDispatchWith.mock.calls[0]?.[1] as {
      approvalId: string;
      refusalReason: string;
      settlementJson: string;
      settlementBytes: number;
    };
    expect(written.approvalId).toBe("a-1");
    expect(written.refusalReason).toBe("stopped");
    const body = JSON.parse(written.settlementJson) as {
      result: { success: boolean; output: string };
    };
    expect(body.result.success).toBe(false);
    expect(body.result.output).toMatch(/restarted/i);
    expect(body.result.output).toMatch(/Nothing was executed/i);
    expect(written.settlementBytes).toBe(
      Buffer.byteLength(written.settlementJson, "utf8"),
    );
    // NOT `indeterminate`: nothing ran, so there is no unknown effect to warn
    // about, and saying so would send the user checking for a transaction that
    // never existed.
    expect(casMarkIndeterminateWithSettlementWith).not.toHaveBeenCalled();
  });

  it("reports only the rows it actually flipped", async () => {
    listUnstartedStudioApprovals.mockResolvedValue([
      { approvalId: "a-1", projectId: "p-1", cursor: { createdAt: "t1", approvalId: "a-1" } },
      { approvalId: "a-2", projectId: "p-2", cursor: { createdAt: "t2", approvalId: "a-2" } },
    ]);
    // The second row was claimed by somebody else between the read and the CAS.
    casRefuseStudioBeforeDispatchWith
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await reconcileUnstartedStudioApprovals()).toEqual([
      { approvalId: "a-1", projectId: "p-1" },
    ]);
  });

  it("lets one unwritable row not stop the rest, and pages forward past it", async () => {
    const page = (n: number) =>
      Array.from({ length: 200 }, (_, i) => ({
        approvalId: `p${String(n)}-${String(i)}`,
        projectId: null,
        cursor: { createdAt: `t${String(n)}-${String(i)}`, approvalId: `p${String(n)}-${String(i)}` },
      }));
    listUnstartedStudioApprovals
      .mockResolvedValueOnce(page(1))
      .mockResolvedValueOnce([]);
    casRefuseStudioBeforeDispatchWith.mockRejectedValueOnce(new Error("db blip"));

    const refused = await reconcileUnstartedStudioApprovals();
    expect(refused).toHaveLength(199);
    // The cursor moved PAST the unwritable row: a `LIMIT`-only loop would hand
    // it back for ever, because this reconciler writes the rows it reads.
    const second = listUnstartedStudioApprovals.mock.calls[1]?.[0] as {
      after: { approvalId: string };
    };
    expect(second.after.approvalId).toBe("p1-199");
  });

  it("announces `rejected`, never `indeterminate`, and only after the writes", async () => {
    const events: Array<{ approvalId: string; outcome: string }> = [];
    const off = studioSettlementBus.subscribe((e) => {
      events.push({ approvalId: e.approvalId, outcome: e.outcome });
    });
    try {
      listUnstartedStudioApprovals.mockResolvedValue([
        { approvalId: "a-1", projectId: "p-1", cursor: { createdAt: "t1", approvalId: "a-1" } },
      ]);
      const refused = await reconcileUnstartedStudioApprovals();
      // Nothing is emitted by the reconciler itself: announcing is a separate
      // call precisely so it cannot happen before the write commits.
      expect(events).toEqual([]);
      announceStudioUnstartedRefusals(refused);
      expect(events).toEqual([{ approvalId: "a-1", outcome: "rejected" }]);
    } finally {
      off();
    }
  });

  it("touches no agent row: the scan is the repo's, and it is studio-only", async () => {
    // The predicate lives in SQL (`origin = 'studio_mcp' AND decision =
    // 'approved' AND execution_status = 'not_started'`), so what is pinned here
    // is that this reconciler adds no second reader of its own.
    listUnstartedStudioApprovals.mockResolvedValue([]);
    await reconcileUnstartedStudioApprovals();
    expect(listUnstartedStudioApprovals).toHaveBeenCalledTimes(1);
    expect(casRefuseStudioBeforeDispatchWith).not.toHaveBeenCalled();
    expect(casMarkIndeterminateWithSettlementWith).not.toHaveBeenCalled();
  });
});
