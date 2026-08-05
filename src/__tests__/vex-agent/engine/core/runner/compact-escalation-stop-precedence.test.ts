/**
 * B3 END-TO-END: a terminal user stop outranks the critical-band escalation,
 * all the way through the finalizer.
 *
 * The helper-level test (`turn-loop-critical-fallback-terminal-safe.test.ts`)
 * proves the escalation's OWN write is a CAS. That is not sufficient on its
 * own and this file is the reason: the turn loop breaks with
 * `stopReason = "compact_unable_at_critical"` and `mission-run.ts` then calls
 * `finalizeMissionRunStatus`, which writes the run row AGAIN. Whichever write
 * is LAST decides what the row carries, so an unguarded finalizer write undoes
 * the helper's guard and re-opens a run the operator already stopped.
 *
 * So the assertion here is deliberately about STATE, not about which repo
 * function was called: a fake `mission_runs` row with real terminal-immutable
 * semantics is threaded through BOTH real modules in the same order the
 * runtime uses, and it must still read `stopped` / `user_stopped` at the end.
 * A future refactor that moves the write, adds a third one, or swaps the CAS
 * back for the unconditional writer fails here regardless of shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Minimal stand-in for the one row both modules write. */
interface FakeRunRow {
  status: string;
  stopReason: string | null;
}

const TERMINAL = new Set(["completed", "failed", "stopped", "cancelled"]);

const runRow: FakeRunRow = { status: "running", stopReason: null };

const mockUpdateStatus = vi.fn(
  async (_id: string, status: string, stopReason?: string) => {
    // Unconditional, exactly like the repo: this is how a run legitimately
    // REACHES a terminal state, and also how a careless park write re-opens one.
    runRow.status = status;
    runRow.stopReason = stopReason ?? runRow.stopReason;
  },
);
const mockUpdateStatusIfNotTerminal = vi.fn(
  async (_id: string, status: string, stopReason?: string) => {
    // The repo's CAS lives in the WHERE clause; this models the same refusal.
    if (TERMINAL.has(runRow.status)) return false;
    runRow.status = status;
    runRow.stopReason = stopReason ?? runRow.stopReason;
    return true;
  },
);

const mockApplyStopForEditTransaction = vi.fn();
// `mission-finalize.ts` now reaches the runtime control plane for two things:
// the ONE atomic stop-for-edit transition, and the durable operator-Stop
// consumer that guards the `compact_unable_at_critical` park. Both are stubbed
// to "no stop raced us" here; their own behaviour is covered by
// `runtime/apply-user-stop.test.ts`, the stop-for-edit integration file and
// `runner/paused-error-stop-consumer.test.ts`.
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  applyStopForEditTransaction: (...a: unknown[]) =>
    mockApplyStopForEditTransaction(...a),
  gateOnOperatorStopWithClient: async () => ({ kind: "clear" }),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: [string, string, string?]) => mockUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: [string, string, string?]) =>
    mockUpdateStatusIfNotTerminal(...a),
}));

const mockMissionsSetStatus = vi.fn();
vi.mock("@vex-agent/db/repos/missions.js", () => ({
  setStatus: (...a: unknown[]) => mockMissionsSetStatus(...a),
  clearApprovedAt: vi.fn(),
}));

/**
 * The operator Stop lands INSIDE this await — that is the whole race. The
 * iteration-entry guards ran before it, so neither module can see the stop
 * coming; only the row state proves what happened.
 */
const mockMaybeRunForcedCompactFallback = vi.fn(async () => {
  runRow.status = "stopped";
  runRow.stopReason = "user_stopped";
  return { kind: "noop" as const, reason: "no_compactable" };
});
vi.mock("@vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: () => mockMaybeRunForcedCompactFallback(),
}));

vi.mock("@vex-agent/engine/core/turn-loop-bug-emit.js", () => ({
  emitCompactUnableAtCriticalBug: vi.fn(),
}));

vi.mock("../../../../../vex-agent/engine/core/runner/abort.js", () => ({
  consumeMissionRunAbortIntent: vi.fn().mockReturnValue(null),
}));

vi.mock(
  "../../../../../vex-agent/engine/core/runner/runtime-continuation.js",
  () => ({
    isContinuableRuntimeStop: vi.fn().mockReturnValue(false),
    scheduleRuntimeContinuation: vi.fn(),
  }),
);

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { tryCriticalBandFallback, COMPACT_MAX_CONSECUTIVE_NOOPS } = await import(
  "@vex-agent/engine/core/turn-loop-critical-fallback.js"
);
const { finalizeMissionRunStatus } = await import(
  "../../../../../vex-agent/engine/core/runner/mission-finalize.js"
);

const MISSION_ID = "mission-1";
const RUN_ID = "run-1";
const SESSION_ID = "s1";

beforeEach(() => {
  vi.clearAllMocks();
  runRow.status = "running";
  runRow.stopReason = null;
  mockMaybeRunForcedCompactFallback.mockImplementation(async () => {
    runRow.status = "stopped";
    runRow.stopReason = "user_stopped";
    return { kind: "noop" as const, reason: "no_compactable" };
  });
});

/** The exact wiring `turn-loop.ts` + `mission-run.ts` perform, in order. */
async function escalateAndFinalize(): Promise<string> {
  const outcome = await tryCriticalBandFallback({
    sessionId: SESSION_ID,
    missionRunId: RUN_ID,
    turnBand: "critical",
    sessionPermission: "restricted" as const,
    skipCriticalCheckNextIter: false,
    criticalNoopCounter: COMPACT_MAX_CONSECUTIVE_NOOPS - 1,
    currentTokenCount: 120_000,
    contextLimit: 128_000,
  });
  if (outcome.kind !== "escalated") throw new Error("expected escalation");
  return finalizeMissionRunStatus(
    MISSION_ID,
    RUN_ID,
    SESSION_ID,
    outcome.stopReason,
  );
}

describe("critical-band escalation vs a concurrent operator Stop", () => {
  it("cannot re-open a run stopped during the forced compaction", async () => {
    await escalateAndFinalize();

    // The canonical user-stop terminal pair, untouched by either write.
    expect(runRow.status).toBe("stopped");
    expect(runRow.stopReason).toBe("user_stopped");
  });

  it("never reaches for the unconditional writer on this path", async () => {
    await escalateAndFinalize();

    // Both writes in the chain are park/recovery writes; neither may use the
    // writer reserved for moving a run TO a terminal state.
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockUpdateStatusIfNotTerminal).toHaveBeenCalled();
  });

  it("leaves the mission row to the stop transaction that owns it", async () => {
    await escalateAndFinalize();

    expect(mockMissionsSetStatus).not.toHaveBeenCalled();
  });

  it("still parks the run when NO stop raced it", async () => {
    // Control case — the guard must not turn the escalation into a no-op.
    mockMaybeRunForcedCompactFallback.mockResolvedValue({
      kind: "noop" as const,
      reason: "no_compactable",
    });

    const missionStatus = await escalateAndFinalize();

    expect(runRow.status).toBe("paused_error");
    expect(runRow.stopReason).toBe("compact_unable_at_critical");
    expect(missionStatus).toBe("running");
  });
});
