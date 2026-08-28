/**
 * Routing of the solana family after the direct-RPC reader became PRIMARY.
 *
 * THE BLAST RADIUS THIS SUITE GUARDS: the Khalani scan reports Solana as
 * SCANNED with zero tokens, and `syncKhalaniWalletBalances` then replaces the
 * chain with an EMPTY row set. If the Khalani path still ran after a
 * successful RPC read, it would DELETE the rows just written and the panel
 * would be back at $0. The absence assertion below is the regression that
 * catches it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockListWallets = vi.fn();
vi.mock("@tools/wallet/inventory.js", () => ({
  listWallets: (family: string) => mockListWallets(family),
}));

const mockKhalaniScan = vi.fn();
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: (...args: unknown[]) => mockKhalaniScan(...args),
}));

const mockGetCachedKhalaniChains = vi.fn();
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: () => mockGetCachedKhalaniChains(),
  resolveChainId: vi.fn(),
}));

const mockSolanaSync = vi.fn();
vi.mock("../../../vex-agent/sync/solana-balance-sync.js", () => ({
  syncSolanaWalletBalances: (...args: unknown[]) => mockSolanaSync(...args),
}));

const mockLocalSync = vi.fn();
vi.mock("../../../vex-agent/sync/local-chain-balance-sync.js", () => ({
  syncLocalChainForWallet: (...args: unknown[]) => mockLocalSync(...args),
}));

vi.mock("../../../vex-agent/sync/pendle-enrichment.js", () => ({
  enrichPendleBalances: (_f: string, _a: string, _c: number, rows: unknown) => rows,
  seedPendleChainBalances: (_f: string, _a: string, chainId: number) => ({
    chainId,
    tokensUpdated: 0,
    skipped: true,
  }),
}));

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

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  hasPendingActivityForWallets: vi.fn().mockResolvedValue(false),
}));

const { syncWalletBalances, selectiveBalanceSync } = await import(
  "../../../vex-agent/sync/balance-sync.js"
);
const { SOLANA_SYNTHETIC_CHAIN_ID } = await import("../../../constants/solana-chain.js");

const SOL_WALLET = "BfvP43eVzM7xAu6Pm7yYbqp8RVkbP8R8dCfTvgPp64Pg";
const EVM_WALLET = "0xAAAaaa";

/** What Khalani actually answers for Solana: scanned, and empty. */
function emptySolanaScan() {
  return { tokens: [], scannedChainIds: [SOLANA_SYNTHETIC_CHAIN_ID], chainErrors: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCachedKhalaniChains.mockResolvedValue([{ id: 1, name: "Ethereum", type: "evm" }]);
  mockKhalaniScan.mockResolvedValue(emptySolanaScan());
  mockSolanaSync.mockResolvedValue({
    chainId: SOLANA_SYNTHETIC_CHAIN_ID,
    tokensUpdated: 9,
    skipped: false,
  });
  mockReplaceBalances.mockResolvedValue(0);
  mockLocalSync.mockImplementation((_family: string, _address: string, chainId: number) =>
    Promise.resolve({ chainId, tokensUpdated: 0, skipped: true }),
  );
  mockGetBalances.mockResolvedValue([]);
  mockGetBalancesByChain.mockResolvedValue([]);
  mockListWallets.mockImplementation((family: string) =>
    family === "solana" ? [{ address: SOL_WALLET }] : [{ address: EVM_WALLET }],
  );
});

describe("solana routing in syncWalletBalances", () => {
  it("reads Solana from RPC and does NOT run the Khalani scan on success", async () => {
    const result = await syncWalletBalances("solana", SOL_WALLET);

    expect(mockSolanaSync).toHaveBeenCalledWith(SOL_WALLET);
    // THE ABSENCE ASSERTION: a Khalani scan here would replace the chain with
    // an empty row set and delete everything the RPC read just wrote.
    expect(mockKhalaniScan).not.toHaveBeenCalled();
    expect(mockReplaceBalances).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      walletFamily: "solana",
      walletAddress: SOL_WALLET,
      tokensUpdated: 9,
      chainsUpdated: 1,
    });
  });

  it("recomputes the wallet total from proj_balances when Khalani is suppressed", async () => {
    mockGetBalances.mockResolvedValue([{ balanceUsd: 10 }, { balanceUsd: 5.93 }, { balanceUsd: null }]);
    const result = await syncWalletBalances("solana", SOL_WALLET);
    expect(result.totalUsd).toBeCloseTo(15.93, 2);
  });

  it("falls back to the Khalani path when the RPC read was SKIPPED", async () => {
    mockSolanaSync.mockResolvedValue({
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      tokensUpdated: 0,
      skipped: true,
    });
    const result = await syncWalletBalances("solana", SOL_WALLET);

    expect(mockSolanaSync).toHaveBeenCalledTimes(1);
    expect(mockKhalaniScan).toHaveBeenCalledWith({
      address: SOL_WALLET,
      family: "solana",
      chainIds: undefined,
    });
    expect(result.chainsUpdated).toBe(0);
  });

  it("keeps the last-good Solana rows when the RPC skipped and Khalani scanned EMPTY", async () => {
    // The exact live shape: the RPC read was skipped (so Khalani is the
    // fallback), Khalani reports Solana as SCANNED and returns zero tokens, and
    // the wallet already has last-good Solana rows in proj_balances. Replacing
    // the chain with nothing here is the $0-panel bug this guards.
    mockSolanaSync.mockResolvedValue({
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      tokensUpdated: 0,
      skipped: true,
    });
    mockGetBalancesByChain.mockResolvedValue([
      { chainId: SOLANA_SYNTHETIC_CHAIN_ID, totalUsd: 1234.5 },
    ]);

    await syncWalletBalances("solana", SOL_WALLET);

    expect(mockKhalaniScan).toHaveBeenCalledTimes(1);
    // THE ABSENCE ASSERTION: no replace at all for the Solana chain, so the
    // last-good rows survive the cycle untouched.
    expect(mockReplaceBalances).not.toHaveBeenCalled();
  });

  it("writes the Solana chain from the Khalani fallback when it DOES return rows", async () => {
    mockSolanaSync.mockResolvedValue({
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      tokensUpdated: 0,
      skipped: true,
    });
    mockGetBalancesByChain.mockResolvedValue([
      { chainId: SOLANA_SYNTHETIC_CHAIN_ID, totalUsd: 1234.5 },
    ]);
    mockKhalaniScan.mockResolvedValue({
      tokens: [
        {
          chainId: SOLANA_SYNTHETIC_CHAIN_ID,
          address: "So11111111111111111111111111111111111111112",
          symbol: "SOL",
          name: "Solana",
          decimals: 9,
          extensions: { balance: "1500000000", price: { usd: "200" } },
        },
      ],
      scannedChainIds: [SOLANA_SYNTHETIC_CHAIN_ID],
      chainErrors: [],
    });
    mockReplaceBalances.mockResolvedValue(1);

    const result = await syncWalletBalances("solana", SOL_WALLET);

    expect(mockReplaceBalances).toHaveBeenCalledTimes(1);
    const [address, chainId, rows] = mockReplaceBalances.mock.calls[0] ?? [];
    expect(address).toBe(SOL_WALLET);
    expect(chainId).toBe(SOLANA_SYNTHETIC_CHAIN_ID);
    expect(rows).toHaveLength(1);
    expect(result.tokensUpdated).toBe(1);
  });

  it("still cleans an EMPTY non-protected chain on the same fallback cycle", async () => {
    // The protection is per chain id, not a family-wide switch: chain 1 is not
    // protected, so its stale rows are still removed while Solana is kept.
    mockSolanaSync.mockResolvedValue({
      chainId: SOLANA_SYNTHETIC_CHAIN_ID,
      tokensUpdated: 0,
      skipped: true,
    });
    mockGetBalancesByChain.mockResolvedValue([
      { chainId: SOLANA_SYNTHETIC_CHAIN_ID, totalUsd: 1234.5 },
      { chainId: 1, totalUsd: 7 },
    ]);
    mockKhalaniScan.mockResolvedValue({
      tokens: [],
      scannedChainIds: [SOLANA_SYNTHETIC_CHAIN_ID, 1],
      chainErrors: [],
    });

    await syncWalletBalances("solana", SOL_WALLET);

    expect(mockReplaceBalances).toHaveBeenCalledTimes(1);
    expect(mockReplaceBalances).toHaveBeenCalledWith(SOL_WALLET, 1, []);
  });

  it("routes an explicit Solana chain id to the RPC reader", async () => {
    await syncWalletBalances("solana", SOL_WALLET, [SOLANA_SYNTHETIC_CHAIN_ID]);
    expect(mockSolanaSync).toHaveBeenCalledTimes(1);
    expect(mockKhalaniScan).not.toHaveBeenCalled();
  });

  it("keeps today's Khalani behavior for a solana request naming other chain ids", async () => {
    mockKhalaniScan.mockResolvedValue({ tokens: [], scannedChainIds: [], chainErrors: [] });
    await syncWalletBalances("solana", SOL_WALLET, [1]);
    expect(mockSolanaSync).not.toHaveBeenCalled();
    expect(mockKhalaniScan).toHaveBeenCalledWith({
      address: SOL_WALLET,
      family: "solana",
      chainIds: [1],
    });
  });

  it("leaves the EVM family untouched: no Solana read, Khalani as before", async () => {
    mockKhalaniScan.mockResolvedValue({ tokens: [], scannedChainIds: [1], chainErrors: [] });
    await syncWalletBalances("eip155", EVM_WALLET);
    expect(mockSolanaSync).not.toHaveBeenCalled();
    expect(mockKhalaniScan).toHaveBeenCalledWith({
      address: EVM_WALLET,
      family: "eip155",
      chainIds: undefined,
    });
  });

  it("routes the 'solana' trade hint (empty chainIds) through the RPC reader", async () => {
    const result = await selectiveBalanceSync("solana");
    expect(mockSolanaSync).toHaveBeenCalledWith(SOL_WALLET);
    expect(mockKhalaniScan).not.toHaveBeenCalled();
    expect(result.tokensUpdated).toBe(9);
    expect(result.families).toEqual(["solana"]);
  });
});
