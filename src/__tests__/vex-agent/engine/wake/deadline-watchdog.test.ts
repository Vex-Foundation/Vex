/**
 * Deadline watchdog unit tests — the agent-INDEPENDENT hard-deadline path.
 *
 * The loop-boundary enforcer (turn-loop.ts) only fires while the turn loop is
 * iterating. A PARKED run never reaches that boundary, so its box is never
 * enforced until something resumes it (observed live: a 5-minute mission ran
 * 1h20m). These tests pin the sweep that closes that gap.
 *
 * Pure `sweepMissionDeadlines(now, deps)` with injected fakes — no DB, mirroring
 * the `wake/executor.ts` tick tests. Clock is an explicit `now` argument, so no
 * fake timers are needed here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  sweepMissionDeadlines,
  type DeadlineWatchdogDeps,
} from "../../../../vex-agent/engine/wake/deadline-watchdog.js";
import type { MissionRun } from "../../../../vex-agent/db/repos/mission-runs.js";
import type { MissionRunStatus } from "../../../../vex-agent/engine/types.js";
import { PAUSED_RUN_STATUSES } from "../../../../vex-agent/engine/types.js";

const START = "2026-07-19T10:00:00.000Z";
const START_MS = Date.parse(START);
/** 5-minute box — the live-repro mission's duration. */
const BOX_MIN = 5;
const DEADLINE_MS = START_MS + BOX_MIN * 60_000;

function makeRun(overrides: Partial<MissionRun> = {}): MissionRun {
  return {
    id: "run-1",
    missionId: "mission-1",
    sessionId: "sess-1",
    status: "paused_error",
    startedAt: START,
    endedAt: null,
    lastCheckpointAt: null,
    stopReason: null,
    stopSummary: null,
    stopEvidenceJson: null,
    iterationCount: 3,
    contractSnapshotJson: {
      frozenMission: { draft: { durationMinutes: BOX_MIN } },
    },
    recoveredFromRunId: null,
    errorRetryCount: 0,
    autoRetryUnsafe: false,
    ...overrides,
  };
}

interface Harness {
  deps: DeadlineWatchdogDeps;
  casStopPastDeadline: ReturnType<typeof vi.fn>;
  rejectPendingApprovals: ReturnType<typeof vi.fn>;
  cancelPendingWakes: ReturnType<typeof vi.fn>;
  setMissionFailed: ReturnType<typeof vi.fn>;
  captureFinal: ReturnType<typeof vi.fn>;
  emitControlState: ReturnType<typeof vi.fn>;
  getLease: ReturnType<typeof vi.fn>;
  /** Rows the fake DB currently holds, keyed by run id (drives CAS idempotency). */
  statuses: Map<string, MissionRunStatus>;
}

function makeHarness(runs: MissionRun[]): Harness {
  const statuses = new Map<string, MissionRunStatus>(
    runs.map((r) => [r.id, r.status]),
  );

  // Fake CAS with the real contract: it only wins when the CURRENT status is in
  // `fromStatuses`, and flipping is a one-way move to terminal. A second sweep
  // (or a concurrent resume that already moved the row) therefore returns null.
  const casStopPastDeadline = vi.fn(
    async (runId: string, fromStatuses: readonly MissionRunStatus[]) => {
      const current = statuses.get(runId);
      if (current === undefined || !fromStatuses.includes(current)) return null;
      statuses.set(runId, "failed");
      return current;
    },
  );

  const rejectPendingApprovals = vi.fn(async () => 0);
  const cancelPendingWakes = vi.fn(async () => 0);
  const setMissionFailed = vi.fn(async () => undefined);
  const captureFinal = vi.fn(async () => undefined);
  const emitControlState = vi.fn(async () => undefined);
  const getLease = vi.fn(async () => null);

  const deps: DeadlineWatchdogDeps = {
    listCandidateRuns: async () =>
      runs.filter((r) => {
        const s = statuses.get(r.id)!;
        return s === "running" || PAUSED_RUN_STATUSES.has(s);
      }).map((r) => ({ ...r, status: statuses.get(r.id)! })),
    resolveDeadlineMs: (run) =>
      run.startedAt === "not-a-date" ? null : DEADLINE_MS,
    getLease: getLease as unknown as DeadlineWatchdogDeps["getLease"],
    casStopPastDeadline:
      casStopPastDeadline as unknown as DeadlineWatchdogDeps["casStopPastDeadline"],
    rejectPendingApprovals,
    cancelPendingWakes,
    setMissionFailed,
    captureFinal,
    emitControlState,
  };

  return {
    deps,
    casStopPastDeadline,
    rejectPendingApprovals,
    cancelPendingWakes,
    setMissionFailed,
    captureFinal,
    emitControlState,
    getLease,
    statuses,
  };
}

/** One second past the 5-minute box — the run is overdue. */
const PAST_DUE = new Date(DEADLINE_MS + 1_000);
/** One minute into the box — not yet due. */
const NOT_DUE = new Date(START_MS + 60_000);

describe("sweepMissionDeadlines — parked runs past the hard deadline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The core regression: EVERY parked arm must be enforced, not just the ones
  // a resume happens to touch. `paused_error` is the live-repro state.
  it.each(Array.from(PAUSED_RUN_STATUSES))(
    "stops a past-deadline run parked in %s with deadline_reached",
    async (parkedStatus) => {
      const h = makeHarness([makeRun({ status: parkedStatus })]);

      const outcomes = await sweepMissionDeadlines(PAST_DUE, h.deps);

      expect(outcomes).toEqual([
        { kind: "stopped", runId: "run-1", previousStatus: parkedStatus },
      ]);
      expect(h.casStopPastDeadline).toHaveBeenCalledTimes(1);
      const [runId, fromStatuses, payload] = h.casStopPastDeadline.mock.calls[0];
      expect(runId).toBe("run-1");
      // Claim from the parked set only — never from `running`, so the CAS can
      // never yank a row out from under a live loop.
      expect([...fromStatuses].sort()).toEqual(
        [...PAUSED_RUN_STATUSES].sort(),
      );
      expect(payload.stopReason).toBe("deadline_reached");
      expect(h.statuses.get("run-1")).toBe("failed");
    },
  );

  it("does not touch a parked run whose box has not expired yet", async () => {
    const h = makeHarness([makeRun({ status: "paused_wake" })]);

    const outcomes = await sweepMissionDeadlines(NOT_DUE, h.deps);

    expect(outcomes).toEqual([{ kind: "skipped_not_due", runId: "run-1" }]);
    expect(h.casStopPastDeadline).not.toHaveBeenCalled();
    expect(h.setMissionFailed).not.toHaveBeenCalled();
    expect(h.statuses.get("run-1")).toBe("paused_wake");
  });

  it("fails open when the run has no resolvable deadline", async () => {
    const h = makeHarness([makeRun({ startedAt: "not-a-date" })]);

    const outcomes = await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(outcomes).toEqual([{ kind: "skipped_no_deadline", runId: "run-1" }]);
    expect(h.casStopPastDeadline).not.toHaveBeenCalled();
  });
});

describe("sweepMissionDeadlines — running runs and lease liveness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips a past-deadline running run that still holds a LIVE lease", async () => {
    // A live loop enforces its own deadline at the turn boundary — the watchdog
    // must never race it.
    const h = makeHarness([makeRun({ status: "running" })]);
    h.getLease.mockResolvedValue({
      expiresAt: new Date(PAST_DUE.getTime() + 30_000),
    });

    const outcomes = await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(outcomes).toEqual([{ kind: "skipped_live_lease", runId: "run-1" }]);
    expect(h.casStopPastDeadline).not.toHaveBeenCalled();
    expect(h.statuses.get("run-1")).toBe("running");
  });

  it("stops a past-deadline GHOST run — status running, lease expired", async () => {
    const h = makeHarness([makeRun({ status: "running" })]);
    h.getLease.mockResolvedValue({
      expiresAt: new Date(PAST_DUE.getTime() - 30_000),
    });

    const outcomes = await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(outcomes).toEqual([
      { kind: "stopped", runId: "run-1", previousStatus: "running" },
    ]);
    const [, fromStatuses] = h.casStopPastDeadline.mock.calls[0];
    expect([...fromStatuses]).toEqual(["running"]);
    expect(h.statuses.get("run-1")).toBe("failed");
  });

  it("stops a past-deadline running run with NO lease row at all", async () => {
    const h = makeHarness([makeRun({ status: "running" })]);
    h.getLease.mockResolvedValue(null);

    const outcomes = await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(outcomes).toEqual([
      { kind: "stopped", runId: "run-1", previousStatus: "running" },
    ]);
  });
});

describe("sweepMissionDeadlines — idempotency and concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is idempotent — a second sweep does not double-stop the same run", async () => {
    const h = makeHarness([makeRun({ status: "paused_error" })]);

    const first = await sweepMissionDeadlines(PAST_DUE, h.deps);
    const second = await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(first).toEqual([
      { kind: "stopped", runId: "run-1", previousStatus: "paused_error" },
    ]);
    // The row is terminal now, so it is no longer a candidate at all.
    expect(second).toEqual([]);
    // Terminal side-effects fired exactly once.
    expect(h.setMissionFailed).toHaveBeenCalledTimes(1);
    expect(h.captureFinal).toHaveBeenCalledTimes(1);
    expect(h.emitControlState).toHaveBeenCalledTimes(1);
  });

  it("no-ops when a concurrent resume/loop-boundary stop won the CAS", async () => {
    const h = makeHarness([makeRun({ status: "paused_error" })]);
    // Simulate the row being claimed by another path between list and CAS.
    h.casStopPastDeadline.mockResolvedValueOnce(null);

    const outcomes = await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(outcomes).toEqual([
      { kind: "skipped_already_terminal", runId: "run-1" },
    ]);
    // CRITICAL: losing the CAS must skip ALL terminal side-effects, otherwise
    // the ledger/mission row would be written twice.
    expect(h.setMissionFailed).not.toHaveBeenCalled();
    expect(h.captureFinal).not.toHaveBeenCalled();
    expect(h.rejectPendingApprovals).not.toHaveBeenCalled();
    expect(h.cancelPendingWakes).not.toHaveBeenCalled();
  });

  it("isolates a per-run failure so one bad row cannot poison the batch", async () => {
    const h = makeHarness([
      makeRun({ id: "run-bad", status: "paused_error" }),
      makeRun({ id: "run-good", status: "paused_user" }),
    ]);
    h.casStopPastDeadline.mockImplementationOnce(async () => {
      throw new Error("db exploded");
    });

    const outcomes = await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(outcomes[0]).toEqual({
      kind: "error",
      runId: "run-bad",
      message: "db exploded",
    });
    expect(outcomes[1]).toEqual({
      kind: "stopped",
      runId: "run-good",
      previousStatus: "paused_user",
    });
  });
});

describe("sweepMissionDeadlines — stop side-effects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects pending approvals and cancels pending wakes so the run cannot be resurrected", async () => {
    // A swept `paused_approval` run leaves a pending approval_queue row; a swept
    // `paused_error` run may have an auto-retry wake queued (upstream 28de53f6).
    // Either would resume the now-terminal run.
    const h = makeHarness([makeRun({ status: "paused_approval" })]);
    h.rejectPendingApprovals.mockResolvedValue(2);
    h.cancelPendingWakes.mockResolvedValue(1);

    await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(h.rejectPendingApprovals).toHaveBeenCalledWith("sess-1");
    expect(h.cancelPendingWakes).toHaveBeenCalledWith("sess-1");
  });

  it("mirrors the loop-boundary terminal side-effects: mission failed + ledger close", async () => {
    const h = makeHarness([makeRun({ status: "paused_wake" })]);

    await sweepMissionDeadlines(PAST_DUE, h.deps);

    expect(h.setMissionFailed).toHaveBeenCalledWith("mission-1");
    expect(h.captureFinal).toHaveBeenCalledWith({
      missionId: "mission-1",
      runId: "run-1",
      sessionId: "sess-1",
      outcome: "failed",
      stopReason: "deadline_reached",
    });
    expect(h.emitControlState).toHaveBeenCalledWith("sess-1", "run-1");
  });

  it("SURFACES an open position rather than closing it — auto-flatten stays deferred", async () => {
    const h = makeHarness([makeRun({ status: "paused_error" })]);

    await sweepMissionDeadlines(PAST_DUE, h.deps);

    const payload = h.casStopPastDeadline.mock.calls[0][2];
    expect(payload.evidence).toMatchObject({
      enforcedWhileParked: true,
      parkedStatus: "paused_error",
      positionCloseDeferred: true,
    });
    // The operator-facing note must say the bag is still open.
    expect(payload.summary).toMatch(/open/i);
    // There is deliberately NO sell/close/liquidate dep on this surface.
    expect(Object.keys(h.deps)).not.toContain("closePositions");
  });
});
