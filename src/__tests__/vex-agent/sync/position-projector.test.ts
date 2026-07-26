import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────

const mockUpsertPosition = vi.fn().mockResolvedValue(undefined);
const mockClosePosition = vi.fn().mockResolvedValue(true);

vi.mock("@vex-agent/db/repos/open-positions.js", () => ({
  upsertPosition: (...args: unknown[]) => mockUpsertPosition(...args),
  closePosition: (...args: unknown[]) => mockClosePosition(...args),
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

  // ── Order lifecycle (DCA, limit orders) ────────────────────────

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
  });

  // ── Spot / LP — projection retired (PnL teardown) ──────────────
  //
  // Position/lot/LP-economics projection for spot and LP trades is retired;
  // `agent_activity` is the trade-truth store for those product types now.
  // These two branches must stay INERT no-ops (never touch open-positions).

  describe("spot (projection retired)", () => {
    it("does nothing on a spot buy", async () => {
      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "buy", instrumentKey: "solana:USDC",
        outputAmount: "1000000", inputValueUsd: "5.25", unitPriceUsd: "0.00000525",
      }));
      expect(mockUpsertPosition).not.toHaveBeenCalled();
      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it("does nothing on a spot sell", async () => {
      await projectPosition(makeActivity({
        productType: "spot", tradeSide: "sell", instrumentKey: "solana:USDC",
        inputAmount: "700000", outputValueUsd: "3.50",
      }));
      expect(mockUpsertPosition).not.toHaveBeenCalled();
      expect(mockClosePosition).not.toHaveBeenCalled();
    });
  });

  describe("lp (projection retired)", () => {
    it("does nothing on zap-in", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: "LP_123", instrumentKey: "ethereum:lp:0xpool",
        meta: { action: "zap-in" }, namespace: "kyberswap", chain: "ethereum",
      }));
      expect(mockUpsertPosition).not.toHaveBeenCalled();
      expect(mockClosePosition).not.toHaveBeenCalled();
    });

    it("does nothing on zap-out", async () => {
      await projectPosition(makeActivity({
        productType: "lp", positionKey: "LP_123",
        meta: { action: "zap-out" }, namespace: "kyberswap", chain: "ethereum",
      }));
      expect(mockUpsertPosition).not.toHaveBeenCalled();
      expect(mockClosePosition).not.toHaveBeenCalled();
    });
  });

  // ── Non-trading — skip ────────────────────────────────────────

  describe("skip", () => {
    it.each(["bridge", "lend", "stake", "reward"])("%s does nothing", async (type) => {
      await projectPosition(makeActivity({ productType: type }));
      expect(mockUpsertPosition).not.toHaveBeenCalled();
      expect(mockClosePosition).not.toHaveBeenCalled();
    });
  });
});
