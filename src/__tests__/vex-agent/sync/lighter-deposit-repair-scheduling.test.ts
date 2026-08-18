import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  seedSyncJobs: vi.fn(),
  drainPendingRuns: vi.fn(),
  fullBalanceSync: vi.fn(),
  rearmPendingFastLanes: vi.fn(),
  getAllJobs: vi.fn(),
  getLastCompletedRun: vi.fn(),
  enqueueRun: vi.fn(),
  completeRun: vi.fn(),
  repairDeposits: vi.fn(),
  repairOrders: vi.fn(),
}));

vi.mock("../../../vex-agent/sync/seed.js", () => ({
  seedSyncJobs: mocks.seedSyncJobs,
}));
vi.mock("../../../vex-agent/sync/worker.js", () => ({
  drainPendingRuns: mocks.drainPendingRuns,
}));
vi.mock("../../../vex-agent/sync/balance-sync.js", () => ({
  fullBalanceSync: mocks.fullBalanceSync,
}));
vi.mock("../../../vex-agent/sync/fast-lane.js", () => ({
  rearmPendingFastLanes: mocks.rearmPendingFastLanes,
}));
vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getAllJobs: mocks.getAllJobs,
  getLastCompletedRun: mocks.getLastCompletedRun,
  enqueueRun: mocks.enqueueRun,
  completeRun: mocks.completeRun,
}));
vi.mock("../../../vex-agent/sync/lighter-deposit-repair.js", () => ({
  repairUnresolvedLighterDeposits: mocks.repairDeposits,
}));
vi.mock("@vex-agent/tools/protocols/lighter/order-repair.js", () => ({
  repairUnresolvedLighterOrdersInBackground: mocks.repairOrders,
}));
vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { initSync, syncTick } = await import("../../../vex-agent/sync/index.js");

const REPAIR_REPORT = {
  examined: 2,
  advanced: 1,
  awaiting: 1,
  failed: 0,
  errors: 0,
  reports: [],
};

const ORDER_REPAIR_REPORT = {
  examined: 3,
  advanced: 1,
  awaiting: 1,
  degraded: 1,
  errors: 0,
  reports: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.seedSyncJobs.mockResolvedValue(undefined);
  mocks.drainPendingRuns.mockResolvedValue({ processed: 0, deduped: 0, errors: 0 });
  mocks.fullBalanceSync.mockResolvedValue({
    totalUsd: 0,
    wallets: [],
    snapshots: [],
    snapshotGroupId: null,
  });
  mocks.rearmPendingFastLanes.mockResolvedValue(undefined);
  mocks.repairDeposits.mockResolvedValue(REPAIR_REPORT);
  mocks.repairOrders.mockResolvedValue(ORDER_REPAIR_REPORT);
  mocks.getAllJobs.mockResolvedValue([]);
  mocks.getLastCompletedRun.mockResolvedValue(null);
  mocks.enqueueRun.mockResolvedValue(91);
  mocks.completeRun.mockResolvedValue(undefined);
});

describe("Lighter deposit repair scheduling", () => {
  it("runs an evidence-only repair pass during startup", async () => {
    await initSync();

    expect(mocks.repairDeposits).toHaveBeenCalledTimes(1);
    expect(mocks.repairDeposits.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fullBalanceSync.mock.invocationCallOrder[0]!,
    );
  });

  it("runs and records the periodic repair job when due", async () => {
    mocks.getAllJobs.mockResolvedValueOnce([
      {
        id: 44,
        namespace: "_global",
        syncType: "lighter_deposit_repair",
        strategy: "periodic",
        intervalSeconds: 30,
        enabled: true,
      },
    ]);

    await syncTick();

    expect(mocks.repairDeposits).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueRun).toHaveBeenCalledWith(44);
    expect(mocks.completeRun).toHaveBeenCalledWith(
      91,
      expect.objectContaining({ periodic: true, examined: 2, advanced: 1 }),
      1,
    );
  });
});

describe("Lighter order nonce-repair scheduling", () => {
  it("runs a bounded public-evidence repair pass during startup", async () => {
    await initSync();

    expect(mocks.repairOrders).toHaveBeenCalledTimes(1);
    expect(mocks.repairOrders.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fullBalanceSync.mock.invocationCallOrder[0]!,
    );
  });

  it("runs and records the periodic repair job when due", async () => {
    mocks.getAllJobs.mockResolvedValueOnce([
      {
        id: 45,
        namespace: "_global",
        syncType: "lighter_order_repair",
        strategy: "periodic",
        intervalSeconds: 300,
        enabled: true,
      },
    ]);

    await syncTick();

    expect(mocks.repairOrders).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueRun).toHaveBeenCalledWith(45);
    expect(mocks.completeRun).toHaveBeenCalledWith(
      91,
      expect.objectContaining({ periodic: true, examined: 3, advanced: 1 }),
      1,
    );
  });
});
