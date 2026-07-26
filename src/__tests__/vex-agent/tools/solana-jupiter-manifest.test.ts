import { describe, it, expect } from "vitest";
import { SOLANA_JUPITER_TOOLS } from "../../../vex-agent/tools/protocols/solana-jupiter/manifest.js";

describe("solana-jupiter manifest", () => {
  // ── Completeness ─────────────────────────────────────────────────

  it("has 34 tools total", () => {
    expect(SOLANA_JUPITER_TOOLS).toHaveLength(34);
  });

  // ── All expected toolIds present ─────────────────────────────────

  const EXPECTED_TOOL_IDS = [
    // Core (3)
    "solana.prices",
    "solana.tokens.search",
    "solana.tokens.trending",
    // Swap (2)
    "solana.swap.quote",
    "solana.swap.execute",
    // Predict (11)
    "solana.predict.events",
    "solana.predict.search",
    "solana.predict.market",
    "solana.predict.event",
    "solana.predict.position",
    "solana.predict.positions",
    "solana.predict.history",
    "solana.predict.buy",
    "solana.predict.sell",
    "solana.predict.claim",
    "solana.predict.closeAll",
    // Predict — pre-trade visibility & order tools (W1-D) (6)
    "solana.predict.orderbook",
    "solana.predict.tradingStatus",
    "solana.predict.orders",
    "solana.predict.order",
    "solana.predict.orderStatus",
    "solana.predict.trades",
    // Predict — discovery & social tools (W1-F) (5)
    "solana.predict.profile",
    "solana.predict.pnlHistory",
    "solana.predict.leaderboards",
    "solana.predict.vaultInfo",
    "solana.predict.suggestedEvents",
    // Lend — Earn (4)
    "solana.lend.rates",
    "solana.lend.positions",
    "solana.lend.deposit",
    "solana.lend.withdraw",
    // Lend — Borrow (3, Batch 5 card B1)
    "solana.lend.borrowVaults",
    "solana.lend.borrowPositions",
    "solana.lend.borrowOperate",
  ];

  it("expected toolId count matches manifest count", () => {
    expect(EXPECTED_TOOL_IDS).toHaveLength(34);
  });

  for (const toolId of EXPECTED_TOOL_IDS) {
    it(`declares ${toolId}`, () => {
      const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === toolId);
      expect(tool).toBeDefined();
    });
  }

  // ── No extra/unexpected tools ────────────────────────────────────

  it("has no tools beyond expected list", () => {
    const expectedSet = new Set(EXPECTED_TOOL_IDS);
    const unexpected = SOLANA_JUPITER_TOOLS.filter(t => !expectedSet.has(t.toolId));
    expect(unexpected).toHaveLength(0);
  });

  // ── Namespace consistency ────────────────────────────────────────

  it("all tools belong to solana namespace", () => {
    for (const tool of SOLANA_JUPITER_TOOLS) {
      expect(tool.namespace).toBe("solana");
    }
  });

  it("all tools are active lifecycle", () => {
    for (const tool of SOLANA_JUPITER_TOOLS) {
      expect(tool.lifecycle).toBe("active");
    }
  });

  it("all toolIds start with solana.", () => {
    for (const tool of SOLANA_JUPITER_TOOLS) {
      expect(tool.toolId).toMatch(/^solana\./);
    }
  });

  // ── Mutating flags ───────────────────────────────────────────────

  const EXPECTED_MUTATING = [
    "solana.swap.execute",
    "solana.predict.buy",
    "solana.predict.sell",
    "solana.predict.claim",
    "solana.predict.closeAll",
    "solana.lend.deposit",
    "solana.lend.withdraw",
    "solana.lend.borrowOperate",
  ];

  it("has correct number of mutating tools", () => {
    const mutating = SOLANA_JUPITER_TOOLS.filter(t => t.mutating);
    expect(mutating).toHaveLength(EXPECTED_MUTATING.length);
  });

  for (const toolId of EXPECTED_MUTATING) {
    it(`${toolId} is mutating`, () => {
      const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === toolId)!;
      expect(tool.mutating).toBe(true);
    });
  }

  it("non-mutating tools are correctly flagged", () => {
    const mutatingSet = new Set(EXPECTED_MUTATING);
    const nonMutating = SOLANA_JUPITER_TOOLS.filter(t => !mutatingSet.has(t.toolId));
    for (const tool of nonMutating) {
      expect(tool.mutating).toBe(false);
    }
  });

  // ── requiresEnv — ALL retained tools require JUPITER_API_KEY ────

  it("all tools require JUPITER_API_KEY", () => {
    for (const tool of SOLANA_JUPITER_TOOLS) {
      expect(tool.requiresEnv).toBe("JUPITER_API_KEY");
    }
  });

  // ── Required params ──────────────────────────────────────────────

  it("solana.swap.execute requires inputToken, outputToken, amount", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.swap.execute")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("inputToken");
    expect(required).toContain("outputToken");
    expect(required).toContain("amount");
  });

  it("solana.predict.buy requires marketId, side, amountUsdc", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.buy")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toContain("marketId");
    expect(required).toContain("side");
    expect(required).toContain("amountUsdc");
  });

  // ── Tokens output redesign (W1-G) ─────────────────────────────────
  // statsInterval selector + client-side threshold filters, on both
  // solana.tokens.search and solana.tokens.trending.

  for (const toolId of ["solana.tokens.search", "solana.tokens.trending"]) {
    it(`${toolId} declares statsInterval + threshold filter params`, () => {
      const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === toolId)!;
      const byKey = new Map(tool.params.map(p => [p.key, p]));

      expect(byKey.get("statsInterval")?.type).toBe("string");
      expect(byKey.get("minOrganicScore")?.type).toBe("number");
      expect(byKey.get("verifiedOnly")?.type).toBe("boolean");
      expect(byKey.get("minLiquidity")?.type).toBe("number");
      for (const key of ["statsInterval", "minOrganicScore", "verifiedOnly", "minLiquidity"]) {
        expect(byKey.get(key)?.required, `${toolId}.${key} should be optional`).toBeFalsy();
      }
    });
  }

  it("solana.tokens.trending's category param lists stocks (tokenized equities)", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.tokens.trending")!;
    const category = tool.params.find(p => p.key === "category")!;
    expect(category.description).toContain("stocks");
  });

  // ── Pagination on unbounded list tools (P1-11) ───────────────────
  // events + positions are unbounded lists and MUST expose limit/offset;
  // history already did. Both params are optional numbers.

  for (const toolId of ["solana.predict.events", "solana.predict.positions", "solana.predict.history"]) {
    it(`${toolId} declares optional number limit + offset params`, () => {
      const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === toolId)!;
      const limit = tool.params.find(p => p.key === "limit");
      const offset = tool.params.find(p => p.key === "offset");
      expect(limit, `${toolId} missing limit param`).toBeDefined();
      expect(offset, `${toolId} missing offset param`).toBeDefined();
      expect(limit!.type).toBe("number");
      expect(offset!.type).toBe("number");
      expect(limit!.required).toBeFalsy();
      expect(offset!.required).toBeFalsy();
    });
  }

  // ── Prediction filters + limits (W1-C, Packet C) ─────────────────
  // Full SDK-validated param passthrough on events/search/event/positions/
  // history, plus the owner-wide limit cap (default 20, max 100 — search
  // stays provider-bounded 1-20).

  it("solana.predict.events declares provider/subcategory/tags/sortBy/sortDirection/includeMarkets, all optional", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.events")!;
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("provider")?.type).toBe("string");
    expect(byKey.get("subcategory")?.type).toBe("string");
    expect(byKey.get("tags")?.type).toBe("string");
    expect(byKey.get("sortBy")?.type).toBe("string");
    expect(byKey.get("sortDirection")?.type).toBe("string");
    expect(byKey.get("includeMarkets")?.type).toBe("boolean");
    for (const key of ["provider", "subcategory", "tags", "sortBy", "sortDirection", "includeMarkets"]) {
      expect(byKey.get(key)?.required, `solana.predict.events.${key} should be optional`).toBeFalsy();
    }
    // filter gained the `upcoming` value (W1-A/W1-C) — the description must
    // say so, not just the underlying validator.
    expect(byKey.get("filter")?.description).toContain("upcoming");
  });

  it("solana.predict.search declares provider/includeMarkets/limit, all optional; limit description discloses local enforcement (F2)", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.search")!;
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("provider")?.type).toBe("string");
    expect(byKey.get("includeMarkets")?.type).toBe("boolean");
    expect(byKey.get("limit")?.type).toBe("number");
    for (const key of ["provider", "includeMarkets", "limit"]) {
      expect(byKey.get(key)?.required, `solana.predict.search.${key} should be optional`).toBeFalsy();
    }
    // The provider ignores its own `limit` param live — Vex enforces the
    // agent's requested window locally, and the manifest must say so.
    expect(byKey.get("limit")?.description.toLowerCase()).toContain("locally");
  });

  it("solana.predict.event declares an optional includeMarkets boolean", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.event")!;
    const includeMarkets = tool.params.find(p => p.key === "includeMarkets")!;
    expect(includeMarkets.type).toBe("boolean");
    expect(includeMarkets.required).toBeFalsy();
  });

  it("solana.predict.positions declares optional marketPubkey/marketId/isYes filters", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.positions")!;
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("marketPubkey")?.type).toBe("string");
    expect(byKey.get("marketId")?.type).toBe("string");
    expect(byKey.get("isYes")?.type).toBe("boolean");
    for (const key of ["marketPubkey", "marketId", "isYes"]) {
      expect(byKey.get(key)?.required, `solana.predict.positions.${key} should be optional`).toBeFalsy();
    }
  });

  it("solana.predict.history declares optional positionPubkey/id filters", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.history")!;
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("positionPubkey")?.type).toBe("string");
    expect(byKey.get("id")?.type).toBe("number");
    expect(byKey.get("positionPubkey")?.required).toBeFalsy();
    expect(byKey.get("id")?.required).toBeFalsy();
  });

  it("events/positions/history limit descriptions state the owner-wide 1-100 cap", () => {
    for (const toolId of ["solana.predict.events", "solana.predict.positions", "solana.predict.history"]) {
      const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === toolId)!;
      const limit = tool.params.find(p => p.key === "limit")!;
      expect(limit.description, `${toolId}.limit description`).toContain("100");
    }
  });

  // ── Pre-trade visibility & order tools (W1-D, Packet D) ──────────

  it("solana.predict.orderbook requires marketId", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.orderbook")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual(["marketId"]);
  });

  it("solana.predict.tradingStatus takes no params", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.tradingStatus")!;
    expect(tool.params).toHaveLength(0);
  });

  it("solana.predict.orders requires address and declares optional limit/offset", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.orders")!;
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("address")?.required).toBe(true);
    expect(byKey.get("limit")?.type).toBe("number");
    expect(byKey.get("offset")?.type).toBe("number");
    expect(byKey.get("limit")?.required).toBeFalsy();
    expect(byKey.get("offset")?.required).toBeFalsy();
  });

  for (const toolId of ["solana.predict.order", "solana.predict.orderStatus"]) {
    it(`${toolId} requires orderPubkey`, () => {
      const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === toolId)!;
      const required = tool.params.filter(p => p.required).map(p => p.key);
      expect(required).toEqual(["orderPubkey"]);
    });
  }

  it("solana.predict.trades requires limit (F2 — no default-N truncation on an unscoped global feed) and declares optional offset", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.trades")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual(["limit"]);
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("limit")?.type).toBe("number");
    expect(byKey.get("offset")?.type).toBe("number");
    expect(byKey.get("offset")?.required).toBeFalsy();
  });

  it("W1-D tools are all read-only", () => {
    for (const toolId of [
      "solana.predict.orderbook", "solana.predict.tradingStatus", "solana.predict.orders",
      "solana.predict.order", "solana.predict.orderStatus", "solana.predict.trades",
    ]) {
      const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === toolId)!;
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
    }
  });

  // ── Discovery & social tools (W1-F, Packet F) ────────────────────

  it("solana.predict.profile requires address", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.profile")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual(["address"]);
  });

  it("solana.predict.pnlHistory requires address and interval, declares optional count capped at 100 (F2 owner-wide limit)", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.pnlHistory")!;
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("address")?.required).toBe(true);
    expect(byKey.get("interval")?.required).toBe(true);
    expect(byKey.get("count")?.type).toBe("number");
    expect(byKey.get("count")?.required).toBeFalsy();
    expect(byKey.get("count")?.description).toContain("100");
  });

  it("solana.predict.leaderboards requires period, metric, and limit", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.leaderboards")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual(expect.arrayContaining(["period", "metric", "limit"]));
    expect(required).toHaveLength(3);
  });

  // P1: winRatePct's scale is not confirmed by any fixture or doc — the
  // manifest description must say so rather than let an agent present it as
  // a settled percent.
  it("solana.predict.leaderboards description flags winRatePct as unit-unconfirmed", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.leaderboards")!;
    expect(tool.description).toContain("winRatePct");
    expect(tool.description).toContain("unit-unconfirmed");
  });

  it("solana.predict.vaultInfo takes no params", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.vaultInfo")!;
    expect(tool.params).toHaveLength(0);
  });

  it("solana.predict.suggestedEvents requires pubkey and declares optional provider/includeMarkets", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.suggestedEvents")!;
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("pubkey")?.required).toBe(true);
    expect(byKey.get("provider")?.type).toBe("string");
    expect(byKey.get("includeMarkets")?.type).toBe("boolean");
    expect(byKey.get("provider")?.required).toBeFalsy();
    expect(byKey.get("includeMarkets")?.required).toBeFalsy();
  });

  it("W1-F tools are all read-only", () => {
    for (const toolId of [
      "solana.predict.profile", "solana.predict.pnlHistory", "solana.predict.leaderboards",
      "solana.predict.vaultInfo", "solana.predict.suggestedEvents",
    ]) {
      const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === toolId)!;
      expect(tool.mutating).toBe(false);
      expect(tool.actionKind).toBe("read");
    }
  });

  // ── Descriptions quality ─────────────────────────────────────────

  it("every tool has non-empty description", () => {
    for (const tool of SOLANA_JUPITER_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(15);
    }
  });

  it("every param has non-empty description", () => {
    for (const tool of SOLANA_JUPITER_TOOLS) {
      for (const param of tool.params) {
        expect(param.description.length).toBeGreaterThan(3);
      }
    }
  });

  it("every tool has non-empty discovery.embeddingText", () => {
    for (const tool of SOLANA_JUPITER_TOOLS) {
      expect(tool.discovery?.embeddingText, `${tool.toolId} missing discovery.embeddingText`).toBeTruthy();
      expect(tool.discovery!.embeddingText!.length).toBeGreaterThan(80);
    }
  });

  // Note: assertions below check intent-level content the agent-style
  // refactor preserves (e.g. "Solana", "swap", "earn yield", "YES", "NO").
  // Implementation-detail strings ("Price API", "Tokens API", "deposit
  // transaction", "settlement history") are intentionally absent in the
  // refactored passages — they were API-doc jargon, not user intent.
  // Router names (Metis/JupiterZ/Dflow/OKX) and the "MEV protection" claim were
  // REMOVED from the execute passage (ergonomics audit D13): no code in this
  // repo selects, requests, or verifies either. Vex posts to Jupiter's `/build`
  // and lands the signed bytes itself, so the router choice is Jupiter's and is
  // never echoed back — the passage was asserting a capability we do not have.
  // The assertions below therefore pin what the embedding must still do (anchor
  // the Solana swap intent on the aggregator) and pin the retired claims as
  // ABSENT, so a future edit cannot quietly reinstate them.

  it("swap embeddings stay Solana-anchored and name the aggregator", () => {
    const quote = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.swap.quote")!;
    const execute = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.swap.execute")!;
    for (const tool of [quote, execute]) {
      expect(tool.discovery!.embeddingText).toContain("Solana");
      expect(tool.discovery!.embeddingText?.toLowerCase()).toContain("swap");
    }
    expect(execute.discovery!.embeddingText).toContain("Jupiter");
    expect(execute.discovery!.embeddingText).toContain("400+ DEXes");
  });

  it("the swap execute surface claims no MEV protection and names no router", () => {
    const execute = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.swap.execute")!;
    const surface = `${execute.description} ${execute.discovery!.canonicalSummary ?? ""} ${execute.discovery!.embeddingText ?? ""}`;
    expect(surface).not.toContain("MEV");
    for (const router of ["Metis", "JupiterZ", "Dflow", "OKX"]) {
      expect(surface, `${router} is an unverified router claim — see audit D13`).not.toContain(router);
    }
  });

  it("core embeddings mention tokens and prices", () => {
    const prices = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.prices")!;
    const search = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.tokens.search")!;
    const trending = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.tokens.trending")!;
    expect(prices.discovery!.embeddingText).toContain("USD prices");
    expect(prices.discovery!.embeddingText).toContain("mint");
    expect(search.discovery!.embeddingText).toContain("SPL token");
    expect(search.discovery!.embeddingText).toContain("mint address");
    expect(trending.discovery!.embeddingText).toContain("top trending");
    expect(trending.discovery!.embeddingText).toContain("SPL tokens");
  });

  it("lend embeddings mention Jupiter Lend Earn semantics", () => {
    const rates = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.lend.rates")!;
    const deposit = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.lend.deposit")!;
    const withdraw = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.lend.withdraw")!;
    expect(rates.discovery!.embeddingText).toContain("Jupiter Lend Earn");
    expect(rates.discovery!.embeddingText).toContain("APY");
    expect(deposit.discovery!.embeddingText).toContain("vault");
    expect(deposit.discovery!.embeddingText).toContain("earn yield");
    expect(withdraw.discovery!.embeddingText).toContain("vault");
    expect(withdraw.discovery!.embeddingText?.toLowerCase()).toContain("withdraw");
  });

  // ── Lend Borrow (Batch 5, card B1) ───────────────────────────────

  it("solana.lend.borrowVaults takes only optional market/vaultIds params", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.lend.borrowVaults")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual([]);
    expect(tool.mutating).toBe(false);
    expect(tool.actionKind).toBe("read");
  });

  it("solana.lend.borrowPositions is read-only with optional address/market/vaultIds", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.lend.borrowPositions")!;
    const required = tool.params.filter(p => p.required).map(p => p.key);
    expect(required).toEqual([]);
    expect(tool.mutating).toBe(false);
    expect(tool.actionKind).toBe("read");
  });

  it("solana.lend.borrowOperate requires vaultId and declares the six mutually-exclusive leg params", () => {
    const tool = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.lend.borrowOperate")!;
    const byKey = new Map(tool.params.map(p => [p.key, p]));
    expect(byKey.get("vaultId")?.required).toBe(true);
    expect(byKey.get("vaultId")?.type).toBe("number");
    for (const key of ["depositAmount", "withdrawAmount", "borrowAmount", "repayAmount"]) {
      expect(byKey.get(key)?.type, key).toBe("string");
      expect(byKey.get(key)?.required, key).toBeFalsy();
    }
    for (const key of ["withdrawAll", "repayAll"]) {
      expect(byKey.get(key)?.type, key).toBe("boolean");
      expect(byKey.get(key)?.required, key).toBeFalsy();
    }
    expect(tool.mutating).toBe(true);
    expect(tool.actionKind).toBe("user_wallet_broadcast");
  });

  it("lend-borrow embeddings mention collateral/debt semantics, distinct from Earn", () => {
    const vaults = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.lend.borrowVaults")!;
    const operate = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.lend.borrowOperate")!;
    expect(vaults.discovery!.embeddingText).toContain("LTV");
    expect(operate.discovery!.embeddingText?.toLowerCase()).toContain("collateral");
    expect(operate.discovery!.embeddingText?.toLowerCase()).toContain("borrow");
  });

  it("prediction embeddings mention YES NO markets and portfolio intent", () => {
    const buy = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.buy")!;
    const positions = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.positions")!;
    const history = SOLANA_JUPITER_TOOLS.find(t => t.toolId === "solana.predict.history")!;
    expect(buy.discovery!.embeddingText).toContain("YES");
    expect(buy.discovery!.embeddingText).toContain("NO");
    expect(buy.discovery!.embeddingText?.toLowerCase()).toContain("bet");
    expect(positions.discovery!.embeddingText?.toLowerCase()).toContain("open prediction");
    expect(history.discovery!.embeddingText).toContain("realized PnL");
    expect(history.discovery!.embeddingText?.toLowerCase()).toContain("past prediction");
  });
});
