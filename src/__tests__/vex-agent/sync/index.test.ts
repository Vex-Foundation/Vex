/**
 * `syncTick()`'s periodic-jobs branch dispatch (`sync/index.ts`) — C1 fix
 * (Batch 4 closure, Codex-verified blocker): `bridge_activity_repair` is
 * seeded (`seed.ts`, periodic/120s) and dispatched on-demand
 * (`worker.ts`'s `drainPendingRuns`/`processNextRun`) but had NO `syncTick()`
 * branch, so its own periodic timer never actually fired it (nothing ever
 * enqueues a `pending` run row for it otherwise). This suite pins the new
 * branch, mirroring the already-tested-by-precedent shape of the sibling
 * `agent_activity_repair`/`solana_activity_repair` branches.
 *
 * Mocked-pool-adjacent unit test: every dependency `syncTick()` touches is
 * mocked (sync repo, `./worker.js`, `./balance-sync.js`, the dynamically
 * imported `./bridge-activity-repair.js`) so this suite exercises ONLY the
 * dispatch/gating logic in `sync/index.ts` itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));
vi.mock("@utils/logger.js", () => ({
  default: loggerMock,
  logger: loggerMock,
  createChildLogger: () => loggerMock,
}));

const mockGetAllJobs = vi.fn();
const mockGetLastCompletedRun = vi.fn();
const mockEnqueueRun = vi.fn();
const mockCompleteRun = vi.fn();

vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getAllJobs: (...args: unknown[]) => mockGetAllJobs(...args),
  getLastCompletedRun: (...args: unknown[]) => mockGetLastCompletedRun(...args),
  enqueueRun: (...args: unknown[]) => mockEnqueueRun(...args),
  completeRun: (...args: unknown[]) => mockCompleteRun(...args),
}));

vi.mock("../../../vex-agent/sync/balance-sync.js", () => ({
  fullBalanceSync: vi.fn().mockResolvedValue({ wallets: [], totalUsd: 0, snapshots: [], snapshotGroupId: null }),
  selectiveBalanceSync: vi.fn(),
}));

const mockDrainPendingRuns = vi.fn();
vi.mock("../../../vex-agent/sync/worker.js", () => ({
  drainPendingRuns: (...args: unknown[]) => mockDrainPendingRuns(...args),
}));

const mockRepairPendingBridges = vi.fn();
const mockBuildProductionBridgeRepairDeps = vi.fn();
vi.mock("../../../vex-agent/sync/bridge-activity-repair.js", () => ({
  repairPendingBridges: (...args: unknown[]) => mockRepairPendingBridges(...args),
  buildProductionBridgeRepairDeps: (...args: unknown[]) => mockBuildProductionBridgeRepairDeps(...args),
}));

const { syncTick } = await import("../../../vex-agent/sync/index.js");

function bridgeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42,
    namespace: "_global",
    syncType: "bridge_activity_repair",
    readToolId: null,
    strategy: "periodic",
    intervalSeconds: 120,
    enabled: true,
    config: {},
    ...overrides,
  };
}

describe("syncTick — bridge_activity_repair periodic branch (C1 fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDrainPendingRuns.mockResolvedValue({ processed: 0, deduped: 0, errors: 0 });
    mockGetLastCompletedRun.mockResolvedValue(null);
    mockEnqueueRun.mockResolvedValue(7);
    mockCompleteRun.mockResolvedValue(undefined);
    mockBuildProductionBridgeRepairDeps.mockReturnValue({ dep: "bridge" });
  });

  it("dispatches the seeded bridge_activity_repair job when due, mirroring the agent_activity_repair/solana_activity_repair branches", async () => {
    mockGetAllJobs.mockResolvedValue([bridgeJob()]);
    mockRepairPendingBridges.mockResolvedValue({
      checked: 3, confirmed: 2, failed: 1, refunded: 0, recovered: 0, balanceReconciled: 0, stillPending: 0,
    });

    await syncTick();

    expect(mockBuildProductionBridgeRepairDeps).toHaveBeenCalledTimes(1);
    expect(mockRepairPendingBridges).toHaveBeenCalledWith({ dep: "bridge" });
    expect(mockEnqueueRun).toHaveBeenCalledWith(42);
    expect(mockCompleteRun).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ periodic: true, confirmed: 2, failed: 1 }),
      3, // confirmed + failed
    );
  });

  it("does not fire before the job's own interval has elapsed (same periodic gating as every other periodic job)", async () => {
    mockGetAllJobs.mockResolvedValue([bridgeJob()]);
    mockGetLastCompletedRun.mockResolvedValue({
      id: 1,
      syncJobId: 42,
      executionId: null,
      status: "completed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: null,
      rowsAffected: 0,
    });

    await syncTick();

    expect(mockRepairPendingBridges).not.toHaveBeenCalled();
    expect(mockCompleteRun).not.toHaveBeenCalled();
  });

  it("logs a warning and does not throw when the sweep itself fails", async () => {
    mockGetAllJobs.mockResolvedValue([bridgeJob()]);
    mockRepairPendingBridges.mockRejectedValue(new Error("rpc down"));

    await expect(syncTick()).resolves.toBeUndefined();

    expect(loggerMock.warn).toHaveBeenCalledWith(
      "sync.tick.periodic_failed",
      expect.objectContaining({ syncType: "bridge_activity_repair" }),
    );
    expect(mockCompleteRun).not.toHaveBeenCalled();
  });
});
