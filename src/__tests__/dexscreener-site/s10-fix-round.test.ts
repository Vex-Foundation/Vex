/**
 * Regressions for the S10 fix round: the defects the ten-persona trading wave
 * measured against the SHIPPED surface.
 *
 * The family resemblance across almost every entry below is worth stating,
 * because it is what the round was about: NONE of these defects looked like
 * failures. They produced fluent, well-formed, confident answers that happened
 * to be false - a summary counting a page the caller never received, a summary
 * naming a token the series did not describe, a market cap 790 million times
 * its own fully diluted value, a concentration figure computed with the pool
 * itself counted as a whale. A shape assertion would have passed on every one,
 * so every case here drives the real projection and asserts the number or the
 * sentence a reader would have acted on.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import {
  registerDexScreenerTransport,
  type DexScreenerTransport,
} from "@tools/dexscreener/transport.js";
import { DexScreenerSiteErrorCodes } from "@tools/dexscreener/site-errors.js";
import { loadFixture, loadJsonFixture } from "./_fixtures.js";
import { makeProtocolContext } from "../vex-agent/tools/_test-context.js";
import { reconcileBatchRows } from "@tools/dexscreener/endpoints/pairs-batch.js";
import {
  addressShapeForArchitecture,
  pairIdShapeForArchitecture,
} from "@tools/dexscreener/endpoints/chains-catalog.js";
import {
  detectPriceDivergence,
  PRICE_DIVERGENCE_RATIO,
} from "@tools/dexscreener/screen-core/project.js";

describe("S10-33: address shape against the chain's architecture", () => {
  it("names an EVM address written under an SVM slug", () => {
    expect(
      addressShapeForArchitecture(
        "svm",
        "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f"
      )
    ).toBe("mismatch");
  });

  it("names a base58 address written under an EVM slug", () => {
    expect(
      addressShapeForArchitecture(
        "evm",
        "So11111111111111111111111111111111111111112"
      )
    ).toBe("mismatch");
  });

  it("accepts each family's own grammar", () => {
    expect(
      addressShapeForArchitecture(
        "evm",
        "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f"
      )
    ).toBe("match");
    expect(
      addressShapeForArchitecture(
        "svm",
        "So11111111111111111111111111111111111111112"
      )
    ).toBe("match");
  });

  it("decides NOTHING where it cannot: an unmodelled architecture", () => {
    // The honest half of this check. A wrong answer here would refuse a real
    // identity, which is worse than the omission it replaces.
    expect(addressShapeForArchitecture(null, "0xabc")).toBe("unknown");
    expect(addressShapeForArchitecture("sui", "0xabc")).toBe("unknown");
  });
});

/**
 * A Uniswap v4 pool has no contract address: the singleton PoolManager holds
 * every pool and names each one by a 32-byte `PoolId`, which DexScreener serves
 * as `0x` + 64 hex. The TOKEN grammar calls that a mismatch, so before this
 * split every v4 pair was refused by `pairs_batch_get` without ever being
 * asked about. The ids below are copied from committed live captures.
 */
describe("EVM pair identities: the v4 PoolId grammar", () => {
  // `token-pairs-v1-ethereum-weth.json`, a row with labels ["v4"].
  const V4_POOL_ID =
    "0xe500210c7ea6bfd9f69dce044b09ef384ec2b34832f132baec3b418208e3a657";
  const EVM_ADDRESS = "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f";

  it("accepts a 64-hex PAIR id on an EVM chain", () => {
    expect(pairIdShapeForArchitecture("evm", V4_POOL_ID)).toBe("match");
  });

  it("still REFUSES a 64-hex value in the TOKEN lane", () => {
    // The check that catches a caller pasting a pool id where a token belongs.
    expect(addressShapeForArchitecture("evm", V4_POOL_ID)).toBe("mismatch");
  });

  it("leaves every other verdict exactly where it was", () => {
    expect(pairIdShapeForArchitecture("evm", EVM_ADDRESS)).toBe("match");
    expect(pairIdShapeForArchitecture("svm", V4_POOL_ID)).toBe("mismatch");
    expect(pairIdShapeForArchitecture("evm", "So11111111111111111111111111111111111111112"))
      .toBe("mismatch");
    expect(pairIdShapeForArchitecture(null, V4_POOL_ID)).toBe("unknown");
    expect(pairIdShapeForArchitecture("sui", V4_POOL_ID)).toBe("unknown");
  });
});

describe("S10-50: a market cap above its own FDV is impossible", () => {
  it("withholds both valuations and says why", async () => {
    const { projectPairRow } = await import(
      "@tools/dexscreener/screen-core/project.js"
    );
    // The measured rank-1 row of the pairs.top marketCap board: a market cap
    // 790 million times the fully diluted value, on the same row.
    const row = projectPairRow(
      {
        chainId: "solana",
        dexId: "raydium",
        pairAddress: "pool",
        baseToken: { address: "tok", name: "LIKE", symbol: "LIKE" },
        quoteToken: { address: "q", symbol: "SOL" },
        marketCap: 263.09e12,
        fdv: 332_916,
      },
      { window: "h24", nowMs: Date.now() }
    );
    expect(row.marketCapUsd).toBeNull();
    expect(row.fdvUsd).toBeNull();
    expect(row.valuationWithheldReason).toContain("cannot exceed FDV");
  });

  it("leaves an ordinary valuation alone", async () => {
    const { projectPairRow } = await import(
      "@tools/dexscreener/screen-core/project.js"
    );
    const row = projectPairRow(
      {
        chainId: "solana",
        dexId: "raydium",
        pairAddress: "pool",
        baseToken: { address: "tok", name: "OK", symbol: "OK" },
        quoteToken: { address: "q", symbol: "SOL" },
        marketCap: 500_000,
        fdv: 1_000_000,
      },
      { window: "h24", nowMs: Date.now() }
    );
    expect(row.marketCapUsd).toBe(500_000);
    expect(row.fdvUsd).toBe(1_000_000);
    expect(row.valuationWithheldReason).toBeUndefined();
  });
});

describe("S10-31: one token, two prices, in one response", () => {
  const row = (pairAddress: string, priceUsd: string) => ({
    chainId: "solana",
    baseTokenAddress: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    pairAddress,
    priceUsd,
  });

  it("flags the mispriced pool and leaves the honest ones alone", () => {
    // The live measurement this threshold was pinned against: JUP's 30 pools
    // sat at a median of 0.2126 with one row at 1109.33, which is 5,218x.
    const flagged = detectPriceDivergence([
      row("a", "0.2126"),
      row("b", "0.2111"),
      row("c", "0.2130"),
      row("junk", "1109.33"),
    ]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.pairAddress).toBe("junk");
    expect(flagged[0]?.ratioToMedian).toBeGreaterThan(PRICE_DIVERGENCE_RATIO);
  });

  it("does not fire on the spread a healthy asset really has", () => {
    // The other half of the live measurement: WETH's 30 pools spanned
    // 2456.94 to 2469.15, which is well under one percent.
    const flagged = detectPriceDivergence([
      row("a", "2456.94"),
      row("b", "2466.69"),
      row("c", "2469.15"),
      row("d", "2460.00"),
    ]);
    expect(flagged).toStrictEqual([]);
  });

  it("says nothing when two rows merely disagree, because there is no majority", () => {
    const flagged = detectPriceDivergence([row("a", "1"), row("b", "5000")]);
    expect(flagged).toStrictEqual([]);
  });
});

describe("S10-7/S10-8: the batch reconciliation", () => {
  const identity = (chainId: string, id: string, kind: "pair" | "token") => ({
    chainId,
    id,
    kind,
    raw: `${chainId}:${id}`,
  });
  const pairRow = (chainId: string, pairAddress: string, base: string) => ({
    chainId,
    pairAddress,
    baseToken: { address: base },
  });

  it("never emits a row for an identity nobody asked for", () => {
    const out = reconcileBatchRows(
      [identity("robinhood", "0x0000000000000000000000000000000000000000", "pair")],
      [pairRow("robinhood", "0x4fc19534", "0xbase")]
    );
    expect(out.rows).toStrictEqual([]);
    expect(out.unrequested).toStrictEqual(["robinhood:0x4fc19534"]);
  });

  it("keeps resolved identities and shown rows reconcilable under a collapse", () => {
    const out = reconcileBatchRows(
      [
        identity("ethereum", "0xtokena", "token"),
        identity("ethereum", "0xtokenb", "token"),
      ],
      [
        pairRow("ethereum", "0xpool", "0xtokena"),
        pairRow("ethereum", "0xpool", "0xtokenb"),
      ]
    );
    // The equation the summary is built on: resolved identities minus the
    // distinct rows that answered them is the number that collapsed. Reading
    // it wrong produced "8 of 9 ... 9 of which are shown".
    expect(out.resolvedKeys.size).toBe(2);
    expect(out.rows).toHaveLength(1);
    expect(out.resolvedKeys.size - out.rows.length).toBe(1);
  });
});

describe("S10-22: a curve that has no pool has no liquidity to be missing", () => {
  it("files a graduated but unmigrated row as not-applicable, not missing", async () => {
    const { projectPairRow } = await import(
      "@tools/dexscreener/screen-core/project.js"
    );
    // Progress 100 and no migrationDEX: the dead curve row. The old
    // `progress < 100` test called this a missing input on 6 of 15 rows.
    const row = projectPairRow(
      {
        chainId: "solana",
        dexId: "pumpfun",
        pairAddress: "curve",
        baseToken: { address: "tok", name: "T", symbol: "T" },
        quoteToken: { address: "q", symbol: "SOL" },
        typeAMM: { launchpad: { progress: 100 } },
      },
      { window: "h24", nowMs: Date.now() }
    );
    expect(row.notApplicableInputs).toContain("liquidityUsd");
    expect(row.missingInputs).not.toContain("liquidityUsd");
  });
});

describe("S10-24: acceleration is 12 by construction on a young pair", () => {
  it("withholds the ratio below one hour of pair age", async () => {
    const { projectPairRow } = await import(
      "@tools/dexscreener/screen-core/project.js"
    );
    const nowMs = Date.now();
    const young = projectPairRow(
      {
        chainId: "solana",
        dexId: "raydium",
        pairAddress: "p",
        baseToken: { address: "t", name: "T", symbol: "T" },
        quoteToken: { address: "q", symbol: "SOL" },
        pairCreatedAt: new Date(nowMs - 120_000).toISOString(),
        volume: { m5: 1000, h1: 1000 },
      },
      { window: "h24", nowMs }
    );
    // Without the guard this is exactly 12 on every such row, and 26 of 47
    // rows of a newest-first board were pinned there.
    expect(young.derived.volumeAccelerationRatio).toBeNull();
  });

  it("still computes it once the trailing hour is real", async () => {
    const { projectPairRow } = await import(
      "@tools/dexscreener/screen-core/project.js"
    );
    const nowMs = Date.now();
    const mature = projectPairRow(
      {
        chainId: "solana",
        dexId: "raydium",
        pairAddress: "p",
        baseToken: { address: "t", name: "T", symbol: "T" },
        quoteToken: { address: "q", symbol: "SOL" },
        pairCreatedAt: new Date(nowMs - 86_400_000).toISOString(),
        volume: { m5: 100, h1: 1200 },
      },
      { window: "h24", nowMs }
    );
    expect(mature.derived.volumeAccelerationRatio).toBeCloseTo(1, 5);
  });
});

/* ------------------------------------------------------------------ */
/* S10-36 and S10-12: freshness and failure kind are measured, not assumed */
/* ------------------------------------------------------------------ */

const CATALOG = loadJsonFixture("chains-by-trending").bytes;
const PAIR_FRAME = loadFixture("pair-ws-ethereum-pepe").bytes;
const TOP_TRADERS = loadFixture("topmakers-uniswap-ethereum").bytes;

let release: (() => void) | null = null;
afterEach(() => {
  release?.();
  release = null;
});

async function callTool(
  toolId: string,
  params: Record<string, unknown>
): Promise<{ success: boolean; data: Record<string, unknown>; output: string }> {
  const handler = DEXSCREENER_HANDLERS[toolId];
  expect(handler).toBeDefined();
  if (handler === undefined) throw new Error("no handler");
  const result = await handler(params, makeProtocolContext());
  return {
    success: result.success,
    data: (result.data ?? {}) as Record<string, unknown>,
    output: result.output,
  };
}

describe("S10-36: cacheState comes from the response, not from a literal", () => {
  it("reports a cache hit and its age when the edge says so", async () => {
    // The defect: this family hardcoded "not_cached" while the edge had held
    // the document for up to 25 seconds. On a staleness-sensitive read that is
    // a freshness claim the tool had not measured.
    release = registerDexScreenerTransport({
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      httpGet: (url) =>
        Promise.resolve({
          url,
          status: 200,
          headers: new Map([
            ["cf-cache-status", "HIT"],
            ["age", "25"],
          ]),
          body: url.includes("/ds-data/") ? CATALOG : TOP_TRADERS,
        }),
      wsExchange: () => Promise.resolve([PAIR_FRAME]),
    } satisfies DexScreenerTransport);

    const out = await callTool("dexscreener.top.traders", {
      chain: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
    });
    expect(out.success, out.output).toBe(true);
    const observation = out.data["sourceObservation"] as Record<string, unknown>;
    expect(observation["cacheState"]).toBe("cache_hit");
    expect(observation["cacheAgeMs"]).toBe(25_000);
  });

  it("still says not_cached when the edge reports no cache status", async () => {
    // The other half: `not_cached` must remain reachable and truthful, or the
    // fix would just be a differently-wrong literal.
    release = registerDexScreenerTransport({
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      httpGet: (url) =>
        Promise.resolve({
          url,
          status: 200,
          headers: new Map<string, string>(),
          body: url.includes("/ds-data/") ? CATALOG : TOP_TRADERS,
        }),
      wsExchange: () => Promise.resolve([PAIR_FRAME]),
    } satisfies DexScreenerTransport);

    const out = await callTool("dexscreener.top.traders", {
      chain: "ethereum",
      pairAddress: "0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
    });
    expect(out.success, out.output).toBe(true);
    const observation = out.data["sourceObservation"] as Record<string, unknown>;
    expect(observation["cacheState"]).toBe("not_cached");
    // The contract this family also broke: cacheAgeMs travels with cache_hit
    // and with nothing else.
    expect(observation["cacheAgeMs"]).toBeUndefined();
  });
});

describe("S10-12: a channel that never opened is not a provider rejection", () => {
  it("names a local transport fault as one, and says retrying is appropriate", async () => {
    // Measured: the bridge process died ("relay exited 1") and the failure
    // reached the agent as provider_error/provider_error - the opposite
    // diagnosis, with the opposite remedy, and no retryability signal.
    release = registerDexScreenerTransport({
      name: "site_bridge",
      capabilities: { site: true, publicApi: true },
      httpGet: (url) =>
        Promise.resolve({
          url,
          status: 200,
          headers: new Map<string, string>(),
          body: CATALOG,
        }),
      wsExchange: () => Promise.reject(new Error("relay exited 1")),
    } satisfies DexScreenerTransport);

    const out = await callTool("dexscreener.pairs.batch", {
      pairs: "ethereum:0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f",
    });
    expect(out.success).toBe(false);
    expect(out.output).toContain("could not be reached");
    // The two facts the old classification destroyed: that nothing reached the
    // provider, and that this one IS safe to retry.
    expect(out.output).toContain("not a rejection by DexScreener");
    expect(out.output).toContain("RETRYING IS APPROPRIATE");
  });
});
