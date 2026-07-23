/**
 * Frozen coverage matrix — canonical source-of-truth from mutation-matrix.ts.
 *
 * FIX-SPINE round 1 (C12) full rewrite: Agent Scan (plan §4.3/§11.4) removed
 * the PnL role split (pnl_spot/pnl_perps/pnl_prediction), the
 * `valuationExpected` exact/conditional/none tri-state, and every matrix row
 * for a deleted tool (KyberSwap limitOrder ×6, KyberSwap/ZaaS zap ×3,
 * Polymarket ×8, the old per-venue kyber/uniswap buy/sell split ×4). The
 * matrix now classifies `kind: "trade" | "projection" | "audit" | "utility"`
 * (coarse capture semantics only, no PnL/valuation machinery) plus an
 * explicit `strictItemsRequired` flag replacing the old
 * `role === "pnl_spot"` fanOut-items guard.
 *
 * Tests structural invariants (every mutating tool classified exactly once)
 * and contract invariants (expectedType, previewSupport, requiredFields).
 * Detects handler drift automatically.
 */

import { describe, it, expect } from "vitest";
import { PROTOCOL_TOOLS } from "../../../vex-agent/tools/protocols/catalog.js";
import {
  MUTATION_MATRIX,
  getMatrixToolIds,
  getToolsByKind,
  isExpectedType,
  type MutationContract,
} from "../../../vex-agent/tools/protocols/mutation-matrix.js";
import { validateCaptureContract, isPreviewExecution } from "../../../vex-agent/tools/protocols/capture-validator.js";

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

  it("no deleted-tool matrix row survives (limitOrder, zap, Polymarket, old kyber/uniswap buy/sell)", () => {
    for (const toolId of [
      "kyberswap.limitOrder.create", "kyberswap.limitOrder.cancel", "kyberswap.limitOrder.hardCancel",
      "kyberswap.limitOrder.fill", "kyberswap.limitOrder.batchFill", "kyberswap.limitOrder.cancelAll",
      "kyberswap.zap.in", "kyberswap.zap.out", "kyberswap.zap.migrate",
      "polymarket.clob.buy", "polymarket.clob.sell", "polymarket.clob.cancel",
      "polymarket.clob.cancelOrders", "polymarket.clob.cancelAll", "polymarket.clob.cancelMarket",
      "polymarket.clob.heartbeat", "polymarket.bridge.deposit", "polymarket.bridge.withdraw",
      "kyberswap.swap.buy", "kyberswap.swap.sell", "uniswap.swap.buy", "uniswap.swap.sell",
    ]) {
      expect(MUTATION_MATRIX.has(toolId), `${toolId} should have been deleted from the matrix`).toBe(false);
    }
  });

  it("the new unified kyberswap.swap.execute / uniswap.swap.execute rows exist, capture:none", () => {
    for (const toolId of ["kyberswap.swap.execute", "uniswap.swap.execute"]) {
      const c = MUTATION_MATRIX.get(toolId);
      expect(c, `${toolId} missing from matrix`).toBeDefined();
      expect(c!.kind).toBe("trade");
      expect(c!.capture).toBe("none");
      expect(c!.expectedType).toBe("swap");
      expect(c!.requiredFields).toEqual([]);
    }
  });

  it("'trade' kind tools with capture:full total 21 (no PnL role split — just the coarse kind)", () => {
    // solana.swap.execute (1); pendle.pt.buy/sell/redeem (3); pendle.yt.buy/sell (2);
    // pendle.py.mint/redeem (2); hyperliquid.spot.trade (1); solana.predict.buy/sell/
    // claim/closeAll (4); hyperliquid.perp.* (8: open/close/setTpsl/modifyOrder/
    // cancelOrders/setLeverage/adjustMargin/twap) = 21. The two Agent Scan unified
    // executes are ALSO kind:"trade" but capture:"none" — excluded here on purpose.
    const trade = getToolsByKind("trade").filter(([, c]) => c.capture === "full");
    expect(trade.length).toBe(21);
    for (const [toolId, c] of trade) {
      expect(c.capture, `${toolId} should have capture:full`).toBe("full");
    }
  });

  it("utility tools all have capture:none (only hyperliquid.risk.proposeSetup survives)", () => {
    const utility = getToolsByKind("utility");
    expect(utility.map(([id]) => id)).toEqual(["hyperliquid.risk.proposeSetup"]);
    for (const [toolId, c] of utility) {
      expect(c.capture, `${toolId} should have capture:none`).toBe("none");
    }
  });

  it("audit tools are ALL capture:full (the two Polymarket bridge capture:none rows were deleted)", () => {
    const audit = getToolsByKind("audit");
    expect(audit.length).toBeGreaterThan(0);
    for (const [toolId, c] of audit) {
      expect(c.capture, `${toolId} should have capture:full`).toBe("full");
    }
  });

  it("projection kind has exactly the two Pendle LP lifecycle rows (zap's projection rows were deleted)", () => {
    const projection = getToolsByKind("projection");
    expect(projection.map(([id]) => id).sort()).toEqual(["pendle.lp.add", "pendle.lp.remove"]);
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

  it("bulk operations have fanOut: 'items' (limitOrder/Polymarket batch tools deleted — only Solana + Pendle PY survive)", () => {
    const bulkTools = [
      "solana.predict.closeAll",
      "pendle.py.mint",
      "pendle.py.redeem",
    ];
    expect(getToolsByKind("trade").filter(([, c]) => c.fanOut === "items").map(([id]) => id).sort())
      .toEqual([...bulkTools].sort());
    for (const toolId of bulkTools) {
      const c = MUTATION_MATRIX.get(toolId)!;
      expect(c.fanOut, `${toolId} should be fanOut:"items"`).toBe("items");
    }
  });

  it("strictItemsRequired is true ONLY for pendle.py.mint/redeem (their summary can never substitute for the two distinct legs)", () => {
    expect(MUTATION_MATRIX.get("pendle.py.mint")!.strictItemsRequired).toBe(true);
    expect(MUTATION_MATRIX.get("pendle.py.redeem")!.strictItemsRequired).toBe(true);
    // solana.predict.closeAll is ALSO fanOut:"items" but its summary fallback
    // is safe (nothing to distinguish) — strictItemsRequired must stay unset.
    expect(MUTATION_MATRIX.get("solana.predict.closeAll")!.strictItemsRequired).toBeUndefined();
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

  it("isExpectedType supports dual-type contracts (synthetic fixture — no LIVE matrix tool is dual-type anymore)", () => {
    // Agent Scan deleted the only dual-type tool (polymarket.clob.buy/sell,
    // expectedType: ["prediction", "order"]). The array-handling branch stays
    // supported in the type/helper for a future dual-type tool, so it is
    // pinned directly against a synthetic contract rather than a live one.
    const dualType: MutationContract = {
      kind: "trade", capture: "full", expectedType: ["prediction", "order"],
      previewSupport: false, fanOut: "single", requiredFields: [],
    };
    expect(isExpectedType(dualType, "prediction")).toBe(true);
    expect(isExpectedType(dualType, "order")).toBe(true);
    expect(isExpectedType(dualType, "swap")).toBe(false);
  });
});

// ── Capture validator tests ────────────────────────────────────

describe("capture contract — runtime validator", () => {
  it("validates a trade capture with all required fields", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
    });
    expect(valid).toBe(true);
  });

  it("rejects trade capture missing tradeSide without a neutral Solana swap marker", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
    });
    expect(valid).toBe(false);
  });

  it("accepts neutral Solana swaps without tradeSide as activity-only captures", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      type: "swap", walletAddress: "0x",
      instrumentKey: "solana:USDT", inputTokenAddress: "0xUSDC", outputTokenAddress: "0xUSDT",
      inputAmount: "100", outputAmount: "100",
      meta: { stableSwap: true },
    });
    expect(valid).toBe(true);
  });

  it("rejects capture:full with null tradeCapture", () => {
    expect(validateCaptureContract("solana.swap.execute", null)).toBe(false);
  });

  it("passes capture:none regardless of tradeCapture (e.g. the Agent Scan unified executes)", () => {
    expect(validateCaptureContract("kyberswap.swap.execute", null)).toBe(true);
    expect(validateCaptureContract("kyberswap.swap.execute", { type: "swap" })).toBe(true);
    expect(validateCaptureContract("hyperliquid.risk.proposeSetup", null)).toBe(true);
  });

  it("passes unknown toolId (not in matrix)", () => {
    expect(validateCaptureContract("unknown.tool", null)).toBe(true);
  });

  it("solana.predict.claim passes without instrumentKey (exception)", () => {
    const valid = validateCaptureContract("solana.predict.claim", {
      type: "prediction", walletAddress: "0x", status: "claimed", positionKey: "PK1",
    });
    expect(valid).toBe(true);
  });

  it("solana.predict.closeAll item passes without instrumentKey (exception)", () => {
    const valid = validateCaptureContract("solana.predict.closeAll", {
      type: "prediction", walletAddress: "0x", status: "claimed", positionKey: "PK1",
    });
    expect(valid).toBe(true);
  });

  it("solana.predict.closeAll item missing positionKey is REJECTED (exception is instrumentKey-only)", () => {
    const valid = validateCaptureContract("solana.predict.closeAll", {
      type: "prediction", walletAddress: "0x", status: "claimed",
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

  it("rejects capture without type field (type is required for all capture:full)", () => {
    const valid = validateCaptureContract("solana.swap.execute", {
      walletAddress: "0x", tradeSide: "buy",
      instrumentKey: "solana:BONK", inputTokenAddress: "0xA", outputTokenAddress: "0xB",
      inputAmount: "100", outputAmount: "200",
    });
    expect(valid).toBe(false);
  });

  it("validates real matrix tools — pendle.lp.add requires type+positionKey+status", () => {
    // Missing positionKey
    expect(validateCaptureContract("pendle.lp.add", {
      type: "lp", status: "open",
    })).toBe(false);

    // Complete
    expect(validateCaptureContract("pendle.lp.add", {
      type: "lp", status: "open", positionKey: "123",
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

// ── Meta fields regression guard (Hyperliquid protection-gate inputs) ──

describe("capture contract — required meta fields", () => {
  it("solana.predict.buy requires meta.contracts", () => {
    const c = MUTATION_MATRIX.get("solana.predict.buy")!;
    expect(c.requiredMetaFields).toContain("contracts");
  });

  it("prediction buy with contracts in meta passes", () => {
    const valid = validateCaptureContract("solana.predict.buy", {
      type: "prediction", walletAddress: "0x", status: "open",
      positionKey: "pk", instrumentKey: "solana:predict:m1:yes",
      meta: { contracts: "3.5" },
    });
    expect(valid).toBe(true);
  });

  it("hyperliquid.perp.open requires coin+contracts+protectionState in meta", () => {
    const c = MUTATION_MATRIX.get("hyperliquid.perp.open")!;
    expect(c.requiredMetaFields).toEqual(["coin", "contracts", "protectionState"]);

    expect(validateCaptureContract("hyperliquid.perp.open", {
      type: "perps", walletAddress: "0x", status: "open", positionKey: "pk", instrumentKey: "ik",
      meta: { coin: "ETH", contracts: "1.5" }, // protectionState missing
    })).toBe(false);

    expect(validateCaptureContract("hyperliquid.perp.open", {
      type: "perps", walletAddress: "0x", status: "open", positionKey: "pk", instrumentKey: "ik",
      meta: { coin: "ETH", contracts: "1.5", protectionState: "protected" },
    })).toBe(true);
  });
});

// ── Preview detection tests ────────────────────────────────────

describe("capture contract — preview detection", () => {
  it("detects preview for tools with previewSupport", () => {
    // The two agent_activity swap executes deliberately have previewSupport:false
    // (dryRun preview would skip the approval gate before a REAL broadcast path).
    expect(isPreviewExecution("kyberswap.swap.execute", { dryRun: true })).toBe(false);
    expect(isPreviewExecution("uniswap.swap.execute", { dryRun: true })).toBe(false);
    expect(isPreviewExecution("khalani.bridge", { dryRun: true })).toBe(true);
    expect(isPreviewExecution("pendle.pt.buy", { dryRun: true })).toBe(true);
  });

  it("does not detect preview when dryRun is false or absent", () => {
    expect(isPreviewExecution("kyberswap.swap.execute", { dryRun: false })).toBe(false);
    expect(isPreviewExecution("kyberswap.swap.execute", {})).toBe(false);
  });

  it("does not detect preview for tools without previewSupport", () => {
    expect(isPreviewExecution("solana.swap.execute", { dryRun: true })).toBe(false);
    expect(isPreviewExecution("solana.predict.buy", { dryRun: true })).toBe(false);
    expect(isPreviewExecution("hyperliquid.perp.open", { dryRun: true })).toBe(false);
  });
});
