/**
 * S-5 wiring from the turn loop into the critical-compaction waits.
 *
 * The ladder (`critical-compaction.ts`) already ends its bounded wait on an
 * aborted signal and returns `deferred` / `aborted`. These tests pin that the
 * LOOP hands it the run's Stop:
 *   - a Stop landing DURING the critical-band wait ends it promptly and the
 *     step proceeds with the noop counter passed through (the next iteration
 *     guard consumes the Stop - no escalation, no cutover);
 *   - the wake park after a `waiting_for_wake` batch forwards the Stop too;
 *   - `turn-loop.ts` threads the Stop (never the lease-lost signal) into all
 *     three call sites.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seenSignals: Array<AbortSignal | undefined> = [];
const mockResolveCriticalCompaction = vi.fn();
vi.mock("../../../../../vex-agent/engine/core/critical-compaction.js", () => ({
  resolveCriticalCompaction: (...a: unknown[]) => mockResolveCriticalCompaction(...a),
}));
vi.mock("../../../../../vex-agent/db/repos/mission-runs.js", () => ({
  updateStatusIfNotTerminal: vi.fn().mockResolvedValue(true),
}));
vi.mock("../../../../../vex-agent/engine/core/turn-loop-bug-emit.js", () => ({
  emitCompactUnableAtCriticalBug: vi.fn(),
}));
const mockWakePark = vi.fn();
vi.mock("../../../../../vex-agent/engine/core/turn-loop-waiting-for-wake.js", () => ({
  applyWaitingForWakePostBatch: (...a: unknown[]) => mockWakePark(...a),
}));

const { runCriticalBandStep } = await import(
  "../../../../../vex-agent/engine/core/turn-loop/critical-band-step.js"
);
const { applyToolBatchOutcome } = await import(
  "../../../../../vex-agent/engine/core/turn-loop/tool-batch-step.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  seenSignals.length = 0;
});

describe("critical-band wait - Stop from the loop (S-5)", () => {
  it("a Stop during the wait ends it promptly; the step proceeds with the counter passed through", async () => {
    // The ladder is mid-wait: it settles only when the Stop aborts it, and
    // then answers exactly what the real ladder answers - deferred / aborted.
    mockResolveCriticalCompaction.mockImplementation(
      async (input: { signal?: AbortSignal }) => {
        seenSignals.push(input.signal);
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { kind: "deferred", reason: "aborted" };
      },
    );
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);
    const startedAt = Date.now();

    const step = await runCriticalBandStep({
      sessionId: "s-1",
      missionRunId: "run-1",
      sessionPermission: "full",
      runnerOwnerId: "owner-1",
      contextLimit: 200_000,
      criticalNoopCounter: 1,
      skipCriticalCheckNextIter: false,
      observeBand: () => "critical",
      readCurrentTokenCount: () => 190_000,
      handlePostCompactBookkeeping: async () => {},
      signal: stop.signal,
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(seenSignals).toEqual([stop.signal]);
    expect(step).toEqual({
      kind: "proceed",
      turnBand: "critical",
      criticalNoopCounter: 1,
      skipCriticalCheckNextIter: false,
    });
  });

  it("the wake park after a waiting_for_wake batch receives the Stop", async () => {
    mockWakePark.mockResolvedValue(undefined);
    const stop = new AbortController();

    await applyToolBatchOutcome({
      batchOutcome: {
        kind: "waiting_for_wake",
        text: null,
        stopPayload: {},
        toolCallsExecuted: 1,
        lastText: null,
      },
      sessionId: "s-1",
      missionRunId: "run-1",
      sessionPermission: "full",
      runnerOwnerId: "owner-1",
      currentTokenCount: 0,
      contextLimit: 200_000,
      totalToolCalls: 1,
      pendingApprovals: [],
      lastText: null,
      handlePostCompactBookkeeping: async () => {},
      mergeOperatorInstructions: async () => {},
      signal: stop.signal,
    });

    expect(mockWakePark).toHaveBeenCalledWith(
      expect.objectContaining({ signal: stop.signal }),
    );
  });

  it("turn-loop.ts threads the Stop into the critical step, the ceiling gate and both wake parks", () => {
    const source = readFileSync(
      new URL("../../../../../vex-agent/engine/core/turn-loop.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("const stopSignal = abortSignal ?? inferenceAbortSignal;");
    const threaded = source.match(
      /\.\.\.\(stopSignal === undefined \? \{\} : \{ signal: stopSignal \}\)/g,
    );
    // Four sites: the critical step, the ceiling gate, the batch wake park and
    // the honest-idle wake park (Kairos B-1).
    expect(threaded).toHaveLength(4);
    // The lease-lost signal is never what the waits are handed.
    expect(source).not.toMatch(/signal: leaseGuard/);
  });
});
