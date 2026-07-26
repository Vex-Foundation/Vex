import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetActivities = vi.fn().mockResolvedValue([]);
const mockGetByNamespace = vi.fn().mockResolvedValue([]);
const mockGetTotalUsd = vi.fn().mockResolvedValue(0);
const mockGetLatestAggregateSnapshot = vi.fn().mockResolvedValue(null);
const mockGetAggregateSnapshots = vi.fn().mockResolvedValue([]);
const mockGetOpen = vi.fn().mockResolvedValue([]);
const mockResolveSet = vi.fn().mockReturnValue({ evm: "0xEVM", solana: "SOL", all: ["0xEVM", "SOL"] });

vi.mock("@vex-agent/db/repos/open-positions.js", () => ({
  getOpen: (...a: unknown[]) => mockGetOpen(...a),
}));
vi.mock("@vex-agent/db/repos/activity.js", () => ({
  getActivities: (...a: unknown[]) => mockGetActivities(...a),
}));
vi.mock("@vex-agent/db/repos/executions.js", () => ({
  getByNamespace: (...a: unknown[]) => mockGetByNamespace(...a),
}));
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  getTotalUsd: (...a: unknown[]) => mockGetTotalUsd(...a),
  getLatestAggregateSnapshot: (...a: unknown[]) => mockGetLatestAggregateSnapshot(...a),
  getAggregateSnapshots: (...a: unknown[]) => mockGetAggregateSnapshots(...a),
}));

// Mock ONLY resolveSelectedAddressSetForRead (the read-side resolver the
// agent_scan handler uses — mission setup may READ its own wallet) so the handler
// test controls the wallet set; keep the REAL walletScopeErrorToResult so
// fail-closed behaviour is real.
vi.mock("../../../../vex-agent/tools/internal/wallet/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../vex-agent/tools/internal/wallet/resolve.js")>(
    "../../../../vex-agent/tools/internal/wallet/resolve.js",
  );
  return { ...actual, resolveSelectedAddressSetForRead: (...a: unknown[]) => mockResolveSet(...a) };
});

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(), query: vi.fn().mockResolvedValue([]), queryOne: vi.fn().mockResolvedValue(null),
}));

const { handleAgentScan } = await import("../../../../vex-agent/tools/internal/portfolio-inspect.js");
import { makeTestContext } from "../_test-context.js";
import { VexError, ErrorCodes } from "../../../../errors.js";

const ctx = makeTestContext({ sessionId: "s1" });

describe("agent_scan tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveSet.mockReturnValue({ evm: "0xEVM", solana: "SOL", all: ["0xEVM", "SOL"] });
  });

  it("rejects invalid view", async () => {
    const r = await handleAgentScan({ view: "invalid" }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toContain("Invalid view");
  });

  // Deleted views (Agent Scan plan v3 §1.9/§4.7 — the profit-computation
  // system and the LP/position/order lifecycle views are gone; the agent
  // reads history through `transactions`): open_positions, closed_positions,
  // orders, lots, profits, unrealized, bridges, lp_history,
  // non_trading_history all reject the same way `invalid` does now.
  it("rejects a deleted view name", async () => {
    for (const deletedView of [
      "open_positions", "closed_positions", "orders",
      "lots", "profits", "unrealized",
      "bridges", "lp_history", "non_trading_history",
    ]) {
      const r = await handleAgentScan({ view: deletedView }, ctx);
      expect(r.success, deletedView).toBe(false);
      expect(r.output, deletedView).toContain("Invalid view");
    }
  });

  describe("activity", () => {
    it("passes the wallet set + filters to getActivities", async () => {
      await handleAgentScan({ view: "activity", namespace: "khalani", productType: "bridge", limit: 5 }, ctx);
      expect(mockGetActivities).toHaveBeenCalledWith({ addresses: ["0xEVM", "SOL"], namespace: "khalani", productType: "bridge", limit: 5 });
    });
  });

  describe("executions", () => {
    it("works without namespace (full history)", async () => {
      const r = await handleAgentScan({ view: "executions" }, ctx);
      expect(r.success).toBe(true);
    });

    it("passes namespace and limit", async () => {
      await handleAgentScan({ view: "executions", namespace: "solana", limit: 10 }, ctx);
      expect(mockGetByNamespace).toHaveBeenCalledWith("solana", 10);
    });
  });

  describe("balances", () => {
    it("returns totalUsd", async () => {
      mockGetTotalUsd.mockResolvedValueOnce(1234.56);
      const r = await handleAgentScan({ view: "balances" }, ctx);
      expect(r.data!.totalUsd).toBe(1234.56);
    });
  });

  describe("snapshots", () => {
    it("calls getAggregateSnapshots with the wallet set + 7d", async () => {
      await handleAgentScan({ view: "snapshots" }, ctx);
      expect(mockGetAggregateSnapshots).toHaveBeenCalledWith(["0xEVM", "SOL"], "7d");
    });
  });

  describe("summary — balances-only (no PnL)", () => {
    it("aggregates totalUsd + open position count + latest snapshot, with no PnL fields", async () => {
      mockGetTotalUsd.mockResolvedValueOnce(5000);
      mockGetOpen.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
      mockGetLatestAggregateSnapshot.mockResolvedValueOnce({
        totalUsd: 4900, pnlVsPrev: 100, pnlPctVsPrev: 2.08,
        activeChains: ["1"], at: "2026-03-29",
      });
      const r = await handleAgentScan({ view: "summary" }, ctx);
      expect(r.data!.totalBalanceUsd).toBe(5000);
      expect(r.data!.openPositionCount).toBe(2);
      expect(r.data!.latestSnapshot).toEqual({
        totalUsd: 4900, pnlVsPrev: 100, activeChains: ["1"], at: "2026-03-29",
      });
      // No realized/unrealized PnL surface survives the teardown.
      expect(r.data).not.toHaveProperty("realizedPnlUsd");
      expect(r.data).not.toHaveProperty("unrealizedPnlUsd");
      expect(r.data).not.toHaveProperty("openSpotLotCount");
      // Never queries the deleted PnL repos/tables.
      expect(mockGetTotalUsd).toHaveBeenCalledTimes(1);
    });

    it("null latestSnapshot when none exists yet", async () => {
      mockGetTotalUsd.mockResolvedValueOnce(0);
      mockGetOpen.mockResolvedValueOnce([]);
      mockGetLatestAggregateSnapshot.mockResolvedValueOnce(null);
      const r = await handleAgentScan({ view: "summary" }, ctx);
      expect(r.data!.latestSnapshot).toBeNull();
      expect(r.data!.openPositionCount).toBe(0);
    });
  });

  describe("per-session wallet scoping", () => {
    it("scopes reads to ONLY the session's selected wallet set", async () => {
      mockResolveSet.mockReturnValueOnce({ evm: "0xEVM", solana: "SOL", all: ["0xEVM", "SOL"] });
      mockGetTotalUsd.mockResolvedValueOnce(777);
      const r = await handleAgentScan({ view: "balances" }, ctx);
      expect(mockGetTotalUsd).toHaveBeenCalledWith(["0xEVM", "SOL"]);
      expect(r.data!.totalUsd).toBe(777);
    });

    it("a session with no selected wallets passes an EMPTY set (never global)", async () => {
      mockResolveSet.mockReturnValueOnce({ evm: null, solana: null, all: [] });
      await handleAgentScan({ view: "summary" }, ctx);
      expect(mockGetTotalUsd).toHaveBeenCalledWith([]);
    });

    it("fails closed on invalid wallet policy / scope drift (no repo query)", async () => {
      mockResolveSet.mockImplementationOnce(() => {
        throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "contract drift");
      });
      const r = await handleAgentScan({ view: "summary" }, ctx);
      expect(r.success).toBe(false);
      expect(mockGetTotalUsd).not.toHaveBeenCalled();
    });
  });
});
