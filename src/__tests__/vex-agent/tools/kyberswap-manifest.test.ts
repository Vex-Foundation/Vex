import { describe, it, expect } from "vitest";
import { KYBERSWAP_TOOLS } from "../../../vex-agent/tools/protocols/kyberswap/manifest.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";

describe("kyberswap manifest", () => {
  // ── Completeness ─────────────────────────────────────────────────

  it("has 20 tools total", () => {
    expect(KYBERSWAP_TOOLS).toHaveLength(20);
  });

  const EXPECTED_TOOL_IDS = [
    // Chains (2)
    "kyberswap.chains",
    "kyberswap.chains.supported",
    // Tokens (1)
    "kyberswap.tokens.check",
    // Swap (3)
    "kyberswap.swap.quote",
    "kyberswap.swap.sell",
    "kyberswap.swap.buy",
    // Limit Order — Maker (5)
    "kyberswap.limitOrder.list",
    "kyberswap.limitOrder.activeMakingAmount",
    "kyberswap.limitOrder.create",
    "kyberswap.limitOrder.cancel",
    "kyberswap.limitOrder.hardCancel",
    // Limit Order — Taker (4)
    "kyberswap.limitOrder.pairs",
    "kyberswap.limitOrder.takerOrders",
    "kyberswap.limitOrder.fill",
    "kyberswap.limitOrder.batchFill",
    // Limit Order — Cancel All (1)
    "kyberswap.limitOrder.cancelAll",
    // Zap (4)
    "kyberswap.zap.in",
    "kyberswap.zap.out",
    "kyberswap.zap.migrate",
    "kyberswap.zap.list",
  ];

  it("expected toolId count matches manifest count", () => {
    expect(EXPECTED_TOOL_IDS).toHaveLength(20);
  });

  for (const toolId of EXPECTED_TOOL_IDS) {
    it(`declares ${toolId}`, () => {
      const tool = KYBERSWAP_TOOLS.find(t => t.toolId === toolId);
      expect(tool).toBeDefined();
    });
  }

  it("has no tools beyond expected list", () => {
    const expectedSet = new Set(EXPECTED_TOOL_IDS);
    const unexpected = KYBERSWAP_TOOLS.filter(t => !expectedSet.has(t.toolId));
    expect(unexpected).toHaveLength(0);
  });

  // ── Namespace ────────────────────────────────────────────────────

  it("all tools belong to kyberswap namespace", () => {
    for (const tool of KYBERSWAP_TOOLS) {
      expect(tool.namespace).toBe("kyberswap");
    }
  });

  it("all tools are active lifecycle", () => {
    for (const tool of KYBERSWAP_TOOLS) {
      expect(tool.lifecycle).toBe("active");
    }
  });

  it("all toolIds start with kyberswap.", () => {
    for (const tool of KYBERSWAP_TOOLS) {
      expect(tool.toolId).toMatch(/^kyberswap\./);
    }
  });

  // ── Mutating flags ───────────────────────────────────────────────

  const EXPECTED_MUTATING = [
    "kyberswap.swap.sell",
    "kyberswap.swap.buy",
    "kyberswap.limitOrder.create",
    "kyberswap.limitOrder.cancel",
    "kyberswap.limitOrder.hardCancel",
    "kyberswap.limitOrder.fill",
    "kyberswap.limitOrder.batchFill",
    "kyberswap.limitOrder.cancelAll",
    "kyberswap.zap.in",
    "kyberswap.zap.out",
    "kyberswap.zap.migrate",
  ];

  it("has correct number of mutating tools", () => {
    const mutating = KYBERSWAP_TOOLS.filter(t => t.mutating);
    expect(mutating).toHaveLength(EXPECTED_MUTATING.length);
  });

  for (const toolId of EXPECTED_MUTATING) {
    it(`${toolId} is mutating`, () => {
      const tool = KYBERSWAP_TOOLS.find(t => t.toolId === toolId)!;
      expect(tool.mutating).toBe(true);
    });
  }

  it("read-only tools are not mutating", () => {
    const mutatingSet = new Set(EXPECTED_MUTATING);
    const readOnly = KYBERSWAP_TOOLS.filter(t => !mutatingSet.has(t.toolId));
    for (const tool of readOnly) {
      expect(tool.mutating).toBe(false);
    }
  });

  // ── Required params ──────────────────────────────────────────────

  it("kyberswap.swap.sell requires chain, tokenIn, tokenOut, amountIn", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.sell")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("tokenIn");
    expect(required).toContain("tokenOut");
    expect(required).toContain("amountIn");
  });

  it("kyberswap.limitOrder.create requires chain, makerAsset, takerAsset, makingAmount, takingAmount, expires", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.limitOrder.create")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("makerAsset");
    expect(required).toContain("takerAsset");
    expect(required).toContain("makingAmount");
    expect(required).toContain("takingAmount");
    expect(required).toContain("expires");
  });

  it("kyberswap.zap.in requires chain, dex, pool, tokenIn, amountIn", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.zap.in")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("dex");
    expect(required).toContain("pool");
    expect(required).toContain("tokenIn");
    expect(required).toContain("amountIn");
  });

  it("kyberswap.limitOrder.batchFill requires chain, orderIds, takingAmounts, thresholdAmount", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.limitOrder.batchFill")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("orderIds");
    expect(required).toContain("takingAmounts");
    expect(required).toContain("thresholdAmount");
  });

  it("kyberswap.limitOrder.cancelAll requires only chain", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.limitOrder.cancelAll")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual(["chain"]);
  });

  it("kyberswap.chains has no required params", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.chains")!;
    const required = tool.params.filter(p => p.required);
    expect(required).toHaveLength(0);
  });

  it("kyberswap.tokens.check requires chain and address", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.tokens.check")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("address");
  });

  // ── No requiresEnv (KyberSwap is free) ──────────────────────────

  it("no tools require ENV", () => {
    for (const tool of KYBERSWAP_TOOLS) {
      expect(tool.requiresEnv).toBeUndefined();
    }
  });

  // ── Descriptions quality ─────────────────────────────────────────

  it("every tool has non-empty description", () => {
    for (const tool of KYBERSWAP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(15);
    }
  });

  it("every param has non-empty description", () => {
    for (const tool of KYBERSWAP_TOOLS) {
      for (const param of tool.params) {
        expect(param.description.length).toBeGreaterThan(3);
      }
    }
  });

  // ── Swap hardening: exact-input semantics ─────────────────────

  it("swap.sell and swap.buy describe exact-input semantics", () => {
    const sell = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.sell")!;
    const buy = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.buy")!;
    expect(sell.description).toContain("exact-input");
    expect(buy.description).toContain("exact-input");
  });

  it("swap tools reference khalani as resolver, not kyberswap", () => {
    const sell = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.sell")!;
    const buy = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.buy")!;
    expect(sell.description).toContain("khalani.tokens.search");
    expect(buy.description).toContain("khalani.tokens.search");
  });

  // ── Zap hardening: DEX_* IDs ──────────────────────────────────

  it("zap exampleParams use DEX_* format IDs", () => {
    const zapIn = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.zap.in")!;
    const zapOut = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.zap.out")!;
    const zapMigrate = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.zap.migrate")!;
    expect(zapIn.exampleParams.dex).toMatch(/^DEX_/);
    expect(zapOut.exampleParams.dex).toMatch(/^DEX_/);
    expect(zapMigrate.exampleParams.dexFrom).toMatch(/^DEX_/);
    expect(zapMigrate.exampleParams.dexTo).toMatch(/^DEX_/);
  });

  it("zap.list is a read-only tool", () => {
    const zapList = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.zap.list")!;
    expect(zapList).toBeDefined();
    expect(zapList.mutating).toBe(false);
  });

  // ── Etap 1: quote↔execute slippageBps param-surface alignment ──────
  //
  // Regression guard for the deterministic no_quote swap-block loop. The
  // prequote gate binds slippageBps into the match-hash from the QUOTE params
  // (recorder) and the EXECUTE params (gate). Previously kyberswap.swap.quote
  // did NOT declare slippageBps, so the dispatcher's strict param boundary
  // REJECTED a quote carrying it (and the agent never passed it), so every
  // recorded quote hashed slippage="" while a buy/sell carrying slippageBps:50
  // hashed "50" → unwinnable no_quote block. The quote must accept the same
  // optional slippageBps the execute tools accept.

  const quoteTool = () => KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.quote")!;

  it("kyberswap.swap.quote declares an optional slippageBps number param", () => {
    const slippage = quoteTool().params.find(p => p.key === "slippageBps");
    expect(slippage).toBeDefined();
    expect(slippage!.type).toBe("number");
    expect(slippage!.required).not.toBe(true);
    // The description must steer the agent to match the value on the execute call.
    expect(slippage!.description.toLowerCase()).toContain("slippage");
    expect(slippage!.description.toLowerCase()).toMatch(/same|match/);
  });

  it("the dispatcher param boundary ACCEPTS slippageBps on kyberswap.swap.quote", () => {
    const v = validateProtocolParams(quoteTool(), {
      chain: "base",
      tokenIn: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      tokenOut: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      amountIn: "1",
      slippageBps: 50,
    });
    expect(v.ok).toBe(true);
  });

  it("quote/sell/buy exampleParams all carry a consistent slippageBps", () => {
    for (const toolId of ["kyberswap.swap.quote", "kyberswap.swap.sell", "kyberswap.swap.buy"]) {
      const tool = KYBERSWAP_TOOLS.find(t => t.toolId === toolId)!;
      expect(tool.exampleParams.slippageBps).toBe(50);
    }
  });

  // ── Etap 4: always-exact approvals — `approveExact` removed from the surface ──
  //
  // Approvals are now always exact (see `ensureKyberAllowance`), so the opt-in
  // param is gone from the swap sell/buy + zap.in manifests. The prequote gate
  // already blocked an execute passing `approveExact: true` (it diverges the
  // match-hash → no_quote), so the tool contract must not advertise it either —
  // and the strict dispatcher boundary must reject a model that still passes it.

  it("kyberswap.swap.sell/buy no longer declare approveExact", () => {
    for (const toolId of ["kyberswap.swap.sell", "kyberswap.swap.buy"]) {
      const tool = KYBERSWAP_TOOLS.find(t => t.toolId === toolId)!;
      expect(tool.params.some(p => p.key === "approveExact")).toBe(false);
    }
  });

  it("kyberswap.zap.in no longer declares approveExact", () => {
    const zapIn = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.zap.in")!;
    expect(zapIn.params.some(p => p.key === "approveExact")).toBe(false);
  });

  it("the dispatcher param boundary REJECTS approveExact on kyberswap.swap.buy", () => {
    const buy = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.buy")!;
    const v = validateProtocolParams(buy, {
      chain: "base",
      tokenIn: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      tokenOut: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      amountIn: "100",
      slippageBps: 50,
      approveExact: true,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('Unknown parameter "approveExact"');
  });
});
