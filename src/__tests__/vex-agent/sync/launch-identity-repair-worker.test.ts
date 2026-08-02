/**
 * The launch identity sweep must actually be REACHABLE.
 *
 * `sync/worker.ts` dispatches by `syncType`; an unknown one logs
 * "Unknown sync type" and skips. The launch sweep was registered nowhere, so
 * crash-recovery for launches was dead code. Both dispatch paths are pinned —
 * the batched drain and the single-run path — because a launch left
 * `broadcast_pending` is a token the user owns and cannot see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRepair = vi.fn().mockResolvedValue({ checked: 2, repaired: 1, indexed: 1, failed: 0, stillPending: 1 });
const mockBuildDeps = vi.fn().mockReturnValue({ resolveLaunchOutcome: async () => null });

vi.mock("../../../vex-agent/sync/launch-identity-repair.js", () => ({
  repairLaunchIdentities: (...a: unknown[]) => mockRepair(...a),
  buildProductionLaunchRepairDeps: () => mockBuildDeps(),
}));

const mockClaimAllPending = vi.fn().mockResolvedValue([]);
const mockClaimPendingRun = vi.fn().mockResolvedValue(null);
const mockGetJob = vi.fn().mockResolvedValue(null);
const mockCompleteRun = vi.fn().mockResolvedValue(undefined);
const mockFailRun = vi.fn().mockResolvedValue(undefined);

vi.mock("@vex-agent/db/repos/sync.js", () => ({
  claimAllPending: () => mockClaimAllPending(),
  claimPendingRun: () => mockClaimPendingRun(),
  getJob: (...a: unknown[]) => mockGetJob(...a),
  completeRun: (...a: unknown[]) => mockCompleteRun(...a),
  failRun: (...a: unknown[]) => mockFailRun(...a),
  recoverStaleRuns: async () => 0,
  enqueueRun: async () => 1,
  getAllJobs: async () => [],
  getLastCompletedRun: async () => null,
  getJobsForNamespace: async () => [],
}));
vi.mock("@vex-agent/db/repos/executions.js", () => ({
  getById: async () => null,
  recordExecution: async () => 1,
}));
vi.mock("../../../vex-agent/sync/balance-sync.js", () => ({
  selectiveBalanceSync: async () => ({ tokensUpdated: 0 }),
  fullBalanceSync: async () => ({ wallets: [], totalUsd: 0 }),
}));

const { drainPendingRuns, processNextRun } = await import("../../../vex-agent/sync/worker.js");

beforeEach(() => {
  mockRepair.mockClear();
  mockCompleteRun.mockClear();
});

describe("worker dispatch for launch_identity_repair", () => {
  it("runs the sweep from the batched drain and reports its rows", async () => {
    mockClaimAllPending.mockResolvedValueOnce([{ id: 11, syncJobId: 3, executionId: null }]);
    mockGetJob.mockResolvedValueOnce({ id: 3, syncType: "launch_identity_repair" });

    const result = await drainPendingRuns();

    expect(mockRepair).toHaveBeenCalledTimes(1);
    expect(result.errors).toBe(0);
    expect(result.processed).toBe(1);
    // repaired + failed — the rows this run moved out of pending.
    expect(mockCompleteRun).toHaveBeenCalledWith(11, expect.objectContaining({ repaired: 1 }), 1);
  });

  it("runs the sweep from the single-run path too", async () => {
    mockClaimPendingRun.mockResolvedValueOnce({ id: 12, syncJobId: 3, executionId: null });
    mockGetJob.mockResolvedValueOnce({ id: 3, syncType: "launch_identity_repair" });

    expect(await processNextRun()).toBe(true);
    expect(mockRepair).toHaveBeenCalledTimes(1);
    expect(mockFailRun).not.toHaveBeenCalled();
  });
});
