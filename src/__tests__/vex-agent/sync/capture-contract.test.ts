/**
 * Frozen coverage matrix — canonical source-of-truth from mutation-matrix.ts.
 *
 * Tests structural invariants (every mutating tool classified exactly once)
 * and contract invariants (expectedType, previewSupport, requiredFields).
 * Detects handler drift automatically.
 */

import { describe, it, expect, vi } from "vitest";
import { PROTOCOL_TOOLS } from "../../../vex-agent/tools/protocols/catalog.js";
import { MUTATION_MATRIX, getMatrixToolIds, getToolsByRole, isExpectedType } from "../../../vex-agent/tools/protocols/mutation-matrix.js";
import { validateCaptureContract, isPreviewExecution } from "../../../vex-agent/tools/protocols/capture-validator.js";
import type { PortfolioRole } from "../../../vex-agent/tools/protocols/types.js";

// ── Structural coverage ────────────────────────────────────────

describe("capture contract — structural coverage", () => {
  it("every mutating tool in PROTOCOL_TOOLS is in MUTATION_MATRIX exactly once", () => {
    const mutatingTools = PROTOCOL_TOOLS.filter(t => t.mutating).map(t => t.toolId).sort();
    const matrixTools = getMatrixToolIds().sort();

    for (const toolId of mutatingTools) {
      expect(MUTATION_MATRIX.has(toolId), `Missing from matrix: ${toolId}`).toBe(true);
    }

    const seen = new Set<string>();
    for (const toolId of matrixTools) {
      expect(seen.has(toolId), `Duplicate in matrix: ${toolId}`).toBe(false);
      seen.add(toolId);
    }
  });

  it("non-mutating tools are NOT in MUTATION_MATRIX", () => {
    const nonMutating = PROTOCOL_TOOLS.filter(t => !t.mutating).map(t => t.toolId);
    for (const toolId of nonMutating) {
      expect(MUTATION_MATRIX.has(toolId), `Non-mutating tool in matrix: ${toolId}`).toBe(false);
    }
  });

  it("no phantom entries (in matrix but not in PROTOCOL_TOOLS)", () => {
    const protocolToolIds = new Set(PROTOCOL_TOOLS.map(t => t.toolId));
    for (const toolId of getMatrixToolIds()) {
      expect(protocolToolIds.has(toolId), `Phantom in matrix (not in PROTOCOL_TOOLS): ${toolId}`).toBe(true);
    }
  });

  it("pnl_spot tools all have capture:full", () => {
    const spot = getToolsByRole("pnl_spot");
    // solana.swap.execute, kyberswap.swap.sell/buy, uniswap.swap.sell/buy (Wave 2c),
    // pendle.pt.buy/sell/redeem (Wave 5), pendle.yt.buy/sell (P3 YT surface),
    // pendle.py.mint/redeem (P4 PY — two capture items each),
    // hyperliquid.spot.trade (HL Phase 2).
    expect(spot.length).toBe(13);
    for (const [toolId, c] of spot) {
      expect(c.capture, `${toolId} should have capture:full`).toBe("full");
    }
  });

  it("utility tools all have capture:none", () => {
    const utility = getToolsByRole("utility");
    for (const [toolId, c] of utility) {
      expect(c.capture, `${toolId} should have capture:none`).toBe("none");
    }
  });

  it("audit capture:none has exactly 2 entries (polymarket bridge)", () => {
    const auditNone = getToolsByRole("audit").filter(([, c]) => c.capture === "none");
    expect(auditNone.map(([id]) => id).sort()).toEqual([
      "polymarket.bridge.deposit",
      "polymarket.bridge.withdraw",
    ]);
  });
});

// ── Contract invariants ────────────────────────────────────────

describe("capture contract — contract invariants", () => {
  it("every capture:full tool has at least 1 requiredField", () => {
    for (const [toolId, c] of MUTATION_MATRIX) {
      if (c.capture === "full") {
        expect(c.requiredFields.length, `${toolId} capture:full but no requiredFields`).toBeGreaterThan(0);
      }
    }
  });

  it("every capture:none tool has empty requiredFields", () => {
    for (const [toolId, c] of MUTATION_MATRIX) {
      if (c.capture === "none") {
        expect(c.requiredFields.length, `${toolId} capture:none but has requiredFields`).toBe(0);
      }
    }
  });

  it("KyberSwap limitOrder tools all have expectedType 'order' (not 'swap')", () => {
    const loTools = getMatrixToolIds().filter(id => id.startsWith("kyberswap.limitOrder."));
    expect(loTools.length).toBeGreaterThanOrEqual(6);
    for (const toolId of loTools) {
      const c = MUTATION_MATRIX.get(toolId)!;
      expect(c.expectedType, `${toolId} should be "order"`).toBe("order");
    }
  });

  it("Polymarket buy/sell are dual-type (order|prediction)", () => {
    for (const toolId of ["polymarket.clob.buy", "polymarket.clob.sell"]) {
      const c = MUTATION_MATRIX.get(toolId)!;
      expect(Array.isArray(c.expectedType), `${toolId} should have dual expectedType`).toBe(true);
      expect(c.expectedType).toContain("prediction");
      expect(c.expectedType).toContain("order");
    }
  });

  it("Polymarket cancel* are type 'order' with role 'projection'", () => {
    const cancelTools = [
      "polymarket.clob.cancel", "polymarket.clob.cancelOrders",
      "polymarket.clob.cancelAll", "polymarket.clob.cancelMarket",
    ];
    for (const toolId of cancelTools) {
      const c = MUTATION_MATRIX.get(toolId)!;
      expect(c.expectedType, `${toolId} should be "order"`).toBe("order");
      expect(c.role, `${toolId} should be "projection"`).toBe("projection");
    }
  });

  it("bulk operations have fanOut: 'items'", () => {
    const bulkTools = [
      "solana.predict.closeAll",
      "kyberswap.limitOrder.batchFill",
      "kyberswap.limitOrder.cancelAll",
      "polymarket.clob.cancelOrders",
      "polymarket.clob.cancelAll",
      "polymarket.clob.cancelMarket",
      // P4: PY mint/redeem emit two spot capture items (PT leg + YT leg).
      "pendle.py.mint",
      "pendle.py.redeem",
    ];
    for (const toolId of bulkTools) {
      const c = MUTATION_MATRIX.get(toolId)!;
      expect(c.fanOut, `${toolId} should be fanOut:"items"`).toBe("items");
    }
  });

  it("solana.predict.claim has exception for instrumentKey", () => {
    const c = MUTATION_MATRIX.get("solana.predict.claim")!;
    expect(c.exceptions).toBeDefined();
    expect(c.exceptions!.some(e => e.includes("instrumentKey"))).toBe(true);
  });

  it("solana.predict.closeAll has exception for instrumentKey (claim items match via positionKey)", () => {
    const c = MUTATION_MATRIX.get("solana.predict.closeAll")!;
    expect(c.exceptions).toBeDefined();
    expect(c.exceptions!.some(e => /no instrumentKey/i.test(e))).toBe(true);
  });
});

// ── Capture validator tests ────────────────────────────────────

describe("capture contract — runtime validator", () => {
  it("validates pnl_spot with all required fields + valuation", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
      inputValueUsd: "5.00", outputValueUsd: "4.90", valuationSource: "jupiter_exact",
    });
    expect(valid).toBe(true);
  });

  it("rejects pnl_spot missing tradeSide without a neutral Solana swap marker", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
      inputValueUsd: "5.00", valuationSource: "jupiter_exact",
    });
    expect(valid).toBe(false);
  });

  it("accepts neutral Solana swaps without tradeSide as activity-only captures", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x",
      instrumentKey: "solana:USDT", inputTokenAddress: "0xUSDC", outputTokenAddress: "0xUSDT",
      inputAmount: "100", outputAmount: "100",
      inputValueUsd: "100.00", valuationSource: "jupiter_exact",
      meta: { stableSwap: true },
    });
    expect(valid).toBe(true);
  });

  it("rejects capture:full with null tradeCapture", () => {
    expect(validateCaptureContract("solana.swap.execute", null)).toBe(false);
  });

  it("passes capture:none regardless of tradeCapture", () => {
    expect(validateCaptureContract("polymarket.bridge.deposit", null)).toBe(true);
    expect(validateCaptureContract("polymarket.bridge.deposit", { type: "bridge" })).toBe(true);
  });

  it("passes unknown toolId (not in matrix)", () => {
    expect(validateCaptureContract("unknown.tool", null)).toBe(true);
  });

  it("solana.predict.claim passes without instrumentKey (exception) with valuation", () => {
    const valid = validateCaptureContract("solana.predict.claim", {
      type: "prediction", walletAddress: "0x", status: "claimed", positionKey: "PK1",
      outputValueUsd: "3.50", valuationSource: "prediction_exact",
    });
    expect(valid).toBe(true);
  });

  it("solana.predict.closeAll item passes without instrumentKey (exception) with valuation", () => {
    const valid = validateCaptureContract("solana.predict.closeAll", {
      type: "prediction", walletAddress: "0x", status: "claimed", positionKey: "PK1",
      outputValueUsd: "3.50", valuationSource: "prediction_exact",
    });
    expect(valid).toBe(true);
  });

  it("solana.predict.closeAll item missing positionKey is REJECTED (exception is instrumentKey-only)", () => {
    const valid = validateCaptureContract("solana.predict.closeAll", {
      type: "prediction", walletAddress: "0x", status: "claimed",
      outputValueUsd: "3.50", valuationSource: "prediction_exact",
    });
    expect(valid).toBe(false);
  });

  it("rejects unexpected type", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "prediction", walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
    });
    expect(valid).toBe(false);
  });

  it("accepts dual-type tool with either valid type", () => {
    const base = { walletAddress: "0x", status: "executed", positionKey: "pk", instrumentKey: "ik" };
    expect(validateCaptureContract("polymarket.clob.buy", { ...base, type: "prediction" })).toBe(true);
    expect(validateCaptureContract("polymarket.clob.buy", { ...base, type: "order" })).toBe(true);
    expect(validateCaptureContract("polymarket.clob.buy", { ...base, type: "swap" })).toBe(false);
  });

  it("rejects capture without type field (type is required for all capture:full)", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
    });
    expect(valid).toBe(false);
  });

  it("validates real matrix tools — kyberswap.limitOrder.cancel requires type+positionKey+status", () => {
    // Missing positionKey
    expect(validateCaptureContract("kyberswap.limitOrder.cancel", {
      type: "order", status: "cancelled",
    })).toBe(false);

    // Complete
    expect(validateCaptureContract("kyberswap.limitOrder.cancel", {
      type: "order", status: "cancelled", positionKey: "123",
    })).toBe(true);
  });

  it("validates real matrix tools — khalani.bridge requires type+walletAddress+status", () => {
    expect(validateCaptureContract("khalani.bridge", {
      type: "bridge", status: "pending",
    })).toBe(false);

    expect(validateCaptureContract("khalani.bridge", {
      type: "bridge", status: "pending", walletAddress: "0x123",
    })).toBe(true);
  });
});

// ── Valuation expectations (W4A regression guard) ──────────────

describe("capture contract — valuation expectations", () => {
  it("exact tools have valuationExpected: 'exact'", () => {
    const exactTools = [
      "solana.swap.execute",
      "kyberswap.swap.buy", "kyberswap.swap.sell",
      "solana.predict.buy", "solana.predict.sell", "solana.predict.claim", "solana.predict.closeAll",
    ];
    for (const toolId of exactTools) {
      const c = MUTATION_MATRIX.get(toolId)!;
      expect(c.valuationExpected, `${toolId} should be "exact"`).toBe("exact");
    }
  });

  it("conditional tools have valuationExpected: 'conditional'", () => {
    for (const toolId of ["polymarket.clob.buy", "polymarket.clob.sell"]) {
      const c = MUTATION_MATRIX.get(toolId)!;
      expect(c.valuationExpected, `${toolId} should be "conditional"`).toBe("conditional");
    }
  });

  it("all audit tools have valuationExpected: 'none'", () => {
    const auditTools = getToolsByRole("audit");
    for (const [toolId, c] of auditTools) {
      expect(c.valuationExpected, `${toolId} should be "none"`).toBe("none");
    }
  });

  it("all utility tools have valuationExpected: 'none'", () => {
    const utilityTools = getToolsByRole("utility");
    for (const [toolId, c] of utilityTools) {
      expect(c.valuationExpected, `${toolId} should be "none"`).toBe("none");
    }
  });

  it("all projection tools have valuationExpected: 'none'", () => {
    const projectionTools = getToolsByRole("projection");
    for (const [toolId, c] of projectionTools) {
      expect(c.valuationExpected, `${toolId} should be "none"`).toBe("none");
    }
  });

  it("every matrix entry has valuationExpected defined", () => {
    for (const [toolId, c] of MUTATION_MATRIX) {
      expect(["exact", "conditional", "none"]).toContain(c.valuationExpected);
    }
  });

  // ── Content-level regression guard: validate capture economics ──

  it("exact capture with full valuation passes validator", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
      inputValueUsd: "5.00", outputValueUsd: "4.90", valuationSource: "jupiter_exact",
    });
    expect(valid).toBe(true);
  });

  it("exact capture WITHOUT USD fields is REJECTED (hard fail)", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
      // No inputValueUsd, no outputValueUsd — handler regression
    });
    expect(valid).toBe(false);
  });

  it("exact capture WITHOUT valuationSource is REJECTED", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
      inputValueUsd: "5.00", // has USD but no valuationSource
    });
    expect(valid).toBe(false);
  });

  it("exact capture with valuationSource 'none' is REJECTED", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
      inputValueUsd: "5.00", valuationSource: "none",
    });
    expect(valid).toBe(false);
  });

  it("exact capture with only outputValueUsd passes (e.g. predict.claim)", () => {
    const valid = validateCaptureContract("solana.predict.claim", {
      type: "prediction", walletAddress: "0x", status: "claimed", positionKey: "pk",
      outputValueUsd: "3.50", valuationSource: "prediction_exact",
    });
    expect(valid).toBe(true);
  });

  it("Solana swap exact capture with only outputValueUsd passes", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x", tradeSide: "sell",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xBONK", outputTokenAddress: "So111",
      inputAmount: "100", outputAmount: "200",
      outputValueUsd: "3.50", valuationSource: "jupiter_exact",
    });
    expect(valid).toBe(true);
  });

  it("conditional capture with polymarket_exact on matched path", () => {
    const valid = validateCaptureContract("polymarket.clob.buy", {
      type: "prediction", walletAddress: "0x", status: "executed",
      positionKey: "pk", instrumentKey: "ik",
      inputValueUsd: "2.00", unitPriceUsd: "0.65", valuationSource: "polymarket_exact",
    });
    expect(valid).toBe(true);
  });

  it("conditional capture with valuationSource 'none' on unmatched path passes (no exact guard)", () => {
    const valid = validateCaptureContract("polymarket.clob.buy", {
      type: "order", walletAddress: "0x", status: "open",
      positionKey: "pk", instrumentKey: "ik",
      valuationSource: "none",
    });
    expect(valid).toBe(true);
  });
});

// ── Meta fields regression guard (contracts for MTM) ───────────

describe("capture contract — required meta fields", () => {
  it("solana.predict.buy requires meta.contracts", () => {
    const c = MUTATION_MATRIX.get("solana.predict.buy")!;
    expect(c.requiredMetaFields).toContain("contracts");
  });

  it("prediction buy with contracts in meta passes", () => {
    const valid = validateCaptureContract("solana.predict.buy", {
      type: "prediction", walletAddress: "0x", status: "open",
      positionKey: "pk", instrumentKey: "solana:predict:m1:yes",
      inputValueUsd: "2.00", valuationSource: "prediction_exact",
      meta: { contracts: "3.5" },
    });
    expect(valid).toBe(true);
  });
});

// ── Preview detection tests ────────────────────────────────────

describe("capture contract — preview detection", () => {
  it("detects preview for tools with previewSupport", () => {
    expect(isPreviewExecution("kyberswap.swap.sell", { dryRun: true })).toBe(true);
    expect(isPreviewExecution("kyberswap.limitOrder.batchFill", { dryRun: true })).toBe(true);
    expect(isPreviewExecution("khalani.bridge", { dryRun: true })).toBe(true);
    expect(isPreviewExecution("polymarket.clob.buy", { dryRun: true })).toBe(true);
  });

  it("does not detect preview when dryRun is false or absent", () => {
    expect(isPreviewExecution("kyberswap.swap.sell", { dryRun: false })).toBe(false);
    expect(isPreviewExecution("kyberswap.swap.sell", {})).toBe(false);
  });

  it("does not detect preview for tools without previewSupport", () => {
    expect(isPreviewExecution("solana.swap.execute", { dryRun: true })).toBe(false);
    expect(isPreviewExecution("solana.predict.buy", { dryRun: true })).toBe(false);
    expect(isPreviewExecution("polymarket.clob.cancel", { dryRun: true })).toBe(false);
  });
});
