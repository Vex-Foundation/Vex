/**
 * KyberSwap route-summary cost restorations (2026-07-25).
 *
 * `formatRouteSummary` dropped `l1FeeUsd` — the L1 data fee, which on the L2s
 * that make up most of the 19 supported chains can rival or exceed `gasUsd` —
 * and `extraFee`, the integrator fee actually applied to the trade, and
 * discarded the venue path entirely while keeping only a hop count.
 *
 * Pure-function tests: the projector performs no IO and must never throw on a
 * malformed provider payload.
 */

import { describe, expect, it } from "vitest";
import type { SwapRouteSummary } from "@tools/kyberswap/aggregator/types.js";
import { formatRouteSummary, sanitizeProviderNote } from "@vex-agent/tools/protocols/kyberswap/helpers.js";

function summary(overrides: Partial<SwapRouteSummary> = {}): SwapRouteSummary {
  return {
    tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    amountIn: "1000000",
    amountInUsd: "1.00",
    tokenOut: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    amountOut: "999000",
    amountOutUsd: "0.99",
    gas: "180000",
    gasPrice: "1000000",
    gasUsd: "0.05",
    route: [[
      { pool: "0xpool1", tokenIn: "0xA0", tokenOut: "0xB0", swapAmount: "600000", amountOut: "599000", exchange: "uniswapv3", poolType: "univ3", poolExtra: { huge: "blob" }, extra: { also: "blob" } },
      { pool: "0xpool2", tokenIn: "0xB0", tokenOut: "0xC0", swapAmount: "599000", amountOut: "598500", exchange: "curve", poolType: "curve", poolExtra: null, extra: null },
    ], [
      { pool: "0xpool3", tokenIn: "0xA0", tokenOut: "0xC0", swapAmount: "400000", amountOut: "400500", exchange: "balancer", poolType: "balancer-v2", poolExtra: null, extra: null },
    ]],
    routeID: "route-1",
    checksum: "sum-1",
    ...overrides,
  };
}

describe("formatRouteSummary — restored cost fields", () => {
  it("keeps the L1 data fee that used to be dropped alongside gasUsd", () => {
    expect(formatRouteSummary(summary({ l1FeeUsd: "0.31" })).l1FeeUsd).toBe("0.31");
  });

  it("reports a missing L1 fee as null — 'not quoted', which is not the same as free", () => {
    expect(formatRouteSummary(summary()).l1FeeUsd).toBeNull();
  });

  it("keeps the integrator fee exactly as the aggregator applied it", () => {
    const formatted = formatRouteSummary(summary({
      extraFee: { feeAmount: "25", chargeFeeBy: "currency_in", isInBps: true, feeReceiver: "0xTreasury" },
    }));
    expect(formatted.extraFee).toEqual({
      feeAmount: "25", chargeFeeBy: "currency_in", isInBps: true, feeReceiver: "0xTreasury",
    });
  });

  it("normalises an integrator fee's optional fields to null instead of dropping the fee", () => {
    const formatted = formatRouteSummary(summary({ extraFee: { feeAmount: "100" } }));
    expect(formatted.extraFee).toEqual({
      feeAmount: "100", chargeFeeBy: null, isInBps: null, feeReceiver: null,
    });
  });

  it("reports no integrator fee as null", () => {
    expect(formatRouteSummary(summary()).extraFee).toBeNull();
  });
});

describe("formatRouteSummary — venue path", () => {
  it("surfaces each path's venues and split size while pool internals stay dropped", () => {
    const formatted = formatRouteSummary(summary());
    expect(formatted.routePaths).toEqual([
      { exchanges: ["uniswapv3", "curve"], amountInRaw: "600000" },
      { exchanges: ["balancer"], amountInRaw: "400000" },
    ]);
    // The hop count still covers every hop across every path.
    expect(formatted.routeHops).toBe(3);
    expect(JSON.stringify(formatted)).not.toContain("blob");
  });

  it("degrades to an empty path list on a malformed route, never throwing", () => {
    const malformed = summary();
    (malformed as { route: unknown }).route = "not-an-array";
    const formatted = formatRouteSummary(malformed);
    expect(formatted.routePaths).toEqual([]);
    expect(formatted.routeHops).toBe(0);
  });

  it("omits an unlabeled hop from the venue list while routeHops still counts it", () => {
    const partial = summary({
      route: [[
        { pool: "0xp", tokenIn: "0xA", tokenOut: "0xB", swapAmount: "1", amountOut: "1", exchange: "curve", poolType: "curve", poolExtra: null, extra: null },
        { pool: "0xq", tokenIn: "0xB", tokenOut: "0xC", swapAmount: "1", amountOut: "1", poolType: "?", poolExtra: null, extra: null } as unknown as SwapRouteSummary["route"][number][number],
      ]],
    });
    const formatted = formatRouteSummary(partial);
    expect(formatted.routePaths).toEqual([{ exchanges: ["curve"], amountInRaw: "1" }]);
    expect(formatted.routeHops).toBe(2);
  });
});

describe("sanitizeProviderNote", () => {
  it("keeps provider prose in full — no truncation of agent-facing content", () => {
    const long = `Positive slippage recouped. ${"detail ".repeat(80)}`.trim();
    expect(sanitizeProviderNote(long)).toBe(long);
  });

  it("collapses control characters so a note cannot smuggle framing into the output", () => {
    expect(sanitizeProviderNote("line one\nline\ttwo")).toBe("line one line two");
  });

  it("degrades an absent or empty note to null", () => {
    expect(sanitizeProviderNote(undefined)).toBeNull();
    expect(sanitizeProviderNote("   ")).toBeNull();
  });
});
