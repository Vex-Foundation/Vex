/**
 * `gate_deferred` must not walk a healthy run toward `compact_unable_at_critical`.
 *
 * The escalation machine fires after `COMPACT_MAX_CONSECUTIVE_NOOPS` (2)
 * consecutive noops, parking the run as `paused_error`. A deferral is the gate
 * WORKING — today, an operator Stop is queued and the transcript must not be
 * rewritten under it. If deferrals counted, pressing Stop at critical would
 * park the run with an error, blaming the runtime for obeying the user.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveCriticalCompaction = vi.fn();
vi.mock("../../../../../vex-agent/engine/core/critical-compaction.js", () => ({
  resolveCriticalCompaction: (...a: unknown[]) => mockResolveCriticalCompaction(...a),
}));
vi.mock("../../../../../vex-agent/db/repos/mission-runs.js", () => ({
  updateStatusIfNotTerminal: vi.fn().mockResolvedValue(true),
}));
const mockBugEmit = vi.fn();
vi.mock("../../../../../vex-agent/engine/core/turn-loop-bug-emit.js", () => ({
  emitCompactUnableAtCriticalBug: (...a: unknown[]) => mockBugEmit(...a),
}));

const { tryCriticalBandFallback, COMPACT_MAX_CONSECUTIVE_NOOPS } = await import(
  "../../../../../vex-agent/engine/core/turn-loop-critical-fallback.js"
);

function args(over: Record<string, unknown> = {}) {
  return {
    sessionId: "s-1",
    missionRunId: null,
    turnBand: "critical" as const,
    skipCriticalCheckNextIter: false,
    criticalNoopCounter: 0,
    currentTokenCount: 190_000,
    contextLimit: 200_000,
    sessionPermission: "restricted" as const,
    ...over,
  };
}

describe("critical band — gate_deferred counter semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a deferral PASSES THE COUNTER THROUGH, never increments it", async () => {
    mockResolveCriticalCompaction.mockResolvedValue({
      kind: "deferred",
      reason: "stop_queued",
    });

    const outcome = await tryCriticalBandFallback(args({ criticalNoopCounter: 1 }));

    expect(outcome).toEqual({
      kind: "gate_deferred",
      nextCriticalNoopCounter: 1,
      reason: "stop_queued",
    });
  });

  it("TWO consecutive deferrals do NOT escalate", async () => {
    mockResolveCriticalCompaction.mockResolvedValue({
      kind: "deferred",
      reason: "stop_queued",
    });

    let counter = 0;
    for (let i = 0; i < COMPACT_MAX_CONSECUTIVE_NOOPS + 2; i++) {
      const outcome = await tryCriticalBandFallback(args({ criticalNoopCounter: counter }));
      expect(outcome.kind).toBe("gate_deferred");
      counter = (outcome as { nextCriticalNoopCounter: number }).nextCriticalNoopCounter;
    }

    expect(counter).toBe(0);
    expect(mockBugEmit).not.toHaveBeenCalled();
  });

  it("a GENUINE noop still increments and still escalates at the limit", async () => {
    // The guard above must not have disarmed the escalation path.
    mockResolveCriticalCompaction.mockResolvedValue({
      kind: "noop",
      reason: "no_compactable",
    });

    const first = await tryCriticalBandFallback(args({ criticalNoopCounter: 0 }));
    expect(first).toMatchObject({ kind: "noop", nextCriticalNoopCounter: 1 });

    const second = await tryCriticalBandFallback(args({ criticalNoopCounter: 1 }));
    expect(second).toMatchObject({
      kind: "escalated",
      stopReason: "compact_unable_at_critical",
      consecutiveNoops: COMPACT_MAX_CONSECUTIVE_NOOPS,
    });
    expect(mockBugEmit).toHaveBeenCalledTimes(1);
  });

  it("a committed compaction resets the counter to zero", async () => {
    mockResolveCriticalCompaction.mockResolvedValue({
      kind: "committed",
      via: "prepared_apply",
      generation: 3,
    });

    const outcome = await tryCriticalBandFallback(args({ criticalNoopCounter: 1 }));

    expect(outcome).toEqual({ kind: "committed", nextCriticalNoopCounter: 0 });
  });

  it("below critical the ladder is never consulted", async () => {
    const outcome = await tryCriticalBandFallback(
      args({ turnBand: "barrier", criticalNoopCounter: 1 }),
    );

    expect(outcome).toEqual({ kind: "below_critical", nextCriticalNoopCounter: 0 });
    expect(mockResolveCriticalCompaction).not.toHaveBeenCalled();
  });
});
