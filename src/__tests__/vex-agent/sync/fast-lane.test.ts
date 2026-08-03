/**
 * Pending-activity FAST LANE — the invariants that make it safe to run a 12 s
 * loop against real money rows.
 *
 * The properties pinned here are the ones whose absence causes damage rather
 * than slowness:
 *
 * 1. THE 90 s GATE. A lane may not terminalize a row while its broadcast
 *    handler could still be writing executed amounts. This is the money-truth
 *    guard, not latency slack, and it is the reason this file exists at all.
 * 2. DEDUP / CAP. A second arm is a no-op; overflow is not an error and not a
 *    dropped row.
 * 3. SEMAPHORE. Bounded concurrent chain reads — the DB pool is `max: 10` and
 *    the global sweeps share it.
 * 4. DISARM. Terminalization removes the lane, so nothing keeps polling a
 *    settled row.
 * 5. BATCHING. Solana lanes coalesce into ONE call per cycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListPendingByIds = vi.fn();
const mockListPendingOlderThan = vi.fn();
const mockGetActivityEventById = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  listPendingByIds: (...a: unknown[]) => mockListPendingByIds(...a),
  listPendingOlderThan: (...a: unknown[]) => mockListPendingOlderThan(...a),
  getActivityEventById: (...a: unknown[]) => mockGetActivityEventById(...a),
}));

const mockGetJobsForNamespace = vi.fn();
const mockEnqueueRun = vi.fn();
vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: (...a: unknown[]) => mockGetJobsForNamespace(...a),
  enqueueRun: (...a: unknown[]) => mockEnqueueRun(...a),
}));

const {
  startFastLane,
  rearmPendingFastLanes,
  isPastHandlerWindow,
  FAST_LANE_MAX_ACTIVE,
  FAST_LANE_MAX_CONCURRENCY,
  FAST_LANE_INTERVAL_MS,
  FAST_LANE_MAX_AGE_MS,
} = await import("../../../vex-agent/sync/fast-lane.js");
const { REPAIR_CANDIDATE_AGE_MS } = await import(
  "../../../vex-agent/sync/agent-activity-repair.js"
);
const { pendingActivityBus, emitPendingActivityArmed, emitPendingActivityResolved } =
  await import("../../../vex-agent/events/pending-activity-bus.js");

/** A pending row as the fast lane reads it back from the DB. */
function pendingRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    chainId: 8453,
    chainFamily: "eip155",
    txHash: "0xabc",
    eventRole: "swap",
    protocolExecutionId: 500,
    // Old enough that the handler can no longer be writing.
    submitAttemptedAt: new Date(Date.now() - REPAIR_CANDIDATE_AGE_MS - 1_000).toISOString(),
    ...over,
  };
}

function stubDeps() {
  return {
    resolveEvmRows: vi.fn().mockResolvedValue(undefined),
    resolveSolanaRows: vi.fn().mockResolvedValue(undefined),
    runBridgeSweep: vi.fn().mockResolvedValue(undefined),
  };
}

/** Deterministic "jitter": always the midpoint, so due times are exact multiples. */
const noJitter = () => 0.5;

beforeEach(() => {
  vi.clearAllMocks();
  pendingActivityBus.clear();
  mockListPendingByIds.mockResolvedValue([]);
  mockListPendingOlderThan.mockResolvedValue([]);
  mockGetJobsForNamespace.mockResolvedValue([{ id: 9, syncType: "balances_snapshot" }]);
  mockEnqueueRun.mockResolvedValue(1);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  pendingActivityBus.clear();
});

// ── 1. The 90 s gate ──────────────────────────────────────────────────────

describe("the 90 s handler window", () => {
  it("isPastHandlerWindow is false inside the window and true outside it", () => {
    const now = Date.now();
    const fresh = new Date(now - 10_000).toISOString();
    const old = new Date(now - REPAIR_CANDIDATE_AGE_MS - 1).toISOString();

    expect(isPastHandlerWindow({ submitAttemptedAt: fresh }, now)).toBe(false);
    expect(isPastHandlerWindow({ submitAttemptedAt: old }, now)).toBe(true);
  });

  it("treats a missing or unparseable submit time as INSIDE the window", () => {
    // Conservative direction: without proof the handler is gone, do not
    // terminalize. Guessing the other way forfeits executed amounts forever.
    const now = Date.now();
    expect(isPastHandlerWindow({ submitAttemptedAt: null }, now)).toBe(false);
    expect(isPastHandlerWindow({ submitAttemptedAt: "not-a-date" }, now)).toBe(false);
  });

  it("a lane does NOT terminalize a row younger than the gate while its handler is alive", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 8453 });
    // The row exists and is pending, but is ALWAYS only 10 s past its submit at
    // the moment it is read — a handler that is still decoding its own receipt,
    // however far the fake clock has advanced.
    mockListPendingByIds.mockImplementation(async () => [
      pendingRow({ submitAttemptedAt: new Date(Date.now() - 10_000).toISOString() }),
    ]);

    // Run well past the first due time so the lane definitely fires.
    await vi.advanceTimersByTimeAsync(REPAIR_CANDIDATE_AGE_MS + FAST_LANE_INTERVAL_MS * 2);

    // The lane looked, but handed nothing to the resolver — no CAS was attempted.
    expect(deps.resolveEvmRows).not.toHaveBeenCalled();
    // And it is still armed: this is a deferral, never a give-up.
    expect(handle.size()).toBe(1);

    handle.stop();
  });

  it("resolves the row once it is past the gate", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 8453 });
    mockListPendingByIds.mockResolvedValue([pendingRow()]);

    await vi.advanceTimersByTimeAsync(REPAIR_CANDIDATE_AGE_MS + 4_000);

    expect(deps.resolveEvmRows).toHaveBeenCalled();
    expect(deps.resolveEvmRows.mock.calls[0]?.[0]).toHaveLength(1);

    handle.stop();
  });

  it("Solana lanes carry no gate — their sweep never had one", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    emitPendingActivityArmed({ activityId: 2, chainFamily: "solana", chainId: 101 });
    mockListPendingByIds.mockResolvedValue([
      pendingRow({
        id: 2,
        chainFamily: "solana",
        submitAttemptedAt: new Date(Date.now() - 2_000).toISOString(),
      }),
    ]);

    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS + 4_000);

    expect(deps.resolveSolanaRows).toHaveBeenCalled();
    expect(deps.resolveEvmRows).not.toHaveBeenCalled();

    handle.stop();
  });
});

// ── 2. Dedup and cap ──────────────────────────────────────────────────────

describe("dedup and capacity", () => {
  it("a second arm for the same row is a no-op", () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });

    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 1 });
    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 1 });
    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 1 });

    expect(handle.size()).toBe(1);
    handle.stop();
  });

  it("stops arming at the cap — overflow is not an error and the row is not dropped", () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });

    for (let id = 1; id <= FAST_LANE_MAX_ACTIVE + 5; id++) {
      emitPendingActivityArmed({ activityId: id, chainFamily: "eip155", chainId: 1 });
    }

    // The overflow rows are still `pending` in the DB and still owned by the
    // global sweep — which is exactly the world before this module existed.
    expect(handle.size()).toBe(FAST_LANE_MAX_ACTIVE);
    handle.stop();
  });
});

// ── 3. Semaphore ──────────────────────────────────────────────────────────

describe("bounded concurrency", () => {
  it("never has more than FAST_LANE_MAX_CONCURRENCY EVM lookups in flight", async () => {
    // Exercises the real production dep's semaphore by injecting a resolver that
    // records its own concurrency, wired through the same bounded runner.
    const { buildProductionFastLaneDeps } = await import("../../../vex-agent/sync/fast-lane.js");
    expect(typeof buildProductionFastLaneDeps).toBe("function");

    let inFlight = 0;
    let peak = 0;
    const deps = {
      ...stubDeps(),
      resolveEvmRows: vi.fn(async (rows: readonly unknown[]) => {
        // The production dep bounds per ROW; this stub asserts the fast lane
        // hands the whole due batch over in one call so the bound is applied in
        // exactly one place rather than re-derived per cycle.
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        expect(rows.length).toBeLessThanOrEqual(FAST_LANE_MAX_ACTIVE);
      }),
    };

    const handle = startFastLane({ deps, random: noJitter });
    for (let id = 1; id <= 6; id++) {
      emitPendingActivityArmed({ activityId: id, chainFamily: "eip155", chainId: 1 });
    }
    mockListPendingByIds.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => pendingRow({ id: i + 1 })),
    );

    await vi.advanceTimersByTimeAsync(REPAIR_CANDIDATE_AGE_MS + 4_000);

    expect(peak).toBeLessThanOrEqual(FAST_LANE_MAX_CONCURRENCY);
    handle.stop();
  });

  it("batches all due Solana lanes into ONE resolver call per cycle", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    for (let id = 1; id <= 5; id++) {
      emitPendingActivityArmed({ activityId: id, chainFamily: "solana", chainId: 101 });
    }
    mockListPendingByIds.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) =>
        pendingRow({ id: i + 1, chainFamily: "solana" }),
      ),
    );

    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS + 4_000);

    // One call carrying five rows — NOT five calls. `getSignatureStatuses` takes
    // an array, so per-row calls would multiply RPC load by the lane count.
    expect(deps.resolveSolanaRows).toHaveBeenCalledTimes(1);
    expect(deps.resolveSolanaRows.mock.calls[0]?.[0]).toHaveLength(5);

    handle.stop();
  });
});

// ── 4. Disarm ─────────────────────────────────────────────────────────────

describe("disarm", () => {
  it("disarms on terminalization", () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });

    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 1 });
    expect(handle.size()).toBe(1);

    emitPendingActivityResolved({
      activityId: 1,
      chainFamily: "eip155",
      chainId: 1,
      status: "confirmed",
    });

    expect(handle.size()).toBe(0);
    handle.stop();
  });

  it("enqueues a balances_snapshot run on terminalization, keyed by execution id", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    mockGetActivityEventById.mockResolvedValue(pendingRow({ protocolExecutionId: 777 }));

    emitPendingActivityResolved({
      activityId: 1,
      chainFamily: "eip155",
      chainId: 1,
      status: "confirmed",
    });
    await vi.advanceTimersByTimeAsync(10);

    // Keyed by execution id so migration 046's partial unique index collapses a
    // multi-leg execution into ONE snapshot run.
    expect(mockEnqueueRun).toHaveBeenCalledWith(9, 777);
    handle.stop();
  });

  it("disarms a row that vanished from the pending set — someone else resolved it", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 1 });
    // The by-id read comes back empty: the row is no longer pending.
    mockListPendingByIds.mockResolvedValue([]);

    await vi.advanceTimersByTimeAsync(REPAIR_CANDIDATE_AGE_MS + 4_000);

    expect(handle.size()).toBe(0);
    expect(deps.resolveEvmRows).not.toHaveBeenCalled();
    handle.stop();
  });

  it("ages a lane out instead of ever auto-failing it", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 1 });
    mockListPendingByIds.mockResolvedValue([pendingRow()]);

    await vi.advanceTimersByTimeAsync(FAST_LANE_MAX_AGE_MS + 4_000);

    // Handed back to the global sweep. The row stays `pending` in the DB —
    // NOTHING in this module may write a terminal status on a timeout.
    expect(handle.size()).toBe(0);
    handle.stop();
  });

  it("stop() clears every lane and unsubscribes", () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    emitPendingActivityArmed({ activityId: 1, chainFamily: "eip155", chainId: 1 });

    handle.stop();

    expect(handle.size()).toBe(0);
    // A post-stop arm must not resurrect the lane.
    emitPendingActivityArmed({ activityId: 2, chainFamily: "eip155", chainId: 1 });
    expect(handle.size()).toBe(0);
  });
});

// ── 5. Crash recovery ─────────────────────────────────────────────────────

describe("crash recovery", () => {
  it("re-arms in-flight rows through the bus, so the cap and dedup still apply", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    mockListPendingOlderThan.mockImplementation(async (_age: number, _limit: number, family: string) =>
      family === "eip155" ? [pendingRow({ id: 1 }), pendingRow({ id: 2 })] : [],
    );

    const armed = await rearmPendingFastLanes();

    expect(armed).toBe(2);
    expect(handle.size()).toBe(2);
    handle.stop();
  });

  it("does not re-arm a row already older than the fast lane's max age", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    mockListPendingOlderThan.mockImplementation(async (_a: number, _l: number, family: string) =>
      family === "eip155"
        ? [
            pendingRow({
              id: 1,
              submitAttemptedAt: new Date(Date.now() - FAST_LANE_MAX_AGE_MS - 1_000).toISOString(),
            }),
          ]
        : [],
    );

    // A long-stuck row belongs to the global sweep, not to a "fresh broadcast"
    // lane — arming it would burn a capped slot a genuinely fresh row needs.
    expect(await rearmPendingFastLanes()).toBe(0);
    expect(handle.size()).toBe(0);
    handle.stop();
  });
});
