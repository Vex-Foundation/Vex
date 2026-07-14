import { afterEach, describe, expect, it } from "vitest";

import {
  clearHlPolicyProvider,
  hyperliquidPolicySchema,
  registerHlPolicyProvider,
  resolveHlPolicy,
} from "../../../../lib/hyperliquid-policy.js";
import { evaluatePerpPolicy, evaluateProtectionInvariant, estimateSlippagePct, validateCollateralSensitiveAction } from "@vex-agent/tools/protocols/hyperliquid/protection-gate.js";
import { buildPositionProtectionSnapshot, isSoleProtectiveOrder, parseLiveProtectionState } from "@vex-agent/tools/protocols/hyperliquid/protection-snapshot.js";
import { selectPerpOpenPath } from "@vex-agent/tools/protocols/hyperliquid/open-path.js";
import { compensateRejectedStop, type OpenCompensationExchange, type OpenCompensationInfo } from "@vex-agent/tools/protocols/hyperliquid/handlers.js";
import { validateCaptureContract } from "@vex-agent/tools/protocols/capture-validator.js";
import { parseDecimalString } from "@tools/hyperliquid/validation.js";
import { HYPERLIQUID_TOOLS } from "@vex-agent/tools/protocols/hyperliquid/manifest.js";
import { HYPERLIQUID_HANDLERS } from "@vex-agent/tools/protocols/hyperliquid/handlers.js";
import { HYPERLIQUID_MARKET_ANALYSIS_HANDLERS } from "@vex-agent/tools/protocols/hyperliquid/market-analysis-handlers.js";
import { lintEmbeddingPassage } from "@vex-agent/tools/protocols/_embedding-lint.js";

const longState = { assetPositions: [{ position: { coin: "BTC", szi: "2", entryPx: "100", liquidationPx: "50", positionValue: "200" } }], marginSummary: { accountValue: "1000", totalMarginUsed: "100" } };
const fullStop = { oid: 1, coin: "BTC", reduceOnly: true, isTrigger: true, triggerCondition: "Stop Market", side: "A", isPositionTpsl: true, triggerPx: "90" };
const openParams = { coin: "BTC", side: "long", size: "1", price: "100" };
const rejectedStopResult = { kind: "orders" as const, raw: {}, statuses: [{ kind: "accepted_filled" as const, oid: 1, totalSz: parseDecimalString("1"), avgPx: parseDecimalString("100") }, { kind: "rejected" as const, message: "bad trigger" }] };

afterEach(() => clearHlPolicyProvider());

describe("Hyperliquid policy provider", () => {
  it("fails closed without a provider", () => {
    expect(resolveHlPolicy()).toEqual({ kind: "unavailable", reason: "provider_absent" });
  });

  it("parses policy defaults per resolution and rejects malformed providers", () => {
    registerHlPolicyProvider(() => ({ policy: {}, version: "v1", provenance: "preferences" }));
    const resolved = resolveHlPolicy();
    expect(resolved).toMatchObject({ kind: "available", snapshot: { policy: { requireStopLoss: true, leverageCapDefault: 3, egressAlwaysApprove: true } } });
    registerHlPolicyProvider(() => ({ policy: { marketMode: "other" }, version: "v1", provenance: "preferences" }));
    expect(resolveHlPolicy()).toEqual({ kind: "unavailable", reason: "provider_invalid" });
  });
});

describe("Hyperliquid protection invariant", () => {
  it("derives protected, consolidating, partial, and unprotected state only from live responses", () => {
    expect(buildPositionProtectionSnapshot(longState, [fullStop], "BTC").state).toBe("PROTECTED");
    expect(buildPositionProtectionSnapshot(longState, [{ ...fullStop, isPositionTpsl: false, origSz: "2" }], "BTC").state).toBe("CONSOLIDATING");
    expect(buildPositionProtectionSnapshot(longState, [{ ...fullStop, isPositionTpsl: false, origSz: "1" }], "BTC").state).toBe("PARTIAL");
    expect(buildPositionProtectionSnapshot(longState, [], "BTC").state).toBe("UNPROTECTED");
    expect(buildPositionProtectionSnapshot({ assetPositions: [] }, [{ coin: "BTC", reduceOnly: false, side: "B" }], "BTC").state).toBe("OPENING");
  });

  it("rejects SL-less opens under the default and records user-choice under the explicit opt-out", () => {
    const flat = buildPositionProtectionSnapshot({ assetPositions: [] }, [], "BTC");
    expect(evaluateProtectionInvariant("hyperliquid.perp.open", openParams, flat, true)).toMatchObject({ kind: "block" });
    expect(evaluateProtectionInvariant("hyperliquid.perp.open", openParams, flat, false)).toEqual({ kind: "allow", stopLossVerdict: "unprotected_by_user_choice" });
    expect(selectPerpOpenPath(false, false)).toBe("plain");
  });

  it("keeps supplied SL opens in normalTpsl even under opt-out", () => {
    const flat = buildPositionProtectionSnapshot({ assetPositions: [] }, [], "BTC");
    expect(evaluateProtectionInvariant("hyperliquid.perp.open", { ...openParams, slPrice: "90" }, flat, false)).toEqual({ kind: "allow", stopLossVerdict: "protected_required" });
    expect(selectPerpOpenPath(false, true)).toBe("normalTpsl");
  });

  it("refuses sole-stop cancellation and rejects a TWAP without full protection", () => {
    const protectedSnapshot = buildPositionProtectionSnapshot(longState, [fullStop], "BTC");
    expect(isSoleProtectiveOrder(protectedSnapshot, 1)).toBe(true);
    expect(evaluateProtectionInvariant("hyperliquid.perp.cancelOrders", { coin: "BTC", oid: 1 }, protectedSnapshot, true)).toMatchObject({ kind: "block" });
    const unprotected = buildPositionProtectionSnapshot(longState, [], "BTC");
    expect(evaluateProtectionInvariant("hyperliquid.perp.twap", { coin: "BTC" }, unprotected, true)).toMatchObject({ kind: "block" });
  });

  it.each([
    ["missing assetPositions", { marginSummary: { accountValue: "1000", totalMarginUsed: "100" } }],
    ["non-numeric position size", { ...longState, assetPositions: [{ position: { ...longState.assetPositions[0]!.position, szi: "not-a-number" } }] }],
  ])("never infers FLAT to authorize a sole-stop cancellation from %s", (_label, malformedState) => {
    expect(() => buildPositionProtectionSnapshot(malformedState, [fullStop], "BTC")).toThrow(/live clearinghouse/i);
    expect(() => parseLiveProtectionState(malformedState, [fullStop])).toThrow(/live clearinghouse/i);
  });
});

describe("Hyperliquid policy and L2 exact arithmetic", () => {
  it("enforces asset-bounded leverage and order notional caps", () => {
    const policy = hyperliquidPolicySchema.parse({ leverageCapDefault: 3, perOrderNotionalPct: 20 });
    expect(evaluatePerpPolicy({ leverage: 4 }, longState, 50, policy)).toMatchObject({ kind: "block" });
    expect(evaluatePerpPolicy({ size: "3", price: "100" }, longState, 50, policy)).toMatchObject({ kind: "block" });
  });

  it.each(["NaN", "Infinity", "-1", "not-a-number"]) ("blocks invalid risk decimal %s rather than allowing a collateral transfer", (value) => {
    expect(validateCollateralSensitiveAction([buildPositionProtectionSnapshot(longState, [fullStop], "BTC")], value, "10", 2)).toMatch(/finite non-negative/i);
  });

  it.each([
    ["account value", { ...longState, marginSummary: { accountValue: "NaN", totalMarginUsed: "10" } }],
    ["maintenance margin", { ...longState, marginSummary: { accountValue: "1000", totalMarginUsed: "Infinity" } }],
    ["position value", { ...longState, assetPositions: [{ position: { ...longState.assetPositions[0]!.position, positionValue: "-1" } }] }],
  ])("fails closed when %s is not a finite non-negative risk decimal", (_label, state) => {
    const policy = hyperliquidPolicySchema.parse({ perOrderNotionalPct: 50, totalNotionalPct: 50, maintenanceHeadroomFloor: 1.25 });
    expect(evaluatePerpPolicy({ size: "1", price: "100" }, state, 50, policy)).toMatchObject({ kind: "block" });
  });

  it("computes L2 slippage with Decimal rather than binary float", () => {
    const book = { levels: [[{ px: "99", sz: "5" }], [{ px: "100.1", sz: "1" }, { px: "100.2", sz: "1" }]] };
    // Uncapped market sweep (TWAP semantics, limitPrice null): the fill average
    // 100.15 is adverse to the 100 mid reference, so the directional measure
    // matches the abs form here (avg > reference) with Decimal precision.
    expect(estimateSlippagePct(book, "2", "100", "buy", null)?.toFixed()).toBe("0.15");
    // Same book as a LIMIT order at 100 (hl_open): both asks are above the
    // limit, so nothing crosses, the order rests, and adverse slippage is 0 —
    // the abs form wrongly reported 0.15 here.
    expect(estimateSlippagePct(book, "2", "100", "buy", "100")?.toFixed()).toBe("0");
  });
});

describe("Hyperliquid capture contracts", () => {
  it("accepts typed netted snapshots for open and close", () => {
    const capture = {
      type: "perps", walletAddress: "0xabc", status: "open", positionKey: "hyperliquid:perp:BTC:0xabc", instrumentKey: "hyperliquid:perp:BTC",
      inputValueUsd: "100", unitPriceUsd: "100", valuationSource: "hyperliquid_clearinghouse",
      meta: { coin: "BTC", contracts: "1", protectionState: "PROTECTED" },
    };
    expect(validateCaptureContract("hyperliquid.perp.open", capture)).toBe(true);
    expect(validateCaptureContract("hyperliquid.perp.close", { ...capture, status: "closed" })).toBe(true);
  });
});

describe("Hyperliquid registration surface", () => {
  it("pairs every manifest with a handler and passes the embedding lint", () => {
    // The catalog registers the MERGED handler maps (core + market-analysis);
    // the invariant is every manifest has a handler at that registration point.
    const registeredHandlerIds = Object.keys({ ...HYPERLIQUID_HANDLERS, ...HYPERLIQUID_MARKET_ANALYSIS_HANDLERS }).sort();
    expect(registeredHandlerIds).toEqual(HYPERLIQUID_TOOLS.map((tool) => tool.toolId).sort());
    for (const tool of HYPERLIQUID_TOOLS) {
      expect(lintEmbeddingPassage(tool.toolId, tool.discovery?.embeddingText ?? "", tool.mutating)).toEqual([]);
    }
  });

  it("registers risk setup as a local user-confirmation proposal, never a financial egress", () => {
    const riskSetup = HYPERLIQUID_TOOLS.find((tool) => tool.toolId === "hyperliquid.risk.proposeSetup");
    expect(riskSetup).toMatchObject({
      mutating: true,
      actionKind: "local_write",
    });
    expect(HYPERLIQUID_HANDLERS["hyperliquid.risk.proposeSetup"]).toBeTypeOf("function");
  });
});

describe("Hyperliquid rejected-SL compensation", () => {
  const protectedOrders = [fullStop];
  const info = (orders: readonly unknown[]): OpenCompensationInfo => ({
    clearinghouseState: async () => longState,
    frontendOpenOrders: async () => orders,
  });
  it("retries with a full-position stop and verifies live protected state", async () => {
    const exchange: OpenCompensationExchange = {
      cancel: async () => ({ kind: "orders", raw: {}, statuses: [] }),
      setPositionTpsl: async () => ({ kind: "orders", raw: {}, statuses: [{ kind: "accepted_resting" }] }),
    };
    await expect(compensateRejectedStop(rejectedStopResult, exchange, info(protectedOrders), "0xabc", 0, "BTC", parseDecimalString("90"))).resolves.toMatchObject({ unprotected: false, steps: ["atomic stop-loss child rejected", "full-position stop placed on retry 1"] });
  });
  it("escalates UNPROTECTED when full-position stop placement fails", async () => {
    const exchange: OpenCompensationExchange = {
      cancel: async () => ({ kind: "orders", raw: {}, statuses: [] }),
      setPositionTpsl: async () => ({ kind: "orders", raw: {}, statuses: [{ kind: "rejected", message: "offline" }] }),
    };
    await expect(compensateRejectedStop(rejectedStopResult, exchange, info([]), "0xabc", 0, "BTC", parseDecimalString("90"))).resolves.toMatchObject({ unprotected: true });
  });
  it("escalates if a resting entry cannot be cancelled after child rejection", async () => {
    const resting = { kind: "orders" as const, raw: {}, statuses: [{ kind: "accepted_resting" as const, oid: 1 }, { kind: "rejected" as const, message: "bad trigger" }] };
    const exchange: OpenCompensationExchange = {
      cancel: async () => ({ kind: "orders", raw: {}, statuses: [{ kind: "rejected", message: "cancel failed" }] }),
      setPositionTpsl: async () => ({ kind: "orders", raw: {}, statuses: [] }),
    };
    await expect(compensateRejectedStop(resting, exchange, info([]), "0xabc", 0, "BTC", parseDecimalString("90"))).resolves.toMatchObject({ unprotected: true });
  });
});
