/**
 * The DexScreener price fallback for Khalani balance rows.
 *
 * MEASURED 2026-08-26 11:25Z: Khalani's balance scan stopped populating
 * `extensions.price.usd`, and the owner's portfolio dropped $23.71 with the
 * balances themselves unchanged. These cases pin the four outcomes that matter
 * on a money display:
 *
 *  1. a price-less row on a covered chain gets a tiered DexScreener price;
 *  2. a row Khalani DID price is never touched, byte for byte;
 *  3. a provider failure leaves rows exactly as Khalani sent them;
 *  4. a chain with no policy entry gets no fallback and no request.
 *
 * The provider bytes come from `fixtures/dexscreener/` (verbatim live captures)
 * and go through the REAL validator, so what the projection sees is what the
 * provider actually sends.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockReadTokensPairs = vi.fn();
const mockReadTokenPools = vi.fn();
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
  readTokenPools: (...args: unknown[]) => mockReadTokenPools(...args),
}));

const { fillMissingKhalaniPrices, computeBalanceUsd } = await import(
  "@vex-agent/sync/khalani-price-fallback.js"
);
const { validateTokensResponse } = await import("@tools/dexscreener/validation/pairs.js");
const { UNPRICED_POOL_FALLBACK_MAX_ADDRESSES } = await import(
  "@tools/dexscreener/unpriced-pool-fallback.js"
);
type BalanceRow = import("@vex-agent/db/repos/balances.js").BalanceRow;

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../fixtures/dexscreener/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}
const baseWethPairs = validateTokensResponse(fixture("tokens-v1-base-weth.json"));

const BASE_CHAIN_ID = 8453;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
/** The EIP-7528-style sentinel Khalani reports for a native ETH row. */
const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

function row(fields: Partial<BalanceRow> & { tokenAddress: string }): BalanceRow {
  return {
    walletFamily: "eip155",
    walletAddress: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
    chainId: BASE_CHAIN_ID,
    tokenSymbol: "TKN",
    tokenName: "Token",
    balanceRaw: "1000000000000000000",
    balanceUsd: null,
    priceUsd: null,
    decimals: 18,
    ...fields,
  } as BalanceRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the pool-list rescue finds nothing extra. Cases that exercise it
  // override this.
  mockReadTokenPools.mockResolvedValue([]);
});

describe("fillMissingKhalaniPrices", () => {
  it("prices a price-less ETH and USDC row on base through the tier rule", async () => {
    // One USDC/USDbC pool (tier 0, $1.00014) plus the live WETH/USDC capture.
    mockReadTokensPairs.mockResolvedValue([
      ...baseWethPairs,
      ...validateTokensResponse([
        {
          chainId: "base",
          dexId: "test",
          url: "https://dexscreener.com/base/test",
          pairAddress: "0xusdcpool",
          baseToken: { address: BASE_USDC, name: "USD Coin", symbol: "USDC" },
          quoteToken: { address: BASE_WETH, name: "Wrapped Ether", symbol: "WETH" },
          priceUsd: "1.00014",
          priceNative: "0.000404",
          liquidity: { usd: 500_000, base: 0, quote: 0 },
        },
      ]),
    ]);

    const byChain = new Map<number, BalanceRow[]>([
      [
        BASE_CHAIN_ID,
        [
          // 0.00716 ETH, the owner's live base balance shape.
          row({ tokenAddress: NATIVE_SENTINEL, tokenSymbol: "ETH", balanceRaw: "7160000000000000" }),
          row({ tokenAddress: BASE_USDC, tokenSymbol: "USDC", decimals: 6, balanceRaw: "400000" }),
        ],
      ],
    ]);

    await fillMissingKhalaniPrices(byChain);
    const filled = byChain.get(BASE_CHAIN_ID) ?? [];

    // Native has no pair of its own: it is priced as the wrapped native.
    expect(filled[0]?.priceUsd).toBeCloseTo(2472.15, 2);
    expect(filled[0]?.balanceUsd).toBeCloseTo(0.00716 * 2472.15, 4);
    // USDC wins from the QUOTE side of the live tier-0 WETH/USDC pool
    // (2472.15 / 2472.1507 = $0.9999997), which outranks the tier-1
    // USDC/WETH pool below it. Both routes agree to four decimals, which is
    // the point: a stablecoin that prices to $1 is the rule working.
    expect(filled[1]?.priceUsd).toBeCloseTo(1, 4);
    expect(filled[1]?.balanceUsd).toBeCloseTo(0.4, 4);
    // One batched request for the chain, and it asked for the WRAPPED native.
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(1);
    expect(mockReadTokensPairs).toHaveBeenCalledWith("base", expect.stringContaining(BASE_WETH));
  });

  it("NEVER overwrites a price Khalani supplied", async () => {
    mockReadTokensPairs.mockResolvedValue(baseWethPairs);
    const priced = row({
      tokenAddress: BASE_WETH,
      priceUsd: 1234.5,
      balanceUsd: 1234.5,
    });
    const byChain = new Map<number, BalanceRow[]>([[BASE_CHAIN_ID, [priced]]]);

    await fillMissingKhalaniPrices(byChain);

    // Same object, same numbers: Khalani owns the balance and its own price.
    expect(byChain.get(BASE_CHAIN_ID)?.[0]).toEqual(priced);
    expect(mockReadTokensPairs).not.toHaveBeenCalled();
  });

  it("keeps rows unpriced and intact when the provider throws (fail-soft)", async () => {
    mockReadTokensPairs.mockRejectedValue(new Error("provider down"));
    const original = row({ tokenAddress: BASE_USDC, decimals: 6, balanceRaw: "400000" });
    const byChain = new Map<number, BalanceRow[]>([[BASE_CHAIN_ID, [original]]]);

    await fillMissingKhalaniPrices(byChain);

    expect(byChain.get(BASE_CHAIN_ID)).toEqual([original]);
    expect(byChain.get(BASE_CHAIN_ID)?.[0]?.priceUsd).toBe(null);
  });

  it("makes NO request for a chain the policy table does not cover", async () => {
    const unknownChain = 999_999;
    const original = row({ chainId: unknownChain, tokenAddress: BASE_USDC });
    const byChain = new Map<number, BalanceRow[]>([[unknownChain, [original]]]);

    await fillMissingKhalaniPrices(byChain);

    expect(mockReadTokensPairs).not.toHaveBeenCalled();
    expect(byChain.get(unknownChain)).toEqual([original]);
  });

  it("leaves a row unpriced when the chain has pools but none in a usable tier", async () => {
    mockReadTokensPairs.mockResolvedValue(
      validateTokensResponse([
        {
          chainId: "base",
          dexId: "test",
          url: "https://dexscreener.com/base/test",
          pairAddress: "0xjunk",
          baseToken: { address: BASE_USDC, name: "USD Coin", symbol: "USDC" },
          // An unknown quote asset: tier 2, prices nothing, however deep.
          quoteToken: { address: "0xdeadbeef", name: "MYSTERY", symbol: "MYS" },
          priceUsd: "999999",
          priceNative: "1",
          liquidity: { usd: 900_000_000, base: 0, quote: 0 },
        },
      ]),
    );
    const byChain = new Map<number, BalanceRow[]>([
      [BASE_CHAIN_ID, [row({ tokenAddress: BASE_USDC, decimals: 6, balanceRaw: "400000" })]],
    ]);

    await fillMissingKhalaniPrices(byChain);

    expect(byChain.get(BASE_CHAIN_ID)?.[0]?.priceUsd).toBe(null);
  });
});

/**
 * The two lanes that price a token must not disagree about it.
 *
 * This lane and the per-chain wallet readers are two paths to ONE number on a
 * money display. Both now seed the chain's wrapped native into the request
 * (the tier-1 anchor is useless if it is one address away in a request that is
 * issued anyway) and both spend the same bounded pool-list rescue on a token
 * whose representative pool is tier 2. Neither the seed nor the rescue may
 * inflate what the census counts.
 */
describe("seeding and rescue parity with the wallet readers", () => {
  const TIER2_TOKEN = "0x00000000000000000000000000000000000000aa";
  const MYSTERY = "0x00000000000000000000000000000000000000bb";

  function basePair(fields: {
    base: string;
    quote: string;
    priceUsd: string;
    priceNative?: string;
    liquidityUsd: number;
  }): unknown {
    return {
      chainId: "base",
      dexId: "test",
      url: "https://dexscreener.com/base/test",
      pairAddress: `0xpair-${fields.base}-${fields.quote}`,
      baseToken: { address: fields.base, name: "b", symbol: "B" },
      quoteToken: { address: fields.quote, name: "q", symbol: "Q" },
      priceUsd: fields.priceUsd,
      priceNative: fields.priceNative ?? "1",
      liquidity: { usd: fields.liquidityUsd, base: 0, quote: 0 },
    };
  }

  it("seeds the WRAPPED NATIVE even when no row needs a native price", async () => {
    // A wallet holding one WETH-quoted token and no ETH: without the seed the
    // anchor is unreachable and a tier-1 token cannot be valued at all.
    mockReadTokensPairs.mockImplementation((_slug: string, addresses: string) =>
      Promise.resolve(
        validateTokensResponse([
          ...(addresses.toLowerCase().includes(BASE_WETH.toLowerCase()) ? baseWethPairs : []),
          basePair({ base: TIER2_TOKEN, quote: BASE_WETH, priceUsd: "1", priceNative: "0.002", liquidityUsd: 500_000 }),
        ]),
      ),
    );

    const byChain = new Map<number, BalanceRow[]>([
      [BASE_CHAIN_ID, [row({ tokenAddress: TIER2_TOKEN, tokenSymbol: "TK1" })]],
    ]);
    await fillMissingKhalaniPrices(byChain);

    // priceNative 0.002 x the live WETH anchor 2472.15 = $4.94.
    expect(byChain.get(BASE_CHAIN_ID)?.[0]?.priceUsd).toBeCloseTo(0.002 * 2472.15, 4);
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(1);
    expect(mockReadTokensPairs).toHaveBeenCalledWith("base", expect.stringContaining(BASE_WETH.toLowerCase()));
  });

  it("the wrapped-native seed consumes no ROW slot and no RESCUE slot", async () => {
    // Nothing is priced at all, so every row address is a rescue candidate -
    // and the seeded wrapped native must not be one of them.
    mockReadTokensPairs.mockResolvedValue([]);
    const byChain = new Map<number, BalanceRow[]>([
      [BASE_CHAIN_ID, [row({ tokenAddress: TIER2_TOKEN, tokenSymbol: "TK1" })]],
    ]);
    await fillMissingKhalaniPrices(byChain);

    expect(mockReadTokenPools).toHaveBeenCalledTimes(1);
    expect(mockReadTokenPools).toHaveBeenCalledWith("base", TIER2_TOKEN);
    // One row in, one row out, still unpriced: the seed is not a row.
    expect(byChain.get(BASE_CHAIN_ID)).toHaveLength(1);
    expect(byChain.get(BASE_CHAIN_ID)?.[0]?.priceUsd).toBe(null);
  });

  it("rescues a tier-2-representative token from its FULL pool list, like the wallet readers", async () => {
    // The measured $VEX / JUP shape: the provider's representative pool is the
    // one the quote rule refuses, and the pool list carries a tier-0 one.
    mockReadTokensPairs.mockResolvedValue(
      validateTokensResponse([
        basePair({ base: TIER2_TOKEN, quote: MYSTERY, priceUsd: "0.002713", liquidityUsd: 280_516 }),
      ]),
    );
    mockReadTokenPools.mockResolvedValue(
      validateTokensResponse([
        basePair({ base: TIER2_TOKEN, quote: BASE_USDC.toLowerCase(), priceUsd: "0.002747", liquidityUsd: 69_463 }),
      ]),
    );

    const byChain = new Map<number, BalanceRow[]>([
      [BASE_CHAIN_ID, [row({ tokenAddress: TIER2_TOKEN, tokenSymbol: "TK1" })]],
    ]);
    await fillMissingKhalaniPrices(byChain);

    // The SAME number the wallet reader reaches from the same bytes, which is
    // the point of the parity: one token, one price, whichever lane read it.
    expect(byChain.get(BASE_CHAIN_ID)?.[0]?.priceUsd).toBe(0.002747);
    expect(mockReadTokenPools).toHaveBeenCalledWith("base", TIER2_TOKEN);
  });

  it("spends at most the shared cap on rescues and leaves the rest unpriced", async () => {
    mockReadTokensPairs.mockResolvedValue([]);
    const many = Array.from(
      { length: UNPRICED_POOL_FALLBACK_MAX_ADDRESSES + 5 },
      (_unused, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );
    const byChain = new Map<number, BalanceRow[]>([
      [BASE_CHAIN_ID, many.map((address) => row({ tokenAddress: address }))],
    ]);
    await fillMissingKhalaniPrices(byChain);

    expect(mockReadTokenPools).toHaveBeenCalledTimes(UNPRICED_POOL_FALLBACK_MAX_ADDRESSES);
    expect(byChain.get(BASE_CHAIN_ID)?.every((balanceRow) => balanceRow.priceUsd === null)).toBe(true);
  });

  it("stays fail-soft when the rescue read throws", async () => {
    mockReadTokensPairs.mockResolvedValue([]);
    mockReadTokenPools.mockRejectedValue(new Error("provider down"));
    const original = row({ tokenAddress: TIER2_TOKEN });
    const byChain = new Map<number, BalanceRow[]>([[BASE_CHAIN_ID, [original]]]);

    await fillMissingKhalaniPrices(byChain);

    expect(byChain.get(BASE_CHAIN_ID)).toEqual([original]);
  });

  it("refuses provider rows carrying another chain's pools", async () => {
    mockReadTokensPairs.mockResolvedValue(
      validateTokensResponse([
        {
          ...(basePair({ base: TIER2_TOKEN, quote: BASE_USDC.toLowerCase(), priceUsd: "9999", liquidityUsd: 5_000_000 }) as Record<string, unknown>),
          chainId: "arbitrum",
        },
      ]),
    );
    const byChain = new Map<number, BalanceRow[]>([
      [BASE_CHAIN_ID, [row({ tokenAddress: TIER2_TOKEN })]],
    ]);
    await fillMissingKhalaniPrices(byChain);

    expect(byChain.get(BASE_CHAIN_ID)?.[0]?.priceUsd).toBe(null);
  });
});

describe("computeBalanceUsd", () => {
  it("returns null rather than a guessed value when decimals are unknown", () => {
    expect(computeBalanceUsd("1000000000000000000", null, 5)).toBe(null);
  });

  it("returns null for a zero balance and for a missing price", () => {
    expect(computeBalanceUsd("0", 18, 5)).toBe(null);
    expect(computeBalanceUsd("1000000000000000000", 18, null)).toBe(null);
  });

  it("returns null rather than throwing on an unparseable raw amount", () => {
    expect(computeBalanceUsd("not-an-integer", 18, 5)).toBe(null);
  });

  it("converts a raw amount at its decimals", () => {
    expect(computeBalanceUsd("400000", 6, 1.00014)).toBeCloseTo(0.400056, 6);
  });
});
