import { describe, expect, it } from "vitest";
import {
  marginUsage,
  portionOfSize,
  positionMetrics,
  positionProtection,
  type LighterOpenOrderRow,
  type LighterPositionRow,
} from "../account-model.js";
import {
  buildCancelAllOrdersMessage,
  buildConnectMessage,
  buildFundMessage,
} from "../desk-messages.js";

const LONG: LighterPositionRow = {
  marketId: 1,
  symbol: "BTC",
  side: "long",
  size: "0.25",
  entryPrice: "64000",
  value: "16000",
  unrealizedPnl: "12.75",
  liquidationPrice: "41000",
  initialMarginFraction: 1_000,
  marginMode: "cross",
  allocatedMargin: "1600",
};

function order(overrides: Partial<LighterOpenOrderRow>): LighterOpenOrderRow {
  return {
    orderId: "order-1",
    clientOrderId: null,
    marketId: 1,
    symbol: "BTC",
    side: "sell",
    type: "limit",
    timeInForce: "good-till-time",
    reduceOnly: true,
    triggerPrice: null,
    triggerStatus: null,
    triggeredAt: null,
    orderExpiry: null,
    price: "70000",
    size: "0.25",
    filled: null,
    remaining: "0.25",
    status: "open",
    createdAt: null,
    ...overrides,
  };
}

describe("positionMetrics", () => {
  it("prefers the live mark and Lighter's own margin allocation", () => {
    const metrics = positionMetrics(LONG, 64_100);
    expect(metrics.mark).toBe(64_100);
    expect(metrics.margin).toBe(1_600);
    expect(metrics.leverage).toBe(10);
    expect(metrics.roe).toBeCloseTo(12.75 / 1_600, 8);
  });

  it("derives mark from the snapshot and margin from the IMF when Lighter gave neither", () => {
    const metrics = positionMetrics({ ...LONG, allocatedMargin: null, initialMarginFraction: 500 }, null);
    expect(metrics.mark).toBe(64_000);
    expect(metrics.margin).toBe(800);
    expect(metrics.leverage).toBe(20);
  });

  it("returns nulls, never NaN, when the row carried no terms", () => {
    const metrics = positionMetrics(
      { ...LONG, value: null, allocatedMargin: null, initialMarginFraction: null, unrealizedPnl: null },
      null,
    );
    expect(metrics).toEqual({ mark: null, margin: null, leverage: null, roe: null });
  });
});

describe("positionProtection", () => {
  it("names the legs from the order type, and ignores non-protective orders", () => {
    const orders = [
      order({ orderId: "plain", reduceOnly: false }),
      order({ orderId: "other-market", marketId: 2, type: "stop-loss-limit", triggerPrice: "60000" }),
      order({ orderId: "same-side", side: "buy", type: "stop-loss-limit", triggerPrice: "60000" }),
      order({ orderId: "sl", type: "stop-loss-limit", triggerPrice: "60000" }),
      order({ orderId: "tp", type: "take-profit-limit", triggerPrice: "72000" }),
      order({ orderId: "sl-2", type: "stop-loss", triggerPrice: "59000" }),
    ];
    const protection = positionProtection(LONG, orders);
    expect(protection.stopLoss?.orderId).toBe("sl");
    expect(protection.takeProfit?.orderId).toBe("tp");
  });

  it("falls back to the trigger's side of the entry when the type is opaque", () => {
    const long = positionProtection(LONG, [
      order({ orderId: "below", type: null, triggerPrice: "60000" }),
      order({ orderId: "above", type: null, triggerPrice: "72000" }),
    ]);
    expect(long.stopLoss?.orderId).toBe("below");
    expect(long.takeProfit?.orderId).toBe("above");

    const short = positionProtection({ ...LONG, side: "short" }, [
      order({ orderId: "below", side: "buy", type: null, triggerPrice: "60000" }),
      order({ orderId: "above", side: "buy", type: null, triggerPrice: "72000" }),
    ]);
    expect(short.stopLoss?.orderId).toBe("above");
    expect(short.takeProfit?.orderId).toBe("below");
  });
});

describe("marginUsage", () => {
  it("is the committed share of collateral, clamped to 0..1", () => {
    expect(marginUsage({ collateral: "1200.5", availableBalance: "800.25", unrealizedPnl: null })).toBeCloseTo(0.3334, 3);
    expect(marginUsage({ collateral: "100", availableBalance: "-20", unrealizedPnl: null })).toBe(1);
    expect(marginUsage({ collateral: "100", availableBalance: "120", unrealizedPnl: null })).toBe(0);
    expect(marginUsage({ collateral: "0", availableBalance: "0", unrealizedPnl: null })).toBeNull();
    expect(marginUsage(null)).toBeNull();
  });
});

describe("desk messages", () => {
  it("names the account scope and always ends on the approval rule", () => {
    expect(buildCancelAllOrdersMessage({ environment: "core", orderCount: 3 })).toContain(
      "Cancel all 3 of my open Lighter orders across every market with one account-wide cancellation, prepared with lighter__order_cancel_all_prepare.; environment=core; Display the approval card",
    );
  });

  it("starts onboarding from the status read and names every step as its own approval", () => {
    const connect = buildConnectMessage({ environment: "rhc" });
    expect(connect).toContain("lighter__account_onboarding_status");
    expect(connect).toContain("lighter__deposit_prepare");
    expect(connect).toContain("lighter__key_register_prepare");
    expect(connect).toContain("lighter__fees_approve_prepare");
    expect(connect).toContain("environment=rhc");
    expect(connect).toContain("Nothing may execute without my explicit approval");
  });

  it("asks for a deposit walkthrough with approval, and is honest that withdrawals happen on Lighter", () => {
    const deposit = buildFundMessage({ environment: "core", kind: "deposit" });
    expect(deposit).toContain("lighter__deposit_prepare");
    expect(deposit).toContain("Nothing may execute without my explicit approval");
    const withdraw = buildFundMessage({ environment: "core", kind: "withdraw" });
    expect(withdraw).toContain("Vex has no withdrawal tool");
    expect(withdraw).not.toContain("approval card");
  });
});

describe("portionOfSize", () => {
  it("floors the portion to the market's size decimals and keeps the whole position exact", () => {
    expect(portionOfSize("0.00051", 1, 5)).toBe("0.00051");
    expect(portionOfSize("0.00051", 0.75, 5)).toBe("0.00038");
    expect(portionOfSize("0.00051", 0.25, 5)).toBe("0.00012");
    expect(portionOfSize("3", 0.5, 0)).toBe("1");
    expect(portionOfSize("1.5", 0.5, 1)).toBe("0.7");
    expect(portionOfSize("0.00001", 0.25, 5)).toBe("0");
  });
});
