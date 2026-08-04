/**
 * Pending-activity FAST LANE — the invariants that make it safe to run a 12 s
 * loop against real money rows.
 *
 * The properties pinned here are the ones whose absence causes damage rather
 * than slowness:
 *
 * 1. THE 90 s GATE, as a pure predicate. EVM ROWS ARE NO LONGER REGISTRY WORK:
 *    the durable claim (`claimDuePendingEvm`) is their single scheduler, so this
 *    module's job for them is to DRIVE that claimant every cycle — including
 *    with an empty registry, which is exactly the restart case the old per-id
 *    path could not serve. The gate itself is enforced where terminalization
 *    happens, and is pinned in `agent-activity-repair-observation-lane.test.ts`.
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
const mockListPendingProviderLogical = vi.fn();
const mockGetActivityEventById = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  listPendingByIds: (...a: unknown[]) => mockListPendingByIds(...a),
  listPendingOlderThan: (...a: unknown[]) => mockListPendingOlderThan(...a),
  listPendingProviderLogical: (...a: unknown[]) => mockListPendingProviderLogical(...a),
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
  FAST_LANE_INTERVAL_MS,
  FAST_LANE_MAX_AGE_MS,
  FAST_LANE_PROVIDER_INTERVAL_MS,
} = await import("../../../vex-agent/sync/fast-lane.js");
const { REPAIR_CANDIDATE_AGE_MS } = await import(
  "../../../vex-agent/sync/handler-window.js"
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
    runEvmPendingLane: vi.fn().mockResolvedValue(undefined),
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
  mockListPendingProviderLogical.mockResolvedValue([]);
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

  it("drives the EVM claimant every cycle even with an EMPTY registry — the restart case", async () => {
    // The old per-id path could only observe rows THIS process had armed, so a
    // restart left every in-flight EVM row waiting for the 30 s sweep. The
    // claimant reads the database, so an empty registry is not an empty queue.
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    expect(handle.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS);

    expect(deps.runEvmPendingLane).toHaveBeenCalled();
    // And never through the non-claiming by-id read, which could race the sweep
    // on the same row.
    expect(mockListPendingByIds).not.toHaveBeenCalled();

    handle.stop();
  });

  it("an EVM arm takes NO registry slot — the claim owns those rows", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });

    for (let id = 1; id <= 5; id++) {
      emitPendingActivityArmed({ activityId: id, chainFamily: "eip155", chainId: 8453, lane: "onchain" });
    }

    // A second owner with a weaker guarantee — capped at 12, lost on restart —
    // is exactly what the claim replaced.
    expect(handle.size()).toBe(0);
    handle.stop();
  });

  it("Solana lanes carry no gate — their sweep never had one", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    emitPendingActivityArmed({ activityId: 2, chainFamily: "solana", chainId: 101, lane: "onchain" });
    mockListPendingByIds.mockResolvedValue([
      pendingRow({
        id: 2,
        chainFamily: "solana",
        submitAttemptedAt: new Date(Date.now() - 2_000).toISOString(),
      }),
    ]);

    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS + 4_000);

    expect(deps.resolveSolanaRows).toHaveBeenCalled();

    handle.stop();
  });
});

// ── 2. Dedup and cap ──────────────────────────────────────────────────────

describe("dedup and capacity", () => {
  it("a second arm for the same row is a no-op", () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });

    emitPendingActivityArmed({ activityId: 1, chainFamily: "solana", chainId: 101, lane: "onchain" });
    emitPendingActivityArmed({ activityId: 1, chainFamily: "solana", chainId: 101, lane: "onchain" });
    emitPendingActivityArmed({ activityId: 1, chainFamily: "solana", chainId: 101, lane: "onchain" });

    expect(handle.size()).toBe(1);
    handle.stop();
  });

  it("stops arming at the cap — overflow is not an error and the row is not dropped", () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });

    for (let id = 1; id <= FAST_LANE_MAX_ACTIVE + 5; id++) {
      emitPendingActivityArmed({ activityId: id, chainFamily: "solana", chainId: 101, lane: "onchain" });
    }

    // The overflow rows are still `pending` in the DB and still owned by the
    // global sweep — which is exactly the world before this module existed.
    expect(handle.size()).toBe(FAST_LANE_MAX_ACTIVE);
    handle.stop();
  });
});

// ── 3. Batching ───────────────────────────────────────────────────────────
//
// The EVM in-flight bound moved with the EVM scheduler: it is now
// `EVM_LANE_MAX_CONCURRENCY` in `agent-activity-repair.ts`, applied once over a
// claimed page, and pinned there.

describe("batching", () => {
  it("batches all due Solana lanes into ONE resolver call per cycle", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    for (let id = 1; id <= 5; id++) {
      emitPendingActivityArmed({ activityId: id, chainFamily: "solana", chainId: 101, lane: "onchain" });
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

    emitPendingActivityArmed({ activityId: 1, chainFamily: "solana", chainId: 101, lane: "onchain" });
    expect(handle.size()).toBe(1);

    emitPendingActivityResolved({
      activityId: 1,
      chainFamily: "eip155",
      chainId: 1,
      lane: "onchain",
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
      lane: "onchain",
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

    emitPendingActivityArmed({ activityId: 1, chainFamily: "solana", chainId: 101, lane: "onchain" });
    // The by-id read comes back empty: the row is no longer pending.
    mockListPendingByIds.mockResolvedValue([]);

    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS + 4_000);

    expect(handle.size()).toBe(0);
    expect(deps.resolveSolanaRows).not.toHaveBeenCalled();
    handle.stop();
  });

  it("ages a lane out instead of ever auto-failing it", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    emitPendingActivityArmed({ activityId: 1, chainFamily: "solana", chainId: 101, lane: "onchain" });
    mockListPendingByIds.mockResolvedValue([pendingRow({ chainFamily: "solana" })]);

    await vi.advanceTimersByTimeAsync(FAST_LANE_MAX_AGE_MS + 4_000);

    // Handed back to the global sweep. The row stays `pending` in the DB —
    // NOTHING in this module may write a terminal status on a timeout.
    expect(handle.size()).toBe(0);
    handle.stop();
  });

  it("stop() clears every lane and unsubscribes", () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    emitPendingActivityArmed({ activityId: 1, chainFamily: "solana", chainId: 101, lane: "onchain" });

    handle.stop();

    expect(handle.size()).toBe(0);
    // A post-stop arm must not resurrect the lane.
    emitPendingActivityArmed({ activityId: 2, chainFamily: "solana", chainId: 101, lane: "onchain" });
    expect(handle.size()).toBe(0);
  });
});

// ── 5. Crash recovery ─────────────────────────────────────────────────────

describe("crash recovery", () => {
  it("re-arms in-flight rows through the bus, so the cap and dedup still apply", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    mockListPendingOlderThan.mockImplementation(async (_age: number, _limit: number, family: string) =>
      family === "solana"
        ? [pendingRow({ id: 1, chainFamily: "solana" }), pendingRow({ id: 2, chainFamily: "solana" })]
        : [],
    );

    const armed = await rearmPendingFastLanes();

    expect(armed).toBe(2);
    expect(handle.size()).toBe(2);
    handle.stop();
  });

  it("does NOT re-arm EVM rows — the durable claim already covers every one of them", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    mockListPendingOlderThan.mockResolvedValue([]);

    await rearmPendingFastLanes();

    // Re-arming them would create a second, weaker owner for rows the claim
    // selects from the database on the very first cycle after a restart.
    expect(mockListPendingOlderThan).toHaveBeenCalledTimes(1);
    expect(mockListPendingOlderThan).toHaveBeenCalledWith(0, FAST_LANE_MAX_ACTIVE, "solana");
    handle.stop();
  });

  // The count is a REPORT of how many rows the fast lane actually took over.
  // Counting emitted candidates instead overstated it whenever the registry
  // declined one — a restart that armed nothing could still log "12 re-armed",
  // which is exactly the wrong signal when the cap is the thing under pressure.
  it("counts lanes ACCEPTED, not candidates emitted, when a row is already armed", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    emitPendingActivityArmed({ activityId: 1, chainFamily: "solana", chainId: 101, lane: "onchain" });
    mockListPendingOlderThan.mockImplementation(async (_a: number, _l: number, family: string) =>
      family === "solana"
        ? [pendingRow({ id: 1, chainFamily: "solana" }), pendingRow({ id: 2, chainFamily: "solana" })]
        : [],
    );

    // Two candidates, one already armed → exactly one new lane.
    expect(await rearmPendingFastLanes(() => handle.size())).toBe(1);
    expect(handle.size()).toBe(2);
    handle.stop();
  });

  it("counts lanes ACCEPTED, not candidates emitted, when the cap is reached", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    const overCap = Array.from(
      { length: FAST_LANE_MAX_ACTIVE + 5 },
      (_, i) => pendingRow({ id: i + 1, chainFamily: "solana" }),
    );
    mockListPendingOlderThan.mockImplementation(async (_a: number, _l: number, family: string) =>
      family === "solana" ? overCap : [],
    );

    expect(await rearmPendingFastLanes(() => handle.size())).toBe(FAST_LANE_MAX_ACTIVE);
    expect(handle.size()).toBe(FAST_LANE_MAX_ACTIVE);
    handle.stop();
  });

  it("does not re-arm a row already older than the fast lane's max age", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    mockListPendingOlderThan.mockImplementation(async (_a: number, _l: number, family: string) =>
      family === "solana"
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

// ── 6. The PROVIDER lane (Blocker 1) ──────────────────────────────────────

/**
 * The regression this section exists for: a logical `bridge_fill_expected` row
 * carries a NON-NULL destination chain id, but holds no `tx_hash` and no
 * `submit_attempted_at` — the fill has not happened, so there is nothing local
 * to look up. While the lane was inferred from the payload (`chainId === null`),
 * every such row was routed into the ON-CHAIN leg, whose by-id reread requires
 * both of those columns, and was therefore disarmed on its first cycle. The
 * provider lane was unreachable in production, live AND after restart.
 *
 * The lane is now stated by the arming CAS and carried on the event.
 */
describe("the provider lane", () => {
  /** A REALISTIC logical bridge row: destination chain set, no local hash, no submit time. */
  function bridgeLogicalRow(over: Record<string, unknown> = {}) {
    return {
      id: 77,
      chainId: 8453,
      chainFamily: "eip155",
      txHash: null,
      submitAttemptedAt: null,
      eventRole: "bridge_fill_expected",
      protocolExecutionId: 900,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      ...over,
    };
  }

  it("resolves a live bridge row through the bridge sweep, not the on-chain leg", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });

    const row = bridgeLogicalRow();
    emitPendingActivityArmed({
      activityId: row.id,
      chainFamily: "eip155",
      // The destination chain id — non-null, which is exactly what used to
      // misroute this row into the on-chain leg.
      chainId: row.chainId,
      lane: "provider",
    });
    expect(handle.size()).toBe(1);

    await vi.advanceTimersByTimeAsync(FAST_LANE_PROVIDER_INTERVAL_MS + 4_000);

    expect(deps.runBridgeSweep).toHaveBeenCalled();
    // Never the on-chain leg, and never disarmed for lacking a hash it cannot have.
    expect(deps.resolveSolanaRows).not.toHaveBeenCalled();
    expect(mockListPendingByIds).not.toHaveBeenCalled();
    expect(handle.size()).toBe(1);
    handle.stop();
  });

  it("re-arms the bridge row on the provider lane after a restart", async () => {
    const deps = stubDeps();
    const handle = startFastLane({ deps, random: noJitter });
    // The on-chain rearm set cannot see this row — it has no staged hash and no
    // submit timestamp — which is why the provider lane needs its own query.
    mockListPendingOlderThan.mockResolvedValue([]);
    mockListPendingProviderLogical.mockResolvedValue([bridgeLogicalRow()]);

    expect(await rearmPendingFastLanes()).toBe(1);
    expect(handle.size()).toBe(1);

    await vi.advanceTimersByTimeAsync(FAST_LANE_PROVIDER_INTERVAL_MS + 4_000);

    expect(deps.runBridgeSweep).toHaveBeenCalled();
    expect(deps.resolveSolanaRows).not.toHaveBeenCalled();
    expect(handle.size()).toBe(1);
    handle.stop();
  });

  it("does not re-arm a logical row older than the fast lane's max age", async () => {
    const handle = startFastLane({ deps: stubDeps(), random: noJitter });
    mockListPendingProviderLogical.mockResolvedValue([
      bridgeLogicalRow({ createdAt: new Date(Date.now() - FAST_LANE_MAX_AGE_MS - 1_000).toISOString() }),
    ]);

    // A long-stuck bridge belongs to the 120 s global sweep, not to a capped
    // real-time slot. It is NOT failed — just handed back.
    expect(await rearmPendingFastLanes()).toBe(0);
    expect(handle.size()).toBe(0);
    handle.stop();
  });
});

// ── 7. Error scrubbing (the secrets decree) ───────────────────────────────

describe("the cycle's own failure log", () => {
  /**
   * A cycle failure is the one place in this module where a PROVIDER error
   * reaches a log, and it was logging `err.message` verbatim. That string can
   * carry the RPC URL, its credentials, an Authorization header and a response
   * body — `describeFailureForLog` is the canonical scrub boundary every other
   * provider-error site in the repo already routes through.
   *
   * The dep is made to throw so the catch is genuinely exercised, rather than
   * asserting on a hand-built string that never met the real code path.
   */
  it("scrubs a provider error instead of logging it verbatim", async () => {
    const logger = (await import("@utils/logger.js")).default;
    const warnSpy = vi.spyOn(logger, "warn").mockReturnThis();
    const canary =
      'Provider 500 https://user:p4ssw0rd@rpc.example.io/v1?key=SECRET123 '
      + 'Authorization: Bearer FASTLANE_CANARY_7 body={"error":{"code":401}}';

    const deps = {
      ...stubDeps(),
      runEvmPendingLane: vi.fn().mockRejectedValue(new Error(canary)),
    };
    const handle = startFastLane({ deps, random: noJitter });

    await vi.advanceTimersByTimeAsync(FAST_LANE_INTERVAL_MS);

    // Serialise EVERYTHING the logger was handed rather than indexing one
    // argument: the logger's type models a single-object overload, so reaching
    // for `call[1]` is both a type error and a weaker assertion. The question
    // this test asks is "does any fragment of the secret appear ANYWHERE in what
    // was logged?", and that is what is checked.
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain("sync.fast_lane.cycle_failed");
    for (const fragment of [
      "p4ssw0rd", "SECRET123", "rpc.example.io", "https://",
      "FASTLANE_CANARY_7", "Bearer",
    ]) {
      expect(logged).not.toContain(fragment);
    }

    warnSpy.mockRestore();
    handle.stop();
  });
});
