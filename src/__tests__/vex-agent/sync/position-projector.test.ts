import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────

const mockUpsertPosition = vi.fn().mockResolvedValue(undefined);
const mockClosePosition = vi.fn().mockResolvedValue(true);

const mockGetByPositionKey = vi.fn().mockResolvedValue(null);

vi.mock("@vex-agent/db/repos/open-positions.js", () => ({
  upsertPosition: (...args: unknown[]) => mockUpsertPosition(...args),
  closePosition: (...args: unknown[]) => mockClosePosition(...args),
  getByPositionKey: (...args: unknown[]) => mockGetByPositionKey(...args),
}));

const mockOpenLot = vi.fn().mockResolvedValue(1);
const mockGetOpenLots = vi.fn().mockResolvedValue([]);
const mockReduceLot = vi.fn().mockResolvedValue(undefined);

vi.mock("@vex-agent/db/repos/pnl-lots.js", () => ({
  openLot: (...args: unknown[]) => mockOpenLot(...args),
  getOpenLots: (...args: unknown[]) => mockGetOpenLots(...args),
  reduceLot: (...args: unknown[]) => mockReduceLot(...args),
}));

// DB client mock for transactional sell path
const queryResults: Record<string, unknown>[] = [];
const mockClientQuery = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
  if (typeof sql === "string" && sql.includes("SELECT * FROM proj_pnl_lots")) {
    return { rows: queryResults.splice(0) };
  }
  return { rows: [], rowCount: 1 };
});
const mockClient = {
  query: mockClientQuery,
  release: vi.fn(),
};

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => ({ connect: () => Promise.resolve(mockClient) }),
}));

// LP economics mocks (lazy-imported by projectLpLifecycle → recordLpEconomics)
const mockInsertLpEvent = vi.fn().mockResolvedValue(1);
const mockInsertLpLegs = vi.fn().mockResolvedValue(undefined);

vi.mock("@vex-agent/db/repos/lp-events.js", () => ({
  insertLpEvent: (...args: unknown[]) => mockInsertLpEvent(...args),
  insertLpLegs: (...args: unknown[]) => mockInsertLpLegs(...args),
}));

const mockExtractLpLegs = vi.fn().mockReturnValue([]);
const mockExtractFeeCollectedUsd = vi.fn().mockReturnValue(undefined);

vi.mock("../../../vex-agent/sync/lp-economics.js", () => ({
  extractLpLegs: (...args: unknown[]) => mockExtractLpLegs(...args),
  extractFeeCollectedUsd: (...args: unknown[]) => mockExtractFeeCollectedUsd(...args),
}));

const { projectPosition } = await import("../../../vex-agent/sync/position-projector.js");

function makeActivity(overrides: Record<string, unknown>) {
  return {
    id: 1, namespace: "solana", activityType: "perps", productType: "perps",
    tradeSide: null, chain: "solana", executionId: 100, walletAddress: "0xWallet",
    inputToken: null, inputAmount: null, outputToken: null, outputAmount: null,
    valueUsd: null, inputValueUsd: null, outputValueUsd: null, feeValueUsd: null,
    unitPriceUsd: null, valuationSource: null,
    captureStatus: null, positionKey: null, instrumentKey: null,
    externalRefs: {}, meta: {}, createdAt: new Date().toISOString(),
    captureItemId: null,
    ...overrides,
  } as any;
}

describe("position-projector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.length = 0;
  });

  // ── Perps — uses captureStatus from _tradeCapture.status ──────

  describe("perps", () => {
    it("opens position when captureStatus=executed", async () => {
      await projectPosition(makeActivity({
        productType: "perps", positionKey: "PK1", captureStatus: "executed",
        instrumentKey: "solana:perps:SOL",
      }));
      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
      expect(mockUpsertPosition.mock.calls[0][0].status).toBe("open");
    });

    it("projects capture-derived Hyperliquid MTM fields without a direct sync write", async () => {
      await projectPosition(makeActivity({
        namespace: "hyperliquid", chain: "hyperliquid", productType: "perps",
        positionKey: "hyperliquid:perp:BTC:0xWallet", captureStatus: "open",
        meta: { contracts: "1", currentValueUsd: "100", unrealizedPnlUsd: "20" },
      }));
      expect(mockUpsertPosition.mock.calls[0][0]).toMatchObject({
        currentValueUsd: "100",
        unrealizedPnlUsd: "20",
      });
    });

    it("closes position when captureStatus=closed", async () => {
      await projectPosition(makeActivity({
        productType: "perps", positionKey: "PK1", captureStatus: "closed",
      }));
      expect(mockClosePosition).toHaveBeenCalledWith("solana", "perps", "solana", "0xWallet", "PK1", "closed");
    });

    it("retains a liquidation status from a synthetic reconciliation capture", async () => {
      await projectPosition(makeActivity({
        namespace: "hyperliquid", chain: "hyperliquid", productType: "perps",
        positionKey: "hyperliquid:perp:BTC:0xWallet", captureStatus: "liquidated",
      }));
      expect(mockClosePosition).toHaveBeenCalledWith(
        "hyperliquid", "perps", "hyperliquid", "0xWallet", "hyperliquid:perp:BTC:0xWallet", "liquidated",
      );
    });

    it("skips when no positionKey", async () => {
      await projectPosition(makeActivity({ productType: "perps", captureStatus: "executed" }));
      expect(mockUpsertPosition).not.toHaveBeenCalled();
    });
  });

  // ── Predictions ───────────────────────────────────────────────

  describe("predictions", () => {
    it("opens on captureStatus=open with entry price", async () => {
      await projectPosition(makeActivity({
        productType: "prediction", positionKey: "PK_pred", captureStatus: "open",
        instrumentKey: "solana:predict:abc:yes",
        unitPriceUsd: "0.65", inputValueUsd: "2.00", feeValueUsd: "0.02",
      }));
      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
      expect(mockUpsertPosition.mock.calls[0][0].entryPriceUsd).toBe("0.65");
      expect(mockUpsertPosition.mock.calls[0][0].notionalUsd).toBe("2.00");
      expect(mockUpsertPosition.mock.calls[0][0].feeUsd).toBe("0.02");
    });

    it("closes on captureStatus=claimed", async () => {
      await projectPosition(makeActivity({
        productType: "prediction", positionKey: "PK_pred", captureStatus: "claimed",
      }));
      expect(mockClosePosition).toHaveBeenCalledWith("solana", "prediction", "solana", "0xWallet", "PK_pred", "closed");
    });

    it("cancels on captureStatus=cancelled", async () => {
      await projectPosition(makeActivity({
        productType: "prediction", positionKey: "PK_pred", captureStatus: "cancelled",
      }));
      expect(mockClosePosition).toHaveBeenCalledWith("solana", "prediction", "solana", "0xWallet", "PK_pred", "cancelled");
    });
  });

  // ── Order lifecycle (DCA/limit) — NOT spot lots ───────────────

  describe("order lifecycle", () => {
    it("opens order position on captureStatus=open", async () => {
      await projectPosition(makeActivity({
        productType: "order", positionKey: "orderKey123", captureStatus: "open",
        instrumentKey: "solana:USDC",
      }));
      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
      expect(mockUpsertPosition.mock.calls[0][0].positionType).toBe("order");
    });

    it("cancels order on captureStatus=cancelled", async () => {
      await projectPosition(makeActivity({
        productType: "order", positionKey: "orderKey123", captureStatus: "cancelled",
      }));
      expect(mockClosePosition).toHaveBeenCalledWith("solana", "order", "solana", "0xWallet", "orderKey123", "cancelled");
    });

    it("closes order on captureStatus=executed", async () => {
      await projectPosition(makeActivity({
        productType: "order", positionKey: "orderKey123", captureStatus: "executed",
      }));
      expect(mockClosePosition).toHaveBeenCalledWith("solana", "order", "solana", "0xWallet", "orderKey123", "filled");
      expect(mockUpsertPosition).not.toHaveBeenCalled();
    });

    it("does NOT open FIFO lot", async () => {
      await projectPosition(makeActivity({
        productType: "order", positionKey: "orderKey123", captureStatus: "open",
        instrumentKey: "solana:USDC",
      }));
      expect(mockOpenLot).not.toHaveBeenCalled();
    });
  });

  // ── LP lifecycle (zap-in/out/migrate) ─────────────────────────

  describe("LP lifecycle", () => {
    it("opens on zap-in", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: "LP_123", instrumentKey: "ethereum:lp:0xpool",
        meta: { action: "zap-in" }, namespace: "kyberswap", chain: "ethereum",
      }));
      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
      expect(mockUpsertPosition.mock.calls[0][0].positionType).toBe("lp");
    });

    it("closes on zap-out", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: "LP_123",
        meta: { action: "zap-out" }, namespace: "kyberswap", chain: "ethereum",
      }));
      expect(mockClosePosition).toHaveBeenCalledWith("kyberswap", "lp", "ethereum", "0xWallet", "LP_123", "closed");
    });

    it("close old + open new on zap-migrate", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: "LP_123", instrumentKey: "ethereum:lp:0xNewPool",
        meta: { action: "zap-migrate", poolTo: "0xNewPool" },
        namespace: "kyberswap", chain: "ethereum",
      }));
      expect(mockClosePosition).toHaveBeenCalledWith("kyberswap", "lp", "ethereum", "0xWallet", "LP_123", "migrated");
      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
    });
  });

  // ── Spot lots ─────────────────────────────────────────────────

  describe("spot lots", () => {
    it("opens lot on buy with economics", async () => {
      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "buy", instrumentKey: "solana:USDC",
        outputAmount: "1000000", inputValueUsd: "5.25", unitPriceUsd: "0.00000525",
      }));
      expect(mockOpenLot).toHaveBeenCalledTimes(1);
      expect(mockOpenLot.mock.calls[0][0].costBasisUsd).toBe("5.25");
      expect(mockOpenLot.mock.calls[0][0].priceUsd).toBe("0.00000525");
    });

    it("opens lot without economics for none valuation", async () => {
      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "buy", instrumentKey: "ethereum:0xToken",
        outputAmount: "1000000", valuationSource: "none",
      }));
      expect(mockOpenLot).toHaveBeenCalledTimes(1);
      expect(mockOpenLot.mock.calls[0][0].costBasisUsd).toBeUndefined();
    });

    it("skips zero-quantity buy", async () => {
      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "buy", instrumentKey: "solana:USDC",
        outputAmount: "0",
      }));
      expect(mockOpenLot).not.toHaveBeenCalled();
    });

    it("FIFO sell uses transactional client with FOR UPDATE", async () => {
      // Seed the mock client's SELECT response
      queryResults.push(
        { id: 1, remaining_quantity_raw: "500000", quantity_raw: "500000", cost_basis_usd: "2.50" },
        { id: 2, remaining_quantity_raw: "1000000", quantity_raw: "1000000", cost_basis_usd: "5.00" },
      );

      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "sell", instrumentKey: "solana:USDC",
        inputAmount: "700000", outputValueUsd: "3.50",
      }));

      // Verify transaction lifecycle
      const calls = mockClientQuery.mock.calls.map((c: unknown[]) => String(c[0]).trim().split(/\s+/).slice(0, 2).join(" "));
      expect(calls[0]).toBe("BEGIN");
      expect(calls).toContain("COMMIT");

      // Verify FOR UPDATE in SELECT
      const selectCall = mockClientQuery.mock.calls.find((c: unknown[]) => String(c[0]).includes("FOR UPDATE"));
      expect(selectCall).toBeTruthy();

      // Verify client released
      expect(mockClient.release).toHaveBeenCalled();
    });

    it("records shortfall for sell exceeding inventory", async () => {
      queryResults.push(
        { id: 1, remaining_quantity_raw: "300000", quantity_raw: "500000", cost_basis_usd: "1.50" },
      );

      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "sell", instrumentKey: "solana:USDC",
        inputAmount: "500000", outputValueUsd: "2.50",
      }));

      // Should have shortfall INSERT
      const shortfallCall = mockClientQuery.mock.calls.find((c: unknown[]) => String(c[0]).includes("shortfall"));
      expect(shortfallCall).toBeTruthy();
    });
  });

  // ── Non-trading — skip ────────────────────────────────────────

  describe("skip", () => {
    it.each(["bridge", "lend", "stake", "reward"])("%s does nothing", async (type) => {
      await projectPosition(makeActivity({ productType: type }));
      expect(mockUpsertPosition).not.toHaveBeenCalled();
      expect(mockOpenLot).not.toHaveBeenCalled();
    });
  });

  // ── Spot buy/sell inventory continuity ─────────────────────────

  describe("spot buy/sell continuity", () => {
    it("buy opens a lot and sell reduces it transactionally", async () => {
      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "buy", instrumentKey: "ethereum:0xToken",
        outputAmount: "5000000000000000000", namespace: "kyberswap", chain: "ethereum",
      }));
      expect(mockOpenLot.mock.calls[0][0].instrumentKey).toBe("ethereum:0xToken");

      queryResults.push({ id: 10, remaining_quantity_raw: "5000000000000000000", quantity_raw: "5000000000000000000", cost_basis_usd: null });
      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "sell", instrumentKey: "ethereum:0xToken",
        inputAmount: "2000000000000000000", namespace: "kyberswap", chain: "ethereum",
      }));
      // Verify transaction happened
      const beginCall = mockClientQuery.mock.calls.find((c: unknown[]) => String(c[0]).includes("BEGIN"));
      expect(beginCall).toBeTruthy();
    });
  });

  // ── LP economics record path ────────────────────────────────────

  describe("LP economics", () => {
    it("zap-in with zapDetails records LP event and extracts legs", async () => {
      const zapDetails = {
        actions: [{ type: "ACTION_TYPE_ADD_LIQUIDITY", addLiquidity: { token0: { address: "0xA", amount: "1000" }, token1: { address: "0xB", amount: "2000" } } }],
        initialAmountUsd: "100.00",
      };
      mockExtractLpLegs.mockReturnValueOnce([
        { lpEventId: 1, legType: "deposit", tokenAddress: "0xA", amountRaw: "1000" },
      ]);

      await projectPosition(makeActivity({
        productType: "lp", positionKey: "LP_ECO_1", instrumentKey: "ethereum:lp:0xpool",
        meta: { action: "zap-in", dex: "uniswapv3", pool: "0xpool", zapDetails },
        namespace: "kyberswap", chain: "ethereum", inputValueUsd: "100.00",
      }));

      // Position should be opened
      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
      // LP event should be recorded
      expect(mockInsertLpEvent).toHaveBeenCalledTimes(1);
      const eventArgs = mockInsertLpEvent.mock.calls[0][0];
      expect(eventArgs.action).toBe("zap-in");
      expect(eventArgs.dex).toBe("uniswapv3");
      expect(eventArgs.positionKey).toBe("LP_ECO_1");
      expect(eventArgs.totalValueUsd).toBe("100.00");
      // Legs should be extracted and inserted
      expect(mockExtractLpLegs).toHaveBeenCalledTimes(1);
      expect(mockInsertLpLegs).toHaveBeenCalledTimes(1);
    });

    it("zap-in without zapDetails skips LP economics", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: "LP_NO_ZAP", instrumentKey: "ethereum:lp:0xpool",
        meta: { action: "zap-in" },
        namespace: "kyberswap", chain: "ethereum",
      }));

      // Position still opened
      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
      // LP economics skipped — no zapDetails
      expect(mockInsertLpEvent).not.toHaveBeenCalled();
    });

    it("zap-migrate carries cost basis from old position", async () => {
      mockGetByPositionKey.mockResolvedValueOnce({ notionalUsd: "500.00" });

      await projectPosition(makeActivity({
        productType: "lp", positionKey: "LP_MIGRATE", instrumentKey: "ethereum:lp:0xNewPool",
        meta: { action: "zap-migrate", poolTo: "0xNewPool" },
        namespace: "kyberswap", chain: "ethereum",
      }));

      // Old position closed
      expect(mockClosePosition).toHaveBeenCalledWith("kyberswap", "lp", "ethereum", "0xWallet", "LP_MIGRATE", "migrated");
      // New position opened with carried notionalUsd
      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
      expect(mockUpsertPosition.mock.calls[0][0].notionalUsd).toBe("500.00");
    });
  });

  // ── Pendle LP lifecycle + economics (P5, meta.lpLegs neutral path) ─────
  //
  // Pendle add/remove use their OWN action names (lp-add / lp-remove) and a
  // protocol-neutral meta.lpLegs block instead of the kyberswap ZaaS zapDetails.
  // add opens the position; remove closes it ONLY on a proven full exit
  // (meta.fullExit === true) — a partial remove leaves it open. Both directions
  // always record proj_lp_events + legs.

  describe("Pendle LP lifecycle", () => {
    const PK = "ethereum:lp:0xmkt:0xwallet";
    const addMeta = {
      action: "lp-add", dex: "pendle", pool: "0xmkt",
      pendle: { marketAddress: "0xmkt", expiry: "2027-12-30T00:00:00.000Z" },
      lpLegs: [{ legType: "deposit", tokenAddress: "0xtok", amountRaw: "1000000000000000000", amountUsd: "100.00" }],
    };

    it("lp-add opens the LP position (per-chain key) and records the event + deposit leg", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: PK, instrumentKey: "ethereum:lp:0xmkt",
        meta: addMeta, namespace: "pendle", chain: "ethereum",
        inputValueUsd: "100.00", valuationSource: "pendle",
      }));

      expect(mockUpsertPosition).toHaveBeenCalledTimes(1);
      expect(mockUpsertPosition.mock.calls[0][0].positionType).toBe("lp");
      expect(mockUpsertPosition.mock.calls[0][0].positionKey).toBe(PK);
      expect(mockUpsertPosition.mock.calls[0][0].notionalUsd).toBe("100.00");

      expect(mockInsertLpEvent).toHaveBeenCalledTimes(1);
      const ev = mockInsertLpEvent.mock.calls[0][0];
      expect(ev.action).toBe("lp-add");
      expect(ev.dex).toBe("pendle");
      expect(ev.positionKey).toBe(PK);
      expect(ev.totalValueUsd).toBe("100.00");
      expect(ev.valuationSource).toBe("pendle");
      // Neutral path: legs come from meta.lpLegs, NOT the kyberswap extractLpLegs.
      expect(mockExtractLpLegs).not.toHaveBeenCalled();
      expect(mockInsertLpLegs).toHaveBeenCalledTimes(1);
      const legs = mockInsertLpLegs.mock.calls[0][0];
      expect(legs).toHaveLength(1);
      expect(legs[0]).toMatchObject({ lpEventId: 1, legType: "deposit", tokenAddress: "0xtok", amountRaw: "1000000000000000000", amountUsd: "100.00" });
    });

    it("lp-remove with proven full exit closes the position and records the withdraw leg", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: PK, instrumentKey: "ethereum:lp:0xmkt",
        meta: {
          action: "lp-remove", dex: "pendle", pool: "0xmkt", fullExit: true,
          lpLegs: [{ legType: "withdraw", tokenAddress: "0xtok", amountRaw: "1786480896063125847", amountUsd: "3.20" }],
        },
        namespace: "pendle", chain: "ethereum", outputValueUsd: "3.20", valuationSource: "pendle",
      }));

      expect(mockClosePosition).toHaveBeenCalledWith("pendle", "lp", "ethereum", "0xWallet", PK, "closed");
      expect(mockInsertLpEvent).toHaveBeenCalledTimes(1);
      expect(mockInsertLpEvent.mock.calls[0][0].action).toBe("lp-remove");
      expect(mockInsertLpLegs).toHaveBeenCalledTimes(1);
      expect(mockInsertLpLegs.mock.calls[0][0][0].legType).toBe("withdraw");
    });

    it("lp-remove PARTIAL (fullExit false) leaves the position OPEN but still records economics", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: PK, instrumentKey: "ethereum:lp:0xmkt",
        meta: {
          action: "lp-remove", dex: "pendle", pool: "0xmkt", fullExit: false,
          lpLegs: [{ legType: "withdraw", tokenAddress: "0xtok", amountRaw: "500000000000000000" }],
        },
        namespace: "pendle", chain: "ethereum", outputValueUsd: "1.60",
      }));

      // A partial remove neither opens nor closes the position.
      expect(mockClosePosition).not.toHaveBeenCalled();
      expect(mockUpsertPosition).not.toHaveBeenCalled();
      // Economics are still recorded (the withdraw is a real cashflow).
      expect(mockInsertLpEvent).toHaveBeenCalledTimes(1);
      expect(mockInsertLpLegs).toHaveBeenCalledTimes(1);
    });

    it("lp-remove with fullExit OMITTED is treated as partial (not closed) — fail-safe", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: PK,
        meta: { action: "lp-remove", dex: "pendle", pool: "0xmkt", lpLegs: [{ legType: "withdraw", tokenAddress: "0xtok", amountRaw: "1" }] },
        namespace: "pendle", chain: "ethereum",
      }));
      expect(mockClosePosition).not.toHaveBeenCalled();
    });
  });
});
