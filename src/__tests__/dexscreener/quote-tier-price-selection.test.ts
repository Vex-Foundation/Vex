/**
 * The quote-tier pricing rule, driven over LIVE-CAPTURED provider bytes.
 *
 * The defect this rule replaced is reproducible from the fixtures alone: the
 * old "deepest `liquidity.usd` wins regardless of quote" comparator priced JUP
 * at $1136.11 off a JUP/MET pool whose $176M depth is denominated in a token
 * DexScreener itself misprices. Reintroduce that comparator and the first case
 * below goes red.
 *
 * The rule is NOT "prefer a stablecoin pool". Among TRUSTED pools (stable- or
 * wrapped-native-quoted, above the liquidity floor) the deepest wins whichever
 * class it is, and the class only picks the arithmetic. Tier 2 is excluded at
 * any depth.
 *
 * Fixtures are verbatim live responses; see `fixtures/dexscreener/PROVENANCE.md`.
 * Every response is put through the REAL validator (`validateTokensResponse` /
 * `validateTokensPairsResponse`) first, so the projection is proven against the
 * same parsed shape production gets, not against a hand-written object.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createBestLiquidityPriceAccumulator,
  PRICE_SOURCE_MIN_LIQUIDITY_USD,
  type QuoteAssetPolicy,
} from "@tools/dexscreener/best-liquidity-price.js";
import {
  validateTokensPairsResponse,
  validateTokensResponse,
} from "@tools/dexscreener/validation/pairs.js";
import {
  SOLANA_QUOTE_ASSET_POLICY,
  SOL_MINT,
} from "@tools/solana-ecosystem/shared/solana-constants.js";
import { getLocalChain } from "@tools/evm-chains/registry.js";
import { getEvmChainQuotePolicy } from "@tools/dexscreener/evm-chain-quote-policy.js";
import type { DexPair } from "@tools/dexscreener/types.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/dexscreener/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";

const jupRepresentative = validateTokensResponse(fixture("tokens-v1-solana-jup.json"));
const jupPools = validateTokensPairsResponse(fixture("token-pairs-v1-solana-jup.json"));
const wsolRepresentative = validateTokensResponse(fixture("tokens-v1-solana-wsol.json"));
const vexRepresentative = validateTokensResponse(fixture("tokens-v1-robinhood-vex.json"));
const vexPools = validateTokensPairsResponse(fixture("token-pairs-v1-robinhood-vex.json"));
const arbUsdcRepresentative = validateTokensResponse(fixture("tokens-v1-arbitrum-usdc.json"));
const baseWethRepresentative = validateTokensResponse(fixture("tokens-v1-base-weth.json"));

function solanaAccumulator(wanted: readonly string[]) {
  return createBestLiquidityPriceAccumulator({
    wanted,
    normalizeAddress: (address) => address,
    quotePolicy: SOLANA_QUOTE_ASSET_POLICY,
  });
}

describe("quote-tier price selection over live provider bytes", () => {
  it("REGRESSION: JUP's representative pool is tier 2, so it prices to NOTHING rather than $1136", () => {
    // What the provider actually sent: one JUP/MET pool, $176M "liquidity".
    expect(jupRepresentative).toHaveLength(1);
    expect(jupRepresentative[0]?.quoteToken.symbol).toBe("MET");
    expect(jupRepresentative[0]?.priceUsd).toBe("1136.11");
    expect(jupRepresentative[0]?.liquidity?.usd).toBeGreaterThan(100_000_000);

    const accumulator = solanaAccumulator([JUP, SOL_MINT]);
    accumulator.addPairs(wsolRepresentative);
    accumulator.addPairs(jupRepresentative);

    // The old comparator produced 1136.11 here. Refusing is the fix.
    expect(accumulator.toPriceMap().get(JUP)).toBeUndefined();
    expect(accumulator.unpricedAddresses()).toContain(JUP);
    // SOL still prices, from its own tier-0 SOL/USDC pool.
    expect(accumulator.toPriceMap().get(SOL_MINT)).toBeCloseTo(96.76, 2);
  });

  it("prices JUP from the FULL pool list the way the caller's fallback does", () => {
    const accumulator = solanaAccumulator([JUP, SOL_MINT]);
    accumulator.addPairs(wsolRepresentative);
    accumulator.addPairs(jupRepresentative);
    // What `unpriced-pool-fallback.ts` folds in on the second pass.
    accumulator.addPairs(jupPools);

    const price = accumulator.toPriceMap().get(JUP);
    // The DEEPEST trusted pool is JUP/SOL ($1.36M), not JUP/USDC ($165k), so
    // the native-quoted pool wins and the price is priceNative x our SOL price:
    // 0.002239 x 96.76 = $0.2166. Every JUP/MET pool is tier 2 and excluded at
    // any depth, including the $176M one.
    expect(price).toBeCloseTo(0.2166, 3);
    const decision = accumulator.toDecisionMap().get(JUP);
    expect(decision?.tier).toBe(1);
    expect(decision?.quoteSymbol).toBe("SOL");
    expect(decision?.basis).toBe("native-quote-multiple");
    expect(decision?.liquidityUsd).toBeCloseTo(1_361_290, 0);
  });

  it("the two trusted routes to JUP agree, which is why depth may pick between them", () => {
    // JUP/USDC (tier 0, $165k) says $0.2170; JUP/SOL (tier 1, $1.36M) says
    // $0.2166. Preferring the stable pool on principle would report the
    // 8x thinner market for a 0.2% difference.
    const stableOnly = createBestLiquidityPriceAccumulator({
      wanted: [JUP],
      normalizeAddress: (address) => address,
      quotePolicy: { ...SOLANA_QUOTE_ASSET_POLICY, wrappedNative: "not-a-quote-asset-here" },
    });
    stableOnly.addPairs(jupPools);
    expect(stableOnly.toPriceMap().get(JUP)).toBeCloseTo(0.217, 3);
    expect(stableOnly.toDecisionMap().get(JUP)?.quoteSymbol).toBe("USDC");
  });

  it("agrees with the tier-1 derivation it beat: JUP/SOL priceNative x our SOL price", () => {
    // Same pool list, but with the stables removed from the policy so the only
    // survivor is the tier-1 JUP/SOL pool. This proves the two independent
    // routes to JUP's price agree to within a spread, i.e. tier 1 is sound.
    const nativeOnly: QuoteAssetPolicy = { stables: new Set<string>(), wrappedNative: SOL_MINT };
    const accumulator = createBestLiquidityPriceAccumulator({
      wanted: [JUP, SOL_MINT],
      normalizeAddress: (address) => address,
      quotePolicy: nativeOnly,
    });
    accumulator.addPairs(wsolRepresentative);
    accumulator.addPairs(jupPools);

    const decision = accumulator.toDecisionMap().get(JUP);
    expect(decision?.tier).toBe(1);
    expect(decision?.basis).toBe("native-quote-multiple");
    // 0.002239 x nativeUsd. Under THIS policy the SOL/USDC pool is tier 2, so
    // nativeUsd falls to the implied leg: 96.76 / 96.7636.
    const nativeUsd = accumulator.nativeUsd();
    expect(nativeUsd).not.toBeNull();
    expect(accumulator.toPriceMap().get(JUP)).toBeCloseTo(0.002239 * (nativeUsd ?? 0), 6);
    expect(accumulator.toPriceMap().get(JUP)).toBeCloseTo(0.2167, 3);
  });

  it("counts tiers over the whole wanted set, unpriced included", () => {
    const accumulator = solanaAccumulator([
      JUP,
      SOL_MINT,
      "SoMeMintThatWasNeverQuotedAnywhere11111111",
    ]);
    accumulator.addPairs(wsolRepresentative);
    accumulator.addPairs(jupPools);
    // SOL from its own stable pool, JUP from its deeper native pool.
    expect(accumulator.countTiers()).toEqual({ tier0: 1, tier1: 1, unpriced: 1 });
    expect(accumulator.unpricedReasons().get("SoMeMintThatWasNeverQuotedAnywhere11111111")).toBe(
      "no_trusted_pool",
    );
  });

  it("tier-2-only everywhere prices nothing, even with enormous liquidity", () => {
    const accumulator = solanaAccumulator([JUP]);
    // Every JUP/MET pool in the live list, and nothing else.
    accumulator.addPairs(jupPools.filter((pair) => pair.quoteToken.symbol === "MET"));
    expect(accumulator.toPriceMap().size).toBe(0);
    expect(accumulator.countTiers()).toEqual({ tier0: 0, tier1: 0, unpriced: 1 });
    expect(accumulator.unpricedReasons().get(JUP)).toBe("no_trusted_pool");
  });
});

describe("depth ordering among trusted pools", () => {
  const policy: QuoteAssetPolicy = { stables: new Set(["stable"]), wrappedNative: "wnative" };

  interface Row {
    base: string;
    quote: string;
    priceUsd?: string;
    priceNative?: string;
    liquidityUsd?: number;
  }

  const build = (rows: readonly Row[]): DexPair[] =>
    rows.map((row, index) => ({
      chainId: "test",
      dexId: "test",
      url: "",
      pairAddress: `pair${index}`,
      labels: [],
      baseToken: { address: row.base, name: "b", symbol: "B" },
      quoteToken: { address: row.quote, name: "q", symbol: row.quote },
      priceNative: row.priceNative ?? "1",
      priceUsd: row.priceUsd ?? null,
      txns: {},
      volume: {},
      priceChange: null,
      liquidity: { usd: row.liquidityUsd ?? 0, base: 0, quote: 0 },
      fdv: null,
      marketCap: null,
      pairCreatedAt: null,
      info: null,
      boosts: null,
    }));

  const accumulatorFor = (wanted: readonly string[], quotePolicy: QuoteAssetPolicy = policy) =>
    createBestLiquidityPriceAccumulator({
      wanted,
      normalizeAddress: (address) => address,
      quotePolicy,
    });

  it("a DEEPER native pool beats a SHALLOWER stable pool (the owner's memecoin case)", () => {
    const accumulator = accumulatorFor(["tok"]);
    accumulator.addPairs(
      build([
        // Anchors nativeUsd at $10.
        { base: "wnative", quote: "stable", priceUsd: "10", liquidityUsd: 1_000_000 },
        // Tier 0, but a $2k book.
        { base: "tok", quote: "stable", priceUsd: "27", liquidityUsd: 2_000 },
        // Tier 1, a $1M book: 3 x $10 = $30. Depth decides, not the class.
        { base: "tok", quote: "wnative", priceNative: "3", liquidityUsd: 1_000_000 },
      ]),
    );
    expect(accumulator.toPriceMap().get("tok")).toBe(30);
    expect(accumulator.toDecisionMap().get("tok")?.tier).toBe(1);
  });

  it("a SHALLOWER stable pool loses even though it is tier 0", () => {
    const accumulator = accumulatorFor(["tok"]);
    accumulator.addPairs(
      build([
        { base: "wnative", quote: "stable", priceUsd: "10", liquidityUsd: 1_000_000 },
        { base: "tok", quote: "stable", priceUsd: "99", liquidityUsd: 1_500 },
        { base: "tok", quote: "wnative", priceNative: "3", liquidityUsd: 1_501 },
      ]),
    );
    expect(accumulator.toPriceMap().get("tok")).toBe(30);
  });

  it("a stable pool wins when it IS the deepest", () => {
    const accumulator = accumulatorFor(["tok"]);
    accumulator.addPairs(
      build([
        { base: "wnative", quote: "stable", priceUsd: "10", liquidityUsd: 1_000_000 },
        { base: "tok", quote: "stable", priceUsd: "27", liquidityUsd: 5_000 },
        { base: "tok", quote: "wnative", priceNative: "3", liquidityUsd: 4_999 },
      ]),
    );
    expect(accumulator.toPriceMap().get("tok")).toBe(27);
    expect(accumulator.toDecisionMap().get("tok")?.tier).toBe(0);
  });

  it("a tier-2 pool never wins, however deep", () => {
    const accumulator = accumulatorFor(["tok"]);
    accumulator.addPairs(
      build([
        { base: "wnative", quote: "stable", priceUsd: "10", liquidityUsd: 1_000_000 },
        { base: "tok", quote: "stable", priceUsd: "27", liquidityUsd: 1_100 },
        { base: "tok", quote: "mystery", priceUsd: "99999", liquidityUsd: 900_000_000 },
      ]),
    );
    expect(accumulator.toPriceMap().get("tok")).toBe(27);
  });

  it("within one class the deeper pool wins", () => {
    const accumulator = accumulatorFor(["tok"]);
    accumulator.addPairs(
      build([
        { base: "tok", quote: "stable", priceUsd: "5", liquidityUsd: 1_000 },
        { base: "tok", quote: "stable", priceUsd: "7", liquidityUsd: 2_000 },
        { base: "tok", quote: "stable", priceUsd: "9", liquidityUsd: 1_500 },
      ]),
    );
    expect(accumulator.toPriceMap().get("tok")).toBe(7);
  });

  it("a sub-floor pool is not a price source, and says so", () => {
    const accumulator = accumulatorFor(["tok"]);
    // The measured shape: jlUSDC at $1.058 out of a $43 pool.
    accumulator.addPairs(
      build([{ base: "tok", quote: "stable", priceUsd: "1.058", liquidityUsd: 43 }]),
    );
    expect(accumulator.toPriceMap().size).toBe(0);
    expect(accumulator.unpricedReasons().get("tok")).toBe("below_liquidity_floor");
  });

  it("a token with a sub-floor AND an at-floor pool prices from the at-floor one", () => {
    const accumulator = accumulatorFor(["tok"]);
    accumulator.addPairs(
      build([
        // Deeper in raw terms would be the $999 pool if the floor did not exist.
        { base: "tok", quote: "stable", priceUsd: "1.058", liquidityUsd: 999 },
        { base: "tok", quote: "stable", priceUsd: "0.5", liquidityUsd: PRICE_SOURCE_MIN_LIQUIDITY_USD },
      ]),
    );
    expect(accumulator.toPriceMap().get("tok")).toBe(0.5);
  });

  it("the floor applies to the nativeUsd anchor too", () => {
    const accumulator = accumulatorFor(["tok"]);
    accumulator.addPairs(
      build([
        // A $12 wrapped-native pool cannot set the price of a whole chain.
        { base: "wnative", quote: "stable", priceUsd: "10", liquidityUsd: 12 },
        { base: "tok", quote: "wnative", priceNative: "3", liquidityUsd: 50_000 },
      ]),
    );
    expect(accumulator.nativeUsd()).toBeNull();
    expect(accumulator.toPriceMap().size).toBe(0);
    expect(accumulator.unpricedReasons().get("tok")).toBe("no_native_price");
  });

  it("a tier-1 token stays UNPRICED when no pool anywhere supplies nativeUsd", () => {
    const accumulator = accumulatorFor(["tok"]);
    // Tier 1 with no priceUsd at all: nothing can imply the native price.
    accumulator.addPairs(
      build([{ base: "tok", quote: "wnative", priceNative: "3", liquidityUsd: 50_000 }]),
    );
    expect(accumulator.nativeUsd()).toBeNull();
    expect(accumulator.toPriceMap().size).toBe(0);
    expect(accumulator.unpricedReasons().get("tok")).toBe("no_native_price");
  });

  it("the wrapped native is priced by the SAME nativeUsd every tier-1 token uses", () => {
    const accumulator = accumulatorFor(["tok", "wnative"]);
    accumulator.addPairs(
      build([
        { base: "wnative", quote: "stable", priceUsd: "10", liquidityUsd: 1_000_000 },
        { base: "tok", quote: "wnative", priceNative: "3", liquidityUsd: 50_000 },
      ]),
    );
    expect(accumulator.toPriceMap().get("wnative")).toBe(10);
    expect(accumulator.toPriceMap().get("tok")).toBe(30);
    expect(accumulator.countTiers()).toEqual({ tier0: 1, tier1: 1, unpriced: 0 });
  });

  it("a wanted STABLECOIN is priced from the quote side (priceUsd / priceNative)", () => {
    const accumulator = accumulatorFor(["stable"]);
    accumulator.addPairs(
      build([{ base: "tok", quote: "stable", priceUsd: "2.25", priceNative: "1.5", liquidityUsd: 40_000 }]),
    );
    expect(accumulator.toPriceMap().get("stable")).toBe(1.5);
    expect(accumulator.toDecisionMap().get("stable")?.basis).toBe("stable-quote-inverted");
  });

  it("normalizes the POLICY's addresses too, so a table may be written in any case", () => {
    const accumulator = createBestLiquidityPriceAccumulator({
      wanted: ["TOK"],
      normalizeAddress: (address) => address.toLowerCase(),
      quotePolicy: { stables: new Set(["STABLE"]), wrappedNative: "WNATIVE" },
    });
    accumulator.addPairs(build([{ base: "tok", quote: "stable", priceUsd: "4", liquidityUsd: 9_000 }]));
    expect(accumulator.toPriceMap().get("tok")).toBe(4);
  });
});

describe("nativeUsd derivation, both live routes", () => {
  it("ANCHOR route: the wrapped native's own tier-0 pool prices it directly", () => {
    const base = getEvmChainQuotePolicy(8453);
    if (!base) throw new Error("base 8453 missing from the quote-policy table");
    const accumulator = createBestLiquidityPriceAccumulator({
      wanted: [base.policy.wrappedNative],
      normalizeAddress: (address) => address.toLowerCase(),
      quotePolicy: base.policy,
    });
    accumulator.addPairs(baseWethRepresentative);
    // Live capture: WETH/USDC, priceUsd 2472.15, $4.41M.
    expect(accumulator.nativeUsd()).toBeCloseTo(2472.15, 2);
    const decision = accumulator.toDecisionMap().get(base.policy.wrappedNative);
    expect(decision?.basis).toBe("native-anchor");
    expect(decision?.tier).toBe(0);
  });

  it("IMPLIED route: arbitrum WETH's own pool is WBTC-quoted, so USDC/WETH supplies nativeUsd", () => {
    const arbitrum = getEvmChainQuotePolicy(42161);
    if (!arbitrum) throw new Error("arbitrum 42161 missing from the quote-policy table");
    const accumulator = createBestLiquidityPriceAccumulator({
      wanted: [arbitrum.policy.wrappedNative],
      normalizeAddress: (address) => address.toLowerCase(),
      quotePolicy: arbitrum.policy,
    });
    // Live capture: USDC/WETH, priceUsd 1.000021, priceNative 0.0004044.
    accumulator.addPairs(arbUsdcRepresentative);
    expect(accumulator.nativeUsd()).toBeCloseTo(1.000021 / 0.0004044, 1);
    expect(accumulator.toPriceMap().get(arbitrum.policy.wrappedNative)).toBeCloseTo(2472.9, 0);
    expect(accumulator.toDecisionMap().get(arbitrum.policy.wrappedNative)?.tier).toBe(1);
  });
});

describe("robinhood $VEX, the local-chain twin of the JUP defect", () => {
  const config = getLocalChain(4663);
  if (!config) throw new Error("local chain 4663 missing from the registry");

  const accumulatorFor = (wanted: readonly string[]) =>
    createBestLiquidityPriceAccumulator({
      wanted,
      normalizeAddress: (address) => address.toLowerCase(),
      quotePolicy: config.quoteAssetPolicy,
    });

  it("VEX's representative pool is VIRTUAL-quoted (tier 2) and prices nothing", () => {
    expect(vexRepresentative[0]?.quoteToken.symbol).toBe("VIRTUAL");
    const accumulator = accumulatorFor([VEX]);
    accumulator.addPairs(vexRepresentative);
    expect(accumulator.toPriceMap().size).toBe(0);
  });

  it("the full pool list prices VEX from the deepest TRUSTED pool, VEX/USDG", () => {
    const accumulator = accumulatorFor([VEX]);
    accumulator.addPairs(vexRepresentative);
    accumulator.addPairs(vexPools);
    const price = accumulator.toPriceMap().get(VEX.toLowerCase());
    expect(price).toBeCloseTo(0.002747, 6);
    const decision = accumulator.toDecisionMap().get(VEX.toLowerCase());
    expect(decision?.tier).toBe(0);
    expect(decision?.quoteSymbol).toBe("USDG");
    // The deepest VEX pool in the live list is the $280k tier-2 VEX/VIRTUAL
    // one, excluded; the deepest TRUSTED pool holds $69k. The VEX/WETH pool
    // ($1.2k) and the sub-floor VEX/USDG pools lose on depth.
    expect(decision?.liquidityUsd).toBeCloseTo(69463.21, 2);
  });
});
