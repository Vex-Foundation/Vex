import { describe, it, expect } from "vitest";
import { KYBERSWAP_TOOLS } from "../../../vex-agent/tools/protocols/kyberswap/manifest.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";

describe("kyberswap manifest", () => {
  // ── Completeness ─────────────────────────────────────────────────
  //
  // Agent Scan plan §4.2 deleted limit-order (10) + zap (4) tooling and
  // collapsed swap.sell/swap.buy into ONE unified swap.execute.

  it("has 5 tools total", () => {
    expect(KYBERSWAP_TOOLS).toHaveLength(5);
  });

  const EXPECTED_TOOL_IDS = [
    // Chains (2)
    "kyberswap.chains",
    "kyberswap.chains.supported",
    // Tokens (1)
    "kyberswap.tokens.check",
    // Swap (2)
    "kyberswap.swap.quote",
    "kyberswap.swap.execute",
  ];

  it("expected toolId count matches manifest count", () => {
    expect(EXPECTED_TOOL_IDS).toHaveLength(5);
  });

  for (const toolId of EXPECTED_TOOL_IDS) {
    it(`declares ${toolId}`, () => {
      const tool = KYBERSWAP_TOOLS.find(t => t.toolId === toolId);
      expect(tool).toBeDefined();
    });
  }

  it("has no tools beyond expected list (limit-order/zap are gone)", () => {
    const expectedSet = new Set(EXPECTED_TOOL_IDS);
    const unexpected = KYBERSWAP_TOOLS.filter(t => !expectedSet.has(t.toolId));
    expect(unexpected).toHaveLength(0);
  });

  it("does not declare any limitOrder or zap tool", () => {
    for (const tool of KYBERSWAP_TOOLS) {
      expect(tool.toolId).not.toMatch(/^kyberswap\.limitOrder\./);
      expect(tool.toolId).not.toMatch(/^kyberswap\.zap\./);
    }
  });

  it("does not declare the retired swap.sell/swap.buy toolIds", () => {
    const toolIds = KYBERSWAP_TOOLS.map(t => t.toolId);
    expect(toolIds).not.toContain("kyberswap.swap.sell");
    expect(toolIds).not.toContain("kyberswap.swap.buy");
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

  const EXPECTED_MUTATING = ["kyberswap.swap.execute"];

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

  it("kyberswap.swap.execute carries actionKind user_wallet_broadcast", () => {
    const execute = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.execute")!;
    expect(execute.actionKind).toBe("user_wallet_broadcast");
  });

  // ── Required params ──────────────────────────────────────────────

  it("kyberswap.swap.execute requires chain, tokenIn, tokenOut, amountIn", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.execute")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("chain");
    expect(required).toContain("tokenIn");
    expect(required).toContain("tokenOut");
    expect(required).toContain("amountIn");
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

  // ── Unified swap contract (plan §4.2/§11.2): no side/recipient/dryRun ──

  it("kyberswap.swap.execute does not declare side, recipient, or dryRun", () => {
    const tool = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.execute")!;
    const keys = tool.params.map(p => p.key);
    expect(keys).not.toContain("side");
    expect(keys).not.toContain("recipient");
    expect(keys).not.toContain("dryRun");
    expect(keys).not.toContain("approveExact");
  });

  it("the dispatcher param boundary REJECTS a legacy recipient param on kyberswap.swap.execute", () => {
    const execute = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.execute")!;
    const v = validateProtocolParams(execute, {
      chain: "base",
      tokenIn: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      tokenOut: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      amountIn: "100",
      recipient: "0xcccccccccccccccccccccccccccccccccccccc",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('Unknown parameter "recipient"');
  });

  it("swap.execute describes exact-input semantics", () => {
    const execute = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.execute")!;
    expect(execute.description).toContain("exact-input");
  });

  it("swap.execute requires a fresh matching quote first", () => {
    const execute = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.execute")!;
    expect(execute.description.toLowerCase()).toContain("quote");
  });

  // ── Etap 1: quote↔execute slippageBps param-surface alignment ──────
  //
  // Regression guard for the deterministic no_quote swap-block loop. The
  // prequote gate binds slippageBps into the match-hash from the QUOTE params
  // (recorder) and the EXECUTE params (gate). The quote must accept the same
  // optional slippageBps the execute tool accepts.

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

  it("quote/execute exampleParams both carry a consistent slippageBps", () => {
    for (const toolId of ["kyberswap.swap.quote", "kyberswap.swap.execute"]) {
      const tool = KYBERSWAP_TOOLS.find(t => t.toolId === toolId)!;
      expect(tool.exampleParams.slippageBps).toBe(50);
    }
  });

  // ── Etap 4: always-exact approvals — `approveExact` removed from the surface ──

  it("the dispatcher param boundary REJECTS approveExact on kyberswap.swap.execute", () => {
    const execute = KYBERSWAP_TOOLS.find(t => t.toolId === "kyberswap.swap.execute")!;
    const v = validateProtocolParams(execute, {
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
