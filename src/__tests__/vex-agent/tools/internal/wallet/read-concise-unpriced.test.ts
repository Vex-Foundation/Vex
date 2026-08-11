/**
 * wallet_balances concise+limit must not hide a holding just because it has no
 * price feed.
 *
 * WHY THIS FILE EXISTS - live 2026-08-10: with response_format "concise" and a
 * limit, tokens were sorted by held USD (an unpriced row scores 0) and sliced,
 * so a real balance with no DexScreener price was cut FIRST and was
 * indistinguishable from "you do not hold this token". Unpriced non-zero rows
 * are now always retained, after the priced rows, marked `priceUnavailable`.
 *
 * Mock scaffold mirrors `read.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ChainFamily } from "@tools/khalani/types.js";

const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tools/khalani/balances.js")>();
  return {
    getSelectedChainIdsForFamily: original.getSelectedChainIdsForFamily,
    parseBalanceChainSelection: async (raw: string | undefined) => {
      if (!raw) return { rawProvided: false, byFamily: new Map() };
      return { rawProvided: true, byFamily: new Map<ChainFamily, number[]>() };
    },
    getTokenBalancesAcrossChains: (...a: unknown[]) => mockScan(...a),
  };
});

vi.mock("@tools/evm-chains/resolver.js", () => ({
  resolveInclusiveEvmChain: async (input: string) => {
    if (input.trim().toLowerCase() === "robinhood") {
      return { source: "local", chainId: 4663, family: "eip155" };
    }
    throw new Error(`Unsupported chain: ${input}`);
  },
}));

const mockReadLocal = vi.fn();
vi.mock("@tools/evm-chains/balances.js", () => ({
  readLocalChainBalances: (...a: unknown[]) => mockReadLocal(...a),
}));

const mockScanSet = vi.fn();
vi.mock("@vex-agent/sync/local-chain-balance-sync.js", () => ({
  buildTokenScanSet: (...a: unknown[]) => mockScanSet(...a),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: () => "0xWALLET",
}));

const { handleWalletBalances } = await import(
  "../../../../../vex-agent/tools/internal/wallet/read.js"
);

const CONTEXT = {
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
} as never;

const ONE = 1_000000000000000000n;

/** Mirrors `MAX_UNPRICED_TOKENS_PER_SNAPSHOT` in the handler. */
const UNPRICED_CAP = 20;

/** Four priced holdings ($40/$30/$20/$10) plus two unpriced non-zero ones. */
function localRead() {
  return {
    nativeWei: 0n,
    nativePriceUsd: null,
    tokens: [
      { address: "0xa", symbol: "AAA", decimals: 18, balanceWei: ONE * 40n, priceUsd: 1 },
      { address: "0xu", symbol: "UNP", decimals: 18, balanceWei: ONE * 5n, priceUsd: null },
      { address: "0xb", symbol: "BBB", decimals: 18, balanceWei: ONE * 30n, priceUsd: 1 },
      { address: "0xc", symbol: "CCC", decimals: 18, balanceWei: ONE * 20n, priceUsd: 1 },
      { address: "0xv", symbol: "UN2", decimals: 18, balanceWei: ONE * 7n, priceUsd: null },
      { address: "0xd", symbol: "DDD", decimals: 18, balanceWei: ONE * 10n, priceUsd: 1 },
    ],
    tokenFailures: [],
  };
}

type Row = { symbol: string; priceUsd?: string; priceUnavailable?: boolean };

async function tokensFor(params: Record<string, unknown>): Promise<Row[]> {
  const res = await handleWalletBalances({ walletFamily: "eip155", chainIds: "robinhood", ...params }, CONTEXT);
  expect(res.success).toBe(true);
  const snap = (res.data as { wallets: Array<{ tokens: Row[] }> }).wallets[0]!;
  return snap.tokens;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScanSet.mockResolvedValue([]);
  mockReadLocal.mockResolvedValue(localRead());
});

describe("wallet_balances concise+limit - unpriced holdings are never silently cut", () => {
  it("retains unpriced non-zero rows beyond the limit, marked and placed last", async () => {
    const tokens = await tokensFor({ response_format: "concise", limit: 2 });

    expect(tokens.map((t) => t.symbol)).toEqual(["AAA", "BBB", "UNP", "UN2"]);
    // Priced rows keep their exact ordering and slicing.
    expect(tokens.slice(0, 2).every((t) => t.priceUnavailable === undefined)).toBe(true);
    // The marker states WHY there is no USD figure, so "no price feed" can
    // never read as "not held".
    expect(tokens[2]).toMatchObject({ symbol: "UNP", priceUnavailable: true });
    expect(tokens[3]).toMatchObject({ symbol: "UN2", priceUnavailable: true });
    expect(tokens[2]!.priceUsd).toBeUndefined();
  });

  it("treats a provider price of '0' as PRICED - a zero quote is a feed, not a missing one", async () => {
    mockReadLocal.mockResolvedValue({
      ...localRead(),
      tokens: [
        { address: "0xa", symbol: "AAA", decimals: 18, balanceWei: ONE, priceUsd: 1 },
        { address: "0x0", symbol: "ZED", decimals: 18, balanceWei: ONE, priceUsd: 0 },
        { address: "0xu", symbol: "UNP", decimals: 18, balanceWei: ONE, priceUsd: null },
      ],
    });

    const tokens = await tokensFor({ response_format: "concise", limit: 2 });
    // ZED counts against the priced limit and carries no marker; only the
    // feed-less UNP row is retained outside it.
    expect(tokens.map((t) => t.symbol)).toEqual(["AAA", "ZED", "UNP"]);
    expect(tokens[1]!.priceUnavailable).toBeUndefined();
    expect(tokens[1]!.priceUsd).toBe("0");
    expect(tokens[2]!.priceUnavailable).toBe(true);
  });

  it("drops a zero-balance unpriced row - retention is for real holdings only", async () => {
    mockReadLocal.mockResolvedValue({
      ...localRead(),
      tokens: [
        { address: "0xa", symbol: "AAA", decimals: 18, balanceWei: ONE, priceUsd: 1 },
        { address: "0xz", symbol: "ZERO", decimals: 18, balanceWei: 0n, priceUsd: null },
      ],
    });

    const tokens = await tokensFor({ response_format: "concise", limit: 1 });
    expect(tokens.map((t) => t.symbol)).toEqual(["AAA"]);
  });

  it("leaves totals untouched - the trim is a display concern", async () => {
    const res = await handleWalletBalances(
      { walletFamily: "eip155", chainIds: "robinhood", response_format: "concise", limit: 2 },
      CONTEXT,
    );
    const data = res.data as { totalUsd: number; wallets: Array<{ tokenCount: number }> };
    // 40 + 30 + 20 + 10, unpriced rows contribute nothing, and the count is off
    // the FULL scan.
    expect(data.totalUsd).toBeCloseTo(100);
    expect(data.wallets[0]!.tokenCount).toBe(6);
  });

  // The Khalani read requests EVERY holding the provider knows with no token
  // cap of its own (`tools/khalani/balances/scan.ts`), so a wallet full of
  // unpriced dust must not be able to turn concise limit:1 into unbounded
  // output. The cap here is what bounds it, not the scan set.
  it("caps retained unpriced rows on the uncapped Khalani path and says how many were dropped", async () => {
    const dust = Array.from({ length: 25 }, (_, i) => ({
      address: `0xdust${i}`,
      chainId: 8453,
      symbol: `DUST${i}`,
      name: `Dust ${i}`,
      decimals: 18,
      extensions: { balance: ONE.toString() },
    }));
    mockScan.mockResolvedValue({
      address: "0xWALLET",
      family: "eip155" as ChainFamily,
      tokens: [
        { address: "0xusdc", chainId: 8453, symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "100000000", price: { usd: "1.00" } } },
        ...dust,
      ],
      scannedChainIds: [8453],
      chainErrors: [],
      totalUsd: 100,
    });
    mockReadLocal.mockResolvedValue({ nativeWei: 0n, nativePriceUsd: null, tokens: [], tokenFailures: [] });

    const res = await handleWalletBalances({ walletFamily: "eip155", response_format: "concise", limit: 1 }, CONTEXT);
    expect(res.success).toBe(true);
    const snap = (res.data as { wallets: Array<{ tokens: Row[]; unpricedOmitted?: number; tokenCount: number }> }).wallets[0]!;

    // 1 priced row (the limit) + exactly the cap, in stable scan order.
    expect(snap.tokens).toHaveLength(1 + UNPRICED_CAP);
    expect(snap.tokens[0]!.symbol).toBe("USDC");
    expect(snap.tokens.slice(1).map((t) => t.symbol)).toEqual(
      Array.from({ length: UNPRICED_CAP }, (_, i) => `DUST${i}`),
    );
    expect(snap.tokens.slice(1).every((t) => t.priceUnavailable === true)).toBe(true);
    expect(snap.unpricedOmitted).toBe(5);
    // The full scan is still reported honestly.
    expect(snap.tokenCount).toBe(26);
  });

  it("omits the unpricedOmitted field entirely when nothing was dropped", async () => {
    const res = await handleWalletBalances(
      { walletFamily: "eip155", chainIds: "robinhood", response_format: "concise", limit: 2 },
      CONTEXT,
    );
    const snap = (res.data as { wallets: Array<Record<string, unknown>> }).wallets[0]!;
    expect("unpricedOmitted" in snap).toBe(false);
  });

  it("detailed mode (the default) returns every row untouched, unmarked", async () => {
    const detailed = await tokensFor({});
    expect(detailed.map((t) => t.symbol)).toEqual(["AAA", "UNP", "BBB", "CCC", "UN2", "DDD"]);
    expect(detailed.some((t) => t.priceUnavailable !== undefined)).toBe(false);

    const explicitDetailedWithLimit = await tokensFor({ response_format: "detailed", limit: 1 });
    expect(explicitDetailedWithLimit).toEqual(detailed);
  });

  it("concise WITHOUT a limit still returns every row untouched", async () => {
    const tokens = await tokensFor({ response_format: "concise" });
    expect(tokens.map((t) => t.symbol)).toEqual(["AAA", "UNP", "BBB", "CCC", "UN2", "DDD"]);
    expect(tokens.some((t) => t.priceUnavailable !== undefined)).toBe(false);
  });
});
