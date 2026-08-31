/**
 * DexScreener price enrichment for Khalani balance rows.
 *
 * MEASURED 2026-08-26 11:25Z: Khalani's balance scan stopped populating
 * `extensions.price.usd`, and the owner's portfolio dropped $23.71 with the
 * balances themselves unchanged. These cases pin the outcomes that matter on a
 * money display:
 *
 *  1. a price-less row on a covered chain gets a tiered DexScreener price;
 *  2. a row Khalani DID price is never touched, byte for byte;
 *  3. a provider failure leaves rows exactly as Khalani sent them;
 *  4. a chain with no policy entry gets no enrichment and no request;
 *  5. an operator Stop PROPAGATES instead of being reported as "unpriced".
 *
 * MIGRATED 2026-08-31 from `vex-agent/sync/khalani-price-fallback.test.ts`
 * together with the code it characterizes. Every scenario of that suite is
 * reproduced here over the PROVIDER's own row type (`KhalaniToken`) rather than
 * the persisted `BalanceRow`, which is the whole point of the move: the live
 * wallet read now runs the same pass the sync always did. The per-row USD
 * arithmetic that suite also covered stayed with its owner, the sync mapper,
 * and is asserted in `vex-agent/sync/balance-sync.test.ts`.
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

const { enrichKhalaniBalancePrices } = await import(
  "@tools/khalani/balance-price-enrichment.js"
);
const { validateTokensResponse } = await import("@tools/dexscreener/validation/pairs.js");
const { UNPRICED_POOL_FALLBACK_MAX_ADDRESSES } = await import(
  "@tools/dexscreener/unpriced-pool-fallback.js"
);
type KhalaniToken = import("@tools/khalani/types.js").KhalaniToken;

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

function token(fields: {
  address: string;
  chainId?: number;
  symbol?: string;
  decimals?: number;
  balanceRaw?: string;
  priceUsd?: string;
}): KhalaniToken {
  return {
    address: fields.address,
    chainId: fields.chainId ?? BASE_CHAIN_ID,
    name: "Token",
    symbol: fields.symbol ?? "TKN",
    decimals: fields.decimals ?? 18,
    extensions: {
      balance: fields.balanceRaw ?? "1000000000000000000",
      ...(fields.priceUsd === undefined ? {} : { price: { usd: fields.priceUsd } }),
    },
  };
}

/** The final USD price of one enriched row, as a number, or null. */
function priceOf(row: { token: KhalaniToken } | undefined): number | null {
  const raw = row?.token.extensions?.price?.usd;
  return typeof raw === "string" ? Number(raw) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the pool-list rescue finds nothing extra. Cases that exercise it
  // override this.
  mockReadTokenPools.mockResolvedValue([]);
});

describe("enrichKhalaniBalancePrices", () => {
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

    const result = await enrichKhalaniBalancePrices([
      // 0.00716 ETH, the owner's live base balance shape.
      token({ address: NATIVE_SENTINEL, symbol: "ETH", balanceRaw: "7160000000000000" }),
      token({ address: BASE_USDC, symbol: "USDC", decimals: 6, balanceRaw: "400000" }),
    ]);

    // Native has no pair of its own: it is priced as the wrapped native.
    expect(priceOf(result.rows[0])).toBeCloseTo(2472.15, 2);
    // USDC wins from the QUOTE side of the live tier-0 WETH/USDC pool
    // (2472.15 / 2472.1507 = $0.9999997), which outranks the tier-1
    // USDC/WETH pool below it. Both routes agree to four decimals, which is
    // the point: a stablecoin that prices to $1 is the rule working.
    expect(priceOf(result.rows[1])).toBeCloseTo(1, 4);
    expect(result.rows.map((row) => row.priceSource)).toEqual(["dexscreener", "dexscreener"]);
    expect(result.counts).toEqual([
      { chainId: BASE_CHAIN_ID, khalaniPriced: 0, dexscreenerPriced: 2, unpriced: 0 },
    ]);
    // One batched request for the chain, and it asked for the WRAPPED native.
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(1);
    expect(mockReadTokensPairs).toHaveBeenCalledWith("base", expect.stringContaining(BASE_WETH));
  });

  it("NEVER overwrites a price Khalani supplied", async () => {
    mockReadTokensPairs.mockResolvedValue(baseWethPairs);
    const priced = token({ address: BASE_WETH, priceUsd: "1234.5" });

    const result = await enrichKhalaniBalancePrices([priced]);

    // The SAME object, not a clone: Khalani owns the balance and its own price.
    expect(result.rows[0]?.token).toBe(priced);
    expect(result.rows[0]?.priceSource).toBe("khalani");
    expect(result.counts).toEqual([
      { chainId: BASE_CHAIN_ID, khalaniPriced: 1, dexscreenerPriced: 0, unpriced: 0 },
    ]);
    expect(mockReadTokensPairs).not.toHaveBeenCalled();
  });

  it("keeps rows unpriced and intact when the provider throws (fail-soft)", async () => {
    mockReadTokensPairs.mockRejectedValue(new Error("provider down"));
    const original = token({ address: BASE_USDC, decimals: 6, balanceRaw: "400000" });

    const result = await enrichKhalaniBalancePrices([original]);

    expect(result.rows[0]?.token).toBe(original);
    expect(result.rows[0]?.priceSource).toBe(null);
    expect(priceOf(result.rows[0])).toBe(null);
  });

  it("makes NO request for a chain the policy table does not cover", async () => {
    const unknownChain = 999_999;
    const original = token({ chainId: unknownChain, address: BASE_USDC });

    const result = await enrichKhalaniBalancePrices([original]);

    expect(mockReadTokensPairs).not.toHaveBeenCalled();
    expect(result.rows[0]?.token).toBe(original);
    expect(result.rows[0]?.priceSource).toBe(null);
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

    const result = await enrichKhalaniBalancePrices([
      token({ address: BASE_USDC, decimals: 6, balanceRaw: "400000" }),
    ]);

    expect(priceOf(result.rows[0])).toBe(null);
    expect(result.rows[0]?.priceSource).toBe(null);
  });

  it("returns one row per input token, in the input order, across chains", async () => {
    mockReadTokensPairs.mockResolvedValue([]);
    const input = [
      token({ address: BASE_USDC, symbol: "USDC" }),
      token({ address: BASE_WETH, chainId: 42_161, symbol: "ARB-WETH" }),
      token({ address: NATIVE_SENTINEL, symbol: "ETH" }),
    ];

    const result = await enrichKhalaniBalancePrices(input);

    expect(result.rows.map((row) => row.token.symbol)).toEqual(["USDC", "ARB-WETH", "ETH"]);
    // Chains in first-appearance order, one census entry each.
    expect(result.counts.map((entry) => entry.chainId)).toEqual([BASE_CHAIN_ID, 42_161]);
  });

  it("treats an unreadable Khalani price as absent rather than as a value", async () => {
    // A blank or unparseable price is what the projection boundary already
    // calls "no price" (`priceUnavailable`), so this pass must be allowed to
    // fill it - the alternative is a holding that no lane can ever value.
    mockReadTokensPairs.mockResolvedValue(baseWethPairs);

    const result = await enrichKhalaniBalancePrices([
      token({ address: BASE_WETH, priceUsd: "   " }),
      token({ address: NATIVE_SENTINEL, priceUsd: "not-a-number" }),
    ]);

    expect(priceOf(result.rows[0])).toBeCloseTo(2472.15, 2);
    expect(priceOf(result.rows[1])).toBeCloseTo(2472.15, 2);
    expect(result.rows.map((row) => row.priceSource)).toEqual(["dexscreener", "dexscreener"]);
  });
});

/**
 * A Stop is the OPERATOR's outcome, never a valuation result.
 *
 * Converting a cancellation into "these rows have no price" would report a
 * wrong number as a measurement, and would keep spending the provider budget on
 * the chains after it.
 */
describe("cancellation", () => {
  it("propagates the signal's reason instead of reporting rows unpriced", async () => {
    const controller = new AbortController();
    mockReadTokensPairs.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("aborted transport"));
    });

    await expect(
      enrichKhalaniBalancePrices([token({ address: BASE_USDC })], { signal: controller.signal }),
    ).rejects.toBeDefined();
  });

  it("issues no request at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      enrichKhalaniBalancePrices([token({ address: BASE_USDC })], { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(mockReadTokensPairs).not.toHaveBeenCalled();
  });

  it("passes the signal to the provider read", async () => {
    const controller = new AbortController();
    mockReadTokensPairs.mockResolvedValue([]);

    await enrichKhalaniBalancePrices([token({ address: BASE_USDC })], { signal: controller.signal });

    expect(mockReadTokensPairs).toHaveBeenCalledWith("base", expect.any(String), {
      signal: controller.signal,
    });
  });
});

/**
 * The two lanes that price a token must not disagree about it.
 *
 * This pass and the per-chain wallet readers are two paths to ONE number on a
 * money display. Both seed the chain's wrapped native into the request (the
 * tier-1 anchor is useless if it is one address away in a request that is
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

    const result = await enrichKhalaniBalancePrices([token({ address: TIER2_TOKEN, symbol: "TK1" })]);

    // priceNative 0.002 x the live WETH anchor 2472.15 = $4.94.
    expect(priceOf(result.rows[0])).toBeCloseTo(0.002 * 2472.15, 4);
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(1);
    expect(mockReadTokensPairs).toHaveBeenCalledWith("base", expect.stringContaining(BASE_WETH.toLowerCase()));
  });

  it("the wrapped-native seed consumes no ROW slot and no RESCUE slot", async () => {
    // Nothing is priced at all, so every row address is a rescue candidate -
    // and the seeded wrapped native must not be one of them.
    mockReadTokensPairs.mockResolvedValue([]);

    const result = await enrichKhalaniBalancePrices([token({ address: TIER2_TOKEN, symbol: "TK1" })]);

    expect(mockReadTokenPools).toHaveBeenCalledTimes(1);
    expect(mockReadTokenPools).toHaveBeenCalledWith("base", TIER2_TOKEN);
    // One row in, one row out, still unpriced: the seed is not a row.
    expect(result.rows).toHaveLength(1);
    expect(priceOf(result.rows[0])).toBe(null);
    expect(result.counts).toEqual([
      { chainId: BASE_CHAIN_ID, khalaniPriced: 0, dexscreenerPriced: 0, unpriced: 1 },
    ]);
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

    const result = await enrichKhalaniBalancePrices([token({ address: TIER2_TOKEN, symbol: "TK1" })]);

    // The SAME number the wallet reader reaches from the same bytes, which is
    // the point of the parity: one token, one price, whichever lane read it.
    expect(priceOf(result.rows[0])).toBe(0.002747);
    expect(mockReadTokenPools).toHaveBeenCalledWith("base", TIER2_TOKEN);
  });

  it("spends at most the shared cap on rescues and leaves the rest unpriced", async () => {
    mockReadTokensPairs.mockResolvedValue([]);
    const many = Array.from(
      { length: UNPRICED_POOL_FALLBACK_MAX_ADDRESSES + 5 },
      (_unused, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );

    const result = await enrichKhalaniBalancePrices(many.map((address) => token({ address })));

    expect(mockReadTokenPools).toHaveBeenCalledTimes(UNPRICED_POOL_FALLBACK_MAX_ADDRESSES);
    expect(result.rows.every((row) => priceOf(row) === null)).toBe(true);
  });

  it("stays fail-soft when the rescue read throws", async () => {
    mockReadTokensPairs.mockResolvedValue([]);
    mockReadTokenPools.mockRejectedValue(new Error("provider down"));
    const original = token({ address: TIER2_TOKEN });

    const result = await enrichKhalaniBalancePrices([original]);

    expect(result.rows[0]?.token).toBe(original);
    expect(result.rows[0]?.priceSource).toBe(null);
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

    const result = await enrichKhalaniBalancePrices([token({ address: TIER2_TOKEN })]);

    expect(priceOf(result.rows[0])).toBe(null);
  });
});

/**
 * The batching bound, stated rather than implied: 30 addresses per request is
 * the provider's own cap for `tokens/v1`, and nothing is dropped for being past
 * it - the addresses simply travel in the next request.
 */
describe("request bounds", () => {
  it("splits more than 30 addresses into sequential batches and asks for all of them", async () => {
    mockReadTokensPairs.mockResolvedValue([]);
    const addresses = Array.from(
      { length: 31 },
      (_unused, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`,
    );

    await enrichKhalaniBalancePrices(addresses.map((address) => token({ address })));

    // 31 row addresses plus the wrapped-native seed = 32 -> two batches.
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(2);
    const asked = mockReadTokensPairs.mock.calls
      .map((call) => String(call[1]))
      .join(",")
      .toLowerCase();
    for (const address of addresses) expect(asked).toContain(address.toLowerCase());
    expect(asked).toContain(BASE_WETH.toLowerCase());
  });
});
