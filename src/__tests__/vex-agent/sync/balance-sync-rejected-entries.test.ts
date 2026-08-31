/**
 * What a REFUSED wallet-balance entry costs the durable rows.
 *
 * The Khalani boundary now refuses an entry whose `decimals` are unusable and
 * reports it instead of failing the chain. The sync path writes `proj_balances`
 * with a DESTRUCTIVE per-chain replace, so it has to answer two questions the
 * boundary deliberately leaves open:
 *
 * - a refusal WITH an exact atomic amount is still a holding: it is retained
 *   with `decimals: null` and `balanceUsd: null`, because the wallet does hold
 *   it and no price can be computed without a scale. The bad scale is never
 *   stored and never guessed as 18 (frozen contract C1.2);
 * - a refusal WITHOUT an exact amount means the chain's inventory cannot be
 *   reconstructed, so the destructive replace for THAT chain is off and the
 *   last-good rows (and their timestamps) survive untouched (C3.5).
 *
 * Neighbouring chains in the same scan are unaffected in both cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListWallets = vi.fn();
vi.mock("@tools/wallet/inventory.js", () => ({
  listWallets: (family: string) => mockListWallets(family),
}));

const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: (...args: unknown[]) => mockScan(...args),
}));

const mockGetCachedKhalaniChains = vi.fn();
const mockResolveChainId = vi.fn();
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: () => mockGetCachedKhalaniChains(),
  resolveChainId: (...a: unknown[]) => mockResolveChainId(...a),
}));

vi.mock("../../../vex-agent/sync/local-chain-balance-sync.js", () => ({
  syncLocalChainForWallet: vi.fn().mockResolvedValue({ chainId: 4663, tokensUpdated: 0, skipped: true }),
}));

vi.mock("../../../vex-agent/sync/pendle-enrichment.js", () => ({
  enrichPendleBalances: (_f: string, _a: string, _c: number, rows: unknown) => rows,
  seedPendleChainBalances: (_f: string, _a: string, chainId: number) => ({
    chainId,
    tokensUpdated: 0,
    skipped: true,
  }),
}));

// The price fallback is its own suite and would otherwise reach the network.
// `computeBalanceUsd` stays REAL, because the USD arithmetic of a salvaged row
// is part of what is under test here.
vi.mock("../../../vex-agent/sync/khalani-price-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../vex-agent/sync/khalani-price-fallback.js")>();
  return { ...actual, fillMissingKhalaniPrices: vi.fn().mockResolvedValue(undefined) };
});

const mockReplaceBalances = vi.fn().mockResolvedValue(0);
const mockGetBalances = vi.fn().mockResolvedValue([]);
const mockGetBalancesByChain = vi.fn().mockResolvedValue([]);

vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: (...a: unknown[]) => mockReplaceBalances(...a),
  getBalances: (...a: unknown[]) => mockGetBalances(...a),
  getBalancesByChain: (...a: unknown[]) => mockGetBalancesByChain(...a),
  insertSnapshot: vi.fn(),
  getLatestSnapshot: vi.fn().mockResolvedValue(null),
  getSnapshotHistory: vi.fn().mockResolvedValue([]),
}));

const { syncWalletBalances } = await import("../../../vex-agent/sync/balance-sync.js");

const EVM_A = "0xAAAaaa";

interface ReplacedRow {
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  balanceRaw: string;
  balanceUsd: number | null;
  priceUsd: number | null;
  decimals: number | null;
}

/** Rows the sync actually asked the repo to write, by chain. */
function replacedRowsByChain(): Map<number, ReplacedRow[]> {
  const byChain = new Map<number, ReplacedRow[]>();
  for (const call of mockReplaceBalances.mock.calls) {
    byChain.set(call[1] as number, call[2] as ReplacedRow[]);
  }
  return byChain;
}

function validToken(chainId: number, address: string) {
  return {
    chainId,
    address,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    extensions: { balance: "1000000", price: { usd: "1.0" } },
  };
}

function rejection(overrides: Record<string, unknown>) {
  return {
    entryIndex: 1,
    chainId: 1,
    address: "0xGIFT",
    name: "Airdropped Gift",
    symbol: "GIFT",
    balanceRaw: "424242",
    reason: "token_decimals_invalid" as const,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedKhalaniChains.mockResolvedValue([
    { id: 1, name: "Ethereum", type: "eip155" },
    { id: 8453, name: "Base", type: "eip155" },
  ]);
  mockResolveChainId.mockImplementation(() => {
    throw new Error("unsupported");
  });
  mockGetBalances.mockResolvedValue([]);
  mockGetBalancesByChain.mockResolvedValue([]);
  mockListWallets.mockImplementation((family: string) =>
    family === "solana" ? [] : [{ id: "evm_1", address: EVM_A, label: "EVM 1", createdAt: "" }],
  );
  mockReplaceBalances.mockResolvedValue(0);
});

describe("balance sync: a refusal WITH an exact amount is retained as a holding", () => {
  it("writes the row with a null scale and a null value, next to the valid rows", async () => {
    mockScan.mockResolvedValue({
      tokens: [validToken(1, "0xUSDC")],
      scannedChainIds: [1],
      chainErrors: [],
      rejectedEntries: [rejection({})],
    });

    await syncWalletBalances("eip155", EVM_A);

    const rows = replacedRowsByChain().get(1) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      walletFamily: "eip155",
      walletAddress: EVM_A,
      chainId: 1,
      tokenAddress: "0xGIFT",
      tokenSymbol: "GIFT",
      tokenName: "Airdropped Gift",
      balanceRaw: "424242",
      balanceUsd: null,
      priceUsd: null,
      decimals: null,
    });
  });

  it("creates the chain's write set even when every entry on it was refused", async () => {
    // The chain has holdings; we simply cannot value them. Leaving the chain out
    // of the write set would let the empty-chain cleanup delete its last-good
    // rows and report the wallet as holding nothing there.
    mockGetBalancesByChain.mockResolvedValue([{ chainId: 1, totalUsd: 10, tokenCount: 1 }]);
    mockScan.mockResolvedValue({
      tokens: [],
      scannedChainIds: [1],
      chainErrors: [],
      rejectedEntries: [rejection({ entryIndex: 0 })],
    });

    await syncWalletBalances("eip155", EVM_A);

    const rows = replacedRowsByChain().get(1) ?? [];
    expect(rows.map((row) => row.tokenAddress)).toEqual(["0xGIFT"]);
  });

  it("lets a VALID row for the same chain and address win over the salvage residue", async () => {
    mockScan.mockResolvedValue({
      tokens: [validToken(1, "0xGIFT")],
      scannedChainIds: [1],
      chainErrors: [],
      // The same token, refused on a second (duplicate) provider entry.
      rejectedEntries: [rejection({ address: "0xgift" })],
    });

    await syncWalletBalances("eip155", EVM_A);

    const rows = replacedRowsByChain().get(1) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].decimals).toBe(6);
    expect(rows[0].balanceUsd).toBe(1);
  });
});

describe("balance sync: a refusal WITHOUT an exact amount blocks the destructive replace", () => {
  it("writes nothing for that chain, so the last-good rows and their timestamps stay", async () => {
    mockGetBalancesByChain.mockResolvedValue([{ chainId: 1, totalUsd: 10, tokenCount: 1 }]);
    mockScan.mockResolvedValue({
      tokens: [validToken(1, "0xUSDC")],
      scannedChainIds: [1],
      chainErrors: [],
      rejectedEntries: [rejection({ balanceRaw: null })],
    });

    const result = await syncWalletBalances("eip155", EVM_A);

    expect(mockReplaceBalances).not.toHaveBeenCalled();
    expect(result.chainsUpdated).toBe(0);
  });

  it("leaves valid rows on OTHER chains completely unaffected", async () => {
    mockScan.mockResolvedValue({
      tokens: [validToken(1, "0xUSDC"), validToken(8453, "0xBASEUSDC")],
      scannedChainIds: [1, 8453],
      chainErrors: [],
      rejectedEntries: [rejection({ balanceRaw: null })],
    });

    await syncWalletBalances("eip155", EVM_A);

    const byChain = replacedRowsByChain();
    expect([...byChain.keys()]).toEqual([8453]);
    expect((byChain.get(8453) ?? []).map((row) => row.tokenAddress)).toEqual(["0xBASEUSDC"]);
  });

  it("does not empty a blocked chain that the scan otherwise reported as refreshed", async () => {
    // Without the block this is the exact shape that erases a chain: it was
    // scanned, it produced no valid rows, so the cleanup would replace it with
    // an empty set.
    mockGetBalancesByChain.mockResolvedValue([{ chainId: 1, totalUsd: 10, tokenCount: 1 }]);
    mockScan.mockResolvedValue({
      tokens: [],
      scannedChainIds: [1],
      chainErrors: [],
      rejectedEntries: [rejection({ balanceRaw: null, entryIndex: 0 })],
    });

    await syncWalletBalances("eip155", EVM_A);

    expect(mockReplaceBalances).not.toHaveBeenCalled();
  });
});

describe("balance sync: a scan without rejections behaves exactly as before", () => {
  it("writes the valid rows and nothing else", async () => {
    mockScan.mockResolvedValue({
      tokens: [validToken(1, "0xUSDC")],
      scannedChainIds: [1],
      chainErrors: [],
      rejectedEntries: [],
    });

    await syncWalletBalances("eip155", EVM_A);

    expect((replacedRowsByChain().get(1) ?? []).map((row) => row.tokenAddress)).toEqual(["0xUSDC"]);
  });

  it("tolerates a scan result that carries no rejection field at all", async () => {
    mockScan.mockResolvedValue({
      tokens: [validToken(1, "0xUSDC")],
      scannedChainIds: [1],
      chainErrors: [],
    });

    await syncWalletBalances("eip155", EVM_A);

    expect((replacedRowsByChain().get(1) ?? []).map((row) => row.tokenAddress)).toEqual(["0xUSDC"]);
  });
});
