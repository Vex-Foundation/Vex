import { describe, expect, it, vi } from "vitest";

import { evaluateProtectionInvariant } from "../../../../vex-agent/tools/protocols/hyperliquid/protection-gate.js";
import { cancelStaleStopsAfterReplacement } from "../../../../vex-agent/tools/protocols/hyperliquid/handlers.js";
import { consolidateConfirmedOpen } from "../../../../vex-agent/tools/protocols/hyperliquid/handlers.js";
import { buildPositionProtectionSnapshot } from "../../../../vex-agent/tools/protocols/hyperliquid/protection-snapshot.js";
import type { HyperliquidExchangeResult } from "../../../../tools/hyperliquid/types.js";

const state = {
  assetPositions: [{ position: { coin: "BTC", szi: "1", entryPx: "100", liquidationPx: "50" } }],
};

function fixedSizeStop() {
  return [{
    coin: "BTC", reduceOnly: true, isTrigger: true, triggerCondition: "stop",
    isBuy: false, oid: 1, triggerPx: "90", origSz: "1",
  }];
}

describe("Hyperliquid offline-fill protection", () => {
  it("models a fixed-size normalTpsl child as protected-but-CONSOLIDATING", () => {
    const snapshot = buildPositionProtectionSnapshot(state, fixedSizeStop(), "BTC");
    expect(snapshot.state).toBe("CONSOLIDATING");
  });

  it("blocks scale-in and TWAP until a full-position stop is consolidated", () => {
    const snapshot = buildPositionProtectionSnapshot(state, fixedSizeStop(), "BTC");
    expect(evaluateProtectionInvariant(
      "hyperliquid.perp.open",
      { coin: "BTC", side: "long", price: "100", size: "1", slPrice: "90" },
      snapshot,
      true,
    )).toMatchObject({ kind: "block" });
    expect(evaluateProtectionInvariant(
      "hyperliquid.perp.twap",
      { coin: "BTC", side: "buy", price: "100", size: "1" },
      snapshot,
      true,
    )).toMatchObject({ kind: "block" });
  });

  it("permits the gated full-position stop replacement needed for consolidation", () => {
    const snapshot = buildPositionProtectionSnapshot(state, fixedSizeStop(), "BTC");
    expect(evaluateProtectionInvariant(
      "hyperliquid.perp.setTpsl",
      { coin: "BTC", slPrice: "90" },
      snapshot,
      true,
    )).toMatchObject({ kind: "allow" });
  });

  it("cancels stale fixed-size children only after the replacement is accepted", async () => {
    const snapshot = buildPositionProtectionSnapshot(state, fixedSizeStop(), "BTC");
    const accepted: HyperliquidExchangeResult = { kind: "orders", statuses: [], raw: {} };
    const cancel = vi.fn().mockResolvedValue(accepted);
    const result = await cancelStaleStopsAfterReplacement(accepted, { cancel }, 0, snapshot);
    expect(result).toEqual({ staleStopsCancelled: true, consolidationPending: false });
    expect(cancel).toHaveBeenCalledWith({ cancels: [{ a: 0, o: 1 }] });
  });

  it("does not cancel a live child when placing the replacement fails", async () => {
    const snapshot = buildPositionProtectionSnapshot(state, fixedSizeStop(), "BTC");
    const rejected: HyperliquidExchangeResult = {
      kind: "orders", statuses: [{ kind: "rejected", message: "venue rejected" }], raw: {},
    };
    const cancel = vi.fn();
    await expect(cancelStaleStopsAfterReplacement(rejected, { cancel }, 0, snapshot))
      .resolves.toEqual({ staleStopsCancelled: false, consolidationPending: false });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps the replacement plus child safe-but-CONSOLIDATING when cancellation fails", async () => {
    const snapshot = buildPositionProtectionSnapshot(state, fixedSizeStop(), "BTC");
    const accepted: HyperliquidExchangeResult = { kind: "orders", statuses: [], raw: {} };
    const rejected: HyperliquidExchangeResult = {
      kind: "orders", statuses: [{ kind: "rejected", message: "cancel rejected" }], raw: {},
    };
    await expect(cancelStaleStopsAfterReplacement(accepted, { cancel: vi.fn().mockResolvedValue(rejected) }, 0, snapshot))
      .resolves.toEqual({ staleStopsCancelled: false, consolidationPending: true });
  });

  it("passes the absolute live position size when consolidating a full-position stop", async () => {
    const entryFilled: HyperliquidExchangeResult = {
      kind: "orders",
      raw: {},
      statuses: [
        { kind: "accepted_filled", oid: 10, totalSz: "1", avgPx: "100" },
        { kind: "accepted_resting", oid: 11 },
      ],
    };
    const setPositionTpsl = vi.fn().mockResolvedValue({ kind: "orders", raw: {}, statuses: [] });
    await consolidateConfirmedOpen(
      entryFilled,
      { setPositionTpsl, cancel: vi.fn().mockResolvedValue({ kind: "orders", raw: {}, statuses: [] }) },
      { clearinghouseState: vi.fn().mockResolvedValue(state), frontendOpenOrders: vi.fn().mockResolvedValue([fullPositionStop()]) },
      "0xabc",
      0,
      "BTC",
      "90" as never,
    );
    expect(setPositionTpsl).toHaveBeenCalledWith(expect.objectContaining({ s: "1" }));
  });
});

function fullPositionStop() {
  return {
    coin: "BTC", reduceOnly: true, isTrigger: true, triggerCondition: "stop",
    isBuy: false, oid: 2, triggerPx: "90", isPositionTpsl: true,
  };
}
