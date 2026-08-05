/**
 * Vex-fee approval disclosure — per-venue, engine-owned, unspoofable.
 *
 * Pins the money-path invariants the disclosure exists to hold:
 *   - the RATE always comes from the venue's own product-owner constant, so the
 *     card can never state a rate the executor does not charge;
 *   - a caller-supplied `fee` / `feeBps` / `feeReceiver` / `feeAmount` NEVER
 *     reaches the line (the standing decree: a model-chosen fee is an
 *     overcharge vector);
 *   - the arithmetic is exact — no float, no rounding — and truncation-free;
 *   - the wording distinguishes a fee taken INSIDE the approved amount from one
 *     charged as a SEPARATE transfer only after the operation succeeds;
 *   - a fee that cannot be known before signing (a Trench SELL) is stated as
 *     unknown rather than given a number.
 */

import { describe, it, expect } from "vitest";
import { describeApprovalVexFee } from "@vex-agent/engine/core/approval-vex-fee.js";
import { KYBERSWAP_FEE_BPS } from "@tools/kyberswap/constants.js";
import { UNISWAP_FEE_BPS } from "@tools/uniswap/fee/index.js";
import { BRIDGE_FEE_BPS } from "@tools/bridge-fee/index.js";
import { TRENCH_FEE_BPS } from "@tools/trench-express/fee/index.js";

describe("describeApprovalVexFee", () => {
  it("every covered venue charges the SAME product-owner rate (25 bps)", () => {
    expect([KYBERSWAP_FEE_BPS, UNISWAP_FEE_BPS, BRIDGE_FEE_BPS, TRENCH_FEE_BPS]).toEqual([
      25, 25, 25, 25,
    ]);
  });

  it("kyberswap.swap.execute — fee inside the approved amountIn, exact decimal", () => {
    const line = describeApprovalVexFee("kyberswap.swap.execute", {
      chain: "base",
      tokenIn: "ETH",
      tokenOut: "0xdeadbeef",
      amountIn: "1.5",
    });
    expect(line).toContain("0.25% (25 bps)");
    // 1.5 × 25/10000 = 0.00375 EXACTLY — no float, no rounding.
    expect(line).toContain("0.00375 ETH");
    expect(line).toContain("included in the amountIn above");
  });

  it("uniswap.swap.execute — presented as a SEPARATE post-swap transfer", () => {
    const line = describeApprovalVexFee("uniswap.swap.execute", {
      chain: "base",
      tokenIn: "ETH",
      tokenOut: "0xdeadbeef",
      amountIn: "2",
    });
    expect(line).toContain("0.005 ETH");
    expect(line).toContain("separate transfer signed only after the swap confirms");
    expect(line).not.toContain("included in the amountIn above");
  });

  it("relay.bridge / khalani.bridge — raw units, named with the token they belong to", () => {
    for (const toolId of ["relay.bridge", "khalani.bridge"]) {
      const line = describeApprovalVexFee(toolId, {
        fromChain: "base",
        toChain: "arbitrum",
        fromToken: "0xUSDC",
        toToken: "0xUSDC",
        amountRaw: "1000000",
      });
      expect(line).toContain("0.25% (25 bps)");
      expect(line).toContain("2500 raw units of fromToken");
      expect(line).toContain("included in the amountRaw above");
    }
  });

  it("a bridge fee that floors to zero says so instead of printing 0", () => {
    const line = describeApprovalVexFee("relay.bridge", {
      fromToken: "0xUSDC",
      amountRaw: "399",
    });
    expect(line).toContain("floors to zero at this size");
    expect(line).not.toMatch(/\b0 raw units\b/);
  });

  it("trench BUY — fee on the ETH spent, charged only after the trade confirms", () => {
    const line = describeApprovalVexFee("trench.trade_execute", {
      tokenIn: "ETH",
      tokenOut: "0xcurve",
      amountIn: "0.01",
    });
    expect(line).toContain("0.000025 ETH");
    expect(line).toContain("after the trade confirms");
  });

  it("trench SELL — the ETH proceeds do not exist yet, so NO number is claimed", () => {
    const line = describeApprovalVexFee("trench.trade_execute", {
      tokenIn: "0xcurve",
      tokenOut: "ETH",
      amountIn: "1000",
    });
    expect(line).toContain("ETH you receive");
    expect(line).toContain("not known until");
    expect(line).not.toMatch(/\d+\.\d+ ETH/);
  });

  it("solana.swap.execute is NOT covered here — Jupiter has its own feeDisclosure", () => {
    expect(
      describeApprovalVexFee("solana.swap.execute", { amountIn: "1", tokenIn: "SOL" }),
    ).toBeUndefined();
  });

  it("a fee-free venue (Pendle) and a read tool get no line at all", () => {
    expect(describeApprovalVexFee("pendle.pt.buy", { amountIn: "1" })).toBeUndefined();
    expect(describeApprovalVexFee("kyberswap.swap.quote", { amountIn: "1" })).toBeUndefined();
  });

  it("a missing or malformed amount yields NO line rather than a fabricated fee", () => {
    expect(describeApprovalVexFee("kyberswap.swap.execute", { tokenIn: "ETH" })).toBeUndefined();
    expect(
      describeApprovalVexFee("kyberswap.swap.execute", { tokenIn: "ETH", amountIn: "1e18" }),
    ).toBeUndefined();
    expect(
      describeApprovalVexFee("relay.bridge", { fromToken: "0xUSDC", amountRaw: "1.5" }),
    ).toBeUndefined();
  });

  it("a caller-supplied fee param can NEVER move the disclosed rate or amount", () => {
    const honest = describeApprovalVexFee("kyberswap.swap.execute", {
      tokenIn: "ETH",
      amountIn: "1.5",
    });
    const spoofed = describeApprovalVexFee("kyberswap.swap.execute", {
      tokenIn: "ETH",
      amountIn: "1.5",
      fee: "500",
      feeBps: 9999,
      feeAmount: "1.4",
      feeReceiver: "0xattacker",
    });
    expect(spoofed).toBe(honest);
    expect(spoofed).not.toContain("9999");
    expect(spoofed).not.toContain("0xattacker");
  });
});
