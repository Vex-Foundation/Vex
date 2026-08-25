/**
 * The Vex Studio approval BROKER.
 *
 * Everything here is about a blocked MCP call getting exactly one honest
 * answer:
 *
 *   - exactly-once release, whichever of the four producers fires first;
 *   - a lost waiter leaves the durable row alone (nothing here writes);
 *   - the expiry timer goes through the engine's decision path and lets the
 *     COMMITTED row release the waiter, rather than releasing on a guess;
 *   - withdrawal REFUSES FIRST and RELEASES SECOND, and reports whether the
 *     refusal actually committed;
 *   - the cap refuses by name instead of parking an unbounded number of
 *     waiting agents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { StudioSettlementRow } from "@vex-agent/db/repos/approval-intents.js";
import type { StudioWithdrawalReason } from "../approval-broker.js";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  awaitStudioSettlement,
  configureStudioApprovalBroker,
  disposeStudioApprovalBroker,
  reserveStudioWaiterSlot,
  settleStudioWaiter,
  studioReservationCount,
  withdrawStudioWaiter,
  studioWaiterCount,
  STUDIO_WAITER_CAP,
  STUDIO_DURABLE_RECHECK_INTERVAL_MS,
} = await import("../approval-broker.js");

const refuseIntent =
  vi.fn<(id: string, reason: StudioWithdrawalReason) => Promise<boolean>>();
const expireIntent = vi.fn<(id: string) => Promise<void>>();
const readSettlement =
  vi.fn<(id: string) => Promise<StudioSettlementRow | null>>();

function settlementRow(approvalId: string): StudioSettlementRow {
  return {
    approvalId,
    projectId: "project-1",
    decision: "approved",
    decisionReason: null,
    refusalReason: null,
    executionStatus: "succeeded",
    settlement: { v: 1, result: { success: true, output: "done" } },
    settlementBytes: 40,
    expiresAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  refuseIntent.mockResolvedValue(true);
  expireIntent.mockResolvedValue(undefined);
  // The default: nothing is settled yet, so the probe finds nothing and every
  // release below comes from the producer under test.
  readSettlement.mockResolvedValue(null);
  configureStudioApprovalBroker({ refuseIntent, expireIntent, readSettlement });
});

afterEach(() => {
  disposeStudioApprovalBroker();
  vi.useRealTimers();
});

describe("release", () => {
  it("hands the COMMITTED row to the waiter exactly once", async () => {
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await Promise.resolve();
    settleStudioWaiter(settlementRow("a-1"));
    // A second settlement for the same id is a no-op, not a second answer.
    settleStudioWaiter(settlementRow("a-1"));
    const outcome = await waiting;
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.row.executionStatus).toBe("succeeded");
    expect(studioWaiterCount()).toBe(0);
  });

  it("is a silent no-op when nobody is waiting", () => {
    // The common case: a human decided from the Vex UI with no MCP call open.
    expect(() => settleStudioWaiter(settlementRow("nobody"))).not.toThrow();
    expect(studioWaiterCount()).toBe(0);
  });
});

describe("the expiry timer", () => {
  it("expires through the engine and lets the committed row release the waiter", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt,
    });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(expireIntent).toHaveBeenCalledWith("a-1");
    // Deliberately still blocked: `expireApproval` settles the ROW and the
    // settlement bridge releases the waiter from committed state.
    settleStudioWaiter({
      ...settlementRow("a-1"),
      decision: "rejected",
      decisionReason: "Approval expired",
      executionStatus: "not_started",
    });
    const outcome = await waiting;
    expect(outcome.kind).toBe("settled");
  });

  it("releases with an unconfirmed answer when the expiry itself fails", async () => {
    vi.useFakeTimers();
    expireIntent.mockRejectedValue(new Error("db down"));
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: new Date(Date.now() + 10).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(50);
    const outcome = await waiting;
    expect(outcome.kind).toBe("withdrawn");
    if (outcome.kind !== "withdrawn") return;
    // The caller is told the cancellation is NOT confirmed durable.
    expect(outcome.refusalCommitted).toBe(false);
  });
});

describe("progress", () => {
  it("ticks while the decision is outstanding and stops on release", async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
      onProgress,
      progressIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(350);
    expect(onProgress).toHaveBeenCalledTimes(3);
    settleStudioWaiter(settlementRow("a-1"));
    await waiting;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });
});

describe("withdrawal", () => {
  it("refuses durably BEFORE it releases the waiter", async () => {
    const order: string[] = [];
    refuseIntent.mockImplementation(async () => {
      order.push("refused");
      return true;
    });
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    }).then((outcome) => {
      order.push("released");
      return outcome;
    });
    await Promise.resolve();
    await withdrawStudioWaiter("a-1", "disconnect");
    const outcome = await waiting;
    // The ordering IS the safety property: a waiter released before its intent
    // is terminal leaves an approvable row behind a caller already told no.
    expect(order).toEqual(["refused", "released"]);
    expect(outcome.kind).toBe("withdrawn");
    if (outcome.kind !== "withdrawn") return;
    expect(outcome.reason).toBe("disconnect");
    expect(outcome.refusalCommitted).toBe(true);
  });

  it("reports an unconfirmed refusal rather than claiming a clean cancel", async () => {
    refuseIntent.mockRejectedValue(new Error("db down"));
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await Promise.resolve();
    await withdrawStudioWaiter("a-1", "disconnect");
    const outcome = await waiting;
    expect(outcome.kind).toBe("withdrawn");
    if (outcome.kind !== "withdrawn") return;
    expect(outcome.refusalCommitted).toBe(false);
  });

  it("withdraws on an abort signal, refusing first", async () => {
    const controller = new AbortController();
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    const outcome = await waiting;
    expect(refuseIntent).toHaveBeenCalledWith("a-1", "cancelled");
    expect(outcome.kind).toBe("withdrawn");
  });

  it("does nothing for an approval nobody is waiting on", async () => {
    await withdrawStudioWaiter("unknown", "cancelled");
    expect(refuseIntent).not.toHaveBeenCalled();
  });

  /**
   * THE TYPED CANCELLATION CAUSE (stage A4a, spec item 2).
   *
   * Four teardown owners can abort one blocked call and they mean four
   * different things. The cause is asked of the OWNER, never taken from the
   * client's `notifications/cancelled` reason string, and it is what reaches
   * the durable `refusal_reason` - which is the only reason a later reader can
   * tell "the user locked Vex" apart from "the client hung up".
   */
  it.each(["lock", "vex_quit", "disconnect", "cancelled"] as const)(
    "records the teardown owner's typed cause %s in the durable refusal",
    async (cause) => {
      const controller = new AbortController();
      const waiting = awaitStudioSettlement({
        approvalId: "a-1",
        projectId: "project-1",
        expiresAt: null,
        signal: controller.signal,
        cancelCause: () => cause,
      });
      await Promise.resolve();
      controller.abort();
      const outcome = await waiting;
      expect(refuseIntent).toHaveBeenCalledWith("a-1", cause);
      expect(outcome.kind).toBe("withdrawn");
      if (outcome.kind !== "withdrawn") return;
      expect(outcome.reason).toBe(cause);
    },
  );

  it("defaults to `cancelled` when no cause channel was supplied", async () => {
    // Today's behaviour, pinned: a caller that does not name a cause gets the
    // honest machine fact for "the caller went away without saying why".
    const controller = new AbortController();
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();
    await waiting;
    expect(refuseIntent).toHaveBeenCalledWith("a-1", "cancelled");
  });

  it("treats a throwing cause callback as `cancelled` and still withdraws", async () => {
    // An exception escaping the abort listener would leave the waiter blocked
    // and its intent pending, which is the failure withdrawal exists to stop.
    const controller = new AbortController();
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
      signal: controller.signal,
      cancelCause: () => {
        throw new Error("teardown owner is gone");
      },
    });
    await Promise.resolve();
    controller.abort();
    const outcome = await waiting;
    expect(refuseIntent).toHaveBeenCalledWith("a-1", "cancelled");
    expect(outcome.kind).toBe("withdrawn");
  });

  it("withdraws with the cause an ALREADY-aborted signal names", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
      signal: controller.signal,
      cancelCause: () => "lock",
    });
    expect(refuseIntent).toHaveBeenCalledWith("a-1", "lock");
    expect(outcome.kind).toBe("withdrawn");
  });
});

describe("the cap", () => {
  it("refuses a new waiter above the cap, by name, without touching the intent", async () => {
    const open: Array<Promise<unknown>> = [];
    for (let i = 0; i < STUDIO_WAITER_CAP; i++) {
      open.push(
        awaitStudioSettlement({
          approvalId: `a-${String(i)}`,
          projectId: "project-1",
          expiresAt: null,
        }),
      );
    }
    await Promise.resolve();
    expect(studioWaiterCount()).toBe(STUDIO_WAITER_CAP);

    const refused = await awaitStudioSettlement({
      approvalId: "one-too-many",
      projectId: "project-1",
      expiresAt: null,
    });
    expect(refused.kind).toBe("at_capacity");
    if (refused.kind !== "at_capacity") return;
    // Actionable: it says what to do, and that the row is untouched.
    expect(refused.reason).toMatch(/Nothing was executed/i);
    expect(refused.reason).toMatch(/Decide the pending approvals/i);
    expect(refuseIntent).not.toHaveBeenCalled();

    disposeStudioApprovalBroker();
    await Promise.all(open);
  });
});

describe("dispose", () => {
  it("releases every open waiter and clears its timers", async () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      onProgress,
      progressIntervalMs: 100,
    });
    await Promise.resolve();
    disposeStudioApprovalBroker();
    const outcome = await waiting;
    expect(outcome.kind).toBe("broker_closed");
    expect(studioWaiterCount()).toBe(0);
    // The timers went with it: nothing fires after the quit.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onProgress).not.toHaveBeenCalled();
    expect(expireIntent).not.toHaveBeenCalled();
  });
});

describe("the lost-wakeup window", () => {
  it("releases a waiter whose settlement COMMITTED before it registered", async () => {
    // The settlement landed between the enqueue and the registration, so its
    // bus event reached nobody. Without the durable probe the call would block
    // until the transport gave up: the intent is approved, so its own expiry
    // cannot reject it either.
    const listener = vi.fn();
    readSettlement.mockResolvedValue(settlementRow("a-1"));
    const outcome = await awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
      onProgress: listener,
    });
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.row.executionStatus).toBe("succeeded");
    // No bus event was ever emitted for this waiter.
    expect(studioWaiterCount()).toBe(0);
  });

  it("releases on a row that is REFUSED rather than executed", async () => {
    readSettlement.mockResolvedValue({
      ...settlementRow("a-1"),
      decision: "rejected",
      refusalReason: "lock",
      executionStatus: "not_started",
      settlement: null,
    });
    const outcome = await awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    expect(outcome.kind).toBe("settled");
  });

  it("keeps waiting when the row is still undecided", async () => {
    readSettlement.mockResolvedValue({
      ...settlementRow("a-1"),
      decision: null,
      executionStatus: "not_started",
      settlement: null,
    });
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(studioWaiterCount()).toBe(1);
    settleStudioWaiter(settlementRow("a-1"));
    expect((await waiting).kind).toBe("settled");
  });

  it("still waits when the probe itself fails", async () => {
    // A failed read costs an EARLY answer, never correctness: the expiry timer
    // and the scheduled sweep are still under the call.
    readSettlement.mockRejectedValue(new Error("db down"));
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    settleStudioWaiter(settlementRow("a-1"));
    expect((await waiting).kind).toBe("settled");
  });
});

describe("only a TERMINAL row may answer a blocked call", () => {
  // The approval COMMITS BEFORE THE DISPATCH. A probe that treats "a decision
  // exists" as terminal therefore observes a legitimate mid-flight row and
  // would answer the external agent "nothing happened" while the approved
  // action is still on its way.
  const nonTerminal: ReadonlyArray<[string, Partial<StudioSettlementRow>]> = [
    ["approved/not_started", { decision: "approved", executionStatus: "not_started" }],
    ["approved/dispatching", { decision: "approved", executionStatus: "dispatching" }],
    ["undecided", { decision: null, executionStatus: "not_started" }],
  ];

  for (const [label, patch] of nonTerminal) {
    it(`does NOT release the waiter on ${label}`, async () => {
      readSettlement.mockResolvedValue({
        ...settlementRow("a-1"),
        settlement: null,
        ...patch,
      });
      const waiting = awaitStudioSettlement({
        approvalId: "a-1",
        projectId: "project-1",
        expiresAt: null,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(studioWaiterCount()).toBe(1);
      // The terminal event that follows is the one that may answer.
      settleStudioWaiter(settlementRow("a-1"));
      expect((await waiting).kind).toBe("settled");
    });

    it(`ignores a non-terminal announce for ${label}`, async () => {
      const waiting = awaitStudioSettlement({
        approvalId: "a-1",
        projectId: "project-1",
        expiresAt: null,
      });
      await Promise.resolve();
      await Promise.resolve();
      settleStudioWaiter({
        ...settlementRow("a-1"),
        settlement: null,
        ...patch,
      } as StudioSettlementRow);
      // Still blocked: nothing terminal has committed.
      expect(studioWaiterCount()).toBe(1);
      settleStudioWaiter(settlementRow("a-1"));
      const outcome = await waiting;
      expect(outcome.kind).toBe("settled");
      if (outcome.kind !== "settled") return;
      expect(outcome.row.executionStatus).toBe("succeeded");
    });
  }

  const terminal: ReadonlyArray<[string, Partial<StudioSettlementRow>]> = [
    // A rejection never dispatches, whatever its execution status says.
    ["rejected/not_started", { decision: "rejected", executionStatus: "not_started" }],
    ["approved/succeeded", { decision: "approved", executionStatus: "succeeded" }],
    ["approved/failed", { decision: "approved", executionStatus: "failed" }],
    ["approved/indeterminate", { decision: "approved", executionStatus: "indeterminate" }],
  ];
  for (const [label, patch] of terminal) {
    it(`releases on ${label}`, async () => {
      readSettlement.mockResolvedValue({ ...settlementRow("a-1"), ...patch });
      const outcome = await awaitStudioSettlement({
        approvalId: "a-1",
        projectId: "project-1",
        expiresAt: null,
      });
      expect(outcome.kind).toBe("settled");
      expect(studioWaiterCount()).toBe(0);
    });
  }
});

describe("the periodic durable read is the floor", () => {
  it("releases a waiter whose first probe FAILED and whose bus event never came", async () => {
    // An APPROVED row is past the expiry sweep for good (the sweep scans
    // UNDECIDED rows only), so without this timer a lost event plus a failed
    // read would block the call until its transport gave up.
    vi.useFakeTimers();
    readSettlement.mockRejectedValueOnce(new Error("db down"));
    readSettlement.mockResolvedValue(settlementRow("a-1"));
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(studioWaiterCount()).toBe(1);
    // No settleStudioWaiter call anywhere in this test: the timer is the only
    // producer.
    await vi.advanceTimersByTimeAsync(STUDIO_DURABLE_RECHECK_INTERVAL_MS + 10);
    const outcome = await waiting;
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.row.executionStatus).toBe("succeeded");
    expect(studioWaiterCount()).toBe(0);
  });

  it("keeps re-reading a row that is still mid-flight, and stops on release", async () => {
    vi.useFakeTimers();
    readSettlement.mockResolvedValue({
      ...settlementRow("a-1"),
      executionStatus: "dispatching",
      settlement: null,
    });
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await vi.advanceTimersByTimeAsync(STUDIO_DURABLE_RECHECK_INTERVAL_MS * 3 + 10);
    expect(studioWaiterCount()).toBe(1);
    const readsWhileBlocked = readSettlement.mock.calls.length;
    expect(readsWhileBlocked).toBeGreaterThanOrEqual(4);
    settleStudioWaiter(settlementRow("a-1"));
    expect((await waiting).kind).toBe("settled");
    // The timer went with the waiter: no read outlives the call it served.
    await vi.advanceTimersByTimeAsync(STUDIO_DURABLE_RECHECK_INTERVAL_MS * 3);
    expect(readSettlement.mock.calls.length).toBe(readsWhileBlocked);
  });
});

describe("the periodic durable read is SINGLE-FLIGHT", () => {
  /**
   * The read used to run on a `setInterval`. Under a database that is slow or
   * wedged - precisely the condition the read exists to survive - each tick
   * started ANOTHER read on top of every hung one, so one blocked waiter could
   * hold an unbounded and growing number of connections against the database
   * that was already failing to answer.
   *
   * The schedule is now a gap, not a period: the next read is armed only once
   * the previous one has SETTLED.
   */
  it("leaves at most ONE outstanding read under a read that never resolves", async () => {
    vi.useFakeTimers();
    // A read that hangs for ever.
    readSettlement.mockImplementation(
      () => new Promise<StudioSettlementRow | null>(() => {}),
    );
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(readSettlement).toHaveBeenCalledTimes(1);

    // Ten cadences pass. An interval would have started ten more reads.
    await vi.advanceTimersByTimeAsync(STUDIO_DURABLE_RECHECK_INTERVAL_MS * 10);
    expect(readSettlement).toHaveBeenCalledTimes(1);
    expect(studioWaiterCount()).toBe(1);

    // And the waiter is still releasable through every other producer.
    settleStudioWaiter(settlementRow("a-1"));
    expect((await waiting).kind).toBe("settled");
  });

  it("arms the next read only AFTER a slow read settles", async () => {
    vi.useFakeTimers();
    // A holder rather than a bare `let`: the assignment happens inside a
    // callback, which TypeScript cannot see, so a plain binding would narrow to
    // `null` at the call site below.
    const slowRead: {
      release: ((row: StudioSettlementRow | null) => void) | null;
    } = { release: null };
    readSettlement.mockImplementationOnce(
      () =>
        new Promise<StudioSettlementRow | null>((resolve) => {
          slowRead.release = resolve;
        }),
    );
    readSettlement.mockResolvedValue(null);
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(readSettlement).toHaveBeenCalledTimes(1);

    // The cadence elapses while the FIRST read is still outstanding: no second
    // read, because nothing has been armed yet.
    await vi.advanceTimersByTimeAsync(STUDIO_DURABLE_RECHECK_INTERVAL_MS * 2);
    expect(readSettlement).toHaveBeenCalledTimes(1);

    // The slow read finally answers. Only now does the cycle resume.
    slowRead.release?.(null);
    await vi.advanceTimersByTimeAsync(STUDIO_DURABLE_RECHECK_INTERVAL_MS + 10);
    expect(readSettlement).toHaveBeenCalledTimes(2);

    settleStudioWaiter(settlementRow("a-1"));
    expect((await waiting).kind).toBe("settled");
  });

  it("disposal cancels the outstanding recheck timer", async () => {
    vi.useFakeTimers();
    readSettlement.mockResolvedValue(null);
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
    });
    await vi.advanceTimersByTimeAsync(1);
    const before = readSettlement.mock.calls.length;
    disposeStudioApprovalBroker();
    expect((await waiting).kind).toBe("broker_closed");
    await vi.advanceTimersByTimeAsync(STUDIO_DURABLE_RECHECK_INTERVAL_MS * 5);
    // No read outlives the broker that owned it.
    expect(readSettlement.mock.calls.length).toBe(before);
  });
});

describe("the reservation", () => {
  it("counts against the cap before any waiter registers", () => {
    const claimed: Array<{ release: () => void }> = [];
    for (let i = 0; i < STUDIO_WAITER_CAP; i++) {
      const reserved = reserveStudioWaiterSlot();
      expect(reserved.ok).toBe(true);
      if (reserved.ok) claimed.push(reserved.reservation);
    }
    expect(studioReservationCount()).toBe(STUDIO_WAITER_CAP);
    const refused = reserveStudioWaiterSlot();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/Nothing was executed/i);
    expect(refused.reason).toMatch(/Decide the pending approvals/i);

    // Releasing one frees exactly one place, and a second release is a no-op.
    claimed[0]?.release();
    claimed[0]?.release();
    expect(studioReservationCount()).toBe(STUDIO_WAITER_CAP - 1);
    const afterRelease = reserveStudioWaiterSlot();
    expect(afterRelease.ok).toBe(true);
    for (const reservation of claimed) reservation.release();
    if (afterRelease.ok) afterRelease.reservation.release();
    expect(studioReservationCount()).toBe(0);
  });

  it("becomes the registered waiter instead of counting twice", async () => {
    const reserved = reserveStudioWaiterSlot();
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const waiting = awaitStudioSettlement({
      approvalId: "a-1",
      projectId: "project-1",
      expiresAt: null,
      reservation: reserved.reservation,
    });
    await Promise.resolve();
    expect(studioWaiterCount()).toBe(1);
    expect(studioReservationCount()).toBe(0);
    settleStudioWaiter(settlementRow("a-1"));
    await waiting;
  });
});
