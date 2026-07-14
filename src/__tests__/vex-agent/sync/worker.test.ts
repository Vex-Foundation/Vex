import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────

// Mocked so the cause-code diagnostics tests below can assert log meta.
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

const mockClaimAllPending = vi.fn().mockResolvedValue([]);
const mockClaimPendingRun = vi.fn().mockResolvedValue(null);
const mockGetJob = vi.fn().mockResolvedValue(null);
const mockCompleteRun = vi.fn().mockResolvedValue(undefined);
const mockFailRun = vi.fn().mockResolvedValue(undefined);
const mockRecoverStaleRuns = vi.fn().mockResolvedValue(0);

vi.mock("@vex-agent/db/repos/sync.js", () => ({
  claimAllPending: () => mockClaimAllPending(),
  claimPendingRun: () => mockClaimPendingRun(),
  getJob: (...args: unknown[]) => mockGetJob(...args),
  completeRun: (...args: unknown[]) => mockCompleteRun(...args),
  failRun: (...args: unknown[]) => mockFailRun(...args),
  recoverStaleRuns: (...args: unknown[]) => mockRecoverStaleRuns(...args),
  enqueueRun: vi.fn().mockResolvedValue(1),
  getAllJobs: vi.fn().mockResolvedValue([]),
  getLastCompletedRun: vi.fn().mockResolvedValue(null),
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
}));

const mockGetById = vi.fn().mockResolvedValue(null);
vi.mock("@vex-agent/db/repos/executions.js", () => ({
  getById: (...args: unknown[]) => mockGetById(...args),
  recordExecution: vi.fn().mockResolvedValue(1),
}));

const mockSelectiveSync = vi.fn().mockResolvedValue({ walletFamily: "eip155", walletAddress: "0x", tokensUpdated: 5, chainsUpdated: 1, totalUsd: 100 });
vi.mock("../../../vex-agent/sync/balance-sync.js", () => ({
  selectiveBalanceSync: (...args: unknown[]) => mockSelectiveSync(...args),
  fullBalanceSync: vi.fn().mockResolvedValue({ wallets: [], totalUsd: 0, snapshotId: 1, pnlVsPrev: null }),
}));

vi.mock("../../../vex-agent/sync/chains.js", () => ({
  resolveChainHint: vi.fn().mockResolvedValue({ family: "eip155", chainIds: [1] }),
}));

const mockReconcileHyperliquid = vi.fn().mockResolvedValue({
  checked: 1, captured: 1, closed: 0, cancelled: 0, liquidated: 0,
  consolidating: 0, unprotected: 0, skipped: 0, errors: 0,
});
vi.mock("../../../vex-agent/sync/hyperliquid-reconciler.js", () => ({
  reconcileHyperliquid: () => mockReconcileHyperliquid(),
}));

const { drainPendingRuns, processNextRun } = await import("../../../vex-agent/sync/worker.js");

describe("sync worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── drainPendingRuns ──────────────────────────────────────────

  describe("drainPendingRuns", () => {
    it("returns zeros when no pending runs", async () => {
      const result = await drainPendingRuns();
      expect(result).toEqual({ processed: 0, deduped: 0, errors: 0 });
    });

    it("deduplicates multiple balance runs", async () => {
      mockClaimAllPending.mockResolvedValueOnce([
        { id: 1, syncJobId: 10, executionId: 100, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
        { id: 2, syncJobId: 10, executionId: 101, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
        { id: 3, syncJobId: 11, executionId: 102, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
      ]);
      mockGetJob.mockResolvedValue({ id: 10, syncType: "balances", namespace: "solana", strategy: "post_mutation" });

      // Executions have chain hints
      mockGetById
        .mockResolvedValueOnce({ tradeCapture: { chain: "solana" } })
        .mockResolvedValueOnce({ tradeCapture: { chain: "solana" } })
        .mockResolvedValueOnce({ tradeCapture: { chain: "solana" } });

      const result = await drainPendingRuns();

      expect(result.processed).toBe(3);
      expect(result.deduped).toBe(2); // 3 runs but 1 execution batch
      expect(mockCompleteRun).toHaveBeenCalledTimes(3);
    });

    it("derives chain hint from execution trade_capture", async () => {
      mockClaimAllPending.mockResolvedValueOnce([
        { id: 1, syncJobId: 10, executionId: 100, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
      ]);
      mockGetJob.mockResolvedValue({ id: 10, syncType: "balances", namespace: "solana", strategy: "post_mutation" });
      mockGetById.mockResolvedValueOnce({ tradeCapture: { chain: "solana" } });

      await drainPendingRuns();

      // Should have called selectiveBalanceSync with resolved chain
      expect(mockSelectiveSync).toHaveBeenCalled();
    });

    it("falls back to both families when no chain info", async () => {
      mockClaimAllPending.mockResolvedValueOnce([
        { id: 1, syncJobId: 10, executionId: null, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
      ]);
      mockGetJob.mockResolvedValue({ id: 10, syncType: "balances", namespace: "khalani", strategy: "post_mutation" });

      await drainPendingRuns();

      // Should call selective for both eip155 and solana
      expect(mockSelectiveSync).toHaveBeenCalledTimes(2);
      expect(mockSelectiveSync).toHaveBeenCalledWith("eip155");
      expect(mockSelectiveSync).toHaveBeenCalledWith("solana");
    });

    it("dispatches and deduplicates Hyperliquid reconciliation runs", async () => {
      mockClaimAllPending.mockResolvedValueOnce([
        { id: 1, syncJobId: 41, executionId: 1, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
        { id: 2, syncJobId: 42, executionId: 2, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
      ]);
      mockGetJob.mockResolvedValue({ id: 41, syncType: "hyperliquid_reconcile", namespace: "hyperliquid", strategy: "post_mutation" });

      const result = await drainPendingRuns();

      expect(result).toMatchObject({ processed: 2, deduped: 1, errors: 0 });
      expect(mockReconcileHyperliquid).toHaveBeenCalledTimes(1);
      expect(mockCompleteRun).toHaveBeenCalledWith(1, expect.objectContaining({ captured: 1 }), 1);
      expect(mockCompleteRun).toHaveBeenCalledWith(2, expect.objectContaining({ captured: 1 }), 1);
    });

    it("marks all runs as failed on error", async () => {
      mockClaimAllPending.mockResolvedValueOnce([
        { id: 1, syncJobId: 10, executionId: null, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
      ]);
      mockGetJob.mockResolvedValue({ id: 10, syncType: "balances", namespace: "solana", strategy: "post_mutation" });
      mockSelectiveSync.mockRejectedValueOnce(new Error("Khalani down"));

      const result = await drainPendingRuns();

      expect(result.errors).toBe(1);
      expect(mockFailRun).toHaveBeenCalledTimes(1);
      // No errno in the chain → message persisted unchanged.
      expect(mockFailRun).toHaveBeenCalledWith(1, "Khalani down");
    });

    // ── cause-code diagnostics (error-diagnostics phase) ─────────
    it("suffixes the persisted failure with the errno cause code and logs causeCode meta", async () => {
      mockClaimAllPending.mockResolvedValueOnce([
        { id: 1, syncJobId: 10, executionId: null, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
      ]);
      mockGetJob.mockResolvedValue({ id: 10, syncType: "balances", namespace: "solana", strategy: "post_mutation" });
      const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      mockSelectiveSync.mockRejectedValueOnce(new Error("Khalani down", { cause: inner }));

      const result = await drainPendingRuns();

      expect(result.errors).toBe(1);
      expect(mockFailRun).toHaveBeenCalledWith(1, "Khalani down (ECONNRESET)");
      const call = loggerMock.error.mock.calls.find((c) => c[0] === "sync.worker.failed");
      expect(call).toBeDefined();
      const meta = call![1] as Record<string, unknown>;
      expect(meta.causeCode).toBe("ECONNRESET");
      expect(meta.error).toBe("Khalani down");
    });

    // ── B-005: stale `running` recovery ─────────────────────────
    describe("stale running recovery", () => {
      it("recovers stale runs once per drain, before claiming new work", async () => {
        await drainPendingRuns();

        // Recovery runs exactly once per drain with a positive lease timeout.
        expect(mockRecoverStaleRuns).toHaveBeenCalledTimes(1);
        const timeoutArg = mockRecoverStaleRuns.mock.calls[0][0];
        expect(typeof timeoutArg).toBe("number");
        expect(timeoutArg).toBeGreaterThan(0);

        // Recovery must precede the claim — the orphan flip frees nothing to
        // claim here, but the ordering is what makes recovery effective.
        const recoverOrder = mockRecoverStaleRuns.mock.invocationCallOrder[0];
        const claimOrder = mockClaimAllPending.mock.invocationCallOrder[0];
        expect(recoverOrder).toBeLessThan(claimOrder);
      });

      it("recovering a stale orphan does not requeue it (recovered count is observable only)", async () => {
        // Stale orphan flipped to `failed` by recoverStaleRuns; it is NOT
        // returned by claimAllPending (only `pending` rows are claimable), so
        // the drain processes nothing from it — recovered exactly once.
        mockRecoverStaleRuns.mockResolvedValueOnce(1);
        mockClaimAllPending.mockResolvedValueOnce([]);

        const result = await drainPendingRuns();

        expect(result).toEqual({ processed: 0, deduped: 0, errors: 0 });
        expect(mockCompleteRun).not.toHaveBeenCalled();
        expect(mockFailRun).not.toHaveBeenCalled();
      });

      it("does not abort the drain when recovery fails", async () => {
        mockRecoverStaleRuns.mockRejectedValueOnce(new Error("db blip"));
        mockClaimAllPending.mockResolvedValueOnce([
          { id: 1, syncJobId: 10, executionId: null, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0 },
        ]);
        mockGetJob.mockResolvedValue({ id: 10, syncType: "balances", namespace: "khalani", strategy: "post_mutation" });

        const result = await drainPendingRuns();

        // Drain still proceeds despite recovery error.
        expect(result.processed).toBe(1);
        expect(mockClaimAllPending).toHaveBeenCalled();
      });
    });
  });

  // ── processNextRun ────────────────────────────────────────────

  describe("processNextRun", () => {
    it("returns false when no pending runs", async () => {
      expect(await processNextRun()).toBe(false);
    });

    it("derives chain from execution_id", async () => {
      mockClaimPendingRun.mockResolvedValueOnce({
        id: 1, syncJobId: 10, executionId: 100, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0,
      });
      mockGetJob.mockResolvedValueOnce({ id: 10, syncType: "balances", namespace: "solana", strategy: "post_mutation" });
      mockGetById.mockResolvedValueOnce({ tradeCapture: { chain: "polygon" } });

      await processNextRun();

      expect(mockSelectiveSync).toHaveBeenCalledWith("polygon");
      expect(mockCompleteRun).toHaveBeenCalled();
    });

    it("falls back to eip155 when no execution", async () => {
      mockClaimPendingRun.mockResolvedValueOnce({
        id: 1, syncJobId: 10, executionId: null, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0,
      });
      mockGetJob.mockResolvedValueOnce({ id: 10, syncType: "balances", namespace: "khalani", strategy: "post_mutation" });

      await processNextRun();

      expect(mockSelectiveSync).toHaveBeenCalledWith("eip155");
    });

    it("dispatches a single Hyperliquid reconciliation run", async () => {
      mockClaimPendingRun.mockResolvedValueOnce({
        id: 8, syncJobId: 41, executionId: null, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0,
      });
      mockGetJob.mockResolvedValueOnce({ id: 41, syncType: "hyperliquid_reconcile", namespace: "hyperliquid", strategy: "post_mutation" });

      await processNextRun();

      expect(mockReconcileHyperliquid).toHaveBeenCalledTimes(1);
      expect(mockCompleteRun).toHaveBeenCalledWith(8, expect.objectContaining({ checked: 1 }), 1);
    });

    it("suffixes the persisted failure with the errno cause code", async () => {
      mockClaimPendingRun.mockResolvedValueOnce({
        id: 7, syncJobId: 10, executionId: null, status: "running", startedAt: "", endedAt: null, error: null, rowsAffected: 0,
      });
      mockGetJob.mockResolvedValueOnce({ id: 10, syncType: "balances", namespace: "khalani", strategy: "post_mutation" });
      const inner = Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" });
      mockSelectiveSync.mockRejectedValueOnce(new Error("rpc unreachable", { cause: inner }));

      await processNextRun();

      expect(mockFailRun).toHaveBeenCalledWith(7, "rpc unreachable (ENOTFOUND)");
    });
  });
});
