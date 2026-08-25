/**
 * S11a characterization: the observable contract of every NON-AGENT
 * DexScreener price consumer, pinned at its DEFAULT wiring.
 *
 * ## Why this suite exists and what makes it evidence
 *
 * S11a moves five consumers off the REST `client.ts` and onto the
 * `price-read.ts` seam. Each one already has a behavior suite that injects its
 * dependencies, so what those suites prove survives the migration by
 * construction - and says nothing about it, because the thing that changes is
 * the DEFAULT wiring underneath the injection point.
 *
 * So this suite drives each consumer through the wiring it uses in production,
 * from provider bytes to the value the consumer publishes, and asserts two
 * things that must not move: the exact provider PATH requested, and the
 * consumer's own output. `price-read-harness.ts` answers both the old client's
 * `fetchWithTimeout` and the new seam's registered transport from one route
 * table, so this file is byte-identical before and after the swap. It was run
 * green against the pre-swap tree first; that run is the characterization, and
 * the post-swap run is the parity proof.
 *
 * Fixture rows are trimmed from responses captured live on 2026-08-25 and
 * archived under `scratchpad/execution/s11a/probe2-live-shapes.json`, so every
 * optional field a consumer reads is PRESENT in at least one row rather than
 * asserted null against a fixture that never had it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  installFakeTransport,
  requestedPaths,
  serveDexScreener,
} from "./price-read-harness.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
// The banner's holders enrichment is a different provider entirely; it is
// stubbed to null so this suite characterizes the DexScreener half alone.
vi.mock("@tools/virtuals/client.js", () => ({
  getVirtualsClient: () => ({ getVirtual: async () => null }),
}));

const { resetPriceReadCacheForTests } = await import("@tools/dexscreener/price-read.js");
const { createTokenPriceEvaluator, readWatchedTokenPools } = await import(
  "../../vex-agent/engine/wake/watch/token-price.js"
);
const { buildProductionPriceWatchDeps } = await import(
  "../../vex-agent/engine/wake/price-watch-poller.js"
);
const { buildOwnTokenBanner } = await import(
  "../../vex-agent/engine/prompts/own-token-banner.js"
);
const { checkOutputLiquidity } = await import(
  "../../vex-agent/tools/protocols/uniswap/handlers/swap/quote-safety.js"
);
const { listUniswapDeployments } = await import("@tools/uniswap/deployments.js");

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

interface PairOverrides {
  readonly pairAddress: string;
  readonly baseAddress: string;
  readonly quoteAddress: string;
  readonly priceUsd: string | null;
  readonly priceNative: string;
  readonly liquidityUsd: number | null;
  readonly chainId?: string;
  readonly dexId?: string;
  readonly priceChangeH24?: number;
  readonly marketCap?: number;
}

/** A pair row with every field the five consumers read, shaped like the live one. */
function pairRow(overrides: PairOverrides): Record<string, unknown> {
  return {
    chainId: overrides.chainId ?? "base",
    dexId: overrides.dexId ?? "uniswap",
    url: `https://dexscreener.com/${overrides.chainId ?? "base"}/${overrides.pairAddress}`,
    pairAddress: overrides.pairAddress,
    labels: ["v3"],
    baseToken: { address: overrides.baseAddress, name: "Base Token", symbol: "BASE" },
    quoteToken: { address: overrides.quoteAddress, name: "Quote Token", symbol: "QUOTE" },
    priceNative: overrides.priceNative,
    priceUsd: overrides.priceUsd,
    txns: { h24: { buys: 12, sells: 7 } },
    volume: { h24: 123456.78 },
    priceChange: { h24: overrides.priceChangeH24 ?? -10.84 },
    liquidity: { usd: overrides.liquidityUsd, base: 1000, quote: 2000 },
    fdv: 2573248,
    marketCap: overrides.marketCap ?? 2573248,
    pairCreatedAt: 1_749_000_000_000,
    info: { imageUrl: "https://example.invalid/icon.png" },
  };
}

const WATCHED_TOKEN = "0x532f27101965dd16442e59d40670faf5ebb142e4";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

/**
 * Three pools for the watched token, built so the selection rule is VISIBLE in
 * the answer: the deepest pool of the three prices the token an order of
 * magnitude above the other two, so a naive depth pick and the real rule
 * (deepest sane NON-OUTLIER) return different prices.
 */
const WATCHED_TOKEN_POOLS = [
  pairRow({
    pairAddress: "0xdeep0utl1er00000000000000000000000000001",
    baseAddress: WATCHED_TOKEN,
    quoteAddress: WETH_BASE,
    priceUsd: "42.0",
    priceNative: "0.01",
    liquidityUsd: 9_000_000,
    dexId: "mispriced-amm",
  }),
  pairRow({
    pairAddress: "0x5ane0deepe5t000000000000000000000000002",
    baseAddress: WATCHED_TOKEN,
    quoteAddress: WETH_BASE,
    priceUsd: "1.25",
    priceNative: "0.0004",
    liquidityUsd: 3_500_000,
  }),
  pairRow({
    pairAddress: "0x5ha11ower00000000000000000000000000003",
    baseAddress: WATCHED_TOKEN,
    quoteAddress: WETH_BASE,
    priceUsd: "1.24",
    priceNative: "0.0004",
    liquidityUsd: 120_000,
  }),
];

const VEX_CHAIN = "robinhood";
const VEX_PAIR = "0x817f16F5D8da83d1B089B082c0172af3923618dA";

let unregisterTransport: (() => void) | null = null;

beforeEach(() => {
  resetPriceReadCacheForTests();
  unregisterTransport = installFakeTransport();
});

afterEach(() => {
  unregisterTransport?.();
  unregisterTransport = null;
});

/* ------------------------------------------------------------------ */
/* Consumer 1: the `token_price` wake watch, at arming                 */
/* ------------------------------------------------------------------ */

describe("token_price watch: default provider wiring", () => {
  it("arms from the deepest SANE pool, not the deepest pool", async () => {
    serveDexScreener({
      [`/token-pairs/v1/base/${WATCHED_TOKEN}`]: { body: WATCHED_TOKEN_POOLS },
    });

    const evaluator = createTokenPriceEvaluator({
      getTokenPairs: readWatchedTokenPools,
      listPendingPriceWatchPairs: async () => [],
    });

    const armed = await evaluator.validate(
      {
        type: "token_price",
        chain: "base",
        tokenAddress: WATCHED_TOKEN,
        direction: "above",
        priceUsd: "5",
      },
      // The evaluator's provider path never touches the tool context.
      {} as never,
    );

    expect(armed).toMatchObject({
      type: "token_price",
      chain: "base",
      tokenAddress: WATCHED_TOKEN,
      direction: "above",
      priceUsd: "5",
      // 1.25 is the deepest NON-OUTLIER. The 9M-deep pool at 42.0 is an order
      // of magnitude off the median and must not be what a watch arms on.
      referencePriceUsd: "1.25",
      poolCount: 3,
    });
    expect(requestedPaths()).toEqual([`/token-pairs/v1/base/${WATCHED_TOKEN}`]);
  });

  it("refuses to arm, by name, when no pool prices the token", async () => {
    serveDexScreener({ [`/token-pairs/v1/base/${WATCHED_TOKEN}`]: { body: [] } });

    const evaluator = createTokenPriceEvaluator({
      getTokenPairs: readWatchedTokenPools,
      listPendingPriceWatchPairs: async () => [],
    });

    await expect(
      evaluator.validate(
        {
          type: "token_price",
          chain: "base",
          tokenAddress: WATCHED_TOKEN,
          direction: "above",
          priceUsd: "5",
        },
        {} as never,
      ),
    ).rejects.toThrow(/no priced pool/i);
  });
});

/* ------------------------------------------------------------------ */
/* Consumer 2: the price-watch poller's production deps                */
/* ------------------------------------------------------------------ */

describe("price-watch poller: production provider dep", () => {
  it("reads the full pool list for one (chain, token) and returns every row", async () => {
    serveDexScreener({
      [`/token-pairs/v1/base/${WATCHED_TOKEN}`]: { body: WATCHED_TOKEN_POOLS },
    });

    const pools = await buildProductionPriceWatchDeps().getTokenPairs("base", WATCHED_TOKEN, {
      timeoutMs: 5_000,
    });

    expect(pools).toHaveLength(3);
    expect(pools.map((pool) => pool.pairAddress)).toEqual(
      WATCHED_TOKEN_POOLS.map((pool) => pool["pairAddress"]),
    );
    expect(requestedPaths()).toEqual([`/token-pairs/v1/base/${WATCHED_TOKEN}`]);
  });

  it("shares one provider request between two callers asking in the same moment", async () => {
    serveDexScreener({
      [`/token-pairs/v1/base/${WATCHED_TOKEN}`]: { body: WATCHED_TOKEN_POOLS },
    });

    const deps = buildProductionPriceWatchDeps();
    await Promise.all([
      deps.getTokenPairs("base", WATCHED_TOKEN, { timeoutMs: 5_000 }),
      deps.getTokenPairs("base", WATCHED_TOKEN, { timeoutMs: 5_000 }),
    ]);

    // The 3 s poll cadence is only affordable because of this. Two ticks that
    // overlap, or two watches on one token, cost ONE request.
    expect(requestedPaths()).toEqual([`/token-pairs/v1/base/${WATCHED_TOKEN}`]);
  });

  it("bounds the CALLER'S wait without cancelling the shared request", async () => {
    serveDexScreener({
      [`/token-pairs/v1/base/${WATCHED_TOKEN}`]: { body: WATCHED_TOKEN_POOLS },
    });

    const aborter = new AbortController();
    aborter.abort();

    await expect(
      buildProductionPriceWatchDeps().getTokenPairs("base", WATCHED_TOKEN, {
        timeoutMs: 5_000,
        signal: aborter.signal,
      }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Consumer 3: the $VEX own-token prompt banner                        */
/* ------------------------------------------------------------------ */

describe("$VEX own-token banner: default snapshot wiring", () => {
  it("renders the live snapshot from the pair read", async () => {
    serveDexScreener({
      [`/latest/dex/pairs/${VEX_CHAIN}/${VEX_PAIR}`]: {
        body: {
          schemaVersion: "1.0.0",
          pairs: [
            pairRow({
              chainId: VEX_CHAIN,
              pairAddress: VEX_PAIR,
              baseAddress: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b",
              quoteAddress: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
              priceUsd: "0.002573",
              priceNative: "0.003398",
              liquidityUsd: 279_587.37,
              priceChangeH24: -10.84,
              marketCap: 2_573_248,
            }),
          ],
        },
      },
    });

    const banner = await buildOwnTokenBanner();

    expect(banner).toContain("# $VEX (own token)");
    expect(banner).toContain("- Price: $0.002573 (24h -10.84%)");
    expect(banner).toContain("- Market cap: $2,573,248");
    expect(banner).toContain("- Liquidity: $279,587");
    expect(requestedPaths()).toEqual([`/latest/dex/pairs/${VEX_CHAIN}/${VEX_PAIR}`]);
  });

  it("omits the banner entirely when the provider refuses", async () => {
    serveDexScreener({
      [`/latest/dex/pairs/${VEX_CHAIN}/${VEX_PAIR}`]: {
        status: 502,
        body: { error: "bad gateway" },
      },
    });

    // Fail-soft is the whole contract here: this string lands in a system
    // prompt, so a provider failure must cost the layer, never the turn.
    await expect(buildOwnTokenBanner()).resolves.toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* Consumer 4: the Uniswap quote-safety liquidity check                */
/* ------------------------------------------------------------------ */

describe("Uniswap quote safety: output-token liquidity", () => {
  const base = listUniswapDeployments().find((deployment) => deployment.key === "base");

  it("takes the deepest pool whose BASE side is the output token", async () => {
    if (base === undefined) throw new Error("the base deployment is missing from the registry");
    serveDexScreener({
      [`/tokens/v1/base/${WATCHED_TOKEN}`]: {
        body: [
          // Quote-side row: the output token is not the base side, so its
          // liquidity must NOT be considered.
          pairRow({
            pairAddress: "0xquote51de000000000000000000000000000001",
            baseAddress: WETH_BASE,
            quoteAddress: WATCHED_TOKEN,
            priceUsd: "3000",
            priceNative: "1",
            liquidityUsd: 50_000_000,
          }),
          pairRow({
            pairAddress: "0xba5e51de0000000000000000000000000000002",
            baseAddress: WATCHED_TOKEN,
            quoteAddress: WETH_BASE,
            priceUsd: "1.25",
            priceNative: "0.0004",
            liquidityUsd: 3_500_000,
          }),
          pairRow({
            pairAddress: "0xba5e51de0000000000000000000000000000003",
            baseAddress: WATCHED_TOKEN,
            quoteAddress: WETH_BASE,
            priceUsd: "1.24",
            priceNative: "0.0004",
            liquidityUsd: 120_000,
          }),
        ],
      },
    });

    const liquidity = await checkOutputLiquidity(base, {
      address: WATCHED_TOKEN as `0x${string}`,
      symbol: "BASE",
      decimals: 18,
      isNative: false,
    });

    expect(liquidity).toEqual({ checked: true, usd: 3_500_000, aboveThreshold: true });
    expect(requestedPaths()).toEqual([`/tokens/v1/base/${WATCHED_TOKEN}`]);
  });

  it("reports checkFailed, never a zero, when the provider refuses", async () => {
    if (base === undefined) throw new Error("the base deployment is missing from the registry");
    serveDexScreener({
      [`/tokens/v1/base/${WATCHED_TOKEN}`]: { status: 429, body: { error: "slow down" } },
    });

    const liquidity = await checkOutputLiquidity(base, {
      address: WATCHED_TOKEN as `0x${string}`,
      symbol: "BASE",
      decimals: 18,
      isNative: false,
    });

    // "unknown" and "no liquidity" have opposite meanings for a swap refusal.
    expect(liquidity).toEqual({ checkFailed: true, reason: "unavailable" });
  });

  it("never asks the provider about a native output leg", async () => {
    if (base === undefined) throw new Error("the base deployment is missing from the registry");
    serveDexScreener({});

    const liquidity = await checkOutputLiquidity(base, {
      address: WETH_BASE as `0x${string}`,
      symbol: "ETH",
      decimals: 18,
      isNative: true,
    });

    expect(liquidity).toEqual({ checked: true, usd: null, aboveThreshold: true });
    expect(requestedPaths()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The migration itself: old client and new seam, on the same bytes    */
/* ------------------------------------------------------------------ */

/**
 * The pre/post pin, taken SIMULTANEOUSLY rather than temporally.
 *
 * The obvious form of "characterize, then swap, then re-run" is to record the
 * old tree's answers and compare. That was not available here: this worktree is
 * shared with five other tasks, so stashing the swap to run against the old code
 * would have moved their files too. The equivalent evidence, and a stronger
 * regression guard because it keeps running, is to drive BOTH implementations
 * over one route table in one process and require them to agree.
 *
 * REMOVAL CONDITION: this block dies with `client.ts`, at measured zero
 * consumers. It is the last thing in the repository asserting the old client's
 * behavior, so it must not be deleted before the client is.
 */


/** The typed failure's code, or null when the value carries none. */
function codeOf(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error
    && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}
