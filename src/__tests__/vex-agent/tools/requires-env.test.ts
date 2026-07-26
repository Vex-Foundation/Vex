import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { getOpenAITools, getAllTools, defaultVisibilityContext } = await import(
  "../../../vex-agent/tools/registry.js"
);
const { discoverProtocolCapabilities } = await import(
  "../../../vex-agent/tools/protocols/runtime.js"
);
const { executeProtocolTool } = await import(
  "../../../vex-agent/tools/protocols/runtime.js"
);

describe("requiresEnv filtering", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.RETTIWT_API_KEY;
    delete process.env.JUPITER_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Internal tools (registry) ──────────────────────────────────

  describe("internal tools (registry)", () => {
    it("hides web_research when TAVILY_API_KEY not set", async () => {
      const tools = getOpenAITools(defaultVisibilityContext());
      const hasWebResearch = tools.some(t => t.function.name === "web_research");
      expect(hasWebResearch).toBe(false);
    });

    it("shows web_research when TAVILY_API_KEY is set", async () => {
      process.env.TAVILY_API_KEY = "tvly-test-key-12345678";
      const tools = getOpenAITools(defaultVisibilityContext());
      const hasWebResearch = tools.some(t => t.function.name === "web_research");
      expect(hasWebResearch).toBe(true);
    });

    it("hides twitter_account when RETTIWT_API_KEY is not set", async () => {
      const tools = getOpenAITools(defaultVisibilityContext());
      const hasTwitterAccount = tools.some(t => t.function.name === "twitter_account");
      expect(hasTwitterAccount).toBe(false);
    });

    it("shows twitter_account when RETTIWT_API_KEY is set", async () => {
      process.env.RETTIWT_API_KEY = "rettiwt-test-key";
      const tools = getOpenAITools(defaultVisibilityContext());
      const hasTwitterAccount = tools.some(t => t.function.name === "twitter_account");
      expect(hasTwitterAccount).toBe(true);
    });

    it("non-ENV tools always present regardless of ENV state", async () => {
      const tools = getOpenAITools(defaultVisibilityContext());
      const hasDiscover = tools.some(t => t.function.name === "discover_tools");
      const hasLongMemorySearch = tools.some(t => t.function.name === "long_memory_search");
      expect(hasDiscover).toBe(true);
      expect(hasLongMemorySearch).toBe(true);
    });

    it("all long_memory_* tools are visible without EMBEDDING_BASE_URL (decision #10: no requiresEnv)", async () => {
      delete process.env.EMBEDDING_BASE_URL;
      const tools = getOpenAITools(defaultVisibilityContext());
      const names = tools.map(t => t.function.name);
      expect(names).toContain("long_memory_suggest");
      expect(names).toContain("long_memory_search");
      expect(names).toContain("long_memory_get");
      expect(names).toContain("long_memory_history");
    });

    it("long_memory_* tools have NO requiresEnv field (visible always, fail loud at runtime)", async () => {
      const all = getAllTools();
      const longMemoryTools = all.filter(t => t.name.startsWith("long_memory_"));
      // suggest (staged write-door) + 3 read tools (search / get / history).
      expect(longMemoryTools.length).toBe(4);
      for (const tool of longMemoryTools) {
        expect(tool.requiresEnv).toBeUndefined();
      }
    });

    it("getAllTools still returns all tools including ENV-gated ones", async () => {
      const all = getAllTools();
      const webResearch = all.find(t => t.name === "web_research");
      expect(webResearch).toBeDefined();
      expect(webResearch!.requiresEnv).toBe("TAVILY_API_KEY");
      const twitterAccount = all.find(t => t.name === "twitter_account");
      expect(twitterAccount).toBeDefined();
      expect(twitterAccount!.requiresEnv).toBe("RETTIWT_API_KEY");
    });
  });

  // ── Protocol tools (discovery) ─────────────────────────────────

  describe("protocol discovery", () => {
    it("hides ALL solana tools when JUPITER_API_KEY not set", async () => {
      const result = await discoverProtocolCapabilities({
        namespace: "solana",
      });
      expect(result.count).toBe(0);
    });

    it("shows all 34 solana tools when JUPITER_API_KEY is set", async () => {
      process.env.JUPITER_API_KEY = "test-jupiter-key";
      const result = await discoverProtocolCapabilities({
        namespace: "solana",
        limit: 100,
      });
      expect(result.count).toBe(34);
    });

    it("khalani tools unaffected by JUPITER_API_KEY", async () => {
      const result = await discoverProtocolCapabilities({ namespace: "khalani" });
      expect(result.count).toBeGreaterThan(0);
    });

    it("total tool count is higher with JUPITER_API_KEY", async () => {
      const without = await discoverProtocolCapabilities({ limit: 300 });
      process.env.JUPITER_API_KEY = "test-key";
      const withKey = await discoverProtocolCapabilities({ limit: 300 });
      expect(withKey.totalCount).toBe(without.totalCount + 34);
    });
  });

  // ── Protocol execute guard ─────────────────────────────────────

  describe("protocol execute guard", () => {
    it("blocks solana.swap.quote without JUPITER_API_KEY", async () => {
      const result = await executeProtocolTool(
        { toolId: "solana.swap.quote", params: { inputToken: "SOL", outputToken: "USDC", amount: 1 } },
        { sessionPermission: "restricted", approved: false },
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("JUPITER_API_KEY");
    });

    it("blocks solana.tokens.search without JUPITER_API_KEY", async () => {
      const result = await executeProtocolTool(
        { toolId: "solana.tokens.search", params: { query: "SOL" } },
        { sessionPermission: "restricted", approved: false },
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("JUPITER_API_KEY");
    });

    it("blocks solana.predict.events without JUPITER_API_KEY", async () => {
      const result = await executeProtocolTool(
        { toolId: "solana.predict.events", params: {} },
        { sessionPermission: "restricted", approved: false },
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("JUPITER_API_KEY");
    });

    it("blocks solana.lend.rates without JUPITER_API_KEY", async () => {
      const result = await executeProtocolTool(
        { toolId: "solana.lend.rates", params: {} },
        { sessionPermission: "restricted", approved: false },
      );
      expect(result.success).toBe(false);
      expect(result.output).toContain("JUPITER_API_KEY");
    });
  });
});
