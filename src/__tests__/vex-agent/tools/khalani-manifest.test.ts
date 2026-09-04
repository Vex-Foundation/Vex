import { describe, it, expect } from "vitest";
import { KHALANI_TOOLS } from "../../../vex-agent/tools/protocols/khalani/manifest.js";

describe("khalani manifest", () => {
  // ── Completeness ─────────────────────────────────────────────────

  it("has exactly 9 tools", () => {
    expect(KHALANI_TOOLS).toHaveLength(9);
  });

  const EXPECTED_TOOL_IDS = [
    "khalani.chains.list",
    "khalani.tokens.top",
    "khalani.tokens.search",
    "khalani.tokens.autocomplete",
    "khalani.tokens.balances",
    "khalani.quote.get",
    "khalani.orders.list",
    "khalani.orders.get",
    "khalani.bridge",
  ];

  for (const toolId of EXPECTED_TOOL_IDS) {
    it(`declares ${toolId}`, () => {
      const tool = KHALANI_TOOLS.find(t => t.toolId === toolId);
      expect(tool).toBeDefined();
    });
  }

  // ── Namespace consistency ────────────────────────────────────────

  it("all tools belong to khalani namespace", () => {
    for (const tool of KHALANI_TOOLS) {
      expect(tool.namespace).toBe("khalani");
    }
  });

  it("all tools are active lifecycle", () => {
    for (const tool of KHALANI_TOOLS) {
      expect(tool.lifecycle).toBe("active");
    }
  });

  it("all toolIds start with khalani.", () => {
    for (const tool of KHALANI_TOOLS) {
      expect(tool.toolId).toMatch(/^khalani\./);
    }
  });

  // ── Mutating flags ───────────────────────────────────────────────

  it("only khalani.bridge is mutating", () => {
    const mutating = KHALANI_TOOLS.filter(t => t.mutating);
    expect(mutating).toHaveLength(1);
    expect(mutating[0].toolId).toBe("khalani.bridge");
  });

  it("read-only tools are not mutating", () => {
    const readOnly = KHALANI_TOOLS.filter(t => t.toolId !== "khalani.bridge");
    for (const tool of readOnly) {
      expect(tool.mutating).toBe(false);
    }
  });

  // ── Required params ──────────────────────────────────────────────

  it("khalani.tokens.search requires query", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.tokens.search")!;
    const queryParam = tool.params.find(p => p.key === "query");
    expect(queryParam).toBeDefined();
    expect(queryParam!.required).toBe(true);
  });

  it("khalani.tokens.autocomplete requires keyword", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.tokens.autocomplete")!;
    const keywordParam = tool.params.find(p => p.key === "keyword");
    expect(keywordParam).toBeDefined();
    expect(keywordParam!.required).toBe(true);
  });

  it("khalani.quote.get requires fromChain, fromToken, toChain, toToken, amountRaw", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.quote.get")!;
    const requiredKeys = tool.params.filter(p => p.required).map(p => p.key);
    expect(requiredKeys).toContain("fromChain");
    expect(requiredKeys).toContain("fromToken");
    expect(requiredKeys).toContain("toChain");
    expect(requiredKeys).toContain("toToken");
    expect(requiredKeys).toContain("amountRaw");
  });

  it("khalani.bridge requires fromChain, fromToken, toChain, toToken, amountRaw", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.bridge")!;
    const requiredKeys = tool.params.filter(p => p.required).map(p => p.key);
    expect(requiredKeys).toContain("fromChain");
    expect(requiredKeys).toContain("fromToken");
    expect(requiredKeys).toContain("toChain");
    expect(requiredKeys).toContain("toToken");
    expect(requiredKeys).toContain("amountRaw");
  });

  it("khalani.orders.get requires orderId", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.orders.get")!;
    const requiredKeys = tool.params.filter(p => p.required).map(p => p.key);
    expect(requiredKeys).toEqual(["orderId"]);
  });

  it("khalani.chains.list has no required params", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.chains.list")!;
    const requiredKeys = tool.params.filter(p => p.required);
    expect(requiredKeys).toHaveLength(0);
  });

  // ── Descriptions quality ─────────────────────────────────────────

  it("every tool has non-empty description", () => {
    for (const tool of KHALANI_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(15);
    }
  });

  it("every param has non-empty description", () => {
    for (const tool of KHALANI_TOOLS) {
      for (const param of tool.params) {
        expect(param.description.length).toBeGreaterThan(5);
      }
    }
  });

  it("every tool has retrieval-only embedding text", () => {
    // Note: pre-refactor every passage interpolated the full chain string
    // (which contained "Solana"), so the per-tool "contains Solana" check
    // was incidentally satisfied. After moving the chain enumeration to
    // the structured `chains` field, only passages whose user intent
    // actually involves Solana name it explicitly. We assert the full
    // chain set contains "Solana" via the `chains` field instead.
    for (const tool of KHALANI_TOOLS) {
      expect(
        tool.discovery?.embeddingText,
        `${tool.toolId} missing discovery.embeddingText`,
      ).toBeTruthy();
      expect(tool.discovery!.embeddingText!.length).toBeGreaterThan(80);
      expect(tool.discovery?.chains, `${tool.toolId} missing discovery.chains`).toBeDefined();
      expect(tool.discovery!.chains!).toContain("Solana");
    }
  });

  // Note: assertions below check intent-level content the agent-style
  // refactor preserves. Implementation-detail phrases ("Hyperstream",
  // "Across", "CONTRACT_CALL/PERMIT2/TRANSFER", "canonical cross-chain
  // token resolver", lifecycle status enums) were API-doc jargon and
  // were intentionally replaced with user-intent phrasing in the new
  // passages. The deposit-method tokens still appear in `description`/
  // `params` for power-user lexical exact-match.

  it("quote embedding text captures bridge preview intent", () => {
    const quote = KHALANI_TOOLS.find(t => t.toolId === "khalani.quote.get")!;
    expect(quote.discovery?.embeddingText?.toLowerCase()).toContain("preview a cross-chain bridge");
    expect(quote.discovery?.embeddingText?.toLowerCase()).toContain("compare bridge routes");
    expect(quote.discovery?.embeddingText?.toLowerCase()).toContain("read-only");
  });

  it("bridge embedding text captures cross-chain transfer intent", () => {
    const bridge = KHALANI_TOOLS.find(t => t.toolId === "khalani.bridge")!;
    expect(bridge.discovery?.embeddingText).toContain("Move tokens between blockchains");
    expect(bridge.discovery?.embeddingText?.toLowerCase()).toContain("bridge funds");
    expect(bridge.discovery?.embeddingText?.toLowerCase()).toContain("cross-chain transfer");
  });

  it("token resolver embeddings distinguish search, autocomplete, and balances", () => {
    const search = KHALANI_TOOLS.find(t => t.toolId === "khalani.tokens.search")!;
    const autocomplete = KHALANI_TOOLS.find(t => t.toolId === "khalani.tokens.autocomplete")!;
    const balances = KHALANI_TOOLS.find(t => t.toolId === "khalani.tokens.balances")!;
    expect(search.discovery?.embeddingText).toContain("Look up a token");
    expect(search.discovery?.embeddingText?.toLowerCase()).toContain("cross-chain resolver");
    expect(autocomplete.discovery?.embeddingText).toContain("Parse natural-language token");
    expect(autocomplete.discovery?.embeddingText?.toLowerCase()).toContain("auto-fill");
    expect(balances.discovery?.embeddingText?.toLowerCase()).toContain("wallet's token balances");
    expect(balances.discovery?.embeddingText?.toLowerCase()).toContain("portfolio");
  });

  it("order embeddings capture lifecycle and transaction lookup intent", () => {
    const list = KHALANI_TOOLS.find(t => t.toolId === "khalani.orders.list")!;
    const get = KHALANI_TOOLS.find(t => t.toolId === "khalani.orders.get")!;
    expect(list.discovery?.embeddingText?.toLowerCase()).toContain("bridge history");
    expect(list.discovery?.embeddingText).toContain("transaction hash");
    expect(get.discovery?.embeddingText?.toLowerCase()).toContain("full lifecycle details");
    expect(get.discovery?.embeddingText?.toLowerCase()).toContain("troubleshoot");
  });

  // ── Example params ───────────────────────────────────────────────

  it("khalani.bridge has example params", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.bridge")!;
    expect(Object.keys(tool.exampleParams).length).toBeGreaterThan(0);
    expect(tool.exampleParams.fromChain).toBeDefined();
  });

  it("khalani.quote.get has example params with all required fields", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.quote.get")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    for (const key of required) {
      expect(tool.exampleParams[key]).toBeDefined();
    }
  });

  // ── Provider search versus signing-path resolver ───────────────

  it("khalani.tokens.search refuses provider metadata as EVM signing authority", () => {
    const tool = KHALANI_TOOLS.find(t => t.toolId === "khalani.tokens.search");
    expect(tool).toBeDefined();
    if (!tool) return;
    expect(tool.description).toContain("TokenFind");
    expect(tool.description).toContain("Use this when researching provider-listed candidates");
    expect(tool.description).toContain("never to authorize an EVM amount or approval");
    expect(tool.description).toContain("its symbol and decimals are provider metadata");
    expect(tool.description).toContain("reads EVM symbol and decimals from the contract");
    expect(tool.description).not.toContain("Use either before any EVM mutation");
    expect(tool.description).not.toContain("there use `dexscreener__pairs_search`");
  });

  it.each(["khalani.quote.get", "khalani.bridge"])(
    "%s requires contract-origin EVM decimals",
    (toolId) => {
      const tool = KHALANI_TOOLS.find(t => t.toolId === toolId);
      expect(tool).toBeDefined();
      if (!tool) return;
      expect(tool.description).toContain("independently re-reads EVM symbol and decimals from");
      expect(tool.description).toContain("contract");
      if (toolId === "khalani.bridge") {
        expect(tool.description).toContain("provider-list decimals are never signing authority");
      }
    },
  );
});
