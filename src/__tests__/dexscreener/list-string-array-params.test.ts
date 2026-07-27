/**
 * Comma-string ⇄ string-array EQUIVALENCE, pinned through the production path.
 *
 * THE MEASURED DEFECT
 *
 * `agents_dm/agentscan-phase4/persona-tests/call-records.json`, first record:
 * `dexscreener.profiles {chainIds: ["solana"], limit: 15}` → **78 bytes,
 * ok:false**. The same call spelled `chainIds: "solana"` → 5,215 bytes of
 * answer. The param text said "comma-separated", the agent sent the JSON array
 * that a JSON tool call makes natural, and the call was spent finding out.
 *
 * WHAT THIS SUITE HAS TO PROVE, AND WHY EACH PART
 *
 * 1. Both spellings produce the IDENTICAL result — not merely "both are
 *    accepted". A widened reader that lower-cases one path and not the other
 *    trades a loud rejection for a silent wrong answer, which is worse.
 * 2. The equivalence holds THROUGH the handler for the two identity params
 *    (`tokenAddresses`, `pairAddress`), because those do not go through the list
 *    reader at all — they are sent upstream and reconciled, and address CASING
 *    must survive both spellings (Solana base58 is case-sensitive).
 * 3. Params that mean exactly ONE value still reject an array.
 * 4. `fields` stays comma-string-only BY INTENT: it is a projection selector,
 *    not a data list, and its param text says so.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "@vex-agent/tools/protocols/dexscreener/manifest.js";
import { parseFeedListQuery } from "@vex-agent/tools/protocols/dexscreener/feed-list/index.js";
import { parsePairListQuery } from "@vex-agent/tools/protocols/dexscreener/pair-list/index.js";
import { validateProtocolParams } from "@vex-agent/tools/protocols/runtime/params.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

import { pairsWethUsdcPool, searchUsdc, tokensEthereum40 } from "./_pair-captures.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

/** Every DexScreener param that opted in, with a value in both spellings. */
const OPT_IN_LIST_PARAMS: readonly (readonly [string, string, string[]])[] = [
  ["chainIds", "ethereum,base", ["ethereum", "base"]],
  ["dexIds", "uniswap,raydium", ["uniswap", "raydium"]],
  ["excludeDexIds", "pancakeswap", ["pancakeswap"]],
  ["labels", "v3,CLMM", ["v3", "CLMM"]],
  ["quoteSymbols", "USDC,WETH", ["USDC", "WETH"]],
];

function parsePair(params: Record<string, unknown>) {
  return parsePairListQuery(params, { sortBy: "relevance", allowChainFilter: true });
}

describe("DexScreener list params accept a string OR a string array", () => {
  // ── The shared list vocabulary ──────────────────────────────────

  for (const [key, asString, asArray] of OPT_IN_LIST_PARAMS) {
    it(`"${key}" reads the array spelling identically to the comma string`, () => {
      const fromString = parsePair({ [key]: asString });
      const fromArray = parsePair({ [key]: asArray });
      expect(fromString.ok && fromArray.ok).toBe(true);
      if (!fromString.ok || !fromArray.ok) return;
      expect(fromArray.query.filters).toEqual(fromString.query.filters);
      // The ECHO must agree too — an agent reads filtersApplied to learn what
      // was actually applied, and two spellings echoing differently would make
      // the echo a function of the request shape rather than of the filter.
      expect(fromArray.query.filtersApplied).toEqual(fromString.query.filtersApplied);
    });
  }

  it("the feed family reads chainIds both ways, identically", () => {
    const defaults = {
      eventAgeParam: "updatedWithinSeconds",
      supportsCtoFilter: true,
      supportsBoostFilter: false,
      sortKeys: ["relevance", "eventAgeSeconds"],
      sortBy: "relevance",
    } as const;
    const fromString = parseFeedListQuery({ chainIds: "solana,base" }, defaults);
    const fromArray = parseFeedListQuery({ chainIds: ["solana", "base"] }, defaults);
    expect(fromString.ok && fromArray.ok).toBe(true);
    if (!fromString.ok || !fromArray.ok) return;
    expect(fromArray.query.filters).toEqual(fromString.query.filters);
    expect(fromArray.query.filtersApplied).toEqual(fromString.query.filtersApplied);
  });

  it("normalisation is applied to the array spelling too, not only the string", () => {
    const parsed = parsePair({ chainIds: [" ETHEREUM ", "Base"] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.query.filters.chainIds).toEqual(["ethereum", "base"]);
  });

  it("rejects a non-string member BY POSITION rather than dropping it", () => {
    const parsed = parsePair({ chainIds: ["ethereum", 5] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("chainIds");
      expect(parsed.reason).toContain("index 1");
    }
  });

  it("rejects an empty array rather than reading it as 'no filter'", () => {
    const parsed = parsePair({ chainIds: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("chainIds");
  });

  // ── `fields` is comma-string-only, on purpose ───────────────────

  it("`fields` REJECTS an array — it is a projection selector, not a data list", () => {
    const parsed = parsePair({ fields: ["fdvUsd", "marketCapUsd"] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("fields");
  });

  it("every manifest `fields` param says which spelling it takes", () => {
    for (const tool of DEXSCREENER_TOOLS) {
      const fields = tool.params.find((param) => param.key === "fields");
      if (fields === undefined) continue;
      expect(fields.acceptsStringArray, `${tool.toolId}.fields`).toBeUndefined();
      expect(fields.description, `${tool.toolId}.fields`).toContain("Comma-separated");
    }
  });

  // ── The declaration and the reader must agree ───────────────────

  it("every param declared acceptsStringArray really accepts an array at the boundary", () => {
    const declared = DEXSCREENER_TOOLS.flatMap((tool) =>
      tool.params.filter((param) => param.acceptsStringArray === true).map((param) => [tool, param] as const),
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const [tool, param] of declared) {
      expect(param.type, `${tool.toolId}.${param.key}`).toBe("string");
      const required = Object.fromEntries(
        tool.params.filter((p) => p.required).map((p) => [p.key, "x"]),
      );
      const outcome = validateProtocolParams(tool, { ...required, [param.key]: ["a"] });
      expect(outcome.ok, `${tool.toolId}.${param.key}: ${outcome.ok ? "" : outcome.reason}`).toBe(true);
    }
  });

  it("params that mean ONE value still reject an array", () => {
    const search = DEXSCREENER_TOOLS.find((tool) => tool.toolId === "dexscreener.search");
    const meta = DEXSCREENER_TOOLS.find((tool) => tool.toolId === "dexscreener.meta");
    const tokenPairs = DEXSCREENER_TOOLS.find((tool) => tool.toolId === "dexscreener.tokenPairs");
    expect(search && meta && tokenPairs).toBeTruthy();
    if (!search || !meta || !tokenPairs) return;

    for (const [manifest, params] of [
      [search, { query: ["PEPE"] }],
      [meta, { slug: ["cat"] }],
      [tokenPairs, { chainId: ["solana"], tokenAddress: "X" }],
      [tokenPairs, { chainId: "solana", tokenAddress: ["X"] }],
    ] as const) {
      const outcome = validateProtocolParams(manifest, params);
      expect(outcome.ok, `${manifest.toolId} ${JSON.stringify(params)}`).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain("array");
    }
  });
});

describe("DexScreener identity params accept a string OR a string array", () => {
  beforeEach(() => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "search").mockResolvedValue(searchUsdc());
    vi.spyOn(client, "getPairs").mockResolvedValue(pairsWethUsdcPool());
    vi.spyOn(client, "getTokens").mockResolvedValue(tokensEthereum40().pairs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function callJson(
    toolId: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const handler = DEXSCREENER_HANDLERS[toolId];
    if (handler === undefined) throw new Error(`no handler for ${toolId}`);
    const result = await handler(params, READ_CTX);
    expect(result.success, result.output).toBe(true);
    return JSON.parse(result.output) as Record<string, unknown>;
  }

  it("tokens: both spellings reach the provider with ONE canonical address list", async () => {
    const client = getDexScreenerClient();
    const getTokens = vi.spyOn(client, "getTokens").mockResolvedValue(tokensEthereum40().pairs);
    const { requestedAddresses } = tokensEthereum40();
    const asArray = requestedAddresses.split(",");

    const fromString = await callJson("dexscreener.tokens", {
      chainId: "ethereum",
      tokenAddresses: requestedAddresses,
    });
    const fromArray = await callJson("dexscreener.tokens", {
      chainId: "ethereum",
      tokenAddresses: asArray,
    });

    // Same bytes upstream — the normalizer feeds the client, not just the echo.
    expect(getTokens.mock.calls[0]?.[1]).toBe(getTokens.mock.calls[1]?.[1]);
    // Same reconciliation, with the caller's address CASING preserved.
    for (const key of ["requestedAddresses", "resolvedAddresses", "unresolvedAddresses"]) {
      expect(fromArray[key], key).toEqual(fromString[key]);
    }
    expect(fromArray.requestedAddresses).toEqual(asArray);
    expect(fromArray.addressCapApplied).toBe(fromString.addressCapApplied);
  });

  it("tokens: a mixed-case address is never folded on either spelling", async () => {
    const mixed = "So11111111111111111111111111111111111111112";
    const fromArray = await callJson("dexscreener.tokens", {
      chainId: "solana",
      tokenAddresses: [mixed],
    });
    expect(fromArray.requestedAddresses).toEqual([mixed]);
  });

  it("pairs: both spellings produce the same requested-address echo and upstream call", async () => {
    const client = getDexScreenerClient();
    const getPairs = vi.spyOn(client, "getPairs").mockResolvedValue(pairsWethUsdcPool());
    const first = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
    const second = "0x11b815efB8f581194ae79006d24E0d814B7697F6";

    const fromString = await callJson("dexscreener.pairs", {
      chainId: "ethereum",
      pairAddress: `${first},${second}`,
    });
    const fromArray = await callJson("dexscreener.pairs", {
      chainId: "ethereum",
      pairAddress: [first, second],
    });

    expect(getPairs.mock.calls[0]?.[1]).toBe(getPairs.mock.calls[1]?.[1]);
    expect(fromArray.requestedPairAddresses).toEqual([first, second]);
    expect(fromArray.requestedPairAddresses).toEqual(fromString.requestedPairAddresses);
  });

  it("an empty identity array is rejected by name, not treated as a missing param", async () => {
    const handler = DEXSCREENER_HANDLERS["dexscreener.tokens"];
    if (handler === undefined) throw new Error("no handler");
    const result = await handler({ chainId: "ethereum", tokenAddresses: [] }, READ_CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("tokenAddresses");
  });
});
