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
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
  readTokenPools: vi.fn(),
}));

const { fillMissingKhalaniPrices, computeBalanceUsd } = await import(
  "@vex-agent/sync/khalani-price-fallback.js"
);
const { validateTokensResponse } = await import("@tools/dexscreener/validation/pairs.js");
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
