import { describe, expect, it, vi } from "vitest";

import { parseDecimalString } from "@tools/hyperliquid/validation.js";
import { applyOpenLeverage, capturePerpSafely, compensateRejectedStop, consolidateConfirmedOpen, preflightConfigureAndSubmitPerpOpen } from "@vex-agent/tools/protocols/hyperliquid/handlers.js";
import { evaluateFlatOpenLiquidation } from "@vex-agent/tools/protocols/hyperliquid/protection-gate.js";

const filled = {
  kind: "orders" as const,
  raw: {},
  statuses: [
    { kind: "accepted_filled" as const, oid: 1, totalSz: parseDecimalString("1"), avgPx: parseDecimalString("100") },
    { kind: "accepted_resting" as const, oid: 2 },
  ],
};
const accepted = { kind: "orders" as const, raw: {}, statuses: [] };
const rejected = { kind: "batch_error" as const, raw: {}, message: "rejected" };
const state = { assetPositions: [{ position: { coin: "BTC", szi: "1", entryPx: "100", liquidationPx: "50" } }] };
const fixed = { oid: 2, coin: "BTC", reduceOnly: true, isTrigger: true, triggerCondition: "Stop Market", side: "A", origSz: "1", triggerPx: "90" };
const full = { oid: 3, coin: "BTC", reduceOnly: true, isTrigger: true, triggerCondition: "Stop Market", side: "A", isPositionTpsl: true, triggerPx: "90" };

describe("Hyperliquid synchronous open safety", () => {
  it("confirms full-position protection before cancelling the fixed child", async () => {
    const calls: string[] = [];
    const exchange = {
      setPositionTpsl: vi.fn(async () => { calls.push("place"); return accepted; }),
      cancel: vi.fn(async () => { calls.push("cancel"); return accepted; }),
    };
    const orders = [[fixed], [fixed, full], [full]];
    const info = {
      clearinghouseState: vi.fn(async () => state),
      frontendOpenOrders: vi.fn(async () => orders.shift() ?? [full]),
    };
    await expect(consolidateConfirmedOpen(filled, exchange, info, "0xabc", 0, "BTC", parseDecimalString("90")))
      .resolves.toMatchObject({ state: "complete" });
    expect(calls).toEqual(["place", "cancel"]);
    expect(exchange.cancel).toHaveBeenCalledWith({ cancels: [{ a: 0, o: 2 }] });
  });

  it("never cancels the child when full-position placement fails", async () => {
    const exchange = { setPositionTpsl: vi.fn(async () => rejected), cancel: vi.fn(async () => accepted) };
    const info = { clearinghouseState: vi.fn(async () => state), frontendOpenOrders: vi.fn(async () => [fixed]) };
    await expect(consolidateConfirmedOpen(filled, exchange, info, "0xabc", 0, "BTC", parseDecimalString("90")))
      .resolves.toMatchObject({ state: "pending" });
    expect(exchange.cancel).not.toHaveBeenCalled();
  });

  it("returns an unprotected verdict when rejected-stop recovery cannot read live state", async () => {
    const rejectedChild = {
      kind: "orders" as const,
      raw: {},
      statuses: [
        { kind: "accepted_filled" as const, oid: 1, totalSz: parseDecimalString("1"), avgPx: parseDecimalString("100") },
        { kind: "rejected" as const, message: "child rejected" },
      ],
    };
    await expect(compensateRejectedStop(
      rejectedChild,
      { setPositionTpsl: vi.fn(), cancel: vi.fn() },
      { clearinghouseState: vi.fn().mockRejectedValue(new Error("state unavailable")), frontendOpenOrders: vi.fn() },
      "0xabc", 0, "BTC", parseDecimalString("90"),
    )).resolves.toMatchObject({ unprotected: true });
  });

  it("returns a conservative pending verdict when final protection verification throws", async () => {
    const exchange = {
      setPositionTpsl: vi.fn(async () => accepted),
      cancel: vi.fn(async () => accepted),
    };
    const info = {
      clearinghouseState: vi.fn()
        .mockResolvedValueOnce(state)
        .mockResolvedValueOnce(state)
        .mockRejectedValueOnce(new Error("final state unavailable")),
      frontendOpenOrders: vi.fn()
        .mockResolvedValueOnce([fixed])
        .mockResolvedValueOnce([fixed, full])
        .mockRejectedValueOnce(new Error("final orders unavailable")),
    };
    await expect(consolidateConfirmedOpen(filled, exchange, info, "0xabc", 0, "BTC", parseDecimalString("90")))
      .resolves.toMatchObject({ state: "pending" });
  });

  it("still emits a conservative capture when post-submit live state is unavailable", async () => {
    const capture = await capturePerpSafely(
      {
        clearinghouseState: vi.fn().mockRejectedValue(new Error("state unavailable")),
        frontendOpenOrders: vi.fn().mockRejectedValue(new Error("orders unavailable")),
      } as never,
      "0xabc",
      "BTC",
      {} as never,
      false,
      true,
      { protectionState: "unknown", actionableError: "verify protection" },
    );
    expect(capture).toMatchObject({
      type: "perps",
      walletAddress: "0xabc",
      meta: { protectionState: "unknown", captureState: "live_state_unavailable" },
    });
  });

  it("applies leverage/margin mode before entry and exposes rejection to the caller", async () => {
    const updateLeverage = vi.fn(async () => accepted);
    await expect(applyOpenLeverage({ updateLeverage }, 7, 3, "isolated")).resolves.toEqual(accepted);
    expect(updateLeverage).toHaveBeenCalledWith({ asset: 7, leverage: 3, isCross: false });
    await expect(applyOpenLeverage({ updateLeverage: async () => rejected }, 7, 3, "cross")).resolves.toEqual(rejected);
  });

  it("rejects an invalid bundle before leverage setup or entry submission", async () => {
    const preflightPerpOpen = vi.fn(async () => { throw new Error("invalid tick"); });
    const updateLeverage = vi.fn(async () => accepted);
    const submit = vi.fn(async () => accepted);
    await expect(preflightConfigureAndSubmitPerpOpen(
      { preflightPerpOpen, updateLeverage },
      {
        asset: 7,
        leverage: 3,
        marginMode: "isolated",
        preflight: {
          entry: { a: 7, b: true, p: parseDecimalString("100.01"), s: parseDecimalString("1"), r: false, t: { limit: { tif: "Gtc" } } },
          leverage: 3,
        },
      },
      submit,
    )).rejects.toThrow("invalid tick");
    expect(updateLeverage).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("orders a valid bundle as preflight then leverage then entry", async () => {
    const calls: string[] = [];
    const preflightPerpOpen = vi.fn(async () => { calls.push("preflight"); });
    const updateLeverage = vi.fn(async () => { calls.push("leverage"); return accepted; });
    const submit = vi.fn(async () => { calls.push("entry"); return accepted; });
    await expect(preflightConfigureAndSubmitPerpOpen(
      { preflightPerpOpen, updateLeverage },
      {
        asset: 7,
        leverage: 3,
        marginMode: "cross",
        preflight: {
          entry: { a: 7, b: true, p: parseDecimalString("100"), s: parseDecimalString("1"), r: false, t: { limit: { tif: "Gtc" } } },
          leverage: 3,
        },
      },
      submit,
    )).resolves.toMatchObject({ phase: "entry", result: accepted });
    expect(calls).toEqual(["preflight", "leverage", "entry"]);
    expect(updateLeverage).toHaveBeenCalledWith({ asset: 7, leverage: 3, isCross: true });
  });
});

describe("flat-account liquidation estimate", () => {
  const account = { marginSummary: { accountValue: "1000", totalMarginUsed: "0" } };
  it("allows a stop before conservative liquidation and reports the estimate", () => {
    expect(evaluateFlatOpenLiquidation({ side: "long", price: "100", size: "1", leverage: 3, slPrice: "80" }, account, 50, 2))
      .toMatchObject({ kind: "allow", estimatedLiquidationPx: "67.666666666666666667" });
  });
  it("blocks stops beyond liquidation and insufficient maintenance headroom", () => {
    expect(evaluateFlatOpenLiquidation({ side: "long", price: "100", size: "1", leverage: 3, slPrice: "60" }, account, 50, 2)).toMatchObject({ kind: "block" });
    expect(evaluateFlatOpenLiquidation({ side: "long", price: "100", size: "10000", leverage: 3, slPrice: "80" }, { marginSummary: { accountValue: "1" } }, 50, 2)).toMatchObject({ kind: "block" });
  });
});
