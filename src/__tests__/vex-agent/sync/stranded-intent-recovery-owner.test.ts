/**
 * WHO OWNS STRANDED-INTENT CRASH RECOVERY (T4a/T4b).
 *
 * `recoverStrandedTransactionIntents` used to run inside the EVM activity sweep
 * (`agent-activity-repair.ts`), which made a FAMILY-AGNOSTIC recovery
 * conditional on the EVM lane being enabled: with the EVM lane off - the job
 * absent, disabled, or simply not due - a Solana intent left `consuming` by a
 * dead handler was never recovered, and a money-path row stayed stranded for as
 * long as that stayed true.
 *
 * The owner is now `syncTick`, the one tick that runs unconditionally. These
 * cases pin exactly that: recovery happens with NO EVM lane in the job list at
 * all, it happens before the periodic jobs are even consulted, and its failure
 * is reported without stopping the rest of the tick.
 *
 * Mocked-pool unit test, same shape as `index.test.ts`: every dependency
 * `syncTick` touches is mocked, so this exercises ownership and ordering in
 * `sync/index.ts` alone.
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
  fullBalanceSync: vi.fn(),
  selectiveBalanceSync: vi.fn(),
}));

const mockDrainPendingRuns = vi.fn();
vi.mock("../../../vex-agent/sync/worker.js", () => ({
  drainPendingRuns: (...args: unknown[]) => mockDrainPendingRuns(...args),
}));

const mockRecoverStranded = vi.fn();
vi.mock("../../../vex-agent/sync/wallet-transaction-intent-settlement.js", () => ({
  recoverStrandedTransactionIntents: (...args: unknown[]) => mockRecoverStranded(...args),
}));

/** The EVM sweep, mocked so a case that DOES enable it can prove it is not the caller. */
const mockRepairPendingActivity = vi.fn();
const mockBuildProductionRepairDeps = vi.fn();
vi.mock("../../../vex-agent/sync/agent-activity-repair.js", () => ({
  repairPendingActivity: (...args: unknown[]) => mockRepairPendingActivity(...args),
  buildProductionRepairDeps: (...args: unknown[]) => mockBuildProductionRepairDeps(...args),
}));

vi.mock("../../../vex-agent/sync/executed-amount-fallback.js", () => ({
  repairMissingExecutedAmounts: vi.fn().mockResolvedValue({ filled: 0 }),
  buildProductionAmountFallbackDeps: vi.fn().mockReturnValue({}),
}));

const { syncTick } = await import("../../../vex-agent/sync/index.js");

function evmRepairJob() {
  return {
    id: 11,
    namespace: "_global",
    syncType: "agent_activity_repair",
    readToolId: null,
    strategy: "periodic",
    intervalSeconds: 30,
    enabled: true,
    config: {},
  };
}

describe("syncTick owns stranded wallet-transaction-intent recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDrainPendingRuns.mockResolvedValue({ processed: 0, deduped: 0, errors: 0 });
    mockGetLastCompletedRun.mockResolvedValue(null);
    mockEnqueueRun.mockResolvedValue(7);
    mockCompleteRun.mockResolvedValue(undefined);
    mockRecoverStranded.mockResolvedValue({
      examined: 0,
      crashedBeforeBroadcast: 0,
      recoveredUnconfirmed: 0,
    });
  });

  it("recovers stranded intents with the EVM lane DISABLED - no agent_activity_repair job exists at all", async () => {
    mockGetAllJobs.mockResolvedValue([]);

    await syncTick();

    expect(mockRepairPendingActivity).not.toHaveBeenCalled();
    expect(mockRecoverStranded).toHaveBeenCalledTimes(1);
  });

  it("runs recovery exactly once per tick even when the EVM lane IS enabled - the sweep is no longer its caller", async () => {
    mockGetAllJobs.mockResolvedValue([evmRepairJob()]);
    mockBuildProductionRepairDeps.mockReturnValue({ dep: "evm" });
    mockRepairPendingActivity.mockResolvedValue({
      checked: 0, confirmed: 0, failed: 0, stillPending: 0,
    });

    await syncTick();

    expect(mockRepairPendingActivity).toHaveBeenCalledTimes(1);
    expect(mockRecoverStranded).toHaveBeenCalledTimes(1);
  });

  it("runs recovery BEFORE the job list is read, so a failing job list cannot strand an intent", async () => {
    const order: string[] = [];
    mockRecoverStranded.mockImplementation(async () => {
      order.push("recover");
      return { examined: 0, crashedBeforeBroadcast: 0, recoveredUnconfirmed: 0 };
    });
    mockGetAllJobs.mockImplementation(async () => {
      order.push("jobs");
      return [];
    });

    await syncTick();

    expect(order).toEqual(["recover", "jobs"]);
  });

  it("logs and continues the tick when recovery itself throws", async () => {
    mockGetAllJobs.mockResolvedValue([]);
    mockRecoverStranded.mockRejectedValue(new Error("pool unavailable"));

    await expect(syncTick()).resolves.toBeUndefined();

    expect(loggerMock.warn).toHaveBeenCalledWith(
      "sync.tick.stranded_intent_recovery_failed",
      expect.objectContaining({ error: "pool unavailable" }),
    );
    expect(mockDrainPendingRuns).toHaveBeenCalledTimes(1);
  });
});
