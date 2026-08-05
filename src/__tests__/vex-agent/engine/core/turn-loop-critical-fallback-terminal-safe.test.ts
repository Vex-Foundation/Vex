/**
 * B3 regression: the critical-band escalation must not overwrite a terminal
 * run row.
 *
 * `maybeRunForcedCompactFallback` is an await that can span a whole forced
 * compaction. The loop's iteration-entry guards ran BEFORE it, so an operator
 * Stop that lands during it is invisible to this helper — and the escalation
 * that follows used to write `paused_error` unconditionally, replacing the
 * canonical `stopped` / `user_stopped` the stop path had just established and
 * re-opening a run whose approvals were already rejected and whose lease was
 * already released. A terminal run row is immutable audit history.
 *
 * The fix is the CAS variant (`updateStatusIfNotTerminal`), which holds under
 * concurrency because the guard is in the WHERE clause rather than a
 * read-then-write. These tests pin the CALL, the emit ORDER around it, and the
 * fact that a superseded write is surfaced rather than swallowed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMaybeRunForcedCompactFallback = vi.fn();
vi.mock("@vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: (...a: unknown[]) =>
    mockMaybeRunForcedCompactFallback(...a),
}));

const mockUpdateStatus = vi.fn();
const mockUpdateStatusIfNotTerminal = vi.fn();
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) =>
    mockUpdateStatusIfNotTerminal(...a),
}));

const mockEmitBug = vi.fn();
vi.mock("@vex-agent/engine/core/turn-loop-bug-emit.js", () => ({
  emitCompactUnableAtCriticalBug: (...a: unknown[]) => mockEmitBug(...a),
}));

const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    debug: vi.fn(),
  },
}));

// The escalation's status write now carries the durable operator-Stop consumer,
// so it reaches the runtime control plane. Stubbed to "no stop raced us" here;
// the consumer's own behaviour is pinned by
// `critical-fallback-stop-consumer.test.ts`.
const mockGateOnOperatorStop = vi.fn();
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
  withSessionControlLock: async <T>(
    _sessionId: string,
    fn: (client: unknown) => Promise<T>,
  ): Promise<T> => fn({}),
}));

const { tryCriticalBandFallback, COMPACT_MAX_CONSECUTIVE_NOOPS } = await import(
  "@vex-agent/engine/core/turn-loop-critical-fallback.js"
);

function escalatingArgs(missionRunId: string | null) {
  return {
    sessionId: "s1",
    missionRunId,
    turnBand: "critical" as const,
    sessionPermission: "restricted" as const,
    skipCriticalCheckNextIter: false,
    // One below the max, so this call is the escalating one.
    criticalNoopCounter: COMPACT_MAX_CONSECUTIVE_NOOPS - 1,
    currentTokenCount: 120_000,
    contextLimit: 128_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMaybeRunForcedCompactFallback.mockResolvedValue({
    kind: "noop",
    reason: "no_compactable",
  });
  mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
  mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
});

describe("tryCriticalBandFallback — terminal-safe escalation", () => {
  it("writes paused_error through the terminal-safe CAS, never the unconditional write", async () => {
    const outcome = await tryCriticalBandFallback(escalatingArgs("run-1"));

    expect(outcome.kind).toBe("escalated");
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockUpdateStatusIfNotTerminal).toHaveBeenCalledWith(
      "run-1",
      "paused_error",
      "compact_unable_at_critical",
      undefined,
      // Same client as the gate, so gate and park commit together.
      expect.anything(),
    );
  });

  it("a Stop that landed during the compaction survives the escalation", async () => {
    // The CAS refuses because the run row is already terminal — exactly what
    // `stopped` / `user_stopped` looks like from in here.
    mockUpdateStatusIfNotTerminal.mockResolvedValue(false);

    const outcome = await tryCriticalBandFallback(escalatingArgs("run-1"));

    // The loop still unwinds (the compaction genuinely failed), but the run
    // row was NOT re-opened, and the supersession is surfaced rather than
    // silently swallowed.
    expect(outcome.kind).toBe("escalated");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "compact.unable_at_critical.status_superseded",
      expect.objectContaining({ sessionId: "s1", missionRunId: "run-1" }),
    );
  });

  it("preserves the status → error log → bug emit ORDER", async () => {
    const order: string[] = [];
    mockUpdateStatusIfNotTerminal.mockImplementation(async () => {
      order.push("status");
      return true;
    });
    mockLoggerError.mockImplementation(() => {
      order.push("error_log");
    });
    mockEmitBug.mockImplementation(async () => {
      order.push("bug_emit");
    });

    await tryCriticalBandFallback(escalatingArgs("run-1"));

    expect(order).toEqual(["status", "error_log", "bug_emit"]);
  });

  it("a chat session has no run row to guard, and still escalates + emits", async () => {
    const outcome = await tryCriticalBandFallback(escalatingArgs(null));

    expect(outcome.kind).toBe("escalated");
    expect(mockUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockEmitBug).toHaveBeenCalledTimes(1);
  });

  it("does not touch the run row below the escalation threshold", async () => {
    const outcome = await tryCriticalBandFallback({
      ...escalatingArgs("run-1"),
      criticalNoopCounter: 0,
    });

    expect(outcome.kind).toBe("noop");
    expect(mockUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});
