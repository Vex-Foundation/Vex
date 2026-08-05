/**
 * THE POINT OF THIS CARD, AS AN EXECUTABLE TEST.
 *
 * The owner's diagnosis was one loop: **no params → the agent compensates with
 * call volume → every call returns everything → everything blobs → the agent
 * spends more calls reading blobs.** Params break it at the source.
 *
 * The worked example was "hunt for fresh memecoins on the robinhood chain", which
 * before this card was not slow but IMPOSSIBLE: `profiles.recent` had no chain
 * filter, so the agent received 30 rows across all chains at 40,089 B — 2.45x the
 * context cap — which blobbed, and it still could not say "robinhood only" or
 * "give me 15".
 *
 * But robinhood was ONE illustration, and a test that proved only that case would
 * miss the card. The owner named the same bottleneck blocking rug-checking a token
 * before buying, picking an execution venue, refreshing a portfolio, watching
 * narrative rotation, checking whether a token is paid-promoted, and testing exit
 * liquidity at size. So this file walks SIX distinct research flows end to end and
 * asserts three things about each:
 *
 * 1. it completes in a small number of calls;
 * 2. every call fits the context cap, so nothing blobs and no call is spent
 *    reading a blob back;
 * 3. it is expressed in the SAME vocabulary keys as every other flow.
 *
 * Point 3 is the one that is easy to lose. If `chainIds` were `chainId` on one
 * tool and `chains` on another, the agent would have to remember which tool spells
 * which — recreating the bottleneck as guesswork instead of call volume. The last
 * describe block asserts the vocabulary mechanically across all 14 tools, so a
 * future contributor who adds `minLiquidity` to one tool fails here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "@vex-agent/tools/protocols/dexscreener/manifest.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import {
  adsLatest,
  boostsLatest,
  boostsTop,
  communityTakeovers,
  metaCat,
  metasTrending,
  profilesLatest,
  profilesRecent,
} from "./_feed-captures.js";
import { searchUsdc, tokenPairsBonk, tokenPairsWeth, tokensEthereum40 } from "./_pair-captures.js";
import { DEXSCREENER_BYTE_BUDGET_BYTES } from "./_byte-budget.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};


interface FlowCall {
  readonly toolId: string;
  readonly params: Record<string, unknown>;
  readonly bytes: number;
  readonly data: Record<string, unknown>;
}

/**
 * Run a flow, recording every call.
 *
 * The recorder is the assertion surface: a flow's cost is the number of entries it
 * returns, and a blobbed call is one whose bytes exceed the cap — which would in
 * reality cost FURTHER calls to read back.
 */
class FlowRecorder {
  readonly calls: FlowCall[] = [];

  async call(toolId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const handler = DEXSCREENER_HANDLERS[toolId];
    if (handler === undefined) throw new Error(`no handler for ${toolId}`);
    const result = await handler(params, READ_CTX);
    expect(result.success, `${toolId} failed: ${result.output}`).toBe(true);
    const data = JSON.parse(result.output) as Record<string, unknown>;
    this.calls.push({
      toolId,
      params,
      bytes: Buffer.byteLength(result.output, "utf8"),
      data,
    });
    return data;
  }

  /** Every key the flow used, across every call. The shared-vocabulary evidence. */
  vocabulary(): string[] {
    return [...new Set(this.calls.flatMap((entry) => Object.keys(entry.params)))].sort();
  }

  report(label: string): void {
    for (const entry of this.calls) {
      // eslint-disable-next-line no-console
      console.log(
        `flow ${label.padEnd(24)} ${entry.toolId.padEnd(30)} ${String(entry.bytes).padStart(6)} B  ${JSON.stringify(entry.params)}`,
      );
    }
  }
}

function rows(data: Record<string, unknown>, key = "rows"): Array<Record<string, unknown>> {
  const value = data[key];
  if (!Array.isArray(value)) throw new Error(`expected ${key} to be an array`);
  return value as Array<Record<string, unknown>>;
}

describe("DexScreener research flows — generality", () => {
  beforeEach(() => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getProfiles").mockResolvedValue(profilesLatest());
    vi.spyOn(client, "getProfilesRecentUpdates").mockResolvedValue(profilesRecent());
    vi.spyOn(client, "getBoosts").mockResolvedValue(boostsLatest());
    vi.spyOn(client, "getTopBoosts").mockResolvedValue(boostsTop());
    vi.spyOn(client, "getCommunityTakeovers").mockResolvedValue(communityTakeovers());
    vi.spyOn(client, "getAds").mockResolvedValue(adsLatest());
    vi.spyOn(client, "getMetasTrending").mockResolvedValue(metasTrending());
    vi.spyOn(client, "getMeta").mockResolvedValue(metaCat());
    vi.spyOn(client, "search").mockResolvedValue(searchUsdc());
    vi.spyOn(client, "getTokenPairs").mockResolvedValue(tokenPairsBonk());
    vi.spyOn(client, "getTokens").mockResolvedValue(tokensEthereum40().pairs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Flow 1 — the owner's worked example ────────────────────────

  it("FLOW: hunt fresh tokens on ONE chain (the owner's robinhood example) — 2 calls, nothing blobbed", async () => {
    const flow = new FlowRecorder();

    // Call 1. Before this card there was no way to express either half of this.
    const fresh = await flow.call("dexscreener.profiles", {
      chainIds: "robinhood",
      limit: 15,
    });
    const found = rows(fresh);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((row) => row.chainId === "robinhood")).toBe(true);
    // The window really did hold other chains — the filter did work, and said so.
    expect((fresh.droppedByFilter as Record<string, number>).chainIds).toBeGreaterThan(0);

    // Call 2. The feed row carries no market data at all, and the envelope says
    // so; the address it does carry is what turns a hunt into a decision.
    const address = found[0]?.tokenAddress;
    expect(typeof address).toBe("string");
    const pools = await flow.call("dexscreener.tokenPairs", {
      chain: "robinhood",
      tokenAddress: String(address),
      maxPairAgeSeconds: 86_400,
      minTurnoverRatio: 0.05,
    });
    expect(pools).toHaveProperty("providerWindow");

    flow.report("fresh-on-chain");
    expect(flow.calls).toHaveLength(2);
    expect(flow.calls.every((entry) => entry.bytes < DEXSCREENER_BYTE_BUDGET_BYTES)).toBe(true);
  });

  // ── Flow 2 — paid-promotion check ──────────────────────────────

  it("FLOW: is this token being paid-promoted? — 3 calls, nothing blobbed", async () => {
    const flow = new FlowRecorder();

    // Two promotional windows, each narrowed to the chain in question, plus the
    // per-token order ledger. Same `chainIds` key on both feeds.
    const boosted = await flow.call("dexscreener.boosts", {
      chainIds: "solana",
      minBoostCountTotal: 30,
      sortBy: "boostCountTotal",
    });
    const ads = await flow.call("dexscreener.ads", {
      chainIds: "solana",
      sortBy: "adImpressionCount",
    });
    const target = rows(boosted)[0]?.tokenAddress ?? rows(ads)[0]?.tokenAddress;
    expect(typeof target).toBe("string");

    const orders = await flow.call("dexscreener.orders", {
      chain: "solana",
      tokenAddress: String(target),
    });
    expect(orders).toHaveProperty("orderCount");

    flow.report("paid-promotion");
    expect(flow.calls).toHaveLength(3);
    expect(flow.calls.every((entry) => entry.bytes < DEXSCREENER_BYTE_BUDGET_BYTES)).toBe(true);
    // The counts are promotion packs, never a currency amount.
    for (const row of rows(boosted)) {
      expect(row.boostCountTotal === null || typeof row.boostCountTotal === "number").toBe(true);
    }
  });

  // ── Flow 3 — narrative rotation ────────────────────────────────

  it("FLOW: which narrative is rotating, and what is inside it? — 2 calls, nothing blobbed", async () => {
    const flow = new FlowRecorder();

    // Sorting by CHANGE rather than size is the whole question: the largest
    // narrative is rarely the moving one.
    const narratives = await flow.call("dexscreener.trending", {
      sortBy: "marketCapChangePct",
      window: "h6",
      minTokenCount: 20,
      limit: 5,
    });
    const list = rows(narratives, "narratives");
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((row) => Number(row.narrativeTokenCount) >= 20)).toBe(true);

    // Drill in, filtered by the same threshold vocabulary the pair tools use.
    const inside = await flow.call("dexscreener.meta", {
      slug: "cat",
      minTurnoverRatio: 0.01,
      sortBy: "turnoverRatio",
      limit: 10,
    });
    expect(inside).toHaveProperty("narrativeSubsetNote");
    expect(inside).toHaveProperty("pairsReturned");

    flow.report("narrative-rotation");
    expect(flow.calls).toHaveLength(2);
    expect(flow.calls.every((entry) => entry.bytes < DEXSCREENER_BYTE_BUDGET_BYTES)).toBe(true);
  });

  // ── Flow 4 — rug-check before buying ───────────────────────────

  it("FLOW: rug-check a token before buying — 3 calls, nothing blobbed", async () => {
    const flow = new FlowRecorder();

    // Depth and price sanity across every pool of the token.
    const pools = await flow.call("dexscreener.tokenPairs", {
      chain: "solana",
      tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      minQuoteDepthTokens: 1,
      requireSocials: true,
      fields: "liquidityQuoteTokens,marketCapEqualsFdv,hasSocials",
    });
    expect(pools).toHaveProperty("priceUsdMedianAcrossPools");
    expect(pools).toHaveProperty("pricePoolOutliers");

    // Has the project gone through a community takeover, and has it paid for
    // visibility? Two feeds, one `chainIds` key.
    const takeovers = await flow.call("dexscreener.communityTakeovers", {
      chainIds: "solana",
      claimedWithinSeconds: 2_592_000,
    });
    const promoted = await flow.call("dexscreener.attention", {
      chainIds: "solana",
      minBoostCountTotal: 10,
      limit: 20,
    });
    expect(takeovers).toHaveProperty("droppedByFilter");
    expect(promoted).toHaveProperty("droppedByFilter");

    flow.report("rug-check");
    expect(flow.calls).toHaveLength(3);
    expect(flow.calls.every((entry) => entry.bytes < DEXSCREENER_BYTE_BUDGET_BYTES)).toBe(true);
  });

  // ── Flow 5 — pick an execution venue / exit liquidity at size ───

  it("FLOW: which pool can I exit at size? — 1 call, nothing blobbed", async () => {
    const flow = new FlowRecorder();

    // `minQuoteDepthTokens` is the one depth number a pool cannot inflate by
    // mispricing itself, and it is the same key on every pair tool.
    const venues = await flow.call("dexscreener.tokenPairs", {
      chain: "solana",
      tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      minQuoteDepthTokens: 100,
      minTurnoverRatio: 0.01,
      sortBy: "liquidityUsd",
      limit: 5,
      fields: "liquidityQuoteTokens,liquidityBaseTokens",
    });
    const pools = rows(venues, "pairs");
    // The price-sanity verdict is what stops the agent trading a 4,892x-mispriced
    // pool that a liquidity sort puts first.
    expect(pools.every((pool) => typeof pool.priceSanity === "string")).toBe(true);

    flow.report("exit-liquidity");
    expect(flow.calls).toHaveLength(1);
    expect(flow.calls.every((entry) => entry.bytes < DEXSCREENER_BYTE_BUDGET_BYTES)).toBe(true);
  });

  // ── Flow 6 — portfolio refresh ─────────────────────────────────

  it("FLOW: refresh a portfolio and re-check the thin holdings — 2 calls, nothing blobbed", async () => {
    const flow = new FlowRecorder();

    const priced = await flow.call("dexscreener.tokens", {
      chain: "ethereum",
      tokenAddresses: tokensEthereum40().requestedAddresses,
      limit: 20,
      sortBy: "liquidityUsd",
    });
    // The provider silently answered 30 of 40; the echo is what makes that visible.
    expect(priced.unresolvedAddresses).toHaveLength(10);

    const thin = await flow.call("dexscreener.tokenPairs", {
      chain: "ethereum",
      tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      sortBy: "liquidityUsd",
      limit: 5,
    });
    expect(thin).toHaveProperty("providerWindow");

    flow.report("portfolio-refresh");
    expect(flow.calls).toHaveLength(2);
    expect(flow.calls.every((entry) => entry.bytes < DEXSCREENER_BYTE_BUDGET_BYTES)).toBe(true);
  });

  // ── The generality claim, asserted rather than asserted-about ───

  it("all six flows share one vocabulary — no flow needs a key another flow spells differently", async () => {
    const flow = new FlowRecorder();
    await flow.call("dexscreener.profiles", { chainIds: "robinhood", limit: 15 });
    await flow.call("dexscreener.boosts", { chainIds: "solana", sortBy: "boostCountTotal" });
    await flow.call("dexscreener.ads", { chainIds: "solana", limit: 10 });
    await flow.call("dexscreener.communityTakeovers", { chainIds: "solana", limit: 10 });
    await flow.call("dexscreener.attention", { chainIds: "solana", limit: 10 });
    await flow.call("dexscreener.trending", { sortBy: "marketCapChangePct", limit: 5 });
    await flow.call("dexscreener.meta", { slug: "cat", chainIds: "solana", limit: 10 });
    await flow.call("dexscreener.search", { query: "USDC", chainIds: "base", limit: 10 });
    await flow.call("dexscreener.tokenPairs", {
      chain: "solana",
      tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      limit: 10,
    });

    // `chainIds` and `limit` were accepted by eight different tools across three
    // families with one spelling each, and every call fit the cap.
    expect(flow.vocabulary()).toContain("chainIds");
    expect(flow.vocabulary()).toContain("limit");
    expect(flow.calls.every((entry) => entry.bytes < DEXSCREENER_BYTE_BUDGET_BYTES)).toBe(true);
    expect(flow.calls).toHaveLength(9);
  });
});

/**
 * The mechanical guard on the vocabulary.
 *
 * The flows above prove the keys work TODAY. These assert the property that keeps
 * them working: one spelling per idea, across every tool in the namespace.
 */
describe("DexScreener shared param vocabulary", () => {
  const listTools = DEXSCREENER_TOOLS.filter((tool) =>
    tool.params.some((param) => param.key === "limit"),
  );

  it("every list-returning tool spells the window vocabulary identically", () => {
    expect(listTools.length).toBeGreaterThanOrEqual(11);
    for (const tool of listTools) {
      const keys = tool.params.map((param) => param.key);
      for (const shared of ["limit", "offset", "fields", "sortBy", "sortDir"]) {
        expect(keys, `${tool.toolId} is missing "${shared}"`).toContain(shared);
      }
    }
  });

  it("no tool declares a near-miss spelling of a shared key", () => {
    // Each entry is a name that WOULD have worked and must never appear, paired
    // with the one spelling the namespace uses. A contributor who adds the left
    // side to one tool re-creates the guesswork this card removed.
    const banned: Record<string, string> = {
      chainId: "chain",
      chains: "chainIds",
      minLiquidity: "minLiquidityUsd",
      liquidityMin: "minLiquidityUsd",
      maxResults: "limit",
      count: "limit",
      top: "limit",
      page: "offset",
      sort: "sortBy",
      order: "sortDir",
      timeframe: "window",
      minBoostCount: "minBoostCountTotal",
    };
    for (const tool of DEXSCREENER_TOOLS) {
      for (const param of tool.params) {
        // `chain` (singular) survives ONLY where it is a required identity
        // argument naming the single chain being queried — never as a filter.
        // W6a: the old `chainId` spelling of that argument is banned outright.
        const isIdentityArgument = param.key === "chain" && param.required === true;
        if (isIdentityArgument) continue;
        const replacement = banned[param.key];
        expect(
          replacement,
          `${tool.toolId} declares "${param.key}"; this namespace spells that "${replacement ?? ""}"`,
        ).toBeUndefined();
      }
    }
  });

  // The bar is deliberately low and it is a FLOOR, not a target. Two kinds of
  // param legitimately need few words: a required identity argument ("Token
  // contract address.") and the `max*` half of a documented `min*`/`max*` pair,
  // whose caveats live on the `min` side rather than being duplicated. Padding
  // either one to clear a threshold would be writing for the test instead of for
  // the agent. What this catches is a param shipped with no usable text at all —
  // which is what every one of the nine tools in this card had, by having no
  // params.
  it("every param carries usable text, and every filter says what it does", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      for (const param of tool.params) {
        const description = param.description ?? "";
        expect(description.length, `${tool.toolId}.${param.key} has no description`).toBeGreaterThan(0);
        if (param.required === true) continue;
        expect(
          description.length,
          `${tool.toolId}.${param.key} is a filter with no usable description`,
        ).toBeGreaterThan(35);
      }
    }
  });

  // The honest constraint every client-side filter must carry SOMEWHERE the agent
  // reads: DexScreener applies none of them, so an empty result is our filter's
  // doing and not the market's. Asserted on the chain filter of each family
  // because that is the one an empty result is most often blamed on.
  it("each family's chain filter states that an empty result is not an absent market", () => {
    const chainFilters = DEXSCREENER_TOOLS.flatMap((tool) =>
      tool.params
        .filter((param) => param.key === "chainIds")
        .map((param) => [tool.toolId, param.description ?? ""] as const),
    );
    expect(chainFilters.length).toBeGreaterThanOrEqual(8);
    for (const [toolId, description] of chainFilters) {
      expect(description, `${toolId} chainIds hides that Vex applies the filter`).toMatch(
        /droppedByFilter|does not mean|not that none exist/i,
      );
    }
  });

  // The card's headline number: nine tools went from 0-1 params to a real filter
  // surface. Asserted so a future edit cannot quietly strip it back.
  it("the nine hunt and narrative tools all have a real filter surface now", () => {
    const wasParamless = [
      "dexscreener.profiles",
      "dexscreener.profiles.recent",
      "dexscreener.boosts",
      "dexscreener.boosts.top",
      "dexscreener.communityTakeovers",
      "dexscreener.ads",
      "dexscreener.attention",
      "dexscreener.trending",
      "dexscreener.meta",
    ];
    for (const toolId of wasParamless) {
      const tool = DEXSCREENER_TOOLS.find((candidate) => candidate.toolId === toolId);
      expect(tool, `${toolId} is missing from the manifest`).toBeDefined();
      expect(tool?.params.length ?? 0, `${toolId} has no params`).toBeGreaterThanOrEqual(7);
    }
  });
});
