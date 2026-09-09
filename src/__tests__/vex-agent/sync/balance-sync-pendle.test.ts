/**
 * Pendle enrichment scope lock (G2#2) — multichain (harness P2).
 *
 * The MERGE enrichment runs ONLY for a Pendle chain the Khalani scan actually
 * refreshed (so a sync scoped elsewhere never synthesizes/replaces those rows),
 * and now for EVERY refreshed Pendle chain — not just Ethereum. A refreshed
 * NON-Pendle chain is never enriched. A Pendle chain Khalani CANNOT scan is
 * seeded STANDALONE (no Khalani scan for it) so post-trade balances still appear.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vex-agent/db/repos/balance-chain-read-status.js", () => ({
  recordChainReadObservations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

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
  syncLocalChainForWallet: vi.fn().mockResolvedValue({ chainId: 0, tokensUpdated: 0, skipped: true }),
}));

const mockReplaceBalances = vi.fn().mockResolvedValue(0);
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: (...a: unknown[]) => mockReplaceBalances(...a),
  getBalances: vi.fn().mockResolvedValue([]),
  getBalancesByChain: vi.fn().mockResolvedValue([]),
  insertSnapshot: vi.fn().mockResolvedValue({ snapshotId: 1, pnlVsPrev: null }),
  getLatestSnapshot: vi.fn().mockResolvedValue(null),
  getSnapshotHistory: vi.fn().mockResolvedValue([]),
}));

// The units under scope: spy BOTH the MERGE enrichment and the STANDALONE seed so
// we can assert IF/WHEN each is called (and with which chainId).
const mockEnrich = vi.fn(async (_f: string, _a: string, _c: number, rows: unknown) => rows);
const mockSeed = vi.fn(async (_f: string, _a: string, chainId: number) => ({
  chainId,
  tokensUpdated: 0,
  skipped: true,
}));
vi.mock("../../../vex-agent/sync/pendle-enrichment.js", () => ({
  enrichPendleBalances: (...a: unknown[]) => mockEnrich(...(a as [string, string, number, unknown])),
  seedPendleChainBalances: (...a: unknown[]) => mockSeed(...(a as [string, string, number])),
}));

const { selectiveBalanceSync } = await import("../../../vex-agent/sync/balance-sync.js");

const EVM_A = "0xAAAaaa";

beforeEach(() => {
  vi.clearAllMocks();
  // Khalani dynamic registry: Ethereum + Arbitrum + Polygon are covered; Monad
  // (a Pendle chain) is ABSENT — Khalani's scan would throw for it.
  mockGetCachedKhalaniChains.mockResolvedValue([
    { id: 1, name: "Ethereum", type: "eip155" },
    { id: 42161, name: "Arbitrum", type: "eip155" },
    { id: 137, name: "Polygon", type: "eip155" },
  ]);
  mockResolveChainId.mockImplementation((hint: string) => {
    if (hint === "ethereum") return 1;
    if (hint === "arbitrum") return 42161;
    if (hint === "polygon") return 137;
    if (hint === "monad") return 143; // Pendle chain, absent from the registry above
    throw new Error("unsupported");
  });
  mockListWallets.mockImplementation((family: string) =>
    family === "solana" ? [] : [{ id: "evm_1", address: EVM_A, label: "EVM 1", createdAt: "" }],
  );
  // The scan echoes back exactly the chains it was asked to refresh.
  mockScan.mockImplementation((args: { chainIds?: number[] }) => ({
    tokens: [],
    scannedChainIds: args.chainIds ?? [],
    chainErrors: [],
  }));
});

describe("pendle enrichment scope lock — multichain (G2#2 / P2)", () => {
  it("runs the MERGE enrichment for the refreshed Ethereum chain (1)", async () => {
    await selectiveBalanceSync("ethereum");
    expect(mockEnrich).toHaveBeenCalledTimes(1);
    expect(mockEnrich).toHaveBeenCalledWith("eip155", EVM_A, 1, expect.any(Array));
    expect(mockSeed).not.toHaveBeenCalled();
  });

  it("runs the MERGE enrichment for the refreshed Arbitrum chain (42161)", async () => {
    await selectiveBalanceSync("arbitrum");
    expect(mockEnrich).toHaveBeenCalledTimes(1);
    expect(mockEnrich).toHaveBeenCalledWith("eip155", EVM_A, 42161, expect.any(Array));
    expect(mockSeed).not.toHaveBeenCalled();
  });

  it("does NOT enrich a refreshed NON-Pendle chain (polygon 137)", async () => {
    await selectiveBalanceSync("polygon");
    expect(mockScan).toHaveBeenCalledWith({ address: EVM_A, family: "eip155", chainIds: [137] });
    expect(mockEnrich).not.toHaveBeenCalled();
    expect(mockSeed).not.toHaveBeenCalled();
  });

  it("SEEDS a Khalani-uncovered Pendle chain (monad 143) standalone — no Khalani scan, no merge", async () => {
    await selectiveBalanceSync("monad");
    // Khalani never scans a chain absent from its registry (it would throw).
    expect(mockScan).not.toHaveBeenCalled();
    // The standalone seed runs for the traded chain so post-trade PT balances appear.
    expect(mockSeed).toHaveBeenCalledTimes(1);
    expect(mockSeed).toHaveBeenCalledWith("eip155", EVM_A, 143);
    // The MERGE path is not used for a chain Khalani did not scan.
    expect(mockEnrich).not.toHaveBeenCalled();
    // A monad-scoped sync never replaces some other chain's rows (e.g. chain 1).
    for (const call of mockReplaceBalances.mock.calls) {
      expect(call[1]).not.toBe(1);
    }
  });
});
