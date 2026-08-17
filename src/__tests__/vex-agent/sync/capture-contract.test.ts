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

  it("no deleted-tool matrix row survives (limitOrder, zap, Polymarket, old kyber/uniswap buy/sell, Hyperliquid)", () => {
    for (const toolId of [
      "kyberswap.limitOrder.create", "kyberswap.limitOrder.cancel", "kyberswap.limitOrder.hardCancel",
      "kyberswap.limitOrder.fill", "kyberswap.limitOrder.batchFill", "kyberswap.limitOrder.cancelAll",
      "kyberswap.zap.in", "kyberswap.zap.out", "kyberswap.zap.migrate",
      "polymarket.clob.buy", "polymarket.clob.sell", "polymarket.clob.cancel",
      "polymarket.clob.cancelOrders", "polymarket.clob.cancelAll", "polymarket.clob.cancelMarket",
      "polymarket.clob.heartbeat", "polymarket.bridge.deposit", "polymarket.bridge.withdraw",
      "kyberswap.swap.buy", "kyberswap.swap.sell", "uniswap.swap.buy", "uniswap.swap.sell",
      // Agent Scan Phase 3 (Hyperliquid total removal) — spot/perp/risk/account rows.
      "hyperliquid.spot.trade", "hyperliquid.perp.open", "hyperliquid.perp.close",
      "hyperliquid.perp.setTpsl", "hyperliquid.perp.modifyOrder", "hyperliquid.perp.cancelOrders",
      "hyperliquid.perp.setLeverage", "hyperliquid.perp.adjustMargin", "hyperliquid.perp.twap",
      "hyperliquid.risk.proposeSetup", "hyperliquid.deposit", "hyperliquid.transfer.usdClass",
      "hyperliquid.withdraw", "hyperliquid.transfer.send", "hyperliquid.vault.transfer",
      "hyperliquid.staking.delegate", "hyperliquid.staking.transfer", "hyperliquid.rewards.claim",
      "hyperliquid.builder.approveFee",
    ]) {
      expect(MUTATION_MATRIX.has(toolId), `${toolId} should have been deleted from the matrix`).toBe(false);
    }
  });

  it("the unified kyberswap.swap.execute / uniswap.swap.execute / solana.swap.execute rows exist, capture:none", () => {
    // solana.swap.execute flipped full->none in W5 (design §3/§6, migration
    // 049) with the fee-bearing /build atomic flip — same K2 staged Solana
    // seam kyberswap/uniswap already use on EVM.
    for (const toolId of ["kyberswap.swap.execute", "uniswap.swap.execute", "solana.swap.execute"]) {
      const c = MUTATION_MATRIX.get(toolId);
      expect(c, `${toolId} missing from matrix`).toBeDefined();
      expect(c!.kind).toBe("trade");
      expect(c!.capture).toBe("none");
      expect(c!.expectedType).toBe("swap");
      expect(c!.requiredFields).toEqual([]);
    }
  });

  it("solana.predict.buy/.sell/.claim/.closeAll are capture:none (W5 staged Solana seam, migration 049)", () => {
    for (const toolId of ["solana.predict.buy", "solana.predict.sell", "solana.predict.claim", "solana.predict.closeAll"]) {
      const c = MUTATION_MATRIX.get(toolId);
      expect(c, `${toolId} missing from matrix`).toBeDefined();
      expect(c!.kind).toBe("trade");
      expect(c!.capture).toBe("none");
      expect(c!.expectedType).toBe("prediction");
      expect(c!.requiredFields).toEqual([]);
    }
    expect(MUTATION_MATRIX.get("solana.predict.closeAll")!.fanOut).toBe("items");
  });

  it("NO live matrix tool is capture:full any more (Batch B card B2 flipped the last seven — Pendle)", () => {
    // The 7 that used to be here were pendle.pt.buy/sell/redeem, pendle.yt.buy/
    // sell and pendle.py.mint/redeem; card B2 flipped every Pendle mutation to
    // capture:"none" (migration 053 — the handler writes `kind: 'yield'` rows
    // to agent_activity directly). Every mutating tool in the repo now owns its
    // durable truth; the legacy proj_activity projection has no live producer.
    // The `capture: "full"` branch of capture-validator.ts stays supported for
    // the next protocol that needs it (exercised below against pendle-free
    // fixtures via the unknown-tool/synthetic paths).
    expect([...MUTATION_MATRIX].filter(([, c]) => c.capture === "full")).toEqual([]);
  });

  it("no utility-kind tools are currently classified (Hyperliquid removal deleted the only one)", () => {
    // hyperliquid.risk.proposeSetup was the sole "utility" (no portfolio
    // impact) entry until Agent Scan Phase 3 deleted it with the protocol.
    // `trench.launch_request_form` (migration 062) is the successor this
    // comment predicted: mutating (it drafts a launch-intent row and parks the
    // turn) but zero portfolio impact and no capture — signs nothing.
    expect(getToolsByKind("utility").map(([id]) => id)).toEqual(["trench.launch_request_form"]);
  });

  it("every audit tool is now a staged agent_activity write path (Phase 2 bridges + W5/Batch5 lend + Batch B pendle.claim)", () => {
    const audit = getToolsByKind("audit");
    expect(audit.length).toBeGreaterThan(0);
    // khalani.bridge / relay.bridge record their full staged lifecycle in
    // agent_activity directly (migration 045); solana.lend.deposit/withdraw
    // and solana.lend.borrowOperate (Batch 5, card B1) do the same via the K2
    // staged Solana seam (migration 049); morpho.vault.deposit/withdraw (E3b-2)
    // and the four morpho.market.* borrow-lane operations (E3c) do the same
    // through morpho/handlers/signed-broadcast.ts; morpho.rewards.claim does the
    // same through signed-broadcast/claim-broadcast.ts, writing the one
    // `yield_claim` row a claim transaction can back — capture is intentionally
    // off for exactly these.
    const captureNone = audit.filter(([, c]) => c.capture === "none").map(([id]) => id).sort();
    expect(captureNone).toEqual([
      "khalani.bridge",
      "morpho.market.borrow", "morpho.market.repay",
      "morpho.market.supplyCollateral", "morpho.market.withdrawCollateral",
      "morpho.rewards.claim",
      "morpho.vault.deposit", "morpho.vault.withdraw", "pendle.claim",
      "relay.bridge",
      "solana.lend.borrowOperate", "solana.lend.deposit", "solana.lend.withdraw",
    ]);
    for (const [toolId, c] of audit) {
      if (captureNone.includes(toolId)) continue;
      expect(c.capture, `${toolId} should have capture:full`).toBe("full");
    }
  });

  it("projection kind is exactly the Pendle LP lifecycle rows, all capture:none (Batch B card B2; R5d E5)", () => {
    // The dual-leg pair joined at card E5 on the same terms as lp.add/lp.remove:
    // an LP lifecycle row, no LP economics, and never a second quote-derived
    // truth beside the handler's own agent_activity write.
    const projection = getToolsByKind("projection");
    expect(projection.map(([id]) => id).sort()).toEqual([
      "pendle.lp.add",
      "pendle.lp.addKeepYt",
      "pendle.lp.remove",
      "pendle.lp.removeDual",
    ]);
    for (const [toolId, c] of projection) {
      expect(c.capture, `${toolId} should have capture:none`).toBe("none");
    }
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

// Batch B card B2: Pendle flipped capture:"full"->"none", so NO live matrix
// tool is capture:"full" any more and the generic capture:"full" validator
// arms (missing capture, wrong type, missing required field) have no live
// example left to exercise. They are NOT deleted silently: the branches stay
// in `capture-validator.ts` for the next protocol that declares a capture, and
// the structural pin above ("NO live matrix tool is capture:full any more") is
// what will fail loudly if one appears without matching validator coverage.
// The `hasRequiredFieldException` stableSwap/ambiguousSwap branch is likewise
// dead with no matrix consumer — flagged for the coordinator rather than
// silently removed (out of this card's stated scope).
describe("capture contract — runtime validator", () => {
  it("passes capture:none regardless of tradeCapture — every Pendle mutation (Batch B card B2)", () => {
    for (const toolId of ["pendle.pt.buy", "pendle.py.mint", "pendle.lp.add", "pendle.claim"]) {
      expect(validateCaptureContract(toolId, null), toolId).toBe(true);
      expect(validateCaptureContract(toolId, { type: "yield" }), toolId).toBe(true);
    }
  });

  it("passes capture:none regardless of tradeCapture (e.g. the Agent Scan unified executes)", () => {
    expect(validateCaptureContract("kyberswap.swap.execute", null)).toBe(true);
    expect(validateCaptureContract("kyberswap.swap.execute", { type: "swap" })).toBe(true);
    expect(validateCaptureContract("solana.swap.execute", null)).toBe(true);
  });

  it("passes unknown toolId (not in matrix)", () => {
    expect(validateCaptureContract("unknown.tool", null)).toBe(true);
  });

  it("passes capture:none regardless of tradeCapture — solana.predict.claim/closeAll (W5 staged Solana seam)", () => {
    expect(validateCaptureContract("solana.predict.claim", null)).toBe(true);
    expect(validateCaptureContract("solana.predict.claim", { type: "prediction" })).toBe(true);
    expect(validateCaptureContract("solana.predict.closeAll", null)).toBe(true);
  });

  it("passes capture:none regardless of tradeCapture — solana.lend.deposit/withdraw (W5 staged Solana seam)", () => {
    expect(validateCaptureContract("solana.lend.deposit", null)).toBe(true);
    expect(validateCaptureContract("solana.lend.deposit", { type: "lend" })).toBe(true);
    expect(validateCaptureContract("solana.lend.withdraw", null)).toBe(true);
  });

  it("passes capture:none regardless of tradeCapture — solana.lend.borrowOperate (Batch 5, card B1)", () => {
    expect(validateCaptureContract("solana.lend.borrowOperate", null)).toBe(true);
    expect(validateCaptureContract("solana.lend.borrowOperate", { type: "lend" })).toBe(true);
  });
});

// requiredMetaFields (nested-invariant support in capture-validator.ts) has no
// LIVE matrix example anymore: Hyperliquid's perp.* rows (deleted, Agent Scan
// Phase 3) and solana.predict.buy (flipped to capture:"none", W5 migration
// 049 — requiredMetaFields no longer set) were its only two users. Left
// dormant-but-reserved for the next protocol that needs it, same treatment as
// the (also currently empty) "utility" CaptureKind above — no dedicated
// mechanism test without a real `validateCaptureContract` entry point that
// accepts a synthetic contract.

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
  });
});
