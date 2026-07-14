/**
 * Liveness + diagnostics behavior of the top-level Hyperliquid protection gate.
 *
 * Covers three fixes on the fix/hyperliquid-gate-diagnostics branch:
 *  - read-only perp tools (perp.positions / perp.orders) must skip the gate and
 *    never be blocked by a coin requirement or a live-state hiccup;
 *  - the live read block retries ONCE so a single transient info-API blip does
 *    not fail an otherwise legitimate open closed;
 *  - a persistent read failure fails closed AND emits bounded diagnostics via
 *    logger.warn (no params, addresses, or amounts).
 *
 * The gate constructs its own HyperliquidInfoClient / HyperliquidMetaCache and
 * resolves the wallet through a dynamic import, so those modules are mocked here
 * to drive the read outcomes deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearHlPolicyProvider,
  registerHlPolicyProvider,
  resolveHlPolicy,
} from "../../../../lib/hyperliquid-policy.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const mocks = vi.hoisted(() => ({
  clearinghouseState: vi.fn(),
  frontendOpenOrders: vi.fn(),
  metaGet: vi.fn(),
  l2Book: vi.fn(),
  allMids: vi.fn(),
  resolveSelectedAddress: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@tools/hyperliquid/info.js", () => ({
  HyperliquidInfoClient: class {
    clearinghouseState = mocks.clearinghouseState;
    frontendOpenOrders = mocks.frontendOpenOrders;
    allMids = mocks.allMids;
    l2Book = mocks.l2Book;
  },
}));

vi.mock("@tools/hyperliquid/meta-cache.js", () => ({
  HyperliquidMetaCache: class {
    get = mocks.metaGet;
  },
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: mocks.resolveSelectedAddress,
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: mocks.loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(() => stub) };
  return { default: stub, logger: stub, createChildLogger: () => stub };
});

const { evaluateHyperliquidProtectionGate, estimateSlippagePct } = await import(
  "@vex-agent/tools/protocols/hyperliquid/protection-gate.js"
);

const OPEN_PARAMS = {
  coin: "BTC", side: "long", size: "0.001", price: "60000", slPrice: "59000", leverage: 3, marginMode: "isolated",
};

function context(): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    hyperliquidPolicy: resolveHlPolicy(),
  };
}

beforeEach(() => {
  registerHlPolicyProvider(() => ({ policy: {}, version: "v1", provenance: "preferences" }));
  mocks.clearinghouseState.mockReset();
  mocks.frontendOpenOrders.mockReset();
  mocks.metaGet.mockReset();
  mocks.l2Book.mockReset();
  mocks.allMids.mockReset();
  mocks.resolveSelectedAddress.mockReset();
  mocks.loggerWarn.mockReset();
  mocks.resolveSelectedAddress.mockReturnValue("0x00000000000000000000000000000000000000ab");
});

afterEach(() => {
  clearHlPolicyProvider();
});

describe("Hyperliquid protection gate — read-only skip", () => {
  it("lets read-only perp tools through without any live-state read or coin requirement", async () => {
    await expect(evaluateHyperliquidProtectionGate("hyperliquid.perp.positions", {}, context())).resolves.toBeNull();
    await expect(evaluateHyperliquidProtectionGate("hyperliquid.perp.orders", {}, context())).resolves.toBeNull();
    expect(mocks.clearinghouseState).not.toHaveBeenCalled();
    expect(mocks.resolveSelectedAddress).not.toHaveBeenCalled();
  });

  it("still blocks a mutating open that is missing its coin", async () => {
    await expect(evaluateHyperliquidProtectionGate("hyperliquid.perp.open", {}, context()))
      .resolves.toEqual({ kind: "block", message: "Hyperliquid perp action requires a coin." });
    expect(mocks.clearinghouseState).not.toHaveBeenCalled();
  });
});

describe("Hyperliquid protection gate — transient-read retry and diagnostics", () => {
  it("retries the live reads once and proceeds when the first read is a transient blip", async () => {
    mocks.clearinghouseState.mockRejectedValueOnce(new Error("HTTP 429 rate limited")).mockResolvedValue({});
    mocks.frontendOpenOrders.mockResolvedValue([]);
    // Empty market map → the gate blocks AFTER a successful read, proving the
    // retry healed the blip (distinct from the live-verification failure block).
    mocks.metaGet.mockResolvedValue({ perpsByCoin: new Map() });

    const result = await evaluateHyperliquidProtectionGate("hyperliquid.perp.open", OPEN_PARAMS, context());

    expect(mocks.clearinghouseState).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      kind: "block",
      message: `"BTC" is not a validator-operated Hyperliquid core perp market.`,
    });
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("fails closed and logs bounded diagnostics when both read attempts reject", async () => {
    mocks.clearinghouseState.mockRejectedValue(new Error("HTTP 429 rate limited"));
    mocks.frontendOpenOrders.mockResolvedValue([]);
    mocks.metaGet.mockResolvedValue({ perpsByCoin: new Map([["BTC", { maxLeverage: 40 }]]) });

    const result = await evaluateHyperliquidProtectionGate("hyperliquid.perp.open", OPEN_PARAMS, context());

    expect(mocks.clearinghouseState).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      kind: "block",
      message: "Hyperliquid live protection and policy state could not be verified. Retry when account data is available.",
    });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith("hyperliquid.protection_gate.error", {
      toolId: "hyperliquid.perp.open",
      coin: "BTC",
      errorClass: "Error",
      cause: expect.stringContaining("rate limited"),
    });
  });
});

describe("Hyperliquid protection gate — venue trailing-zero decimals (FIX 5)", () => {
  // Real CASHCAT book shape: szDecimals 0 → every level size is an integer
  // rendered with a trailing zero ("500.0"/"1509.0"). This deterministically
  // threw parseDecimalString and blocked real opens on 2026-07-13.
  it("estimateSlippagePct returns a Decimal for a real trailing-zero book instead of throwing", () => {
    const book = {
      levels: [
        [{ px: "0.15044", sz: "500.0", n: 1 }],
        [{ px: "0.1507", sz: "1509.0", n: 1 }],
      ],
    };
    const estimate = estimateSlippagePct(book, "30", "0.1507", "buy", "0.1507");
    expect(estimate).not.toBeNull();
    expect(estimate?.toFixed()).toBe("0");
  });

  it("estimateSlippagePct returns null on a malformed crossing level rather than crashing", () => {
    const book = { levels: [[{ px: "0.15", sz: "500.0" }], [{ px: "abc", sz: "1509.0" }]] };
    expect(estimateSlippagePct(book, "30", "0.1507", "buy", "0.1507")).toBeNull();
  });

  it("allows a full open when live book sizes carry trailing zeros (end-to-end)", async () => {
    mocks.clearinghouseState.mockResolvedValue({
      marginSummary: { accountValue: "100000", totalMarginUsed: "0" },
      assetPositions: [],
    });
    mocks.frontendOpenOrders.mockResolvedValue([]);
    mocks.metaGet.mockResolvedValue({ perpsByCoin: new Map([["BTC", { maxLeverage: 40 }]]) });
    mocks.l2Book.mockResolvedValue({
      levels: [
        [{ px: "59999.0", sz: "500.0" }],
        [{ px: "60000.0", sz: "500.0" }],
      ],
    });

    const result = await evaluateHyperliquidProtectionGate("hyperliquid.perp.open", OPEN_PARAMS, context());

    expect(mocks.loggerWarn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "allow", stopLossVerdict: "protected_required" });
  });
});
