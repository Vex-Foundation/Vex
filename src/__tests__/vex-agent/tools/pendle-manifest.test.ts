import { describe, it, expect } from "vitest";
import { PENDLE_TOOLS } from "../../../vex-agent/tools/protocols/pendle/manifest.js";

describe("pendle manifest", () => {
  // ── Completeness ─────────────────────────────────────────────────

  const EXPECTED_TOOL_IDS = [
    // Read (2)
    "pendle.yields",
    "pendle.position.value",
    // Market data reads (6, T1 card R3/R4)
    "pendle.market.get",
    "pendle.market.history",
    "pendle.market.candles",
    "pendle.orderbook",
    "pendle.rewards.merkle",
    "pendle.prices.assets",
    // PT trading (4)
    "pendle.pt.quote",
    "pendle.pt.buy",
    "pendle.pt.sell",
    "pendle.pt.redeem",
    // YT trading + claim (4, P3)
    "pendle.yt.quote",
    "pendle.yt.buy",
    "pendle.yt.sell",
    "pendle.claim",
    // PY mint/redeem (3, P4)
    "pendle.py.quote",
    "pendle.py.mint",
    "pendle.py.redeem",
    // LP single-token add/remove (3, P5)
    "pendle.lp.quote",
    "pendle.lp.add",
    "pendle.lp.remove",
    // SY wrap/unwrap (2, R5d card D3) — dryRun-in-tool, no separate *.quote
    "pendle.sy.mint",
    "pendle.sy.redeem",
    // Dual-leg LP (2, R5d card E3) — one action, TWO output instruments.
    // dryRun-in-tool.
    "pendle.lp.removeDual",
    "pendle.lp.addKeepYt",
    // Term mobility (3, R5d card E4) — move a position between maturities or
    // between position types without leaving Pendle. dryRun-in-tool.
    "pendle.pt.rollover",
    "pendle.lp.transfer",
    "pendle.lp.toPt",
  ];

  it("has 29 tools total", () => {
    expect(PENDLE_TOOLS).toHaveLength(29);
    expect(EXPECTED_TOOL_IDS).toHaveLength(29);
  });

  for (const toolId of EXPECTED_TOOL_IDS) {
    it(`declares ${toolId}`, () => {
      expect(PENDLE_TOOLS.find((t) => t.toolId === toolId)).toBeDefined();
    });
  }

  it("has no tools beyond the expected list", () => {
    const expected = new Set(EXPECTED_TOOL_IDS);
    expect(PENDLE_TOOLS.filter((t) => !expected.has(t.toolId))).toHaveLength(0);
  });

  // ── Namespace + lifecycle ────────────────────────────────────────

  it("all tools belong to the pendle namespace and start with pendle.", () => {
    for (const tool of PENDLE_TOOLS) {
      expect(tool.namespace).toBe("pendle");
      expect(tool.toolId).toMatch(/^pendle\./);
    }
  });

  it("all tools are active lifecycle", () => {
    for (const tool of PENDLE_TOOLS) {
      expect(tool.lifecycle).toBe("active");
    }
  });

  // ── Mutating flags + actionKind ──────────────────────────────────

  const EXPECTED_MUTATING = [
    "pendle.pt.buy",
    "pendle.pt.sell",
    "pendle.pt.redeem",
    "pendle.yt.buy",
    "pendle.yt.sell",
    "pendle.claim",
    "pendle.py.mint",
    "pendle.py.redeem",
    "pendle.lp.add",
    "pendle.lp.remove",
    "pendle.sy.mint",
    "pendle.sy.redeem",
    "pendle.lp.removeDual",
    "pendle.lp.addKeepYt",
    "pendle.pt.rollover",
    "pendle.lp.transfer",
    "pendle.lp.toPt",
  ];

  it("has exactly the expected mutating tools", () => {
    const mutating = PENDLE_TOOLS.filter((t) => t.mutating).map((t) => t.toolId).sort();
    expect(mutating).toEqual([...EXPECTED_MUTATING].sort());
  });

  it("every mutating tool is a user_wallet_broadcast", () => {
    for (const toolId of EXPECTED_MUTATING) {
      const tool = PENDLE_TOOLS.find((t) => t.toolId === toolId)!;
      expect(tool.actionKind).toBe("user_wallet_broadcast");
    }
  });

  it("read-only tools are actionKind read and not mutating", () => {
    const mutatingSet = new Set(EXPECTED_MUTATING);
    for (const tool of PENDLE_TOOLS.filter((t) => !mutatingSet.has(t.toolId))) {
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
    }
  });

  // ── Required params ──────────────────────────────────────────────

  it("YT buy/sell require chain, tokenIn, tokenOut, amountIn and support dryRun", () => {
    for (const toolId of ["pendle.yt.buy", "pendle.yt.sell"]) {
      const tool = PENDLE_TOOLS.find((t) => t.toolId === toolId)!;
      const required = tool.params.filter((p) => p.required).map((p) => p.key);
      expect(required).toEqual(expect.arrayContaining(["chain", "tokenIn", "tokenOut", "amountIn"]));
      expect(tool.params.some((p) => p.key === "dryRun")).toBe(true);
    }
  });

  it("pendle.yt.quote requires chain, tokenIn, tokenOut, amountIn (read — no dryRun)", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.yt.quote")!;
    const required = tool.params.filter((p) => p.required).map((p) => p.key);
    expect(required).toEqual(expect.arrayContaining(["chain", "tokenIn", "tokenOut", "amountIn"]));
  });

  it("pendle.py.quote requires chain, direction, pt, amountIn (read — no dryRun)", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.py.quote")!;
    const required = tool.params.filter((p) => p.required).map((p) => p.key);
    expect(required).toEqual(expect.arrayContaining(["chain", "direction", "pt", "amountIn"]));
    expect(tool.params.some((p) => p.key === "dryRun")).toBe(false);
  });

  it("pendle.py.mint requires chain, pt, tokenIn, amountIn and supports dryRun", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.py.mint")!;
    const required = tool.params.filter((p) => p.required).map((p) => p.key);
    expect(required).toEqual(expect.arrayContaining(["chain", "pt", "tokenIn", "amountIn"]));
    expect(tool.params.some((p) => p.key === "dryRun")).toBe(true);
  });

  it("pendle.py.redeem requires chain, pt, amountIn; tokenOut optional; supports dryRun", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.py.redeem")!;
    const required = tool.params.filter((p) => p.required).map((p) => p.key);
    expect(required).toEqual(expect.arrayContaining(["chain", "pt", "amountIn"]));
    expect(tool.params.some((p) => p.key === "tokenOut" && !p.required)).toBe(true);
    expect(tool.params.some((p) => p.key === "dryRun")).toBe(true);
  });

  it("pendle.lp.quote requires chain, direction, market, amountIn (read — no dryRun)", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.lp.quote")!;
    const required = tool.params.filter((p) => p.required).map((p) => p.key);
    expect(required).toEqual(expect.arrayContaining(["chain", "direction", "market", "amountIn"]));
    expect(tool.params.some((p) => p.key === "dryRun")).toBe(false);
  });

  it("pendle.lp.add requires chain, market, tokenIn, amountIn and supports dryRun", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.lp.add")!;
    const required = tool.params.filter((p) => p.required).map((p) => p.key);
    expect(required).toEqual(expect.arrayContaining(["chain", "market", "tokenIn", "amountIn"]));
    expect(tool.params.some((p) => p.key === "dryRun")).toBe(true);
  });

  it("pendle.lp.remove requires chain, market, amountIn; tokenOut optional; supports dryRun", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.lp.remove")!;
    const required = tool.params.filter((p) => p.required).map((p) => p.key);
    expect(required).toEqual(expect.arrayContaining(["chain", "market", "amountIn"]));
    expect(tool.params.some((p) => p.key === "tokenOut" && !p.required)).toBe(true);
    expect(tool.params.some((p) => p.key === "dryRun")).toBe(true);
  });

  it("LP surface descriptions state LP is not a fixed-rate lock / stops earning after expiry", () => {
    for (const toolId of ["pendle.lp.quote", "pendle.lp.add", "pendle.lp.remove"]) {
      const tool = PENDLE_TOOLS.find((t) => t.toolId === toolId)!;
      expect(tool.description.toLowerCase()).toMatch(/not a fixed-rate lock|stops earning|no longer earns/);
    }
  });

  it("pendle.claim requires only chain; market is optional; supports dryRun", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.claim")!;
    const required = tool.params.filter((p) => p.required).map((p) => p.key);
    expect(required).toEqual(["chain"]);
    expect(tool.params.some((p) => p.key === "market" && !p.required)).toBe(true);
    expect(tool.params.some((p) => p.key === "dryRun")).toBe(true);
  });

  // ── Descriptions + discovery ─────────────────────────────────────

  it("every tool has a non-empty description and discovery metadata", () => {
    for (const tool of PENDLE_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(15);
      expect(tool.discovery).toBeDefined();
      expect(tool.discovery.embeddingText.length).toBeGreaterThan(0);
    }
  });

  it("YT surface descriptions carry the decay warning (never fixed-yield framing)", () => {
    for (const toolId of ["pendle.yt.quote", "pendle.yt.buy", "pendle.yt.sell"]) {
      const tool = PENDLE_TOOLS.find((t) => t.toolId === toolId)!;
      expect(tool.description.toLowerCase()).toMatch(/decay|variable/);
    }
  });

  it("pendle.claim description states it moves income, not principal", () => {
    const tool = PENDLE_TOOLS.find((t) => t.toolId === "pendle.claim")!;
    expect(tool.description.toLowerCase()).toContain("never principal");
  });
});
