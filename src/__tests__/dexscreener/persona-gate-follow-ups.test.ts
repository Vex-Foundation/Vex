/**
 * The remaining persona-gate follow-ups, each pinned against its evidence.
 *
 * These are small, independent corrections that share one property: every one
 * of them was found by an Opus persona planning ONLY from tool descriptions and
 * param text, with no repo context. So the fix is a claim the description makes,
 * and the test is what stops the claim drifting away from the code.
 *
 * Byte figures are the CANONICAL replay in
 * `agents_dm/agentscan-phase4/persona-tests/call-records.json`
 * (`Buffer.byteLength(result.output, "utf8")`, the same measure the engine's
 * overflow guard uses), not the persona scripts' ~2x-inflated ToolResult count.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "@vex-agent/tools/protocols/dexscreener/manifest.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { searchUsdc, tokenPairsWeth } from "./_pair-captures.js";
import { metasTrending } from "./_feed-captures.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

function toolById(toolId: string): ProtocolToolManifest {
  const tool = DEXSCREENER_TOOLS.find((candidate) => candidate.toolId === toolId);
  if (tool === undefined) throw new Error(`no manifest declares ${toolId}`);
  return tool;
}

function paramOf(toolId: string, key: string): string {
  const param = toolById(toolId).params.find((candidate) => candidate.key === key);
  if (param === undefined) throw new Error(`${toolId} declares no ${key}`);
  return param.description;
}

async function run(
  toolId: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  return { ok: result.success, output: result.output };
}

// ── Item 4: byte-cost honesty on the two surfaces that can exceed the cap ──

describe("`limit` states the measured cost of a bare call, where there is one", () => {
  it("search names its canonical bare-call size", () => {
    // call-records.json: {"query":"SOL/USDC"} → 24,139 B, wouldOverflow: true.
    const limit = paramOf("dexscreener.search", "limit");
    expect(limit).toContain("24,139");
    expect(limit).toMatch(/16,384|16 KiB|cap/i);
  });

  it("tokens names its canonical bare-call size", () => {
    // call-records.json: 41 solana addresses → 17,822 B, wouldOverflow: true.
    const limit = paramOf("dexscreener.tokens", "limit");
    expect(limit).toContain("17,822");
  });

  it("the two measured surfaces are the only ones making a byte claim on `limit`", () => {
    // A number is a measurement. Copying one onto a tool it was not measured on
    // would be the same class of error as asserting an unobserved provider cap.
    const claiming = DEXSCREENER_TOOLS.filter((tool) => {
      const limit = tool.params.find((param) => param.key === "limit");
      return limit !== undefined && /\d,\d{3} B/.test(limit.description);
    }).map((tool) => tool.toolId);
    expect(claiming.sort()).toEqual(["dexscreener.search", "dexscreener.tokens"]);
  });

  it("keeps the shared no-default rule on every tool that declares `limit`", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      const limit = tool.params.find((param) => param.key === "limit");
      if (limit === undefined) continue;
      expect(limit.required, tool.toolId).toBeFalsy();
      expect(limit.description, tool.toolId).toMatch(/omit/i);
    }
  });
});

// ── Item 6: a missing-param message lists only what is missing ────────────

describe("missing-parameter messages name only the genuinely absent params", () => {
  it("does not accuse a parameter that was supplied", async () => {
    // The live repro: the chain param was present, tokenAddresses empty, and
    // the message said "Missing required: chain, tokenAddresses".
    const result = await run("dexscreener.tokens", { chain: "solana", tokenAddresses: "" });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("tokenAddresses");
    expect(result.output).not.toMatch(/\bchain\b/);
  });

  it("names both when both are absent", async () => {
    const result = await run("dexscreener.tokens", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("chain");
    expect(result.output).toContain("tokenAddresses");
  });

  it("holds for every multi-param lookup in the namespace", async () => {
    const cases: readonly (readonly [string, Record<string, unknown>, string, string])[] = [
      ["dexscreener.pairs", { chain: "ethereum" }, "pairAddress", "chain"],
      ["dexscreener.pairs", { pairAddress: "0xabc" }, "chain", "pairAddress"],
      ["dexscreener.tokenPairs", { chain: "solana" }, "tokenAddress", "chain"],
      ["dexscreener.orders", { chain: "solana" }, "tokenAddress", "chain"],
    ];
    for (const [toolId, params, absent, supplied] of cases) {
      const result = await run(toolId, params);
      expect(result.ok, toolId).toBe(false);
      expect(result.output, `${toolId} names the absent ${absent}`).toContain(absent);
      expect(
        new RegExp(`\\b${supplied}\\b`).test(result.output),
        `${toolId} must not accuse the supplied ${supplied}: ${result.output}`,
      ).toBe(false);
    }
  });
});

// ── Item 12: attention discloses that its rows carry no timestamp ─────────

describe("attention discloses its missing timestamps, and why", () => {
  it("says the rows carry no time and names the cause", () => {
    const description = toolById("dexscreener.attention").description;
    expect(description).toMatch(/no timestamp/i);
    // The reason is structural: the merge keeps boost units and the boost feed
    // has no time at all, so it cannot be fixed by a parameter.
    expect(description).toMatch(/boost/i);
  });

  it("points at the feed that IS time-ordered instead of inventing one here", () => {
    expect(toolById("dexscreener.attention").description).toContain("dexscreener.profiles.recent");
  });

  it("declares no freshness param it could not honour", () => {
    const keys = toolById("dexscreener.attention").params.map((param) => param.key);
    expect(keys).not.toContain("updatedWithinSeconds");
    expect(keys).not.toContain("claimedWithinSeconds");
    expect(keys).not.toContain("placedWithinSeconds");
  });
});

// ── Item 14: communityTakeovers claims only what it can answer ────────────

describe("communityTakeovers is honest about what it cannot answer", () => {
  it("says it is a recency window, not a takeover history", () => {
    const description = toolById("dexscreener.communityTakeovers").description;
    expect(description).toMatch(/history/i);
    expect(description).toMatch(/cannot|not answerable|no way/i);
  });

  it("invents no history capability to go with the disclosure", () => {
    const keys = toolById("dexscreener.communityTakeovers").params.map((param) => param.key);
    expect(keys).not.toContain("since");
    expect(keys).not.toContain("fromDate");
    expect(keys).not.toContain("tokenAddress");
  });
});

// ── Items 9 + 10: confirmed already true, and pinned so they stay true ────

describe("depth numbers travel with the symbol that reads them", () => {
  beforeEach(() => {
    vi.spyOn(getDexScreenerClient(), "getTokenPairs").mockResolvedValue(tokenPairsWeth());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("baseSymbol rides along whenever liquidityBaseTokens is projected", async () => {
    // A raw token amount is unreadable without the asset it counts —
    // `rules/90` money-path discipline. Both symbols are in the LEAN set, so
    // this holds by construction; the pin is what keeps it holding.
    const result = await run("dexscreener.tokenPairs", {
      chain: "ethereum",
      tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      fields: "liquidityBaseTokens",
    });
    expect(result.ok).toBe(true);
    const rows = (JSON.parse(result.output) as { pairs: Array<Record<string, unknown>> }).pairs;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveProperty("liquidityBaseTokens");
      expect(row).toHaveProperty("baseSymbol");
    }
  });

  it("quoteSymbol rides along with liquidityQuoteTokens, the mirror case", async () => {
    const result = await run("dexscreener.tokenPairs", {
      chain: "ethereum",
      tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      fields: "liquidityQuoteTokens",
    });
    expect(result.ok).toBe(true);
    const rows = (JSON.parse(result.output) as { pairs: Array<Record<string, unknown>> }).pairs;
    for (const row of rows) {
      expect(row).toHaveProperty("liquidityQuoteTokens");
      expect(row).toHaveProperty("quoteSymbol");
    }
  });
});

describe("the quote-token ADDRESS is reachable, and stays out of the lean row", () => {
  beforeEach(() => {
    vi.spyOn(getDexScreenerClient(), "search").mockResolvedValue(searchUsdc());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is selectable via `fields`, so a portfolio can be assembled from search output", async () => {
    const result = await run("dexscreener.search", { query: "USDC", fields: "quoteAddress" });
    expect(result.ok).toBe(true);
    const rows = (JSON.parse(result.output) as { pairs: Array<Record<string, unknown>> }).pairs;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => "quoteAddress" in row)).toBe(true);
    expect(rows.some((row) => typeof row.quoteAddress === "string")).toBe(true);
  });

  it("is NOT in the lean row — the byte budget is why it is opt-in", async () => {
    const result = await run("dexscreener.search", { query: "USDC" });
    expect(result.ok).toBe(true);
    const rows = (JSON.parse(result.output) as { pairs: Array<Record<string, unknown>> }).pairs;
    expect(rows.every((row) => !("quoteAddress" in row))).toBe(true);
  });
});

// ── Item 8: the window echo travels ON the row ────────────────────────────

describe("a *Selected value states the window it was resolved against", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pair rows echo the resolved window, default included", async () => {
    vi.spyOn(getDexScreenerClient(), "search").mockResolvedValue(searchUsdc());
    const asDefault = await run("dexscreener.search", { query: "USDC" });
    const asH1 = await run("dexscreener.search", { query: "USDC", window: "h1" });
    const rowsOf = (output: string): Array<Record<string, unknown>> =>
      (JSON.parse(output) as { pairs: Array<Record<string, unknown>> }).pairs;

    expect(rowsOf(asDefault.output).every((row) => row.windowSelected === "h24")).toBe(true);
    expect(rowsOf(asH1.output).every((row) => row.windowSelected === "h1")).toBe(true);
    // And the value it labels really did move with it.
    expect(rowsOf(asH1.output)[0]?.volumeUsdSelected).not.toBe(
      rowsOf(asDefault.output)[0]?.volumeUsdSelected,
    );
  });

  it("narrative rows echo it too — the case falsified live", async () => {
    vi.spyOn(getDexScreenerClient(), "getMetasTrending").mockResolvedValue(metasTrending());
    const result = await run("dexscreener.trending", { window: "h6" });
    expect(result.ok).toBe(true);
    const rows = (JSON.parse(result.output) as { narratives: Array<Record<string, unknown>> })
      .narratives;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.windowSelected).toBe("h6");
      expect(row).toHaveProperty("marketCapChangePctSelected");
    }
  });
});
