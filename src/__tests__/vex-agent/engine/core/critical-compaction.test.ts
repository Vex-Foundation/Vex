/**
 * The shared critical-band ladder: prepared apply → bounded wait → fallback.
 *
 * The cases that matter are the ones where getting it wrong is expensive:
 *   - a queued operator Stop must NOT read as a failed compaction;
 *   - the wait must never span a second attempt;
 *   - a timeout must end in the deterministic fallback, never in "carry on".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PreparationPressureState } from "../../../../vex-agent/engine/core/preparation-pressure-state.js";

const mockForcePreparedApply = vi.fn();
const mockForcedFallback = vi.fn();

vi.mock("../../../../vex-agent/engine/compaction/apply/index.js", () => ({
  forcePreparedApply: (...a: unknown[]) => mockForcePreparedApply(...a),
}));
vi.mock("../../../../vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  maybeRunForcedCompactFallback: (...a: unknown[]) => mockForcedFallback(...a),
}));
vi.mock("../../../../vex-agent/db/repos/compaction-preparations/index.js", () => ({
  getLivePreparationPressureState: vi.fn(),
}));

const { resolveCriticalCompaction, CRITICAL_PREPARATION_WAIT_MS } = await import(
  "../../../../vex-agent/engine/core/critical-compaction.js"
);
const { SUMMARY_CALL_TIMEOUT_MS } = await import(
  "../../../../vex-agent/engine/compaction/policy.js"
);

const READY: PreparationPressureState = { kind: "summary_ready", preparationId: "p1" };
const NONE: PreparationPressureState = { kind: "none" };
const APPLYING: PreparationPressureState = { kind: "applying", preparationId: "p1" };

function preparing(over: Partial<Extract<PreparationPressureState, { kind: "preparing" }>> = {}) {
  return {
    kind: "preparing" as const,
    preparationId: "p1",
    leaseAlive: true,
    attemptsRemaining: 2,
    currentAttemptDeadlineMs: null,
    ...over,
  };
}

/** A sleep that advances a fake clock instead of waiting. */
function fakeClock() {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return {
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function run(states: PreparationPressureState[], extra: Record<string, unknown> = {}) {
  let i = 0;
  const seen: PreparationPressureState[] = [];
  return {
    seen,
    promise: resolveCriticalCompaction({
      sessionId: "s-1",
      missionRunId: null,
      sessionPermission: "restricted",
      // The forced apply now requires the caller to PROVE it holds the session
      // lease, so the ladder only attempts it when an owner id is supplied.
      // Omitting it is exercised by its own case below.
      runnerOwnerId: "runner-1",
      readPreparationState: async () => {
        const next = states[Math.min(i, states.length - 1)]!;
        i += 1;
        seen.push(next);
        return next;
      },
      ...extra,
    }),
  };
}

describe("resolveCriticalCompaction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockForcePreparedApply.mockReset();
    mockForcedFallback.mockReset();
  });

  it("shares branch A's timeout constant rather than restating it", () => {
    // A local copy would silently stop tracking the worker it waits on.
    expect(CRITICAL_PREPARATION_WAIT_MS).toBe(SUMMARY_CALL_TIMEOUT_MS);
  });

  it("PREFERS the prepared apply over the deterministic fallback", async () => {
    mockForcePreparedApply.mockResolvedValue({
      kind: "applied",
      generation: 7,
      archivedMessages: 30,
    });

    const outcome = await run([READY]).promise;

    expect(outcome).toEqual({
      kind: "committed",
      via: "prepared_apply",
      generation: 7,
    });
    expect(mockForcedFallback).not.toHaveBeenCalled();
  });

  it("a cutover ALREADY IN FLIGHT defers — and NEVER reaches the fallback", async () => {
    // THE DEFECT THIS PREVENTS. `applying` used to read as `summary_ready`, so
    // the ladder tried a forced apply that could not win, then fell through to
    // the deterministic fallback. That fallback bumps `current + 1`, normally the
    // exact generation the in-flight preparation had frozen as its target — two
    // writers claiming one generation with different summaries and archives,
    // after which apply-crash recovery cannot tell which one committed.
    const outcome = await run([APPLYING]).promise;

    expect(outcome).toEqual({ kind: "deferred", reason: "apply_in_flight" });
    // Neither path runs: forcing could only fail, and the fallback is the danger.
    expect(mockForcedFallback).not.toHaveBeenCalled();
    expect(mockForcePreparedApply).not.toHaveBeenCalled();
  });

  it("a ready preparation with NO proven lease ownership never forces an apply", async () => {
    // Fail-closed: a caller that cannot name its lease owner cannot prove it may
    // rewrite the transcript. The ladder still terminates via the fallback,
    // which is safe here precisely because an `applying` row defers above, so
    // the fallback can never race a live cutover.
    mockForcedFallback.mockResolvedValue({
      kind: "committed",
      generation: 3,
      jobId: 1,
      planMode: "prefix",
    });

    const outcome = await resolveCriticalCompaction({
      sessionId: "s-1",
      missionRunId: null,
      sessionPermission: "restricted",
      readPreparationState: async () => READY,
    });

    expect(mockForcePreparedApply).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: "committed",
      via: "deterministic_fallback",
      generation: 3,
    });
  });

  it("a queued operator Stop DEFERS — it is not a compaction failure", async () => {
    mockForcePreparedApply.mockResolvedValue({
      kind: "deferred",
      result: { kind: "stop_queued" },
    });

    const outcome = await run([READY]).promise;

    expect(outcome).toEqual({ kind: "deferred", reason: "stop_queued" });
    // And it must NOT quietly compact anyway behind the operator's back.
    expect(mockForcedFallback).not.toHaveBeenCalled();
  });

  it("an unusable preparation falls through to the deterministic fallback", async () => {
    mockForcePreparedApply.mockResolvedValue({
      kind: "deferred",
      result: { kind: "generation_moved" },
    });
    mockForcedFallback.mockResolvedValue({
      kind: "committed", generation: 9, jobId: 1, planMode: "runtime",
    });

    const outcome = await run([READY]).promise;

    expect(outcome).toEqual({
      kind: "committed", via: "deterministic_fallback", generation: 9,
    });
  });

  it("no preparation at all ⇒ straight to the deterministic fallback", async () => {
    mockForcedFallback.mockResolvedValue({
      kind: "committed", generation: 2, jobId: 3, planMode: "runtime",
    });

    const outcome = await run([NONE]).promise;

    expect(outcome.kind).toBe("committed");
    expect(mockForcePreparedApply).not.toHaveBeenCalled();
  });

  it("nothing compactable ⇒ noop, which is what the caller escalates on", async () => {
    mockForcedFallback.mockResolvedValue({ kind: "noop", reason: "no_compactable" });

    const outcome = await run([NONE]).promise;

    expect(outcome).toEqual({ kind: "noop", reason: "no_compactable" });
  });

  it("BOUNDED WAIT: exits early the moment the summary becomes ready", async () => {
    const { sleep } = fakeClock();
    mockForcePreparedApply.mockResolvedValue({
      kind: "applied", generation: 4, archivedMessages: 12,
    });

    const outcome = await run([preparing(), preparing(), READY], { sleep }).promise;

    expect(outcome).toEqual({
      kind: "committed", via: "prepared_apply", generation: 4,
    });
    expect(mockForcedFallback).not.toHaveBeenCalled();
  });

  it("BOUNDED WAIT: never spans a second attempt", async () => {
    const { sleep } = fakeClock();
    mockForcedFallback.mockResolvedValue({ kind: "noop", reason: "no_compactable" });

    // attemptsRemaining drops ⇒ the first attempt failed and a new one began.
    const r = run([preparing({ attemptsRemaining: 2 }), preparing({ attemptsRemaining: 1 })], { sleep });
    const outcome = await r.promise;

    expect(outcome.kind).toBe("noop");
    // Two reads only: the initial one and the one that saw the rollover.
    expect(r.seen).toHaveLength(2);
  });

  it("BOUNDED WAIT: a dead lease ends the wait immediately", async () => {
    const { sleep } = fakeClock();
    mockForcedFallback.mockResolvedValue({ kind: "noop", reason: "no_compactable" });

    const r = run([preparing(), preparing({ leaseAlive: false })], { sleep });
    await r.promise;

    expect(r.seen).toHaveLength(2);
  });

  it("BOUNDED WAIT: a timeout runs the FALLBACK — it never proceeds to inference", async () => {
    const { sleep } = fakeClock();
    mockForcedFallback.mockResolvedValue({
      kind: "committed", generation: 5, jobId: 2, planMode: "runtime",
    });

    // Always still preparing ⇒ the wait runs to its bound.
    const outcome = await run([preparing()], { sleep }).promise;

    expect(outcome).toEqual({
      kind: "committed", via: "deterministic_fallback", generation: 5,
    });
    expect(mockForcedFallback).toHaveBeenCalledTimes(1);
  });

  it("does NOT wait when the lease is already dead", async () => {
    const { sleep } = fakeClock();
    mockForcedFallback.mockResolvedValue({ kind: "noop", reason: "no_compactable" });

    const r = run([preparing({ leaseAlive: false })], { sleep });
    await r.promise;

    expect(r.seen).toHaveLength(1);
  });

  it("an unreadable preparation state fails CLOSED into the fallback, never throws", async () => {
    mockForcedFallback.mockResolvedValue({ kind: "noop", reason: "no_compactable" });

    const outcome = await resolveCriticalCompaction({
      sessionId: "s-1",
      missionRunId: null,
      sessionPermission: "restricted",
      readPreparationState: async () => {
        throw new Error("pool exhausted");
      },
    });

    expect(outcome.kind).toBe("noop");
    expect(mockForcePreparedApply).not.toHaveBeenCalled();
  });
});
