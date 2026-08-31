/**
 * CHARACTERIZATION of the local-EVM DexScreener price selection.
 *
 * It pins the observable output of `readLocalChainBalances` - the exact price
 * attached to every token and to the native coin - across the axes an edit
 * could plausibly move: base-side vs quote-side matching, the deepest-pool
 * tie-break, competition ACROSS request batches (the accumulator is stateful
 * for this reason), a null `liquidity`, an unparseable `priceNative`, a
 * negative price, and an address whose case differs from the checksummed scan
 * address.
 *
 * ## DELIBERATE CONTRACT CHANGE 2026-08-26: quote tiers
 *
 * The comparator this file was written against was "deepest `liquidity.usd`
 * wins, regardless of which quote asset the pool is denominated in". Measured
 * live, that rule priced JUP on Solana at $1136.11 (see
 * `__tests__/dexscreener/quote-tier-price-selection.test.ts`), so the rule is
 * now: a pool may price a token ONLY if its quote asset is a stablecoin this
 * chain's policy recognises (tier 0) or the chain's wrapped native (tier 1),
 * and only above `PRICE_SOURCE_MIN_LIQUIDITY_USD`. Among those the DEEPEST
 * pool wins whichever class it is; the class only selects the arithmetic.
 * A pool quoted in anything else prices nothing at any depth.
 *
 * Every case below that the two rules AGREE on is kept verbatim and still
 * pinned. The cases that changed are named for the reason they changed, and
 * each states the new rule rather than the old number. A token left unpriced
 * by the representative pool list now also gets one full-pool-list re-read, so
 * `readTokenPools` is mocked here too.
 *
 * If a future edit changes any number here, it changed pricing behavior, not
 * structure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPublicClient, http, type Chain, type PublicClient, type Transport } from "viem";
import { mainnet } from "viem/chains";

type EvmClientModule = typeof import("@tools/evm-chains/evm-client.js");

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockReadTokensPairs = vi.fn();
const mockReadTokenPools = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
  readTokenPools: (...args: unknown[]) => mockReadTokenPools(...args),
}));

const baseClient: PublicClient<Transport, Chain> = createPublicClient({
  chain: mainnet,
  transport: http("http://127.0.0.1:1"),
});
const fakeClient = Object.assign(baseClient, {
  multicall: vi.fn(),
  getBalance: vi.fn(),
});
vi.mock("@tools/evm-chains/evm-client.js", () => ({
  getLocalPublicClient: (..._args: Parameters<EvmClientModule["getLocalPublicClient"]>) => fakeClient,
}));

const { readLocalChainBalances, resetLocalChainMetadataCache } = await import(
  "@tools/evm-chains/balances.js"
);
const { getLocalChain } = await import("@tools/evm-chains/registry.js");

const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const config = getLocalChain(4663);
if (!config) throw new Error("local chain 4663 missing from the registry");

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b" as const;
const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

/** 30 filler addresses push VEX/VIRTUAL/USDG into the SECOND provider batch. */
function filler(index: number): `0x${string}` {
  return `0x${(index + 1).toString(16).padStart(40, "0")}` as `0x${string}`;
}
const FILLERS = Array.from({ length: 29 }, (_unused, index) => filler(index));
const SCAN: readonly `0x${string}`[] = [WETH, ...FILLERS, VEX, VIRTUAL, USDG];

// USDG is robinhood's ONLY tier-0 quote asset; WETH is its wrapped native.
function pair(fields: {
  base: string;
  quote?: string | null;
  priceUsd: string | null;
  priceNative?: string;
  liquidityUsd?: number | null;
}): Record<string, unknown> {
  return {
    chainId: "robinhood",
    pairAddress: `0xpair-${fields.base}-${fields.quote ?? "none"}-${fields.priceUsd ?? "null"}`,
    baseToken: { address: fields.base, name: "b", symbol: "B" },
    quoteToken: { address: fields.quote ?? null, name: null, symbol: null },
    priceUsd: fields.priceUsd,
    priceNative: fields.priceNative ?? "1",
    liquidity: fields.liquidityUsd === undefined ? null : { usd: fields.liquidityUsd, base: 0, quote: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the pool-list fallback finds nothing extra. Cases that exercise
  // it override this.
  mockReadTokenPools.mockResolvedValue([]);
  resetLocalChainMetadataCache();
  fakeClient.getBalance.mockResolvedValue(1_000000000000000000n);
  fakeClient.multicall.mockImplementation((args: unknown) => {
    const { contracts } = args as { contracts: Array<{ functionName: string }> };
    return Promise.resolve(
      contracts.map((call) => {
        if (call.functionName === "decimals") return { status: "success", result: 18 };
        if (call.functionName === "symbol") return { status: "success", result: "TKN" };
        return { status: "success", result: 1_000000000000000000n };
      }),
    );
  });
});

describe("local-chain price selection (characterization)", () => {
  it("pins tier-0/tier-1 matching, the in-tier deepest-pool tie-break and cross-batch competition", async () => {
    mockReadTokensPairs.mockImplementation((_slug: string, addresses: string) => {
      const isFirstBatch = addresses.toLowerCase().includes(WETH.toLowerCase());
      if (isFirstBatch) {
        return Promise.resolve([
          // WETH is priced from the QUOTE side: 1.5 / 0.0005 = 3000.
          pair({ base: filler(3), quote: WETH, priceUsd: "1.5", priceNative: "0.0005", liquidityUsd: 1_000_000 }),
          // VIRTUAL, base side, tier 0, above the floor but SHALLOWER than the
          // second-batch pool below: proves a later batch can win, i.e. the
          // accumulator is not per-batch.
          pair({ base: VIRTUAL, quote: USDG, priceUsd: "9.99", liquidityUsd: 1_500 }),
          // Unparseable priceNative: the quote side contributes nothing, so USDG
          // stays priced by its own base-side pool in the second batch.
          pair({ base: filler(0), quote: USDG, priceUsd: "5", priceNative: "not-a-number", liquidityUsd: 9_000_000 }),
          // Negative price is rejected outright (filler 1 stays unpriced).
          pair({ base: filler(1), quote: USDG, priceUsd: "-3", liquidityUsd: 2_000 }),
          // Null priceUsd is skipped (filler 2 stays unpriced).
          pair({ base: filler(2), quote: USDG, priceUsd: null, liquidityUsd: 2_000 }),
        ]);
      }
      return Promise.resolve([
        // Lowercase echo of a checksummed scan address still matches on EVM.
        // `priceNative` is kept consistent with `priceUsd` (a USDG-quoted pool
        // whose base costs 0.5 USDG is worth $0.50 when USDG is $1), so this
        // pool ALSO derives USDG = 0.5 / 0.5 = 1.0 from the quote side - and
        // with 50k it is the deepest tier-0 pool USDG appears in.
        pair({ base: VEX.toLowerCase(), quote: USDG, priceUsd: "0.5", priceNative: "0.5", liquidityUsd: 50_000 }),
        // A null `liquidity` scores 0, which is below the floor, so this pool
        // is not a price source at all: VEX stays 0.5, not 77.
        pair({ base: VEX, quote: USDG, priceUsd: "77", priceNative: "77", liquidityUsd: null }),
        // CHANGED RULE: this pool's quote token is unknown, so it is tier 2 and
        // contributes NOTHING. Under the old rule its base side offered USDG a
        // 1.01 price at liquidity 0.
        pair({ base: USDG, quote: null, priceUsd: "1.01", liquidityUsd: null }),
        // Tier 0, 4k: beats the 10-liquidity VIRTUAL pool from the first batch
        // (cross-batch competition) but loses the USDG quote-side race to the
        // 50k pool above.
        pair({ base: VIRTUAL, quote: USDG, priceUsd: "2.25", liquidityUsd: 4_000 }),
      ]);
    });

    const read = await readLocalChainBalances(config, WALLET, SCAN);
    const priceOf = (address: string): number | null =>
      read.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())?.priceUsd ?? null;

    expect(read.nativePriceUsd).toBe(3000);
    expect(priceOf(WETH)).toBe(3000);
    expect(priceOf(VEX)).toBe(0.5);
    expect(priceOf(VIRTUAL)).toBe(2.25);
    // CHANGED RULE: USDG is derived from the DEEPEST tier-0 pool that quotes
    // it (the 50k VEX/USDG pool, 0.5 / 0.5 = 1.0), not from the 4k one. The old
    // rule reached 2.25 through the same quote-side derivation on a pool that
    // is no longer the deepest tier-0 candidate.
    expect(priceOf(USDG)).toBe(1);
    // The base side of the bad-`priceNative` pair still prices normally; only
    // the quote-side derivation it would have fed is discarded.
    expect(priceOf(filler(0))).toBe(5);
    expect(priceOf(filler(1))).toBe(null);
    expect(priceOf(filler(2))).toBe(null);
    expect(priceOf(filler(3))).toBe(1.5);
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(2);
    // VEX, VIRTUAL, USDG and filler(0) come from stablecoin-quoted pools.
    expect(read.priceTiers.tier0).toBe(4);
    // filler(3) is WETH-quoted, and WETH itself is the native anchor - which on
    // this fixture comes from the IMPLIED leg (no WETH/USDG pool here), so it
    // is recorded at tier 1 too.
    expect(read.priceTiers.tier1).toBe(2);
  });

  it("CHANGED RULE: a pool whose quote asset the policy does not recognise prices NOTHING", async () => {
    // The old rule priced VEX at 0.5 from this pool because it had the deepest
    // liquidity. Its quote token is unknown (null address), so its `priceUsd`
    // rests on a USD value we cannot verify - exactly the shape that priced
    // JUP at $1136 on Solana. Refusing is the fix.
    mockReadTokensPairs.mockResolvedValue([
      pair({ base: VEX, quote: null, priceUsd: "0.5", liquidityUsd: 50_000 }),
    ]);
    const read = await readLocalChainBalances(config, WALLET, [VEX]);
    expect(read.tokens[0]?.priceUsd).toBe(null);
    expect(read.priceTiers).toEqual({ tier0: 0, tier1: 0, unpriced: 1 });
  });

  it("CHANGED RULE: VIRTUAL-quoted is tier 2, so the FULL pool list rescues $VEX", async () => {
    // Live-measured 2026-08-26: robinhood's representative pool for $VEX is
    // VEX/VIRTUAL, and its full pool list carries VEX/USDG.
    mockReadTokensPairs.mockResolvedValue([
      pair({ base: VEX, quote: VIRTUAL, priceUsd: "0.002713", liquidityUsd: 280_516 }),
    ]);
    mockReadTokenPools.mockResolvedValue([
      pair({ base: VEX, quote: USDG, priceUsd: "0.002747", liquidityUsd: 69_463 }),
    ]);

    const read = await readLocalChainBalances(config, WALLET, [VEX]);
    expect(read.tokens[0]?.priceUsd).toBe(0.002747);
    expect(mockReadTokenPools).toHaveBeenCalledWith("robinhood", VEX);
    expect(read.priceTiers).toEqual({ tier0: 1, tier1: 0, unpriced: 0 });
  });

  it("a sub-floor pool is not a price source, and the re-read is still spent on it", async () => {
    // The measured shape this floor exists for: a real quote out of a book too
    // thin for the number to mean anything.
    mockReadTokensPairs.mockResolvedValue([
      pair({ base: VEX, quote: USDG, priceUsd: "1.058", liquidityUsd: 43 }),
    ]);
    const read = await readLocalChainBalances(config, WALLET, [VEX]);
    expect(read.tokens[0]?.priceUsd).toBe(null);
    expect(mockReadTokenPools).toHaveBeenCalledWith("robinhood", VEX);
  });

  it("spends the pool-list re-read ONLY on tokens still unpriced after the batch", async () => {
    mockReadTokensPairs.mockResolvedValue([
      pair({ base: USDG, quote: USDG, priceUsd: "1", liquidityUsd: 5_000 }),
      pair({ base: VEX, quote: null, priceUsd: "0.5", liquidityUsd: 50_000 }),
    ]);
    await readLocalChainBalances(config, WALLET, [USDG, VEX]);
    expect(mockReadTokenPools).toHaveBeenCalledTimes(1);
    expect(mockReadTokenPools).toHaveBeenCalledWith("robinhood", VEX);
  });

  it("keeps every token when the pool-list re-read throws (fail-soft, still unpriced)", async () => {
    mockReadTokensPairs.mockResolvedValue([
      pair({ base: VEX, quote: null, priceUsd: "0.5", liquidityUsd: 50_000 }),
    ]);
    mockReadTokenPools.mockRejectedValue(new Error("provider down"));
    const read = await readLocalChainBalances(config, WALLET, [VEX]);
    expect(read.tokens[0]?.priceUsd).toBe(null);
    expect(read.tokenFailures).toEqual([]);
  });

  it("keeps every token when a provider batch throws (fail-soft to null prices)", async () => {
    mockReadTokensPairs.mockRejectedValue(new Error("provider down"));
    const read = await readLocalChainBalances(config, WALLET, [WETH, VEX]);
    expect(read.tokens.map((token) => token.priceUsd)).toEqual([null, null]);
    expect(read.nativePriceUsd).toBe(null);
    expect(read.tokenFailures).toEqual([]);
    expect(read.priceTiers).toEqual({ tier0: 0, tier1: 0, unpriced: 2 });
  });
});

describe("the wrapped-native seed (always requested, never counted)", () => {
  it("prices the NATIVE coin for a wallet whose scan set holds no wrapped native", async () => {
    mockReadTokensPairs.mockResolvedValue([
      pair({ base: WETH, quote: USDG, priceUsd: "3000", liquidityUsd: 1_000_000 }),
      pair({ base: VEX, quote: WETH, priceNative: "0.001", priceUsd: null, liquidityUsd: 50_000 }),
    ]);

    // VEX only: under the old request set WETH was never asked for, so the
    // anchor did not exist, the native coin had no price and every WETH-quoted
    // token was unpriceable.
    const read = await readLocalChainBalances(config, WALLET, [VEX]);

    expect(read.nativePriceUsd).toBe(3000);
    expect(read.tokens[0]?.priceUsd).toBe(3);
    expect(mockReadTokensPairs).toHaveBeenCalledWith(
      "robinhood",
      expect.stringContaining(WETH.toLowerCase()),
    );
    // The seed is NOT part of the coverage census: one scanned token, priced.
    expect(read.priceTiers).toEqual({ tier0: 0, tier1: 1, unpriced: 0 });
  });

  it("prices the native coin for a wallet with NO tokens at all", async () => {
    mockReadTokensPairs.mockResolvedValue([
      pair({ base: WETH, quote: USDG, priceUsd: "3000", liquidityUsd: 1_000_000 }),
    ]);

    const read = await readLocalChainBalances(config, WALLET, []);

    expect(read.nativePriceUsd).toBe(3000);
    expect(read.tokens).toEqual([]);
    expect(read.priceTiers).toEqual({ tier0: 0, tier1: 0, unpriced: 0 });
    // One batch for the seed, and no rescue slot spent on it.
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(1);
    expect(mockReadTokenPools).not.toHaveBeenCalled();
  });

  it("never spends a pool-list rescue on the seeded wrapped native", async () => {
    // Nothing is priced, so every SCANNED address is a rescue candidate.
    mockReadTokensPairs.mockResolvedValue([]);
    await readLocalChainBalances(config, WALLET, [VEX]);
    expect(mockReadTokenPools).toHaveBeenCalledTimes(1);
    expect(mockReadTokenPools).toHaveBeenCalledWith("robinhood", VEX);
  });

  it("REFUSES pools the provider answers for another chain", async () => {
    mockReadTokensPairs.mockResolvedValue([
      { ...pair({ base: VEX, quote: USDG, priceUsd: "0.5", liquidityUsd: 50_000 }), chainId: "base" },
    ]);
    const read = await readLocalChainBalances(config, WALLET, [VEX]);
    expect(read.tokens[0]?.priceUsd).toBe(null);
    expect(read.priceTiers).toEqual({ tier0: 0, tier1: 0, unpriced: 1 });
  });
});
