/**
 * CHARACTERIZATION of the local-EVM DexScreener price selection, captured
 * BEFORE the best-liquidity comparator was extracted into
 * `tools/dexscreener/best-liquidity-price.ts` and re-run after, unchanged.
 *
 * It pins the observable output of `readLocalChainBalances` - the exact price
 * attached to every token and to the native coin - across the axes the
 * extraction could plausibly move: base-side vs quote-side matching, the
 * deepest-pool tie-break, competition ACROSS request batches (the accumulator
 * is stateful for this reason), a null `liquidity`, an unparseable
 * `priceNative`, a negative price, and an address whose case differs from the
 * checksummed scan address.
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
vi.mock("@tools/dexscreener/price-read.js", () => ({
  readTokensPairs: (...args: unknown[]) => mockReadTokensPairs(...args),
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

function pair(fields: {
  base: string;
  quote?: string | null;
  priceUsd: string | null;
  priceNative?: string;
  liquidityUsd?: number | null;
}): Record<string, unknown> {
  return {
    chainId: "robinhood",
    baseToken: { address: fields.base, name: "b", symbol: "B" },
    quoteToken: { address: fields.quote ?? null, name: null, symbol: null },
    priceUsd: fields.priceUsd,
    priceNative: fields.priceNative ?? "1",
    liquidity: fields.liquidityUsd === undefined ? null : { usd: fields.liquidityUsd, base: 0, quote: 0 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  it("pins base/quote matching, the deepest-pool tie-break and cross-batch competition", async () => {
    mockReadTokensPairs.mockImplementation((_slug: string, addresses: string) => {
      const isFirstBatch = addresses.toLowerCase().includes(WETH.toLowerCase());
      if (isFirstBatch) {
        return Promise.resolve([
          // WETH is priced from the QUOTE side: 1.5 / 0.0005 = 3000.
          pair({ base: filler(3), quote: WETH, priceUsd: "1.5", priceNative: "0.0005", liquidityUsd: 1_000_000 }),
          // VIRTUAL, base side, SHALLOWER than the second-batch pool below:
          // proves a later batch can win, i.e. the accumulator is not per-batch.
          pair({ base: VIRTUAL, quote: USDG, priceUsd: "9.99", liquidityUsd: 10 }),
          // Unparseable priceNative: the quote side contributes nothing, so USDG
          // stays priced by its own base-side pool in the second batch.
          pair({ base: filler(0), quote: USDG, priceUsd: "5", priceNative: "not-a-number", liquidityUsd: 9_000_000 }),
          // Negative price is rejected outright (filler 1 stays unpriced).
          pair({ base: filler(1), priceUsd: "-3", liquidityUsd: 500 }),
          // Null priceUsd is skipped (filler 2 stays unpriced).
          pair({ base: filler(2), priceUsd: null, liquidityUsd: 500 }),
        ]);
      }
      return Promise.resolve([
        // Lowercase echo of a checksummed scan address still matches on EVM.
        pair({ base: VEX.toLowerCase(), priceUsd: "0.5", liquidityUsd: 50_000 }),
        // A null `liquidity` scores 0 and loses to any positive pool ...
        pair({ base: VEX, priceUsd: "77", liquidityUsd: null }),
        // ... including here, where USDG's own base-side pool scores 0 and is
        // beaten by USDG's quote-side match on the 4k pool below (2.25 / 1),
        // which in turn beat the 10-liquidity quote match from the first batch.
        pair({ base: USDG, priceUsd: "1.01", liquidityUsd: null }),
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
    expect(priceOf(USDG)).toBe(2.25);
    // The base side of the bad-`priceNative` pair still prices normally; only
    // the quote-side derivation it would have fed is discarded.
    expect(priceOf(filler(0))).toBe(5);
    expect(priceOf(filler(1))).toBe(null);
    expect(priceOf(filler(2))).toBe(null);
    expect(priceOf(filler(3))).toBe(1.5);
    expect(mockReadTokensPairs).toHaveBeenCalledTimes(2);
  });

  it("keeps every token when a provider batch throws (fail-soft to null prices)", async () => {
    mockReadTokensPairs.mockRejectedValue(new Error("provider down"));
    const read = await readLocalChainBalances(config, WALLET, [WETH, VEX]);
    expect(read.tokens.map((token) => token.priceUsd)).toEqual([null, null]);
    expect(read.nativePriceUsd).toBe(null);
    expect(read.tokenFailures).toEqual([]);
  });
});
