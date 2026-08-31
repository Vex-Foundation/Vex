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
const mockGetPortfolioValuation = vi.fn().mockResolvedValue({
  totalUsdEstimate: 34.4,
  pricedRowCount: 2,
  unpricedRowCount: 0,
  oldestSyncedAt: "2026-08-10T13:40:04.000Z",
  newestSyncedAt: "2026-08-10T13:42:04.000Z",
});
const mockGetRun = vi.fn();

vi.mock("@vex-agent/db/repos/balances.js", () => ({
  getTotalUsd: (...a: unknown[]) => mockGetTotalUsd(...a),
  getLatestAggregateSnapshot: (...a: unknown[]) => mockGetLatestAggregateSnapshot(...a),
  getAggregateSnapshots: (...a: unknown[]) => mockGetAggregateSnapshots(...a),
  getPortfolioValuation: (...a: unknown[]) => mockGetPortfolioValuation(...a),
}));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  getRun: (...a: unknown[]) => mockGetRun(...a),
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

/** The structured block, without a non-null assertion at every read site. */
function dataOf(result: { data?: Record<string, unknown> }): Record<string, unknown> {
  const { data } = result;
  if (data === undefined) throw new Error("tool result carried no structured data");
  return data;
}

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

    // `proj_activity.input_amount`/`output_amount` are written VERBATIM from
    // each tool's `_tradeCapture` (activity-populator.ts) — no unit
    // normalisation anywhere. The only live writers of those fields are the
    // Pendle handlers, and they write RAW base units deliberately (the spot
    // lot projector BigInt()s them). rules/90: a raw amount must travel with
    // the decimals needed to read it, so a raw row must SAY it is raw.
    function activityRow(over: Record<string, unknown> = {}) {
      return {
        namespace: "pendle", activityType: "swap", productType: "spot", tradeSide: "buy",
        chain: "arbitrum", inputToken: "PT-wstETH", inputAmount: "1047061",
        outputToken: "USDC", outputAmount: "2000000",
        inputValueUsd: null, outputValueUsd: null, valuationSource: "pendle",
        captureStatus: "executed", createdAt: "2026-07-30T00:00:00.000Z",
        ...over,
      };
    }

    it("labels Pendle amounts as raw base units, on both legs", async () => {
      mockGetActivities.mockResolvedValueOnce([activityRow()]);
      const r = await handleAgentScan({ view: "activity" }, ctx);
      const [row] = r.data!.activities as Array<Record<string, unknown>>;
      expect(row!.input).toBe("1047061 PT-wstETH (raw base units — resolve decimals before quoting)");
      expect(row!.output).toBe("2000000 USDC (raw base units — resolve decimals before quoting)");
    });

    it("leaves a non-raw-source row's amounts exactly as before", async () => {
      mockGetActivities.mockResolvedValueOnce([
        activityRow({ namespace: "solana", inputToken: "SOL", inputAmount: "1.5", outputToken: null }),
      ]);
      const r = await handleAgentScan({ view: "activity" }, ctx);
      const [row] = r.data!.activities as Array<Record<string, unknown>>;
      expect(row!.input).toBe("1.5 SOL");
      expect(row!.output).toBeNull();
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

  // The mission start baseline: a frozen figure the agent compares against, so
  // the view must never present an unreadable or missing one as usable.
  describe("mission_baseline", () => {
    const RECORDED_BLOB = {
      version: 1,
      capturedAt: "2026-08-10T13:12:30.000Z",
      status: "recorded",
      reasons: [],
      source: "proj_balances",
      scope: { addresses: ["0xEVM", "SOL"] },
      portfolio: {
        totalUsdEstimate: 32.1,
        pricedRowCount: 2,
        unpricedRowCount: 0,
        oldestSyncedAt: "2026-08-10T13:10:04.000Z",
        newestSyncedAt: "2026-08-10T13:12:04.000Z",
      },
      deployedCapitalAtStart: {
        chainId: 4663,
        assetAddress: "0x0f9f",
        assetKind: "token",
        assetSymbol: "VEX",
        declaredAmountRaw: "3044000000000000000000",
        declaredDecimals: 18,
        heldAmountRaw: "6802264854000000000000",
        heldDecimals: 18,
        heldUsdEstimate: 1.98,
      },
    };

    const missionCtx = makeTestContext({ sessionId: "s1", missionRunId: "run-1" });

    it("refuses outside an active mission run and points at the views that do work", async () => {
      const r = await handleAgentScan({ view: "mission_baseline" }, ctx);
      expect(r.success).toBe(false);
      expect(r.output).toContain("only available during an active mission run");
      expect(r.output).toContain('view="transactions"');
      expect(mockGetRun).not.toHaveBeenCalled();
    });

    it("reports an unrecorded baseline as absent instead of inventing a start value", async () => {
      mockGetRun.mockResolvedValueOnce({ id: "run-1", baselineJson: null });
      const r = await handleAgentScan({ view: "mission_baseline" }, missionCtx);
      expect(r.success).toBe(true);
      expect(dataOf(r).status).toBe("absent");
      expect(dataOf(r).reasons).toEqual(["not_recorded"]);
      expect(String(dataOf(r).note)).toContain("Do not assume a start value");
    });

    it("an unreadable stored blob reads as absent, never as a usable figure", async () => {
      mockGetRun.mockResolvedValueOnce({ id: "run-1", baselineJson: { version: 99 } });
      const r = await handleAgentScan({ view: "mission_baseline" }, missionCtx);
      expect(dataOf(r).status).toBe("absent");
      expect(dataOf(r).reasons).toEqual(["not_recorded"]);
    });

    it("returns the frozen start, the now figure over the SAME wallet set, and the change", async () => {
      mockGetRun.mockResolvedValueOnce({ id: "run-1", baselineJson: RECORDED_BLOB });
      const r = await handleAgentScan({ view: "mission_baseline" }, missionCtx);
      expect(r.success).toBe(true);
      expect(mockGetPortfolioValuation).toHaveBeenCalledWith(["0xEVM", "SOL"]);
      expect(dataOf(r).status).toBe("recorded");
      expect(dataOf(r).scopeAddresses).toEqual(["0xEVM", "SOL"]);
      expect((dataOf(r).start as Record<string, unknown>).totalUsdEstimate).toBe(32.1);
      expect((dataOf(r).now as Record<string, unknown>).totalUsdEstimate).toBe(34.4);
      expect(dataOf(r).changeSinceStartUsdEstimate).toBeCloseTo(2.3, 6);
      const deployed = dataOf(r).deployedCapital as Record<string, unknown>;
      expect(deployed.assetKind).toBe("token");
      expect(deployed.declaredAmountHuman).toBe("3044");
      expect(deployed.heldAtStartHuman).toBe("6802.264854");
      expect(String(dataOf(r).note)).toContain("not trade PnL");
      expect(dataOf(r).scopeNote).toBeUndefined();
    });

    it("a failed now read leaves the frozen start standing and names the gap", async () => {
      mockGetRun.mockResolvedValueOnce({ id: "run-1", baselineJson: RECORDED_BLOB });
      mockGetPortfolioValuation.mockRejectedValueOnce(new Error("db down"));
      const r = await handleAgentScan({ view: "mission_baseline" }, missionCtx);
      expect(r.success).toBe(true);
      expect((dataOf(r).start as Record<string, unknown>).totalUsdEstimate).toBe(32.1);
      expect(dataOf(r).now).toBeNull();
      expect(dataOf(r).changeSinceStartUsdEstimate).toBeNull();
    });

    // Base58 case IS identity on Solana: two mint-style addresses differing
    // only in case are DIFFERENT wallets, and folding their case would hide a
    // real scope divergence behind a clean-looking comparison.
    it("two Solana wallets differing only in case are a divergence, not a match", async () => {
      const frozen = { ...RECORDED_BLOB, scope: { addresses: ["AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK"] } };
      mockResolveSet.mockReturnValueOnce({
        evm: null,
        solana: "abcdefghjklmnpqrstuvwxyz123456789abcdefghjk",
        all: ["abcdefghjklmnpqrstuvwxyz123456789abcdefghjk"],
      });
      mockGetRun.mockResolvedValueOnce({ id: "run-1", baselineJson: frozen });
      const r = await handleAgentScan({ view: "mission_baseline" }, missionCtx);
      expect(mockGetPortfolioValuation).toHaveBeenCalledWith(["AbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGHJK"]);
      expect(String(dataOf(r).scopeNote)).toContain("differ from the wallets this baseline was recorded for");
    });

    // EVM addresses ARE case-insensitive: a checksum rewrite is the same wallet.
    it("an EVM checksum rewrite of the same wallet is not a divergence", async () => {
      const frozen = { ...RECORDED_BLOB, scope: { addresses: ["0xAbCdEf0123456789AbCdEf0123456789AbCdEf01"] } };
      mockResolveSet.mockReturnValueOnce({
        evm: "0xabcdef0123456789abcdef0123456789abcdef01",
        solana: null,
        all: ["0xabcdef0123456789abcdef0123456789abcdef01"],
      });
      mockGetRun.mockResolvedValueOnce({ id: "run-1", baselineJson: frozen });
      const r = await handleAgentScan({ view: "mission_baseline" }, missionCtx);
      expect(dataOf(r).scopeNote).toBeUndefined();
    });

    it("says so when the session's selected wallets differ from the recorded set", async () => {
      mockResolveSet.mockReturnValueOnce({ evm: "0xOTHER", solana: null, all: ["0xOTHER"] });
      mockGetRun.mockResolvedValueOnce({ id: "run-1", baselineJson: RECORDED_BLOB });
      const r = await handleAgentScan({ view: "mission_baseline" }, missionCtx);
      // The figures still use the RECORDED set, or the comparison is not like for like.
      expect(mockGetPortfolioValuation).toHaveBeenCalledWith(["0xEVM", "SOL"]);
      expect(String(dataOf(r).scopeNote)).toContain("differ from the wallets this baseline was recorded for");
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

    it("mission_baseline fails closed on scope drift too, before any run read", async () => {
      mockResolveSet.mockImplementationOnce(() => {
        throw new VexError(ErrorCodes.WALLET_SCOPE_MISMATCH, "contract drift");
      });
      const r = await handleAgentScan(
        { view: "mission_baseline" },
        makeTestContext({ sessionId: "s1", missionRunId: "run-1" }),
      );
      expect(r.success).toBe(false);
      expect(mockGetRun).not.toHaveBeenCalled();
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
