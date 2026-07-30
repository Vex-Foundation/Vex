/**
 * DURABLE operator-Stop consumer at the CRITICAL-BAND escalation park
 * (`turn-loop-critical-fallback.ts`, `paused_error` /
 * `compact_unable_at_critical`).
 *
 * Site-specific hazard: the escalation parks with NO wake, so this is the last
 * boundary the run reaches. It also has a HARD ordering requirement flagged in
 * an earlier Codex round and documented in the module header — status write →
 * `logger.error` → bug emit. Only the status write moved inside the lock; the
 * error log and the bug emit must still run unconditionally, in that order, on
 * every branch including a consumed Stop.
 *
 * Pinned here: gate consulted under the lock on the write's own client; no park
 * write when it reports `stopped`; the escalation ORDER and the unconditional
 * error-log + bug-emit survive gate-stopped; a chat session never gates.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockMaybeRunForcedCompactFallback = vi.fn();
const mockUpdateStatus = vi.fn();
const mockUpdateStatusIfNotTerminal = vi.fn();
const mockEmitBug = vi.fn();
const mockGateOnOperatorStop = vi.fn();
const mockWithSessionControlLock = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockLoggerInfo = vi.fn();

const fakeClient = { id: "fake-client" };

vi.mock("@vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: (...a: unknown[]) =>
    mockMaybeRunForcedCompactFallback(...a),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  updateStatusIfNotTerminal: (...a: unknown[]) =>
    mockUpdateStatusIfNotTerminal(...a),
}));

vi.mock("@vex-agent/engine/core/turn-loop-bug-emit.js", () => ({
  emitCompactUnableAtCriticalBug: (...a: unknown[]) => mockEmitBug(...a),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  gateOnOperatorStopWithClient: (...a: unknown[]) => mockGateOnOperatorStop(...a),
  withSessionControlLock: (...a: unknown[]) => mockWithSessionControlLock(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    debug: vi.fn(),
  },
}));

const { tryCriticalBandFallback, COMPACT_MAX_CONSECUTIVE_NOOPS } = await import(
  "@vex-agent/engine/core/turn-loop-critical-fallback.js"
);

function escalatingArgs(missionRunId: string | null) {
  return {
    sessionId: "s1",
    missionRunId,
    turnBand: "critical" as const,
    skipCriticalCheckNextIter: false,
    criticalNoopCounter: COMPACT_MAX_CONSECUTIVE_NOOPS - 1,
    currentTokenCount: 120_000,
    contextLimit: 128_000,
  };
}

describe("compact_unable_at_critical escalation — durable operator-Stop consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMaybeRunForcedCompactFallback.mockResolvedValue({
      kind: "noop",
      reason: "no_compactable",
    });
    mockUpdateStatusIfNotTerminal.mockResolvedValue(true);
    mockGateOnOperatorStop.mockResolvedValue({ kind: "clear" });
    mockWithSessionControlLock.mockImplementation(
      async (_sessionId: string, fn: (c: unknown) => Promise<unknown>) =>
        fn(fakeClient),
    );
  });

  it("runs the gate under the session control lock, on the write's own client", async () => {
    await tryCriticalBandFallback(escalatingArgs("run-1"));

    expect(mockWithSessionControlLock.mock.calls[0]![0]).toBe("s1");
    expect(mockGateOnOperatorStop).toHaveBeenCalledWith(fakeClient, {
      sessionId: "s1",
      missionRunId: "run-1",
    });
    expect(mockUpdateStatusIfNotTerminal.mock.calls[0]!.at(-1)).toBe(fakeClient);
  });

  it("applies a queued Stop instead of writing paused_error", async () => {
    mockGateOnOperatorStop.mockResolvedValue({
      kind: "stopped",
      runStatus: "stopped",
    });

    const outcome = await tryCriticalBandFallback(escalatingArgs("run-1"));

    // FAIL-CLOSED: no status write at all.
    expect(mockUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "compact.unable_at_critical.consumed_operator_stop",
      expect.objectContaining({ sessionId: "s1", missionRunId: "run-1" }),
    );
    // The loop still unwinds: the compaction genuinely failed regardless of the
    // Stop, and the caller's contract is unchanged.
    expect(outcome.kind).toBe("escalated");
  });

  it("preserves the status → error log → bug emit ORDER when a Stop is consumed", async () => {
    // The hard ordering requirement is not conditional on the write landing.
    const order: string[] = [];
    mockGateOnOperatorStop.mockImplementation(async () => {
      order.push("status");
      return { kind: "stopped", runStatus: "stopped" };
    });
    mockLoggerError.mockImplementation(() => {
      order.push("error_log");
    });
    mockEmitBug.mockImplementation(async () => {
      order.push("bug_emit");
    });

    await tryCriticalBandFallback(escalatingArgs("run-1"));

    expect(order).toEqual(["status", "error_log", "bug_emit"]);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "compact.unable_at_critical",
      expect.objectContaining({ sessionId: "s1" }),
    );
    expect(mockEmitBug).toHaveBeenCalledTimes(1);
  });

  it("a chat session neither gates nor writes, and still escalates + emits", async () => {
    const outcome = await tryCriticalBandFallback(escalatingArgs(null));

    expect(mockWithSessionControlLock).not.toHaveBeenCalled();
    expect(mockUpdateStatusIfNotTerminal).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("escalated");
    expect(mockEmitBug).toHaveBeenCalledTimes(1);
  });
});
